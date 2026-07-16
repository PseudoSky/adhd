# orchestrator-harden — STATE_NAME

**Phase:** orchestrator · **Kind:** work · **Depends on:** opt-audit · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [orchestrator-harden.1] orchestrator builds+tests green

---

## Reservations

```text
read_only:  []
mutates:    ["packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
