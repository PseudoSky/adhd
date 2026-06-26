# code-review — FINAL DIFF REVIEW: DESIGN-INTENT FIDELITY THE AUDIT CAN'T CATCH

**Phase:** audit · **Kind:** review · **Depends on:** session-e2e · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/review_gate.py`

---

## Goal

The full refactor diff (`refactor-design` … `session-e2e`) has been read by an
architect-reviewer (opus) and recorded an APPROVED verdict in `review.md` with no
unresolved blocking findings. This is the second of two review gates (the first,
`code-review-integration`, gated the integration/retire core before
`audit-integration`). It catches design-intent violations a structural
`audit_*.py` oracle cannot — e.g. an AgentStore retirement that leaves a competing
source of truth, a `systemPrompt` compat-shim that diverges from the recorded
policy, or a `composed_prompt`/`sessions` FK that does not match the decided
session topology. `audit-final` depends on this state, so the plan cannot reach
done on a NEEDS-WORK or absent review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review.1] review.md records an APPROVED verdict with no unresolved blocking findings (architect-reviewer diff review vs CLAUDE.md + decisions.md; design-intent fidelity: AgentStore retired with no competing source of truth, systemPrompt is a compat shim, session/cache FKs match decided topology, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src"]
mutates:    ["docs/plan/agent-mcp-refactor/review.md", "docs/plan/agent-mcp-refactor/scripts/review_gate.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus) — this plan is an architectural refactor (retire AgentStore, route systemPrompt through compileAgent). Diff-reading review of the full implementation (refactor-design..session-e2e) against CLAUDE.md (layer/platform isolation, @adhd/ imports, I-prefixed interfaces, JSDoc, the 'Proving features actually work' verification standard) AND decisions.md/contracts. Must check design-intent fidelity the structural audit misses: AgentStore retirement leaves NO competing source of truth; systemPrompt is a computed compat shim per the recorded policy; composed_prompt cache + sessions FK match the decided session topology; PolicyEngine reads agent-policy templates; no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the implementation states, then re-review. Mutates only review.md + scripts/review_gate.py. (A mid-plan review, code-review-integration, gates the integration/retire core before audit-integration.)
