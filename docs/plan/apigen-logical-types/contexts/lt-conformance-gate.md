# lt-conformance-gate — STATE_NAME

**Phase:** gates · **Kind:** work · **Depends on:** lt-host-generator · **Guard:** `npx nx run apigen-conformance:conformance`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [lt-conformance-gate.1] guard green: npx nx run apigen-conformance:conformance

---

## Reservations

```text
read_only:  []
mutates:    ["packages/apigen/conformance/src/lib/gate.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
