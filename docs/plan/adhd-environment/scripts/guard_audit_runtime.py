#!/usr/bin/env python3
"""guard_audit_runtime.py — audit gate for the runtime wave (F11, F8).

Replaces the old `npx --yes nx build environment-core-node && python -m build &&
cargo build` guard. That guard was broken two ways: it went GREEN on mere
compilation, AND its `python -m build && cargo build` legs were BARE — ambient
`python`/`cargo` — yet the substring env-pin heuristic still reported the whole
string PINNED because `npx --yes` appeared earlier in it (F8 laundering).

This guard drives the declarative harness for the runtime phase:

    node scripts/run-audit.js --phase runtime

Every runtime criterion the harness runs is INDEPENDENTLY pinned: the Node/CLI
legs use npx/node against the repo-local toolchain, and EVERY Python/Rust leg
delegates to the pinned guard scripts (`guard_runtime_py.py {build,test,import}`,
`guard_runtime_rs.py {build,test,clippy}`) which resolve uv/rustup to explicit
versions. No bare `python`/`cargo` executes anywhere in this gate.

RED until the Node client, the CLI, and both cross-language runtimes satisfy
their criteria. Exit == harness failure count (0 ⇔ green).
"""
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
RUN_AUDIT = SCRIPT_DIR / "run-audit.js"
PHASES = "runtime"


def main() -> int:
    if not RUN_AUDIT.exists():
        sys.stderr.write(f"guard_audit_runtime: FATAL — missing {RUN_AUDIT}\n")
        return 2
    cmd = ["node", str(RUN_AUDIT), "--phase", PHASES]
    sys.stderr.write(f"guard_audit_runtime: {' '.join(cmd)} (cwd={REPO_ROOT})\n")
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_audit_runtime: RED — {proc.returncode} runtime-wave "
            "criterion(s) failed (Node/CLI/Python/Rust; see [id] FAIL markers).\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
