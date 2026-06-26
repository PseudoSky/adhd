# code-review — DIFF REVIEW: DESIGN-INTENT FIDELITY THE AUDIT CAN'T CATCH

**Phase:** audit · **Kind:** review · **Depends on:** seed-and-roundtrip · **Guard:** `python3 docs/plan/agent-tool-registry/scripts/review_gate.py`

---

## Goal

The diff of every implementation state (`scaffold-package` … `seed-and-roundtrip`)
has been read by a human/agent reviewer (routing below) and recorded an APPROVED
verdict in `review.md` with no unresolved blocking findings. This gate catches
design-intent violations a structural `audit_*.py` oracle cannot — e.g. a stated
composite primary key implemented as a non-unique `index()` instead of
`primaryKey()`/`uniqueIndex()`, an FK that does not match the decided topology, or
a cross-package FK violation. The build/grep/test audits answer "does it run"; this
state answers "is it built the way we decided." `audit-final` depends on this state,
so the plan cannot reach done on a NEEDS-WORK or absent review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review.1] review.md records an APPROVED verdict with no unresolved blocking findings (code-reviewer diff review vs CLAUDE.md + decisions.md; design-intent fidelity: composite keys are primaryKey()/uniqueIndex() not non-unique index(), FKs match decided topology, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-tool-registry/src"]
mutates:    ["docs/plan/agent-tool-registry/review.md", "docs/plan/agent-tool-registry/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: code-reviewer (opus). Diff-reading code review of the implementation states (scaffold-package..seed-and-roundtrip) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: composite keys are real primaryKey()/uniqueIndex() not a non-unique index(); FKs match the decided topology; tool_types stays a lookup table; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py.
