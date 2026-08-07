#!/usr/bin/env python3
"""guard_audit_builder.py — audit gate for the builder wave (F11).

Replaces the old `npx --yes nx build environment-base-spec && npx --yes nx build
environment-builder` guard, which went GREEN the moment the two packages merely
COMPILED — regardless of whether any acceptance criterion held. This guard drives
the declarative audit harness for exactly the phases the builder wave delivers:

    node scripts/run-audit.js --phase contract,builder

so the gate is RED until every contract + builder criterion actually PASSES
(schema/vectors/index exist, field-merge & config-resolver behave, the snapshot
API file exists, packages build). Exit == the harness failure count (0 ⇔ green).

It is a repo-owned `python3 …​.py` invocation → environment-pinned. Every check it
runs is itself pinned (npx/node, and the py/rust legs delegate to the pinned
guard scripts), so no leg launders past the substring env-pin heuristic (F8).
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "contract,builder"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_builder: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
    sys.stderr.write(f"guard_audit_builder: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_builder: RED — {proc.returncode} builder-wave "
            "criterion(s) failed (see [id] FAIL markers above).\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
