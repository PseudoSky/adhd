"""
apigen_python.flask_server — stdlib HTTP server for the Python apigen target (SPEC §14).

Runs each exported Python function as a real HTTP endpoint, mirroring the
TypeScript ``api-fastify`` plugin's route shape, validation contract, and
logical-type wire encoding.

Usage (apigen-serve-core py-flask-serve-split — two-phase extract/serve split):
    python3 -m apigen_python.flask_server \\
        --module <path.py> \\
        --namespace <ns> \\
        --port <p> \\
        --plan-file <plan.json>

    This server no longer self-extracts or derives its own route/verb table.
    `--plan-file` is REQUIRED and points to a JSON file of the shape
    `{"operations": [...Operation dicts, exactly what `apigen_python.extractor
    --emit-json` emits...], "routes": {"<opId>": {"route": "<path>", "verb":
    "GET"|"POST"}}}`, produced by the TS `py-flask` plugin's two-phase spawn:
    (1) spawn `apigen_python.extractor --emit-json` in a short-lived process
    to get `Operation[]`, (2) call the REAL `@adhd/apigen-engine-naming`
    `project(op).http` on each op — the SAME canonical projector every other
    transport (fastify/express/mcp/cli) uses — (3) spawn THIS server with the
    result. See `packages/apigen/apigen-plugin-py-flask/src/lib/plugin.ts`.

Route contract (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — byte-identical to
`@adhd/apigen-engine-naming`'s `project(op).http`, the SAME derivation used by the
`openapi` mount plugin):
    POST <route>        body: {"data": {<param>: <value>, …}}
    GET  /_meta/health  → {"status": "ok", "host": "<ns>"}

    <route>/<verb> are computed ONCE, TS-side, by the REAL `project()` and
    injected via `--plan-file` (see "Usage" above) — this module no longer
    contains a Python port of that algorithm. Previously (pre apigen-serve-
    core py-flask-serve-split) `_route_for_op()`/`_http_verb()`/
    `_is_primitive_only_input_schema()` reimplemented `project()`'s formula
    byte-for-byte against the Segment `words` the extractor produces, because
    Python cannot import the TS package and there was no IPC channel to carry
    TS-computed values across the process boundary. That channel now exists
    (the two-phase extractor `--emit-json` → `project()` → `--plan-file`
    pipeline), so the Python re-derivation was deleted rather than kept as a
    redundant fallback — one algorithm, one place, byte-identical by
    construction instead of by manual synchronization.

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
from concurrent.futures import ThreadPoolExecutor
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
from apigen_python.parent_watchdog import start_parent_death_watchdog  # noqa: E402
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
# JSON serialisation helper — handles non-standard types gracefully
# ---------------------------------------------------------------------------

def _json_dumps(obj: Any) -> str:
    """Serialise obj to JSON, using ApigenEncoder if available."""
    if _HAS_LOGICAL:
        return json.dumps(obj, cls=apigen_logical.ApigenEncoder)
    return json.dumps(obj)


# ---------------------------------------------------------------------------
# Server state — built once on startup, shared across request threads
#
# apigen-serve-core py-flask-serve-split: route + verb are no longer derived
# here. `_route_for_op()` / `_http_verb()` / `_is_primitive_only_input_schema()`
# (formerly here, a hand-maintained Python port of `@adhd/apigen-engine-naming`'s
# `project(op).http`) are DELETED — see the module docstring's "Route
# contract" section. `routes` is the TS-computed `{opId: {route, verb}}` map
# injected via `--plan-file`.
# ---------------------------------------------------------------------------

class _RouteEntry:
    """One resolved route: the operation it dispatches to + its TS-computed verb."""

    __slots__ = ("op", "verb")

    def __init__(self, op: dict[str, Any], verb: str) -> None:
        self.op = op
        self.verb = verb


class _ServerState:
    """Immutable server configuration shared across all request threads."""

    __slots__ = ("namespace", "runtime", "operations", "route_map", "route_map_by_op_id")

    def __init__(
        self,
        namespace: str,
        runtime: Runtime,
        operations: list[dict[str, Any]],
        routes: dict[str, dict[str, str]],
    ) -> None:
        self.namespace = namespace
        self.runtime = runtime
        self.operations = operations
        # Map canonical HTTP route → _RouteEntry(op, verb), for O(1) request
        # dispatch. `routes[op["id"]]` supplies BOTH the route and the verb,
        # computed TS-side by the REAL `@adhd/apigen-engine-naming` `project()`
        # (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001) — not re-derived here.
        # The operation's `input` dict IS the inner param schema directly (no
        # data-wrapper in the extractor's output — that wrapper is a TS-side
        # composition artifact; the Python runtime receives bare params), so
        # no separate schema map is needed alongside this.
        self.route_map: dict[str, _RouteEntry] = {}
        # (batch-rollout F8) op id -> _RouteEntry, built from the SAME loop
        # that builds route_map above. `_dispatch_batch` resolves a batch
        # request's `operation` field (an operation ID, not a URL path) to
        # its real, dispatchable route entry through this index — `route_map`
        # alone (keyed by URL path) cannot serve that lookup.
        self.route_map_by_op_id: dict[str, _RouteEntry] = {}
        for op in operations:
            entry = routes.get(op["id"])
            if entry is None:
                raise ValueError(
                    f"apigen-py-flask: --plan-file is missing a routes entry "
                    f"for operation id {op['id']!r} — the injected plan must "
                    f"cover every operation extract_module() (phase 1) "
                    f"produced, 1:1."
                )
            route_entry = _RouteEntry(op=op, verb=entry["verb"])
            self.route_map[entry["route"]] = route_entry
            self.route_map_by_op_id[op["id"]] = route_entry


# ---------------------------------------------------------------------------
# Batch/bulk fan-out (`_batch/<kind>`) — BATCH_0.0.1.md §5, this host's own
# executor implementation, ported from the design at
# tmp/apigen-batch-python-design.md (§2.2, corrected per §3.5's architect-
# review findings F2-F5). This is the Python-idiom equivalent of the TS
# `invokeBatch` (`apigen-engine-runtime/src/lib/batch.ts`), never a call into
# it — the target op is dispatched locally, the same way every other route on
# this server already dispatches, N times, with concurrency/mode/onItemError
# control.
# ---------------------------------------------------------------------------

# (F7) Hard cap on requested concurrency — a literal port of the TS
# constant's VALUE (intentionally duplicated per-host rather than unified
# into one cross-language source of truth; there is no cross-language
# constant-sharing mechanism in this repo today — see
# `apigen-engine-runtime/src/lib/batch.ts:35`'s
# `export const BATCH_MAX_CONCURRENCY = 32;`).
BATCH_MAX_CONCURRENCY = 32

# Mirrors `apigen-engine-runtime/src/lib/batch.ts`'s
# `BATCH_DEFAULT_CONCURRENCY = 4` — the fan-out width used when the request
# doesn't specify one.
BATCH_DEFAULT_CONCURRENCY = 4


def _not_attempted_reason(mode: str) -> dict[str, Any]:
    """The per-item rejection reason for an item never attempted because an
    earlier item aborted the whole batch (F5): a REAL
    ``ApiError('internal', ...).to_json()``, never a hand-rolled dict with an
    invented ``'cancelled'`` code that exists in neither ``errors.py``'s
    taxonomy nor ``apigen-base-errors`` — mirrors TS `invokeBatch`'s own
    `notAttempted()` mapping (`apigen-engine-runtime/src/lib/batch.ts`)."""
    if mode == "chained":
        message = (
            "batch aborted (mode=chained) — an earlier item failed and this "
            "item was never attempted"
        )
    else:
        message = (
            "batch aborted (onItemError=abort) — an earlier item failed and "
            "this item was never attempted"
        )
    return ApiError("internal", message).to_json()


def _run_batch_item(
    state: _ServerState,
    entry: _RouteEntry,
    index: int,
    item: Any,
    envelope: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch ONE batch item through the SAME validate -> decode logical
    types -> invoke -> encode result pipeline `_ApigenHandler._dispatch`
    already performs for a real single-op request (F4 — logical-type
    parity). Never a bypass of `_decode_params`/`pre_validated=True`/
    `_encode_result`; the only difference from `_dispatch` is that a failure
    here becomes a per-item `BatchItemResult` instead of an HTTP response.
    """
    input_schema: dict[str, Any] = entry.op.get("input", {})
    try:
        data = item if isinstance(item, dict) else {}

        # SPEC §6: validate BEFORE dispatch, exactly like the single-op path.
        if input_schema:
            try:
                validate(input_schema, data)
            except ValidationError as exc:
                raise ApiError(
                    "invalid_argument", f"input validation failed: {exc}"
                ) from exc

        # Schema-driven logical-type decode (Decimal, datetime, ...) — F4.
        decoded_data = _decode_params(data, input_schema)

        host_req = HostRequest(
            operation=entry.op,
            data=decoded_data,
            envelope=envelope,
            transport="http",
            pre_validated=True,
        )
        value = state.runtime.invoke_sync(host_req)
        return {"index": index, "status": "fulfilled", "value": _encode_result(value)}
    except ApiError as exc:
        return {"index": index, "status": "rejected", "reason": exc.to_json()}
    except Exception as exc:  # noqa: BLE001 - must never leak a bare traceback over the wire
        return {
            "index": index,
            "status": "rejected",
            "reason": ApiError("internal", f"dispatch error: {exc}").to_json(),
        }


def _resolve_batch_concurrency(mode: str, requested: Any, item_count: int) -> int:
    """Mirror `apigen-engine-runtime/src/lib/batch.ts`'s `resolveConcurrency`:
    `serial`/`chained` are always width-1 (never reach this — callers only
    invoke this for `mode == 'parallel'`), a bad/missing request falls back
    to `BATCH_DEFAULT_CONCURRENCY`, and the result is always clamped to
    `[1, BATCH_MAX_CONCURRENCY]` and never exceeds the item count (so
    `ThreadPoolExecutor` is never constructed with `max_workers=0`).
    """
    if requested is None or not isinstance(requested, (int, float)) or requested < 1:
        n = BATCH_DEFAULT_CONCURRENCY
    else:
        n = int(requested)
    n = min(n, BATCH_MAX_CONCURRENCY)
    return max(1, min(n, max(item_count, 1)))


def _dispatch_batch(
    state: _ServerState, body: dict[str, Any], envelope: dict[str, Any]
) -> list[dict[str, Any]]:
    """Fan out `body['items']` to the real operation `body['operation']` —
    the Python host's OWN executor against BATCH_0.0.1.md §5's wire contract
    (LEFT column only; this function is never a call into the TS
    `invokeBatch`). Implements the architect-reviewed design's binding fixes
    (`tmp/apigen-batch-python-design.md` §3.5):

    - F2: `mode` branching — `parallel` uses a bounded `ThreadPoolExecutor`;
      `serial`/`chained` use a plain sequential loop; `chained` additionally
      stops on the first failure regardless of `onItemError`.
    - F3: `itemTimeoutMs` is rejected upfront (whole-batch `invalid_argument`)
      — `Runtime.invoke_sync` has no timeout kwarg / cancellation hook, so no
      partial/best-effort cancellation is offered under the same field name
      TS uses for real `AbortSignal`-based cancellation.
    - F4: every item goes through `_run_batch_item`'s real
      validate/decode/invoke/encode pipeline (logical-type parity with the
      single-op path); the nested-batch guard checks the `_batch/` ID
      PREFIX, never `op["kind"] == "batch"` (impossible — `kind` is always
      the real grouped kind, e.g. `'action'`/`'query'`).
    - F5: every rejected result's `reason` is a real `ApiError(...).to_json()`
      using an existing `errors.py` taxonomy code.

    Raises:
        ApiError: for whole-request-level rejections (bad `operation`,
            unsupported `itemTimeoutMs`, malformed `items`/`mode`/
            `onItemError`/`concurrency`) — the caller maps this to a real
            HTTP 4xx via `_send_error`, the SAME mechanism every other route
            on this server already uses.
    """
    # F3 — reject the WHOLE batch upfront; never a silently-weaker
    # wait-only guarantee under the same field name TS uses for real
    # cancellation.
    if body.get("itemTimeoutMs") is not None:
        raise ApiError(
            "invalid_argument",
            "itemTimeoutMs is not supported by the Python host",
        )

    target_op_id = body.get("operation")
    if not isinstance(target_op_id, str) or not target_op_id:
        raise ApiError(
            "invalid_argument",
            '"operation" must be a non-empty string naming the target operation id',
        )
    # F4 — the nested-batch guard checks the ID PREFIX (`syntheticOp` always
    # names batch mounts this way), NOT `op["kind"] == "batch"` (impossible:
    # `kind` on a real target op is always its real grouped kind, never the
    # literal string 'batch').
    if target_op_id.startswith("_batch/"):
        raise ApiError(
            "invalid_argument",
            f"not a real batchable operation: {target_op_id!r} is itself a "
            "batch mount",
        )
    entry = state.route_map_by_op_id.get(target_op_id)
    if entry is None:
        raise ApiError(
            "invalid_argument",
            f"not a real batchable operation: {target_op_id!r} is not one "
            "of this server's operations",
        )

    items = body.get("items")
    if not isinstance(items, list):
        raise ApiError("invalid_argument", '"items" must be an array')

    mode = body.get("mode", "parallel")
    if mode not in ("parallel", "serial", "chained"):
        raise ApiError(
            "invalid_argument",
            '"mode" must be one of "parallel" | "serial" | "chained"',
        )
    on_item_error = body.get("onItemError", "continue")
    if on_item_error not in ("continue", "abort"):
        raise ApiError(
            "invalid_argument",
            '"onItemError" must be one of "continue" | "abort"',
        )
    requested_concurrency = body.get("concurrency")
    if requested_concurrency is not None and not isinstance(requested_concurrency, (int, float)):
        raise ApiError("invalid_argument", '"concurrency" must be a number')

    results: list[dict[str, Any] | None] = [None] * len(items)

    # F2 — serial/chained: a plain sequential loop, no thread pool at all
    # (strictly simpler than the parallel path below).
    if mode in ("serial", "chained"):
        stop = False
        for i, item in enumerate(items):
            if stop:
                results[i] = {
                    "index": i,
                    "status": "rejected",
                    "reason": _not_attempted_reason(mode),
                }
                continue
            result = _run_batch_item(state, entry, i, item, envelope)
            results[i] = result
            if result["status"] == "rejected" and (mode == "chained" or on_item_error == "abort"):
                stop = True
        return results  # type: ignore[return-value]

    # F2 — parallel: bounded ThreadPoolExecutor, the idiomatic sync-Python
    # equivalent of TS's worker-pool scheduler (runtime.invoke is NOT used —
    # introducing asyncio into this synchronous BaseHTTPRequestHandler server
    # is out of scope; see the design doc's "Concurrency primitive" note).
    concurrency = _resolve_batch_concurrency(mode, requested_concurrency, len(items))
    aborted = threading.Event()

    def run_one(i: int, item: Any) -> None:
        if aborted.is_set():
            results[i] = {
                "index": i,
                "status": "rejected",
                "reason": _not_attempted_reason(mode),
            }
            return
        result = _run_batch_item(state, entry, i, item, envelope)
        results[i] = result
        if result["status"] == "rejected" and on_item_error == "abort":
            # Stop starting NEW items once one fails — cannot un-submit
            # already-running thread-pool work, identical in spirit to TS's
            # `onItemError:'abort'` behavior (in-flight items are allowed to
            # finish; they are not force-cancelled).
            aborted.set()

    if items:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(run_one, i, item) for i, item in enumerate(items)]
            for f in futures:
                f.result()  # propagate any genuinely unexpected exception loudly

    return results  # type: ignore[return-value]


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
    # Route: POST <route> for a synthetic `_batch/<kind>` mount
    # (BATCH_0.0.1.md §5 — see `_dispatch_batch`'s own doc comment).
    # ------------------------------------------------------------------

    def _handle_batch_post(self, op: dict[str, Any]) -> None:
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

        state: _ServerState = self.server.state  # type: ignore[attr-defined]

        # §9.1 envelope from headers, extracted once and shared across every
        # item — mirrors the TS `invokeBatch` call site, which also threads
        # ONE shared `call.envelope` across every fanned-out item (never a
        # per-item envelope).
        headers_lc = {k.lower(): v for k, v in self.headers.items()}
        envelope = _extract_envelope(op.get("input", {}), headers_lc)

        try:
            results = _dispatch_batch(state, body, envelope)
        except ApiError as exc:
            status = HTTP_STATUS.get(exc.code, 500)
            self._send_error(status, exc.code, exc.message)
            return
        except Exception as exc:
            self._send_error(500, "internal", f"batch dispatch error: {exc}")
            return

        body_out = _json_dumps(results).encode()
        self._send_json(200, body_out)

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
        entry = state.route_map.get(path_only)
        if entry is not None:
            if entry.verb == "GET":
                self._handle_safe_get(entry.op)
                return
            # Known route but wrong verb (POST-only operation, per the
            # TS-computed --plan-file verb — see _ServerState's doc comment).
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
        entry = state.route_map.get(path_only)
        if entry is not None:
            # (batch-rollout) A synthetic `_batch/<kind>` mount's op id is
            # the authoritative marker (`syntheticOp` always names batch
            # mounts this way — F4) — never `entry.op.get("kind")`, which on
            # a batch mount is its real grouped kind (e.g. 'action'), not the
            # literal string 'batch'.
            if entry.op.get("id", "").startswith("_batch/"):
                self._handle_batch_post(entry.op)
            else:
                self._handle_post(entry.op)
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
        plan: dict[str, Any],
        host: str = "127.0.0.1",
        port: int = 8000,
    ) -> None:
        self._module_path = module_path
        self._namespace = namespace
        self._plan = plan
        self._host = host
        self._port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def _build_state(self) -> _ServerState:
        """Build the server state from the INJECTED `--plan-file` — this
        server no longer self-extracts (apigen-serve-core py-flask-serve-
        split). `self._plan["operations"]` supplies the full Operation[]
        (schema-bearing dicts, produced by `apigen_python.extractor
        --emit-json` in a separate, short-lived process — see plugin.ts's
        two-phase spawn) and `self._plan["routes"]` supplies the per-op
        canonical route/verb, computed by the REAL `@adhd/apigen-engine-naming`
        `project()` — never re-derived here.

        The module is still loaded a SECOND time, independently, right here —
        that load's only job is producing LIVE function references for the
        runtime registry, which cannot cross a process boundary as data
        (Python callables are not serialisable). This is unchanged from the
        pre-split design and was confirmed safe by
        `docs/apigen/proposals/py-extract-serve-split-findings.md` §1.2/§1.4.
        """
        ops: list[dict[str, Any]] = self._plan["operations"]
        routes: dict[str, dict[str, str]] = self._plan["routes"]
        if not ops:
            raise ValueError(
                f"--plan-file for {self._module_path!r} carries zero "
                "operations. Ensure the module has public callable exports."
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
            routes=routes,
        )

    def start(self) -> None:
        """Build state and start the HTTP server in a background thread."""
        state = self._build_state()

        class _Server(ThreadingHTTPServer):
            pass

        httpd = _Server((self._host, self._port), _ApigenHandler)
        httpd.state = state  # type: ignore[attr-defined]
        self._httpd = httpd

        # BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: bind() already happened
        # synchronously in the `_Server(...)` constructor above (TCPServer.
        # __init__ calls server_bind()+server_activate() before returning), so
        # the OS has already resolved `port=0` to a real ephemeral port by
        # this point. Read the actual bound port back so callers that asked
        # for port 0 can learn what they actually got — self._port is the
        # single source of truth from here on (used by the log line below and
        # by serve_forever()'s readiness signal).
        self._port = httpd.socket.getsockname()[1]

        # Log the registered routes to stderr — canonical route/verb, TS-
        # computed via the injected --plan-file (BUG-APIGEN-OPENAPI-ROUTE-
        # PATH-MISMATCH-001), not re-derived here.
        print(f"apigen-py-flask  listening on http://{self._host}:{self._port}", file=sys.stderr)
        print(f"  GET  /_meta/health", file=sys.stderr)
        for route, entry in state.route_map.items():
            print(f"  {entry.verb:<4} {route}", file=sys.stderr)
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

        Prints the §13.1-compatible readiness signal ``{"ready": true, "port":
        <n>}`` to stdout immediately after the server thread starts, so the TS
        plugin subprocess launcher can poll for it. ``port`` is the ACTUAL
        bound port (BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001) — identical to
        the requested ``--port`` unless 0 (OS-assigned ephemeral) was passed,
        in which case this is the only way the caller learns the real port.
        """
        self.start()
        # §13.1 readiness signal — TS launcher polls for this line on stdout
        print(json.dumps({"ready": True, "port": self._port}), flush=True)
        # BUG-APIGEN-053: self-terminate if the TS parent process dies
        # outright (SIGKILL/OOM-kill/crash) without ever sending a signal —
        # see apigen_python.parent_watchdog's module docstring.
        start_parent_death_watchdog()
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
    plan: dict[str, Any],
    host: str = "127.0.0.1",
    port: int = 8000,
) -> ApigenFlaskServer:
    """Construct an :class:`ApigenFlaskServer` for the given module.

    Args:
        module_path: Path to the ``.py`` source file (absolute or relative).
        namespace:   The apigen namespace slug (used as the route prefix).
        plan:        The TS-computed serve plan (`{"operations": [...],
                     "routes": {"<opId>": {"route": str, "verb": "GET"|"POST"}}}`)
                     — see the module docstring's "Usage" section.
        host:        Bind address (default ``127.0.0.1``).
        port:        TCP port (default ``8000``).

    Returns:
        An :class:`ApigenFlaskServer` instance ready to call ``.start()`` or
        ``.serve_forever()``.
    """
    return ApigenFlaskServer(module_path, namespace, plan, host=host, port=port)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "apigen Python HTTP server — serves a .py module over HTTP.\n\n"
            "Routes (TS-computed via @adhd/apigen-engine-naming's project().http and\n"
            "injected via --plan-file — BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 /\n"
            "apigen-serve-core py-flask-serve-split):\n"
            "  GET  /_meta/health  → {status, host}\n"
            "  POST <route>        → body {data: {<params>}} → result\n"
            "  GET  <route>        → query-string (per the injected plan's verb)\n"
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
        help="TCP port (default: 8000; pass 0 to bind an OS-assigned "
             "ephemeral port — the actual bound port is reported back in "
             "the {ready: true, port: <n>} stdout line)"
    )
    parser.add_argument(
        "--plan-file", required=True,
        help=(
            "Path to a JSON file: {\"operations\": [...Operation dicts, exactly "
            "apigen_python.extractor --emit-json's output...], \"routes\": "
            "{\"<opId>\": {\"route\": \"<path>\", \"verb\": \"GET\"|\"POST\"}}}. "
            "REQUIRED — this server no longer self-extracts or re-derives "
            "route/verb (apigen-serve-core py-flask-serve-split); produced by "
            "the py-flask TS plugin's two-phase spawn (extractor --emit-json "
            "-> @adhd/apigen-engine-naming project() -> this flag)."
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
