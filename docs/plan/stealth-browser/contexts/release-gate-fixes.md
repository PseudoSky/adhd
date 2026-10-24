# release-gate-fixes — STATE_NAME

**Phase:** release · **Kind:** work · **Depends on:** search-cutover, plan-notes, fix-tripwire, fix-core-parsers, fix-core-lifecycle, fix-core-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py release-gate-fixes`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [release-gate-fixes.1] tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs exists with the testing-standard header (guards:, tier: S, cites:) citing 8468f7b1 and [release-gate-fixes.1], carries a plugin-inferred-target case and a negative control (a project with specs and no test target, literal or inferred, is still flagged), is listed in package.json `test:build-tools`, passes `node --test`, and check-lane-reachability exits 0.

- [release-gate-fixes.2] check-test-wiring.mjs honours Nx-inferred `test` targets through the project graph (no longer only the literal project.json `targets.test`), keeps its exit 1 for a project with specs and no test target, names no project, and `node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs` exits 0 on the tree (agent-store-runtime and agent-store-prompts are no longer flagged).
- [release-gate-fixes.3] package.json `release:dry` begins with `export ADHD_NX_VERSION_DRY_RUN=1 &&` so the build, version and publish run-many calls all inherit it, and tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs (header, cites 8468f7b1 and [release-gate-fixes.3], listed in `test:build-tools`) parses the script, asserts the export covers every nx invocation of the chain, passes `node --test`, and check-lane-reachability exits 0.
- [release-gate-fixes.4] `pnpm release:dry` (ADHD_NX_VERSION_DRY_RUN NOT pre-set) exits 0 on the fixed tree, does real dry work (not the 'nothing to version/publish' no-op) and leaves `git status --porcelain` identical before and after (plan bookkeeping paths ignored); run only once the fixes exist, cached by code identity in evidence/release-gate-fixes.dry.json.
- [release-gate-fixes.5] decompile-cli's validators/local/index.spec.ts builds fixturesDir from the current test/fixtures layout (not src/tests), entrypoint/decompile-cli/test/fixtures is populated, and `nx run decompile-cli:test --skip-nx-cache` exits 0.
- [release-gate-fixes.6] The backlog c8-vocabulary failure is fixed at its root cause: evidence/release-gate-fixes.md has a `ROOT-CAUSE backlog: <mechanism>` line, `nx run backlog:test --skip-nx-cache` exits 0, and the end-to-end release:dry run (release-gate-fixes.4) is green for the current code.
- [release-gate-fixes.7] Only owned paths changed by [psm:release-gate-fixes] commits (package.json, the wiring check and its two specs, the decompile-cli and backlog specs, backlog project.json, the state's evidence).
---

## Reservations

```text
read_only:  []
mutates:    ["package.json", "tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs", "tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs", "tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs", "entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts", "entrypoint/backlog/test/unit/c8-vocabulary.spec.ts", "entrypoint/backlog/project.json", "docs/plan/stealth-browser/evidence/release-gate-fixes.md", "docs/plan/stealth-browser/evidence/release-gate-fixes.dry.json"]
```

---

## Notes for executor

executor=sonnet tier=sonnet; root-cause fixes for the release gates that were red: check-test-wiring inferred targets, release:dry mutating tracked files, decompile-cli fixture path, backlog c8-vocabulary load-dependence
