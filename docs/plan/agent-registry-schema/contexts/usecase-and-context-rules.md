# usecase-and-context-rules — STATE_NAME

**Phase:** composition · **Kind:** work · **Depends on:** composition-junction · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [usecase-and-context-rules.1] use_cases + component_usage + context_rules tables

- [usecase-and-context-rules.2] usecase-store test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/composition-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/usecase-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/usecase-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
