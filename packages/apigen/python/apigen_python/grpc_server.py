"""
apigen_python.grpc_server — gRPC server for the Python apigen target.

Runs each exported Python function as a real gRPC unary method, generating
protobuf descriptors **in memory** (no .proto files written to disk) by
building per-method typed ``FileDescriptorProto`` objects from the operation's
JSON-Schema input descriptor.

Usage (apigen-serve-core py-grpc-serve-split — two-phase extract/serve split):
    python3 -m apigen_python.grpc_server \\
        --module <path.py> \\
        --namespace <ns> \\
        --port <p> \\
        --plan-file <plan.json>

    This server no longer self-extracts, and no longer derives its own
    package/service/method names. `--plan-file` is REQUIRED and points to a
    JSON file of the shape `{"operations": [...Operation dicts, exactly what
    `apigen_python.extractor --emit-json` emits...], "grpc": {"<opId>":
    {"package": "<dotted.package>", "service": "<PascalService>", "method":
    "<PascalMethod>"}}}`, produced by the TS `py-grpc` plugin's two-phase
    spawn: (1) spawn `apigen_python.extractor --emit-json` in a short-lived
    process to get `Operation[]`, (2) call the REAL
    `@adhd/apigen-engine-naming` `project(op).grpc` on each op — the SAME
    canonical projector every other transport (fastify/express/mcp/cli) uses
    — (3) spawn THIS server with the result. See
    `packages/apigen/apigen-plugin-py-grpc/src/lib/plugin.ts`.

Service layout (apigen-engine-naming's `project(op).grpc` rule — computed
TS-side and injected via `--plan-file`; this module contains no Python port
of the formula):
    package  = dotted, snake_cased, all path segments except the method
    service  = Pascal-cased "file" segment (second-to-last of [namespace, ...path])
    method   = Pascal-cased "export" segment (last of [namespace, ...path])

    Example: namespace='pkg', source file 'grpc_api.py', fn='add_decimal'
        → package: 'pkg.grpc_api', service: 'GrpcApi', method: 'AddDecimal'
        → full method path:  pkg.grpc_api.GrpcApi/AddDecimal
        → grpcurl call:
            grpcurl -plaintext \\
              -d '{"data":{"amount":"123.456"}}' \\
              localhost:50051 pkg.grpc_api.GrpcApi/AddDecimal

    A single server process serves exactly one Python source file, so every
    operation it exposes shares the same "file" path segment — and therefore
    the same projected package + service — by construction; `_build_state()`
    asserts this invariant rather than silently picking one when the
    injected plan ever disagreed (it never should for a single-module server).

Wire contract (canonical apigen logical-type tenet):
    Request message per method (generated from JSON-Schema input descriptor):
        message <Method>Request {
            <Method>Request.Data data = 1;
            message Data {
                string  <param1> = 1;  // string for decimal/date-time/uuid/str
                int64   <param2> = 2;  // integer JSON type
                double  <param3> = 3;  // number JSON type
                bool    <param4> = 4;  // boolean JSON type
            }
        }
    Response message:
        message <Method>Response {
            string data = 1;   // JSON-encoded result (string, decimal, RFC3339, etc.)
        }

    CANONICAL WIRE TENET (must never change):
      date-time  → string field, RFC3339 value (NOT protobuf Timestamp)
      decimal    → string field, decimal string value
      int64      → string field, decimal string value (preserve precision)
      uuid       → string field, lowercase hyphenated
      bytes      → string field, base64 encoded
      integer    → int64 proto field
      number     → double proto field
      boolean    → bool proto field

Streaming (deferred scope — [fix:pygrpc-streaming-deferral]):
    gRPC natively supports streaming, but this transport does not implement
    it yet. `_build_state()` rejects any injected operation with
    `streaming: true` with a clear `ValueError` rather than silently
    mishandling it as a unary call. Implementing real gRPC streaming is
    tracked separately and out of scope for this split.

Reflection:
    grpc_reflection v1alpha is enabled unconditionally so grpcurl can list,
    describe, and call methods without a local .proto file.

Startup signal:
    Emits ``{"ready": true}`` on stdout once the gRPC server is accepting
    connections — same §13.1 readiness protocol as flask_server.py.

What serve.ts needs to mount a gRPC host:
    - HTTP/2 front (gRPC is already HTTP/2 + length-prefixed framing)
    - Route pattern: ``/<package>.<Service>/<Method>``
    - Trailer-based error: ``grpc-status`` + ``grpc-message`` trailers
    - Metadata passthrough: ``x-adhd-*`` request metadata → envelope/ctx dict
    - No gatewayCode mapping — gRPC status codes are the canonical errors
    - gRPC-Web (via sonora/grpclib) is a stretch goal — not included here;
      see BACKLOG for the pure-Python gRPC-Web option
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import signal as _signal
import sys
import threading
from concurrent import futures
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Bootstrap: ensure the package is importable when run as __main__
# ---------------------------------------------------------------------------

_THIS_DIR = Path(__file__).resolve().parent.parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from apigen_python.errors import ApiError, GRPC_CODE  # noqa: E402
from apigen_python.runtime import HostRequest, Runtime  # noqa: E402
from apigen_python.validator import validate, ValidationError  # noqa: E402

# apigen_logical lives one level up from the package (repo layout)
try:
    import apigen_logical  # type: ignore[import]
    _HAS_LOGICAL = True
except ImportError:
    _HAS_LOGICAL = False

# ---------------------------------------------------------------------------
# grpcio / grpcio-reflection imports — fail clearly if absent
# ---------------------------------------------------------------------------

try:
    import grpc                                    # type: ignore[import]
    from grpc_reflection.v1alpha import reflection # type: ignore[import]
    _HAS_GRPC = True
    _GRPC_IMPORT_ERR: str = ""
except ImportError as _err:
    _HAS_GRPC = False
    _GRPC_IMPORT_ERR = str(_err)

# ---------------------------------------------------------------------------
# Logical-type helpers (mirrors flask_server pattern)
# ---------------------------------------------------------------------------

def _decode_params(data: dict[str, Any], input_schema: dict[str, Any]) -> dict[str, Any]:
    """Schema-driven decode of each wire parameter to its native Python type.

    Only runs when apigen_logical is available and the schema carries ``format``
    annotations.  Plain string/int/bool params pass through unchanged.
    """
    if not _HAS_LOGICAL or not input_schema:
        return data
    props: dict[str, Any] = input_schema.get("properties", {})
    if not props:
        return data
    decoded: dict[str, Any] = {}
    for key, val in data.items():
        prop_schema = props.get(key, {})
        decoded[key] = apigen_logical.decode(val, prop_schema)
    return decoded


def _encode_result(value: Any) -> Any:
    """Encode a native Python return value to its canonical wire form.

    Uses apigen_logical.encode_value when available.  Falls back to handling
    the most common types (datetime, Decimal, UUID, bytes) directly.
    """
    if _HAS_LOGICAL:
        return apigen_logical.encode_value(value)
    from datetime import datetime
    from decimal import Decimal
    from uuid import UUID
    if isinstance(value, datetime):
        from datetime import timezone
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        else:
            value = value.replace(tzinfo=timezone.utc)
        base = value.strftime("%Y-%m-%dT%H:%M:%S")
        ms = value.microsecond // 1000
        return f"{base}.{ms:03d}Z"
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, UUID):
        return str(value).lower()
    if isinstance(value, (bytes, bytearray)):
        import base64
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, dict):
        return {k: _encode_result(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_encode_result(v) for v in value]
    return value


def _json_dumps(obj: Any) -> str:
    """Serialise to JSON using ApigenEncoder when available."""
    if _HAS_LOGICAL:
        return json.dumps(obj, cls=apigen_logical.ApigenEncoder)
    return json.dumps(obj)


# ---------------------------------------------------------------------------
# gRPC ApiError → grpc.StatusCode mapping
# ---------------------------------------------------------------------------

def _grpc_status_for(code: str) -> Any:
    """Map an apigen ApiErrorCode string to a grpc.StatusCode."""
    _map = {
        "invalid_argument":  grpc.StatusCode.INVALID_ARGUMENT,
        "unauthenticated":   grpc.StatusCode.UNAUTHENTICATED,
        "permission_denied": grpc.StatusCode.PERMISSION_DENIED,
        "not_found":         grpc.StatusCode.NOT_FOUND,
        "internal":          grpc.StatusCode.INTERNAL,
    }
    return _map.get(code, grpc.StatusCode.INTERNAL)


# ---------------------------------------------------------------------------
# JSON-Schema → proto3 field type mapping
# ---------------------------------------------------------------------------

def _json_type_to_proto_field_type(schema: dict[str, Any]) -> int:
    """Map a JSON Schema type fragment to a proto3 FieldDescriptorProto TYPE_*.

    Logical-type mappings (all map to string to preserve the canonical wire):
      format:decimal   → TYPE_STRING  (decimal string "123.456")
      format:date-time → TYPE_STRING  (RFC3339 string)
      format:uuid      → TYPE_STRING  (lowercase hyphenated string)
      type:integer     → TYPE_INT64
      type:number      → TYPE_DOUBLE
      type:boolean     → TYPE_BOOL
      type:string      → TYPE_STRING  (default)
      (anything else)  → TYPE_STRING
    """
    from google.protobuf import descriptor_pb2  # type: ignore[import]

    t = schema.get("type", "string")
    # Note: integer maps to TYPE_INT64 for exact round-trips.
    # All logical string formats (decimal, date-time, uuid, byte) stay TYPE_STRING.
    if t == "integer":
        return descriptor_pb2.FieldDescriptorProto.TYPE_INT64
    if t == "number":
        return descriptor_pb2.FieldDescriptorProto.TYPE_DOUBLE
    if t == "boolean":
        return descriptor_pb2.FieldDescriptorProto.TYPE_BOOL
    return descriptor_pb2.FieldDescriptorProto.TYPE_STRING


# ---------------------------------------------------------------------------
# In-memory FileDescriptorProto construction
#
# Per-method typed messages for ergonomic grpcurl calls, named from the
# INJECTED plan's Pascal-cased `method` (never the raw Python function name):
#
#   message AddDecimalRequest {
#       AddDecimalRequest.Data data = 1;
#       message Data { string amount = 1; }
#   }
#   message AddDecimalResponse { string data = 1; }
#
# grpcurl call:  -d '{"data":{"amount":"123.456"}}'
# ---------------------------------------------------------------------------

def _build_file_descriptor_proto(
    package: str,
    service_name: str,
    operations: list[dict[str, Any]],
    grpc_map: dict[str, dict[str, str]],
) -> Any:
    """Build a FileDescriptorProto in memory for the given service.

    Each operation's input JSON Schema properties become the fields of the
    per-method ``Data`` sub-message.  The response is always a
    ``string data = 1`` field carrying the JSON-encoded result.

    Args:
        package:      Proto package name — the plan's TS-computed
                       `project(op).grpc.package` (e.g. "pkg.grpc_api"),
                       shared by every op in a single-module server.
        service_name: gRPC service name — the plan's TS-computed
                       `project(op).grpc.service` (e.g. "GrpcApi").
        operations:   List of operation dicts (from the injected plan).
        grpc_map:     `{opId: {"package", "service", "method"}}` from the
                       injected `--plan-file`, supplying each op's
                       Pascal-cased method name.

    Returns:
        A ``google.protobuf.descriptor_pb2.FileDescriptorProto``.
    """
    from google.protobuf import descriptor_pb2  # type: ignore[import]

    file_proto = descriptor_pb2.FileDescriptorProto()
    file_proto.name = f"{package}.proto"
    file_proto.package = package
    file_proto.syntax = "proto3"

    for op in operations:
        method_name: str = grpc_map[op["id"]]["method"]
        input_schema: dict[str, Any] = op.get("input", {})
        input_props: dict[str, Any] = input_schema.get("properties", {})

        # --- Request message ---
        req_msg = file_proto.message_type.add()
        req_msg.name = f"{method_name}Request"

        # Nested `Data` sub-message with typed per-param fields.
        data_submsg = req_msg.nested_type.add()
        data_submsg.name = "Data"
        for field_num, (prop_name, prop_schema) in enumerate(
            input_props.items(), start=1
        ):
            field = data_submsg.field.add()
            field.name = prop_name
            field.number = field_num
            field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
            field.type = _json_type_to_proto_field_type(prop_schema)

        # The outer `data` field pointing to the nested Data message.
        data_field = req_msg.field.add()
        data_field.name = "data"
        data_field.number = 1
        data_field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        data_field.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
        data_field.type_name = f".{package}.{method_name}Request.Data"

        # --- Response message ---
        resp_msg = file_proto.message_type.add()
        resp_msg.name = f"{method_name}Response"
        resp_field = resp_msg.field.add()
        resp_field.name = "data"
        resp_field.number = 1
        resp_field.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        resp_field.type = descriptor_pb2.FieldDescriptorProto.TYPE_STRING

        # --- Service method ---

    # Service definition (must come after all message types).
    service = file_proto.service.add()
    service.name = service_name
    for op in operations:
        method_name = grpc_map[op["id"]]["method"]
        method = service.method.add()
        method.name = method_name
        method.input_type = f".{package}.{method_name}Request"
        method.output_type = f".{package}.{method_name}Response"

    return file_proto


def _build_descriptor_pool(
    package: str,
    service_name: str,
    operations: list[dict[str, Any]],
    grpc_map: dict[str, dict[str, str]],
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    """Build a DescriptorPool + message classes for all operations.

    Args:
        package:      Proto package name (plan-computed).
        service_name: gRPC service name (plan-computed).
        operations:   Extracted operation descriptors (from the injected plan).
        grpc_map:     `{opId: {"package", "service", "method"}}` from the
                       injected `--plan-file`.

    Returns:
        (pool, req_classes, resp_classes) where:
          pool         — a DescriptorPool pre-populated with the generated file,
                         suitable for passing to enable_server_reflection.
          req_classes  — {method_name → Request message class}
          resp_classes — {method_name → Response message class}
    """
    from google.protobuf import descriptor_pool, message_factory  # type: ignore[import]

    file_proto = _build_file_descriptor_proto(package, service_name, operations, grpc_map)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file_proto)

    req_classes: dict[str, Any] = {}
    resp_classes: dict[str, Any] = {}
    for op in operations:
        method_name = grpc_map[op["id"]]["method"]
        req_desc = pool.FindMessageTypeByName(f"{package}.{method_name}Request")
        resp_desc = pool.FindMessageTypeByName(f"{package}.{method_name}Response")
        req_classes[method_name] = message_factory.GetMessageClass(req_desc)
        resp_classes[method_name] = message_factory.GetMessageClass(resp_desc)

    return pool, req_classes, resp_classes


# ---------------------------------------------------------------------------
# Proto3 message → Python dict conversion
# ---------------------------------------------------------------------------

def _msg_to_dict(msg: Any) -> dict[str, Any]:
    """Recursively convert a protobuf message to a Python dict.

    Only processes LABEL_OPTIONAL scalar and message fields (no repeated or
    map fields — apigen schemas don't use them at the top data level).

    Args:
        msg: A protobuf Message instance.

    Returns:
        A plain Python dict with field names as keys and Python-native values.
    """
    result: dict[str, Any] = {}
    for field in msg.DESCRIPTOR.fields:
        val = getattr(msg, field.name)
        if field.type == field.TYPE_MESSAGE:
            result[field.name] = _msg_to_dict(val)
        else:
            result[field.name] = val
    return result


# ---------------------------------------------------------------------------
# Server state
#
# apigen-serve-core py-grpc-serve-split: package/service are no longer
# derived here. The previous scheme built the service name by upper-casing
# just the namespace's first character and lower-casing the rest, then
# appending a fixed literal suffix, duplicated at (at least) two call sites,
# and used the raw un-cased Python function identifier as the wire method
# name everywhere else — an inline algorithm unrelated to
# `@adhd/apigen-engine-naming`'s real gRPC projection. That whole scheme is
# DELETED; `package`/`service_name` and each operation's wire `method` name
# are now supplied by the injected `--plan-file` (`grpc_map`, TS-computed via
# the real `project(op).grpc` — see the module docstring's "Service layout").
# ---------------------------------------------------------------------------

class _ServerState:
    """Immutable server configuration shared across all gRPC threads."""

    __slots__ = (
        "package", "service_name", "runtime", "operations",
        "op_map", "input_schema_map", "method_names",
        "req_classes", "resp_classes",
    )

    def __init__(
        self,
        package: str,
        service_name: str,
        runtime: Runtime,
        operations: list[dict[str, Any]],
        grpc_map: dict[str, dict[str, str]],
        req_classes: dict[str, Any],
        resp_classes: dict[str, Any],
    ) -> None:
        self.package = package
        self.service_name = service_name
        self.runtime = runtime
        self.operations = operations
        self.req_classes = req_classes
        self.resp_classes = resp_classes

        self.op_map: dict[str, dict[str, Any]] = {}
        self.input_schema_map: dict[str, dict[str, Any]] = {}
        self.method_names: list[str] = []

        for op in operations:
            method_name = grpc_map[op["id"]]["method"]
            self.op_map[method_name] = op
            self.input_schema_map[method_name] = op.get("input", {})
            self.method_names.append(method_name)


# ---------------------------------------------------------------------------
# GenericRpcHandler — dispatches all service methods using typed proto messages
# ---------------------------------------------------------------------------

class _ApigenGrpcHandler(grpc.GenericRpcHandler if _HAS_GRPC else object):  # type: ignore[misc]
    """Generic gRPC handler for the apigen service.

    Each gRPC method has fully typed request/response messages (built from the
    operation's input JSON schema) so grpcurl can call methods as:

        grpcurl -plaintext \\
            -d '{"data":{"amount":"123.456"}}' \\
            localhost:50051 pkg.grpc_api.GrpcApi/AddDecimal

    The ``data`` field of the request is a typed sub-message whose fields
    correspond to the function's parameters (all logical-type params use
    ``string`` proto fields, carrying their canonical wire values).

    The ``data`` field of the response is a plain ``string`` carrying the
    JSON-encoded return value.
    """

    def __init__(self, state: "_ServerState") -> None:
        self._state = state
        self._full_service = f"{state.package}.{state.service_name}"

    def service_name(self) -> str:
        return self._full_service

    def service(self, handler_call_details: Any) -> Any:  # type: ignore[override]
        """Return an RpcMethodHandler for the requested method, or None."""
        method: str = handler_call_details.method
        prefix = f"/{self._full_service}/"
        if not method.startswith(prefix):
            return None
        method_name = method[len(prefix):]
        if method_name not in self._state.op_map:
            return None

        req_cls = self._state.req_classes[method_name]
        resp_cls = self._state.resp_classes[method_name]
        method_name_captured = method_name

        def _handle(request: Any, context: Any) -> Any:
            result_json = self._dispatch(method_name_captured, request, context)
            resp = resp_cls()
            resp.data = result_json  # type: ignore[attr-defined]
            return resp

        return grpc.unary_unary_rpc_method_handler(
            _handle,
            request_deserializer=req_cls.FromString,
            response_serializer=lambda r: r.SerializeToString(),
        )

    def _dispatch(self, method_name: str, request: Any, context: Any) -> str:
        """Extract params from the typed request → validate → invoke → encode.

        Args:
            method_name: The wire gRPC method name (plan-computed, Pascal-cased).
            request:     The decoded request proto message instance.
            context:     The grpc.ServicerContext for abort/metadata.

        Returns:
            JSON-encoded result string (placed in response ``data`` field).
            Returns "" and calls ``context.abort()`` on any error.
        """
        # Convert the typed ``data`` sub-message to a plain Python dict.
        req_dict = _msg_to_dict(request)
        data = req_dict.get("data", {})
        if not isinstance(data, dict):
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                '"data" sub-message could not be decoded to a dict',
            )
            return ""

        # Extract x-adhd-* from gRPC metadata → envelope (mirrors HTTP headers).
        envelope: dict[str, Any] = {}
        try:
            for key, value in context.invocation_metadata():
                if key.startswith("x-adhd-"):
                    field = key[len("x-adhd-"):]
                    if field:
                        envelope[field] = value
        except Exception:
            pass

        # Pre-dispatch input validation (same gate as flask_server).
        input_schema = self._state.input_schema_map.get(method_name, {})
        if input_schema:
            try:
                validate(input_schema, data)
            except ValidationError as exc:
                context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT,
                    f"input validation failed: {exc}",
                )
                return ""

        # Schema-driven decode for logical types (Decimal, datetime, etc.).
        decoded_data = _decode_params(data, input_schema)

        host_req = HostRequest(
            operation=self._state.op_map[method_name],
            data=decoded_data,
            envelope=envelope,
            transport="grpc",
            pre_validated=True,
        )

        try:
            result = self._state.runtime.invoke_sync(host_req)
        except ApiError as exc:
            context.abort(_grpc_status_for(exc.code), exc.message)
            return ""
        except Exception as exc:
            context.abort(grpc.StatusCode.INTERNAL, f"dispatch error: {exc}")
            return ""

        # Encode the result to its canonical wire form.
        wire_result = _encode_result(result)
        try:
            return _json_dumps(wire_result)
        except Exception as exc:
            context.abort(grpc.StatusCode.INTERNAL, f"result encode error: {exc}")
            return ""


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

class ApigenGrpcServer:
    """gRPC server that exposes a Python module as a typed gRPC service.

    Each exported function becomes a unary gRPC method with fully typed
    request/response messages generated from its JSON-Schema input descriptor.

    Method path:  ``/<package>.<Service>/<Method>`` (plan-computed — see the
    module docstring's "Service layout").

    grpcurl example::

        grpcurl -plaintext \\
            -d '{"data":{"amount":"123.456"}}' \\
            localhost:50051 \\
            pkg.grpc_api.GrpcApi/AddDecimal

    Wire contract (canonical apigen tenet):
      All logical types keep their string wire form in the proto ``string``
      field — ``date-time`` stays RFC3339, ``decimal`` stays a decimal string.
      No ``google.protobuf.Timestamp`` is used.
    """

    def __init__(
        self,
        module_path: str,
        namespace: str,
        plan: dict[str, Any],
        host: str = "127.0.0.1",
        port: int = 50051,
        max_workers: int = 10,
    ) -> None:
        if not _HAS_GRPC:
            raise ImportError(
                f"grpcio / grpcio-reflection is required but could not be imported: "
                f"{_GRPC_IMPORT_ERR}\n"
                "Install with:  pip install grpcio grpcio-tools grpcio-reflection"
            )
        self._module_path = module_path
        self._namespace = namespace  # informational only — package/service/method
        # names are supplied by --plan-file (see _build_state()), never
        # re-derived from `namespace` here.
        self._plan = plan
        self._host = host
        self._port = port
        self._max_workers = max_workers
        self._server: Any = None

    def _build_state(self) -> "_ServerState":
        """Build descriptors + server state from the INJECTED `--plan-file` —
        this server no longer self-extracts (apigen-serve-core
        py-grpc-serve-split). `self._plan["operations"]` supplies the full
        Operation[] (schema-bearing dicts, produced by
        `apigen_python.extractor --emit-json` in a separate, short-lived
        process — see plugin.ts's two-phase spawn) and
        `self._plan["grpc"]` supplies each op's canonical
        package/service/method, computed by the REAL
        `@adhd/apigen-engine-naming` `project()` — never re-derived here.

        The module is still loaded a SECOND time, independently, right here —
        that load's only job is producing LIVE function references for the
        runtime registry, which cannot cross a process boundary as data
        (Python callables are not serialisable). This is unchanged from the
        pre-split design and was confirmed safe by
        `docs/apigen/proposals/py-extract-serve-split-findings.md` §1.2/§2.2.
        """
        ops: list[dict[str, Any]] = self._plan["operations"]
        grpc_map: dict[str, dict[str, str]] = self._plan["grpc"]
        if not ops:
            raise ValueError(
                f"--plan-file for {self._module_path!r} carries zero "
                "operations. Ensure the module has public callable exports."
            )

        # gRPC-specific wrinkle (unchanged from pre-split design, confirmed
        # by py-extract-serve-split-findings.md §2.2): only 'action'/
        # 'constructor' kinds become gRPC methods; 'query' ops are dropped,
        # falling back to all ops only if none qualify.
        callable_ops = [op for op in ops if op.get("kind") in ("action", "constructor")]
        if not callable_ops:
            callable_ops = ops

        # [fix:pygrpc-streaming-deferral] gRPC natively supports streaming,
        # but this transport does not implement it. Reject explicitly rather
        # than silently mishandling a streaming op as a plain unary call —
        # this is a documented, already-tracked deferral, not a TODO here.
        streaming_ops = [op for op in callable_ops if op.get("streaming")]
        if streaming_ops:
            ids = ", ".join(repr(op["id"]) for op in streaming_ops)
            raise ValueError(
                "apigen-py-grpc: streaming operations are not supported by "
                f"this transport (deferred scope): {ids}. gRPC natively "
                "supports streaming; implementing it here is out of scope "
                "for the py-grpc-serve-split extract/serve split."
            )

        missing = [op["id"] for op in callable_ops if op["id"] not in grpc_map]
        if missing:
            raise ValueError(
                f"apigen-py-grpc: --plan-file is missing a grpc entry for "
                f"operation id(s) {missing!r} — the injected plan must "
                f"cover every callable operation extract_module() (phase 1) "
                f"produced, 1:1."
            )

        # A single server process serves exactly one Python source file, so
        # every operation it exposes shares the same "file" path segment —
        # and therefore the same projected package + service — by
        # construction (see module docstring). Assert rather than silently
        # pick one if that invariant were ever violated.
        packages = {grpc_map[op["id"]]["package"] for op in callable_ops}
        services = {grpc_map[op["id"]]["service"] for op in callable_ops}
        if len(packages) != 1 or len(services) != 1:
            raise ValueError(
                "apigen-py-grpc: operations from a single module projected "
                f"to multiple gRPC package/service pairs "
                f"(packages={sorted(packages)!r}, services={sorted(services)!r}) "
                "— a single server process can only host one file's worth "
                "of gRPC package/service."
            )
        package = next(iter(packages))
        service_name = next(iter(services))

        # Load the module to get live function references.
        # Register in sys.modules BEFORE exec_module (canonical importlib pattern)
        # so dataclasses._is_type and typing.get_type_hints work correctly for
        # modules that use `from __future__ import annotations` (PEP 563).
        path = Path(self._module_path).resolve()
        spec = importlib.util.spec_from_file_location("_apigen_grpc_module_", str(path))
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load module from {path}")
        mod = importlib.util.module_from_spec(spec)
        import sys as _sys
        _sys.modules[spec.name] = mod
        try:
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
        except Exception:
            _sys.modules.pop(spec.name, None)
            raise

        registry: dict[str, Any] = {}
        for op in callable_ops:
            fn_name = op["path"][-1]["raw"]
            fn = getattr(mod, fn_name, None)
            if callable(fn):
                registry[op["id"]] = fn

        runtime = Runtime(registry)

        pool, req_classes, resp_classes = _build_descriptor_pool(
            package, service_name, callable_ops, grpc_map
        )

        return _ServerState(
            package=package,
            service_name=service_name,
            runtime=runtime,
            operations=callable_ops,
            grpc_map=grpc_map,
            req_classes=req_classes,
            resp_classes=resp_classes,
        )

    def start(self) -> None:
        """Build state + descriptors, create the gRPC server, start serving."""
        state = self._build_state()

        # Re-build the pool for reflection (identical FileDescriptorProto).
        pool, _, _ = _build_descriptor_pool(
            state.package, state.service_name, state.operations, self._plan["grpc"]
        )

        handler = _ApigenGrpcHandler(state)
        server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=self._max_workers)
        )
        server.add_generic_rpc_handlers([handler])

        # Register reflection with our custom pool so grpcurl list/describe works.
        service_names = [f"{state.package}.{state.service_name}"]
        try:
            reflection.enable_server_reflection(service_names, server, pool=pool)
        except Exception as exc:
            print(
                f"apigen-py-grpc  WARNING: reflection setup failed: {exc}",
                file=sys.stderr,
            )

        address = f"{self._host}:{self._port}"
        # BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: grpc's add_insecure_port
        # returns the ACTUAL bound port — identical to the requested port
        # unless 0 (OS-assigned ephemeral) was passed, in which case this is
        # the only way to learn the real port. self._port is the single
        # source of truth from here on (used by the log line below and by
        # serve_forever()'s readiness signal).
        self._port = server.add_insecure_port(address)
        server.start()
        self._server = server

        # Print route summary to stderr (mirrors flask_server pattern).
        pkg = state.package
        svc = state.service_name
        print(
            f"apigen-py-grpc  listening on grpc://{self._host}:{self._port}",
            file=sys.stderr,
        )
        print(f"  service: {pkg}.{svc}", file=sys.stderr)
        for method_name in state.method_names:
            print(f"  method:  /{pkg}.{svc}/{method_name}", file=sys.stderr)
        sys.stderr.flush()

    def stop(self, grace: float = 2.0) -> None:
        """Shutdown the gRPC server gracefully."""
        if self._server is not None:
            self._server.stop(grace)
            self._server = None

    def serve_forever(self) -> None:
        """Start the server and block until SIGTERM / SIGINT / Ctrl-C.

        Emits ``{"ready": true, "port": <n>}`` on stdout immediately after
        binding so the TS plugin subprocess launcher can detect readiness
        (same §13.1 protocol as flask_server.py). ``port`` is the ACTUAL
        bound port (BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001) — identical to
        the requested ``--port`` unless 0 (OS-assigned ephemeral) was passed,
        in which case this is the only way the caller learns the real port.
        """
        self.start()
        # §13.1 readiness signal — TS launcher polls stdout for this line.
        print(json.dumps({"ready": True, "port": self._port}), flush=True)

        stop_event = threading.Event()

        def _sig_handler(signum: int, frame: Any) -> None:
            stop_event.set()

        _signal.signal(_signal.SIGTERM, _sig_handler)
        _signal.signal(_signal.SIGINT, _sig_handler)

        try:
            stop_event.wait()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()


# ---------------------------------------------------------------------------
# Public convenience: build_server()
# ---------------------------------------------------------------------------

def build_server(
    module_path: str,
    namespace: str,
    plan: dict[str, Any],
    host: str = "127.0.0.1",
    port: int = 50051,
) -> "ApigenGrpcServer":
    """Construct an :class:`ApigenGrpcServer` for the given module.

    Args:
        module_path: Path to the ``.py`` source file (absolute or relative).
        namespace:   The apigen namespace slug (informational only — the
                     served gRPC package/service/method names come from
                     `plan["grpc"]`, never re-derived from this value).
        plan:        The TS-computed serve plan (`{"operations": [...],
                     "grpc": {"<opId>": {"package": str, "service": str,
                     "method": str}}}`) — see the module docstring's
                     "Usage" section.
        host:        Bind address (default ``127.0.0.1``).
        port:        TCP port (default ``50051``).

    Returns:
        An :class:`ApigenGrpcServer` instance ready to call ``.start()`` or
        ``.serve_forever()``.
    """
    return ApigenGrpcServer(module_path, namespace, plan, host=host, port=port)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "apigen Python gRPC server — serves a .py module over gRPC.\n\n"
            "Service layout (TS-computed via @adhd/apigen-engine-naming's\n"
            "project().grpc and injected via --plan-file; apigen-serve-core\n"
            "py-grpc-serve-split):\n"
            "  package: <dotted, all path segments but the method>\n"
            "  service: <Pascal file segment>\n"
            "  methods: /<package>.<Service>/<PascalMethod>\n\n"
            "Wire encoding (canonical apigen tenet):\n"
            "  Request:  typed sub-message per function\n"
            "            date-time/decimal/uuid → string fields\n"
            "            integer → int64, number → double\n"
            "  Response: message { string data = 1; }  (JSON-encoded result)\n\n"
            "  date-time → RFC3339 string (NOT protobuf Timestamp)\n"
            "  decimal   → decimal string\n\n"
            "Startup: emits {ready: true} on stdout once the server is up.\n\n"
            "grpcurl example:\n"
            "  grpcurl -plaintext \\\n"
            "    -d '{\"data\":{\"amount\":\"123.456\"}}' \\\n"
            "    localhost:50051 pkg.grpc_api.GrpcApi/AddDecimal\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--module", required=True, help="Path to the Python source module")
    parser.add_argument(
        "--namespace", required=True,
        help="Namespace slug (informational only; wire naming comes from --plan-file)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument(
        "--port", type=int, default=50051,
        help="TCP port (default: 50051; pass 0 to bind an OS-assigned "
             "ephemeral port — the actual bound port is reported back in "
             "the {ready: true, port: <n>} stdout line)",
    )
    parser.add_argument(
        "--plan-file", required=True,
        help=(
            "Path to a JSON file: {\"operations\": [...Operation dicts, exactly "
            "apigen_python.extractor --emit-json's output...], \"grpc\": "
            "{\"<opId>\": {\"package\": str, \"service\": str, \"method\": str}}}. "
            "REQUIRED — this server no longer self-extracts or re-derives "
            "package/service/method (apigen-serve-core py-grpc-serve-split); "
            "produced by the py-grpc TS plugin's two-phase spawn (extractor "
            "--emit-json -> @adhd/apigen-engine-naming project() -> this flag)."
        ),
    )
    args = parser.parse_args()

    with open(args.plan_file, "r", encoding="utf-8") as plan_fh:
        plan = json.load(plan_fh)

    server = build_server(
        module_path=args.module,
        namespace=args.namespace,
        plan=plan,
        host=args.host,
        port=args.port,
    )
    server.serve_forever()


if __name__ == "__main__":
    _main()
