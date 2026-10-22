# QA legacy-test audit (dispatch-1014)

Method: static only. No test, build or gate was run (user constraint). Criteria: `docs/standards/testing.md` retention questions R1-R6, applied conservatively; a test is removed only when reading proves it cannot execute or guard anything.
authorship-check: not-auditor (the audited files predate this dispatch; first-parent history shows commits 27abab5f and b9e13840, neither by this session).
Parity: parity unverified (tests not run per user). Every removal below is a comment-only region, so no executing test case was changed; the user should still run the gates.

## Scans performed

| scan | command (abridged) | result |
|---|---|---|
| dead `packages/ai/*`, `packages/shared/*` paths | `rg "packages/(ai\|shared)/"` over test files; `ls packages/ai packages/shared` | dirs absent. Hits are comments or the live guard `docs-and-config-contract.test.ts` "AC1: no dead packages/ai/... source path remains" (kept, it is the regression guard) |
| unresolvable imports in tests | python script over `git ls-files` spec/test/e2e files: relative imports resolved on disk, `@adhd/*` imports resolved against workspace package names | every hit inspected is a fixture string written into temp workspaces (`./module.js`, `@adhd/fx-*`), an external `@adhd/sox-*` npm dependency, or a commented import. No test imports a deleted module |
| exact duplicates | md5 over all spec/test/e2e files | none; only identical config files (`tsconfig.spec.json`, `vitest.e2e.config.ts`), not tests |
| skip / todo | `rg "\.(skip\|todo)\b\|xit\("` | see kept-doubtful |
| commented-out test code | comment ratio >= 35% in files > 40 lines; `// it(`/`// expect(` scan | three removals below |

## Removed (3 records)

### 1. `packages/data/data-base-transforms/src/lib/stats.spec.ts` lines 42-358 (317 lines)
- why obsolete: R1/R2. The region is a fully commented-out React Native component (`RangeSlider`, `react-native-svg`, `@adhd/utils`, `./RangeSliderLabel`, `./TestData.test.js`) pasted from an app. It is not a test, runs nothing, and references a package (`@adhd/utils`) and two files that do not exist in this repo. The live test (`describe('transforms')`, lines 1-40) is untouched.
- evidence: `rg -n "@adhd/utils|RangeSliderLabel|TestData" packages/data/data-base-transforms/src` -> only lines 45, 47, 49, 333 of this file, all `//` comments. `ls packages/data/data-base-transforms/src/lib` shows no `RangeSliderLabel*` or `TestData*`. Python assert that every removed line matched `^\s*(//.*)?$` passed before write.
- risk: none for execution (comment-only). Loss of historical reference; recoverable from git history.

### 2. `packages/data/data-base-transforms/src/lib/collections.spec.ts` lines 348-361 (14 lines)
- why obsolete: R1. Trailing commented-out `honey/src/components/Search/QuickFilters.js` snippet importing `@adhd/utils` `Collections`; unrelated to this package's tests.
- evidence: `rg -n "@adhd/utils" packages/data/data-base-transforms/src` -> line 349, a `//` comment; same all-comment assert as above.
- risk: none (comment-only).

### 3. `entrypoint/decompile-cli/src/lib/validators/local/__tests__/index.spec.ts` lines 43-98 (56 lines)
- why obsolete: R1/R3. Commented-out ava-era `t.deepEqual(local.getFileInfo(...))` assertions for a shape (`root`, `dir`, `exists`, `type: 'SourceMap'`) from before the TypeScript migration; `t` does not exist in this vitest/jest file, and the live loop above already covers the same file-type inference through `local.getFileInfo`.
- evidence: `sed -n '43,$p'` of the file matches only `^\s*(//.*)?$`; live coverage of the same inputs is the `fixtures` table (`index.css`, `index.html`, `index.js?q=1`, `index.map`, ...) at lines 17-37.
- risk: none (comment-only). The `exists`/`root` fields in the old shape were not asserted by any live case; if they are still part of the contract that is a coverage question, not a loss from this removal.

Totals: 3 files edited, 387 comment lines removed, 0 executing test cases removed.

## Kept (policy-protected, not doubtful)

- 82 stub spec files headed `STUB (mocked placeholder)` (for example `entrypoint/backlog/src/cli.spec.ts`, `entrypoint/apigen-cli/src/test/*.spec.ts`). `docs/standards/testing.md` line 11 requires every `*.e2e.ts` to have a paired `*.spec.ts` stub so tier S lists the suite, and `tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs` baselines their `it.todo` markers (gate G4). Removing them would break the pairing rule and the baseline.

## kept-doubtful

| path | marker | why kept |
|---|---|---|
| `entrypoint/backlog/src/store/graph-backlog-store.spec.ts:104` | `it.skip` "[CPU-THRASH-SKIP: owner-requested]" | skipped by owner request; no tracking id/date found by reading, so G4 may flag it, but the owner decision needs a human |
| `entrypoint/agent-mcp/src/__tests__/integration/live-cache-smoke.e2e.test.ts:78` | `LIVE ? it : it.skip` | paid-LLM gate, the one exception the AGENTS.md allows |
| `packages/data/data-query-engine/src/lib/parser.spec.ts:164-169` | commented `parseOrderBy` cases | unimplemented-feature TODOs, may be wanted |
| `entrypoint/decompile-cli/src/lib/validators/url/index.spec.ts:756+` | commented "deprecated options" case | may document a pending behavior |
| `packages/data/data-base-transforms/src/lib/object.spec.ts:77-78`, `stats.spec.ts` lines 36-38 | commented `// TODO: doesn't work` / `// Broken below` expectations | record known-broken behavior inside live tests |
| `entrypoint/agent-mcp/src/__tests__/docs-and-config-contract.test.ts:232` | "no dead packages/ai/... source path remains" | live guard for exactly the legacy path class; protective |
| `packages/agent/agent-engine-compiler/src/__tests__/compile-agent.test.ts:64-68`, `agent-core-provider/src/__tests__/binding-store.test.ts:15` | comments citing `packages/ai/...` | stale comments, not tests; the code resolves current paths. Comment fix deferred, not a test removal |
| `entrypoint/backlog/src/api.semantic-laziness.spec.ts` and ~30 other backlog specs | import `@adhd/sox-*` | resolved from npm/node_modules, not workspace packages; not verifiable as dead without running |

## Not covered (budget and no-run constraint)

Detecting tests of deleted symbols that still resolve by module path, and mock-only assertions, needs per-test reading or a run; sampled only. Not claimed clean.
