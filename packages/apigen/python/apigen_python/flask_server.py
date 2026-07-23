"""
apigen_python.flask_server — stdlib HTTP server for the Python apigen target (SPEC §14).

Runs each exported Python function as a real HTTP endpoint, mirroring the
TypeScript ``api-fastify`` plugin's route shape, validation contract, and
logical-type wire encoding.

Usage:
    python3 -m apigen_python.flask_server \\
        --module <path.py> \\
        --namespace <ns> \\
        --port <p>

Route contract (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — byte-identical to
`@adhd/apigen-engine-naming`'s `project(op).http`, the SAME derivation used by the
`openapi` mount plugin):
    POST <route>        body: {"data": {<param>: <value>, …}}
    GET  /_meta/health  → {"status": "ok", "host": "<ns>"}

    <route> = "/" + kebab(namespace) + "/" + kebab(pathSeg) + "/" + …
    (every §4 Segment — namespace AND each path segment, e.g. the file segment
    plus the export-name segment — is independently kebab-cased and joined
    with "/"; see `_route_for_op()` below). This is a pure re-derivation of
    `project()`'s algorithm against the Segment `words` the extractor already
    produces (`_seg()`), NOT a call into the TS package — Python cannot import
    `@adhd/apigen-engine-naming`, so the SAME shared algorithm is reimplemented here
    from the identical Segment structure.

    Verb is GET when the operation is `safe` OR its input is "primitive-only"
    per FEAT-APIGEN-022 (`_is_primitive_only_input_schema()` mirrors
    `@adhd/apigen-core-client`'s `isPrimitiveOnlyInputSchema()`); otherwise POST.

Validation:
    Input is validated BEFORE dispatch. Malformed input → HTTP 400
    {"code": "invalid_argument", "message": "…"}.

Logical types:
    Parameters whose schema carries ``format: "decimal"`` are decoded from their
    decimal-string wire form into ``decimal.Decimal`` before dispatch.  Return
    values are encoded back to their wire forms (datetime → RFC 3339 string,
    Decimal → decimal string, etc.) using ``apigen_logical.encode_value``.

Envelope:
    ``x-adhd-<field>`` request headers are read and forwarded to the function's
    ``ctx`` parameter (if present) as a dict, matching the §9.1 binding table.

Implementation note:
    Flask is not required.  This module uses Python's stdlib
    ``http.server.BaseHTTPRequestHandler`` with a ``ThreadingHTTPServer`` so
    each request runs in its own thread (for sync fns) or via asyncio
    (for async fns).  Flask is listed as an optional dependency in
    ``pyproject.toml``; when installed it is NOT used here (the stdlib
    implementation is production-ready for the apigen use-case).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import threading
import urllib.parse
from datetime import datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import UUID

# ---------------------------------------------------------------------------
# Bootstrap: make the package importable when run as __main__ from the
# repo root (python3 -m apigen_python.flask_server requires the package on
# sys.path, which is handled by -m; but for PYTHONPATH-based invocations we
# also accept the parent directory).
# ---------------------------------------------------------------------------

_THIS_DIR = Path(__file__).resolve().parent.parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from apigen_python.errors import ApiError, HTTP_STATUS  # noqa: E402
from apigen_python.extractor import extract_module  # noqa: E402
from apigen_python.runtime import HostRequest, Runtime  # noqa: E402
from apigen_python.validator import validate, ValidationError  # noqa: E402

# apigen_logical lives one level up from the package (repo layout):
# packages/apigen/python/apigen_logical.py
try:
    import apigen_logical  # type: ignore[import]
    _HAS_LOGICAL = True
except ImportError:
    _HAS_LOGICAL = False


# ---------------------------------------------------------------------------
# Logical-type decode helpers
# ---------------------------------------------------------------------------

def _decode_with_schema(value: Any, schema: dict[str, Any]) -> Any:
    """Schema-driven decode of a single wire value using apigen_logical.

    Falls back to identity when apigen_logical is not on sys.path.
    """
    if not _HAS_LOGICAL or not schema:
        return value
    return apigen_logical.decode(value, schema)


def _encode_result(value: Any) -> Any:
    """Encode a native Python return value to its canonical wire form.

    Uses apigen_logical.encode_value when available, otherwise handles the
    most common types (datetime, Decimal, UUID, bytes) directly.
    """
    if _HAS_LOGICAL:
        return apigen_logical.encode_value(value)
    # Fallback: handle the common cases so the server is usable without
    # apigen_logical on the path.
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


# ---------------------------------------------------------------------------
# Schema-driven parameter decode (apply logical types to each input param)
# ---------------------------------------------------------------------------

def _decode_params(data: dict[str, Any], input_schema: dict[str, Any]) -> dict[str, Any]:
    """Apply schema-driven decode to each parameter in the incoming data dict.

    Only runs for schemas that carry ``format`` annotations (date-time,
    decimal, etc.).  Plain string/int/bool params pass through unchanged.
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


# ---------------------------------------------------------------------------
# Envelope extraction from request headers (§9.1)
#
# Two complementary strategies are combined:
#
# 1. Schema-driven (mirrors api-fastify): for each non-'data' field declared
#    in the input schema's top-level properties, read the header named by
#    the §9.1 binding (x-<pluginId>-<field>).  This is the TS-side contract.
#
# 2. Direct x-adhd-* header scan: in Python, the 'ctx' first-parameter is
#    stripped from the input schema by the extractor (§4 inv:ctx-name-only),
#    so there is no schema field to match against.  Instead we read ALL
#    x-adhd-<field> headers and include them in the envelope.  The runtime's
#    _build_kwargs() already knows to pass the entire envelope dict to the
#    function's 'ctx' parameter.
#
# The two strategies are merged (schema-driven wins on key conflicts).
# ---------------------------------------------------------------------------

_X_ADHD_PREFIX = "x-adhd-"


def _extract_envelope(
    input_schema: dict[str, Any],
    headers: dict[str, str],
) -> dict[str, Any]:
    """Extract envelope values from request headers per §9.1.

    Combines schema-driven extraction (for TS-style envelope fields declared
    in the schema) with a direct scan of all ``x-adhd-*`` headers (for
    Python ``ctx`` parameters whose schema entry is stripped by the extractor).

    Args:
        input_schema: The operation's top-level input schema (with 'properties').
        headers:      The request headers (lowercased keys -> value strings).

    Returns:
        Dict of envelope field name -> header value for all matched fields.
    """
    envelope: dict[str, Any] = {}

    # Strategy 1: collect ALL x-adhd-* headers directly.
    # This ensures `ctx` functions receive headers even when no schema field
    # declares them (the extractor strips 'ctx' from input properties).
    for key, value in headers.items():
        if key.startswith(_X_ADHD_PREFIX):
            field = key[len(_X_ADHD_PREFIX):]
            if field:
                envelope[field] = value

    # Strategy 2: schema-driven extraction for non-'data' declared properties
    # (mirrors api-fastify's extractEnvelopeFromHeaders).  May add fields for
    # envelope fields declared by the schema under a non-'adhd' pluginId.
    props: dict[str, Any] = input_schema.get("properties", {})
    meta: dict[str, str] = input_schema.get("x-apigen-envelope", {})
    for field in props:
        if field == "data":
            continue
        plugin_id = meta.get(field, "adhd")
        if plugin_id == "adhd":
            # Already covered by Strategy 1 above.
            continue
        header_name = f"x-{plugin_id}-{field}"
        value = headers.get(header_name)
        if value is not None:
            envelope[field] = value

    return envelope


# ---------------------------------------------------------------------------
# HTTP route + verb — BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001
#
# Byte-identical re-derivation of `@adhd/apigen-engine-naming`'s `project(op).http`
# (route) and the FEAT-APIGEN-022 GET-hoist rule it applies for verb — see the
# module docstring's "Route contract" section for the full rationale. Python
# cannot import the TS package, so both algorithms are reimplemented here
# against the SAME Segment (`{"raw", "words"}`) structures `extract_module()`
# already builds via `_seg()`, which is itself documented as mirroring the TS
# tokeniser exactly.
# ---------------------------------------------------------------------------

def _kebab(seg: dict[str, Any]) -> str:
    """Kebab-case a §4 Segment — mirrors apigen-naming's `toKebab()`."""
    return "-".join(seg["words"])


def _route_for_op(op: dict[str, Any]) -> str:
    """Canonical HTTP route for an operation.

    Mirrors `@adhd/apigen-engine-naming`'s `project(op).http.route`:
    `'/' + [namespace, ...path].map(toKebab).join('/')`. Every segment
    (namespace AND each path segment) is independently kebab-cased — this is
    what api-fastify/openapi/mcp all derive from, and what this server must
    match byte-for-byte.
    """
    segs = [op["namespace"], *op["path"]]
    return "/" + "/".join(_kebab(s) for s in segs)


_PRIMITIVE_TYPES = {"string", "number", "boolean", "integer"}


def _is_primitive_only_input_schema(input_schema: dict[str, Any] | None) -> bool:
    """Port of `@adhd/apigen-core-client`'s `isPrimitiveOnlyInputSchema()`
    (FEAT-APIGEN-022) — structural check over a bare domain-input JSON Schema.

    Returns True iff every declared property is a "properly typed primitive"
    (string/number/boolean/integer, optionally unioned with null), including
    the vacuous zero-property case. Absence of a `properties` key entirely
    (as opposed to an explicit empty object) returns False.
    """
    if not isinstance(input_schema, dict):
        return False
    if "properties" not in input_schema:
        return False
    properties = input_schema["properties"]
    if not isinstance(properties, dict):
        return False
    return all(_is_primitive_property_schema(p) for p in properties.values())


def _is_primitive_property_schema(prop_schema: Any) -> bool:
    if not isinstance(prop_schema, dict):
        return False
    if "$ref" in prop_schema:
        return False
    if prop_schema.get("oneOf") or prop_schema.get("anyOf") or prop_schema.get("allOf"):
        return False

    type_ = prop_schema.get("type")
    if isinstance(type_, str):
        return type_ in _PRIMITIVE_TYPES
    if isinstance(type_, list):
        return all(t in _PRIMITIVE_TYPES or t == "null" for t in type_)

    enum = prop_schema.get("enum")
    if isinstance(enum, list) and len(enum) > 0:
        return all(isinstance(v, (str, int, float, bool)) for v in enum)

    return False


def _http_verb(op: dict[str, Any]) -> str:
    """Return 'GET' when safe OR primitive-only-input (FEAT-APIGEN-022),
    else 'POST' — mirrors `@adhd/apigen-engine-naming`'s `project()` default-verb rule.
    """
    if op.get("safe", False) or _is_primitive_only_input_schema(op.get("input")):
        return "GET"
    return "POST"


# ---------------------------------------------------------------------------
# JSON serialisation helper — handles non-standard types gracefully
# ---------------------------------------------------------------------------

def _json_dumps(obj: Any) -> str:
    """Serialise obj to JSON, using ApigenEncoder if available."""
    if _HAS_LOGICAL:
        return json.dumps(obj, cls=apigen_logical.ApigenEncoder)
    return json.dumps(obj)


# ---------------------------------------------------------------------------
# Server state — built once on startup, shared across request threads
# ---------------------------------------------------------------------------

class _ServerState:
    """Immutable server configuration shared across all request threads."""

    __slots__ = ("namespace", "runtime", "operations", "route_map")

    def __init__(
        self,
        namespace: str,
        runtime: Runtime,
        operations: list[dict[str, Any]],
    ) -> None:
        self.namespace = namespace
        self.runtime = runtime
        self.operations = operations
        # Map canonical HTTP route (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001:
        # `_route_for_op()`, byte-identical to apigen-naming's project().http.route)
        # → operation descriptor, for O(1) request dispatch. The operation's
        # `input` dict IS the inner param schema directly (no data-wrapper in the
        # extractor's output — that wrapper is a TS-side composition artifact;
        # the Python runtime receives bare params), so no separate schema map
        # is needed alongside this.
        self.route_map: dict[str, dict[str, Any]] = {}
        for op in operations:
            self.route_map[_route_for_op(op)] = op


# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------

class _ApigenHandler(BaseHTTPRequestHandler):
    """HTTP handler wired to a _ServerState via the server's `state` attribute."""

    # Suppress the default request log lines; we print our own.
    def log_message(self, _fmt: str, *_args: Any) -> None:  # noqa: ANN001
        pass

    def log_error(self, _fmt: str, *_args: Any) -> None:  # noqa: ANN001
        pass

    # ------------------------------------------------------------------
    # Route: GET /_meta/health
    # ------------------------------------------------------------------

    def _handle_health(self) -> None:
        ns = self.server.state.namespace  # type: ignore[attr-defined]
        body = _json_dumps({"status": "ok", "host": ns}).encode()
        self._send_json(200, body)

    # ------------------------------------------------------------------
    # Route: GET <route> (safe / primitive-only-input ops — query-string params)
    # ------------------------------------------------------------------

    def _handle_safe_get(self, op: dict[str, Any]) -> None:
        # Parse query-string → data dict
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        # Flatten single-value lists (query-string repeats are unusual for APIs)
        data: dict[str, Any] = {k: v[0] if len(v) == 1 else v for k, v in qs.items()}

        self._dispatch(op, data, envelope_from_headers=True)

    # ------------------------------------------------------------------
    # Route: POST <route>
    # ------------------------------------------------------------------

    def _handle_post(self, op: dict[str, Any]) -> None:
        # Read body
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            body = json.loads(body_bytes or b"{}")
        except json.JSONDecodeError as exc:
            self._send_error(400, "invalid_argument", f"JSON parse error: {exc}")
            return

        if not isinstance(body, dict):
            self._send_error(400, "invalid_argument", "request body must be a JSON object")
            return

        data = body.get("data", {})
        if not isinstance(data, dict):
            self._send_error(400, "invalid_argument", '"data" must be a JSON object')
            return

        self._dispatch(op, data, envelope_from_headers=True)

    # ------------------------------------------------------------------
    # Dispatch (shared between GET/POST paths)
    # ------------------------------------------------------------------

    def _dispatch(
        self,
        op: dict[str, Any],
        data: dict[str, Any],
        *,
        envelope_from_headers: bool,
    ) -> None:
        """Validate input → decode logical types → invoke → encode result → respond."""
        state: _ServerState = self.server.state  # type: ignore[attr-defined]

        # The operation's `input` IS the inner param schema (no data-wrapper —
        # see _ServerState.route_map's doc comment).
        input_schema: dict[str, Any] = op.get("input", {})

        # §9.1 envelope from headers
        envelope: dict[str, Any] = {}
        if envelope_from_headers:
            headers_lc = {k.lower(): v for k, v in self.headers.items()}
            envelope = _extract_envelope(input_schema, headers_lc)

        # SPEC §6: validate BEFORE dispatch (malformed → 400 before fn is called)
        if input_schema:
            try:
                validate(input_schema, data)
            except ValidationError as exc:
                self._send_error(400, "invalid_argument", f"input validation failed: {exc}")
                return

        # Schema-driven decode for logical types (Decimal, datetime, etc.)
        decoded_data = _decode_params(data, input_schema)

        # Build the HostRequest for the runtime.
        # pre_validated=True tells the runtime not to re-validate the data
        # (which now contains decoded native values like Decimal/datetime) against
        # the wire-schema — we already validated the raw wire data above.
        host_req = HostRequest(
            operation=op,
            data=decoded_data,
            envelope=envelope,
            transport="http",
            pre_validated=True,
        )

        try:
            result = state.runtime.invoke_sync(host_req)
        except ApiError as exc:
            status = HTTP_STATUS.get(exc.code, 500)
            self._send_error(status, exc.code, exc.message)
            return
        except Exception as exc:
            self._send_error(500, "internal", f"dispatch error: {exc}")
            return

        # Encode the result to its canonical wire form
        wire_result = _encode_result(result)

        body = _json_dumps(wire_result).encode()
        self._send_json(200, body)

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        """Handle GET requests: health endpoint + GET-eligible operations.

        Routing is a direct lookup of the full request path against
        `state.route_map` (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001) — the
        canonical, kebab-cased, multi-segment route computed by
        `_route_for_op()`, NOT a `/<ns>/<lastSegmentRaw>` prefix strip. This is
        what makes a multi-segment op (namespace + file segment + export
        segment, e.g. `/testapi/test-api/echo-str`) resolve at all — the old
        prefix-strip approach silently dropped every segment but the last.
        """
        parsed = urllib.parse.urlparse(self.path)
        path_only = parsed.path

        if path_only == "/_meta/health":
            self._handle_health()
            return

        state: _ServerState = self.server.state  # type: ignore[attr-defined]
        op = state.route_map.get(path_only)
        if op is not None:
            if _http_verb(op) == "GET":
                self._handle_safe_get(op)
                return
            # Known route but wrong verb (POST-only operation).
            self._send_error(405, "invalid_argument", f"use POST for {path_only}")
            return

        self._send_error(404, "not_found", f"no route for GET {path_only}")

    def do_POST(self) -> None:  # noqa: N802
        """Handle POST requests: function dispatch via the canonical route map
        (see `do_GET`'s doc comment for why this is a full-path lookup, not a
        prefix strip)."""
        parsed = urllib.parse.urlparse(self.path)
        path_only = parsed.path

        state: _ServerState = self.server.state  # type: ignore[attr-defined]
        op = state.route_map.get(path_only)
        if op is not None:
            self._handle_post(op)
            return

        self._send_error(404, "not_found", f"no route for POST {path_only}")

    # ------------------------------------------------------------------
    # Response helpers
    # ------------------------------------------------------------------

    def _send_json(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, code: str, message: str) -> None:
        body = _json_dumps({"code": code, "message": message}).encode()
        self._send_json(status, body)


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

class ApigenFlaskServer:
    """Thin wrapper around ThreadingHTTPServer for lifecycle management.

    Named 'Flask' in the public API for consistency with the deliverable spec,
    but implemented with stdlib ``http.server`` (Flask is an optional dep).
    """

    def __init__(
        self,
        module_path: str,
        namespace: str,
        host: str = "127.0.0.1",
        port: int = 8000,
    ) -> None:
        self._module_path = module_path
        self._namespace = namespace
        self._host = host
        self._port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def _build_state(self) -> _ServerState:
        """Load the module, extract operations, and build the server state."""
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
        spec = importlib.util.spec_from_file_location("_apigen_flask_module_", str(path))
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

        # Build fn_registry: op_id → callable
        registry: dict[str, Any] = {}
        for op in ops:
            fn_name = op["path"][-1]["raw"]
            fn = getattr(mod, fn_name, None)
            if callable(fn):
                registry[op["id"]] = fn

        runtime = Runtime(registry)
        return _ServerState(
            namespace=self._namespace,
            runtime=runtime,
            operations=ops,
        )

    def start(self) -> None:
        """Build state and start the HTTP server in a background thread."""
        state = self._build_state()

        class _Server(ThreadingHTTPServer):
            pass

        httpd = _Server((self._host, self._port), _ApigenHandler)
        httpd.state = state  # type: ignore[attr-defined]
        self._httpd = httpd

        # Log the registered routes to stderr — canonical route (parity with
        # apigen-naming's project().http.route; BUG-APIGEN-OPENAPI-ROUTE-PATH-
        # MISMATCH-001), not the old `/<ns>/<lastSegmentRaw>` shape.
        print(f"apigen-py-flask  listening on http://{self._host}:{self._port}", file=sys.stderr)
        print(f"  GET  /_meta/health", file=sys.stderr)
        for op in state.operations:
            route = _route_for_op(op)
            verb = _http_verb(op)
            print(f"  {verb:<4} {route}", file=sys.stderr)
        sys.stderr.flush()

        self._thread = threading.Thread(
            target=httpd.serve_forever,
            daemon=True,
            name="apigen-flask-http",
        )
        self._thread.start()

    def stop(self) -> None:
        """Shutdown the HTTP server."""
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd = None

    def serve_forever(self) -> None:
        """Block until interrupted (Ctrl-C / SIGTERM).

        Prints the §13.1-compatible readiness signal ``{"ready": true}`` to
        stdout immediately after the server thread starts, so the TS plugin
        subprocess launcher can poll for it.
        """
        self.start()
        # §13.1 readiness signal — TS launcher polls for this line on stdout
        print(json.dumps({"ready": True}), flush=True)
        try:
            # Block main thread while the daemon thread serves
            if self._thread is not None:
                self._thread.join()
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
    port: int = 8000,
) -> ApigenFlaskServer:
    """Construct an :class:`ApigenFlaskServer` for the given module.

    Args:
        module_path: Path to the ``.py`` source file (absolute or relative).
        namespace:   The apigen namespace slug (used as the route prefix).
        host:        Bind address (default ``127.0.0.1``).
        port:        TCP port (default ``8000``).

    Returns:
        An :class:`ApigenFlaskServer` instance ready to call ``.start()`` or
        ``.serve_forever()``.
    """
    return ApigenFlaskServer(module_path, namespace, host=host, port=port)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "apigen Python HTTP server — serves a .py module over HTTP.\n\n"
            "Routes (byte-identical to @adhd/apigen-engine-naming's project().http —\n"
            "BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001):\n"
            "  GET  /_meta/health  → {status, host}\n"
            "  POST <route>        → body {data: {<params>}} → result\n"
            "  GET  <route>        → query-string (safe OR primitive-only-input ops)\n"
            "  <route> = /<kebab-namespace>/<kebab-pathSeg>/…  (multi-segment)\n\n"
            "Startup: emits {ready: true} on stdout once the server is up."
        )
    )
    parser.add_argument(
        "--module", required=True,
        help="Path to the Python source module to serve"
    )
    parser.add_argument(
        "--namespace", required=True,
        help="Namespace slug used as the URL prefix (e.g. 'myapi')"
    )
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="Bind host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=8000,
        help="TCP port (default: 8000)"
    )
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
