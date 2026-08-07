#!/usr/bin/env python3
"""guard_runtime_py.py — environment-pinned guard for the Python runtime.

Replaces bare, ambient-PATH `python -m build` / `python -m pytest`. On this
machine a bare `python`/`python3` resolves to miniconda base (3.13.11), so the
toolchain was nondeterministic between the executor's shell and a clean
subprocess (see BACKLOG ENV-PLAN-002 / ENV-PLAN-005). This guard resolves an
EXPLICIT, pinned interpreter via `uv` (>=0.11.7) and runs against
`requires-python = ">=3.10"`, matching the package's declared floor. It FAILS
LOUDLY (non-zero + stderr) when `uv` is absent — never a silent skip.

Modes (positional arg; default `build` so the pre-existing no-arg dag guard for
the `runtime-py` state is byte-for-byte unchanged):
    build   uv build --python 3.10                        (dist builds; native uv frontend)
    test    uv run --python 3.10 -m pytest tests/ -q        (F13 pinned pytest)
    import  uv run --python 3.10 python -c "<import smoke>" (F8 pinned import)

Every leg resolves its interpreter through the pinned uv toolchain, so this
guard is INDEPENDENTLY pinned wherever it is invoked (a dag guard string OR a
criteria.json `cmd`). It is the sanctioned replacement for any bare
`python`/`pytest`/`build` leg an audit gate would otherwise launder past the
substring-based env-pin heuristic (F8). Being a repo-owned `python3 …​.py`
invocation, its guard STRING is recognised as environment-pinned.

Contract: RED (non-zero) until the runtime is implemented and the requested
verb passes; GREEN (zero) afterwards.
"""
import shutil
import subprocess
import sys
from pathlib import Path

# Repo root = four levels up from docs/plan/adhd-environment/scripts/<this>.
REPO_ROOT = Path(__file__).resolve().parents[4]
PKG_DIR = REPO_ROOT / "packages" / "environment" / "environment-core-py"
PIN_PYTHON = "3.10"

IMPORT_SMOKE = (
    "import sys; sys.path.insert(0, 'src'); "
    "from adhd_environment.environment import Environment; "
    "print('import-ok', Environment.__name__)"
)

# mode -> FULL argv appended after `uv`.
# `build` uses uv's NATIVE `uv build` frontend, NOT `uv run -m build`: the latter
# requires the `build` package to be resolvable in the ephemeral env (it is not a
# project dependency) and fails `No module named build` in a cold uv environment
# (BUG-ENV-PY-001). `uv build` needs no such dependency and emits the same dist/.
MODES = {
    "build": ["build", "--python", PIN_PYTHON],
    "test": ["run", "--python", PIN_PYTHON, "-m", "pytest", "tests/", "-q"],
    "import": ["run", "--python", PIN_PYTHON, "python", "-c", IMPORT_SMOKE],
}


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
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    if mode not in MODES:
        sys.stderr.write(
            f"guard_runtime_py: FATAL — unknown mode {mode!r} (want one of: {', '.join(MODES)})\n"
        )
        return 2
    if not PKG_DIR.is_dir():
        sys.stderr.write(f"guard_runtime_py: FATAL — package dir missing: {PKG_DIR}\n")
        return 2
    uv = resolve_uv()
    cmd = [uv, *MODES[mode]]
    sys.stderr.write(f"guard_runtime_py[{mode}]: running {' '.join(cmd)} in {PKG_DIR}\n")
    proc = subprocess.run(cmd, cwd=str(PKG_DIR))
    if proc.returncode != 0:
        sys.stderr.write(
            f"guard_runtime_py[{mode}]: RED — exited {proc.returncode}. The "
            "environment-core-py runtime does not satisfy this verb yet.\n"
        )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
