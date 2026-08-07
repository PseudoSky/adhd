# closeout-design — STATE_NAME

**Phase:** closeout-design · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase design`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [closeout-design.1] decisions.md records the merge strategy (or explicit no-merge), the pre-initiative agent-mcp baseline ref, the publish order, and the artifact disposition policy

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-release/decisions.md", "docs/plan/agent-registry-release/contexts/closeout-design.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
