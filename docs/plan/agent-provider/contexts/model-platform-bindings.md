# model-platform-bindings — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** provider-and-model-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [model-platform-bindings.1] model_platform_bindings table

- [model-platform-bindings.2] resolveModelId reads binding by platform
---

## Reservations

```text
read_only:  ["packages/ai/agent-provider/src/store/provider-store.ts"]
mutates:    ["packages/ai/agent-provider/src/db/schema.ts", "packages/ai/agent-provider/src/store/model-store.ts", "packages/ai/agent-provider/src/index.ts", "packages/ai/agent-provider/src/__tests__/binding-store.test.ts", "packages/ai/agent-provider/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
