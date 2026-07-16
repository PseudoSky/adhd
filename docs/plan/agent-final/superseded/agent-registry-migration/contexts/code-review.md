# code-review — DIFF REVIEW: DESIGN-INTENT FIDELITY THE AUDIT CAN'T CATCH

**Phase:** audit · **Kind:** review · **Depends on:** removal-runbook · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/review_gate.py`

---

## Goal

The diff of every implementation state (`migration-design` … `removal-runbook`)
has been read by a code-reviewer (opus) and recorded an APPROVED verdict in
`review.md` with no unresolved blocking findings. This gate catches design-intent
violations a structural `audit_*.py` oracle cannot — e.g. an import pipeline that
drives mocks instead of the real registry stores, a round-trip equivalence gate
that does not actually block removal, or a removal step that is not gated on an
all-PASS equivalence report. `audit-final` depends on this state, so the plan
cannot reach done on a NEEDS-WORK or absent review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review.1] review.md records an APPROVED verdict with no unresolved blocking findings (code-reviewer diff review vs CLAUDE.md + decisions.md; design-intent fidelity: import drives real registry stores not mocks, equivalence gate blocks removal, removal gated on all-PASS report, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src"]
mutates:    ["docs/plan/agent-registry-migration/review.md", "docs/plan/agent-registry-migration/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: code-reviewer (opus). Diff-reading code review of the implementation states (migration-design..removal-runbook) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: the import pipeline drives the REAL registry stores (not mocks); the round-trip equivalence gate actually blocks removal; the removal-runbook is gated on an all-PASS equivalence report (forcing function); cross-repo claude-agents removal is a gated step; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py.
