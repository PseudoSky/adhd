# audit-reconcile — Reconcile phase holds

**Phase:** reconcile · **Kind:** audit · **Depends on:** test-resolution-absorbed · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py`

---

## Goal

Both absorbed branches are green together on the upgrade branch before any config or graph work begins.

---

## Semantic distillation

- This is a HOLD, not a formality. A reconcile regression would otherwise be attributed to the config or graph phases.
- Run the intake + reconcile criteria; do not advance on a partially green phase.

---

## Contract promise

```text
added:    []
modified: []
deleted:  []
```

---

## Commit points

- Commit the audit run record.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-reconcile.1] The reconcile-phase audit guard exists

- [audit-reconcile.2] The audit guard passes the runner its criteria file explicitly and names a single accumulated phase, so the gate is neither red by construction nor self-recursive
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tools/vite-plugins/source-resolution.mjs"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_reconcile.py"]
```

---

## Notes for executor

Hold point. The two absorbed branches must both be green before any config or graph work starts.

**Guard mechanics (fixed 2026-09-21).** The guard runs
`node scripts/run-audit.js --phase <terminal-phase> --criteria <abs>/scripts/criteria.json`
with `cwd` = the repo root. Both flags are load-bearing and must not be "simplified":
`--criteria` because the runner resolves `criteria.json` relative to `process.cwd()` while the
criteria commands need the repo root; and a **single** terminal phase because the runner
accumulates every phase declared before it (`--phase "a,b"` is rejected outright). Do not add
a criterion to this state that re-runs this guard — the audit would recurse.

**Precondition for the negative-control criteria.** The audit harness ignores the `mutate`
step's exit code, so a control whose artifact does not exist yet reports PASS without proving
anything. That is only reachable while its owning state is unfinished; the state's own guard
is the real gate.
