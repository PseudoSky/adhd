# code-review-integration — MID-PLAN DIFF REVIEW: INTEGRATION/RETIRE CORE

**Phase:** integration · **Kind:** review · **Depends on:** policy-engine-bridge · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/review_gate_integration.py`

---

## Goal

The integration/retire core diff (`compiler-integration`, `agent-store-retire`,
`policy-engine-bridge`) has been read by an architect-reviewer (opus) just before
`audit-integration` and recorded an APPROVED verdict in `review-integration.md`
with no unresolved blocking findings — BEFORE `session-e2e` and the final gate
build on it. Reviewing the refactor core here catches a source-of-truth or
topology defect early. It checks design-intent fidelity the structural audit
misses: the prompt-resolver imports `compileAgent` and writes `composed_prompt_id`;
AgentStore CRUD is retired/delegated with NO leftover writable agent store;
`systemPrompt` is retained only as a computed compat shim; `PolicyEngine` reads
`agent-policy` templates; claudecli reconciles tactical flags with compiled tools
(no competing third model); no cross-package FK violations. `audit-integration`
depends on this state, so the integration gate cannot pass on a NEEDS-WORK or
absent review.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [code-review-integration.1] review-integration.md records an APPROVED verdict with no unresolved blocking findings (architect-reviewer mid-plan review of the integration/retire core vs CLAUDE.md + decisions.md; AgentStore retired with no competing source of truth, systemPrompt compat shim, session/cache FK topology, no cross-package FK violations)

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src"]
mutates:    ["docs/plan/agent-mcp-refactor/review-integration.md", "docs/plan/agent-mcp-refactor/scripts/review_gate_integration.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus). MID-PLAN review just before audit-integration: reviews the integration/retire core (compiler-integration, agent-store-retire, policy-engine-bridge) so a topology/source-of-truth defect is caught before session-e2e and the final gate. Reviews against CLAUDE.md AND decisions.md/contracts. Must check: prompt-resolver imports compileAgent and writes composed_prompt_id; AgentStore CRUD is retired/delegated with NO leftover writable agent store; systemPrompt retained only as a computed compat shim; PolicyEngine reads agent-policy templates; claudecli reconciles tactical flags with compiled tools (no competing third model); no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the integration/retire states, then re-review. Mutates only review-integration.md + scripts/review_gate_integration.py.
