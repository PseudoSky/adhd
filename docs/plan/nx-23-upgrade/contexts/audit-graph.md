# audit-graph — Task-graph phase holds

**Phase:** graph · **Kind:** audit · **Depends on:** graph-release-eslint-inferred · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_graph.py`

---

## Goal

The remodelled graph produces the same artifacts and an equivalent task graph before anything downstream trusts it.

---

## Semantic distillation

- Re-run a real build and a real suite. A graph that loads is not a graph that works.
- Re-run the earlier phases too — the accumulated harness catches a config regression introduced by the graph edits.

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

- [audit-graph.1] The graph-phase audit guard exists

- [audit-graph.2] The audit guard passes the runner its criteria file explicitly and names a single accumulated phase, so the gate is neither red by construction nor self-recursive
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_graph.py"]
```

---

## Notes for executor

Hold point. The remodel must produce byte-identical build artifacts and an equivalent task graph before anything downstream trusts it.

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
