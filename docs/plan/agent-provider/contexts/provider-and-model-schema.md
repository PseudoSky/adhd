# provider-and-model-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [provider-and-model-schema.1] providers table

- [provider-and-model-schema.2] models table with capability flags
- [provider-and-model-schema.3] model-store round-trip+reopen test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/db/client.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/provider-store.ts", "packages/ai/agent-provider/src/store/model-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/model-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
