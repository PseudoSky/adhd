# authoring-design — STATE_NAME

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-mcp-authoring/scripts/audit_authoring.py --phase architecture`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [authoring-design.1] decisions.md records the embedding-source decision (reuse memory-server vs deterministic in-package) + determinism/idempotence requirement

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-authoring/decisions.md", "docs/plan/agent-mcp-authoring/contexts/authoring-design.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
