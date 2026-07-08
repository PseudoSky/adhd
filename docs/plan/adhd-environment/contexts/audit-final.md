# audit-final — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** refactor-agent-mcp, audit-runtime · **Guard:** `true`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] All packages build

- [audit-final.2] Init generates YAML
---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_audit-final.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
