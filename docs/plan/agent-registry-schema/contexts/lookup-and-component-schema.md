# lookup-and-component-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lookup-and-component-schema.1] prompt_types lookup table defined

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/db/client.ts"]
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/component-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/component-store.test.ts", "packages/ai/agent-registry/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
