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

### BUG-APIGEN-CORE-003 — buildSchema OOMs on a large real-world re-export barrel (>20GB, never completes) — FIXED 2026-07-18

- **Where:** `src/lib/schema-builders/ts-json-schema.ts` (`buildSchema` /
  `buildSchemaUncached`) and `src/lib/extraction-session.ts`
  (`InternalExtractionSession.schemaCache`), exercised via
  `extract()`/`extractClasses()` over
  `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts` (read-only reference).
- **Root cause (confirmed with real profiling data, not guessed — see the
  full investigation trail this entry replaces, preserved in git history):
  a cache stampede.** `buildSchema()`'s session-cache wrapper checked
  `session.schemaCache.get(key)` and, on a miss, `await`ed
  `buildSchemaUncached(...)` and only THEN called `schemaCache.set(key,
  schema)` — there was no in-flight-request deduplication. `morph-walk.ts`'s
  union-variant handling (`walkType`, `Promise.all(members.map(m =>
  walkType(m, recurse, depth + 1)))`) launches concurrent sibling type
  resolutions; when several siblings independently needed the SAME type
  (measured: 1552 of the first 1605 internal `buildSchema` calls during a
  real run were the literally identical string `"SharedArrayBuffer"`,
  pulled in via `Buffer`/`Uint8Array`'s `ArrayBufferLike = ArrayBuffer |
  SharedArrayBuffer`), they could all miss the not-yet-populated cache
  simultaneously and each redundantly recompute the same expensive result.
  99.6% of `buildSchemaUncached` calls fell through to Path 2
  (`morph-walk.ts`'s `withResolvedType`, which does `sf.addTypeAlias(...)` →
  `.getType()` → `alias.remove()` on the shared entry `SourceFile`), and
  each Path-2 call forced a full reparse/retypecheck of the ~40-file
  dependency graph (better-sqlite3, onnxruntime-node, sqlite-vec
  native-binding types) — a perfectly monotonic heap climb with zero GC
  recovery (167MB → 3199MB over 1605 calls), consistent with the stampede
  (repeated *identical*, expensive work), not a leak in any single
  computation.
- **Fix 1 (primary — cache-stampede fix):** `session.schemaCache`
  (`extraction-session.ts`) now stores `Promise<Schema>`, not `Schema`.
  `buildSchema()` (`ts-json-schema.ts`) populates the cache with the
  **pending** promise SYNCHRONOUSLY — before anything is awaited — so a
  concurrent sibling call for the identical `(sourceFile, tsconfig,
  typeText)` key joins the SAME in-flight computation instead of missing
  the cache and redundantly recomputing. There is no `await` between the
  cache-miss check and `schemaCache.set`, so the race window is closed
  entirely (JS is single-threaded). A rejected computation evicts its own
  cache entry (`.catch` deletes the key before rethrowing) so a later,
  independent call gets a fresh attempt rather than replaying a stale
  failure forever. The persistent (cross-run) tier and the `session ===
  undefined` uncached path are unaffected (no concurrent session sharing in
  either case, so no dedup was needed there).
- **Fix 2 (discovered DURING verification of Fix 1 — a NEW deadlock,
  introduced by Fix 1 itself, not present before it): self-referential /
  recursive types.** A type like `interface Node { children: Node[] }` (or
  any `JSONValue`-shaped recursive alias) walks, via Path 2's
  property/element recursion, back into the IDENTICAL `(sourceFile,
  tsconfig, typeText)` key that is still being resolved higher up the SAME
  call chain. Under Fix 1 alone, that recursive call would find its own
  ancestor's PENDING promise already cached and `await` it — a genuine
  deadlock, since that promise can only resolve once the very call that's
  blocked on it returns. **Caught by live verification, not by inspection:**
  running the real repro after Fix 1 alone produced no crash and no OOM,
  but the process hung indefinitely (flat CPU time, flat heap, `kevent`/
  `__psynch_cvwait`-only sampled stacks — event loop genuinely idle, not
  slow). Fixed by threading an explicit `_ancestors: ReadonlySet<string>`
  parameter through `buildSchema()`'s two recursive re-entry points inside
  `buildSchemaUncached` (`buildMapSetTupleSchema`'s element recursion and
  Path 2's `withResolvedType`/`walkType` recursion): when a key is found to
  be its own ancestor (a genuine cycle, NOT the same thing as "any in-flight
  key anywhere in the session" — concurrent unrelated siblings for the same
  key still dedupe normally), the cache is bypassed for that one cyclic
  occurrence and a permissive `{}` fallback is returned — the same
  "can't fully frame it" convention `walkType`'s own `MAX_DEPTH` guard
  already uses for runaway recursion — so the ancestor call is free to
  finish and populate the cache correctly for every other caller.
- **Verification (real, unstubbed `extract()` + `extractClasses()` against
  the sox-ecosystem fixture, `--max-old-space-size=4096`, run twice for
  reproducibility):**
  - **Before (Fix 1 alone, no Fix 2):** did not OOM, did not crash — hung
    indefinitely instead (confirmed via `sample`: all threads parked in
    `kevent`/`__psynch_cvwait`, CPU time flat across a 30s+ window). Killed
    manually; this state would never self-resolve.
  - **Before either fix (original bug):** crashed with a genuine V8
    `FatalProcessOutOfMemory` at `--max-old-space-size=3072` (from the prior
    diagnosis pass, reproduced independently — see superseded investigation
    detail in git history for this entry).
  - **After both fixes:** completes successfully, twice in a row —
    `extract()`: 140 operations; `extractClasses()`: 6 operations; **146
    total**, matching the expected count exactly. Run 1: wall clock 10.60s,
    peak RSS 1293.1MB, peak heapUsed 976.9MB. Run 2 (fresh process): wall
    clock 10.93s, peak RSS 1265.7MB, peak heapUsed 983.5MB. Both comfortably
    under the 4096MB cap that previously either OOM'd or hung.
  - Fix 2 was **necessary**, not optional caution: Fix 1 alone was verified
    live to hang (not just theorized) on the real fixture, which is why both
    fixes are required together — see the negative-control note below.
- **Tests:** `src/test/schema-cache-stampede.spec.ts` (4 new tests, all
  independently negative-controlled by temporarily reverting each fix and
  confirming the corresponding test goes red for the RIGHT reason, then
  restoring): (1) N=12 concurrent `buildSchema()` calls for an identical
  cold key trigger the real underlying Path-2 resolution (`withResolvedType`,
  spied independently of the session's own hit/miss counters) exactly the
  cold baseline number of times, not multiplied by N — reverting Fix 1
  reproduces the exact 2×N stampede (24 calls instead of 2) this test is
  named for; (2) a sequential second call for the same key adds zero further
  resolution calls; (3) a genuinely rejected computation (forced via a
  mocked `buildMapSetTupleSchema` throw — the one call in
  `buildSchemaUncached` not already self-healing via its own try/catch) is
  evicted from the cache rather than cached as a permanent failure; (4) a
  self-referential interface (forced through Path 2 by importing `zod`, the
  same BUG-APIGEN-CORE-001 mechanism the real file itself exercises) resolves
  within a hard timeout instead of hanging — reverting Fix 2's ancestor guard
  reproduces the exact hang this test is named for. Full existing suite
  stays green: `apigen-core-client` 240/240 (236 pre-existing + 4 new),
  `apigen-cli` 113/113.
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

### BUG-APIGEN-CORE-004 — `isSerializableType()`'s textual allow-list doesn't recognize `Record<K,V>` (or other generic utility-type wrappers), causing false-negative skips on legitimately serializable consts

- **Where:** `src/lib/extract.ts:769-783`, `isSerializableType(typeText: string)`.
  It's a purely textual heuristic over `type.getText()` — checks for a fixed
  set of primitive keywords, quote/digit-prefixed literals, and `{`/`[`-
  prefixed or `[]`-suffixed text; anything else falls through to `return
  false`.
- **Symptom:** discovered while reconciling BUG-APIGEN-CORE-002's "146
  operations" number against the raw export count of
  `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts` (read-only
  reference). That file exports 12 `VariableDeclaration`-backed consts; 10
  extract correctly (Shape 3's serializable-data path), 2 are silently
  skipped with `console.warn('[apigen-core] Skipping non-callable,
  non-serializable export: …')`: `SCOPE_WEIGHTS` (`recall.ts:987`, type
  `Record<string, number>`) and `SUPPORTED_GRAPHIFY_SHAPES`
  (`extensions.ts:413`, type `Record<string, GraphifyShapeSpec>`, where
  `GraphifyShapeSpec` is a plain data interface at `extensions.ts:399`). Both
  are trivially JSON-serializable — a `Record` of numbers and a `Record` of
  plain-object literals — but `type.getText()` renders as `Record<string,
  number>` / `Record<string, GraphifyShapeSpec>`, which matches none of
  `isSerializableType`'s patterns (doesn't start with `{`/`[`, isn't a bare
  primitive keyword, isn't a literal) and falls through to `false`.
- **Not caused by, or specific to, the BUG-APIGEN-CORE-002 re-export fix** —
  this heuristic is untouched by that fix and would misclassify a
  `Record<…>`-typed const identically if it were declared locally in the
  entry file rather than re-exported. It was simply never exercised against
  a `Record`-typed const before now (this file previously only reached 2
  operations total, neither a variable-backed one).
- **Why it matters:** low severity, narrow scope — only affects Shape 3's
  serializable-data-const path, and only for type-text shapes the heuristic
  doesn't special-case (confirmed: `Record<K,V>` here; likely also `Map<K,V>`,
  `Partial<T>`, `Readonly<T>`, and any other generic utility-type wrapper
  around an otherwise-serializable shape, by the same textual-matching logic,
  though only `Record<K,V>` was actually observed in this file).
- **Fix direction (not attempted — needs its own investigation):** either (a)
  extend the textual allow-list with a few more recognized generic-wrapper
  prefixes (`Record<`, `Map<`, `Partial<`, `Readonly<`, `Array<`), which is
  cheap but still an incomplete allow-list approach, or (b) replace the
  textual heuristic with an actual `Type` object inspection (the function
  already has `decl.getType()` available at the two call sites — no text
  round-trip needed) checking structural properties (has index signature /
  is a plain object type / has no call signatures) rather than pattern-
  matching `getText()`'s rendering, which is the more robust fix.
- **Status:** OPEN. Filed 2026-07-18 during BUG-APIGEN-CORE-002 verification
  (export-count reconciliation, self-verified via a standalone ts-morph
  script diffing `sf.getExportedDeclarations()` names against `extract()`'s
  output — not from the dispatched agent's report).

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
  what's declared in `package.json`.
- **Why it matters:** this repo's pre-commit hook runs `nx affected -t lint --fix`
  on every commit. Its auto-fix for "unused dependency" is DELETE THE
  DEPENDENCY FROM package.json — which for this specific false-positive
  deletes a genuinely-used runtime import, silently, on every commit that
  touches an affected project. **Reproduced twice in one session**: once
  during this fix's first commit attempt (`git commit`'s pre-commit hook
  auto-fixed + re-staged the deletion into the commit without prompting),
  and again on the very next commit after I'd manually restored it —
  confirming this isn't a one-off, it will keep recurring on every future
  commit until addressed.
- **Fix applied (containment, not the real fix):** added
  `"ignoredDependencies": ["ajv", "ajv-formats"]` to
  `apigen-engine-runtime/.eslintrc.json`'s `@nx/dependency-checks` override
  (matching the pre-existing `ignoredDependencies: ["zod"]` pattern in
  `apigen-core-client/.eslintrc.json`), and restored `ajv`/`ajv-formats` to
  `package.json` `dependencies`. Verified `nx run apigen-engine-runtime:lint`
  passes AND `nx run apigen-engine-runtime:lint --fix` no longer touches
  `package.json` (both checked directly, not assumed). This was the pragmatic
  call given the deletion loop was actively reproducing in real time and
  blocking every subsequent commit in this session — an earlier draft of
  this entry said "do NOT fix via ignoredDependencies", which was the right
  instinct for a first-pass diagnosis but not survivable in practice once
  the destructive auto-fix reproduced a second time.
- **Fix direction (the REAL fix, still not done):** run `pnpm install` (or
  the workspace's equivalent lockfile-sync command) so `pnpm-lock.yaml`
  gains a real importer entry for `packages/apigen/apigen-engine-runtime` —
  NOT attempted here: this repo mixes `pnpm-lock.yaml` and `package-lock.json`
  at the root (unclear which is authoritative) and a full lockfile resync of
  a monorepo this size is a bigger, higher-risk operation than this
  finding's scope warrants. Once that's done, the `ignoredDependencies`
  entry added above should be removed again (it's a workaround for the
  lockfile gap, not a permanent policy).
- **Status:** OPEN (containment fix applied 2026-07-18; root cause — the
  missing lockfile entry — still needs a deliberate `pnpm install` by a
  maintainer).

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
