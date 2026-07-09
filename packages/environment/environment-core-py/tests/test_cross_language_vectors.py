"""Assert the Python primitives reproduce every pinned cross-language vector.

Source of truth (AUTHORITATIVE):
    packages/environment/environment-base-spec/spec/cross-language-test-vectors.json

Per that file's top-level ``description``: contentHash / projectEnvPrefix /
inferEnvVar are compared by exact string equality; generateFieldSchema is
compared by structural (deep) equality of the parsed JSON object -- key
insertion order is not semantically significant. Plain Python dict/list
equality already implements structural equality, so ``==`` is sufficient.

Never change an existing vector's expected value here without updating the
pinned JSON file and the TypeScript/Rust clients in the same change --
add new vectors instead of mutating pinned ones.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from adhd_environment.environment import (
    content_hash,
    generate_field_schema,
    infer_env_var,
    project_env_prefix,
)

#: packages/environment/environment-base-spec/spec/cross-language-test-vectors.json
#: (this file lives at packages/environment/environment-core-py/tests/, so the
#: base-spec sibling package is two directories up).
VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "environment-base-spec"
    / "spec"
    / "cross-language-test-vectors.json"
)


def _load_vectors() -> dict[str, Any]:
    if not VECTORS_PATH.is_file():
        return {
            "contentHash": [],
            "projectEnvPrefix": [],
            "inferEnvVar": [],
            "generateFieldSchema": [],
        }
    with VECTORS_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


_VECTORS = _load_vectors()


def test_vectors_file_exists() -> None:
    """The pinned vectors file must exist -- everything else in this module
    is meaningless without it."""
    assert VECTORS_PATH.is_file(), f"pinned cross-language vectors file missing: {VECTORS_PATH}"


def test_vectors_file_is_nonempty() -> None:
    assert _VECTORS.get("contentHash"), "no contentHash vectors loaded"
    assert _VECTORS.get("projectEnvPrefix"), "no projectEnvPrefix vectors loaded"
    assert _VECTORS.get("inferEnvVar"), "no inferEnvVar vectors loaded"
    assert _VECTORS.get("generateFieldSchema"), "no generateFieldSchema vectors loaded"


@pytest.mark.parametrize(
    "vector", _VECTORS.get("contentHash", []), ids=lambda v: v["name"]
)
def test_content_hash_vector(vector: dict[str, Any]) -> None:
    assert content_hash(vector["input"]) == vector["expected"]


@pytest.mark.parametrize(
    "vector", _VECTORS.get("projectEnvPrefix", []), ids=lambda v: v["name"]
)
def test_project_env_prefix_vector(vector: dict[str, Any]) -> None:
    assert project_env_prefix(vector["input"]) == vector["expected"]


@pytest.mark.parametrize(
    "vector", _VECTORS.get("inferEnvVar", []), ids=lambda v: v["name"]
)
def test_infer_env_var_vector(vector: dict[str, Any]) -> None:
    result = infer_env_var(vector["input"]["prefix"], vector["input"]["fieldPath"])
    assert result == vector["expected"]


@pytest.mark.parametrize(
    "vector", _VECTORS.get("generateFieldSchema", []), ids=lambda v: v["name"]
)
def test_generate_field_schema_vector(vector: dict[str, Any]) -> None:
    # Structural equality per the vectors file's comparison semantics --
    # plain dict equality already ignores key insertion order.
    assert generate_field_schema(vector["input"]) == vector["expected"]


def test_content_hash_unsorted_and_presorted_inputs_agree() -> None:
    """Belt-and-braces on top of the parametrized vectors above: prove the
    two 'same content, different input key order' vectors produce the
    exact same hash as each other, not just the same hash as the pinned
    expected string."""
    unsorted = next(
        v for v in _VECTORS["contentHash"] if v["name"] == "spec-example-unsorted-input"
    )
    presorted = next(
        v for v in _VECTORS["contentHash"] if v["name"] == "spec-example-pre-sorted-input"
    )
    assert content_hash(unsorted["input"]) == content_hash(presorted["input"])


def test_known_discrepancy_is_documented_and_not_silently_patched() -> None:
    """The vectors file documents that _shared.md / criteria.json
    (audit-final.6) pin a placeholder SHA-256 digest of the literal string
    'test' for contentHash({b:'2',a:'1'}) -- not a real output of the
    documented algorithm. This suite intentionally implements the
    documented algorithm (sorted key=value\\n lines -> SHA-256) and
    asserts the CORRECTED value from this vectors file, matching the
    other two runtime clients (TS/Rust). It does not special-case the
    wrong placeholder value to match the stale criterion.
    """
    discrepancy = _VECTORS.get("knownDiscrepancy")
    assert discrepancy is not None
    assert discrepancy["field"] == "contentHash[0]"
    assert content_hash({"b": "2", "a": "1"}) != "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    assert content_hash({"b": "2", "a": "1"}) == (
        "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
    )
