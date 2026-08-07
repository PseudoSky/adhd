# merge-to-main — STATE_NAME

**Phase:** merge-gate · **Kind:** work · **Depends on:** agent-mcp-backout-gate · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase merge`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [merge-to-main.1] MERGE_RUNBOOK.md gives the exact non-interactive merge command + the back-out-gate precondition + rollback

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-release/MERGE_RUNBOOK.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
