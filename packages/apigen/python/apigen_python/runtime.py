"""
apigen_python.runtime — Python host harness: invoke / validate / dispatch (SPEC §8 / §14).

The runtime receives a HostRequest (from the gateway or directly from a plugin),
validates input against the Operation's JSON-Schema, dispatches to the Python fn,
and maps exceptions to §9 ApiError codes.

Lifecycle:
    runtime = Runtime(fn_registry)
    result  = await runtime.invoke(request, signal)   # async path
    result  = runtime.invoke_sync(request)            # sync path (for tests / WSGI)

The fn_registry maps operation id → callable.

SPEC §6: validation is a fast-fail pre-filter, NOT the authoritative type gate.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

from .errors import ApiError, ApiErrorCode
from .validator import validate, ValidationError


# ---------------------------------------------------------------------------
# HostRequest — matches gateway.ts HostRequest (the cross-language IPC contract)
# ---------------------------------------------------------------------------

class HostRequest:
    """The single request the gateway forwards to the Python host runtime.

    Fields mirror gateway.ts::HostRequest exactly so the IPC adapter can
    deserialise directly into this class.
    """

    def __init__(
        self,
        operation: dict[str, Any],
        data: dict[str, Any],
        envelope: dict[str, Any],
        transport: str,
    ) -> None:
        self.operation = operation          # full §4 Operation dict
        self.data = data                    # bare domain params (ctx excluded)
        self.envelope = envelope            # request side-channel (session, auth, …)
        self.transport = transport          # 'http' | 'grpc' | 'mcp' | 'cli'


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

class Runtime:
    """Python host harness — validate → dispatch (SPEC §8 / §14).

    Args:
        fn_registry: Mapping of operation id → Python callable.
            The callable receives keyword arguments matching the operation's
            input schema properties. The 'ctx' parameter (if present) receives
            the envelope dict.
    """

    def __init__(self, fn_registry: dict[str, Any]) -> None:
        self._registry = fn_registry

    # ------------------------------------------------------------------
    # Core dispatch
    # ------------------------------------------------------------------

    def _resolve(self, op_id: str) -> Any:
        """Look up the function for an operation id.

        Raises:
            ApiError(not_found): if no function is registered for op_id.
        """
        fn = self._registry.get(op_id)
        if fn is None:
            raise ApiError("not_found", f"no handler registered for operation '{op_id}'")
        return fn

    def _validate_input(self, op: dict[str, Any], data: dict[str, Any]) -> None:
        """Validate *data* against the operation's input schema (SPEC §6).

        Raises:
            ApiError(invalid_argument): if validation fails.
        """
        input_schema = op.get("input", {})
        if not input_schema:
            return
        try:
            validate(input_schema, data)
        except ValidationError as exc:
            raise ApiError("invalid_argument", f"input validation failed: {exc}") from exc

    def _build_kwargs(self, fn: Any, data: dict[str, Any], envelope: dict[str, Any]) -> dict[str, Any]:
        """Build keyword-argument dict for the function from data + envelope.

        If the function has a first parameter named 'ctx', it receives the
        envelope dict. All other parameters are pulled from data.
        """
        try:
            sig = inspect.signature(fn)
        except (ValueError, TypeError):
            return dict(data)

        params = list(sig.parameters.values())
        kwargs: dict[str, Any] = {}

        # Strip 'self' for bound methods.
        if params and params[0].name == "self":
            params = params[1:]

        # 'ctx' first-param receives the envelope (§4 inv:ctx-name-only).
        if params and params[0].name == "ctx":
            kwargs["ctx"] = envelope
            params = params[1:]

        # Remaining params from data.
        for p in params:
            if p.kind in (
                inspect.Parameter.VAR_POSITIONAL,
                inspect.Parameter.VAR_KEYWORD,
            ):
                continue
            if p.name in data:
                kwargs[p.name] = data[p.name]

        return kwargs

    def _call_fn(self, fn: Any, kwargs: dict[str, Any]) -> Any:
        """Call a synchronous function, mapping exceptions to ApiError."""
        try:
            return fn(**kwargs)
        except ApiError:
            raise
        except TypeError as exc:
            raise ApiError("invalid_argument", f"dispatch type error: {exc}") from exc
        except Exception as exc:
            raise ApiError("internal", f"dispatch error: {exc}") from exc

    async def _call_fn_async(self, fn: Any, kwargs: dict[str, Any]) -> Any:
        """Call an async function (coroutine), mapping exceptions to ApiError."""
        try:
            result = fn(**kwargs)
            if inspect.isawaitable(result):
                return await result
            return result
        except ApiError:
            raise
        except TypeError as exc:
            raise ApiError("invalid_argument", f"dispatch type error: {exc}") from exc
        except Exception as exc:
            raise ApiError("internal", f"dispatch error: {exc}") from exc

    # ------------------------------------------------------------------
    # Public invoke API
    # ------------------------------------------------------------------

    async def invoke(self, req: HostRequest, signal: Any = None) -> Any:
        """Invoke an operation asynchronously.

        Validates input, resolves the function, dispatches, and returns the result.
        Cancellation via *signal* is not yet propagated to the fn (future work).

        Args:
            req: The HostRequest from the gateway or plugin.
            signal: Optional cancellation signal (reserved; not yet consumed).

        Returns:
            The function's return value (awaited if async).

        Raises:
            ApiError: on validation failure, not-found, or dispatch error.
        """
        op = req.operation
        fn = self._resolve(op["id"])
        self._validate_input(op, req.data)
        kwargs = self._build_kwargs(fn, req.data, req.envelope)

        if inspect.iscoroutinefunction(fn) or inspect.isasyncgenfunction(fn):
            return await self._call_fn_async(fn, kwargs)
        # Sync fn — run in thread pool to avoid blocking the event loop.
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: self._call_fn(fn, kwargs))

    def invoke_sync(self, req: HostRequest) -> Any:
        """Invoke an operation synchronously (for tests and WSGI contexts).

        For async functions this runs them in a new event loop; for sync
        functions it calls them directly.

        Args:
            req: The HostRequest.

        Returns:
            The function's return value.

        Raises:
            ApiError: on validation failure, not-found, or dispatch error.
        """
        op = req.operation
        fn = self._resolve(op["id"])
        self._validate_input(op, req.data)
        kwargs = self._build_kwargs(fn, req.data, req.envelope)

        if inspect.iscoroutinefunction(fn) or inspect.isasyncgenfunction(fn):
            return asyncio.run(self._call_fn_async(fn, kwargs))
        return self._call_fn(fn, kwargs)
