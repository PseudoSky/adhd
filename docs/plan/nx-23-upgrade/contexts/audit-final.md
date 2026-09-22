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

- [audit-final.2] The audit guard passes the runner its criteria file explicitly and names a single accumulated phase, so the gate is neither red by construction nor self-recursive
- [audit-final.ref-target-artifact-parity] Conformance: a converted target still produces its artifact through the inferred path
- [audit-final.ref-fail-safe-fast-path] Conformance: the fast path fails loudly on zero selection
- [audit-final.ref-pinned-guard-tool-resolution] Conformance: every guard resolves its tool through a repo-local anchor
- [audit-final.iface-nx-vitest-peer-range] Interface: the vitest ceiling is the one the installed Nx plugin declares
- [audit-final.iface-vitest-related-cli] Interface: the related selector is available in the installed test runner
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "tsconfig.base.json", ".githooks/pre-commit"]
mutates:    ["docs/plan/nx-23-upgrade/scripts/guard_audit_final.py", "docs/plan/nx-23-upgrade/scripts/check-guards-pinned.mjs"]
```

---

## References & interfaces

- [ref:pinned-guard-tool-resolution] — every guard resolves its tool through ./node_modules/.bin/ or a python3 script, never a bare PATH lookup

---

## Notes for executor

Final hold. Proves every Definition-of-Done clause against the real codebase. Nothing lands until this is green.

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
