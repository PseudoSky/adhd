#!/usr/bin/env python3
"""guard_audit_final.py — whole-family final audit gate (F11, F13).

Replaces the old `npx --yes nx run-many -t build --projects=environment-*` guard,
which went GREEN whenever the nx-registered packages compiled — and, worse,
SILENTLY covered only 4 of the 6 packages: environment-core-py and
environment-core-rs have no project.json, so `--projects=environment-*` never
built or tested them (F13). A green there proved nothing about the two
cross-language runtimes.

This guard drives the declarative harness across EVERY phase and then enforces
two coverage invariants that a narrowed glob cannot satisfy:

  1. node scripts/run-audit.js         (no --phase → all criteria)
     RED unless every criterion PASSES (exit == harness failure count).

  2. COVERAGE COUNT — the harness must emit one `[id] PASS/FAIL` marker for
     EVERY criterion declared in criteria.json. If markers < declared (a phase
     was silently dropped) OR the declared floor is implausibly low (an emptied
     criteria.json), the gate FAILS. This makes "built everything" un-fakeable
     by narrowing the project set.

  3. EXPLICIT cross-language coverage — the pinned Python (pytest) and Rust
     (cargo test) criteria MUST be present AND PASS:
        audit-final.9  -> guard_runtime_py.py test   (uv run --python 3.10 -m pytest)
        audit-final.10 -> guard_runtime_rs.py test   (rustup run 1.95.0 cargo test)
        runtime-py.2 / runtime-rs.2 (same pinned guards)
     so the Python and Rust runtimes are proven regardless of nx registration.

Repo-owned `python3 …​.py` → environment-pinned; every leg it drives is pinned.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
CRITERIA = SCRIPT_DIR / "criteria.json"

MARKER_RE = re.compile(r"\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]\s+(PASS|FAIL)\b")
# Cross-language runtimes MUST be covered explicitly (F13). All four are pinned.
REQUIRED_IDS = {"audit-final.9", "audit-final.10", "runtime-py.2", "runtime-rs.2"}
# Floor guards against an emptied/narrowed criteria.json passing as 0==0.
MIN_CRITERIA = 40


def main() -> int:
    if not RUN_AUDIT.exists() or not CRITERIA.exists():
        sys.stderr.write("guard_audit_final: FATAL — missing run-audit.js or criteria.json\n")
        return 2

    declared = json.loads(CRITERIA.read_text()).get("criteria", [])
    declared_ids = {c["id"] for c in declared if isinstance(c, dict) and "id" in c}
    declared_n = len(declared_ids)

    cmd = ["node", str(RUN_AUDIT)]
    sys.stderr.write(f"guard_audit_final: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    sys.stdout.write(proc.stdout or "")
    sys.stderr.write(proc.stderr or "")

    seen = {}
    for m in MARKER_RE.finditer(proc.stdout or ""):
        seen[m.group(1)] = m.group(2) == "PASS"

    failures = 0

    # (1) harness result — every criterion must pass.
    if proc.returncode != 0:
        failures += 1
        sys.stderr.write(
            f"guard_audit_final: RED — harness reported {proc.returncode} failing criterion(s).\n"
        )

    # (2) coverage count — no criterion silently dropped, floor respected.
    if declared_n < MIN_CRITERIA:
        failures += 1
        sys.stderr.write(
            f"guard_audit_final: RED — criteria.json declares only {declared_n} criteria "
            f"(< floor {MIN_CRITERIA}); refusing to read a shrunken suite as full coverage.\n"
        )
    missing = declared_ids - set(seen)
    if missing:
        failures += 1
        sys.stderr.write(
            f"guard_audit_final: RED — harness emitted {len(seen)} markers but criteria.json "
            f"declares {declared_n}; {len(missing)} never ran: {sorted(missing)[:8]}…\n"
        )

    # (3) explicit cross-language coverage — pinned pytest + cargo test present AND green.
    for cid in sorted(REQUIRED_IDS):
        if cid not in seen:
            failures += 1
            sys.stderr.write(
                f"guard_audit_final: RED — required cross-language criterion {cid} did not run "
                "(Python/Rust coverage missing).\n"
            )
        elif not seen[cid]:
            failures += 1
            sys.stderr.write(f"guard_audit_final: RED — required cross-language criterion {cid} FAILED.\n")

    if failures == 0:
        sys.stderr.write(
            f"guard_audit_final: GREEN — {declared_n} criteria all passed; "
            "Python + Rust runtimes explicitly covered via pinned guards.\n"
        )
    return failures


if __name__ == "__main__":
    sys.exit(main())
