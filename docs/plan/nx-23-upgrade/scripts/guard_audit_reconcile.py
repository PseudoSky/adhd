#!/usr/bin/env python3
"""guard_audit_reconcile.py — audit gate for the intake + reconcile phases.

Drives the declarative audit harness for exactly the phases the reconcile wave
delivers:

    node docs/plan/nx-23-upgrade/scripts/run-audit.js --phase reconcile

so the gate is RED until every criterion of the intake and reconcile states
actually PASSES. Exit == the harness failure count (0 ⇔ green).

This is a repo-owned `python3 …​.py` invocation → environment-pinned. Every check
it drives is itself pinned (nx via ./node_modules/.bin, node assertions), so no
leg launders past the substring env-pin heuristic.
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "reconcile"

# BUG-PLAN-AUDIT-PHASE: `run-audit.js` accepts ONE phase name and ACCUMULATES
# every phase declared before it (`accumulatedPhases`), so a comma-joined list is
# rejected outright: `--phase "intake,reconcile"` throws
# `--phase "intake,reconcile" is not a declared phase`. Pass the terminal phase
# only — it runs that phase plus all prior ones, which is exactly the "re-runs
# every criterion of its phase plus all prior phases" contract these gates claim.


# BUG-PLAN-AUDIT-CWD: `run-audit.js` resolves `criteria.json` relative to
# `process.cwd()` (its `resolveCriteriaFile`), but the criteria COMMANDS are
# written as repo-root-relative paths (`./node_modules/.bin/nx`,
# `entrypoint/<pkg>/dist/index.js`) and therefore need `cwd=REPO_ROOT`. Resolving
# the criteria file from cwd and executing the commands from cwd cannot both be
# satisfied by one cwd. Pass the runner its criteria file explicitly (the
# `--criteria` flag is checked first and honours an absolute path), so cwd stays
# REPO_ROOT for command execution. Without this the guard is red by construction:
# it reports `[audit.no-criteria] FAIL` regardless of the plan's real state.
CRITERIA = SCRIPT_DIR / "criteria.json"



def main() -> int:
    if not RUN_AUDIT.exists() or not CRITERIA.exists():
        sys.stderr.write(f"guard_audit_reconcile: FATAL — missing {RUN_AUDIT} or {CRITERIA}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES, "--criteria", str(CRITERIA)]
    sys.stderr.write(f"guard_audit_reconcile: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_reconcile: RED — {proc.returncode} criterion(s) failed "
            "(see [id] FAIL markers above).\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
