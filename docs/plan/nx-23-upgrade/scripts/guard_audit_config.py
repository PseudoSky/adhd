#!/usr/bin/env python3
"""guard_audit_config.py — audit gate for the compiler-config phase.

Drives:

    node docs/plan/nx-23-upgrade/scripts/run-audit.js --phase intake,reconcile,config

The phase-scoped accumulation means a regression in an earlier phase re-blocks
this gate — the shim removal cannot go green on top of a broken reconcile.

Repo-owned `python3 …​.py` → environment-pinned.
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "intake,reconcile,config"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_config: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
    sys.stderr.write(f"guard_audit_config: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_config: RED — {proc.returncode} criterion(s) failed.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
