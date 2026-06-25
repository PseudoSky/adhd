# worktree-clarity — STATE_NAME

**Phase:** worktree-clarity · **Kind:** work · **Depends on:** closeout-design · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase clarity`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [worktree-clarity.1] CLOSEOUT.md states the worktree path, branch, base, the exact merge command, and the agent-mcp back-out gate

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry/CLOSEOUT.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
