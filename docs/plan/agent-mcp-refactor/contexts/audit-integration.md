# audit-integration — STATE_NAME

**Phase:** audit · **Kind:** audit · **Depends on:** policy-engine-bridge · **Guard:** `python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase integration`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-integration.1] integration-phase audit self-consistent (all integration criteria accumulate green)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
