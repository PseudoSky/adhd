# audit-final — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** refactor-agent-mcp, audit-runtime · **Guard:** `true`

---

## Goal

Verify that every clause of the Definition of Done is satisfied. Each criterion below proves one `[dod.N]` clause.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] All 6 packages build successfully — proves [dod.1]
- [audit-final.2] adhd-env init generates valid YAML — proves [dod.2]
---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_audit-final.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
