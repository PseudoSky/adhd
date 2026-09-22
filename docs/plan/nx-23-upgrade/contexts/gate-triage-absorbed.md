# gate-triage-absorbed — The post-bump gate failures have a recorded verdict

**Phase:** intake · **Kind:** work · **Depends on:** browser-cjs-umd-repair · **Guard:** `test -f docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-cli" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && rg -q "apigen-plugin-java-javalin" docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md && ./node_modules/.bin/nx show projects | rg -q "\"backlog\""`

---

## Goal

The three test targets that failed the commit gate after the vite 8 bump have an explicit, cited verdict on file — so no later state assumes the bump was clean.

---

## Semantic distillation

- An in-flight `debug` dispatch is triaging `apigen-cli`, `backlog` and `apigen-plugin-java-javalin`. CONSUME its verdict; do not re-derive it.
- If the verdict is not available, that is itself a finding: record it as open and halt rather than guessing.
- A flaky target (`apigen-cli` has a known flake history) is a different verdict from a real regression. Say which.
- **Re-sequenced by the 2026-09-21 repair pass.** This state now runs *after* the bump-safety fixes, so the verdict is consumed on a tree whose built artifacts actually load. `apigen-cli` and `backlog` are two of the three targets under triage **and** the two entrypoints `vite-cjs-import-meta-repair` builds and runs. If either gate failure was the `ERR_INVALID_ARG_VALUE` module-load throw from the Rolldown empty-import-meta lowering, record that as explained by `VITE-CJS-REPAIR.md` rather than filing it as an open flake — and if it was something else, say so explicitly, because then the fix did not cover it.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md"]
modified: []
deleted:  []
```

---

## Commit points

- Commit TRIAGE-VERDICTS.md post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [gate-triage-absorbed.1] The triage verdict record exists

- [gate-triage-absorbed.2] The verdict record covers the apigen-cli target
- [gate-triage-absorbed.3] The verdict record covers the java-javalin target
- [gate-triage-absorbed.4] The verdict record covers the backlog target
- [gate-triage-absorbed.5] The project graph loads with the affected targets resolvable
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json"]
mutates:    ["docs/plan/nx-23-upgrade/TRIAGE-VERDICTS.md"]
```

---

## Notes for executor

Consume the in-flight `debug` triage verdict for the three test targets that failed the pre-commit gate after the vite 8 bump. Do not assume the bump is clean.

Re-sequenced by the 2026-09-21 repair pass: the two bump-safety fix states now land first, so this verdict is validated against a tree whose built CJS artifacts load and whose public browser package builds. The state's own guard is unchanged.
