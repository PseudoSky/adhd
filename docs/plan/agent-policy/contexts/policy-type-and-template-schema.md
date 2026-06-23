# policy-type-and-template-schema — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [policy-type-and-template-schema.1] policy_types lookup table (text PK, not enum)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-policy/src/db/schema.ts", "packages/ai/agent-policy/src/store/policy-template-store.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/policy-template-store.test.ts", "packages/ai/agent-policy/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
