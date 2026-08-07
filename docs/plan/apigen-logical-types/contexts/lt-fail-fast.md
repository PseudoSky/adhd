# lt-fail-fast — STATE_NAME

**Phase:** integration · **Kind:** work · **Depends on:** lt-host-ts · **Guard:** `npx nx test apigen-cli`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lt-fail-fast.1] guard green: npx nx test apigen-cli

---

## Reservations

```text
read_only:  []
mutates:    ["packages/apigen/cli/src/lib/commands/run.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
