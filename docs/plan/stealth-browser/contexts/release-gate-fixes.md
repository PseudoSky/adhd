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
---

## Reservations

```text
read_only:  []
mutates:    ["package.json", "tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs", "tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs", "tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs", "entrypoint/decompile-cli/test/unit/lib/validators/local/index.spec.ts", "entrypoint/backlog/test/unit/c8-vocabulary.spec.ts", "entrypoint/backlog/project.json", "docs/plan/stealth-browser/evidence/release-gate-fixes.md", "docs/plan/stealth-browser/evidence/release-gate-fixes.dry.json"]
```

---

## Notes for executor

executor=sonnet tier=sonnet; root-cause fixes for the release gates that were red: check-test-wiring inferred targets, release:dry mutating tracked files, decompile-cli fixture path, backlog c8-vocabulary load-dependence
