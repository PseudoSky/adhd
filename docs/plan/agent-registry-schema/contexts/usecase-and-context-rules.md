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

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry/src/db/schema.ts", "packages/ai/agent-registry/src/store/usecase-store.ts", "packages/ai/agent-registry/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
