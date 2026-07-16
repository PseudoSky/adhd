# serializer-sqlite — STATE_NAME

**Phase:** storage · **Kind:** work · **Depends on:** orch-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [serializer-sqlite.1] dispatch-serializer-sqlite builds+tests green (incl. json-parity test)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-serializer-sqlite/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
