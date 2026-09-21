# audit-final — Final hold before anything lands

**Phase:** final · **Kind:** audit · **Depends on:** audit-tests · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_final.py`

---

## Goal

Every Definition-of-Done clause is confirmed by an executed check against the real codebase. Nothing lands until this is green.

---

## Semantic distillation

- This is a HOLD, not a merge. No state in this plan pushes, merges to the default branch, or publishes.
- The guard refuses DONE if any DoD clause has no executed PASS — so a clause that was never really proven cannot be waved through.
- If a clause fails, fix it in its owning state. Do not weaken the check.

---

## Contract promise

```text
added:    []
modified: []
deleted:  []
```

---

## Commit points

- Commit the final audit record; then stop and hand the landing decision to a human.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-final.1] The final audit guard exists

- [audit-final.2] Every criterion across every phase passes at the final hold
- [audit-final.3] Conformance: a converted target still produces its artifact through the inferred path
- [audit-final.4] Conformance: the fast path fails loudly on zero selection
- [audit-final.5] Conformance: every guard resolves its tool through a repo-local anchor
- [audit-final.6] Interface: the vitest ceiling is the one the installed Nx plugin declares
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tsconfig.base.json", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_final.py"]
```

---

## Notes for executor

Final hold. Proves every Definition-of-Done clause against the real codebase. Nothing lands until this is green.
