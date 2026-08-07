#!/usr/bin/env python3
"""
review_gate_engine.py — MID-PLAN code-review gate for the agent-compiler plan.

Guards the `code-review-engine` state, positioned at the resolve→emit phase
boundary so the composition-engine core (composition-resolve, tool-header-emit,
model-and-policy-emit) is reviewed before the platform emitters/CLI/cache build
on top of it. Passes ONLY when the plan dir contains a `review-engine.md` whose
machine-checkable verdict line is APPROVED and which records no UNRESOLVED
blocking findings. An architect-reviewer (opus) authors `review-engine.md`
against this project's CLAUDE.md standards and the plan's decisions.md/contracts
— catching design-intent violations the structural audit_*.py oracle cannot
(e.g. a cross-package join that violates the decided single-DB topology, a
composition-order resolution that diverges from the recorded precedence
contract, or a per-platform header builder that does not match the decided
contract).

Usage:
  python3 docs/plan/agent-compiler/scripts/review_gate_engine.py

Contract for review-engine.md (authored by the reviewer, NEVER by the implementer):
  - Exactly one verdict line matching `^VERDICT:\\s*(APPROVED|NEEDS-WORK)`.
  - Default posture is NEEDS-WORK; an APPROVED verdict must be explicitly
    justified in the prose above it.
  - Blocking findings are recorded as lines beginning `BLOCKING:`. Each must be
    resolved before APPROVED — a resolved finding is struck by appending
    ` [RESOLVED]` (case-insensitive) on the same line. Any `BLOCKING:` line
    without a `[RESOLVED]` marker keeps the gate red even if VERDICT says
    APPROVED (fail-closed: a stray verdict line cannot override an open blocker).

Exit 0  → review-engine.md exists, VERDICT: APPROVED, zero unresolved blockers.
Exit 1  → review-engine.md missing, NEEDS-WORK/absent verdict, or open blocker.

Env-pinned (`python3 … .py`) and exit-code gated — never emits a `passed` marker
for a caller to grep, so noisy output cannot inject a false PASS.
"""

import os
import re
import sys

# scripts/ -> plan dir is the parent directory.
PLAN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REVIEW = os.path.join(PLAN_DIR, "review-engine.md")

VERDICT_RE = re.compile(r"^VERDICT:\s*APPROVED\s*$", re.MULTILINE)
ANY_VERDICT_RE = re.compile(r"^VERDICT:\s*(\S+)", re.MULTILINE)
BLOCKING_RE = re.compile(r"^BLOCKING:", re.IGNORECASE)
RESOLVED_RE = re.compile(r"\[RESOLVED\]", re.IGNORECASE)


def main() -> int:
    if not os.path.isfile(REVIEW):
        print(f"review-gate(engine): FAIL — no review-engine.md at {REVIEW}", file=sys.stderr)
        print("  the code-review-engine state must produce review-engine.md "
              "before this gate can pass.", file=sys.stderr)
        return 1

    with open(REVIEW, "r", encoding="utf-8") as fh:
        text = fh.read()

    unresolved = [
        ln for ln in text.splitlines()
        if BLOCKING_RE.match(ln.strip()) and not RESOLVED_RE.search(ln)
    ]
    if unresolved:
        print("review-gate(engine): FAIL — review-engine.md has unresolved "
              "blocking finding(s):", file=sys.stderr)
        for ln in unresolved:
            print(f"  {ln.strip()}", file=sys.stderr)
        return 1

    if not VERDICT_RE.search(text):
        found = ANY_VERDICT_RE.search(text)
        got = found.group(1) if found else "<no VERDICT line>"
        print(f"review-gate(engine): FAIL — verdict is '{got}', expected APPROVED.",
              file=sys.stderr)
        print("  default posture is NEEDS-WORK; an APPROVED verdict must be "
              "explicitly justified by the reviewer.", file=sys.stderr)
        return 1

    print("review-gate(engine): review-engine.md records VERDICT: APPROVED with "
          "no unresolved blocking findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
