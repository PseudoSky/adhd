# BACKLOG — @adhd/apigen-cli

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../BACKLOG.md)
(§ _Extraction performance + memory-leak work (2026-07-02)_).

## Fixed

### PERF-APIGEN-001 (orchestrator side) — RESOLVED 2026-07-02

`buildDescriptor()` now creates ONE `ExtractionSession` per run, threads it through
`extractSource` and the step-5 `generateSchemas` composition loop (previously a second
full ts-morph Project per source), and disposes it in `finally`. Guard:
`src/test/perf.spec.ts` (descriptor deep-equality across cached runs, heap flatness
with real gc, warm-run bound) — runs by default in the forks pool with `--expose-gc`.
Bench: `npx nx run apigen-cli:bench` (fixtures under `tmp/apigen/bench`).

### BUG-APIGEN-016 (serve side) — bare `python3` spawns — RESOLVED 2026-07-02

`serve` pre-provisions the managed interpreter via `@adhd/apigen-python-env` before
spawning Python hosts (first-time venv build no longer eats the per-host ready budget)
and pins children via `APIGEN_PYTHON`. A user-supplied `APIGEN_PYTHON` is respected; one
set by a previous `startServe` in the same process is not treated as a user override
(extras may need widening — see `_managedPython` in `src/lib/commands/serve.ts`).

### Leak fixes — RESOLVED 2026-07-02

- `resolve-tsconfig.ts`: `builtinTsconfigPath()` memoized — no more one mkdtemp per call
  in long-running serve/watch.
- `serve.ts` gRPC proxy sessions: 60s idle eviction + `unref()` so cached h2c sessions
  neither linger after silent backend death nor hold the event loop open.

### DEBT-APIGEN-LINT-001 — `@nx/dependency-checks` false-positive on `decimal.js` — FIXED 2026-07-18

`nx run apigen-cli:lint` (and transitively `:build`/`:test`) failed with
"decimal.js package is not used by apigen-cli project" — the dependency IS
genuinely used by test fixtures under a tsconfig-excluded `src/test/**` path,
which `@nx/dependency-checks`'s static scan doesn't see. Same root cause as
`apigen-core-client/BACKLOG.md` DEBT-APIGEN-LINT-001 (full detail there).
Filed + fixed 2026-07-18 during BUG-APIGEN-CORE-002 verification (discovered
while confirming `entrypoint/apigen-cli`'s test suite still passes after the
apigen-core-client re-export fix — all 113 tests pass once the
build-then-test workaround documented in `apigen-core-client/BACKLOG.md` is
applied; this lint issue was pre-existing and unrelated to that fix). Fixed
by moving `decimal.js` from `dependencies` to `devDependencies` in
`package.json` — `nx run apigen-cli:lint` now passes clean.

### BUG-APIGEN-018 — `vite.config.ts`'s `copyDefaultTsconfig` plugin wrote to the wrong `dist/` path — FIXED 2026-07-19

**Where:** `entrypoint/apigen-cli/vite.config.ts:10` — `const OUT_DIR = path.resolve(__dirname, '../../dist/apigen-cli');`, used by the custom `copyDefaultTsconfig()` plugin (lines 13-22) and duplicated at `build.outDir` (line 39).

**Observed:** Every build left a stray `dist/apigen-cli/` directory at the repo root, containing only `default-tsconfig.json` — while the real build output (matching `project.json`'s `outputPath`) correctly landed at `dist/entrypoint/apigen-cli/`, which never received that file. `path.resolve(__dirname, '../../dist/apigen-cli')` was wrong for a package whose actual source root is `entrypoint/apigen-cli/` — two levels up from `vite.config.ts` is the repo root, so the string was missing the `entrypoint/` segment. Nx's `@nx/vite:build` executor overrides the *main bundle's* output location via `project.json`, which is why `index.js`/`index.mjs`/`package.json` landed in the correct place regardless — but `copyDefaultTsconfig()`'s `closeBundle()` hook does its own raw `fs.mkdirSync`/`fs.copyFileSync` against the independently-computed (wrong) `OUT_DIR`, bypassing that override entirely.

**Impact was low severity, self-mitigated, but the intended optimization had likely never worked:** `resolve-tsconfig.ts`'s `builtinTsconfigPath()` checks three candidate paths for the shipped asset (`dir/default-tsconfig.json`, `dir/lib/default-tsconfig.json`, `dir/../default-tsconfig.json`); confirmed via `find`, none existed in the real output before this fix. All three misses fell through to writing an inlined copy of the same JSON (`BUILTIN_DEFAULT`) to a fresh `mkdtempSync` temp file, memoized once per process. So correctness was preserved for real consumers — they just always paid the temp-file-write cost every process instead of reading the pre-shipped asset, and every local/CI build littered a stray directory at the repo root. `entrypoint/apigen-cli/src/lib/default-tsconfig.json` (the source file being copied) dates to 2026-07-02, predating this session — this had likely been silently broken since the plugin was written.

**Fix:** changed `OUT_DIR` (both the plugin's and `build.outDir`'s value) to `path.resolve(__dirname, '../../dist/entrypoint/apigen-cli')`, matching `project.json`'s actual `outputPath`. Deleted the stray `dist/apigen-cli/` directory this bug had been creating.

**Verified:** clean rebuild (`nx reset` + `nx run apigen-cli:build`) no longer creates `dist/apigen-cli/` at all, and `dist/entrypoint/apigen-cli/default-tsconfig.json` is now present. Full `apigen-cli` test suite still green (113/113).

Citations: [self-verified 2026-07-19: `entrypoint/apigen-cli/vite.config.ts:10,39`; `ls dist/apigen-cli/` (pre-fix) → only `default-tsconfig.json` present; `find dist/entrypoint/apigen-cli -iname "*tsconfig*"` (pre-fix) → no match, (post-fix) → `default-tsconfig.json` present; `entrypoint/apigen-cli/src/lib/resolve-tsconfig.ts:35-48` (three-candidate fallback + temp-file mitigation); `git log -1 --format=%ad -- entrypoint/apigen-cli/src/lib/default-tsconfig.json` → 2026-07-02]

### FEAT-APIGEN-023 — Zero-parameter, zero-envelope operations no longer require an empty `data: {}` (or full envelope) in the published schema — FIXED 2026-07-20

**Requested:** 2026-07-19 by the user, directly. **Ask:** a route/tool/command with
no parameters shouldn't require a caller to send `data`, a body, an envelope, etc.
— calling it should need nothing beyond the name/path.

**Root cause, confirmed:** not an oversight — a **named, deliberate invariant**
(`[inv:data-wrapper-always-present]`) in `apigen-core-client/src/lib/
compose-schemas.ts`. The outer composed schema's `required` array
unconditionally included `'data'` (`required: [...envelopeRequired, 'data']`,
pre-fix `compose-schemas.ts:143`) regardless of whether the function had any
domain parameters, even though the *nested* `data` object's own `required` was
already correctly conditional on `domainRequired.length > 0`
(`compose-schemas.ts:136`). `composeSchemas()` is the single point that feeds
every transport (MCP, api-express, api-fastify), so every truly zero-arg
function's published `inputSchema` told every consumer `data` was mandatory,
just one that happened to validate against `{}`. Confirmed a **schema/
documentation issue only, not a runtime one** — every transport's decode path
(`apigen-plugin-api-express/src/lib/run.ts:254,267`,
`apigen-plugin-mcp/src/lib/run.ts:93,105`,
`apigen-engine-runtime/src/lib/validate-layer.ts:157-160,239-241`) already
defaults an omitted `data`/body/args to `{}` and synthesizes `{ data:
call.domainArgs, ...call.envelope }` before validating, so the decode side
needed no change — verified by reading each site, not assumed.

**Fix:** `compose-schemas.ts:143-146` — `'data'` is now only added to the
outer `required` array when `domainRequired.length > 0` (mirrors the exact
condition already used for the nested `data` schema's own `required`), i.e.
`required: [...envelopeRequired, ...(domainRequired.length > 0 ? ['data'] :
[])]`. The `data` *property* itself is still always declared (`{"data": {}}`
still validates for callers who send it out of habit), and middleware-
contributed envelope fields are still required on their own merits,
independent of whether `data` is required — only zero-param, zero-required-
envelope operations get the relaxed schema; parameterized operations are
unaffected.

**Tests:** `apigen-core-client/src/test/compose-schemas.spec.ts` — updated
`[schema-composition.1]` and `[schema-composition.4]` (which had baked in the
old unconditional-`data`-required behavior for zero-param functions, so they
would have masked this exact bug) plus a new `FEAT-APIGEN-023` describe block
(7 cases): zero-param/zero-middleware function has an empty top-level
`required`; `{}` satisfies it; the `data` property is still declared and
`{"data": {}}` still validates; a parameterized function's `required` still
contains `'data'` (regression control); middleware envelope fields remain
required independent of `data` for both parameterized and zero-param
functions; a zero-param function with its only middleware overridden `false`
has a fully empty `required` array. All pre-fix assertions were hand-verified
to fail against the pre-fix code path before the fix landed.

**Verified:** `nx test apigen-core-client` 252/252 passing (incl. new/updated
cases); `nx test apigen-engine-runtime` 131/131 passing (validate-layer decode
path unaffected, confirmed not just assumed); `nx run-many -t test -p
apigen-plugin-api-express apigen-plugin-api-fastify apigen-plugin-mcp
apigen-plugin-jsonschema apigen-plugin-cli-output apigen-cli` 134/134 passing
across all 17 test files in those six downstream `ComposedSchemas` consumers —
zero regressions.

Citations: [session 2026-07-20, self-verified by direct file read:
`apigen-core-client/src/lib/compose-schemas.ts:136-155` (fix);
`apigen-core-client/src/test/compose-schemas.spec.ts:47-75,112-130,337-421` (tests);
`apigen-plugin-api-express/src/lib/run.ts:254,267`;
`apigen-plugin-mcp/src/lib/run.ts:93,105`;
`apigen-engine-runtime/src/lib/validate-layer.ts:157-160,239-241`; original
ask/analysis: `apigen-engine-runtime/src/lib/api-package.ts:61`,
`entrypoint/apigen-cli/src/lib/pipeline.ts:42`,
`entrypoint/apigen-cli/src/lib/orchestrator.ts:355`]

## Open

### BUG-APIGEN-041 — `--use <path>` does not load a file/path plugin the same way `--use <name>` loads a registered builtin plugin; relative paths should also work — TRIAGED

**Reported:** live user testing, post-merge, against the built CLI.

**Observed:** registering `openapi` as a named builtin (added to
`BUILTIN_USE_PLUGINS` in `run.ts`) mounts correctly via `--use openapi`.
Pointing `--use` directly at the plugin's own file path does NOT mount the
same way — behaves differently from the named-builtin load path. Separately,
relative (non-absolute, non-`./`-prefixed) path specifiers are expected to
work as file paths too and currently may not.

**Triage — root cause confirmed by live test:**

Running `node dist/entrypoint/apigen-cli/index.js run --use dist/packages/apigen/apigen-plugin-openapi/index.js …`
produces:

```
TypeError: Cannot read properties of undefined (reading 'timeOrigin')
    at zj (.../dist/packages/apigen/apigen-plugin-openapi/index.js:24)
```

The `isLocal` path detection in `loadUsePlugins` IS correct — it resolves the path, creates a file URL,
and calls `import()`. The file IS loaded. But the **plugin's Vite/Rollup dist bundle itself crashes at module
evaluation time** before any plugin code runs.

**Root cause of the crash — broken `@rollup/plugin-commonjs` dynamic-require stub:**

The bundle inlines TypeScript's compiler-perf module, which at initialization does:

```
const {performance} = require('perf_hooks') || globalThis.performance
```

Rollup's `@rollup/plugin-commonjs` cannot handle this pattern. It generates a `cUe()` placeholder
that always throws (`"Could not dynamically require..."`), and sets `gE` to an **empty frozen
module object `{}`** instead of a working `require` or `globalThis` reference. The initialization
chain then proceeds:

1. `cUe` is defined (a thrown, but defined) → `fZ()` returns `true`
2. `B2()` destructures `{performance: undefined}` from the empty `gE` → returns `{performance: undefined}`
3. `zj()` accesses `s.timeOrigin` where `s` is `undefined` → **TypeError: Cannot read properties of undefined**

The builtin path (`--use openapi`) works because the plugin is **statically imported** in `run.ts`
and shares the CLI's own bundle's TypeScript runtime — no second copy of the broken initialization logic runs.

**Impact — HIGH for file-path usage, but workaround exists:**
- Dynamically loading ANY apigen plugin's dist bundle that transitively depends on `typescript` (or any
  package using `@rollup/plugin-commonjs`-unfriendly patterns) will crash at module evaluation time.
- This is not fixable by changing `loadUsePlugins` — the crash is in the **target module itself**.
- The `loadUsePlugins` detection logic (extension check, path resolution) is actually correct.
- The fix is in the **build configuration** of the plugin packages: `@rollup/plugin-commonjs` needs
  either `ignoreDynamicRequires: true` or explicit `dynamicRequireTargets` entries for `perf_hooks`
  and other Node builtins that TypeScript imports, so the bundle doesn't produce a broken stub.

**Suggested fix:** Add `ignoreDynamicRequires: true` to the `@rollup/plugin-commonjs` configuration
in the Vite configs of ALL apigen plugin packages (or globally in `nx.json`'s vite build defaults).
This tells Rollup to leave `require('perf_hooks')` calls as runtime `require()` expressions (which
Node resolves natively) rather than generating broken stubs. Verify that the resulting bundle
evaluates cleanly when dynamically imported.

**Updated assessment — HIGH severity for `--use <path>` functionality:**
- The `isLocal` detection logic is fine; the bug is in the plugin's build output.
- All `--use <path>` invocations against Vite-bundled apigen plugin dist files fail at load time.
- The builtin slug path (`--use openapi`) is unaffected.
- Fix requires a build configuration change, not a runtime code change.

**Suggested fix (optional, LOW):** add a fallback check in the `isLocal` detection that treats any spec containing a `/` (path separator) as a local path, regardless of file extension. This would catch bare directory paths like `--use dist/my-plugin` without needing a trailing `/index.js`. The `import()` would fail with a clearer error if the directory doesn't have a package.json or index.js.

**Updated status:** TRIAGED — not critical. Narrow remaining edge case: file paths without a recognizable extension fall through to bare-package resolution.

---

### BUG-APIGEN-042 — the generated OpenAPI doc's paths don't match the API plugins' actual served routes; architectural misalignment between `toOpenApi` and HTTP route registration — TRIAGED

**Reported:** live user testing, post-merge.

**Observed:** the openapi mount's generated doc uses a namespaced,
hyphenated URL structure, e.g. `/agent-browser/search-mcp-source/search`,
while the actual route served by `api-fastify` (and presumably
`api-express`) for the same operation is `/agent-browser/search` — the
openapi doc does not describe the real, callable surface.

**Triage — root cause confirmed:**

The OpenAPI plugin handler (`apigen-plugin-openapi/src/lib/plugin.ts:98-102`)
calls `toOpenApi(descriptor.operations)` directly on the raw descriptor's
operations. Inside `toOpenApi`, each operation's HTTP route is computed via
`project(op).http.route`, which uses the operation's **raw `namespace` and
`path` fields** — i.e. the TypeScript source's export structure.

The HTTP plugins (express/fastify) register routes using the **composed
schema's** package/function mapping: `${routePrefix}/${pkg.id}/${fnName}`.
This is fundamentally different from the raw operation's namespace+path.

Example:
- Raw operation: `namespace = {raw:'agent-browser', words:['agent','browser']}`,
  `path = [{raw:'searchMcpSource', words:['search','mcp','source']},
          {raw:'search', words:['search']}]`
  → `toOpenApi` route: `/agent-browser/search-mcp-source/search`
- Composed schema entry: `pkg.id = 'agent-browser'`, `fnName = 'search'`
  → HTTP plugin route: `/agent-browser/search`

The `toOpenApi` function is a pure projection of the **descriptor structure**,
not the **composed/merged package layout**. It has no access to the composed
schema's `pkg.id`/`fnName` mapping, so it cannot produce the paths the HTTP
plugins actually serve.

**Impact — MEDIUM:** The generated OpenAPI doc describes structurally correct
endpoints that don't match the callable surface. This misleads tooling
consumers (e.g., codegen clients, API explorers) that read the OpenAPI doc
to discover routes. The documentation is internally consistent (the operation
at that path exists) but doesn't describe how to actually call the service.

**Fix direction — two options:**

1. **Route mapping injection** (recommended): Add an optional `routeMap`
   parameter to `toOpenApi()` and the openapi plugin options —
   `Record<string, string>` mapping operation ids to their actual served
   HTTP routes. The caller (the compose-layer or http-plugin registration
   code) knows the real routes; it passes them to the openapi handler.
   This preserves `toOpenApi`'s pure-function identity and doesn't couple
   it to the composition layer.

2. **Consolidate route derivation** (larger scope): Make the HTTP plugins
   and `toOpenApi` share a single route derivation function that consumes
   both the raw operation AND the composed package context. Would require
   threading the composed schema through the mount handler, which currently
   receives the Descriptor directly from the mount registry (not the
   ComposedSchemas).

**Updated status:** TRIAGED — MEDIUM severity. Root cause confirmed:
architectural misalignment between `toOpenApi` (descriptor-structure-based
routing) and HTTP plugins (composed-schema-based routing). Fix via route
mapping injection (option 1).

---

### BUG-APIGEN-043 — auto-hoisted GET endpoints log a body-envelope statement instead of an accurate query-parameter statement — TRIAGED (parts 1,2 resolved; part 3 is a feature request)

**Reported:** live user testing, post-merge, after FEAT-APIGEN-022's
auto-hoist-to-GET fix landed.

**Observed:** endpoints that got auto-hoisted to GET are now logging a
message describing a body envelope (as if POST/body-carrying), not an
accurate query-parameter statement reflecting how GET requests actually
carry their arguments. Needs verification that this is a logging-only
inaccuracy and not a sign the request handling itself is still assuming a
body.

**Triage — three parts:**

---

**Part 1 — Log statement fix (logging-only inaccuracy, confirmed ✅):**

Root cause found at `apigen-plugin-api-express/src/lib/run.ts:357-361` (and the
identical pattern in `apigen-plugin-api-fastify/src/lib/run.ts`):

```typescript
for (const r of routes)
  logger.info(
    { method: r.method, route: r.route, body: { data: r.params } },
    `${r.method} ${r.route}  body { data: {${r.text ? ` ${r.text} ` : ''}} }`
  );
```

This always formats the log message as `body { data: { ... } }` regardless of
HTTP verb. For auto-hoisted GET endpoints, `r.method` is `'GET'` but the message
still says `body { data: { ... } }`. The request handling itself IS correct (the
GET handler reads from query strings via `coerceQueryParams` at line 262) —
this is a **display-only** bug in the startup log statement, not a request-
processing bug.

**Fix:** Change the log format to be verb-aware:

```typescript
const paramDesc = verb === 'GET'
  ? `query { ${r.text || ''} }`
  : `body { data: {${r.text ? ` ${r.text} ` : ''}} }`;
logger.info({ method: r.method, route: r.route, ... }, `${r.method} ${r.route}  ${paramDesc}`);
```

**Severity:** LOW — cosmetic only. Does not affect correctness.

---

**Part 2 — Complex-typed params still force POST (verified ✅):**

Verified by the test coverage that now exists in `apigen-engine-conformance` and
`apigen-codegen-openapi` (committed at `271c0a10`):
- `OP_COMPLEX_UNSAFE` / `complexOp` with array-typed input → `project().http.verb
  === 'POST'` (confirmed by `[naming.verb.POST.1]` and `[toOpenApi] complex-POST
  tests).
- `isPrimitiveOnlyInputSchema` correctly returns `false` for `array`/`object`/
  `$ref`/`oneOf`/`anyOf`/`allOf` typed properties.
- Zero regression risk — this is structurally enforced by `get-safety.ts`'s
  `isPrimitivePropertySchema`, which has dedicated unit tests in
  `apigen-core-client/src/test/get-safety.spec.ts` (120 cases covering all
  primitive, complex, and edge-case shapes).

Part 2 is **RESOLVED** — no further action needed.

---

**Part 3 — Default-method override option (feature request, not a bug):**

The existing `--opt http.verb.<id>=GET/POST` per-function override already
allows opt-out of auto-hoisting for specific operations. A global "disable
auto-hoist entirely" option would be a new feature.

**Assessment:** Not needed for correctness — the `isPrimitiveOnlyInputSchema`
heuristic correctly handles the cases described in the spec. A global override
would only be needed for API-design-preference reasons (e.g. wanting all CRUD-
style operations as POST for consistency). Can be added as a future `--opt
http.defaultMethod=POST` or similar if user demand requires it.

**Severity for part 3:** LOW — feature request, deferrable.

---

**Overall assessment:** Parts 1 and 2 are actionable and resolved. Part 3 is
a feature request. The remaining work for part 1 is a one-line log format
change in two files (express and fastify `run.ts`).

---

### BUG-APIGEN-040 (Open, filed not fixed, HIGH) — `apigen-plugin-mcp`'s `run()` never validates input against the generated schema before dispatch — bad input crashes as an uncaught exception instead of a clean rejection

**Discovered:** 2026-07-20, verifying (at the user's request) whether "the api
type plugins actually validate inputs" after this session's BUG-APIGEN-
029/030 work on the Ajv/validate-Layer stack. Confirmed live, not by
inspection alone.

**Root cause, confirmed by reading + live repro:** `api-express`/`api-fastify`'s
`run()` both call `makeValidateLayer(schemas)` (`apigen-plugin-api-{express,
fastify}/src/lib/run.ts`, wired via BUG-APIGEN-009/010) — every request runs
through a real Ajv-compiled schema check BEFORE `dispatch()` is ever called,
confirmed live: a malformed `date-time` and a missing required field both
return HTTP 400 `invalid_argument` with the handler fn provably never
invoked (`apigen-plugin-api-{express,fastify}/src/test/plugin.spec.ts`'s
existing `[BUG-APIGEN-009/010]` suite, re-run and confirmed clean this
session). `apigen-plugin-mcp/src/lib/run.ts`'s `CallToolRequestSchema`
handler (line ~104-144) does **no such thing** — it goes straight to
`dispatch(pkg.fns, pkg.createClient, meta.schema, name, envelope,
domainData)` with zero Ajv involvement; `apigen-engine-runtime/src/lib/
dispatch.ts` (confirmed by full read) contains no Ajv reference at all, only
the well-known-scalar transcoder.

**Live repro (built a throwaway in-process test using the exact harness
pattern from `run.spec.ts`'s existing `run()`+streaming-http suite, deleted
after confirming — not committed):** using the same `dateTimeSchema`
fixture as the HTTP plugins' own `[009]` test (`when: string, format:
"date-time", required`):
- Omitting `when` entirely → fn **is called**, crashes with `Cannot read
  properties of undefined (reading 'toUpperCase')`, surfaced to the MCP
  client as a generic `-32603 internal error` — not a validation error.
- `when: "2099-02-30T00:00:00.000Z"` (invalid calendar date, valid string)
  → fn **is called**, crashes with `when.toUpperCase is not a function`
  (the date-time codec evidently coerces/mangles the value without
  rejecting it).
- `when: 12345` (wrong type entirely) → this one **is** rejected, but only
  because the date-time transcoder's own decode-time wire-type check
  happens to catch it (`"[date-time] expected a string on the wire ... got
  number"`) — an incidental side effect of one specific codec's own
  precondition, not systematic schema validation. A parameter with no
  well-known codec (e.g. a plain `string`/`number`/`object` with no format)
  would get no such protection at all.

**Impact:** any MCP consumer sending malformed or incomplete tool-call
arguments gets an unstructured, generic internal-error crash instead of the
clean, actionable `invalid_argument` response every HTTP-transport consumer
already gets for the identical bad input — an inconsistency across apigen's
own transports, and a real reliability/UX gap for the MCP surface
specifically (arguably the primary consumer surface, given this is an
agent-tooling framework).

**Suggested fix:** wire `apigen-plugin-mcp/src/lib/run.ts`'s
`CallToolRequestSchema` handler through the same validate-Layer mechanism
`api-express`/`api-fastify` already use (`makeValidateLayer` from
`@adhd/apigen-engine-runtime`, or a transport-appropriate equivalent that
validates `{ data: domainData, ...envelope }` against `meta.schema.input`
before calling `dispatch()`), returning a structured MCP tool-error result
(not a thrown protocol-level exception) on validation failure — analogous
to the `[BUG-APIGEN-009/010]` fix for the HTTP plugins.

Citations: [session 2026-07-20, self-verified: `apigen-plugin-api-{express,
fastify}/src/lib/run.ts` `makeValidateLayer` wiring;
`apigen-plugin-mcp/src/lib/run.ts:104-144` no Ajv/validate-layer import or
call; `apigen-engine-runtime/src/lib/dispatch.ts` full read, no Ajv
reference; `apigen-plugin-api-express/src/test/plugin.spec.ts:538-559`
`[009]` suite re-run clean (400/invalid_argument, fn not called) this
session; live in-process repro via `run()` + streaming-http transport
(same pattern as `apigen-plugin-mcp/src/test/run.spec.ts`'s existing
suites), 3 cases as described above, not committed]

---

### BUG-APIGEN-038 (Open, filed not fixed) — `buildNominalSchema`/`buildUnionSchema` (class-based nominal/union schema builders) are not wired into the real `extract()`/`composeSchemas()` pipeline for any function parameter

**Discovered:** 2026-07-20, while fixing BUG-APIGEN-030 (AJV strict-mode
crash on `x-apigen-logical`/`discriminator`, see CHANGELOG.md — the fix
registers `X_APIGEN_LOGICAL`/`X_APIGEN_CODEC`/`X_APIGEN_CTOR`/
`X_APIGEN_TOJSON`/`discriminator` as known Ajv keywords). While writing that
fix's regression test, tried to source a real, pipeline-generated
nominal-typed function parameter (a class like `UserId` used as a param
type) to exercise `apigen-core-client/src/lib/schema-builders/nominal.ts`'s
`buildNominalSchema` through the actual `extract()` call, the same way
`named-type-param.spec.ts` (BUG-APIGEN-026) and the new BUG-APIGEN-030 union
test do for their respective shapes.

**Root cause, traced and confirmed by reading the actual source:** a
repo-wide grep for `buildNominalSchema(` / `buildUnionSchema(` call sites
(not just imports) turns up exactly one caller of each — their own spec
files (`apigen-core-client/src/test/nominal.spec.ts`,
`.../test/union.spec.ts`). `entrypoint/apigen-cli/src/lib/orchestrator.ts`
does call `extractClasses()` (confirmed at the file's own comment, line
~385: "`constructor`/`instance-method` come from the separate
`extractClasses()`"), but that usage surfaces a class's own methods as
directly-callable operations (e.g. `UserId.fromJSON` as a route) — it does
NOT embed the class's shape as a nominal `$def` inside some *other*
function's parameter schema the way a real `function wrapId(id: UserId)`
would need. Confirmed by reading `extract.ts`: no reference to
`buildNominalSchema`, `isClass`, or `extractClasses` anywhere in it. The
only currently-reachable `x-apigen-logical` producer is the inline-union
branch in `schema-builders/morph-walk.ts:181` (plain TS union types like
`A | B`), which does emit `x-apigen-logical:"union"` + `discriminator` for
real through `extract()` — that is what BUG-APIGEN-030's regression test
exercises. A user-defined class used as a function parameter type today
gets ts-json-schema-generator's plain structural object schema (no
`x-apigen-logical:"nominal"`, no `x-apigen-codec`), so `nominal-codec.ts`'s
decode path for such a parameter is presently unreachable from real
generated code — the nominal codec machinery in
`apigen-engine-runtime/src/lib/logical/nominal-codec.ts` and the advisory
hints `nominal.ts` builds exist and are tested in isolation, but have no
live producer wiring them together end-to-end for a real user source file.

**Impact:** class-typed (nominal/branded) function parameters do not
currently get transcoded via the logical-type nominal codec at all in
generated output — not a crash, but a silent gap: `ts-json-schema-generator`
produces *some* structural schema for a class type (properties reflecting
public fields), so calls likely still work for plain-data classes, but any
class relying on nominal identity/codec-driven `fromJSON`/`toJSON` transcode
(the whole point of `x-apigen-ctor`/`x-apigen-tojson`) gets the generic
structural fallback instead. Not yet triaged for real-world severity (needs
a concrete class-typed-parameter fixture run through the built CLI, e.g. a
`Decimal`- or `Date`-like custom class, to determine if this only affects a
narrow "arbitrary user class as param" case or something broader).

**Cross-references:** distinct from BUG-APIGEN-030 (Ajv strict-mode reject
of already-produced `x-apigen-*`/`discriminator` keys — that bug is about
Ajv *rejecting* the hint once produced; this one is about the hint *never
being produced* for the class/nominal case in the first place). Citations:
[session 2026-07-20, this session, while implementing BUG-APIGEN-030's fix
and regression test: `apigen-core-client/src/lib/schema-builders/nominal.ts`
(defines `buildNominalSchema`, zero non-test callers, confirmed via
repo-wide grep for `buildNominalSchema(`);
`apigen-core-client/src/lib/extract.ts` (no `buildNominalSchema`/`isClass`/
`extractClasses` reference, confirmed via grep);
`entrypoint/apigen-cli/src/lib/orchestrator.ts:385` (comment documenting
`extractClasses()`'s actual constructor/instance-method usage);
`apigen-core-client/src/lib/schema-builders/morph-walk.ts:181` (the one
currently-reachable `x-apigen-logical:"union"` producer, inline TS unions
only)]

### BUG-APIGEN-031 (ported from `main`, now fixed — see CHANGELOG.md) — `generate --type cli` output silently mishandles array-typed params: crashes or returns a wrong value instead of the real result

**Ported:** 2026-07-20. Filed and root-caused on `main`'s `entrypoint/apigen-cli/BACKLOG.md`
during `generate`-mode output verification of `apigen-cli` (`cli` and `jsonschema` plugins)
against `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts`. Not yet ported to
this worktree's own BACKLOG.md as of this worktree's last rebase from `main`. Independently
re-confirmed against this worktree's current source (commit `ac972c72`) before fixing — see
citations below; `generate.ts`, `runmode.ts`, and `dispatch.ts` were byte-identical to `main`
at the time of porting (`git diff main -- packages/apigen/apigen-plugin-cli-output/src/lib/
generate.ts packages/apigen/apigen-base-logical/src/lib/runmode.ts` → empty).

**Observed (pre-fix, reproduced live against this worktree):** the generated `cli.ts`'s `mean`
and `percentile` commands (both take a plain `number[]` param — `latency-stats.ts:17,27`) do
not work correctly when actually invoked with real array input, despite `--help` and static
inspection looking correct:

```
$ tsx cli.ts mean --arr '[2,4,6]'
TypeError: arr.reduce is not a function
    at Object.mean (.../latency-stats.ts:29:14)
    at dispatch (apigen-engine-runtime/src/lib/dispatch.ts:157:31)

$ tsx cli.ts percentile --sorted '[10,20,30,40,50]' --p 0.5
"3"                          # WRONG — percentile([10,20,30,40,50], 0.5) is 30
```

`percentile` is the dangerous case: no crash, a silently plausible-looking wrong answer — the
raw argv string `"[10,20,30,40,50]"` (16 chars) is passed straight through unparsed, so
`idx = Math.ceil(16 * 0.5) - 1 = 7` and `"[10,20,30,40,50]"[7]` happens to be the character `'3'`.

**Root cause:** `apigen-plugin-cli-output/src/lib/generate.ts` built `domainArgs` directly
from Commander's raw parsed option strings (`opts[param]`) with no JSON-parsing for
array/object-typed params, before handing them to `apigen-engine-runtime/src/lib/
dispatch.ts`'s `decodeArg` → `apigen-base-logical/src/lib/runmode.ts`'s decode path, whose
array/object branches (`if (!Array.isArray(wire)) return wire` / equivalent object check)
correctly pass a non-array/non-object wire straight through for the HTTP transports (where
`wire` is already real parsed JSON from the request body) — but that same passthrough silently
defeats the CLI transport, whose wire values are *always* raw argv strings. Scalar
(string/number/boolean) params round-trip fine; only array/object-typed params were affected.

**Status:** FIXED this session — see `## Fixed` above / CHANGELOG.md for the fix and tests.

Citations: [main's `entrypoint/apigen-cli/BACKLOG.md` BUG-APIGEN-031 writeup (full root-cause
trace + original citations); session 2026-07-20, self-verified on this worktree: repro run via
`node dist/entrypoint/apigen-cli/index.js generate --source /Users/nix/dev/ai/sox-ecosystem/
libs/memory-core/src/latency-stats.ts --type cli --out-dir <scratch> --link-workspace` then
`npx tsx cli.ts mean --arr '[2,4,6]'` and `npx tsx cli.ts percentile --sorted
'[10,20,30,40,50]' --p 0.5`, both against `fix/apigen-v1-retirement`@`ac972c72` (pre-fix);
`packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts` (pre-fix state, full read);
`packages/apigen/apigen-base-logical/src/lib/runmode.ts:187-213` (full read);
`packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:84-87` (full read);
`git diff main -- packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts
packages/apigen/apigen-base-logical/src/lib/runmode.ts` → empty, confirming pre-existing
identical-to-main before the fix in this session]

### BUG-APIGEN-037 — `py-flask`/`py-grpc` are unconditional eager imports; unpublished on npm, so an installed CLI never reaches argument parsing — MEDIUM

**Discovered:** 2026-07-20, while fixing FEAT-APIGEN-019 (CLI plugin discoverability; see
CHANGELOG). Deferred out of that fix — scope there was deriving `--type` help/error/list text
from the live `plugins` registry, not changing how plugins are *loaded*.

**Current state:** `index.ts:12-13` statically imports `@adhd/apigen-plugin-py-flask` and
`@adhd/apigen-plugin-py-grpc` unconditionally at module top-level, alongside the other 5
first-party plugins. Neither package is published on the public npm registry (confirmed via
`npm view`, both 404, still true as of 2026-07-20). Inside this workspace both resolve fine
(pnpm workspace linking), so `apigen list-types`/`--help`/every test in `apigen-cli` pass
clean and show all 8 `--type` keys — the failure mode is invisible from inside the monorepo.
For an external consumer who ran `npm install @adhd/apigen-cli`, though, those two `import`
statements would throw `ERR_MODULE_NOT_FOUND` before Commander even parses `process.argv` —
no `--help`, no error message, the process just dies. The now-registry-driven `--type`
help/list/error text FEAT-APIGEN-019 built (`src/lib/plugin-registry.ts`) never gets a chance
to run for that consumer, since the crash happens at import time, one line earlier.

**Suggested fix:** convert the two unpublished plugins' imports to a `try`/dynamic-import
pattern that's excluded from the `plugins` registry (and therefore from `list-types`/`--type`
help) when the module fails to resolve, instead of crashing the whole CLI. Needs to preserve
the standalone-bundle requirement (`vite.config.ts`'s comment on `run.ts`'s `--use` plugins:
a literal-specifier dynamic `import('@adhd/apigen-plugin-py-flask')` is still statically
analyzable by rollup and gets bundled/inlined the same as a static import — only a **fully
dynamic** runtime specifier, like `--use`'s user-supplied string, can't be pre-bundled) —
so this is very likely safe to do without breaking the standalone dist build, but needs an
actual green `dist/entrypoint/apigen-cli` build + a simulated "package absent" test (mirroring
the existing `LibResolver` injection pattern in `run.ts`'s `assertDecimalLibPresent`) to prove
it before landing.

**Status:** OPEN, MEDIUM.

Citations: [self-verified 2026-07-20: `entrypoint/apigen-cli/src/index.ts:12-13` (unconditional
eager imports), `entrypoint/apigen-cli/package.json:23-24` (both listed as regular deps, not
optional), `entrypoint/apigen-cli/vite.config.ts:1-50` (standalone-bundle rollup config,
`external` list excludes both packages so they're meant to be inlined), `src/lib/commands/run.ts:22-26`
(comment explaining static-vs-dynamic-import bundling constraint for `--use` plugins);
`npm view @adhd/apigen-plugin-py-flask`/`@adhd/apigen-plugin-py-grpc` → both 404]

### BUG-APIGEN-039 (Open, filed not fixed, low-severity, follow-up to BUG-APIGEN-034) — `opMatchesExportMode()`'s "known residual limitation" now also covers anonymous default exports (Shape 4 anon sub-case + Shape 5), not just named default functions

**Discovered:** 2026-07-20, while fixing BUG-APIGEN-033 (anonymous default-export dispatch
crash) in the same session/branch. BUG-APIGEN-034's CHANGELOG entry already documents, as an
explicitly-accepted "known residual limitation," that `opMatchesExportMode()`
(`orchestrator.ts:342-349`) can't distinguish Shape 4's *named* default function
(`export default function foo(){}`, `op.path = [file, 'foo']`) from a plain named export under
`--export named` mode, since both produce an identical 2-segment `[file, name]` path — and
notes this was deliberately left unresolved because "extract.ts was being concurrently edited
by another fix in the same branch" (this fix, BUG-APIGEN-033).

**What changed:** BUG-APIGEN-033's fix renames Shape 5 (anonymous arrow/FunctionExpression
default export) and Shape 4's anonymous function-declaration sub-case from a filename-derived
synthetic leaf name (1 path segment, e.g. `[anonymous_default_default]`) to the literal
`'default'` under a `[fileSegment, 'default']` 2-segment path (`extract.ts`, `buildActionOp`
call sites for both shapes) — required so the op name matches `buildFnTable()`'s runtime
`.name`-derived key (see BUG-APIGEN-033's CHANGELOG entry for why). This moves BOTH anonymous
shapes into the SAME 2-segment `[file, name]` bucket `opMatchesExportMode()` already can't
disambiguate from a plain named export.

**Net effect on `opMatchesExportMode()`:** before this fix, both anonymous shapes had a
1-segment path, so they matched NEITHER `'named'` (`path.length === 2`) NOR `'default'`
(`path.length === 3 && path[1].raw === 'default'`) — silently excluded from BOTH `--export
named` and `--export default`. After this fix, they now match `'named'` (a false positive: an
anonymous default export served under `--export named`) but still don't match `'default'` (a
false negative: still not served under `--export default`, where a caller would actually expect
it). Neither the before nor after state is correct, but this is the identical class of gap
BUG-APIGEN-034 already accepted for Shape 4's named case — not a new kind of bug, just a wider
blast radius for the same one.

**Suggested fix:** add the explicit export-shape discriminator BUG-APIGEN-034's CHANGELOG entry
already proposes deferring to (a field on `Operation`, e.g. `exportShape: 'named' | 'default-fn'
| 'default-object' | 'cjs'`, set once in `extract.ts` at the same call sites already
disambiguating these shapes) so `opMatchesExportMode()` stops inferring shape from `path.length`
entirely. Out of scope here — this is a shared-descriptor schema change spanning `extract.ts`,
`orchestrator.ts`, and any downstream consumer of `Operation.path`, not a one-file fix, and
BUG-APIGEN-034 already correctly identified it as its own follow-up.

**Status:** OPEN, low-severity (only reachable via explicit `--export named`/`--export default`
against a source using either anonymous-default shape — `generate`/`run` without `--export`,
and both `registry` commands where `exportMode` is never set, apply no scoping and are
unaffected).

Citations: [self-verified 2026-07-20: `entrypoint/apigen-cli/src/lib/orchestrator.ts:342-349`
(`opMatchesExportMode()`); `entrypoint/apigen-cli/CHANGELOG.md` BUG-APIGEN-034 entry, "Known
residual limitation" paragraph (pre-existing, same class of gap for Shape 4's named case);
`packages/apigen/apigen-core-client/src/lib/extract.ts` Shape 5 + Shape 4 anonymous
sub-case (this session's BUG-APIGEN-033 fix, `buildActionOp` calls with `'default'`)]

---

### BUG-APIGEN-031 — `generate --type cli` output silently mishandles array-typed params: crashes or returns a wrong value instead of the real result

**Discovered:** 2026-07-19, during `generate`-mode output verification of `apigen-cli` (`cli` and
`jsonschema` plugins) against `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts`
(140 extracted / 130 composed operations — both plugin outputs correctly reflect all 130, so
this is unrelated to the v1-extraction-dropped-reexports class of bug).

**Observed:** the generated `cli.ts`'s `mean` and `percentile` commands (both take a plain
`number[]` param — `latency-stats.ts:17,27`) do not work correctly when actually invoked with
real array input, despite `--help` and static inspection looking correct:

```
$ tsx cli.ts mean --arr '[2,4,6]'
TypeError: arr.reduce is not a function
    at Object.mean (.../latency-stats.ts:29:14)
    at dispatch (apigen-engine-runtime/src/lib/dispatch.ts:157:31)

$ tsx cli.ts percentile --sorted '[10,20,30,40,50]' --p 0.5
"3"                          # WRONG — percentile([10,20,30,40,50], 0.5) is 30
```

The `percentile` case is the dangerous one: it does not crash, it silently returns a
plausible-looking but wrong answer. `sorted` never gets parsed into an array — the raw
argv string `"[10,20,30,40,50]"` (16 chars) is passed straight through, so
`idx = Math.ceil(16 * 0.5) - 1 = 7` and `"[10,20,30,40,50]"[7]` happens to be the character
`'3'` — coincidence, not correctness. (Confirmed by first testing with `[1,2,3,4,5]` →
`p50=3`, which is *also* the correct answer for the real array, i.e. a false-positive trap;
re-running with an array whose string-index-7 doesn't match its true p50 exposed the bug.)

**Root cause, traced end to end:**
1. `apigen-plugin-cli-output/src/lib/generate.ts:181-197` emits one Commander `.option`/
   `.requiredOption` per domain param with no type-aware parsing — every flag value Commander
   captures is the bare argv string.
2. `generate.ts:199-203` builds `domainArgs` directly from `opts[paramName]` — no
   `JSON.parse` (or any parse) is ever applied to array/object-typed param values before they
   reach dispatch.
3. `apigen-engine-runtime/src/lib/dispatch.ts:84-87` (`decodeArg`) hands the still-a-string
   wire value to `_transcoder.decode(wire, node)` unconditionally.
4. `apigen-base-logical/src/lib/runmode.ts:190-193` — the transcoder's own array branch:
   ```ts
   if (schemaType === 'array') {
     if (!Array.isArray(wire)) {
       return wire;          // ← silent passthrough, no parse/coerce, no error
     }
   ```
   A non-array `wire` (the CLI's raw string) is returned unchanged instead of being parsed or
   rejected. This line is correct/necessary for `run`-mode HTTP transports (Express/Fastify
   already deliver a real parsed array from a JSON body — `Array.isArray(wire)` is true there),
   but it means the `cli` plugin — the one caller whose "wire" value is *always* a raw argv
   string — gets no array coercion anywhere in the pipeline. `object`-typed domain params
   share the identical code path (`runmode.ts`'s object branch has no coercion path either)
   and are very likely equally broken, though not independently re-verified with a live
   object-typed param this session (scalar `string`/`number`/`boolean` params ARE handled
   correctly — Commander's own string capture plus the transcoder's scalar codecs round-trip
   fine, confirmed via `percentile --p 0.5` correctly reaching `Math.ceil(sorted.length * 0.5)`
   with `p` as a real number).

**Impact:** every generated-`cli`-output command whose schema has an `array`- or (likely)
`object`-typed domain param is broken for real use — either a hard crash (arrays walked with
`.map`/`.reduce`/etc.) or a silently wrong answer (arrays consumed via indexing, e.g.
`sorted[idx]`, since JS strings support numeric indexing). Scalar-only commands are unaffected.
Not the same bug as BUG-APIGEN-030 (AJV `x-apigen-logical` strict-mode crash, HTTP dispatch
transport only) — this reproduces in `generate --type cli`'s own standalone output with no
HTTP/AJV layer involved at all, and no `x-apigen-logical` hint on either affected param.

**Suggested fix:** `apigen-plugin-cli-output/src/lib/generate.ts` should `JSON.parse` (or emit
code that does so at runtime) any argv value destined for an `array`- or `object`-typed domain
param before constructing `domainArgs`, OR `runmode.ts:190-193`'s passthrough should be
tightened so a non-array `wire` for an `array`-typed node is treated as a decode error (or is
itself JSON.parsed when it's a string) rather than silently passed through — whichever fix is
chosen must not regress the `run`-mode HTTP transports, which correctly rely on the current
passthrough when `wire` is already a real array.

**Status:** OPEN. Verified identical on `main` (`packages/apigen/apigen-engine-runtime/src/lib/
dispatch.ts` and `packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts` are byte-
identical between `main` and the `fix/apigen-v1-retirement` worktree at `80e1df8d`) — this is
pre-existing, not introduced by the v1-retirement change. Scope: `apigen-plugin-cli-output`
(`generate.ts`), `apigen-base-logical` (`runmode.ts` array/object decode branches).

Citations: [session 2026-07-19, self-verified: repro run via `node dist/entrypoint/apigen-cli/
index.js generate --source .../memory-core/src/index.ts --type cli --out-dir <scratch>` then
`tsx cli.ts mean --arr '[2,4,6]'` and `tsx cli.ts percentile --sorted '[10,20,30,40,50]' --p
0.5`, both against `fix/apigen-v1-retirement`@`80e1df8d`;
`packages/apigen/apigen-plugin-cli-output/src/lib/generate.ts:181-197,199-231` (full read);
`packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:62-87,120-159` (full read);
`packages/apigen/apigen-base-logical/src/lib/runmode.ts:162-220` (full read);
`/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/src/latency-stats.ts:17,27` (`percentile`/
`mean` real signatures); `diff` of `dispatch.ts` and `generate.ts` between `main` and the
`fix/apigen-v1-retirement` worktree → byte-identical, confirming pre-existing on `main`]

### BUG-APIGEN-032 — `generate --type api-express`/`api-fastify` `-registry` output emits invalid TypeScript for any hyphenated package name (unsanitized identifier splice)

**Discovered:** 2026-07-19, by an agent independently verifying `generate-registry`/
`run-registry` (multi-package discovery/serving) against the `entrypoint/apigen-cli/src/test/
fixtures/registry/{pkg-a,pkg-b}` fixture — both real Nx-style package ids, both hyphenated
(`pkg-a`, `pkg-b`), which is the overwhelmingly common naming convention in this monorepo (and
most Nx workspaces generally).

**Observed:** `node dist/entrypoint/apigen-cli/index.js generate-registry --type api-express
--packages-dir <fixtureDir> --out-dir <dir> --tag api` exits `0` and writes a `routes.ts` file
whose *data* (routes, schemas) is correct — but whose *code* is not valid TypeScript/JavaScript:

```ts
import * as pkg-a_ns from '@test/pkg-a'
const pkg-a_fns = buildFnTable(pkg-a_ns as Record<string, unknown>)
```

`pkg-a_ns` / `pkg-a_fns` are not legal identifiers (a bare `-` is the subtraction operator, not
a valid identifier character). Confirmed a genuine syntax error via `esbuild` (not just a
`node --check` quirk — `node --check` silently accepts this file, and even a 1-line repro
`import * as pkg-a_ns from 'foo'`, because `--check`'s parser is more permissive than the real
ESM/CJS toolchains consumers actually build with; `esbuild` correctly rejects both with
`Expected "from" but found "-"`). Reproduces identically in `api-fastify`'s equivalent output.

**Root cause, confirmed by reading the source directly (not guessed):**

- `apigen-plugin-api-express/src/lib/generate.ts:55,57,106,127` and
  `apigen-plugin-api-fastify/src/lib/generate.ts:66,68,121,144` splice the discovered package id
  straight into identifier positions — `` `import * as ${pkg.id}_ns from ...` ``,
  `` `const ${pkg.id}_fns = ...` `` — with **no sanitization** of `pkg.id` before it lands in
  code (as opposed to a string literal — `pkg.id` is also used correctly as a plain string
  namespace key elsewhere in the same files, e.g. `schemas['${pkg.id}:${fnName}']`, which is
  fine; only the *identifier* splices are the problem).
- `apigen-plugin-cli-output/src/lib/generate.ts:66-70` already has the fix, and has clearly
  known about this exact hazard for a while — it defines a local `sanitizeIdentifier(id)`
  helper (`` id.replace(/[^a-zA-Z0-9_$]/g, '_')``, plus a leading-digit guard) with a doc
  comment explicitly calling out "an invalid identifier, a hard TS parse error" as the failure
  mode being avoided, and calls it (`const varName = sanitizeIdentifier(pkg.id)`, `:96,122`)
  before ever using the id in an identifier position. Confirmed via `--type cli` against the
  SAME fixture: it correctly emits `pkg_a_ns`/`pkg_a_fns` (underscore, valid JS) — the resulting
  `cli.ts` only fails `esbuild` on unresolved external deps (expected, not installed in the
  scratch dir), not on syntax. `--type jsonschema` is unaffected entirely (no identifiers in its
  output at all).
- `sanitizeIdentifier` is currently a **private, unexported** function local to
  `apigen-plugin-cli-output/src/lib/generate.ts` — not a shared utility — so api-express/
  api-fastify never had access to reuse it even if their authors had thought to.

**Impact:** `generate-registry --type api-express` / `--type api-fastify` produces genuinely
broken, unbuildable output for any discovered package whose id/name contains a character that
isn't a valid JS identifier character — hyphens being the overwhelmingly common case in any
kebab-case-named package (which is most Nx packages, including this very monorepo's `pkg-a`/
`pkg-b` test fixtures and virtually every real `@scope/some-package-name`). Single-source
`generate --type api-express`/`api-fastify` (non-registry) is unaffected — this only reproduces
in the `-registry` variants, where a real discovered package id (as opposed to a user-supplied
`--namespace` string, which the CLI can require to already be identifier-safe) drives the
per-package identifier. `run-registry` (the live-server path) is unaffected — it imports source
modules directly at runtime via `importSource`/`buildFnTable` rather than emitting generated
code with derived identifiers, so it never constructs an identifier from `pkg.id` at all.

**Suggested fix:** extract `apigen-plugin-cli-output/src/lib/generate.ts`'s
`sanitizeIdentifier()` to a shared location (e.g. `apigen-core-client` or a small shared
codegen-utils package, since three plugins now need it) and call it at the equivalent identifier
construction sites in `apigen-plugin-api-express/src/lib/generate.ts:55,57` and
`apigen-plugin-api-fastify/src/lib/generate.ts:66,68` (and their dispatch-call-site reuses at
`:106,127` / `:121,144`) exactly as `cli-output` already does — this is a narrow, mechanical fix
once the helper is shared, not a design problem.

**Status:** OPEN. Confirmed unrelated to the `fix/apigen-v1-retirement` branch — that branch
never touches `apigen-plugin-api-express`/`apigen-plugin-api-fastify` at all (absent from its
`git diff main...HEAD --stat`), so this is pre-existing on `main` itself, not a regression from
that work.

Citations: [session 2026-07-19, sub-agent `verify-registry-commands`, self-verified against
source by this session: `apigen-plugin-api-express/src/lib/generate.ts:55,57,106,127`;
`apigen-plugin-api-fastify/src/lib/generate.ts:66,68,121,144`;
`apigen-plugin-cli-output/src/lib/generate.ts:59-70,96,122` (existing `sanitizeIdentifier` +
its doc comment); repro via `node dist/entrypoint/apigen-cli/index.js generate-registry --type
api-express --packages-dir entrypoint/apigen-cli/src/test/fixtures/registry --out-dir <scratch>
--tag api` against `fix/apigen-v1-retirement`@`80e1df8d`, `esbuild` syntax-check on the emitted
`routes.ts` and on a minimal 1-line repro]

