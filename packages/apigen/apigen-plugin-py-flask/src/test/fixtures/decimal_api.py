"""
decimal_api.py — fixture for CLI-spawned Decimal/datetime decode tests.

Uses NATIVE type hints (decimal.Decimal, datetime.datetime) so that the extractor
emits {"type":"string","format":"decimal"} / {"type":"string","format":"date-time"}
schemas, driving the full logical-type decode path in the flask_server.

Intentionally does NOT use `from __future__ import annotations` so that
annotations are evaluated eagerly and the extractor sees real type objects.
"""

# NO `from __future__ import annotations` -- keep annotations evaluated eagerly.

from decimal import Decimal
from datetime import datetime

# Use __all__ to restrict what is extracted (prevents Decimal/datetime from
# being extracted as constructor operations).
__all__ = ["add_decimal", "echo_datetime", "greet"]


def add_decimal(amount: Decimal) -> Decimal:
    """Add a small increment to a Decimal value.

    The server decodes `amount` from its decimal-string wire form to a
    decimal.Decimal before calling this function.  The result is re-encoded
    to its decimal-string wire form by the server.

    Args:
        amount: A Decimal value decoded from the wire decimal string.

    Returns:
        amount + Decimal("0.001") as a Decimal (wire-encoded to string).
    """
    return amount + Decimal("0.001")


def echo_datetime(iso: datetime) -> datetime:
    """Return the datetime unchanged (identity round-trip).

    The server decodes `iso` from its RFC 3339 wire form to a
    datetime.datetime before calling this function.  The result is
    re-encoded to RFC 3339 by the server.

    Args:
        iso: A datetime decoded from the wire RFC 3339 string.

    Returns:
        The same datetime (wire-encoded to RFC 3339).
    """
    return iso


def greet(name: str) -> str:
    """Return a simple greeting.

    Args:
        name: The name to greet.

    Returns:
        A greeting string.
    """
    return f"Hello, {name}!"
