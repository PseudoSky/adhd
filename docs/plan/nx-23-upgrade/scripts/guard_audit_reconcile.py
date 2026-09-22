#!/usr/bin/env python3
"""guard_audit_reconcile.py — audit gate for the intake + reconcile phases.

Drives the declarative audit harness for exactly the phases the reconcile wave
delivers:

    node docs/plan/nx-23-upgrade/scripts/run-audit.js --phase intake,reconcile

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
PHASES = "intake,reconcile"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_reconcile: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
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
