#!/usr/bin/env python3
"""guard_audit_tests.py — audit gate for the file-level test selection phase.

Drives:

    node docs/plan/nx-23-upgrade/scripts/run-audit.js --phase intake,reconcile,config,graph,tests

The two load-bearing checks in this phase are the custom probes
(`check-zero-selection.mjs` and `check-cross-package-selection.mjs`), which drive
the real fast path and assert:
  - a zero-selection run exits NON-ZERO and says so (the fail-safe property), and
  - a cross-package change still selects a dependent package's specs (the
    consumer-coverage property the commit gate exists to protect).

Repo-owned `python3 …​.py` → environment-pinned.
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "intake,reconcile,config,graph,tests"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_tests: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
    sys.stderr.write(f"guard_audit_tests: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_tests: RED — {proc.returncode} criterion(s) failed.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
