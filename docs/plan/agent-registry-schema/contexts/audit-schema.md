# audit-schema — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** composed-prompt-cache · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-schema.1] schema-phase audit script passes (all schema-state criteria green)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-schema/scripts/audit_registry_schema.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
