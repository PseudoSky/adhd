# code-review-integration — STATE_NAME

**Phase:** integration · **Kind:** review · **Depends on:** policy-engine-bridge · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/review_gate_integration.py`

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
mutates:    ["docs/plan/agent-mcp-refactor/review-integration.md", "docs/plan/agent-mcp-refactor/scripts/review_gate_integration.py"]
```

---

## Notes for executor

Reviewer routing: architect-reviewer (opus). MID-PLAN review just before audit-integration: reviews the integration/retire core (compiler-integration, agent-store-retire, policy-engine-bridge) so a topology/source-of-truth defect is caught before session-e2e and the final gate. Reviews against CLAUDE.md AND decisions.md/contracts. Must check: prompt-resolver imports compileAgent and writes composed_prompt_id; AgentStore CRUD is retired/delegated with NO leftover writable agent store; systemPrompt retained only as a computed compat shim; PolicyEngine reads agent-policy templates; claudecli reconciles tactical flags with compiled tools (no competing third model); no cross-package FK violations. Default verdict NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to the integration/retire states, then re-review. Mutates only review-integration.md + scripts/review_gate_integration.py.
