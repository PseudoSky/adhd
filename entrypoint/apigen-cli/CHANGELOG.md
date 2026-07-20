# Changelog — @adhd/apigen-cli

All notable changes to this project are documented here.

## Unreleased

### Fixed

- **FEAT-APIGEN-019** — CLI's `--type` plugin discovery was undiscoverable: `generate`'s
  `--type` help text was a hardcoded, already-stale string (missing `py-flask`/`py-grpc`,
  two of the 7 real targets); `run`'s and `run-registry`'s `--type` help text said nothing
  but `'Output target'`; there was no `list-types`/`--list` command at all; and `run`'s
  `!plugin?.run` check conflated two distinct failures into one message — a genuinely
  unrecognized `--type` (e.g. `express`, a plausible near-miss of the real key `api-express`)
  was reported identically to a real, registered generate-only plugin (`jsonschema`, `cli`)
  that legitimately has no `run()` — "Plugin express does not support run mode" instead of
  "Unknown --type: express". Reported live: the user hit exactly this typo case against the
  built CLI. Root cause: every one of these surfaces (`generate.ts`, `generate-registry.ts`,
  `run.ts`, `run-registry.ts`) read/derived its `--type` text independently instead of from
  one source of truth, so they drifted from the real `plugins` map (`index.ts:17-30`) and
  from each other. Fixed by adding `src/lib/plugin-registry.ts` as the single source of truth
  — `describeTypeOption()`/`describeRunTypeOption()` for Commander `--type` help text (the
  latter scoped to only run-capable ids), `unknownTypeError()`/`unsupportedRunError()` for the
  two now-distinct error branches, and `formatTypesList()` for the new `apigen list-types`
  command (`src/lib/commands/list-types.ts`, registered in `index.ts`) — every one reading
  `Object.keys(plugins)` / `plugin.run` live, so they can never drift from the registry or
  from each other again. `run.ts`/`run-registry.ts`'s single `if (!plugin?.run) throw …` is
  now two checks: `if (!plugin) throw unknownTypeError(...)` then
  `if (!plugin.run) throw unsupportedRunError(...)` — the latter lists the generate-only and
  run-capable subsets separately. Verified end-to-end against the real registry (all 8 keys):
  `apigen list-types` prints every id with its `plugin.description` and generate/run
  capability; `apigen run --type express ...` now throws `Unknown --type: express. Available:
  mcp, jsonschema, api-fastify, api-express, cli, cli-output, py-flask, py-grpc` (previously
  the misleading "does not support run mode"); `apigen run --type jsonschema ...` throws
  `Plugin jsonschema does not support run mode. Generate-only plugins: jsonschema, cli,
  cli-output. Run-capable plugins: mcp, api-fastify, api-express, py-flask, py-grpc.`; `apigen
  generate --help`/`apigen run --help` show live, correctly-scoped `--type` option text.
  Covered by `src/test/plugin-registry.spec.ts` (registry-derivation unit tests — proves
  every helper's output changes when a fixture registry gains/loses a plugin, not just that
  it matches a fixed string), `src/test/list-types.spec.ts` (the new command, same
  derivation proof), and new cases in `src/test/run.spec.ts`/`src/test/generate.spec.ts`
  (the unknown-vs-unsupported-run-mode split, and `--help` text scoping for `run` vs
  `generate`). Deferred out of scope: `py-flask`/`py-grpc`'s unconditional eager imports
  (unpublished on npm — filed as BUG-APIGEN-037, since it's a plugin-*loading* concern, not
  a `--type` text/list-derivation concern).

- **BUG-APIGEN-021** — `apigen run --source <file> --type <plugin>` crashed with
  `Error: Cannot find module './x.js'` (`MODULE_NOT_FOUND`) against any real
  `--source` whose package has no `"type": "module"` (the common default for
  internal workspace libs, e.g. `@adhd/sox-memory-core`) and that internally
  imports a sibling module via a NodeNext-style `./x.js` specifier resolving to
  `./x.ts` on disk. `importSource()` (`src/lib/import-source.ts`) registered
  only `tsx/esm/api`'s ESM loader hook before the dynamic `import()`; when the
  target's format resolves to CommonJS, Node's ESM loader routes it through the
  CJS translator, which performs a real `require()` that only `tsx/cjs/api`'s
  hook patches — the ESM-only hook never saw it, so the `.js` → `.ts` extension
  mapping never applied. Fixed by also registering `tsx/cjs/api` for the
  duration of the import (mirrors what the full `tsx` CLI does — it patches
  both loaders). Covered by
  `src/test/e2e/import-source-cjs-format.spec.ts`, which spawns the BUILT bin
  as a real `node` child process (the only way to reproduce this — a
  vitest-in-process unit test never hits Node's loader) against a fixture
  reproducing the exact shape (`src/test/fixtures/cjs-format-js-import/`);
  verified red against the pre-fix code (same `MODULE_NOT_FOUND` as the
  original report) and green after.

- **BUG-APIGEN-026** — `apigen run --type api-express/api-fastify` crashed EVERY call to
  any function with a plain named-type parameter (interface, type alias — not a scalar
  apigen special-cases, not inline/anonymous) with
  `{"code":"internal","message":"can't resolve reference #/definitions/<Name> from id #"}`,
  a compile-time AJV failure that fired regardless of the actual input sent. Root cause:
  `ts-json-schema-generator`'s own default (`topRef: true`, confirmed in the installed
  package's `Config.js`) wraps every named-type schema as `{ $ref: "#/definitions/X",
  definitions: { X: {...} } }`; `apigen-core-client`'s `runScalarAwareGenerator()`
  (`schema-builders/ts-json-schema.ts`) never overrode it, and nothing dereferenced the
  result before `extract.ts` spliced it into a nested property position inside the
  composed function schema — where `$ref`'s root-relative resolution permanently dangled
  once AJV compiled the full schema (one schema per function, no shared registry).
  Reported live against a real consumer (`agent-browser`'s `search(provider:
  ProviderName, ...)`); reproduced exactly via `apigen generate --type jsonschema`
  against the unmodified source. Fixed by passing `topRef: false` in Path 1's
  `Config`, which inlines the entry type directly instead of wrapping it — verified via a
  standalone `createGenerator()` call before applying, then end-to-end against the real
  file (`POST /agent-browser/search` now returns `200` instead of crashing). Does **not**
  fully solve genuinely self-referential/cyclic named types, which still need an internal
  `$ref` and would carry the identical class of bug if ever embedded nested — tracked as
  a known residual gap, not yet filed as a separate item (no reproducing case found).
  Covered by `apigen-engine-runtime/src/test/named-type-param.spec.ts` (a real
  `generateSchemas` → `composeSchemas` → `Ajv.compile` pipeline test, not hand-built
  schema fixtures — the existing `ts-json-schema.spec.ts` dangling-ref checks only walk
  a schema fragment in isolation and would not have caught this); verified red against
  the pre-fix code (identical `"can't resolve reference"` error) and green after.

- **BUG-APIGEN-027** — even after BUG-APIGEN-026's fix, any call that legitimately
  omitted an optional `number`-typed parameter (e.g. `search()`'s `maxContentSize`,
  `timeoutMs`, `maxAttempts`, `challengeWaitMs` — all valid to omit per the AJV schema,
  none in `required`) crashed dispatch with `{"code":"internal","message":"[number-
  special] unrecognized wire value at \"\": undefined. Expected a number or one of NaN,
  Infinity, -Infinity."}`, before the target function was ever called. Root cause:
  `apigen-engine-runtime/src/lib/dispatch.ts`'s `decodeArg()` only guarded on whether the
  parameter's *schema node* was defined, not whether the caller actually *sent* a value
  for it — so every declared optional param the caller omitted was still passed through
  `_transcoder.decode(undefined, node)`, which for a bare `{type:'number'}` node resolves
  to `numberSpecialCodec` and correctly rejects `undefined` in strict mode. The object-
  property walk in `runmode.ts`'s `encodeNode`/`decodeNode` already guards `v !==
  undefined` internally; `dispatch.ts`'s per-parameter call site was the one place that
  lacked the equivalent guard, because it calls the transcoder once per declared param
  name rather than walking a nested object schema. Fixed by adding `wire === undefined`
  to `decodeArg()`'s existing early-return guard — an omitted optional value now passes
  through as `undefined` (so TS default parameters apply normally at the function
  boundary), matching how the AJV validation layer already treated it as valid. Covered
  by three new cases in `apigen-engine-runtime/src/test/dispatch.spec.ts` (omitted
  optional param doesn't throw; omitted param arrives as `undefined` at the fn boundary;
  an explicitly-provided optional param still decodes normally); verified red against the
  pre-fix code (identical `number-special` error — including on the "explicitly
  provided" case, since a *different* still-omitted optional param in the same call
  tripped it too) and green after. Verified end-to-end against the real `search()`
  consumer: `POST /agent-browser/search` with only `{provider, query}` now completes
  (`200`, real dispatch to a live network search) instead of crashing before dispatch.

- **BUG-APIGEN-028** — `apigen run`/`generate` (single-source and
  `-registry` variants) still ran the old v1 extraction pipeline by default;
  v1 silently dropped every re-exported operation from a source file
  (`export { x } from './other.js'`), producing e.g. 2 routes instead of
  140+ for a realistic re-export-barrel file (confirmed live against
  `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts`, read-only
  reference). Passing `--v2` fixed the log line ("extracted 140
  operations") but did NOT fix the actually-served routes:
  `orchestrator.ts`'s `buildDescriptor()` had a "Step 5" that independently
  re-ran the buggy v1 extractor a second time to build the `ComposedSchemas`
  every plugin's `generate()`/`run()` actually dispatches against, silently
  discarding the correct extraction from Steps 1-4 — so `--v2` alone,
  without also fixing Step 5, remained broken. Root cause: commit
  `556d02ee` ("apigen v2 — 18-package TS→API toolchain") introduced the v2
  orchestrator behind a cautious `--v2` opt-in flag for staged rollout; the
  follow-up step of flipping the default (or retiring v1) was never done
  and fell through the cracks. Fixed by retiring v1 entirely rather than
  patching it (avoids two parallel implementations drifting again):
  `generate.ts`/`run.ts` now run `orchestrateGenerate`/`orchestrateRun`
  unconditionally (see Removed, below, for the `--v2` flag itself);
  `generate-registry.ts`/`run-registry.ts` rewired from a per-package
  `runPipeline()` loop to build one `SourceEntry[]` and pass it through the
  same orchestrator in a single call, which also surfaced and fixed a real
  latent bug where `orchestrateRun` matched `packageSchemas` entries back to
  their `SourceEntry` by `s.file === p.importPath` (only ever worked by
  coincidence for single-source `run`; silently failed to resolve for the
  registry commands' distinct `file`/`importPath` pair) — fixed by matching
  on namespace instead. Deleted (apigen-core-client side, see
  `BUG-APIGEN-CORE-005` in that package's BACKLOG.md for the extractor-side
  half of this fix): `generateSchemas()`, the three v1 extractors,
  `runPipeline()` (`entrypoint/apigen-cli/src/lib/pipeline.ts`). Covered by
  the existing `generate.spec.ts`/`run.spec.ts`/`orchestrator.spec.ts`/
  `integration/schema.spec.ts` suites, rebuilt against the real
  `extract()`/`composeSchemas()` path in place of the deleted
  `generateSchemas()` (112/112 green, down from 113 — one test removed
  whose entire premise, "behavior is the same whether or not `--v2` is
  passed," no longer applies with only one path left; nothing it protected
  against is now uncovered). Real-world verification: 140 operations
  extracted → 130 real routes served (up from 2), including two
  previously-invisible routes curled and confirmed responding correctly.
  Surfaced, but does not fix (filed separately as **BUG-APIGEN-029**, open):
  a pre-existing `$ref`/ajv-strict-mode dispatch failure on functions taking
  complex external types (e.g. `better-sqlite3.Database`) as params —
  confirmed identical under the old v1 2-route path, so not a regression
  from this fix; it was simply unreachable before because v1 never exposed
  those re-exported routes at all.

- **BUG-APIGEN-036** — post-v1-retirement code review caught
  `apigen-engine-runtime/src/test/named-type-param.spec.ts` (the real-pipeline
  regression test authored for BUG-APIGEN-026) still calling the deleted v1
  `generateSchemas()`, which `7c66413d` (v1 retirement) had removed along with
  `lib/generate-schemas.ts` — every one of its 3 test cases failed with
  `TypeError: generateSchemas is not a function`, meaning BUG-APIGEN-026's
  dangling-`$ref` regression test had zero coverage on this branch. Fixed by
  rewriting all 3 call sites to the v2 equivalent: `extract({ sourceFile })`
  → `Operation[]`, adapted into `composeSchemas()`'s expected `GeneratedSchemas`
  shape via a `toGeneratedSchemas()` helper added to the test file (`kind:
  'action'` operations only, keyed by the terminal path segment's raw
  spelling) — the exact same adaptation `buildDescriptor`'s Step 5 performs in
  `entrypoint/apigen-cli/src/lib/orchestrator.ts`, reproduced locally since
  it isn't exported as a standalone helper. The test's real-pipeline intent
  (extract → compose → real `Ajv.compile`, not hand-built fixtures) and all
  three original assertions (compiles without a dangling `$ref`, a valid
  `pick('a')` call dispatches, an invalid enum value is rejected) are
  unchanged. Confirmed the fix is semantically equivalent, not just
  compiling: the `topRef: false` fix from BUG-APIGEN-026 is still present
  and unchanged in `schema-builders/ts-json-schema.ts`, so this test still
  exercises the real code path the original regression test was written
  against. Verified green:
  `npx nx test apigen-engine-runtime --testFile=src/test/named-type-param.spec.ts`
  (3/3 passing).

- **BUG-APIGEN-CORE-001 re-wired (v1 retirement)** — post-v1-retirement code
  review found that v1's deleted `generate-schemas.ts` called
  `validateSchemaRefs()` (`@adhd/apigen-base-logical`) on every function's
  built `input`/`output` schema, pooling `$defs` across all functions in a
  source file, and threw a clear `Schema validation failed for function "X"`
  error at generate time if any `$ref` was unresolvable — an early,
  well-scoped catch for the exact dangling-`$ref` bug class BUG-APIGEN-026
  hit at runtime instead. This safety net was silently dropped when v1 was
  deleted: `validateSchemaRefs` was never called anywhere in the v2 path
  (`extract.ts`, `extraction-session.ts`, `orchestrator.ts`,
  `compose-schemas.ts`) — the only remaining reference was a local
  re-implementation inside `apigen-core-client/src/test/ts-json-schema.spec.ts`,
  which gave false confidence since it never touched the real pipeline.
  Fixed by importing the real `validateSchemaRefs` from
  `@adhd/apigen-base-logical` and wiring it into `composeSchemas()`
  (`apigen-core-client/src/lib/compose-schemas.ts`) — the v2 equivalent
  insertion point to v1's `generate-schemas.ts`, since that's where all of a
  namespace's functions are present together in one pass. Pools `$defs`
  across every function in the `GeneratedSchemas` passed in and validates
  each function's `input`/`output` against the pooled dictionary before
  composing, throwing the same function-scoped error v1 did. Covered by
  three new cases in `apigen-core-client/src/test/compose-schemas.spec.ts`:
  a dangling `$ref` (referencing a `$def` never defined by any function)
  throws `Schema validation failed for function "pick"`; a `$ref` that
  resolves against a `$def` pooled from a *different* function does not
  throw (proves cross-function pooling, not per-function-only validation);
  a schema with no `$defs` at all is left unvalidated (matches v1's
  behavior — a bare `$ref` with no `$defs` anywhere is a structural problem
  left to the downstream AJV compile, not this check). Verified red (test
  fails with the `validateComposedRefs()` call temporarily removed) and
  green (restored) by hand before landing.

- **BUG-APIGEN-030** — any `x-apigen-logical`-tagged param (union OR
  nominal/branded) crashed EVERY call on `api-express`/`api-fastify` with
  `strict mode: unknown keyword: "x-apigen-logical"` — a 500 regardless of
  input, not a validation rejection. Root cause: apigen's own schema builders
  (`apigen-core-client/src/lib/schema-builders/union.ts`,
  `.../schema-builders/nominal.ts`, and the inline-union path in
  `.../schema-builders/morph-walk.ts:181`) tag union/nominal schema fragments
  with advisory `x-apigen-logical`/`x-apigen-codec`/`x-apigen-ctor`/
  `x-apigen-tojson` keys (`X_APIGEN_LOGICAL` etc. from
  `@adhd/apigen-base-logical/src/lib/descriptor-ext.ts`) plus an
  OpenAPI-style `discriminator` object on union fragments
  (`morph-walk.ts:172-182`) — read back by `union-codec.ts`/`nominal-codec.ts`
  at decode time, never declared to Ajv. `apigen-engine-runtime/src/lib/
  validate-layer.ts`'s single module-level `Ajv({ allErrors: true })`
  singleton (line 51; both `validateLayer` and `makeValidateLayer` share it —
  there is only one construction site, not two as originally suspected) never
  registered any of these five keywords, and Ajv 8's default `strict: true`
  throws `strict mode: unknown keyword` the first time `ajv.compile()` runs
  on any schema carrying one. Confirmed the impact is wider than
  `x-apigen-logical` alone: `discriminator` itself is also rejected by
  default Ajv (`strict mode: unknown keyword: "discriminator"`), and Ajv's
  own built-in `discriminator: true` option is NOT a fix — it enforces its
  own OpenAPI discriminator semantics and explicitly throws
  `discriminator: mapping is not supported` against the `mapping` object
  apigen's `discriminator` fragment carries (verified by direct reproduction
  with `ajv@8.20.0`, the installed version). Fixed by registering all five
  keys (`X_APIGEN_LOGICAL`, `X_APIGEN_CODEC`, `X_APIGEN_CTOR`,
  `X_APIGEN_TOJSON`, `'discriminator'`) as no-op `ajv.addKeyword({ keyword,
  valid: true })` annotations at the singleton's construction site
  (`validate-layer.ts:73-82`), preserving `strict: true`'s other protections
  rather than disabling strict mode wholesale. Covered by a new
  `apigen-engine-runtime/src/test/bug-apigen-030.spec.ts` (5 cases):
  `[apigen-030.1]`-`[apigen-030.3]` run the REAL `extract()` →
  `composeSchemas()` pipeline against a new fixture
  (`test/fixtures/bug-apigen-030.ts`, an inline `Dog | Cat` discriminated
  union param) proving the real `oneOf`+`discriminator`+
  `x-apigen-logical:"union"` shape `morph-walk.ts` actually emits today
  compiles and a real call reaches dispatch instead of crashing;
  `[apigen-030.4]`/`[apigen-030.5]` hand-build schemas using the real
  `X_APIGEN_LOGICAL`/`X_APIGEN_CODEC`/`X_APIGEN_CTOR`/`X_APIGEN_TOJSON`
  constants (not string literals) to cover the two keys the current
  extraction pipeline doesn't yet reach for class-typed nominal params (see
  BUG-APIGEN-036 below) and the `discriminator.mapping` shape Ajv's built-in
  option rejects. Verified red pre-fix (all three previously-failing cases
  reproduced the exact BACKLOG error strings —
  `strict mode: unknown keyword: "x-apigen-logical"` and
  `strict mode: unknown keyword: "discriminator"` — by temporarily reverting
  the `addKeyword` registration) and green post-fix by hand before landing.
  Full suite verified clean: `apigen-engine-runtime` 131/131,
  `apigen-plugin-api-express` 31/31, `apigen-plugin-api-fastify` 43/43 (run
  directly via `vitest run --config <project>/vite.config.ts`, bypassing
  `nx test`'s cross-project lint-dependency chain, which was independently
  broken by an unrelated, concurrently in-flight edit to
  `apigen-core-client/src/test/extract.spec.ts` from another session sharing
  this worktree — not touched by this fix).

  **Also discovered, filed separately (not fixed by this change):**
  `buildNominalSchema`/`buildUnionSchema` (the class-based nominal/union
  schema builders in `schema-builders/nominal.ts`/`union.ts`) are not wired
  into the real `extract()`/`composeSchemas()` pipeline for any function
  parameter — confirmed no call site outside their own spec files, and
  `orchestrator.ts`'s `extractClasses()` usage is for constructor/
  instance-method operations, not embedding nominal `$def`s into other
  functions' input schemas. Filed as BUG-APIGEN-036 in the Open section
  below.

### Changed

- **v1 extraction pipeline retired — v2 orchestrator is now the ONLY
  extraction path** (BUG-APIGEN-028 / BUG-APIGEN-CORE-005). `generate`,
  `run`, `generate-registry`, and `run-registry` all now unconditionally run
  the `detect → extract → merge → collision-check → gen/run` v2 pipeline.
  See BUG-APIGEN-028 above for the full root-cause writeup and verification
  numbers.

### Removed

- **`--v2` flag removed from `generate` and `run`.** It selected between the
  (now-deleted) v1 pipeline and the v2 orchestrator; with only one pipeline
  left, the flag has no meaning. Removed cleanly rather than kept as a
  deprecated no-op — there's no prior flag-removal precedent in this
  changelog to follow a softer convention, and a silently-ignored flag would
  be more confusing than an explicit "unknown option" error for the rare
  script still passing it. **Migration:** delete `--v2` from any existing
  invocation; behavior is unchanged (it's what `--v2` already did).

## 0.1.0 — 2026-07-02

### Added

- **`apigen run`** — Live server from TypeScript source. Supports MCP (stdio/SSE/streaming-http),
  Fastify, Express, CLI output. Dual v1/v2 pipeline paths.
- **`apigen generate`** — Generate server artifacts to disk. Emits resolution scaffolding
  (package.json, tsconfig.json) so generated code runs standalone.
- **`apigen serve`** — Multi-source, multi-language front server. Spawns child `apigen run`
  processes, multiplexes HTTP/1.1 + HTTP/2 (gRPC) on one TCP port via protocol-peeking
  net.Server. Partial availability: a failed host degrades only its own namespace.
- **`apigen run-registry`** / **`apigen generate-registry`** — Discover packages by nx tag
  and wire them into a single server surface or generate artifacts for all.
- **Output plugin system** — Pluggable output targets (mcp, jsonschema, api-fastify,
  api-express, cli, py-flask, py-grpc).
- **`--use` plugin loading** — Layer/mount plugins (health, logger) loaded via built-in slugs,
  package specifiers, or local paths.
- **v2 unified orchestrator** (`--v2` flag) — Detect → extract → merge → collision-check →
  generate/run pipeline with shared ExtractionSession.
- **Projection-override config** (`--config`) — Out-of-source config file for HTTP verb and
  naming overrides (Tenet 1).
- **Per-surface dependency manifest** — Generated package.json patched with only the
  dependencies your code actually uses (e.g. `decimal.js` when `Decimal` format detected).
- **Fail-fast guards** — Precondition checks for 0-function sources and missing `decimal.js`
  optional peer dep.
- **Pino-based logging** — `--log-level`, `--log-format`, `--log-file` with env var
  fallbacks, stderr-only output.

### Fixed

- **BUG-APIGEN-004** — Empty function tables now fail early with actionable message instead
  of cryptic `ERR_MODULE_NOT_FOUND` crash.
- **BUG-APIGEN-009/010** — `--use` plugin loading system threads plugin objects to the run
  plugin via `options.usePlugins` for layered composition.
- **BUG-APIGEN-016** — `serve` pre-provisions managed Python interpreter via
  `@adhd/apigen-python-env` to avoid cold-start timeout.
- **PERF-APIGEN-001** — Single `ExtractionSession` per v2 run eliminates duplicate ts-morph
  Project creation.
- **DEBT-LT-005** — Inline `TS_LOGICAL_TYPE_DEP_MAP` replaced with authoritative
  `tsDepMap()` from `@adhd/apigen-base-logical`.
- **Leak fixes:** `builtinTsconfigPath()` memoized; gRPC h2c sessions have 60s idle eviction
  + `unref()`.
- **Stale monorepo paths** corrected from `packages/apigen/cli/` → `entrypoint/apigen-cli/`.

### Known limitations

- `export { x as y }` aliases, anonymous default exports, and CJS-source files mis-name
  routes in v1 (fixed in v2 by exporting symbol name instead of declaration identifier).
- Python and Rust/Go/Java host languages are designed in SPEC.md but only TypeScript and
  Python are implemented.
