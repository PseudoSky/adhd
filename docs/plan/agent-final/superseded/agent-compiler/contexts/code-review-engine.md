# code-review-engine — MID-PLAN DIFF REVIEW: COMPOSITION ENGINE CORE

**Phase:** resolve · **Kind:** review · **Depends on:** model-and-policy-emit · **Guard:** `python3 docs/plan/agent-compiler/scripts/review_gate_engine.py`

---

## Goal

The composition-engine core diff (`composition-resolve`, `tool-header-emit`,
`model-and-policy-emit`) has been read by an architect-reviewer (opus) at the
resolve→emit boundary and recorded an APPROVED verdict in `review-engine.md` with
no unresolved blocking findings — BEFORE the platform emitters / CLI / cache
(`platform-markdown-emit` onward) build on top of it. Reviewing the engine here
catches a topology or precedence defect early instead of after the e2e fixtures.
It checks design-intent fidelity the structural audit misses: cross-package joins
honor the decided single-DB topology; composition body-ordering follows the
junction order plus the recorded context-condition precedence; tool/model/policy
resolution reads the binding tables rather than hard-coding; no cross-package FK
violations. `platform-markdown-emit` depends on this state, so the emit phase
cannot start on a NEEDS-WORK or absent review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review-engine.1] review-engine.md records an APPROVED verdict with no unresolved blocking findings (architect-reviewer mid-plan review of the composition engine vs CLAUDE.md + decisions.md; single-DB join topology, composition-order precedence, binding-table resolution, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src"]
mutates:    ["docs/plan/agent-compiler/review-engine.md", "docs/plan/agent-compiler/scripts/review_gate_engine.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus). MID-PLAN review at the resolve->emit boundary: reviews the composition-engine core (composition-resolve, tool-header-emit, model-and-policy-emit) BEFORE the platform emitters/CLI/cache build on it, so a topology/precedence defect is caught early instead of after e2e. Reviews against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc, verification standard) AND decisions.md/contracts. Must check: cross-package joins honor the decided single-DB topology; composition body-ordering follows the junction order + recorded context-condition precedence; tool/model/policy resolution reads the binding tables (not hard-coded); no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the resolve-phase states, then re-review. Mutates only review-engine.md + scripts/review_gate_engine.py.
