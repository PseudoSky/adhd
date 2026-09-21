# audit-final — STATE_NAME

**Phase:** final · **Kind:** audit · **Depends on:** audit-tests · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_final.py`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] The final audit guard exists

- [audit-final.2] Every criterion across every phase passes at the final hold
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tsconfig.base.json", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_final.py"]
```

---

## Notes for executor

Final hold. Proves every Definition-of-Done clause against the real codebase. Nothing lands until this is green.
