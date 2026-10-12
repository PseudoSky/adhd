#!/usr/bin/env python3
"""audit_dod.py - Definition-of-Done runner for the stealth-browser plan.

Every [dod.N] clause in README.md has exactly one check() here. A clause is
CONFIRMED only by the `[dod.N] PASS` line this script prints. The audit-final
guard (guard.py audit-final) and the agent-search-cutover guard print the same
lines for their phase, so the orchestrator can confirm from either entrypoint.

usage: python3 docs/plan/stealth-browser/scripts/audit_dod.py [--phase final|cutover|all]
exit status: number of failed checks.
"""
import argparse
import subprocess
import sys

G = "python3 docs/plan/stealth-browser/scripts/guard.py"
NX = "./node_modules/.bin/nx"
fails = []


def check(clause, description, cmd, phase="final"):
    if ARGS.phase not in ("all", phase):
        return
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    ok = r.returncode == 0
    print(f"[{clause}] {'PASS' if ok else 'FAIL'} {description}")
    if not ok:
        fails.append(clause)
        print((r.stdout + r.stderr)[-400:])


ap = argparse.ArgumentParser()
ap.add_argument("--phase", default="all", choices=["final", "cutover", "all"])
ARGS = ap.parse_args()

# tier 3 for behavioral clauses: each drives the clause's declared entrypoint and asserts its observable.
check("dod.1", "one generator-built package, sibling-structure parity",
      f"{G} audit-final --only audit-final.1 | grep -q PASS")
check("dod.2", "six verbs work from library, CLI and MCP against a real Chrome (e2e)",
      f"{NX} run stealth-browser:e2e && {G} tests-e2e --only tests-e2e.2 | grep -q PASS")
check("dod.3", "tracing namespace is adhd, never apigen (spec + mutation)",
      f"{NX} run stealth-browser:test -- entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts && {G} tracing-namespace-proof --only tracing-namespace-proof.4 | grep -q PASS")
check("dod.4", "behavior-preserving port (exports, similarity, tokens)",
      f"{G} audit-final --only audit-final.4 | grep -q PASS")
check("dod.5", "agent-search source untouched until cutover",
      f"{G} audit-final --only audit-final.5 | grep -q PASS")
check("dod.6", "one blind review, one implementer, gates re-run green",
      f"{G} audit-final --only audit-final.6 | grep -q PASS")
check("dod.7", "docs marketing run PASS and receipts-backed README",
      f"{G} audit-final --only audit-final.7 | grep -q PASS")
check("dod.8", "branch committed, main node_modules untouched",
      f"{G} audit-final --only audit-final.8 | grep -q PASS")
check("dod.9", "live agent-search MCP still serves chrome_status and list_providers",
      "python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover | grep -q PASS && ! python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover | grep -q FAIL", phase="cutover")

sys.exit(len(fails))
