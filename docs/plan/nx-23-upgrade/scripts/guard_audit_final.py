#!/usr/bin/env python3
"""guard_audit_final.py — whole-plan final audit gate (the pre-landing hold).

Runs the full declarative harness across EVERY phase and then enforces two
coverage invariants a narrowed run cannot satisfy:

  1. node run-audit.js            (no --phase → all criteria)
     RED unless every criterion PASSES (exit == harness failure count).

  2. COVERAGE COUNT — the harness must emit one `[id] PASS/FAIL` marker for EVERY
     criterion declared in criteria.json, and criteria.json must not have been
     shrunk below a floor. This makes "everything passed" un-fakeable by emptying
     the suite.

  3. EXPLICIT DoD coverage — every [dod.N] clause must have produced an executed
     PASS marker. `state-transition.js` refuses DONE on an unconfirmed DoD; this
     gate is the plan-side half of the same contract.

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
# Floor guards against an emptied/narrowed criteria.json passing as 0==0.
MIN_CRITERIA = 70


def main() -> int:
    if not RUN_AUDIT.exists() or not CRITERIA.exists():
        sys.stderr.write("guard_audit_final: FATAL — missing run-audit.js or criteria.json\n")
        return 2

    declared = json.loads(CRITERIA.read_text()).get("criteria", [])
    declared_ids = {c["id"] for c in declared if isinstance(c, dict) and "id" in c}
    declared_n = len(declared_ids)
    dod_ids = {i for i in declared_ids if i.startswith("dod.")}

    cmd = ["node", str(RUN_AUDIT)]
    sys.stderr.write(f"guard_audit_final: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True)
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

    # (3) every DoD clause produced an executed PASS.
    if not dod_ids:
        failures += 1
        sys.stderr.write("guard_audit_final: RED — no [dod.N] proof checks are declared.\n")
    for cid in sorted(dod_ids):
        if cid not in seen:
            failures += 1
            sys.stderr.write(
                f"guard_audit_final: RED — DoD clause {cid} emitted no executed PASS marker; "
                "DONE would be refused.\n"
            )
        elif not seen[cid]:
            failures += 1
            sys.stderr.write(f"guard_audit_final: RED — DoD clause {cid} FAILED.\n")

    if failures == 0:
        sys.stderr.write(
            f"guard_audit_final: GREEN — {declared_n} criteria all passed; "
            f"{len(dod_ids)} DoD clauses confirmed by executed checks.\n"
        )
    return failures


if __name__ == "__main__":
    sys.exit(main())
