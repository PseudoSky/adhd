"""
future_annotations_api.py — fixture for BUG-APIGEN-008 regression tests.

Uses ``from __future__ import annotations`` (PEP 563) throughout.  This is the
common/recommended style in Python 3.10+ and is the pattern that triggered the
two bugs:

  (a) ``@dataclass`` definitions crashed extraction with AttributeError in
      ``dataclasses._is_type`` because ``sys.modules[cls.__module__]`` was None.
  (b) Per-param JSON-schema inference fell back to ``{}`` because annotations
      were stringized — ``Decimal`` arrived as the string ``"Decimal"`` rather
      than the type object, so the logical-type guards were bypassed.

After the fix (register module in sys.modules + use typing.get_type_hints):
  - ``add_decimal(amount: Decimal) -> Decimal`` must emit
    ``{"type": "string", "format": "decimal"}`` for both param and return.
  - ``PaymentRequest`` dataclass fields must be present in the schema.
  - The server must decode ``"123.456"`` → ``Decimal("123.456")`` → add 0.001
    → encode back → ``"123.457"`` (not a 500 from str + Decimal TypeError).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

# Restrict extraction to the three intended endpoints.
__all__ = ["add_decimal", "describe_payment", "greet"]


@dataclass
class PaymentRequest:
    """A simple payment request dataclass (used to test PEP-563 + dataclass)."""

    amount: Decimal
    currency: str


def add_decimal(amount: Decimal) -> Decimal:
    """Add 0.001 to a Decimal value.

    Args:
        amount: A Decimal value decoded from the wire decimal string.

    Returns:
        amount + Decimal("0.001") as a Decimal (wire-encoded to decimal string).
    """
    return amount + Decimal("0.001")


def describe_payment(req: PaymentRequest) -> str:
    """Describe a payment request (tests dataclass annotation resolution).

    Args:
        req: A PaymentRequest dataclass instance.

    Returns:
        A human-readable description string.
    """
    return f"{req.currency} {req.amount}"


def greet(name: str) -> str:
    """Return a simple greeting.

    Args:
        name: The name to greet.

    Returns:
        A greeting string.
    """
    return f"Hello, {name}!"
