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

- [audit-final.1] final audit self-consistent

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-provider/scripts/audit_provider.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
