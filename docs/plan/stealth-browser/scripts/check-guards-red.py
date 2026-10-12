#!/usr/bin/env python3
"""Prove the guards of every state authored or reshaped by the amendment are RED before any work exists (a guard that is green on an empty tree proves nothing).

Two layers: (1) every non-ownership criterion of the amended states (derived from `guard.py --list`), one by one, plus the file-evidence criteria of the cutover, `surface-api.10` and `gates-first.7-8`; (2) the whole-state guard (`guard.py <state>`, the unit the orchestrator runs) of each amended work state must exit non-zero.
Skipped by design: the cutover as a whole state (its build and live MCP checks run pnpm and a probe in the scratch repo), `agent-search-relink` as a whole state, and commit-ownership criteria, which are vacuously green until a [psm:<slug>] commit exists, like every <state>.ownership criterion.
Each run requires a non-zero exit and no `check crashed` (a crash is a broken guard, not a red one). Safe to run repeatedly: no network, no pnpm.

exit 0: every criterion is red and none crashed.  exit 1: a criterion is green early or crashed (each printed).
usage: python3 docs/plan/stealth-browser/scripts/check-guards-red.py
"""
import json
import re
import subprocess
import sys

TOP = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
GUARD = f"{TOP}/docs/plan/stealth-browser/scripts/guard.py"
LIST = json.loads(subprocess.run([sys.executable, GUARD, "--list"], capture_output=True, text=True, cwd=TOP).stdout)
# States authored or reshaped by the amendment: every non-ownership criterion must be red on an untouched tree.
NEW_STATES = ["failsafe-inventory", "port-fixes", "cdp-test-harness", "capture-upgrade", "chrome-lifecycle", "prod-errors", "prod-examples", "tests-use-cases", "audit-pre-review", "audit-fixes", "agent-search-relink"]
# commit-ownership criteria are vacuously green until a [psm:<slug>] commit exists, like every <state>.ownership criterion
OWNERSHIP = re.compile(r"owned paths|ownership|changed no source|touch only|local-only, staged", re.I)
FOLDED = {s: [int(i.rsplit(".", 1)[1]) for i, doc in LIST[s] if not OWNERSHIP.search(doc)] for s in NEW_STATES}
FOLDED["agent-search-cutover"] = [1, 2, 8, 9]  # file-evidence checks only; the build/MCP checks run pnpm and a live probe in the scratch repo
FOLDED["gates-first"] = [7, 8, 10]
FOLDED["review-prep"] = [5]
FOLDED["audit-final"] = [4, 12]
FOLDED["tests-unit-core"] = [6]
FOLDED["tests-unit-data"] = [6]
FOLDED["tests-unit-extract"] = [6]
FOLDED["tests-unit-surface"] = [6]
FOLDED["surface-api"] = [10, 11]
FOLDED["surface-hosts"] = [14]
STATES = [s for s in NEW_STATES if s != "agent-search-relink"] + ["surface-api"]
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
for slug in STATES:
    n += 1
    try:
        r = subprocess.run([sys.executable, GUARD, slug], capture_output=True, text=True, timeout=1800, cwd=TOP)
    except subprocess.TimeoutExpired:
        problems.append(f"state {slug}: timed out")
        continue
    out = r.stdout + r.stderr
    if "check crashed" in out:
        problems.append(f"state {slug}: guard crashed: {out[out.index('check crashed'):][:160]}")
    elif r.returncode == 0:
        problems.append(f"state {slug}: whole-state guard GREEN before any work")
    else:
        print(f"red   state {slug} (exit {r.returncode})")
if problems:
    print("\n".join(problems))
    print(f"FAIL: {len(problems)} problem(s) across {n} guards")
    sys.exit(1)
print(f"OK: {n} guards (folded criteria + whole states), all red before work, none crashed")
