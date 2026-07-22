# code-review — FINAL DIFF REVIEW: DESIGN-INTENT FIDELITY THE AUDIT CAN'T CATCH

**Phase:** audit · **Kind:** review · **Depends on:** compile-fixtures-e2e · **Guard:** `python3 docs/plan/agent-compiler/scripts/review_gate.py`

---

## Goal

The full implementation diff (`compiler-design` … `compile-fixtures-e2e`) has been
read by an architect-reviewer (opus) and recorded an APPROVED verdict in
`review.md` with no unresolved blocking findings. This is the second of two review
gates (the first, `code-review-engine`, gated the composition-engine core at the
resolve→emit boundary). It catches design-intent violations a structural
`audit_*.py` oracle cannot — e.g. a cross-package join that violates the decided
single-DB topology, a `composed_prompts` cache keyed on the wrong context hash, or
a per-platform header builder that diverges from the decided contract. `audit-final`
depends on this state, so the plan cannot reach done on a NEEDS-WORK or absent
review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review.1] review.md records an APPROVED verdict with no unresolved blocking findings (architect-reviewer diff review vs CLAUDE.md + decisions.md; design-intent fidelity: single-DB cross-package join topology, composition-order precedence, per-platform header contract, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src"]
mutates:    ["docs/plan/agent-compiler/review.md", "docs/plan/agent-compiler/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus) — this plan produces an architectural artifact (the composition engine). Diff-reading review of the full implementation (compiler-design..compile-fixtures-e2e) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: cross-package joins honor the decided single-DB topology; composition-order resolution matches the recorded context-condition precedence; the per-platform header builder matches the decided contract; composed_prompts caching keys on the right context hash; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py. (A mid-plan review, code-review-engine, gates the composition-engine core before the emit phase.)
