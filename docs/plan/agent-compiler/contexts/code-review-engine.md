# code-review-engine — STATE_NAME

**Phase:** resolve · **Kind:** review · **Depends on:** model-and-policy-emit · **Guard:** `python3 docs/plan/agent-compiler/scripts/review_gate_engine.py`

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
read_only:  ["packages/ai/agent-compiler/src"]
mutates:    ["docs/plan/agent-compiler/review-engine.md", "docs/plan/agent-compiler/scripts/review_gate_engine.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus). MID-PLAN review at the resolve->emit boundary: reviews the composition-engine core (composition-resolve, tool-header-emit, model-and-policy-emit) BEFORE the platform emitters/CLI/cache build on it, so a topology/precedence defect is caught early instead of after e2e. Reviews against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc, verification standard) AND decisions.md/contracts. Must check: cross-package joins honor the decided single-DB topology; composition body-ordering follows the junction order + recorded context-condition precedence; tool/model/policy resolution reads the binding tables (not hard-coded); no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the resolve-phase states, then re-review. Mutates only review-engine.md + scripts/review_gate_engine.py.
