# BACKLOG — @adhd/apigen-core

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ _Extraction performance + memory-leak work (2026-07-02)_).

## Fixed

### BUG-APIGEN-CORE-002 — extract()/extractClasses() never followed re-exports (`export { x } from './module.js'`)

- **Where:** `src/lib/extract.ts` (Shape 1/2/3 walkers + the "Shape 1b" renamed-export
  block) and `src/lib/extract-classes.ts` (`for (const cls of sf.getClasses())`).
- **Symptom:** a source file that is a pure re-export barrel (e.g. a package's
  `index.ts` doing `export { a, b, c } from './other.js'`) extracted almost
  nothing. Confirmed against `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts`
  (a ~40-source-file re-export barrel, read-only reference, never modified):
  before the fix, `extract()` found only 2 operations (`write`, `recall` — the
  two functions physically declared IN `index.ts` itself); every one of the
  ~35 `export { ... } from './x.js'` statements re-exporting from `db.ts`,
  `lease.ts`, `write.ts`, `recall.ts`, `cluster.ts`, etc. was silently skipped.
  `extract.ts:357-359` (pre-fix) explicitly bailed on any `ExportDeclaration`
  with a module specifier (`if (ed.getModuleSpecifier()) continue`); the rest
  of the walker only ever called `sf.getFunctions()` /
  `sf.getVariableDeclarations()`, which — per ts-morph semantics — only return
  declarations PHYSICALLY located in `sf`, never ones merely re-exported into
  it. `extract-classes.ts` had the identical disease one level up
  (`sf.getClasses()`), plus an independent same-file bug: it named the
  operation by `cls.getName()` (the LOCAL declaration name) even when the
  class was exported only under a rename (`export { LocalClass as
  PublicClass }`), violating the "canonical name = exported symbol" invariant
  the F28/F29 fix already established for functions/consts.
- **Fix:** rearchitected both walkers to iterate `sf.getExportedDeclarations()`
  — ts-morph's own re-export-chain resolver, which flattens named re-export
  lists, aliased re-exports, multi-hop barrel chains, AND `export * from`
  wildcards down to the terminal physical declaration, keyed by the OUTERMOST
  exported name — as the primary driver, dispatching per declaration kind
  (FunctionDeclaration / VariableDeclaration+initializer-kind /
  ClassDeclaration). This single declaration-driven pass subsumes what were
  previously three separate walks (physical functions, physical variables,
  local-rename-only "Shape 1b") in `extract.ts`, and fixes both bugs in
  `extract-classes.ts` in one pass. `buildSchema` is deliberately still called
  with the TOP-LEVEL entry `sf` (not each resolved declaration's own source
  file) — see the perf note in BUG-APIGEN-CORE-003 below; an earlier version
  of this fix threaded the declaration's own file through and it OOM'd.
- **Tests:** `src/test/fixtures/reexport-{source,barrel,mid,chain-outer,wildcard-barrel}.ts`
  + new describe blocks in `extract.spec.ts` (`[extract.reexport.*]`, 10 tests)
  and `extract-classes.spec.ts` (`[cls.reexport.*]`, 6 tests) covering: plain
  re-export, renamed re-export, re-exported named-object export, re-exported
  class (plain + renamed), two-hop re-export chains, and `export * from`
  wildcard re-exports — each asserting identical name/kind/safe/shape against
  the same operation extracted directly from the declaring file. All 220
  pre-existing tests + 16 new tests pass (236/236); real-world verification
  against the sox-ecosystem file found 146 operations (140 function/const +
  6 class-derived) instead of 2, all correctly named by their outermost
  exported alias.
- **Status:** FIXED 2026-07-18.

### PERF-APIGEN-001 — redundant TypeScript program builds — RESOLVED 2026-07-02

- `extract()` / `generateSchemas()` / `extractClasses()` each built a fresh ts-morph
  `Project` per call (~1–2s each; the orchestrator built ~2 per source per run) and the
  ts-json-schema-generator cache grew a new ~100–200MB entry on every file edit, forever.
- Fixed by `src/lib/extraction-session.ts`: a shared per-run `ExtractionSession`
  (optional `session` on `ExtractOptions` / `GenerateSchemasOptions` /
  `ExtractClassesOptions`; created+disposed internally when absent) plus a bounded
  persistent tier (LRU-capped generators via `APIGEN_PROGRAM_CACHE`, default 8, `0`
  disables; version-checked persistent Project + schema maps, refreshed on edit).
- Measured: cold 37.4s → 7.4s, warm → 6–11ms (6 files × 10 fns); core suite 64.6s → 8.4s.
- Guards: `src/test/extraction-session.spec.ts` (work counts; proven red under a
  negative control), `apigen-cli`'s `src/test/perf.spec.ts` (consumer outcome).

### Deliberate non-change: per-parameter `buildSchema` loops stay sequential

`buildSchema` is synchronous CPU work under an async signature — `Promise.all` gains
nothing and would race morph-walk's shared-SourceFile probe aliases. Do not "optimize"
these loops with concurrency.

## Open

### BUG-APIGEN-CORE-003 — buildSchema OOMs on a large real-world re-export barrel (>20GB, never completes)

- **Where:** `src/lib/schema-builders/ts-json-schema.ts` (`buildSchemaUncached` /
  `runScalarAwareGenerator`, both Path 1 `ts-json-schema-generator` and Path 2
  `morph-walk`), exercised via `extract()`/`extractClasses()` over
  `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts` (read-only reference).
- **Symptom:** discovered while verifying BUG-APIGEN-CORE-002's fix. Once the
  re-export walk correctly finds all 146 operations in that file (up from 2),
  running the REAL (unstubbed) `buildSchema` for all of them — a ~40-file
  transitive dependency graph including better-sqlite3, onnxruntime-node, and
  sqlite-vec native-binding types — exhausts the V8 heap. Reproduced at
  `--max-old-space-size=4096`, `8192`, and `20000` (the last just never
  finished within a 280s cap; machine has 32GB). Isolated experiments rule out
  the obvious suspects: `sf.getExportedDeclarations()` alone is cheap (~250MB,
  <1s for 274 keys); building ONE `ts-json-schema-generator` program for the
  file is cheap (~205MB); calling `SchemaGenerator.createSchema()` ~40 times
  on ONE cached generator instance is cheap (~310MB). So the growth is
  specifically in the PER-OPERATION schema-building work across ~140 distinct,
  often deeply-nested domain types (`WriteParams`, `RecallResult`,
  `ClusterResult`, etc.) — plausibly Path 2 (morph-walk)'s repeated
  "add-a-throwaway-type-alias-then-resolve" mutation of the shared ts-morph
  `SourceFile` across hundreds of recursive nested-property calls, forcing the
  underlying TS language service to reparse/retype-check a large graph on each
  call, with no apparent release between calls. NOT caused by, or specific to,
  the re-export fix itself — `buildSchema`'s internals are untouched by that
  fix; this file simply never exercised more than 2 `buildSchema` calls before
  (the pre-fix extractor found only `write`/`recall`), so this cost was latent
  and never triggered.
- **Why it matters:** any real-world consumer with a re-export barrel this
  large and this dependency-heavy will hit the same wall now that extraction
  actually reaches all of it — the correctness fix (BUG-APIGEN-CORE-002)
  exposes a pre-existing scalability ceiling in schema generation.
- **Verification workaround used (not a fix):** stubbed `buildSchema` via
  `vi.mock('../lib/schema-builders/ts-json-schema', ...)` to isolate and
  confirm the export-name/count discovery logic in milliseconds, with zero
  OOM risk — proves BUG-APIGEN-CORE-002's fix is correct independent of this
  separate schema-generation cost.
- **Fix direction (not attempted — needs its own investigation):** profile
  Path 2 (`morph-walk.ts`'s `withResolvedType`) specifically for whether the
  throwaway type-alias node it adds to the shared `SourceFile` is fully
  cleaned up (removed + forgotten) after each call, and whether ts-morph's
  underlying compiler host/language-service retains per-call AST/type-checker
  state across repeated mutations of the same file instead of releasing it;
  also check whether Path 1's `ts-json-schema-generator` `SchemaGenerator`
  instance accumulates an unbounded internal `$ref`/definitions registry
  across many `createSchema()` calls on structurally large types specifically
  (as opposed to the simple synthetic names used in the isolated experiment
  above). Consider a per-N-operations generator/session recycle as a
  mitigation if the root cause turns out to be unfixable cache growth.
- **Status:** OPEN. Filed 2026-07-18 during BUG-APIGEN-CORE-002 verification.

### DEBT-APIGEN-LINT-001 — `@nx/dependency-checks` false-positive: `decimal.js` only used by `src/test/**` fixtures — FIXED 2026-07-18

- **Where:** `packages/apigen/apigen-core-client/package.json` and
  `entrypoint/apigen-cli/package.json` (both declared `decimal.js`
  in `dependencies`) — blocked `nx run <project>:lint` (and therefore
  `nx run <project>:build`/`:test`, which depend on `lint`) with "package is
  not used by project".
- **Symptom:** `decimal.js` IS genuinely imported (`src/test/fixtures/decimal-nested.ts:18-19`,
  real `import Decimal from 'decimal.js'` / `import { Decimal as D2 }`) — but
  `apigen-core-client/tsconfig.lib.json:9-14` (and the equivalent in
  `apigen-cli`) excludes `src/test/**` from the lib's own compiled source
  set, so `@nx/dependency-checks`'s static import-scan (which follows the
  lib tsconfig's `include`) never sees the fixture's import and flags the
  declared dependency as unused. Confirmed pre-existing and unrelated to
  BUG-APIGEN-CORE-002/003's changes — untouched package.json, decimal.js
  usage untouched, reproduces on a clean worktree.
- **Why it matters:** blocked running `nx build`/`nx test` cleanly for these
  2 projects without `--skip-nx-cache`-style workarounds or bypassing nx
  entirely (raw `vite build`/`vitest run`); surfaced only as
  `Warning: command "eslint ." exited with non-zero status code` +
  `NX Running target … failed`, easy to mistake for a real regression.
- **Fix:** moved `decimal.js` from `dependencies` to `devDependencies` in
  both `package.json`s — semantically correct (it's genuinely test-only,
  never imported by shipped `src/lib/**` code) and `@nx/dependency-checks`
  scans `devDependencies` against the broader (test-inclusive) tsconfig, so
  the fixture import is now visible. `nx run apigen-core-client:lint` and
  `nx run apigen-cli:lint` both pass clean.
- **Status:** FIXED 2026-07-18.

### DEBT-APIGEN-LINT-002 — `apigen-engine-runtime` package.json has no `pnpm-lock.yaml` importer entry at all

- **Where:** `packages/apigen/apigen-engine-runtime/package.json`
  (`ajv`, `ajv-formats` — both genuinely imported in real, non-test source:
  `src/lib/validate-layer.ts:34-36`, `import Ajv from 'ajv'; import
  addFormats from 'ajv-formats'; import type { ErrorObject } from 'ajv';`).
- **Symptom:** `nx run apigen-engine-runtime:lint` fails with `@nx/dependency-checks`
  "The 'ajv' / 'ajv-formats' package is not used by 'apigen-engine-runtime'
  project" — despite the exact declared version (`^8.20.0` / `2.1.1`)
  matching what's actually installed at the workspace root
  (`node_modules/ajv/package.json` → `8.20.0`,
  `node_modules/ajv-formats/package.json` → `2.1.1`) and the import being
  real, unambiguous, non-test source. NOT the same root cause as
  DEBT-APIGEN-LINT-001 (this file is not tsconfig-excluded, and the version
  specifier matches). Root cause: `grep -n "packages/apigen/apigen-engine-runtime"
  pnpm-lock.yaml` returns ZERO matches — this package has no importer entry
  in `pnpm-lock.yaml` at all, so `@nx/dependency-checks` (which reads the
  lockfile-derived dependency graph, not raw `node_modules` disk state) has
  no edge to find between the project and `ajv`/`ajv-formats` regardless of
  what's declared in `package.json`. **Do NOT "fix" this by removing the
  dependency from `package.json` or adding it to `ignoredDependencies`** —
  either would hide a genuinely-used runtime dependency and, worse, an
  ESLint `--fix` run (`nx affected -t lint --fix`, e.g. via a pre-commit
  hook) will silently DELETE `ajv`/`ajv-formats` from `dependencies` again
  (reproduced: this happened once already during BUG-APIGEN-CORE-002's own
  commit and had to be caught + reverted by hand — see git history around
  2026-07-18 on `fix/apigen-reexport-extraction`).
- **Why it matters:** the ESLint auto-fix for this rule is destructive and
  wrong for this specific failure mode — it deletes a real dependency
  declaration instead of fixing the actual gap (a missing lockfile entry),
  which would break the package at install/runtime for anyone who trusts
  `pnpm install` to be authoritative.
- **Fix direction:** run `pnpm install` (or the workspace's equivalent
  lockfile-sync command) so `pnpm-lock.yaml` gains an importer entry for
  `packages/apigen/apigen-engine-runtime` — NOT attempted here: this repo
  mixes `pnpm-lock.yaml` and `package-lock.json` at the root (unclear which
  is authoritative) and a full lockfile resync of a monorepo this size is a
  bigger, higher-risk operation than this finding's scope warrants; flagging
  for a maintainer to run deliberately rather than as a side effect of an
  unrelated fix.
- **Status:** OPEN. Filed 2026-07-18.

### DEBT-APIGEN-CACHE-001 — persistent cache versions the ENTRY file only

A type imported from another file that changes (entry file untouched) is not detected —
same invalidation semantics the generator cache always had. Fix direction: include the
program's referenced-files set in the version stamp.

### DEFER-APIGEN-PERF-001 — worker_threads parallel extraction (stretch)

Per-source fan-out across workers for multi-source cold runs. Deferred: bundled-CLI
worker-entry complexity vs. modest gains now that warm runs are ~free.

---

## Revalidation (2026-07-04) — verified against current source

| Item | Status | Notes |
|------|--------|-------|
| DEBT-APIGEN-CACHE-001 | **STILL OPEN** | `persistentSchemasFor()` uses single `entry.version` stamp only (packages/apigen/apigen-core-client/src/lib/extraction-session.ts:133-145). Inline comment at packages/apigen/apigen-core-client/src/lib/extraction-session.ts:121-124 acknowledges the debt. No referenced-files set in any version stamp. Test does not cover cross-file import change. |
| DEFER-APIGEN-PERF-001 | **STILL OPEN** | Zero matches for `worker_threads`/`Worker` in `src/`. No implementation exists. |
