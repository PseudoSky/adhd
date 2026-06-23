# agent-and-taxonomy-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** lookup-and-component-schema · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [agent-and-taxonomy-schema.1] agents table with slug PK, status, model_hint, taxonomy_category

- [agent-and-taxonomy-schema.2] taxonomy_categories table with ordering
- [agent-and-taxonomy-schema.3] agent-store test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/component-store.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/agent-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/agent-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
