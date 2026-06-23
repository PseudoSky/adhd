# code-review — STATE_NAME

**Phase:** audit · **Kind:** review · **Depends on:** compile-fixtures-e2e · **Guard:** `python3 docs/plan/agent-compiler/scripts/review_gate.py`

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
read_only:  []
mutates:    ["docs/plan/agent-compiler/review.md", "docs/plan/agent-compiler/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus) — this plan produces an architectural artifact (the composition engine). Diff-reading review of the full implementation (compiler-design..compile-fixtures-e2e) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: cross-package joins honor the decided single-DB topology; composition-order resolution matches the recorded context-condition precedence; the per-platform header builder matches the decided contract; composed_prompts caching keys on the right context hash; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py. (A mid-plan review, code-review-engine, gates the composition-engine core before the emit phase.)
