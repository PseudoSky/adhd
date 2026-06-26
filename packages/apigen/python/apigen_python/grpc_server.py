"""
apigen_python.grpc_server — gRPC server for the Python apigen target.

Runs each exported Python function as a real gRPC unary method, generating
protobuf descriptors **in memory** (no .proto files written to disk) by
building per-method typed ``FileDescriptorProto`` objects from the operation's
JSON-Schema input descriptor.

Usage:
    python3 -m apigen_python.grpc_server \\
        --module <path.py> \\
        --namespace <ns> \\
        --port <p>

Service layout:
    package  = <namespace>
    service  = <Namespace>Service    (namespace capitalised, e.g. pkg → PkgService)
    method   = <fn_name>             (snake_case, matching the Python function)

    Example: namespace='pkg', fn='add_decimal'
        → full method path:  pkg.PkgService/add_decimal
        → grpcurl call:
            grpcurl -plaintext \\
              -d '{"data":{"amount":"123.456"}}' \\
              localhost:8950 pkg.PkgService/add_decimal

Wire contract (canonical apigen logical-type tenet):
    Request message per method (generated from JSON-Schema input descriptor):
        message <fn_name>Request {
            <fn_name>Request.Data data = 1;
            message Data {
                string  <param1> = 1;  // string for decimal/date-time/uuid/str
                int64   <param2> = 2;  // integer JSON type
                double  <param3> = 3;  // number JSON type
                bool    <param4> = 4;  // boolean JSON type
            }
        }
    Response message:
        message <fn_name>Response {
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

Reflection:
    grpc_reflection v1alpha is enabled unconditionally so grpcurl can list,
    describe, and call methods without a local .proto file.

Startup signal:
    Emits ``{"ready": true}`` on stdout once the gRPC server is accepting
    connections — same §13.1 readiness protocol as flask_server.py.

What serve.ts needs to mount a gRPC host:
    - HTTP/2 front (gRPC is already HTTP/2 + length-prefixed framing)
    - Route pattern: ``/<namespace>.<Namespace>Service/<fn_name>``
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
from apigen_python.extractor import extract_module    # noqa: E402
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
# Per-method typed messages for ergonomic grpcurl calls:
#
#   message add_decimalRequest {
#       add_decimalRequest.Data data = 1;
#       message Data { string amount = 1; }
#   }
#   message add_decimalResponse { string data = 1; }
#
# grpcurl call:  -d '{"data":{"amount":"123.456"}}'
# ---------------------------------------------------------------------------

def _build_file_descriptor_proto(
    namespace: str,
    service_name: str,
    operations: list[dict[str, Any]],
) -> Any:
    """Build a FileDescriptorProto in memory for the given service.

    Each operation's input JSON Schema properties become the fields of the
    per-method ``Data`` sub-message.  The response is always a
    ``string data = 1`` field carrying the JSON-encoded result.

    Args:
        namespace:    Proto package name (e.g. "pkg").
        service_name: gRPC service name (e.g. "PkgService").
        operations:   List of operation dicts from the extractor.

    Returns:
        A ``google.protobuf.descriptor_pb2.FileDescriptorProto``.
    """
    from google.protobuf import descriptor_pb2  # type: ignore[import]

    file_proto = descriptor_pb2.FileDescriptorProto()
    file_proto.name = f"{namespace}.proto"
    file_proto.package = namespace
    file_proto.syntax = "proto3"

    for op in operations:
        fn_name: str = op["path"][-1]["raw"]
        input_schema: dict[str, Any] = op.get("input", {})
        input_props: dict[str, Any] = input_schema.get("properties", {})

        # --- Request message ---
        req_msg = file_proto.message_type.add()
        req_msg.name = f"{fn_name}Request"

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
        data_field.type_name = f".{namespace}.{fn_name}Request.Data"

        # --- Response message ---
        resp_msg = file_proto.message_type.add()
        resp_msg.name = f"{fn_name}Response"
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
        fn_name = op["path"][-1]["raw"]
        method = service.method.add()
        method.name = fn_name
        method.input_type = f".{namespace}.{fn_name}Request"
        method.output_type = f".{namespace}.{fn_name}Response"

    return file_proto


def _build_descriptor_pool(
    namespace: str,
    service_name: str,
    operations: list[dict[str, Any]],
) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    """Build a DescriptorPool + message classes for all operations.

    Args:
        namespace:    Proto package name.
        service_name: gRPC service name.
        operations:   Extracted operation descriptors.

    Returns:
        (pool, req_classes, resp_classes) where:
          pool         — a DescriptorPool pre-populated with the generated file,
                         suitable for passing to enable_server_reflection.
          req_classes  — {fn_name → Request message class}
          resp_classes — {fn_name → Response message class}
    """
    from google.protobuf import descriptor_pool, message_factory  # type: ignore[import]

    file_proto = _build_file_descriptor_proto(namespace, service_name, operations)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file_proto)

    req_classes: dict[str, Any] = {}
    resp_classes: dict[str, Any] = {}
    for op in operations:
        fn_name = op["path"][-1]["raw"]
        req_desc = pool.FindMessageTypeByName(f"{namespace}.{fn_name}Request")
        resp_desc = pool.FindMessageTypeByName(f"{namespace}.{fn_name}Response")
        req_classes[fn_name] = message_factory.GetMessageClass(req_desc)
        resp_classes[fn_name] = message_factory.GetMessageClass(resp_desc)

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
    from google.protobuf import descriptor_pb2  # type: ignore[import]

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
# ---------------------------------------------------------------------------

class _ServerState:
    """Immutable server configuration shared across all gRPC threads."""

    __slots__ = (
        "namespace", "service_name", "runtime", "operations",
        "op_map", "input_schema_map", "fn_names",
        "req_classes", "resp_classes",
    )

    def __init__(
        self,
        namespace: str,
        runtime: Runtime,
        operations: list[dict[str, Any]],
        req_classes: dict[str, Any],
        resp_classes: dict[str, Any],
    ) -> None:
        self.namespace = namespace
        # Service name: capitalise first letter.  "pkg" → "PkgService".
        self.service_name = namespace.capitalize() + "Service"
        self.runtime = runtime
        self.operations = operations
        self.req_classes = req_classes
        self.resp_classes = resp_classes

        self.op_map: dict[str, dict[str, Any]] = {}
        self.input_schema_map: dict[str, dict[str, Any]] = {}
        self.fn_names: list[str] = []

        for op in operations:
            fn_name = op["path"][-1]["raw"]
            self.op_map[fn_name] = op
            self.input_schema_map[fn_name] = op.get("input", {})
            self.fn_names.append(fn_name)


# ---------------------------------------------------------------------------
# GenericRpcHandler — dispatches all service methods using typed proto messages
# ---------------------------------------------------------------------------

class _ApigenGrpcHandler(grpc.GenericRpcHandler if _HAS_GRPC else object):  # type: ignore[misc]
    """Generic gRPC handler for the apigen service.

    Each gRPC method has fully typed request/response messages (built from the
    operation's input JSON schema) so grpcurl can call methods as:

        grpcurl -plaintext \\
            -d '{"data":{"amount":"123.456"}}' \\
            localhost:8950 pkg.PkgService/add_decimal

    The ``data`` field of the request is a typed sub-message whose fields
    correspond to the function's parameters (all logical-type params use
    ``string`` proto fields, carrying their canonical wire values).

    The ``data`` field of the response is a plain ``string`` carrying the
    JSON-encoded return value.
    """

    def __init__(self, state: "_ServerState") -> None:
        self._state = state
        self._full_service = f"{state.namespace}.{state.service_name}"

    def service_name(self) -> str:
        return self._full_service

    def service(self, handler_call_details: Any) -> Any:  # type: ignore[override]
        """Return an RpcMethodHandler for the requested method, or None."""
        method: str = handler_call_details.method
        prefix = f"/{self._full_service}/"
        if not method.startswith(prefix):
            return None
        fn_name = method[len(prefix):]
        if fn_name not in self._state.op_map:
            return None

        req_cls = self._state.req_classes[fn_name]
        resp_cls = self._state.resp_classes[fn_name]
        fn_name_captured = fn_name

        def _handle(request: Any, context: Any) -> Any:
            result_json = self._dispatch(fn_name_captured, request, context)
            resp = resp_cls()
            resp.data = result_json  # type: ignore[attr-defined]
            return resp

        return grpc.unary_unary_rpc_method_handler(
            _handle,
            request_deserializer=req_cls.FromString,
            response_serializer=lambda r: r.SerializeToString(),
        )

    def _dispatch(self, fn_name: str, request: Any, context: Any) -> str:
        """Extract params from the typed request → validate → invoke → encode.

        Args:
            fn_name:  The Python function name (= gRPC method name).
            request:  The decoded request proto message instance.
            context:  The grpc.ServicerContext for abort/metadata.

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
        input_schema = self._state.input_schema_map.get(fn_name, {})
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
            operation=self._state.op_map[fn_name],
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

    Method path:  ``/<namespace>.<Namespace>Service/<fn_name>``

    grpcurl example::

        grpcurl -plaintext \\
            -d '{"data":{"amount":"123.456"}}' \\
            localhost:8950 \\
            pkg.PkgService/add_decimal

    Wire contract (canonical apigen tenet):
      All logical types keep their string wire form in the proto ``string``
      field — ``date-time`` stays RFC3339, ``decimal`` stays a decimal string.
      No ``google.protobuf.Timestamp`` is used.
    """

    def __init__(
        self,
        module_path: str,
        namespace: str,
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
        self._namespace = namespace
        self._host = host
        self._port = port
        self._max_workers = max_workers
        self._server: Any = None

    def _build_state(self) -> "_ServerState":
        """Load the module, extract operations, build descriptors + server state."""
        ops = extract_module(self._module_path, namespace=self._namespace)
        if not ops:
            raise ValueError(
                f"No exportable operations found in {self._module_path!r}. "
                "Ensure the module has public callable exports."
            )

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
        for op in ops:
            fn_name = op["path"][-1]["raw"]
            fn = getattr(mod, fn_name, None)
            if callable(fn):
                registry[op["id"]] = fn

        runtime = Runtime(registry)

        # Filter to only callable operations (skip kind=query for gRPC).
        callable_ops = [op for op in ops if op.get("kind") in ("action", "constructor")]
        if not callable_ops:
            callable_ops = ops  # fall back to all ops

        service_name = self._namespace.capitalize() + "Service"
        pool, req_classes, resp_classes = _build_descriptor_pool(
            self._namespace, service_name, callable_ops
        )

        return _ServerState(
            namespace=self._namespace,
            runtime=runtime,
            operations=callable_ops,
            req_classes=req_classes,
            resp_classes=resp_classes,
        )

    def _pool(self) -> Any:
        """Return the DescriptorPool (used internally for reflection)."""
        return self._state_pool

    def start(self) -> None:
        """Build state + descriptors, create the gRPC server, start serving."""
        state = self._build_state()
        service_name = state.service_name

        # Re-build the pool for reflection (identical FileDescriptorProto).
        pool, _, _ = _build_descriptor_pool(
            state.namespace, service_name, state.operations
        )

        handler = _ApigenGrpcHandler(state)
        server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=self._max_workers)
        )
        server.add_generic_rpc_handlers([handler])

        # Register reflection with our custom pool so grpcurl list/describe works.
        service_names = [f"{state.namespace}.{service_name}"]
        try:
            reflection.enable_server_reflection(service_names, server, pool=pool)
        except Exception as exc:
            print(
                f"apigen-py-grpc  WARNING: reflection setup failed: {exc}",
                file=sys.stderr,
            )

        address = f"{self._host}:{self._port}"
        server.add_insecure_port(address)
        server.start()
        self._server = server

        # Print route summary to stderr (mirrors flask_server pattern).
        ns = state.namespace
        svc = service_name
        print(
            f"apigen-py-grpc  listening on grpc://{self._host}:{self._port}",
            file=sys.stderr,
        )
        print(f"  service: {ns}.{svc}", file=sys.stderr)
        for fn_name in state.fn_names:
            print(f"  method:  /{ns}.{svc}/{fn_name}", file=sys.stderr)
        sys.stderr.flush()

    def stop(self, grace: float = 2.0) -> None:
        """Shutdown the gRPC server gracefully."""
        if self._server is not None:
            self._server.stop(grace)
            self._server = None

    def serve_forever(self) -> None:
        """Start the server and block until SIGTERM / SIGINT / Ctrl-C.

        Emits ``{"ready": true}`` on stdout immediately after binding so the
        TS plugin subprocess launcher can detect readiness (same §13.1 protocol
        as flask_server.py).
        """
        self.start()
        # §13.1 readiness signal — TS launcher polls stdout for this line.
        print(json.dumps({"ready": True}), flush=True)

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
    host: str = "127.0.0.1",
    port: int = 50051,
) -> "ApigenGrpcServer":
    """Construct an :class:`ApigenGrpcServer` for the given module.

    Args:
        module_path: Path to the ``.py`` source file (absolute or relative).
        namespace:   The apigen namespace slug (used as the gRPC proto package).
        host:        Bind address (default ``127.0.0.1``).
        port:        TCP port (default ``50051``).

    Returns:
        An :class:`ApigenGrpcServer` instance ready to call ``.start()`` or
        ``.serve_forever()``.
    """
    return ApigenGrpcServer(module_path, namespace, host=host, port=port)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "apigen Python gRPC server — serves a .py module over gRPC.\n\n"
            "Service layout:\n"
            "  package: <namespace>\n"
            "  service: <Namespace>Service\n"
            "  methods: /<namespace>.<Namespace>Service/<fn_name>\n\n"
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
            "    localhost:8950 pkg.PkgService/add_decimal\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--module", required=True, help="Path to the Python source module")
    parser.add_argument("--namespace", required=True, help="Namespace slug (proto package name)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=50051, help="TCP port (default: 50051)")
    args = parser.parse_args()

    server = build_server(
        module_path=args.module,
        namespace=args.namespace,
        host=args.host,
        port=args.port,
    )
    server.serve_forever()


if __name__ == "__main__":
    _main()
