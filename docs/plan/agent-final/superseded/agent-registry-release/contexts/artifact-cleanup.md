# artifact-cleanup — STATE_NAME

**Phase:** cleanup · **Kind:** work · **Depends on:** worktree-clarity · **Guard:** `python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase cleanup`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [artifact-cleanup.1] no untracked initiative file under docs/plan/agent-registry/ is unaccounted for (git status vs disposition table)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry/demo/README.md", "docs/plan/plan-index.json", ".gitignore"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
