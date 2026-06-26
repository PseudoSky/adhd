"""
test_api.py -- fixture module for apigen py-flask plugin live tests.

Exposes a small set of functions that exercise:
  - plain string round-trip
  - Decimal param/return (canonical wire: decimal string)
  - datetime param/return (canonical wire: RFC3339)
  - ctx (envelope) forwarding

NOTE: deliberately does NOT use `from __future__ import annotations` so that
Python 3.11+ type annotations are evaluated eagerly and the extractor can
see real type objects (not strings).  The `from __future__ import annotations`
PEP 563 behaviour stringifies annotations, which prevents the extractor from
building per-param JSON schemas.
"""

# NO `from __future__ import annotations` -- keep annotations evaluated eagerly.

import datetime as _dt
from decimal import Decimal
from typing import Any, Dict

# Only expose the API functions -- prevents stdlib imports from being extracted.
__all__ = ["echo_str", "double_decimal", "get_datetime", "greet_with_ctx"]


def echo_str(msg: str) -> str:
    """Return the input string unchanged.

    Args:
        msg: Any string message.

    Returns:
        The same string.
    """
    return msg


def double_decimal(amount: str) -> str:
    """Double a decimal value; input and output are canonical decimal strings.

    The server decodes `amount` from its decimal-string wire form to a
    Decimal, doubles it, and re-encodes to a decimal string.  The function
    itself works with Decimal natively to avoid float precision loss.

    Args:
        amount: A decimal string, e.g. "123.456".

    Returns:
        Doubled decimal as a string, e.g. "246.912".
    """
    d = Decimal(amount)
    result = d * 2
    return str(result)


def get_datetime(iso: str) -> _dt.datetime:
    """Parse an ISO/RFC3339 string and return it as a UTC datetime.

    The server encodes the returned datetime to RFC3339 string on the wire.

    Args:
        iso: An RFC3339 datetime string, e.g. "2024-01-15T12:34:56.789Z".

    Returns:
        The same instant as a timezone-aware datetime in UTC.
    """
    normalised = iso.replace("Z", "+00:00")
    return _dt.datetime.fromisoformat(normalised).astimezone(_dt.timezone.utc)


def greet_with_ctx(ctx: Dict[str, Any], name: str) -> str:
    """Greet a user, incorporating the session from the envelope ctx.

    The 'ctx' first-parameter receives the envelope dict (section 4 inv:ctx-name-only).
    The x-adhd-session header is forwarded as ctx['session'].

    Args:
        ctx: Envelope dict (populated from x-adhd-* headers by the server).
        name: The user's name.

    Returns:
        A greeting string including the session id.
    """
    session = ctx.get("session", "anonymous")
    return f"Hello {name}! session={session}"
