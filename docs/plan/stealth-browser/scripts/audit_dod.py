#!/usr/bin/env python3
"""audit_dod.py - Definition-of-Done runner for the stealth-browser plan.

Every [dod.N] clause in README.md has exactly one check() here. A clause is
CONFIRMED only by the `[dod.N] PASS` line this script prints. The audit-final
guard (guard.py audit-final) and the search-cutover guard print the same
lines for their phase, so the orchestrator can confirm from either entrypoint.

usage: python3 docs/plan/stealth-browser/scripts/audit_dod.py [--phase final|cutover|pre-review|all]
exit status: number of failed checks.
"""
import argparse
import subprocess
import sys

G = "python3 docs/plan/stealth-browser/scripts/guard.py"
NX = "./node_modules/.bin/nx"
fails = []


def check(clause, description, cmd, phase="final", also=()):
    """`phase` is the primary phase; `also` lists further phases that run the same clause (pre-review runs the clauses available before the gates)."""
    if ARGS.phase not in ("all", phase, *also):
        return
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    ok = r.returncode == 0
    print(f"[{clause}] {'PASS' if ok else 'FAIL'} {description}")
    if not ok:
        fails.append(clause)
        print((r.stdout + r.stderr)[-400:])


ap = argparse.ArgumentParser()
ap.add_argument("--phase", default="all", choices=["final", "cutover", "pre-review", "all"])
ARGS = ap.parse_args()

# tier 3 for behavioral clauses: each drives the clause's declared entrypoint and asserts its observable.
check("dod.1", "three generator-built packages (stealth-core-browser, stealth-search, resilience-core-tripwire), sibling-structure parity",
      f"{G} audit-final --only audit-final.1 | grep -q PASS")
check("dod.2", "use-case unit suites (library scenarios in the core, CLI and MCP scenarios in the search entrypoint, against the in-process fake CDP server) pass",
      f"{NX} run stealth-core-browser:test -- test/unit/use-cases && {NX} run stealth-search:test -- test/unit/use-cases && {G} tests-use-cases | grep -q PASS && {G} search-usecases | grep -q PASS", also=("pre-review",))
check("dod.3", "tracing namespace is adhd, never apigen (configuration pins + the validating agent's read of the logs written by the built CLI and MCP hosts)",
      f"{G} audit-final --only audit-final.3 | grep -q PASS", also=("pre-review",))
check("dod.4", "behavior-preserving port (exports, similarity, tokens)",
      f"{G} audit-final --only audit-final.4 | grep -q PASS", also=("pre-review",))
check("dod.5", "agent-search source untouched up to the first cutover commit",
      f"{G} audit-final --only audit-final.5 | grep -q PASS", also=("pre-review",))
check("dod.6", "one blind review, one implementer, gates re-run green",
      f"{G} audit-final --only audit-final.6 | grep -q PASS")
check("dod.7", "docs marketing run PASS and receipts-backed README",
      f"{G} audit-final --only audit-final.7 | grep -q PASS")
check("dod.8", "branch committed, main node_modules untouched",
      f"{G} audit-final --only audit-final.8 | grep -q PASS")
check("dod.9", "agent-search runs on the stealth-search entrypoint (cutover proof) and every consumer is relinked after publication",
      "python3 docs/plan/stealth-browser/scripts/guard.py search-cutover | grep -q PASS && ! python3 docs/plan/stealth-browser/scripts/guard.py search-cutover | grep -q FAIL", phase="cutover")

sys.exit(len(fails))
