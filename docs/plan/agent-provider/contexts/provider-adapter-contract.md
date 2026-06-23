# provider-adapter-contract — STATE_NAME

**Phase:** adapter · **Kind:** work · **Depends on:** audit-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [provider-adapter-contract.1] ProviderAdapter interface defined in agent-mcp-types (not agent-provider)

---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/model-store.ts"]
mutates:    ["packages/ai/agent-mcp-types/src/domain.ts", "packages/ai/agent-mcp-types/src/index.ts", "packages/ai/agent-provider/src/adapter/provider-adapter.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/adapter-resolve.test.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
