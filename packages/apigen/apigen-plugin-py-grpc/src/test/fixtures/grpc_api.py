# grpc_api.py — fixture for apigen py-grpc plugin live tests.
#
# Exposes functions that exercise the gRPC transport:
#   - Decimal param/return (canonical wire: decimal string)
#   - Plain string round-trip
#   - ctx (envelope) forwarding via gRPC metadata
#
# NOTE: deliberately does NOT use `from __future__ import annotations` so that
# Python 3.11+ type annotations are evaluated eagerly and the extractor sees
# real type objects (not strings).

# NO `from __future__ import annotations` -- keep annotations evaluated eagerly.

from decimal import Decimal
from typing import Any, Dict

# Only expose the API functions — prevents stdlib imports from being extracted.
__all__ = ["add_decimal", "greet", "greet_with_ctx"]


def add_decimal(amount: Decimal) -> Decimal:
    """Add a small increment to a Decimal value.

    The gRPC server decodes ``amount`` from its decimal-string wire form to a
    ``decimal.Decimal`` before calling this function.  The result is
    re-encoded to its decimal-string wire form by the server.

    Args:
        amount: A Decimal value decoded from the wire decimal string.

    Returns:
        amount + Decimal("0.001") as a Decimal (wire-encoded to string).
    """
    return amount + Decimal("0.001")


def greet(name: str) -> str:
    """Return a simple greeting string.

    Args:
        name: The name to greet.

    Returns:
        A greeting string.
    """
    return f"Hello, {name}!"


def greet_with_ctx(ctx: Dict[str, Any], name: str) -> str:
    """Greet a user, incorporating the session from the gRPC metadata envelope.

    The ``ctx`` first-parameter receives the envelope dict populated from
    ``x-adhd-*`` gRPC metadata keys (§4 inv:ctx-name-only).

    Args:
        ctx:  Envelope dict (populated from x-adhd-* gRPC metadata by server).
        name: The user's name.

    Returns:
        A greeting string including the session id from metadata.
    """
    session = ctx.get("session", "anonymous")
    return f"Hello {name}! session={session}"
