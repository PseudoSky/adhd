# code-review — STATE_NAME

**Phase:** audit · **Kind:** review · **Depends on:** removal-runbook · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/review_gate.py`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src"]
mutates:    ["docs/plan/agent-registry-migration/review.md", "docs/plan/agent-registry-migration/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: code-reviewer (opus). Diff-reading code review of the implementation states (migration-design..removal-runbook) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: the import pipeline drives the REAL registry stores (not mocks); the round-trip equivalence gate actually blocks removal; the removal-runbook is gated on an all-PASS equivalence report (forcing function); cross-repo claude-agents removal is a gated step; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py.
