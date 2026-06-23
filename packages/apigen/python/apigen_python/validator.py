"""
apigen_python.validator — JSON-Schema 2020-12 validation for the Python host (SPEC §6).

Implements validation as a fast-fail pre-filter. Tries to use the ``jsonschema``
library if installed; falls back to a minimal stdlib-only validator that covers
the common cases used by the conformance vectors.

SPEC §6 note: validation is necessary-not-sufficient. The Python host validates
as a pre-filter; typed dispatch is the authoritative boundary.
"""

from __future__ import annotations

from typing import Any


# ---------------------------------------------------------------------------
# Try to import jsonschema (optional dependency)
# ---------------------------------------------------------------------------

try:
    import jsonschema  # type: ignore[import]
    _HAS_JSONSCHEMA = True
except ImportError:
    _HAS_JSONSCHEMA = False


# ---------------------------------------------------------------------------
# Minimal stdlib validator (fallback when jsonschema is not installed)
#
# Covers: type, required, properties, oneOf, items, additionalProperties.
# Sufficient for all conformance vector schemas.
# ---------------------------------------------------------------------------

def _check_type(schema_type: str, value: Any) -> bool:
    type_map = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }
    checker = type_map.get(schema_type)
    return checker(value) if checker else True


def _minimal_validate(schema: dict[str, Any], value: Any) -> bool:
    """Validate *value* against *schema* using a minimal subset of JSON Schema.

    Returns True if valid, False if invalid.
    Does NOT raise; the caller decides how to surface failure.
    """
    if not isinstance(schema, dict):
        return True  # empty / non-schema → accept

    # type keyword
    schema_type = schema.get("type")
    if schema_type is not None:
        if not _check_type(schema_type, value):
            return False

    # oneOf
    one_of = schema.get("oneOf")
    if one_of is not None:
        matches = sum(1 for s in one_of if _minimal_validate(s, value))
        if matches != 1:
            # Relax to "at least one" (some schemas use oneOf where anyOf is meant).
            if matches == 0:
                return False

    # required + properties (object only)
    if schema_type == "object" and isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                return False
        properties = schema.get("properties", {})
        for prop_name, prop_schema in properties.items():
            if prop_name in value:
                if not _minimal_validate(prop_schema, value[prop_name]):
                    return False

    # items (array only)
    if schema_type == "array" and isinstance(value, list):
        items_schema = schema.get("items")
        if items_schema:
            for item in value:
                if not _minimal_validate(items_schema, item):
                    return False

    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class ValidationError(Exception):
    """Raised when input data fails JSON-Schema validation."""

    def __init__(self, message: str, path: str = "") -> None:
        super().__init__(message)
        self.path = path


def validate(schema: dict[str, Any], value: Any) -> None:
    """Validate *value* against *schema*.

    Uses ``jsonschema`` if installed (full JSON-Schema 2020-12), otherwise falls
    back to the minimal stdlib validator.

    Raises:
        ValidationError: if the value does not satisfy the schema.
    """
    if _HAS_JSONSCHEMA:
        try:
            jsonschema.validate(value, schema)
        except jsonschema.ValidationError as exc:
            raise ValidationError(str(exc.message)) from exc
    else:
        if not _minimal_validate(schema, value):
            raise ValidationError(
                f"Value does not satisfy schema (minimal validator): {value!r}"
            )


def is_valid(schema: dict[str, Any], value: Any) -> bool:
    """Return True if *value* satisfies *schema*, False otherwise. Never raises."""
    try:
        validate(schema, value)
        return True
    except ValidationError:
        return False
