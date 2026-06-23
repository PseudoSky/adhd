"""
apigen_python.gateway_adapter — IPC server side for the TS gateway (SPEC §13.1 / §14.4).

Wire protocol: stdio JSON-RPC (line-delimited JSON).

Each request is one JSON line on stdin; each response is one JSON line on stdout.
The TS side's Python HostAdapter connects to this over a subprocess pipe.

Request shape:
    {"id": <str>, "method": "invoke"|"health"|"ready", "params": {...}}

Response shape (success):
    {"id": <str>, "result": <any>}

Response shape (error):
    {"id": <str>, "error": {"code": <str>, "message": <str>}}

Methods:
    invoke  → params: {operation: <Operation dict>, data: {}, envelope: {}, transport: str}
              result: <function return value>
    health  → result: {"status": "ok", "host": "python"}
    ready   → result: {"ready": true}

Readiness signal:
    On startup, before the read loop begins, the adapter writes a single line:
        {"ready": true}
    This is the §13.1 readiness signal the TS HostAdapter waits for.

Usage:
    python -m apigen_python.gateway_adapter [--module <path>] [--namespace <ns>]

    The adapter loads the specified module (or the echo plugin by default),
    extracts its operations, and starts serving.
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from typing import Any

from .errors import ApiError
from .plugin_echo import ECHO_OPERATIONS, ECHO_REGISTRY
from .runtime import HostRequest, Runtime


# ---------------------------------------------------------------------------
# JSON-RPC handler
# ---------------------------------------------------------------------------

async def _handle_request(
    runtime: Runtime,
    req: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch one JSON-RPC request and return the response dict."""
    req_id = req.get("id", "")
    method = req.get("method", "")
    params = req.get("params", {})

    try:
        if method == "invoke":
            op = params.get("operation", {})
            data = params.get("data", {})
            envelope = params.get("envelope", {})
            transport = params.get("transport", "http")
            host_req = HostRequest(
                operation=op,
                data=data,
                envelope=envelope,
                transport=transport,
            )
            result = await runtime.invoke(host_req)
            return {"id": req_id, "result": result}

        elif method == "health":
            return {"id": req_id, "result": {"status": "ok", "host": "python"}}

        elif method == "ready":
            return {"id": req_id, "result": {"ready": True}}

        else:
            return {
                "id": req_id,
                "error": {"code": "not_found", "message": f"unknown method: {method}"},
            }

    except ApiError as exc:
        return {
            "id": req_id,
            "error": exc.to_json(),
        }
    except Exception as exc:
        return {
            "id": req_id,
            "error": {"code": "internal", "message": str(exc)},
        }


# ---------------------------------------------------------------------------
# Stdio server loop
# ---------------------------------------------------------------------------

async def _serve_stdio(runtime: Runtime) -> None:
    """Read JSON-RPC requests from stdin, write responses to stdout (line-delimited).

    Startup: emit the readiness signal first so the TS HostAdapter can unblock.
    """
    # §13.1 readiness signal — TS side polls ready() which reads this.
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
        except Exception:
            break
        if not line:
            break
        line_str = line.decode("utf-8").strip()
        if not line_str:
            continue
        try:
            req = json.loads(line_str)
        except json.JSONDecodeError as exc:
            resp = {"id": None, "error": {"code": "invalid_argument", "message": f"JSON parse error: {exc}"}}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue

        resp = await _handle_request(runtime, req)
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# Synchronous server (for testing without asyncio)
# ---------------------------------------------------------------------------

def serve_stdio_sync(runtime: Runtime) -> None:
    """Blocking stdio server loop (sync version for subprocess spawning).

    Emits the §13.1 readiness signal then processes requests line by line.
    """
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            resp: dict[str, Any] = {
                "id": None,
                "error": {"code": "invalid_argument", "message": f"JSON parse error: {exc}"},
            }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue

        # Dispatch synchronously.
        req_id = req.get("id", "")
        method = req.get("method", "")
        params = req.get("params", {})
        try:
            if method == "invoke":
                op = params.get("operation", {})
                data = params.get("data", {})
                envelope = params.get("envelope", {})
                transport = params.get("transport", "http")
                host_req = HostRequest(
                    operation=op,
                    data=data,
                    envelope=envelope,
                    transport=transport,
                )
                result = runtime.invoke_sync(host_req)
                resp = {"id": req_id, "result": result}

            elif method == "health":
                resp = {"id": req_id, "result": {"status": "ok", "host": "python"}}

            elif method == "ready":
                resp = {"id": req_id, "result": {"ready": True}}

            else:
                resp = {
                    "id": req_id,
                    "error": {"code": "not_found", "message": f"unknown method: {method}"},
                }

        except ApiError as exc:
            resp = {"id": req_id, "error": exc.to_json()}
        except Exception as exc:
            resp = {"id": req_id, "error": {"code": "internal", "message": str(exc)}}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "apigen Python gateway adapter — stdio JSON-RPC server.\n\n"
            "Wire protocol: line-delimited JSON on stdin/stdout.\n"
            "Request:  {id, method, params}\n"
            "Response: {id, result} or {id, error: {code, message}}\n"
            "Startup:  emits {ready: true} before the read loop."
        )
    )
    parser.add_argument(
        "--module", default=None,
        help="Path to a Python module to extract and serve (default: echo plugin)"
    )
    parser.add_argument(
        "--namespace", default=None,
        help="Namespace for module extraction"
    )
    args = parser.parse_args()

    if args.module:
        from .extractor import extract_module
        import importlib.util
        from pathlib import Path

        ops = extract_module(args.module, namespace=args.namespace)
        spec = importlib.util.spec_from_file_location("_apigen_adapter_module_", args.module)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]

        registry: dict[str, Any] = {}
        for op in ops:
            # Best-effort: map op id to the fn by the last path segment raw name.
            fn_name = op["path"][-1]["raw"]
            fn = getattr(mod, fn_name, None)
            if callable(fn):
                registry[op["id"]] = fn
    else:
        registry = ECHO_REGISTRY

    runtime = Runtime(registry)
    serve_stdio_sync(runtime)


if __name__ == "__main__":
    _main()
