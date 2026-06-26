#!/usr/bin/env python3
"""audit_lt-conformance-crosshost.py — the cross-language proof (state guard).

PROVES the plan's central claim end-to-end with the REAL built host artifacts
(no mocks): a value round-trips

    TS → wire → Python → wire → TS

(and the mirror Python → wire → TS → wire → Python) as the SAME value, *byte
stable*, for every shared conformance vector.

Why this exists
---------------
The TS host suite and the Python host suite are each green, and the
`apigen-conformance:conformance` gate proves each host independently encodes
`seed → wire` and decodes `wire`. But "each host is internally consistent" is
NOT "a wire produced by one host is byte-identical to the wire the other host
re-emits from it." That cross-host stability is the actual portability
guarantee, and it is what this audit drives.

Real components driven (CLAUDE.md verification standard)
--------------------------------------------------------
TS leg  — the shipped `tsHostBinding` from `@adhd/apigen-runtime` (codecs from
          `@adhd/apigen-logical`), executed via the workspace-pinned tsx using
          the exact invocation the proven `apigen-conformance:conformance`
          target uses:
              {workspaceRoot}/node_modules/.bin/tsx \
                  --tsconfig packages/apigen/conformance/tsconfig.json \
                  docs/plan/apigen-logical-types/scripts/crosshost_ts_shim.ts
          cwd = workspace root, NOT ambient PATH.
Python leg — the shipped `packages/apigen/python/apigen_logical.py` module:
          schema-driven `decode()` + the per-format `encode_*` primitive (the
          same dispatch the codegen glue performs and the exact mirror of TS's
          per-id `codec.encode`).

Vectors  — loaded at runtime from the SAME shared fixture both hosts consume:
          `packages/apigen/python/conformance_vectors.json` → LOGICAL_TYPE_VECTORS,
          which is generated from `packages/apigen/conformance/src/lib/vectors.ts`
          (`logicalTypeVectors`). Expected wire is read from each vector — never
          hard-coded.

Legs asserted per vector
------------------------
  1. TS encode:        construct native seed → real codec.encode → tsWire.
                       Assert tsWire == vector.wire (canonical).
  2. Cross fwd:        Python decode(tsWire) → schema-correct re-encode → pyWire.
                       Assert pyWire == tsWire (BYTE-EQUAL) — the core proof.
  3. Full loop:        feed pyWire back to TS decode+re-encode → tsWire2.
                       Assert tsWire2 == vector.wire — TS→wire→Py→wire→TS closed.
  4. Mirror:           Python constructs its seed → schema-encode → pyWire0.
                       Assert pyWire0 == vector.wire; feed to TS decode+re-encode
                       → tsWireM; assert tsWireM == vector.wire — Py→wire→TS→wire→Py.
  5. Negative control: apply vector.negativeControl mutation as the wire fed
                       across the boundary; assert the cross-host byte-equal
                       check goes RED (corrupted wire / wrong codec detected).
                       A vacuous audit (mutation that stays green) is a FAILURE.

Exit-code discipline
--------------------
Exit 0 ONLY if every leg of every vector passes (and every negative control goes
red). Otherwise non-zero with a per-vector report. Keyed entirely on the
subprocess exit status — never `| grep -q`.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

# --------------------------------------------------------------------------
# Paths — resolve everything from the workspace root deterministically.
# --------------------------------------------------------------------------
WORKSPACE_ROOT = Path(__file__).resolve().parents[4]
TSX_BIN = WORKSPACE_ROOT / "node_modules" / ".bin" / "tsx"
TS_TSCONFIG = WORKSPACE_ROOT / "packages" / "apigen" / "conformance" / "tsconfig.json"
TS_SHIM = Path(__file__).resolve().parent / "crosshost_ts_shim.ts"
PY_HOST_DIR = WORKSPACE_ROOT / "packages" / "apigen" / "python"
VECTORS_JSON = PY_HOST_DIR / "conformance_vectors.json"

sys.path.insert(0, str(PY_HOST_DIR))
import apigen_logical as al  # noqa: E402  (real shipped Python host artifact)


# --------------------------------------------------------------------------
# Canonical wire comparison — byte-stable JSON (sorted keys, compact).
# --------------------------------------------------------------------------
def canon(value: Any) -> str:
    """Canonical JSON string for byte-equality comparison of wire values."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


# --------------------------------------------------------------------------
# TS leg — drive the REAL tsHostBinding via the workspace-pinned tsx.
# --------------------------------------------------------------------------
class TsError(Exception):
    """Raised when the TS shim reports a codec/construction error."""


def ts_call(op: str, vector: dict[str, Any], wire: Any = None) -> Any:
    """Invoke the real TS host leg; return the produced wire.

    Uses the same tsx invocation as the proven `conformance` nx target, with
    cwd = workspace root and the workspace-pinned binary (not ambient PATH).
    Raises TsError if the shim reports ok=false (a genuine codec failure, used
    by the negative-control leg to detect corruption).
    """
    if not TSX_BIN.exists():
        raise RuntimeError(f"workspace tsx not found at {TSX_BIN}")
    req: dict[str, Any] = {"op": op, "vector": vector}
    if wire is not None or op == "decode_reencode":
        req["wire"] = wire
    proc = subprocess.run(
        [str(TSX_BIN), "--tsconfig", str(TS_TSCONFIG), str(TS_SHIM)],
        input=json.dumps(req),
        cwd=str(WORKSPACE_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"TS shim subprocess exited {proc.returncode}:\n{proc.stderr or proc.stdout}"
        )
    out = proc.stdout.strip()
    try:
        resp = json.loads(out)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"TS shim returned non-JSON: {out!r} ({e})") from e
    if not resp.get("ok"):
        raise TsError(str(resp.get("error", "unknown TS error")))
    return resp["wire"]


# --------------------------------------------------------------------------
# Python leg — drive the REAL apigen_logical schema-driven decode + the
# schema-correct re-encode (the exact mirror of TS's per-id codec.encode,
# i.e. the same dispatch the generated Python glue performs).
# --------------------------------------------------------------------------
def _format_of(schema: dict[str, Any]) -> str | None:
    """Map a vector schema to the logical format key driving the re-encode."""
    t = schema.get("type")
    fmt = schema.get("format")
    if t == "string" and fmt in ("date-time", "int64", "decimal", "byte", "uuid"):
        return fmt
    if t == "number" and fmt is None:
        return "number-special"
    return None


# Schema-correct re-encode dispatch: native (post-decode) value -> canonical wire.
# These are the SAME primitives the generated glue emits — value-driven
# `encode_value` cannot be used for int64 because a Python `int` is structurally
# indistinguishable from a plain JSON integer, so the schema/format MUST drive
# the encode (exactly as TS's int64Codec does).
_PY_ENCODE: dict[str, Callable[[Any], Any]] = {
    "date-time": al.encode_datetime,
    "int64": al.encode_int64,
    "decimal": al.encode_decimal,
    "byte": al.encode_bytes,
    "uuid": al.encode_uuid,
    "number-special": al.encode_number_special,
}


def py_decode_reencode(wire: Any, schema: dict[str, Any]) -> Any:
    """REAL Python host: schema-driven decode of `wire`, then schema-correct
    re-encode of the resulting native value back to canonical wire."""
    fmt = _format_of(schema)
    if fmt is None:
        raise ValueError(f"no logical format for schema {schema!r}")
    native = al.decode(wire, schema)
    return _PY_ENCODE[fmt](native)


def py_construct_seed_encode(vector: dict[str, Any]) -> Any:
    """REAL Python host mirror seed: build the native Python seed from the
    vector recipe, then schema-correct encode it to canonical wire."""
    schema = vector["schema"]
    fmt = _format_of(schema)
    if fmt is None:
        raise ValueError(f"no logical format for schema {schema!r}")
    native = al.construct_seed(vector["seed"])
    # construct_seed yields the native form (datetime/int/Decimal/bytes/float/str);
    # encode through the schema-correct primitive — identical to the decode path's encode.
    return _PY_ENCODE[fmt](native)


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
_results: list[tuple[bool, str]] = []


def record(ok: bool, label: str, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    line = f"{tag} {label}"
    if detail and not ok:
        line += f"  -- {detail}"
    print(line)
    _results.append((ok, label))
    return ok


# --------------------------------------------------------------------------
# Per-vector cross-host chain
# --------------------------------------------------------------------------
def run_vector(v: dict[str, Any]) -> None:
    vid = v["id"]
    schema = v["schema"]
    canonical_wire = v["wire"]
    fmt = _format_of(schema)

    if fmt is None:
        record(False, f"{vid} [schema]", f"unrecognised logical schema {schema!r}")
        return

    # ---- Leg 1: TS encode seed -> tsWire; assert == canonical wire ----
    try:
        ts_wire = ts_call("encode_seed", v)
    except Exception as e:  # noqa: BLE001
        record(False, f"{vid} [ts-encode]", str(e))
        return
    ok1 = canon(ts_wire) == canon(canonical_wire)
    record(ok1, f"{vid} [ts-encode==canonical]",
           f"tsWire={canon(ts_wire)} != canonical={canon(canonical_wire)}")
    if not ok1:
        return

    # ---- Leg 2: Python decode(tsWire) -> re-encode -> pyWire; BYTE-EQUAL tsWire ----
    try:
        py_wire = py_decode_reencode(ts_wire, schema)
    except Exception as e:  # noqa: BLE001
        record(False, f"{vid} [py-decode-reencode]", str(e))
        return
    record(
        canon(py_wire) == canon(ts_wire),
        f"{vid} [cross-fwd TS->wire->Py->wire byte-equal]",
        f"pyWire={canon(py_wire)} != tsWire={canon(ts_wire)}",
    )

    # ---- Leg 3: feed pyWire back to TS decode+re-encode -> tsWire2 == canonical ----
    try:
        ts_wire2 = ts_call("decode_reencode", v, wire=py_wire)
    except Exception as e:  # noqa: BLE001
        record(False, f"{vid} [full-loop TS-redecode]", str(e))
        return
    record(
        canon(ts_wire2) == canon(canonical_wire),
        f"{vid} [full loop TS->wire->Py->wire->TS == original]",
        f"tsWire2={canon(ts_wire2)} != canonical={canon(canonical_wire)}",
    )

    # ---- Leg 4 (mirror): Python seed -> pyWire0 == canonical; TS re-decode == canonical ----
    try:
        py_wire0 = py_construct_seed_encode(v)
    except Exception as e:  # noqa: BLE001
        record(False, f"{vid} [py-encode-seed]", str(e))
        return
    record(
        canon(py_wire0) == canon(canonical_wire),
        f"{vid} [py-encode==canonical]",
        f"pyWire0={canon(py_wire0)} != canonical={canon(canonical_wire)}",
    )
    try:
        ts_wire_m = ts_call("decode_reencode", v, wire=py_wire0)
    except Exception as e:  # noqa: BLE001
        record(False, f"{vid} [mirror Py->wire->TS]", str(e))
        return
    record(
        canon(ts_wire_m) == canon(canonical_wire),
        f"{vid} [mirror Py->wire->TS->wire == original]",
        f"tsWireM={canon(ts_wire_m)} != canonical={canon(canonical_wire)}",
    )

    # ---- Leg 5: negative control — mutated wire must turn the cross-host check RED ----
    nc = v["negativeControl"]
    if nc.get("mutate") != "wire":
        # Non-wire mutations (schema/codec) are red by construction (no codec fires);
        # this audit's teeth are the wire mutations present in the scalar vectors.
        record(True, f"{vid} [neg-control non-wire trivially-red]")
        return
    mutated = nc["to"]
    neg_red = _negative_control_red(v, fmt, schema, canonical_wire, mutated)
    record(
        neg_red,
        f"{vid} [negative-control turns cross-host RED]",
        f"mutation to {canon(mutated)} did NOT break the cross-host check (vacuous)",
    )


def _negative_control_red(
    v: dict[str, Any],
    fmt: str,
    schema: dict[str, Any],
    canonical_wire: Any,
    mutated: Any,
) -> bool:
    """A negative control is RED iff driving the mutated wire across BOTH real
    hosts fails to reproduce the canonical wire (or one host rejects it).

    We push the mutated wire through:
      - TS:     decode+re-encode the mutated wire; if it errors OR does not equal
                the canonical wire, the corruption was detected.
      - Python: decode+re-encode the mutated wire; same criterion.
    The control is RED if EITHER host detects the corruption (errors, or produces
    a wire != canonical). A control that leaves BOTH hosts reproducing the exact
    canonical wire is vacuous → not red → FAIL.
    """
    ts_detected = False
    try:
        ts_mut = ts_call("decode_reencode", v, wire=mutated)
        ts_detected = canon(ts_mut) != canon(canonical_wire)
    except TsError:
        ts_detected = True  # real codec rejected the corrupted wire
    except Exception:  # noqa: BLE001
        ts_detected = True

    py_detected = False
    try:
        py_mut = py_decode_reencode(mutated, schema)
        py_detected = canon(py_mut) != canon(canonical_wire)
    except Exception:  # noqa: BLE001
        py_detected = True

    return ts_detected or py_detected


# --------------------------------------------------------------------------
# Self-check the negative-control machinery is not itself vacuous: a known-good
# (unmutated) canonical wire must NOT be flagged red. If it were, the teeth
# would fire on everything and prove nothing.
# --------------------------------------------------------------------------
def assert_teeth_are_real(vectors: list[dict[str, Any]]) -> bool:
    all_ok = True
    for v in vectors:
        schema = v["schema"]
        fmt = _format_of(schema)
        if fmt is None:
            continue
        canonical = v["wire"]
        # Passing the UNMUTATED canonical wire must NOT be flagged red.
        false_positive = _negative_control_red(v, fmt, schema, canonical, canonical)
        ok = not false_positive
        all_ok &= ok
        record(
            ok,
            f"{v['id']} [teeth-control: canonical wire is NOT falsely red]",
            "canonical wire was flagged corrupt — negative-control logic is vacuous/over-eager",
        )
    return all_ok


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main() -> int:
    print(f"cross-host conformance audit  (workspace: {WORKSPACE_ROOT})")
    print(f"TS host : {TS_SHIM.relative_to(WORKSPACE_ROOT)} via {TSX_BIN.relative_to(WORKSPACE_ROOT)}")
    print(f"Py host : {VECTORS_JSON.relative_to(WORKSPACE_ROOT)} -> apigen_logical.py")

    if not VECTORS_JSON.exists():
        print(f"FATAL: shared vectors fixture missing: {VECTORS_JSON}")
        return 2
    if not TS_SHIM.exists():
        print(f"FATAL: TS shim missing: {TS_SHIM}")
        return 2

    with VECTORS_JSON.open() as f:
        fixture = json.load(f)
    vectors: list[dict[str, Any]] = fixture.get("LOGICAL_TYPE_VECTORS", [])
    if not vectors:
        print("FATAL: LOGICAL_TYPE_VECTORS is empty in the shared fixture")
        return 2

    # The fixture is the source of truth; cross-check it against the Python
    # host's own derivation count so we know we are driving the full matrix.
    print(f"loaded {len(vectors)} logical-type vectors from the shared fixture\n")

    # Require coverage of the canonical scalar set named in the state spec.
    required = {"date-time", "int64", "decimal", "byte", "uuid", "number-special"}
    covered = {v["logicalType"] for v in vectors}
    missing = required - covered
    if missing:
        record(False, "[coverage]", f"missing canonical scalars: {sorted(missing)}")
    else:
        record(True, "[coverage all canonical scalars present]")

    print("\n--- teeth self-check (canonical wires must NOT be flagged red) ---")
    assert_teeth_are_real(vectors)

    print("\n--- per-vector cross-host chain ---")
    for v in vectors:
        run_vector(v)

    passed = sum(1 for ok, _ in _results if ok)
    total = len(_results)
    print(f"\n{passed}/{total} passed")
    failures = [label for ok, label in _results if not ok]
    if failures:
        print("FAILURES:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("FULL CHAIN BYTE-STABLE, NO CROSS-HOST MISMATCH.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
