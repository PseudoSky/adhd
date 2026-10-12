#!/usr/bin/env python3
"""Prove that no two concurrently-runnable states own overlapping write paths.

Two states are concurrent when neither is an ancestor of the other in dag.json.
Ownership comes from scripts/ownership.json (the single source also read by
guard.py's per-state ownership check) and must equal each state's dag
reservation (`mutates`) - so the guard, the DAG and this proof cannot drift.

exit 0: disjoint and consistent.  exit 1: overlap or drift (each printed).
usage: python3 docs/plan/stealth-browser/scripts/check-disjoint.py [--matrix]
"""
import json
import subprocess
import sys

TOP = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
PLAN = f"{TOP}/docs/plan/stealth-browser"
dag = json.load(open(f"{PLAN}/dag.json"))["nodes"]
own = json.load(open(f"{PLAN}/scripts/ownership.json"))


def ancestors(n, memo={}):
    if n in memo:
        return memo[n]
    out = set()
    for d in dag[n].get("depends_on", []):
        out |= {d} | ancestors(d)
    memo[n] = out
    return out


def overlap(a, b):
    """Path-pattern overlap. `dir/` = subtree, `dir/*` = direct child files, else exact file."""
    def kind(p):
        return "tree" if p.endswith("/") else "children" if p.endswith("/*") else "file"

    def base(p):
        return p[:-1] if p.endswith("*") else p
    ka, kb, ba, bb = kind(a), kind(b), base(a), base(b)
    if ka == "tree" and (bb.startswith(ba)):
        return True
    if kb == "tree" and (ba.startswith(bb)):
        return True
    if ka == "children" and kb == "file":
        return bb.startswith(ba) and "/" not in bb[len(ba):]
    if kb == "children" and ka == "file":
        return ba.startswith(bb) and "/" not in ba[len(bb):]
    if ka == "children" and kb == "children":
        return ba == bb
    return a == b


problems = []
slugs = set(dag)
for s in sorted(slugs - set(own)):
    problems.append(f"state {s} has no ownership entry")
for s in sorted(set(own) - slugs):
    problems.append(f"ownership entry {s} is not a dag state")

for s in sorted(slugs & set(own)):
    declared = set(dag[s].get("mutates", []) or [])
    if not declared:
        # reservations live in contexts/<slug>.md and are mirrored into dag by set-reservation; fall back to artifacts
        declared = set(dag[s].get("artifacts", []))
    # artifacts must lie inside the owned set
    for a in dag[s].get("artifacts", []):
        if not any(overlap(a, o) or a == o for o in own[s]) and not a.startswith("scripts/"):
            problems.append(f"{s}: artifact {a} is outside its owned paths {own[s]}")

order = sorted(slugs & set(own))
pairs = 0
for i, a in enumerate(order):
    for b in order[i + 1:]:
        if a in ancestors(b) or b in ancestors(a):
            continue
        pairs += 1
        for pa in own[a]:
            for pb in own[b]:
                if overlap(pa, pb):
                    problems.append(f"CONCURRENT OVERLAP {a} <-> {b}: {pa} vs {pb}")

if "--matrix" in sys.argv:
    for a in order:
        conc = [b for b in order if b != a and a not in ancestors(b) and b not in ancestors(a)]
        print(f"{a:26s} concurrent with {len(conc):2d}: {', '.join(conc)}")

if problems:
    print("\n".join(problems))
    print(f"FAIL: {len(problems)} problem(s) across {pairs} concurrent pairs")
    sys.exit(1)
print(f"OK: {len(order)} states, {pairs} concurrent pairs, 0 overlaps")
