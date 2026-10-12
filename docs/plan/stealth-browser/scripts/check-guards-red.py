#!/usr/bin/env python3
"""Prove the productization-fold guards are RED before any work exists (a guard that is green on an empty tree proves nothing).

Runs `guard.py <state> --only <id>` for every criterion added by the productization fold (PRODUCT-REVIEW.md) and
requires: non-zero exit, and no `check crashed` (a crash is a broken guard, not a red one).
Pass `--all` to also run the pre-existing states' first criteria. Safe to run repeatedly: no network, no pnpm,
nx build-bin only against a package that does not exist yet.

exit 0: every folded criterion is red and none crashed.  exit 1: a criterion is green early or crashed (each printed).
usage: python3 docs/plan/stealth-browser/scripts/check-guards-red.py
"""
import json
import subprocess
import sys

TOP = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
GUARD = f"{TOP}/docs/plan/stealth-browser/scripts/guard.py"
FOLDED = {
    "surface-api": [7, 8, 9],
    "prod-public-api": [1, 2, 3, 4, 5],
    "prod-errors": [1, 2, 3],
    "surface-hosts": [7, 8, 9, 10, 11, 12, 13],
    "tracing-plugin": [7, 8],
    "tracing-namespace-proof": [6],
    "prod-examples": [1, 2, 3, 4, 5],
    "tests-unit-surface": [4],
    "tests-e2e": [6, 7],
    "docs-marketing-run": [6, 7, 8, 9],
    "readme-rewrite": [6, 7, 8],
    "prod-publish-readiness": [1, 2, 3, 4, 5],  # .6 is the ownership check: vacuously green until commits exist (same as every <state>.ownership criterion)
    "merge-readiness": [4],
    "agent-search-cutover": [6, 7],
}
problems, n = [], 0
for slug, ids in FOLDED.items():
    for i in ids:
        cid = f"{slug}.{i}"
        n += 1
        try:
            r = subprocess.run([sys.executable, GUARD, slug, "--only", cid], capture_output=True, text=True, timeout=900, cwd=TOP)
        except subprocess.TimeoutExpired:
            problems.append(f"{cid}: timed out")
            continue
        out = r.stdout + r.stderr
        if "check crashed" in out:
            problems.append(f"{cid}: guard crashed: {out.strip()[-160:]}")
        elif r.returncode == 0:
            problems.append(f"{cid}: GREEN before any work (exit 0)")
        else:
            print(f"red   {cid} (exit {r.returncode})")
if problems:
    print("\n".join(problems))
    print(f"FAIL: {len(problems)} problem(s) across {n} folded criteria")
    sys.exit(1)
print(f"OK: {n} folded criteria, all red before work, none crashed")
