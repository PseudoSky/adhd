"""
apigen_python.errors — §9.1 canonical error taxonomy for the Python host.

Mirrors the TS @adhd/apigen-errors package exactly so the Python runtime
raises the same codes and the gateway maps them identically.
"""

from __future__ import annotations

from typing import Any, Literal

# ---------------------------------------------------------------------------
# §9 — Canonical error code set (gRPC-style)
# ---------------------------------------------------------------------------

ApiErrorCode = Literal[
    "invalid_argument",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "internal",
]

ERROR_CODES: tuple[ApiErrorCode, ...] = (
    "invalid_argument",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "internal",
)

# ---------------------------------------------------------------------------
# §9.1 — Per-transport status maps  (normative — must mirror SPEC §9 table)
# ---------------------------------------------------------------------------

HTTP_STATUS: dict[ApiErrorCode, int] = {
    "invalid_argument": 400,
    "unauthenticated": 401,
    "permission_denied": 403,
    "not_found": 404,
    "internal": 500,
}

GRPC_CODE: dict[ApiErrorCode, str] = {
    "invalid_argument": "INVALID_ARGUMENT",
    "unauthenticated": "UNAUTHENTICATED",
    "permission_denied": "PERMISSION_DENIED",
    "not_found": "NOT_FOUND",
    "internal": "INTERNAL",
}

CLI_EXIT_CODE: dict[ApiErrorCode, int] = {
    "invalid_argument": 2,
    "unauthenticated": 3,
    "permission_denied": 3,
    "not_found": 4,
    "internal": 1,
}

MCP_ERROR_KIND: dict[ApiErrorCode, Literal["error"]] = {
    "invalid_argument": "error",
    "unauthenticated": "error",
    "permission_denied": "error",
    "not_found": "error",
    "internal": "error",
}

# ---------------------------------------------------------------------------
# ApiError — the raised error class
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """The canonical apigen error (§9).

    Every transport adapter catches this and maps ``code`` to the native
    status using the tables above.
    """

    def __init__(
        self,
        code: ApiErrorCode,
        message: str,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code: ApiErrorCode = code
        self.message: str = message
        self.details: Any = details

    def to_json(self) -> dict[str, Any]:
        """Serialise to a plain dict suitable for JSON transport."""
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            out["details"] = self.details
        return out

    def __repr__(self) -> str:
        return f"ApiError(code={self.code!r}, message={self.message!r})"
