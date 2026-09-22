# audit-tests — Test-selection phase holds

**Phase:** tests · **Kind:** audit · **Depends on:** test-changed-optin · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py`

---

## Goal

File-level selection is proven to select cross-package tests AND to fail loudly on zero selection.

---

## Semantic distillation

- Both halves matter. A selector that finds cross-package tests but passes silently on zero is the measured hazard with a nicer demo.
- The commit gate must still be consumer-covering after this phase. Assert it, do not assume it.

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

- [audit-tests.1] The tests-phase audit guard exists

- [audit-tests.2] The audit guard passes the runner its criteria file explicitly and names a single accumulated phase, so the gate is neither red by construction nor self-recursive
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_tests.py"]
```

---

## Notes for executor

Hold point. File-level selection must be proven to select cross-package tests AND to fail loudly on zero selection.

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
