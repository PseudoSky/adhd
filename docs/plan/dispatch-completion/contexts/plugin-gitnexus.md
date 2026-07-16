# plugin-gitnexus — STATE_NAME

**Phase:** plugins · **Kind:** work · **Depends on:** orch-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [plugin-gitnexus.1] dispatch-plugin-gitnexus builds+tests green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-plugin-gitnexus/src/index.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
