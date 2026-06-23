# code-review — STATE_NAME

**Phase:** audit · **Kind:** review · **Depends on:** seed-and-roundtrip · **Guard:** `python3 docs/plan/agent-tool-registry/scripts/review_gate.py`

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
read_only:  ["packages/ai/agent-tool-registry/src"]
mutates:    ["docs/plan/agent-tool-registry/review.md", "docs/plan/agent-tool-registry/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: code-reviewer (opus). Diff-reading code review of the implementation states (scaffold-package..seed-and-roundtrip) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc on shared public fns, the 'Proving features actually work' verification standard) AND this plan's decisions/contracts. Must check design-intent fidelity the structural audit misses: composite keys are real primaryKey()/uniqueIndex() not a non-unique index(); FKs match the decided topology; tool_types stays a lookup table; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py.
