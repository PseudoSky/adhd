# agent-policy-junction — STATE_NAME

**Phase:** schema · **Kind:** work · **Depends on:** policy-type-and-template-schema · **Guard:** `true`

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
mutates:    ["packages/ai/agent-policy/src/db/schema.ts", "packages/ai/agent-policy/src/store/agent-policy-store.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/agent-policy-store.test.ts", "packages/ai/agent-policy/drizzle"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
