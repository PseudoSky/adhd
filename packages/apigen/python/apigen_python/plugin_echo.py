"""
apigen_python.plugin_echo — trivial echo plugin for round-trip testing (SPEC §14).

This is the "one echo plugin" required by the host contract: a simple Python
function that the gateway can call to prove the full IPC round-trip works.

The echo operation accepts any input dict and returns it unchanged together with
a 'host' marker, proving that the Python runtime received the call and responded.
"""

from __future__ import annotations

from typing import Any


def echo(message: str = "") -> dict[str, Any]:
    """Echo the message back with a host marker.

    Args:
        message: Any string message.

    Returns:
        A dict containing the echoed message and the host identifier.
    """
    return {
        "message": message,
        "host": "python",
        "echo": True,
    }


def ping() -> dict[str, Any]:
    """Health-check ping — returns a minimal ok payload.

    Used by the gateway adapter's readiness probe.
    """
    return {"status": "ok", "host": "python"}


# ---------------------------------------------------------------------------
# Plugin operation descriptors — used by the gateway adapter to register these
# fns without running a full extraction pass.
# ---------------------------------------------------------------------------

ECHO_OPERATION: dict[str, Any] = {
    "id": "echo/echo",
    "host": "python",
    "namespace": {"raw": "echo", "words": ["echo"]},
    "path": [{"raw": "echo", "words": ["echo"]}],
    "kind": "action",
    "async": False,
    "streaming": False,
    "safe": False,
    "input": {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
        },
        "required": [],
    },
    "output": {
        "type": "object",
        "properties": {
            "message": {"type": "string"},
            "host": {"type": "string"},
            "echo": {"type": "boolean"},
        },
    },
    "envelope": {},
    "typeText": None,
}

PING_OPERATION: dict[str, Any] = {
    "id": "echo/ping",
    "host": "python",
    "namespace": {"raw": "echo", "words": ["echo"]},
    "path": [{"raw": "ping", "words": ["ping"]}],
    "kind": "query",
    "async": False,
    "streaming": False,
    "safe": True,
    "input": {"type": "object", "properties": {}},
    "output": {
        "type": "object",
        "properties": {
            "status": {"type": "string"},
            "host": {"type": "string"},
        },
    },
    "envelope": {},
    "typeText": None,
}

# Registry entries used by the gateway adapter.
ECHO_REGISTRY: dict[str, Any] = {
    "echo/echo": echo,
    "echo/ping": ping,
}

ECHO_OPERATIONS: list[dict[str, Any]] = [ECHO_OPERATION, PING_OPERATION]
