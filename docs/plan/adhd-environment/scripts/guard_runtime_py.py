#!/usr/bin/env python3
"""guard_runtime_py.py — environment-pinned guard for the `runtime-py` state.

Replaces the bare, ambient-PATH guard `python -m build`. On this machine a bare
`python`/`python3` resolves to miniconda base (3.13.11), so the original guard's
toolchain was nondeterministic between the executor's shell and a clean
subprocess (see BACKLOG ENV-PLAN-002 / ENV-PLAN-005).

This guard resolves an EXPLICIT, pinned interpreter via `uv` (0.11.7) and builds
the `environment-core-py` distribution with `uv run --python 3.10 -m build`,
matching the package's declared `requires-python = ">=3.10"`. It FAILS LOUDLY
(non-zero exit + stderr) when `uv` is absent — never a silent skip.

Contract: RED (non-zero) until `runtime-py` implements the package
(`src/adhd_environment/{__init__,environment}.py`) and it builds cleanly; GREEN
(zero) afterwards. Being a repo-owned `python3 …​.py` invocation, the guard STRING
is recognised as environment-pinned by the plan-state-machine env-pin heuristic.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Repo root = four levels up from docs/plan/adhd-environment/scripts/<this>.
REPO_ROOT = Path(__file__).resolve().parents[4]
PKG_DIR = REPO_ROOT / "packages" / "environment" / "environment-core-py"
PIN_PYTHON = "3.10"


def resolve_uv() -> str:
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv"
    if not Path(uv).exists():
        sys.stderr.write(
            "guard_runtime_py: FATAL — `uv` toolchain not found on PATH nor at "
            "/opt/homebrew/bin/uv. Install uv (brew install uv) so the Python "
            "runtime guard can pin its interpreter. Refusing to run against an "
            "ambient/miniconda `python` (nondeterministic).\n"
        )
        sys.exit(2)
    return uv


def main() -> int:
    if not PKG_DIR.is_dir():
        sys.stderr.write(f"guard_runtime_py: FATAL — package dir missing: {PKG_DIR}\n")
        return 2
    uv = resolve_uv()
    cmd = [uv, "run", "--python", PIN_PYTHON, "-m", "build"]
    sys.stderr.write(f"guard_runtime_py: running {' '.join(cmd)} in {PKG_DIR}\n")
    proc = subprocess.run(cmd, cwd=str(PKG_DIR))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_runtime_py: RED — `uv run --python {PIN_PYTHON} -m build` "
            f"exited {proc.returncode}. The environment-core-py distribution does "
            "not build yet.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
