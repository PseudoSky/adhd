# audit-reconcile — STATE_NAME

**Phase:** reconcile · **Kind:** audit · **Depends on:** test-resolution-absorbed · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tools/vite-plugins/source-resolution.mjs"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py"]
```

---

## Notes for executor

Hold point. The two absorbed branches must both be green before any config or graph work starts.
