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
- **UPDATE (2026-07-18, same day): root cause found, with data — supersedes
  the "plausibly..." paragraph above.** Reproduced independently (own run,
  not reused from the original report) with temporary instrumentation added
  directly to `buildSchemaUncached` (call-count + heap snapshot per call,
  Path 1 vs Path 2 marker) and `withResolvedType` (ts-morph `Program` object
  identity before/after each call), gated behind `APIGEN_OOM_PROBE=1` so it's
  zero-cost when unset — added, run, and **reverted** (not committed; this
  repo's source is unchanged by the investigation itself).
  - Real (unstubbed) `extract()` against the same fixture, `--max-old-space-size=3072`:
    crashed with a genuine V8 `FatalProcessOutOfMemory` (SIGABRT, exit 134)
    — **before even finishing `extract()`** (never reached `extractClasses()`,
    let alone the 146-operation total). Died at internal `buildSchema` call
    #1605.
  - **Path 1 vs Path 2, measured, not assumed:** of the first 1605 internal
    `buildSchema` calls, only **6 hit Path 1** (the cheap, LRU-cached
    `ts-json-schema-generator` route); **1597 (99.6%) fell through to Path 2**
    (`morph-walk`'s `addTypeAlias`/`withResolvedType`). This file's real
    domain types are overwhelmingly NOT the "simple named interface" shape
    Path 1 is optimized for.
  - **Every single sampled Path-2 call rebuilds the ts-morph `Program`:**
    instrumented `project.getProgram().compilerObject` identity before/after
    each `withResolvedType` call — `programChanged=true` on 100% of the 44
    sampled calls (not "plausibly," confirmed by direct object-identity
    comparison). Each rebuild re-parses/re-typechecks the full ~40-file
    dependency graph (better-sqlite3, onnxruntime-node, sqlite-vec native
    binding types included), and nothing in the observed heap trend indicates
    any of it is ever released.
  - **Heap trend is a clean, unbroken monotonic climb — no GC recovery at
    any point:** call#1→heap 167MB, #101→390MB, #401→774MB, #701→1410MB,
    #1001→2028MB, #1301→2590MB, #1601→3165MB (crash at #1605, heap 3199MB
    against the 3072MB cap). ~2MB of heap added per call, zero dips, the
    entire way — the signature of objects that are never becoming garbage,
    not of a large-but-bounded working set.
  - **The single biggest, and most actionable, finding: 1552 of the 1605
    calls (97%) are the LITERALLY IDENTICAL raw type-text string
    `"SharedArrayBuffer"`** (Node's `Buffer`/`Uint8Array` types pull in
    `ArrayBufferLike = ArrayBuffer | SharedArrayBuffer` — unsurprising given
    memory-core stores embeddings/blobs pervasively). Every one of those 1552
    calls reached `buildSchemaUncached` — i.e., every one was a `session
    .schemaCache` **miss** on an IDENTICAL `(sfPath, tsconfig, typeText)` key,
    despite `extract()` using exactly one shared session for the whole file
    (confirmed by reading `extract()`'s wrapper — one `session` object is
    created and threaded through every operation, not recreated per-op).
  - **Likely mechanism for the miss (plausible, not yet proven with a
    targeted repro):** `ts-json-schema.ts:802-812`'s cache only stores the
    *resolved value*, after `await`, never an *in-flight promise* — there is
    no request-deduplication for concurrent identical keys. Sequential loops
    (the top-level per-operation loop in `extract.ts`, and the object-property
    loop in `morph-walk.ts:238-267`) can't produce this on their own, but
    `morph-walk.ts`'s union-variant branch (`~line 179`,
    `Promise.all(members.map(m => walkType(m, recurse, depth+1)))`) launches
    concurrent sibling resolutions — if several of those siblings each walk
    down into a Buffer-touching property before the first `SharedArrayBuffer`
    resolution has resolved and populated the cache, ALL of them see a miss
    simultaneously and each pays the full (Program-rebuilding) Path-2 cost
    independently. This is a textbook cache-stampede: the fix is to cache the
    in-flight `Promise`, not just its resolved value, so concurrent identical
    requests share one computation.
  - **Compounding, not competing, causes:** the stampede (repeated *identical*
    work) and the per-call Program-rebuild-without-release (each unit of that
    repeated work being unboundedly expensive) multiply together — fixing
    only one likely still leaves the other as a real, if smaller, problem.
- **Fix direction (updated, still not attempted):**
  1. **Highest-leverage, do first:** cache in-flight promises in
     `session.schemaCache`, not just resolved values (`Map<string,
     Promise<Schema>>` instead of `Map<string, Schema>`, or equivalent) — this
     alone should collapse the 1552 redundant `"SharedArrayBuffer"` calls
     (and any other stampede-prone type) down to 1, independent of whether
     Path 2 itself gets cheaper.
  2. Confirm/deny whether `Program` non-release across repeated Path-2 calls
     is a genuine retention (something holding a strong reference to old
     `ts.Program`/`DocumentRegistry` entries after `alias.remove()`) versus
     "correctly collectible but GC hasn't run" — force `global.gc()` between
     calls under `--expose-gc` and see whether heap actually drops; if it
     does, this may already be adequately addressed by fix (1) reducing call
     volume; if it doesn't, ts-morph's `Project`/compiler-host retention needs
     its own fix (candidate: recycle the `Project`/`Program` every N Path-2
     calls, or investigate whether ts-morph exposes an explicit
     `documentRegistry.releaseDocument`-equivalent hook for the mutated
     versions).
  3. Consider special-casing extremely common global/lib scalar-adjacent
     unions (`ArrayBufferLike`, and anything else that shows up with
     `SharedArrayBuffer`-level frequency) the same way `SCALAR_SCHEMAS`
     already special-cases `Uint8Array`/`Buffer` — if `Buffer`'s own fields
     are already mapped to `{type:string,format:byte}` without walking their
     structure, a stray reference to the underlying `ArrayBufferLike` union
     inside `Buffer`'s prototype shape probably shouldn't be walked
     structurally either.
- **Status:** OPEN — root cause now understood and evidence-backed; fix not
  attempted (this update is diagnosis only, per the "no code changes to
  ts-json-schema.ts/morph-walk.ts" scope of BUG-APIGEN-CORE-002's PR). Filed
  2026-07-18, updated same day after independent re-investigation.

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
