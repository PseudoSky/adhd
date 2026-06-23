# audit-final — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** seed-and-roundtrip · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] final audit passes: every prior-phase check green and DoD checks executed

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-policy/scripts/audit_policy.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
