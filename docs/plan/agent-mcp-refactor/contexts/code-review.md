# code-review — STATE_NAME

**Phase:** audit · **Kind:** review · **Depends on:** session-e2e · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/review_gate.py`

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
read_only:  ["packages/ai/agent-mcp/src"]
mutates:    ["docs/plan/agent-mcp-refactor/review.md", "docs/plan/agent-mcp-refactor/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus) — this plan is an architectural refactor (retire AgentStore, route systemPrompt through compileAgent). Diff-reading review of the full implementation (refactor-design..session-e2e) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc, the 'Proving features actually work' verification standard) AND decisions.md/contracts. Must check design-intent fidelity the structural audit misses: AgentStore retirement leaves NO competing source of truth; systemPrompt is a computed compat shim per the recorded policy; composed_prompt cache + sessions FK match the decided session topology; PolicyEngine reads agent-policy templates; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py. (A mid-plan review, code-review-integration, gates the integration/retire core before audit-integration.)
