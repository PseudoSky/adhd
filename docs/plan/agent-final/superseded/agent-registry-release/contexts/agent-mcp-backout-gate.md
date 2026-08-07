# agent-mcp-backout-gate — STATE_NAME

**Phase:** merge-gate · **Kind:** work · **Depends on:** artifact-cleanup · **Guard:** `python3 docs/plan/agent-registry-release/scripts/check_agent_mcp_baseline.py`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [agent-mcp-backout-gate.1] agent-mcp{,-types} matches the recorded baseline within Plan 8's manifest (or byte-identical)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-release/scripts/check_agent_mcp_baseline.py"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
