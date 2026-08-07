"""
apigen_logical.py — Python host binding for the apigen logical-types system.

Mirrors the TypeScript well-known scalar codecs (packages/apigen/logical/src/lib/codecs/)
and provides a schema-walking encode/decode pair so the SAME canonical wire bytes
round-trip identically between TS and Python.

Canonical wire encodings (DESIGN §3):
  date-time    → RFC 3339 UTC string  (datetime.isoformat with 'Z' suffix)
  int64        → decimal string       ("9007199254740993")
  decimal      → decimal string       ("123.456")
  byte         → standard base64 + padding  ("SGVsbG8=")
  uuid         → lowercase hyphenated ("550e8400-e29b-41d4-a716-446655440000")
  number-special → "NaN" / "Infinity" / "-Infinity"

Wire contract note (DESIGN §4.6):
  Encode is value-driven: json.dumps(..., cls=ApigenEncoder) / encode_value().
  Decode is schema-driven and explicit: native json.object_hook is value-only
  and cannot see the schema, so decode() walks the schema and wire in lockstep.

All types use Python stdlib only (datetime, decimal, uuid, base64, math).
"""

from __future__ import annotations

import base64
import json
import math
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------

# Wire is any JSON-serialisable value (str | int | float | bool | None | list | dict).
Wire = Any
# SchemaNode is a dict representing a resolved JSON Schema fragment.
SchemaNode = dict[str, Any]


# ---------------------------------------------------------------------------
# Scalar codec helpers — encode (native → wire)
# ---------------------------------------------------------------------------

def encode_datetime(value: datetime) -> str:
    """Encode a datetime to RFC 3339 UTC string with ms precision.

    Mirrors TS `Date.prototype.toISOString()` which always emits the 'Z' suffix
    and at least millisecond precision.

    Args:
        value: A datetime object (naive is treated as UTC; aware is converted).

    Returns:
        RFC 3339 UTC string, e.g. "2024-01-15T12:34:56.789Z".
    """
    # Ensure UTC.
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc)
    else:
        # Naive → assume UTC (same semantics as JS new Date(...).toISOString()).
        value = value.replace(tzinfo=timezone.utc)

    # Format matches JS toISOString(): YYYY-MM-DDTHH:MM:SS.mmmZ
    # Python isoformat() with 'microseconds' precision gives 6 fractional digits;
    # we truncate to 3 (ms) and append 'Z' to match the canonical TS wire.
    base = value.strftime("%Y-%m-%dT%H:%M:%S")
    ms = value.microsecond // 1000
    return f"{base}.{ms:03d}Z"


def encode_int64(value: int) -> str:
    """Encode a Python int as a decimal string.

    Mirrors TS `String(bigint)`. Avoids f64 precision loss for values beyond
    Number.MAX_SAFE_INTEGER.

    Args:
        value: Any Python int (int64 range or beyond).

    Returns:
        Decimal string, e.g. "9007199254740993".
    """
    return str(int(value))


def encode_decimal(value: Decimal | str) -> str:
    """Encode a Decimal (or already-valid decimal string) to a decimal string.

    Mirrors TS `value as string` (branded-string passthrough for the default
    zero-dep mode). Never emits a float representation.

    Args:
        value: A Python `decimal.Decimal` or a plain decimal string.

    Returns:
        Decimal string, e.g. "123.456".
    """
    return str(value)


def encode_bytes(value: bytes | bytearray) -> str:
    """Encode bytes to standard base64 (RFC 4648 §4) with padding.

    Uses the standard alphabet: '+' and '/', NOT the URL-safe '-' and '_'.
    Padding ('=') is always included.

    Mirrors TS `Buffer.from(value).toString('base64')`.

    Args:
        value: A bytes or bytearray object.

    Returns:
        Standard base64 string with padding, e.g. "SGVsbG8=".
    """
    return base64.b64encode(bytes(value)).decode("ascii")


def encode_uuid(value: UUID | str) -> str:
    """Encode a UUID to lowercase hyphenated RFC 4122 form.

    Mirrors TS `value.toLowerCase()`.

    Args:
        value: A `uuid.UUID` instance or a UUID string (any case).

    Returns:
        Lowercase hyphenated UUID string, e.g. "550e8400-e29b-41d4-a716-446655440000".
    """
    return str(value).lower()


def encode_number_special(value: float) -> str | float:
    """Encode a float, mapping non-finite values to string sentinels.

    Mirrors TS codec: NaN → "NaN", Infinity → "Infinity", -Infinity → "-Infinity",
    finite numbers pass through unchanged.

    Note: JSON.stringify maps NaN/±Infinity to null by default; this codec
    overrides that with ProtoJSON-compatible string sentinels.

    Args:
        value: Any Python float.

    Returns:
        "NaN", "Infinity", or "-Infinity" for non-finite values;
        the original float for finite values.
    """
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


# ---------------------------------------------------------------------------
# Scalar codec helpers — decode (wire → native)
# ---------------------------------------------------------------------------

def decode_datetime(wire: Wire) -> datetime:
    """Decode an RFC 3339 UTC string to a timezone-aware datetime in UTC.

    The decoded value is always UTC (timezone.utc), matching the TS host's
    `new Date(wire)` which always normalises to UTC.

    Args:
        wire: A RFC 3339 UTC string, e.g. "2024-01-15T12:34:56.789Z".

    Returns:
        datetime in UTC.

    Raises:
        TypeError: if wire is not a string.
        ValueError: if the string is not a valid ISO-8601 datetime.
    """
    if not isinstance(wire, str):
        raise TypeError(f"[date-time] expected a string on the wire, got {type(wire).__name__}")
    # Python's fromisoformat (3.7+) handles 'Z' only from 3.11+.
    # For compatibility with 3.9/3.10 replace 'Z' → '+00:00'.
    normalised = wire.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalised)
    return dt.astimezone(timezone.utc)


def decode_int64(wire: Wire) -> int:
    """Decode a decimal string to a Python int (exact, no f64 truncation).

    Args:
        wire: A decimal string, e.g. "9007199254740993".

    Returns:
        Python int with full precision.

    Raises:
        TypeError: if wire is not a string.
        ValueError: if the string is not a valid integer representation.
    """
    if not isinstance(wire, str):
        raise TypeError(f"[int64] expected a string on the wire, got {type(wire).__name__}")
    return int(wire)


def decode_decimal(wire: Wire) -> Decimal:
    """Decode a decimal string to a Python `decimal.Decimal`.

    Args:
        wire: A decimal string, e.g. "123.456".

    Returns:
        `decimal.Decimal` preserving full precision.

    Raises:
        TypeError: if wire is not a string.
    """
    if not isinstance(wire, str):
        raise TypeError(f"[decimal] expected a string on the wire, got {type(wire).__name__}")
    return Decimal(wire)


def decode_bytes(wire: Wire) -> bytes:
    """Decode a standard base64 string (RFC 4648 §4) to bytes.

    Validates that the input uses the standard alphabet (not URL-safe).

    Args:
        wire: A standard base64 string with optional '=' padding.

    Returns:
        Decoded bytes.

    Raises:
        TypeError: if wire is not a string.
        ValueError: if the string is not valid standard base64.
    """
    if not isinstance(wire, str):
        raise TypeError(f"[byte] expected a base64 string on the wire, got {type(wire).__name__}")
    # Validate standard base64 alphabet — disallow URL-safe characters ('-', '_').
    import re
    if not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", wire):
        raise ValueError(
            f"[byte] wire value is not standard base64 (RFC 4648 §4): {wire!r}. "
            "Standard base64 uses '+' and '/' (not '-' and '_')."
        )
    return base64.b64decode(wire)


def decode_uuid(wire: Wire) -> str:
    """Decode a UUID wire string, validating and normalising to lowercase.

    Args:
        wire: A UUID string (any case), e.g. "550E8400-...".

    Returns:
        Lowercase hyphenated UUID string.

    Raises:
        TypeError: if wire is not a string.
        ValueError: if the string is not a valid RFC 4122 UUID.
    """
    if not isinstance(wire, str):
        raise TypeError(f"[uuid] expected a string on the wire, got {type(wire).__name__}")
    # UUID() constructor validates and normalises.
    return str(UUID(wire)).lower()


def decode_number_special(wire: Wire) -> float:
    """Decode a number-special wire value to a Python float.

    Maps string sentinels back to their float equivalents:
      "NaN" → float('nan'), "Infinity" → float('inf'), "-Infinity" → float('-inf').
    Numeric wire values pass through directly.

    Args:
        wire: A string sentinel or a JSON number.

    Returns:
        Python float.

    Raises:
        TypeError: if wire is neither a string sentinel nor a number.
    """
    if isinstance(wire, (int, float)):
        return float(wire)
    if isinstance(wire, str):
        if wire == "NaN":
            return float("nan")
        if wire == "Infinity":
            return float("inf")
        if wire == "-Infinity":
            return float("-inf")
    raise TypeError(
        f"[number-special] unrecognised wire value: {wire!r}. "
        "Expected a number or one of 'NaN', 'Infinity', '-Infinity'."
    )


# ---------------------------------------------------------------------------
# JSONEncoder — encode hook for json.dumps
# ---------------------------------------------------------------------------

class ApigenEncoder(json.JSONEncoder):
    """JSON encoder that maps well-known Python types to their canonical wire form.

    Use as: ``json.dumps(value, cls=ApigenEncoder)``

    Well-known dispatch:
      datetime → RFC 3339 UTC string
      Decimal  → decimal string
      UUID     → lowercase hyphenated string
      bytes / bytearray → standard base64 string
      float (non-finite) → "NaN" / "Infinity" / "-Infinity"
      int (large) → int (JSON number — use encode_int64 + schema-walk for int64 format)

    Note: This encoder is value-driven and cannot see the schema, so it handles
    the "encode" direction only. For schema-driven decode, use ``decode()``.
    """

    def default(self, obj: Any) -> Any:  # noqa: ANN401
        """Override JSONEncoder.default for apigen well-known types."""
        if isinstance(obj, datetime):
            return encode_datetime(obj)
        if isinstance(obj, Decimal):
            return encode_decimal(obj)
        if isinstance(obj, UUID):
            return encode_uuid(obj)
        if isinstance(obj, (bytes, bytearray)):
            return encode_bytes(obj)
        # Let the base encoder raise for everything else.
        return super().default(obj)

    def encode(self, obj: Any) -> str:
        """Override encode to handle float non-finite values at the top level."""
        return super().encode(self._prepare(obj))

    def iterencode(self, obj: Any, _one_shot: bool = False) -> Any:
        """Override iterencode to handle float non-finite values recursively."""
        return super().iterencode(self._prepare(obj))

    def _prepare(self, obj: Any) -> Any:
        """Recursively prepare a value for JSON serialization."""
        if isinstance(obj, float):
            return encode_number_special(obj)
        if isinstance(obj, dict):
            return {k: self._prepare(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._prepare(v) for v in obj]
        return obj


def encode_value(value: Any) -> Wire:
    """Encode a single native value to its canonical wire form (value-driven).

    This is a convenience wrapper around the individual codec encode functions.
    For plain JSON types (str, int, bool, None, list, dict) this is an identity.

    Args:
        value: Any Python value.

    Returns:
        The wire form (a JSON-serialisable value).
    """
    if isinstance(value, datetime):
        return encode_datetime(value)
    if isinstance(value, Decimal):
        return encode_decimal(value)
    if isinstance(value, UUID):
        return encode_uuid(value)
    if isinstance(value, (bytes, bytearray)):
        return encode_bytes(value)
    if isinstance(value, float):
        return encode_number_special(value)
    if isinstance(value, dict):
        return {k: encode_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [encode_value(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# Schema-driven decode — walks schema and wire in lockstep
# ---------------------------------------------------------------------------

def decode(wire: Wire, schema: SchemaNode, defs: dict[str, SchemaNode] | None = None) -> Any:
    """Schema-driven decode: walk `schema` and `wire` in lockstep, constructing
    native types where the schema owns a logical type.

    This is the primary decode entry point. It mirrors the TS transcoder walk
    (DESIGN §4.4) applied to the Python host:

      - Scalars with `format` → dispatch to the typed decoder.
      - $ref → resolve against `defs` and recurse.
      - oneOf → inspect value structure (no discriminator support yet — plain passthrough).
      - array items → recurse per element.
      - object properties → recurse per property.
      - Anything else → plain passthrough (already a JSON-native type).

    Args:
        wire: The wire value (JSON-parsed Python object).
        schema: Resolved JSON Schema fragment describing the value's type.
        defs: Optional ``$defs`` mapping for resolving ``$ref`` nodes. If not
              provided, uses the top-level ``$defs`` from ``schema`` itself.

    Returns:
        The decoded native Python value.
    """
    # Collect $defs for $ref resolution (merge top-level with caller-supplied).
    root_defs: dict[str, SchemaNode] = {}
    if isinstance(schema, dict) and "$defs" in schema:
        root_defs.update(schema["$defs"])
    if defs:
        root_defs.update(defs)

    return _decode_node(wire, schema, root_defs)


def _decode_node(wire: Wire, node: SchemaNode, defs: dict[str, SchemaNode]) -> Any:
    """Recursive decode helper — one schema node at a time."""
    if not isinstance(node, dict):
        return wire

    # ---- $ref ----
    if "$ref" in node:
        ref: str = node["$ref"]
        resolved = _resolve_ref(ref, defs)
        if resolved is not None:
            return _decode_node(wire, resolved, defs)
        # Unknown ref → passthrough.
        return wire

    node_type = node.get("type")
    node_format = node.get("format")

    # ---- Well-known scalar dispatch (format-based) ----
    if node_type == "string" and node_format == "date-time":
        return decode_datetime(wire)

    if node_type == "string" and node_format == "int64":
        return decode_int64(wire)

    if node_type == "string" and node_format == "decimal":
        return decode_decimal(wire)

    if node_type == "string" and node_format == "byte":
        return decode_bytes(wire)

    if node_type == "string" and node_format == "uuid":
        return decode_uuid(wire)

    if node_type == "number" and node_format is None:
        # number-special: only fire when explicitly asked (number node, no format).
        # Handle string sentinels if present; otherwise passthrough numeric wire.
        if isinstance(wire, str) and wire in ("NaN", "Infinity", "-Infinity"):
            return decode_number_special(wire)
        return wire

    # ---- oneOf (union) — passthrough for now; consumer picks the branch ----
    if "oneOf" in node:
        # Without discriminator support, attempt each branch decode and return
        # the first that succeeds without error; fall back to passthrough.
        for branch in node["oneOf"]:
            try:
                return _decode_node(wire, branch, defs)
            except (TypeError, ValueError):
                continue
        return wire

    # ---- array (recurse over items) ----
    if node_type == "array" and isinstance(wire, list):
        items_schema = node.get("items")
        if items_schema and isinstance(items_schema, dict):
            return [_decode_node(item, items_schema, defs) for item in wire]
        return wire

    # ---- object (recurse over declared properties) ----
    if node_type == "object" and isinstance(wire, dict):
        props: dict[str, SchemaNode] = node.get("properties", {})
        if not props:
            return wire
        result: dict[str, Any] = {}
        for k, v in wire.items():
            if k in props:
                result[k] = _decode_node(v, props[k], defs)
            else:
                result[k] = v
        return result

    # ---- plain JSON passthrough ----
    return wire


def _resolve_ref(ref: str, defs: dict[str, SchemaNode]) -> SchemaNode | None:
    """Resolve a JSON Pointer $ref of the form '#/$defs/<Name>' against defs."""
    if not ref.startswith("#/$defs/"):
        return None
    name = ref[len("#/$defs/"):]
    return defs.get(name)


# ---------------------------------------------------------------------------
# Seed construction (used by the test harness)
# ---------------------------------------------------------------------------

def construct_seed(recipe: Wire) -> Any:
    """Build a Python-native seed value from a LogicalTypeVector seed recipe.

    A plain Wire value is returned as-is (already the native form for
    scalars like str, int, Decimal).

    A ``$construct`` recipe has the shape:
        ``{"$construct": <LogicalTypeId>, "args": [<Wire>, ...]}``

    The following LogicalTypeIds are supported:
      "date-time"      → datetime from ISO string arg
      "byte"           → bytes from list-of-ints arg
      "number-special" → float NaN / Infinity / -Infinity from string arg
      "int64"          → int from decimal-string arg
      "decimal"        → Decimal from decimal-string arg
      "uuid"           → str (lowercase UUID) from string arg

    Args:
        recipe: A Wire value or a ``$construct`` dict.

    Returns:
        The native Python seed value.

    Raises:
        ValueError: for unrecognised logical type ids.
        TypeError: for wrong arg types.
    """
    if not isinstance(recipe, dict) or "$construct" not in recipe:
        # Plain wire seed — use as-is (e.g. "9007199254740993" for int64, "123.456" for decimal).
        return recipe

    logical_type: str = recipe["$construct"]
    args: list[Wire] = recipe.get("args", [])

    if logical_type == "date-time":
        iso_str = args[0]
        return decode_datetime(iso_str)

    if logical_type == "byte":
        byte_list = args[0]
        return bytes(byte_list)

    if logical_type == "number-special":
        sentinel: str = args[0]
        return decode_number_special(sentinel)

    if logical_type == "int64":
        return decode_int64(args[0])

    if logical_type == "decimal":
        return decode_decimal(args[0])

    if logical_type == "uuid":
        return decode_uuid(args[0])

    raise ValueError(f"construct_seed: unrecognised logicalType {logical_type!r}")


# ---------------------------------------------------------------------------
# Invariant checker (used by the test harness)
# ---------------------------------------------------------------------------

def check_invariant(decoded: Any, pointer: str, expected: Wire) -> bool:
    """Check a single post-decode invariant.

    The `pointer` is a virtual JSON Pointer that maps to a computed attribute
    of the decoded value — not a literal JSON Pointer into a dict, but a
    semantic label defined per logical type:

      /epochMs   — datetime: int(dt.timestamp() * 1000) since Unix epoch
      /bigintStr — int: str(value) (proves no precision loss)
      /str       — Decimal: str(value) (proves no float coercion)
      /utf8      — bytes: decoded as UTF-8 string
      /value     — str: the value itself (UUID, etc.)
      /isNaN     — float: math.isnan(value)
      /isFinite  — float: math.isfinite(value)

    Args:
        decoded: The decoded native Python value.
        pointer: The semantic pointer string (e.g. "/epochMs").
        expected: The expected Wire value.

    Returns:
        True if the invariant holds; False otherwise.
    """
    actual: Any

    if pointer == "/epochMs":
        if not isinstance(decoded, datetime):
            return False
        actual = int(decoded.timestamp() * 1000)

    elif pointer == "/bigintStr":
        if not isinstance(decoded, int):
            return False
        actual = str(decoded)

    elif pointer == "/str":
        actual = str(decoded)

    elif pointer == "/utf8":
        if not isinstance(decoded, (bytes, bytearray)):
            return False
        actual = decoded.decode("utf-8")

    elif pointer == "/value":
        actual = decoded

    elif pointer == "/isNaN":
        if not isinstance(decoded, float):
            return False
        actual = math.isnan(decoded)

    elif pointer == "/isFinite":
        if not isinstance(decoded, float):
            return False
        actual = math.isfinite(decoded)

    else:
        # Unknown pointer — cannot validate; conservative fail.
        return False

    return actual == expected
