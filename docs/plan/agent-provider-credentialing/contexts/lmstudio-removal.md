# lmstudio-removal — STATE_NAME

**Phase:** runtime · **Kind:** work · **Depends on:** provider-credential-runtime · **Guard:** `npx --yes nx build agent-mcp && python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase runtime`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lmstudio-removal.1] providers/lmstudio.ts is deleted

- [lmstudio-removal.2] factory.ts has no case "lmstudio"
- [lmstudio-removal.3] validation/agent.ts has no lmstudioProviderSchema
- [lmstudio-removal.4] domain.ts union no longer contains a lmstudio member
- [lmstudio-removal.5] providers/index.ts no longer exports LMStudioProvider
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/providers/lmstudio.ts", "packages/ai/agent-mcp/src/providers/factory.ts", "packages/ai/agent-mcp/src/providers/index.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/providers/types.ts", "packages/ai/agent-mcp/src/engine/orchestrator.ts", "packages/ai/agent-mcp/src/db/schema.ts", "packages/ai/agent-mcp/src/providers/openai.ts", "packages/ai/agent-mcp/src/__tests__/debt-005-sdk-timeout.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-oauth.e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-budget.e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/integration/live-dag.e2e.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
