#!/usr/bin/env python3
"""guard_scaffold_workspace.py — environment-pinned guard for `scaffold-workspace`.

Replaces the bare shell guard
    test -f packages/environment/environment-base-spec/package.json \
      && test -f entrypoint/environment-cli/package.json
which, while functionally deterministic, carries no env-pin marker and so trips
`env-pin-check --strict` (BACKLOG ENV-PLAN-002). Expressing it as a repo-owned
python guard makes the STRING env-pinned AND lets the assertion resolve paths
relative to the repo root regardless of the caller's cwd.

`scaffold-workspace` is already `complete`; this guard exists so a re-run is
deterministic (GREEN once the 6-package family + CLI package manifests exist).
It asserts the two canonical scaffold manifests are present and FAILS LOUDLY
(non-zero + stderr) if either is missing.
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
REQUIRED = [
    REPO_ROOT / "packages" / "environment" / "environment-base-spec" / "package.json",
    REPO_ROOT / "entrypoint" / "environment-cli" / "package.json",
]


def main() -> int:
    missing = [str(p) for p in REQUIRED if not p.is_file()]
    if missing:
        sys.stderr.write(
            "guard_scaffold_workspace: RED — required scaffold manifest(s) missing:\n  "
            + "\n  ".join(missing)
            + "\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
