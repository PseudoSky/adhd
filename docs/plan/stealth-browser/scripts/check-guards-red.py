#!/usr/bin/env python3
"""Prove the guards of every state authored or reshaped by the amendment are RED before any work exists (a guard that is green on an empty tree proves nothing).

Two layers: (1) every non-ownership criterion of the amended states (derived from `guard.py --list`), one by one, plus the file-evidence criteria of the cutover, `surface-api.10` and `gates-first.7-8`; (2) the whole-state guard (`guard.py <state>`, the unit the orchestrator runs) of each amended work state must exit non-zero.
Only states that are still `pending` in state.json are proven (a state that is in progress or complete has legitimately started or finished its work, so a baseline red-proof cannot hold for it).
Skipped by design: `search-cutover` and `consumer-relink` as whole states (their checks touch the scratch and consumer repos), `core-scaffold` as a whole state and its criterion .8 (the completed-state regression sweep runs nx builds), and commit-ownership criteria, which are vacuously green until a [psm:<slug>] commit exists, like every <state>.ownership criterion.
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
NEW_STATES = ["failsafe-inventory", "port-fixes", "cdp-test-harness", "capture-upgrade", "chrome-lifecycle", "prod-errors", "prod-examples", "tests-use-cases", "audit-pre-review", "audit-fixes", "consumer-relink",
              "sp-reaper-load-proof", "sp-link", "sp-reaper-smoke", "sp-switch",
              "tripwire-scaffold", "tripwire-core", "tripwire-interactive", "tripwire-docs", "tripwire-pack", "tripwire-reverse-migrate", "tripwire-reverse-relink",
              # the split amendment: generator-built core library, the search entrypoint and its states
              "core-scaffold", "core-seam", "search-scaffold", "search-inventory", "search-errors", "search-port-providers", "search-port-fetch", "search-port-engine", "search-port-guards",
              "search-verbs", "search-tracing", "search-hosts", "search-usecases", "search-examples", "tracing-log-validation", "search-cutover",
              # the 2026-10-23 main-sync amendment
              "main-merge", "conform-tripwire", "conform-core", "conform-search", "fix-tripwire", "fix-core-parsers", "fix-core-lifecycle", "fix-core-errors", "fix-search-fetch", "fix-search-engine", "fix-search-output", "search-mcp-iserror", "fix-search-build", "search-tracing-fixes", "plan-notes", "release-readiness", "release-gate-fixes"]
# commit-ownership criteria are vacuously green until a [psm:<slug>] commit exists, like every <state>.ownership criterion
OWNERSHIP = re.compile(r"owned paths|ownership|changed no source|touch only|local-only, staged", re.I)
FOLDED = {s: [int(i.rsplit(".", 1)[1]) for i, doc in LIST[s] if not OWNERSHIP.search(doc)] for s in NEW_STATES}
FOLDED["core-scaffold"] = [i for i in FOLDED["core-scaffold"] if i != 8]  # .8 is the regression sweep over the completed states' guards (runs nx builds)
FOLDED["gates-first"] = [7, 8, 10, 12]
FOLDED["review-prep"] = [5]
FOLDED["audit-final"] = [4, 12, 13]
FOLDED["merge-readiness"] = [5, 6]
FOLDED["gates-rerun"] = [7]
FOLDED["tests-unit-core"] = [6]
FOLDED["tests-unit-data"] = [6]
FOLDED["tests-unit-extract"] = [6]
FOLDED["tests-unit-surface"] = [6]
FOLDED["surface-api"] = [10, 11]
STATES = [s for s in NEW_STATES if s not in ("consumer-relink", "search-cutover", "core-scaffold")] + ["surface-api"]  # whole-state guards of the cutover/relink touch other repos; core-scaffold's runs the completed-state sweep
_st = json.load(open(f"{TOP}/docs/plan/stealth-browser/state.json")).get("states", {})
PENDING = {k for k, v in _st.items() if v.get("status") == "pending"}
SKIPPED = sorted(k for k in set(FOLDED) | set(STATES) if k not in PENDING)
FOLDED = {k: v for k, v in FOLDED.items() if k in PENDING or k not in _st}
STATES = [k for k in STATES if k in PENDING or k not in _st]
print("skipped (not pending in state.json): " + ", ".join(SKIPPED))
# Inventory-fully-pinned criteria guard a standing invariant ([inv:no-features-removed]): they are green once the inventories are pinned, which the guard sweep did ahead of the audit states.
REGRESSION_GUARDS = {"audit-fixes.6", "review-prep.5", "audit-final.4", "audit-final.12"}
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
        elif r.returncode == 0 and cid in REGRESSION_GUARDS:
            print(f"green {cid} (regression guard: the failsafe inventories are fully pinned since the guard-sweep fix; the criterion stays binding)")
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
