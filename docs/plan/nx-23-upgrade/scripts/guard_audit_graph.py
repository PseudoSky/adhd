#!/usr/bin/env python3
"""guard_audit_graph.py — audit gate for the task-graph remodel phases.

Drives:

    node docs/plan/nx-23-upgrade/scripts/run-audit.js --phase intake,reconcile,config,graph

This is the gate that makes "the inferred targets are equivalent" un-fakeable:
the three graph states delete 136 explicit executor targets across ~62 project
manifests, and their criteria re-run a real build and a real suite through the
inferred target. A green here means the artifacts still get produced.

Repo-owned `python3 …​.py` → environment-pinned.
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "intake,reconcile,config,graph"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_graph: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
    sys.stderr.write(f"guard_audit_graph: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_graph: RED — {proc.returncode} criterion(s) failed.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
