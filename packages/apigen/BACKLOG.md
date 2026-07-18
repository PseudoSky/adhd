# apigen — family backlog

Cross-package findings for the apigen family. Package-local backlogs (e.g.
`core/BACKLOG.md`) take precedence for their own scope.

## Pointers to package-local entries with cross-package impact

- **BUG-APIGEN-CORE-002** (re-exports never followed — FIXED 2026-07-18) and
  **BUG-APIGEN-CORE-003** (buildSchema OOMs on a large real-world re-export
  barrel — OPEN) — full detail in `apigen-core-client/BACKLOG.md`. Relevant
  to every apigen consumer/plugin: any `source:` file that is a re-export
  barrel now extracts correctly (previously near-total data loss for that
  shape), but a barrel large/dependency-heavy enough (proven case:
  ~40-file, ~140-operation) can OOM schema generation.
- **DEBT-APIGEN-LINT-001** (`@nx/dependency-checks` false-positive on
  `decimal.js`, only reachable from tsconfig-excluded `src/test/**`
  fixtures — FIXED 2026-07-18, moved to `devDependencies`) — affected
  `apigen-core-client` and `apigen-cli`. Full detail in
  `apigen-core-client/BACKLOG.md`.
- **DEBT-APIGEN-LINT-002** (`apigen-engine-runtime` has zero importer
  entries in `pnpm-lock.yaml` — OPEN, root cause needs a deliberate lockfile
  resync, not attempted here; a `.eslintrc.json` `ignoredDependencies`
  containment fix IS applied so the destructive `--fix` auto-deletion can't
  recur) — `ajv`/`ajv-formats` are genuinely used in real source at the
  correct installed version; the pre-commit hook's ESLint `--fix` deleted
  them from `dependencies` TWICE before the containment fix landed. Full
  detail in `apigen-core-client/BACKLOG.md` and
  `apigen-engine-runtime/BACKLOG.md`.

## BUG-APIGEN-CLI-001 — cli-output generator emits invalid TS identifiers for hyphenated source dirs

- **Where:** `@adhd/apigen-plugin-cli-output` (`packages/apigen/plugins/cli`), generated `cli.ts`.
- **Symptom:** the namespace identifier is derived verbatim from the source directory name; a hyphenated dir (`tmp/dispatch-cli-spike/api.ts`) generates `import * as dispatch-cli-spike_ns from …` — a TypeScript parse error (`Expected "from" but found "-"`). Found 2026-07-02 during the dispatch CLI spike; reproduced, then confirmed working from a hyphen-free dir (`tmp/dispatchcli`).
- **Why it matters:** repo convention mandates hyphenated package names, so any in-repo consumer following convention hits this on first use.
- **Fix direction:** sanitize the derived namespace to a valid identifier (camelCase or `_` for `-`) in the cli-output plugin's codegen; add a generation test with a hyphenated source dir that spawns the generated CLI (`--help`, exit code) rather than only asserting on the emitted text.
- **Status:** FIXED (2026-07-06) — `sanitizeIdentifier()` called at both import-namespace (line 96) and fn-table (line 122) emission sites in `packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts`. Import path uses correct `@adhd/apigen-engine-runtime`. All 3 hyphenated-namespace tests + all 19 plugin tests pass.

## DEBT-APIGEN-CLI-002 — generated cli.ts imports the source module by absolute path

- **Where:** same generator; first import line of generated `cli.ts`.
- **Symptom:** `import * as … from '/Users/…/tmp/dispatchcli/api.ts'` — machine-absolute path baked into the artifact. Harmless for generate-at-build-time flows (the nx `generate` executor regenerates per machine, cache-aware), but the artifact is not relocatable and diffs across machines defeat byte-identical caching expectations.
- **Fix direction:** emit a path relative to the out-dir (or copy the source module into the out-dir like the mcp generate flow does).
- **Status:** OPEN.
- **Note:** Confirmed still present 2026-07-02 in dispatch-cli's generated artifact (machine-absolute import of src/api.ts).

## BUG-APIGEN-CORE-001 — zod-contaminated $ref resolution corrupts unrelated primitive schemas (runtime crash in generated surfaces)

- **Where:** packages/apigen/core (schema extraction) and/or packages/apigen/logical (src/lib/runmode.ts encodeNode/$ref resolution).
- **Symptom:** when an apigen `source:` file transitively imports anything using zod (e.g. @adhd/dispatch-orchestrator's AgentMcpRunner → @modelcontextprotocol/sdk), ts-json-schema-generator's whole-file extraction registers zod-derived declarations into the shared definitions registry in a way that corrupts unrelated primitive entries — generated commands then crash at first invocation with `[apigen-logical] $ref "#/definitions/boolean" cannot be resolved in run-mode without a descriptor root` (also seen for "#/definitions/number"). Even functions whose own signatures never touch zod types are corrupted (dispatch-cli's calibrate, returning a simple local interface, crashes; only eligible/status — whose type graphs never reach the MCP SDK — work).
- **Why it matters:** general, silent at generate-time, runtime-crash at first use — any future source file with a transitive zod dependency hits it.
- **Fix direction:** isolate/namespace zod-internal definitions during extraction (or filter them from the shared registry), and make runmode's encodeNode fail at GENERATE time (loud) rather than run time when a $ref cannot resolve.
- **Status:** FIXED (2026-07-06). Two-layer defense:
  1. **Skip Path 1 for zod-importing files** — `sourceFileHasZodImport()` detects zod imports in the source file (`ts-json-schema.ts:335-353`). When present, `buildSchemaUncached` skips Path 1 (ts-json-schema-generator, which produces corrupted output with `skipTypeCheck`) and falls directly to Path 2 (morph-walk, which resolves types correctly via ts-morph). Memoized per SourceFile in `InternalExtractionSession.zodImportCache`.
  2. **Schema-level defense for non-zod Path 1 schemas** — `filterZodDefinitions()` enhanced with recursive `stripZodRefsRecursive()` pass that removes any remaining `$ref` entries pointing to zod-named definitions, even when nested inside properties/items/oneOf/etc. `validateSchemaRefs()` then fails at **generate time** (not runtime) if any dangling `$ref` survives the filter.
  3. Test regression: `zod-contamination.ts` fixture + 3 new tests in `ts-json-schema.spec.ts` verify zod definitions stripped, no dangling $ref, and teeth-test for generate-time validation. All 211 tests pass.

## DEBT-APIGEN-CLI-003 — cli-output isBoolean codegen misses anyOf-wrapped optional booleans

- **Where:** packages/apigen/plugins/cli src/lib/generate.ts (isBoolean detection).
- **Symptom:** `flag?: boolean` extracts as `anyOf: [null, boolean, boolean]` (note the duplicate boolean arm — possibly a separate ts-json-schema-generator artifact worth a look), which the strict `schemaProps[param]?.type === 'boolean'` check never matches, so the plugin emits a value-taking `--flag <flag>` instead of a presence-only boolean flag. Workaround: declare a default value (`flag = true`) instead of `?`.
- **Fix direction:** extend isBoolean detection to recognize anyOf nodes whose non-null members are all boolean.
- **Status:** FIXED (2026-07-06) — `isBooleanParam()` helper at `packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts:140-149` descends into `anyOf`, extracting non-null members and checking they're all boolean.

## DEBT-APIGEN-CLI-004 — cli-output cannot express boolean false (no --no-<flag> negation)

- **Where:** packages/apigen/plugins/cli src/lib/generate.ts (boolean flag codegen).
- **Symptom:** even a clean boolean param only projects to a presence-only `--flag` (true or undefined) — false is unreachable through the generated CLI; Commander supports `--no-<flag>` natively and dispatch-cli's hand-written bin/cli.ts demonstrates it.
- **Fix direction:** when a boolean param defaults to true, emit `--no-<flag>`.
- **Status:** FIXED (2026-07-06) — `packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts:188-191` emits `--no-<flag>` when `default === true`.

---

## Revalidation (2026-07-06) — post-fix verification

| Item | Status | Notes |
|------|--------|-------|
| BUG-APIGEN-CLI-001 — hyphenated identifiers | **FIXED** | `sanitizeIdentifier()` called at both emission sites. All 22 tests pass. |
| DEBT-APIGEN-CLI-002 — absolute import path | **STILL OPEN** | `relativeImportPath()` helper exists (line 78-83) but `importPath` passed verbatim. See entry above. |
| BUG-APIGEN-CORE-001 — zod $ref corruption | **FIXED** | Two-layer defense: zod-import skip + recursive $ref stripping + generate-time validation. 3 regression tests. |
| DEBT-APIGEN-CLI-003 — anyOf boolean | **FIXED** | `isBooleanParam()` now descends into `anyOf`. |
| DEBT-APIGEN-CLI-004 — no --no-flag | **FIXED** | `--no-<flag>` emitted when `default === true`. |
