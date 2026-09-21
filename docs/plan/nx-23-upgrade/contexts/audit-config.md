# audit-config — STATE_NAME

**Phase:** config · **Kind:** audit · **Depends on:** cache-isolation · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py`

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
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "tsconfig.base.json", "package.json"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_config.py"]
```

---

## Notes for executor

Hold point. Nothing lands from the config phase until the shim removal and cache isolation are both green.
