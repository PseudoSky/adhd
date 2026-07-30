## 0.2.2 (2026-07-28)

This was a version bump only for apigen-cli to align it with other projects, there were no code changes.

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-cli to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-27)


### 🚀 Features

- **apigen-cli:** `--use batch` plugin registers `POST /_batch/<kind>` mounts for bulk fan-out operations


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-25)


### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)


### 🩹 Fixes

- **apigen-cli:** update cross-host-response-envelope test's startPyServer for required --plan-file

- **apigen:** wire EnvelopeCapability into real --use schema composition

- **backlog:** sourcepath-ownership gate for importFromMarkdown (DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001)

- **backlog:** resolve cross-file duplicate human-ids blocking cut-over parity


### ❤️  Thank You

- pseudosky

## 0.1.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- **apigen-cli:** triage BUG-APIGEN-041 (low, edge case only), 042 (medium, architectural path mismatch), 043 (logging-only, part 1+2 resolved, part 3 feature request)

- **apigen-cli:** correct BUG-APIGEN-041 triage — root cause is broken @rollup/plugin-commonjs dynamic-require stubs in plugin dist, not loadUsePlugins detection logic

- **apigen-cli:** BUG-APIGEN-041 — dist bundle found not viable; fix direction is tsx-based source loading instead

- **apigen-cli:** BUG-APIGEN-041 — final verdict; not fixable at runtime, systemic build-tool issue tracked at INVESTIGATION-BUILD-TOOL-001

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **apigen-cli:** triage BUG-APIGEN-041 (low, edge case only), 042 (medium, architectural path mismatch), 043 (logging-only, part 1+2 resolved, part 3 feature request)

- **apigen-cli:** correct BUG-APIGEN-041 triage — root cause is broken @rollup/plugin-commonjs dynamic-require stubs in plugin dist, not loadUsePlugins detection logic

- **apigen-cli:** BUG-APIGEN-041 — dist bundle found not viable; fix direction is tsx-based source loading instead

- **apigen-cli:** BUG-APIGEN-041 — final verdict; not fixable at runtime, systemic build-tool issue tracked at INVESTIGATION-BUILD-TOOL-001

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

# Changelog — @adhd/apigen-cli

All notable changes to this project are documented here.

## Unreleased

### Fixed

- **BUG-APIGEN-029** — `$ref` resolution / Ajv strict-mode failures on complex
  external or self-referential types (e.g. `better-sqlite3.Database`,
  `WriteParams`) at DISPATCH time, not extraction time. Real production
  repro (`~/dev/ai/sox-ecosystem/libs/memory-core`, read-only reference):
  several routes 500'd — `/memory/write` →
  `{"code":"internal","message":"can't resolve reference
  #/definitions/WriteParams from id #"}`; the `BetterSqlite3.Database`-taking
  routes → the identical error class for `#/definitions/BetterSqlite3.Database`.
  Confirmed identical under both v1 and v2 (pre-existing, not a
  v1-retirement regression).

  **Root cause, confirmed against current source (not by inference — traced
  empirically with temporary instrumentation, reverted before landing):**
  BUG-APIGEN-026 fixed the common case (a named type used as a top-level
  param) via `topRef: false`, but its own doc comment flagged an unresolved
  follow-up: `topRef` only controls whether the ENTRY type is `$ref`-wrapped,
  not a type it recursively/self-referentially contains, which MUST stay a
  `$ref` + `definitions` entry (JSON Schema has no other way to express a
  cycle). `buildSchema()`'s ancestors/deadlock guard (BUG-APIGEN-CORE-003)
  keys on the literal type-text STRING, but the same TS type is frequently
  reported by ts-morph as a DIFFERENT string depending on calling context (a
  fully-qualified `import("path").Foo` for the top-level param vs. bare `Foo`
  for the same type reached again via one of its own properties) — that
  mismatch defeats the guard, lets `ts-json-schema-generator` resolve the
  same type a second time independently at the nested property position, and
  produces a self-contained `$ref` + `definitions` pair several levels deep
  inside the outer param fragment. `extract.ts`'s `buildActionOpAtPath`
  spliced that fragment straight into `properties[p.name]` at whatever depth
  its `definitions` actually landed; `composeSchemas()` never carried any
  nested `definitions`/`$defs` forward onto the final composed document
  either. Since JSON-Schema `$ref` resolution is always root-relative to the
  document Ajv compiles, the `$ref` permanently dangled once
  `validate-layer.ts`'s `ajv.compile(schema.input)` ran — a genuinely
  distinct mechanism from BUG-APIGEN-030 (that one was Ajv strict-mode
  rejecting unregistered `x-apigen-*`/`discriminator` keywords; this one is a
  structural `$ref`/`definitions` placement gap with no keyword involved).

  **Fix (`packages/apigen/apigen-core-client/src/lib/extract.ts:524-603`,
  `hoistNestedDefs`):** recursively walks the ENTIRE per-param fragment tree
  (not just its own top level — the same generic object/array walk style
  `findDanglingRefs` already uses in `ts-json-schema.ts`), hoisting every
  `definitions`/`$defs` dict found at ANY depth up to the function-level
  `input` schema's own root (`extract.ts:667,694-696`). Throws a clear,
  generate-time error on a genuine same-name/different-content definition
  collision across params, rather than silently corrupting one.
  `composeSchemas()` (`apigen-core-client/src/lib/compose-schemas.ts:193-197,
  216-217`) now carries that root-level `definitions`/`$defs` forward onto
  the final composed `input` document, where `ajv.compile()` actually
  resolves `$ref`s against. `validateComposedRefs`'s pre-existing
  BUG-APIGEN-CORE-001 generate-time safety net (`compose-schemas.ts:21-49`)
  was ALSO silently dead code for every real schema before this fix — it
  collected only a `$defs` key (never `definitions`, the key
  `ts-json-schema-generator` actually emits) and keyed its lookup by bare
  definition name where `validateSchemaRefs` (apigen-base-logical) requires
  the full ref-URI string — fixed to collect both key spellings and to
  detect already-qualified `#/...`-prefixed keys (an existing hand-built test
  convention) vs. bare names needing the `#/<defKey>/` prefix, so it no
  longer double-prefixes or silently no-ops.

  **Critical follow-on bug caught by the regression tests themselves (not
  discovered by inspection):** an earlier version of `hoistNestedDefs`
  mutated the per-param fragment tree in place (`delete node.definitions`).
  `buildSchema()`'s results are memoized by reference in a
  session/process-persistent cache (BUG-APIGEN-CORE-003); a NESTED object
  inside a per-param fragment (reached via `properties`, not the top-level
  object the caller already shallow-clones) is the exact cached object, not a
  copy. Deleting `definitions` from it in place permanently stripped the
  cached entry, so the FIRST extraction in a process correctly hoisted and
  passed, but every SUBSEQUENT `extract()` call for the same type in the same
  process (a later test in the same file, or a real watch/serve rebuild) got
  back the now-`definitions`-less cached fragment and reintroduced the exact
  dangling-`$ref` bug — verified live: two BUG-APIGEN-029 regression tests
  run back-to-back reproduced `"can't resolve reference
  #/definitions/SelfRefParams from id #"` on the SECOND test only, while
  either one alone always passed. Fixed by making `hoistNestedDefs` a pure
  clone-and-hoist function that never mutates its input — it returns a
  freshly-built fragment tree with `definitions`/`$defs` removed from
  wherever found, touching only its own new output and the caller-owned
  accumulator, never the cache's objects.

  **Regression tests**
  (`packages/apigen/apigen-engine-runtime/src/test/bug-apigen-029.spec.ts`,
  fixture `src/test/fixtures/bug-apigen-029.ts`), real `extract()` →
  `composeSchemas()` → real Ajv `validateLayer` pipeline, matching the
  established `bug-apigen-030.spec.ts`/`named-type-param.spec.ts` pattern:
  a self-referential local interface (`SelfRefParams`, deterministically
  reproduces the nested-`definitions` mechanism in any environment) hoists
  its `definitions` to the schema root and dispatches correctly; a real
  complex external type (`better-sqlite3`'s `BetterSqlite3.Database`)
  dispatches correctly end-to-end (the actual reported BACKLOG symptom — in
  this no-tsconfig test environment `Database` happens to resolve to a flat,
  cycle-free schema since `ts-json-schema-generator`'s `functions:"comment"`
  default strips its chainable methods, so this case doesn't exercise the
  identical internal mechanism `SelfRefParams` does, but does prove the real
  reported route dispatches); and a negative control confirming
  `validateComposedRefs` now actually throws on a genuinely dangling `$ref`
  instead of silently no-op-ing. All 6 cases verified to fail pre-fix and
  pass post-fix; also verified stable across 10 consecutive full-suite runs
  (the in-place-mutation bug above was order-dependent and required a
  multi-run/full-suite check to catch, not just the new spec file in
  isolation).

  Also updated `descriptor.ts`'s `JSONSchema` type
  (`apigen-core-client/src/lib/descriptor.ts`) to document the `definitions`
  field alongside the already-declared `$defs` — the actual key
  `ts-json-schema-generator` emits, now load-bearing via this fix, previously
  undocumented on the type.

  **Verified:** `apigen-core-client` 267/267 (11 files); `apigen-engine-runtime`
  157/157 (17 files, including the new spec) — stable across 10 consecutive
  full-suite runs; downstream `ComposedSchemas` consumers
  `apigen-plugin-api-express` 36/36, `apigen-plugin-api-fastify` 48/48,
  `apigen-plugin-mcp` 47/47, `apigen-plugin-jsonschema` 8/8,
  `apigen-plugin-cli-output` 34/34; `apigen-base-logical` 186/186;
  `entrypoint/apigen-cli` 150/150 (18 files) — zero regressions anywhere.

- **BUG-APIGEN-034** — `--export <mode>` silently stopped scoping the served/generated
  route surface post-v1-retirement, an undocumented behavior change on an existing
  public CLI flag. Pre-diff, Step 5 of `buildDescriptor()` called v1's
  `generateSchemas({ exportMode })`, so the actual schema/route surface served was
  correctly scoped to the requested export shape. Post-diff, Step 5 derived directly
  from the unscoped `operations` array, so the FULL export matrix was published as
  routes/schemas regardless of `--export` — e.g. a source file with private
  named-export helpers alongside an intentionally `--export default`-scoped public
  object would leak the private helpers as served routes.

  **Decision: restore the scoping** (`orchestrator.ts`) rather than deprecate the flag.
  Since v2's `extract()` walks the full export-shape matrix in one unconditional pass
  (unlike v1's three mutually-exclusive extractors), there's no way to re-run "only
  this shape" extraction — instead, `opMatchesExportMode()` (new, `orchestrator.ts`)
  reclassifies each already-extracted `Operation` by its `path` shape (`path.length`
  and whether `path[1].raw === 'default'`/a named-object name) and `buildDescriptor()`'s
  Step 5 filters on it per source, before composing `packageSchemas`
  (`orchestrator.ts:484-492`). Scoping applies ONLY to what's served —
  `descriptor.operations` (collision-check, `--use` mount plugins via
  `RunInput.operations`) stays fully unscoped, matching v1's own behavior where the
  earlier collision-check step never respected `exportMode` either.

  Known residual limitation (documented in `opMatchesExportMode()`'s doc comment,
  not silently papered over): v2 shape 4's bare `export default function foo(){}`
  form and v2 shape 6 (CJS `module.exports` properties) produce the identical
  `[file, name]` path shape as a plain named export, and are therefore
  indistinguishable from one under `'named'` mode without an explicit export-shape
  discriminator on `Operation` — a schema change to the shared, host-agnostic
  descriptor deliberately left out of scope for this fix (extract.ts was being
  concurrently edited by another fix in the same branch). This is a strict superset
  of v1's true `extractNamed` coverage, never a subset: v1 never supported CJS or a
  bare default-fn-decl under ANY `--export` mode either (see extract.ts's shape 4/6
  header comments), so nothing v1 used to serve goes missing under the restored
  scoping.

  6 new regression tests (`orchestrator.spec.ts`, `BUG-APIGEN-034` describe block):
  `opMatchesExportMode()` unit tests for all three modes, plus real-pipeline
  `buildDescriptor()` integration tests against a new fixture
  (`export-mode-scoping.ts`, a private named helper alongside a
  `--export default`-scoped object) proving `--export default` includes only the
  default object's properties, omitted `--export` (named mode) includes only the
  named helper, and an absent `exportMode` (the `generate-registry`/`run-registry`
  path) applies no scoping at all — unaffected by this fix.

- **BUG-APIGEN-035** — `buildDescriptor()`'s namespace-keyed `groups` Map (Step 5)
  used plain `Map.set()`, silently last-source-wins on a namespace collision across
  sources — no error, no warning, and undocumented as a caller invariant on
  `SourceEntry`/`OrchestratorOptions`. Not reachable today (registry namespaces come
  from a single `fs.readdirSync`, inherently unique; `generate`/`run` only ever pass
  one source), but a latent trap for any future multi-source caller (e.g. the SPEC
  §13 polyglot-host `serve` extension). Fixed by throwing a clear
  `duplicate namespace "<ns>" — ...` error in `buildDescriptor()`
  (`orchestrator.ts:465-482`) the moment a second source resolves to an
  already-seeded namespace, mirroring the pre-existing duplicate-namespace guard in
  `serve.ts`'s `resolveHosts()` (`serve.ts:164-171`) for consistency across the CLI.

  2 new regression tests (`orchestrator.spec.ts`, `BUG-APIGEN-035` describe block):
  a synthetic two-source scenario with a deliberate namespace collision now throws
  `/duplicate namespace "dup"/` instead of silently dropping one source's operations,
  plus a negative control proving distinct namespaces still merge cleanly.

  Related, separate ordering nitpick fixed in the same pass:
  `run-registry.ts` registered its `SIGINT`/`SIGTERM` handlers BEFORE the
  `sources.length === 0` early-return, so on the "nothing to run" path they were
  registered for a run that never started (harmless, but inconsistent with
  `generate-registry.ts`'s equivalent check, which has no such handlers to begin
  with). Reordered so the early-return happens first.

  `npx vitest run --root entrypoint/apigen-cli`: 17 files, 147/147 passed — zero
  regressions.

- **BUG-APIGEN-033** — anonymous default-export functions (`export default (n) => ...` /
  `export default function(n){...}`) were advertised as routes/tools but crashed at
  dispatch time ("function not found"), even though they were correctly listed in the
  served schema. Root cause: `extract.ts` synthesized a filename-derived operation name
  for both anonymous default-export shapes (Shape 5, arrow/`FunctionExpression`; and
  Shape 4's anonymous `FunctionDeclaration` sub-case) — e.g. `foo_default` — and that
  name became the route/tool/schema key. But `apigen-engine-runtime/src/lib/fn-table.ts`'s
  `buildFnTable()`, which builds the `name → fn` table dispatch actually indexes into,
  keys every function by its live JS `.name` property, never by any apigen-synthesized
  name. ECMAScript's `export default AssignmentExpression`/`HoistableDeclaration`
  NamedEvaluation rule gives BOTH anonymous shapes a real runtime `.name` of `"default"`
  (the language's own behavior, not an apigen quirk) — so `buildFnTable()` always produced
  `fns['default']`, never `fns['foo_default']`. At dispatch time `fns[operationName]` was
  `undefined` → crash.

  **Fix:** name both anonymous shapes' operations using the literal `'default'` — the
  exact runtime `.name` `buildFnTable()` will always resolve — instead of a filename-derived
  synthetic id (`extract.ts`'s Shape 5 arrow/`FunctionExpression` branch and Shape 4's
  anonymous `FunctionDeclaration` branch, both now call `buildActionOp(..., fileSegment,
  'default', ...)`, mirroring exactly how Shape 4's *named* default function is already
  handled). `fileSegment` still carries the per-file id/route disambiguation
  (`shapes/anonymous-default/default`) — only the dispatch key (the leaf path segment)
  changes. No changes needed to `fn-table.ts`, `compose-schemas.ts`, `dispatch.ts`, or
  `orchestrator.ts`'s Step 5 key derivation (`op.path[op.path.length - 1].raw`) — this was
  a pure naming fix in `extract.ts`, matching an invariant `orchestrator.ts`'s own Step 5
  comment already assumed held for this shape.

  Regression coverage: `extract.spec.ts` (Shape 5, existing) and
  `export-shape-matrix.spec.ts` (Shape 5, updated to assert `'default'` instead of the old
  synthesized name) prove the static op naming. A new end-to-end test,
  `entrypoint/apigen-cli/src/test/e2e/bug-apigen-033-anonymous-default-dispatch.spec.ts`,
  spawns the BUILT CLI bin as a real `node` child process and drives it with a real
  `@modelcontextprotocol/sdk` client (`tools/list` + `tools/call`) against a new fixture
  covering the previously-uncovered anonymous-`FunctionDeclaration` sub-case
  (`anonymous-default-fn-decl.ts`) plus the existing arrow-form fixture
  (`anonymous-default.ts`), proving both are listed under the name `'default'` AND
  actually dispatch to the correct result — not just present in the schema — with a
  negative control proving a named default export (Shape 4, `default-fn.ts`) is
  unaffected. (This must run against the built bin, not an in-process Vitest `import()` —
  Vitest's own SSR transform resolves a dynamically-imported fixture differently than the
  `tsx`-based loader `run.ts` actually uses at runtime, which is exactly the mechanism this
  bug lived in; see `import-source-cjs-format.spec.ts`'s header comment for the same
  established precedent.) All 3 cases pass against the freshly-built bin (`npx vite build
  --config entrypoint/apigen-cli/vite.config.ts`, `npx vitest run --root
  entrypoint/apigen-cli entrypoint/apigen-cli/src/test/e2e/bug-apigen-033-anonymous-default-dispatch.spec.ts`
  → 3/3), confirmed by the bin's own log lines showing `tools: ["default"]` and a
  successful `→ default` dispatch for both anonymous fixtures pre-fix would instead show
  `fns['foo_default']`/equivalent undefined and throw at the `tools/call`. Additionally
  independently verified via a direct `tsx`-based probe against both real fixtures
  (mirroring `import-source.ts`'s exact loader) that `buildFnTable()` resolves
  `fns['default']` to the correct callable, returning the correct result.

  `npx vitest run --root packages/apigen/apigen-core-client`: 266/267 passed (1 failure
  in `compose-schemas.spec.ts`, confirmed via `git diff` to be caused by concurrent,
  not-yet-committed BUG-APIGEN-029 work touching `compose-schemas.ts`/`descriptor.ts` —
  neither file touched by this fix). `npx vitest run --root
  packages/apigen/apigen-engine-runtime`: 151/151 passed at the time this fix's changes
  were verified in isolation — `dispatch.spec.ts` (14/14) unaffected; a concurrent,
  untracked, not-yet-committed BUG-APIGEN-029 test file
  (`src/test/bug-apigen-029.spec.ts`, not part of this commit) appeared mid-session and
  is excluded from this count since it belongs to that other in-flight fix.

  Known follow-up (filed, not fixed here — see BUG-APIGEN-039): this fix moves both
  anonymous shapes into the same `[file, name]` 2-segment `op.path` bucket
  `opMatchesExportMode()` (BUG-APIGEN-034) already can't fully disambiguate from a plain
  named export — the identical class of gap BUG-APIGEN-034 already documented and
  deferred for Shape 4's *named* default case, now with a wider blast radius.

- **BUG-APIGEN-024** — `--use openapi` mount produced an empty OpenAPI doc (`paths: {}`)
  on live `run`, even though the underlying operations were correctly extracted and
  served. Root cause: `collectMountRoutes()` — identical in both HTTP transports
  (`apigen-plugin-api-express/src/lib/run.ts`, `apigen-plugin-api-fastify/src/lib/run.ts`)
  — built the synthetic `Descriptor` handed to `--use` mount plugins with `operations`
  hardcoded to `[]`, so `apigen-plugin-openapi`'s `toOpenApi(descriptor.operations, ...)`
  always received an empty array regardless of what was actually extracted (confirmed
  independently: `apigen-plugin-openapi`'s own test suite proves `toOpenApi` produces
  correct `paths` given a real descriptor). Fixed by threading the real merged
  `Operation[]` (already computed by `buildDescriptor()`) through `RunInput.operations`
  (new optional field, `apigen-core-client/src/lib/types.ts`), populated by
  `orchestrator.ts`'s `orchestrateRun()`, and consumed by `collectMountRoutes()` in both
  transports instead of the hardcoded `[]` stub (`input.operations ?? []` — the `?? []`
  fallback keeps non-TS-extraction run paths, e.g. py-flask, safe since they have nothing
  extracted to describe). Scoped to the `run` (live server) path per the bug title; the
  BACKLOG entry's separately-noted gap that `generate.ts` never calls
  `collectMountRoutes` at all (mount plugins are a live-server-only concept today) is
  unchanged, pre-existing behavior, not part of this fix.

  9 new regression tests added per HTTP transport (`apigen-plugin-api-express` and
  `apigen-plugin-api-fastify` `plugin.spec.ts`, `[BUG-APIGEN-024]` describe blocks): a
  real `run()` server mounted with the REAL `@adhd/apigen-plugin-openapi` plugin (not a
  stub) against two real multi-route operations, asserting `paths` contains both real
  routes with the correct HTTP method/schema per path (safe→GET, unsafe→POST with
  requestBody), plus a regression control proving `RunInput.operations` omitted still
  safely falls back to empty `paths` rather than crashing. `nx test
  apigen-plugin-api-express` 25/25, `nx test apigen-plugin-api-fastify` 37/37 (2 files),
  `nx run-many -t test -p apigen-core-client apigen-plugin-openapi apigen-cli
  apigen-engine-runtime` 114/114 — zero regressions.

- **FEAT-APIGEN-022 / BUG-APIGEN-025** — apigen now auto-hoists a function to `GET`
  when its domain params are ALL "properly typed primitives" (`string`/`number`/
  `boolean`/`integer`, or zero params) — no `--opt http.verb.<id>=GET` override
  needed — and `x-apigen-safe` (which `httpVerb()` already read but nothing ever
  wrote) is now actually stamped by `composeSchemas()`, so the mechanism it
  partially relied on is live end-to-end.

  **Design:** a new shared helper, `isPrimitiveOnlyInputSchema()`
  (`apigen-core-client/src/lib/get-safety.ts`), inspects a bare domain-input JSON
  Schema (`{type:'object', properties, required}` — the exact shape of both
  `Operation.input` and `GeneratedSchemas.schemas[fn].input`) and returns `true`
  iff every property is `string`/`number`/`boolean`/`integer` (optionally unioned
  with `null`), a primitive-literal `enum`, or there are zero properties at all
  (vacuously true — covers zero-arg functions). `$ref`, `oneOf`/`anyOf`/`allOf`,
  `array`, and `object` properties are excluded. `composeSchemas()`
  (`apigen-core-client/src/lib/compose-schemas.ts`) computes `op.safe ===
  true || isPrimitiveOnlyInputSchema(fnSchema.input)` per function and stamps it
  as `'x-apigen-safe'` on the `ComposedSchemas` entry (BUG-APIGEN-025's fix:
  `op.safe` is threaded from `Operation.safe` through a new `safe?: boolean`
  field on `GeneratedSchemas.schemas[fn]`, populated by
  `orchestrator.ts`'s `buildDescriptor()` Step 5 — previously computed but never
  carried this far, so the field `httpVerb()` read was always `undefined`).
  `apigen-engine-naming`'s `project()` applies the identical OR-condition
  directly against `op.input` for non-`ComposedSchemas` consumers (gRPC/openapi/
  MCP paths). The four previously-duplicated `httpVerb()` definitions
  (`apigen-plugin-api-express`'s `run.ts`/`generate.ts`, `apigen-plugin-api-
  fastify`'s `run.ts`/`generate.ts`) are now ONE definition, exported from
  `apigen-engine-naming`, imported by all four call sites — the manual
  `--opt http.verb.<id>=GET`/`POST` override is checked first there and always
  wins over the auto-detected value, in both directions.

  **Also fixed as a direct consequence:** GET requests were previously broken
  for any non-`string` primitive param (backlog point 3 — Ajv's validate-Layer
  has no `coerceTypes`, so a query-string `"42"` failed a `number` schema check).
  A new `coerceQueryParams()` helper (`apigen-engine-runtime/src/lib/coerce-
  query.ts`) coerces `number`/`integer`/`boolean` query values to their real JS
  types at the TRANSPORT layer (both `run.ts`s and both `generate.ts`s' emitted
  code), strictly scoped to the GET/query-string path — the shared Ajv instance
  used for POST/body validation is untouched, so this cannot silently coerce a
  malformed POST body. An unparseable value (e.g. `?count=abc`) is left as-is so
  validation still rejects it with a clear `invalid_argument` error.

  Several existing tests hardcoded `POST`/JSON-body requests for functions whose
  params are now correctly auto-hoisted to `GET` (a zero-param op in
  `orchestrator.spec.ts`'s override test, `price(v: Decimal)` — literally
  `type Decimal = string` — in `cross-host-response-envelope.spec.ts`,
  `upperFirst`/etc. in `real-consumer.spec.ts`, `addNumbers(a: number, b:
  number)` in `serve.spec.ts`) — updated to GET/query-string calls (or, for the
  one test whose actual point was proving the override mechanism itself, to a
  non-primitive-shaped fixture) since the old assertions encoded pre-feature
  default behavior, not the tests' real intent.

  New regression tests: `apigen-core-client` (`get-safety.spec.ts`, 10 tests;
  `compose-schemas.spec.ts` +5 `x-apigen-safe` tests), `apigen-engine-naming`
  (`naming.spec.ts` +11 auto-hoist/`httpVerb` tests), `apigen-engine-runtime`
  (`coerce-query.spec.ts`, 11 tests incl. a validate-Layer integration proof),
  `entrypoint/apigen-cli` (`orchestrator.spec.ts` +5 real-pipeline
  extract→compose→generate tests covering auto-hoist, non-hoist, override
  precedence, and `x-apigen-safe` presence in the real generated schema). Full
  suites green: `apigen-core-client` 267/267, `apigen-engine-naming` 51/51,
  `apigen-engine-runtime` 151/151, `apigen-plugin-api-express` 36/36,
  `apigen-plugin-api-fastify` 48/48, `apigen-cli` 139/139 — zero regressions.
  `nx run-many -t build` clean for all six + their 32 dependents; `nx run-many -t
  lint` clean.

- **BUG-APIGEN-017/018/019/020** — MCP tool-schema hardening bundle (all four filed
  2026-07-06 from the `scratch-agent-search`/agent-browser consumer). Root-caused each
  independently before fixing (`entrypoint/apigen-cli/BACKLOG.md`'s filed entries per ID):

  - **BUG-APIGEN-017** (unknown properties silently accepted) and **BUG-APIGEN-020**
    (the `data` envelope convention undocumented) were **already fixed** in an earlier
    session batch (`1498dd45`, 2026-07-15) — `apigen-core-client/src/lib/compose-schemas.ts`
    already stamps `additionalProperties: false` on both the top-level and nested `data`
    schema objects, and a human-readable envelope-calling-convention `description` (via
    `apigen-engine-runtime/src/lib/tool-description.ts`'s `buildToolDescription`, consumed by
    `apigen-plugin-mcp`'s `generate.ts` and `run.ts`) — both with existing regression coverage
    in `apigen-core-client/src/test/compose-schemas.spec.ts`. The BACKLOG entries were simply
    never moved to this file when the fix landed; confirmed via direct read of the committed
    (not just working-tree) source before treating this as bookkeeping-only for those two.
    (The BACKLOG's `BUG-APIGEN-020` entry also briefly collided with an unrelated
    `BUG-APIGEN-037` — py-flask/py-grpc eager imports — under a shared duplicate ID; both
    were independently already using their now-current IDs in code comments, and the
    duplicate was resolved in the BACKLOG text separately from this fix.)
  - **BUG-APIGEN-018** (mcp) (parameter defaults not surfaced) was likewise already fixed —
    `apigen-core-client/src/lib/extract.ts` + `param-defaults.ts`'s `applyParamDefault`
    stamp both the native JSON-Schema `default` keyword and a `"(default: <value>)"` note
    onto each parameter's own property schema, which flows unmodified into the MCP
    `inputSchema` (`apigen-plugin-mcp`'s `run.ts`/templates never touch `input`). Existing
    coverage: `apigen-core-client/src/test/extract.spec.ts`'s `[BUG-APIGEN-018]` describe
    block.
  - **BUG-APIGEN-019** (union return types produce weak schemas) had its *schema-building*
    half already fixed the same way — `ts-json-schema.ts`'s `normalizeTopLevelUnion` rewrites
    a TS union's `anyOf` to `oneOf` + an advisory `discriminator` for both inline and named
    union return types, reaching `extract()`'s `output` fragment for real (confirmed via
    `union.spec.ts` + the wiring trace in BUG-APIGEN-038's BACKLOG entry, which explicitly
    scopes that gap to *parameters*, not return types). **But the MCP transport never
    surfaced any return-type schema to clients at all** — `apigen-plugin-mcp`'s `run.ts` and
    both generated-server templates (`server-stdio.tpl.ts`, `server-http.tpl.ts`) only ever
    emitted `inputSchema` in `tools/list`, never `outputSchema`, for any function, union or
    not. This is the one genuinely live gap in the bundle, and it isn't a simple pass-through
    fix: the MCP SDK's `Tool.outputSchema` is constrained by its own Zod schema to a
    top-level `{ type: "object", ... }` shape (`ToolSchema.outputSchema` in
    `@modelcontextprotocol/sdk`), so naively forwarding a `oneOf`-shaped union output would
    have failed the SDK's own runtime validation and crashed the server for exactly the
    return-type shape this bug describes. Fixed by adding
    `apigen-engine-runtime/src/lib/mcp-output-schema.ts` (`buildMcpOutputSchema` /
    `wrapMcpStructuredContent`, exported from the package index): an already-`type:"object"`
    output schema passes through unwrapped; anything else (the union case, arrays, bare
    scalars) is wrapped as `{ type: "object", properties: { result: <output> }, required:
    ["result"] }` for `outputSchema`, with the paired runtime value wrapped the same way
    (`{ result: <value> }`) as MCP's `structuredContent` (also object-constrained by the
    SDK) alongside the pre-existing `content` text field for backward compatibility. Wired
    into all three MCP server code paths that independently duplicate the `tools/list`/
    `tools/call` handlers: `apigen-plugin-mcp/src/lib/run.ts` (in-process server) and both
    `src/lib/templates/server-stdio.tpl.ts` / `server-http.tpl.ts` (generated standalone
    servers).

  **Tests:** new `apigen-engine-runtime/src/test/mcp-output-schema.spec.ts` (9 cases:
  object/union/array/scalar output shaping, empty/undefined output, structuredContent
  wrap/passthrough, and the defensive non-object-value case). New
  `apigen-plugin-mcp/src/test/generate.spec.ts` `[plugin-mcp.7]` describe block (4 cases:
  all three transports' generated `server.ts` import and wire `buildMcpOutputSchema`/
  `wrapMcpStructuredContent` into both `outputSchema` and `structuredContent`;
  `additionalProperties:false` survives `generate()` unmodified; a per-param default note
  survives into the generated schema; an envelope-convention description survives into the
  generated schema). New `apigen-plugin-mcp/src/test/run.spec.ts` `[plugin-mcp.7]` describe
  block (5 real end-to-end HTTP `tools/list`/`tools/call` cases: object-shaped output passes
  through `outputSchema` unwrapped; a `oneOf`+`discriminator` union output is wrapped under
  `result` with the discriminator intact; an array-return output is wrapped under `result`;
  `tools/call` `structuredContent` mirrors `content` unwrapped for the object case; and
  wrapped as `{ result: <value> }` for the union case). Verified clean: `nx test
  apigen-engine-runtime` 140/140 (15 files), `nx test apigen-plugin-mcp` 47/47 (4 files) —
  zero regressions to the pre-existing 38 apigen-plugin-mcp tests or 131 apigen-engine-runtime
  tests. Both projects' `nx run <project>:build` (which typechecks via `vite-plugin-dts`) and
  `nx run <project>:lint` pass clean.

- **FEAT-APIGEN-023** — a zero-parameter, zero-required-envelope operation's published
  `inputSchema` no longer forces callers to send an empty `data: {}` (or any envelope field).
  `apigen-core-client/src/lib/compose-schemas.ts`'s composed outer schema unconditionally
  listed `'data'` in its top-level `required` array even when a function took no domain
  parameters at all (`listProviders`, `tripwireStatus`, etc.) — a deliberate, named invariant
  (`[inv:data-wrapper-always-present]`) that made every MCP host, LLM tool-caller, or other
  strict schema-driven client believe an empty envelope was mandatory, even though every
  transport's decode path (`apigen-plugin-api-express`, `apigen-plugin-mcp`,
  `apigen-engine-runtime`'s `validate-layer.ts`) already defaulted an omitted body/args/data to
  `{}` at runtime — confirmed a schema/documentation-only issue, not a decode-side one, by
  reading each transport's decode site rather than assuming. Fixed by making the `'data'`
  entry in the outer `required` array conditional on `domainRequired.length > 0` — the exact
  condition already used for the nested `data` schema's own `required` — so `{}` (no body
  needed beyond the operation name) is now a valid call for a truly zero-arg operation, while
  the `data` property itself is still always declared (so `{"data": {}}` remains valid for
  callers who send it anyway) and parameterized operations are completely unaffected.
  Regression tests in `apigen-core-client/src/test/compose-schemas.spec.ts`: two pre-existing
  cases that had baked in the old unconditional-required behavior for a zero-param fixture
  function were corrected, plus a new 7-case `FEAT-APIGEN-023` describe block covering an
  empty top-level `required` for a zero-param/zero-middleware function, that `data` remains a
  declared (not required) property, that a parameterized function's `required` still contains
  `'data'` (regression control), that middleware envelope fields stay required independent of
  `data`, and that overriding a zero-param function's only middleware to `false` yields a
  fully empty `required` array. Verified clean: `nx test apigen-core-client` 252/252, `nx test
  apigen-engine-runtime` 131/131, and `nx run-many -t test -p apigen-plugin-api-express
  apigen-plugin-api-fastify apigen-plugin-mcp apigen-plugin-jsonschema apigen-plugin-cli-output
  apigen-cli` 134/134 across all six downstream `ComposedSchemas` consumers — zero regressions.

- **BUG-APIGEN-031** — `generate --type cli` output silently mishandled array/object-typed
  domain params: Commander's raw argv string for a flag like `--arr '[2,4,6]'` was passed
  straight through to `dispatch()` with no JSON-parsing, since only the CLI transport's wire
  values are plain strings (HTTP transports already deliver a real parsed value from the
  request body, and the shared `apigen-base-logical` decode path's array/object branches
  correctly pass a non-array/non-object wire through unchanged for that case). Result: an
  array-typed param either crashed downstream (`arr.reduce is not a function`) or, worse,
  silently returned a wrong-but-plausible-looking answer via string-indexing coincidence
  (`percentile --sorted '[10,20,30,40,50]' --p 0.5` returned `"3"` — the character at index 7
  of the 16-char argv string — instead of the real answer, `30`). Ported from `main`'s
  `entrypoint/apigen-cli/BACKLOG.md` (filed there 2026-07-19) and independently reproduced on
  this worktree's current source before fixing — `generate.ts`, `runmode.ts`, and `dispatch.ts`
  were byte-identical to `main`, confirmed via `git diff main`. Fixed in
  `apigen-plugin-cli-output/src/lib/generate.ts` (transport-specific, not the shared decode
  path, to avoid touching HTTP transports' already-correct behavior): a new `isJsonTypedProp()`
  helper flags any domain param whose schema (or `anyOf` with all non-null members) is
  `array`/`object`-typed; `generate()` now pre-scans every command for such a param and, only
  when at least one exists, embeds a small `__apigenParseJsonArg(flag, raw)` runtime helper in
  the generated `cli.ts` (undefined passthrough for omitted optional params, `JSON.parse` for
  strings, a clear `Invalid JSON for --<flag>: <message>` thrown error on malformed input
  instead of a silent wrong value) and routes each json-typed param's `domainArgs` entry
  through it. Regression tests added to `apigen-plugin-cli-output/src/test/plugin.spec.ts`
  (`BUG-APIGEN-031` describe block, 9 cases): static codegen assertions (array param wrapped,
  object param wrapped, scalar params NOT wrapped, helper omitted entirely when unused,
  nullable `anyOf:[array,null]` param wrapped) plus behavioral assertions that extract the
  actual generated helper source from `content` and evaluate it directly — proving the real
  shipped runtime code parses `'[2,4,6]'` → `[2,4,6]` and `'{"verbose":true}'` →
  `{verbose:true}`, passes `undefined` through for an omitted optional param, and throws
  `Invalid JSON for --arr: ...` (not a silent passthrough) on malformed input. Live end-to-end
  verification against `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/src/latency-stats.ts`
  (`generate --type cli --link-workspace` then real `tsx cli.ts` invocations): `mean --arr
  '[2,4,6]'` now returns `4` (was a crash), `percentile --sorted '[10,20,30,40,50]' --p 0.5` now
  returns `30` (was the silently-wrong `"3"`), and `mean --arr 'not-json'` now throws
  `Invalid JSON for --arr: Unexpected token 'o', "not-json" is not valid JSON` instead of
  reaching dispatch at all. `apigen-plugin-cli-output` suite: 34/34 (was 25/25 pre-fix,
  9 new). `apigen-base-logical` suite (untouched, verified no regression): 186/186.
  `eslint` on both touched files: clean. `nx test`/`tsc --noEmit` for these projects not used
  directly for final verification — `nx test` transitively gates on `apigen-core-client:lint`,
  which had an unrelated, concurrent in-flight failure from a different teammate's uncommitted
  WIP at verification time (`apigen-core-client/src/test/extract.spec.ts`, BUG-APIGEN-CORE-004
  in progress, confirmed via `git status`/`git diff` to be outside this fix's diff entirely);
  raw `tsc --noEmit -p tsconfig.spec.json` hits a pre-existing `vite.config.ts`/`defineConfig`
  raw-`tsc`-invocation artifact (untouched file, not a real type error, an artifact of invoking
  `tsc` outside the Vite-aware toolchain — the project's actual CI-relevant check, `vitest run`,
  passed cleanly).

- **BUG-APIGEN-032** — `generate --type api-express`/`api-fastify` (including their
  `-registry` variants) emitted genuinely invalid TypeScript/JavaScript for any
  hyphenated discovered package id — the repo-convention, overwhelmingly common case
  (`pkg-a`, any real `@scope/some-package-name`) — because both generators spliced
  `pkg.id` straight into JS identifier positions with no sanitization:
  `` `import * as ${pkg.id}_ns from '${pkg.importPath}'` ``,
  `` `const ${pkg.id}_fns = buildFnTable(...)` ``, and the `dispatch(${pkg.id}_fns …)`
  call sites reusing that same unsanitized name — producing `import * as pkg-a_ns from
  …`, a hard parse error (`Expected "from" but found "-"`; a bare `-` is the
  subtraction operator in an identifier position, not a valid character). Ported from
  `main`'s `entrypoint/apigen-cli/BACKLOG.md` (filed there 2026-07-19 by
  `verify-registry-commands`) and independently reproduced on this worktree's current
  source before fixing — confirmed the plugin files were untouched by the
  v1-retirement diff, so the bug carried over unchanged.
  `apigen-plugin-cli-output/src/lib/generate.ts` already had the correct fix for the
  same bug class (`BUG-APIGEN-CLI-001`, `packages/apigen/BACKLOG.md`, fixed
  2026-07-06) as a private, unexported `sanitizeIdentifier()` helper — never shared,
  so `api-express`/`api-fastify` never had access to it. Fixed by extracting
  `sanitizeIdentifier()` into `@adhd/apigen-engine-naming`
  (`packages/apigen/apigen-engine-naming/src/lib/naming.ts:383-407`, exported via
  `src/index.ts`) — the one shared naming/projection-helper package all three plugins
  already depended on (zero new dependency edges needed) and whose own doc comment
  states "No transport may inline its own casing logic; it must call one of the
  helpers exported here." All three plugins now import the single shared
  implementation: `apigen-plugin-api-express/src/lib/generate.ts:2,55,58,83,108,129`,
  `apigen-plugin-api-fastify/src/lib/generate.ts:2,66,69,94,123,146`, and
  `apigen-plugin-cli-output/src/lib/generate.ts:3,139,169` (its former private
  duplicate deleted). Regression tests added:
  `apigen-plugin-api-express/src/test/hyphenated-identifier.spec.ts` and
  `apigen-plugin-api-fastify/src/test/hyphenated-identifier.spec.ts` (6 cases each) —
  unit-verify the sanitized identifier is emitted at every import/fn-table/dispatch
  splice site (GET and POST) while the raw hyphenated id stays verbatim in the
  schema-key string, plus a real `esbuild` syntax check proving the pre-fix splice
  pattern is a genuine parse error and the current `generate()` output parses cleanly.
  `apigen-engine-naming`'s existing `naming.spec.ts` suite is untouched (40/40 still
  pass); `apigen-plugin-cli-output`'s existing `hyphenated-namespace.spec.ts` (proving
  `BUG-APIGEN-CLI-001` stays fixed) also still passes unchanged, now exercising the
  shared implementation instead of the deleted local copy. Verified via direct
  `vitest run` in each of the four affected packages (`apigen-engine-naming`:
  40/40, `apigen-plugin-api-express`: 31/31, `apigen-plugin-api-fastify`: 43/43,
  `apigen-plugin-cli-output`: 34/34) and `tsc --noEmit` on each package's
  `tsconfig.spec.json` (clean, modulo a pre-existing `vite.config.ts`/`defineConfig`
  raw-`tsc`-invocation artifact confirmed to reproduce identically on the untouched
  `apigen-plugin-health` package — not a real type error, an artifact of invoking
  `tsc` outside the Vite-aware toolchain). `nx test` for these projects was not used
  directly for final verification because it transitively gates on `apigen-core-client:
  lint`, which had an unrelated, concurrent in-flight failure from a different
  teammate's uncommitted WIP at verification time (`apigen-core-client/src/test/
  extract.spec.ts`, BUG-APIGEN-CORE-004 in progress) — confirmed via `git status`/`git
  diff` to be outside this fix's diff entirely.

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
  BUG-APIGEN-038 below) and the `discriminator.mapping` shape Ajv's built-in
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
  functions' input schemas. Filed as BUG-APIGEN-038 in the Open section
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
