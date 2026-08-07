#!/usr/bin/env python3
"""
review_gate.py — code-review gate for the agent-mcp-authoring plan (8/9).

Guards the `code-review` state. Passes ONLY when the plan dir contains a
`review.md` whose machine-checkable verdict line is APPROVED and which records
no UNRESOLVED blocking findings. A diff-reading reviewer (architect-reviewer,
opus) authors `review.md` against this project's CLAUDE.md standards and the
plan's own decisions.md/SPEC contracts — catching design-intent violations that
the structural audit_authoring.py oracle cannot.

This plan touches agent-mcp src for the FIRST sanctioned time, so the review
must verify the owner's back-out guarantee specifically:
  - every changed agent-mcp{,-types} src file is enumerated in decisions.md's
    modification manifest (def:agent-mcp-modification-manifest);
  - the 11-tool runtime hot path is unchanged (no new required args; the
    delegation surface a sub-agent sees is still exactly the 11 runtime tools;
    authoring/discovery tools are NOT in the delegation set);
  - `name` is the only identity on the wire — no `slug` leaks through any MCP
    tool schema/output/guide (the translation seam is real, not an alias comment);
  - the enrichment pipeline is deterministic/idempotent (a re-define of identical
    content does not churn the index);
  - `agent_define`/`component_define` are true create-or-replace upserts
    (full-replace of components/tools/policy, version-bumped, idempotent on
    no-change) — not a create/patch dance;
  - the flat `systemPrompt` path is a computed compat shim (mutually exclusive
    with components), not a competing source of truth;
  - layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc, and
    the "Proving features actually work" verification standard all hold.

Usage:
  python3 docs/plan/agent-mcp-authoring/scripts/review_gate.py

Contract for review.md (authored by the reviewer, NEVER by the implementer):
  - Exactly one verdict line matching `^VERDICT:\\s*(APPROVED|NEEDS-WORK)`.
  - Default posture is NEEDS-WORK; an APPROVED verdict must be explicitly
    justified in the prose above it.
  - Blocking findings are recorded as lines beginning `BLOCKING:`. Each must be
    resolved before APPROVED — a resolved finding is struck by appending
    ` [RESOLVED]` (case-insensitive) on the same line. Any `BLOCKING:` line
    without a `[RESOLVED]` marker keeps the gate red even if VERDICT says
    APPROVED (fail-closed).

Exit 0  → review.md exists, VERDICT: APPROVED, zero unresolved blocking findings.
Exit 1  → review.md missing, NEEDS-WORK/absent verdict, or an unresolved blocker.

This guard is env-pinned and gates on the EXIT CODE only.
"""

import os
import re
import sys

PLAN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REVIEW = os.path.join(PLAN_DIR, "review.md")

VERDICT_RE = re.compile(r"^VERDICT:\s*APPROVED\s*$", re.MULTILINE)
ANY_VERDICT_RE = re.compile(r"^VERDICT:\s*(\S+)", re.MULTILINE)
BLOCKING_RE = re.compile(r"^BLOCKING:", re.IGNORECASE)
RESOLVED_RE = re.compile(r"\[RESOLVED\]", re.IGNORECASE)


def main() -> int:
    if not os.path.isfile(REVIEW):
        print(f"review-gate: FAIL — no review.md at {REVIEW}", file=sys.stderr)
        print("  the code-review state must produce review.md before this gate "
              "can pass.", file=sys.stderr)
        return 1

    with open(REVIEW, "r", encoding="utf-8") as fh:
        text = fh.read()

    unresolved = [
        ln for ln in text.splitlines()
        if BLOCKING_RE.match(ln.strip()) and not RESOLVED_RE.search(ln)
    ]
    if unresolved:
        print("review-gate: FAIL — review.md has unresolved blocking finding(s):",
              file=sys.stderr)
        for ln in unresolved:
            print(f"  {ln.strip()}", file=sys.stderr)
        return 1

    if not VERDICT_RE.search(text):
        found = ANY_VERDICT_RE.search(text)
        got = found.group(1) if found else "<no VERDICT line>"
        print(f"review-gate: FAIL — verdict is '{got}', expected APPROVED.",
              file=sys.stderr)
        print("  default posture is NEEDS-WORK; an APPROVED verdict must be "
              "explicitly justified by the reviewer.", file=sys.stderr)
        return 1

    print("review-gate: review.md records VERDICT: APPROVED with no unresolved "
          "blocking findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
