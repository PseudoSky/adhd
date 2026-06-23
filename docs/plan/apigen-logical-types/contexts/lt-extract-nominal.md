# lt-extract-nominal — STATE_NAME

**Phase:** extraction · **Kind:** work · **Depends on:** lt-contracts · **Guard:** `npx nx test apigen-core`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lt-extract-nominal.1] guard green: npx nx test apigen-core

---

## Reservations

```text
read_only:  []
mutates:    ["packages/apigen/core/src/lib/schema-builders/nominal.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
