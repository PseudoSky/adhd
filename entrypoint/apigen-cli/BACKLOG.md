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

## Open

### FEAT-APIGEN-019 — CLI doesn't discoverably list available `--type` plugins (help text stale, `run` commands give no options at all) — HIGH

**Requested:** 2026-07-19 by the user, directly.

**Ask:** the CLI should support listing the available `--type` plugin options; `--help` text
should show them; and the error response on an incorrect `--type` should include the list.

**Current state, verified against `entrypoint/apigen-cli/src/`:**

1. **No list command/flag exists at all.** There's no `apigen list-types`, no `--list`, nothing
   — the only way to discover valid `--type` values today is to read source, hit an error, or
   already know them.
2. **`generate`'s `--type` help text is a hardcoded, already-stale string**
   (`generate.ts:189-190`: `'Output target: mcp | api-fastify | api-express | cli |
   jsonschema'`). It's missing `py-flask` and `py-grpc` — both of which ARE real keys in the
   actual `plugins` map built in `index.ts:16-30` (`mcp`, `jsonschema`, `api-fastify`,
   `api-express`, `cli`/`cli-output`, `py-flask`, `py-grpc` — 7 distinct targets, 8 keys
   counting the `cli`/`cli-output` alias). It's a hand-maintained string, not derived from the
   plugin registry, so it drifts every time a plugin is added — confirmed it already has.
3. **`run`'s and `run-registry`'s `--type` help text is worse — zero information.**
   `run.ts:215` and `run-registry.ts:42` both just say `'Output target'`, no options listed
   at all.
4. **Error behavior is inconsistent across commands, and one path is actively misleading.**
   `generate.ts:242-248` and `generate-registry.ts:69` DO already throw `Unknown --type: X.
   Available: ${Object.keys(plugins).join(', ')}` — this part partially exists and works
   correctly today. But `run.ts:260-261` and `run-registry.ts:74-75` use
   `if (!plugin?.run) throw new Error('Plugin ${opts.type} does not support run mode')` — a
   single check that conflates two different failures with one message: a genuinely unknown/
   misspelled `--type` gets the SAME wording as a real, valid plugin (e.g. `jsonschema`,
   `cli` — both documented generate-only) that legitimately has no `run()`. A typo'd `--type`
   reads as "this plugin exists but doesn't support run" instead of "this isn't a recognized
   plugin at all — did you mean one of: …". Neither `run` path lists available options.

   **Live field confirmation, 2026-07-19:** the user ran `apigen run --type express ...`
   (a natural guess — the real key is `api-express`, no bare `express` alias exists) and hit
   exactly this: `Error: Plugin express does not support run mode` at
   `dist/entrypoint/apigen-cli/index.js:14:9868`. Reproduced independently, byte-for-byte
   identical, via `node dist/entrypoint/apigen-cli/index.js run --type express --source
   packages/apigen/apigen-core-client/src/index.ts --namespace test`. This is the concrete
   case the fix needs to handle: a plausible near-miss of a real plugin id (`express` vs.
   `api-express`) getting a misleading "doesn't support run mode" instead of "unknown --type,
   did you mean api-express? Available: …".

**Why this matters beyond convenience:** two of the seven target plugins imported into
`plugins` — `@adhd/apigen-plugin-py-flask` and `@adhd/apigen-plugin-py-grpc`
(`index.ts:12-13`) — are NOT published on the public npm registry (confirmed via `npm view`,
both 404). Those imports are unconditional, top-level, eager `import` statements, so for any
consumer who actually installed `@adhd/apigen-cli` from npm, they'd never resolve and the CLI
would fail before even reaching argument parsing — no `--help`, no error message, nothing. A
truly registry-driven list/help/error mechanism should be built to reflect what's *actually
loaded*, not a static ideal list — which would also surface this exact problem clearly to a
real user instead of an opaque module-resolution crash.

**Suggested fix:** derive the `--type` help text and all error-path option lists from a single
source of truth (the `plugins` record itself, or a shared registry module `generate.ts`/
`generate-registry.ts`/`run.ts`/`run-registry.ts` all import from) so they can never drift
again; add an explicit `apigen list-types` (or `--list-types`) command; and split `run`'s
`!plugin?.run` check into two distinct branches — "unknown `--type`: X. Available: …" vs.
"plugin X exists but doesn't support run mode. Generate-only plugins: …" — each listing the
relevant subset.

**Status:** OPEN, HIGH.

Citations: [self-verified 2026-07-19: `entrypoint/apigen-cli/src/index.ts:6-30` (plugins
map + eager imports), `src/lib/commands/generate.ts:189-190,242-248` (stale help text,
existing dynamic error listing), `src/lib/commands/run.ts:215,260-261` (bare help text,
conflated error), `src/lib/commands/run-registry.ts:42,74-75` (same pattern),
`src/lib/commands/generate-registry.ts:30,69` (same dynamic-listing pattern as generate.ts);
`npm view @adhd/apigen-plugin-py-flask`/`@adhd/apigen-plugin-py-grpc` → both 404]

### BUG-APIGEN-017 — MCP tool schemas don't reject unknown properties

**Reported:** 2026-07-06  
**Source:** `scratch-agent-search` consumer (agent-browser project)

**Observed:** Calling a zero-argument MCP function like `tripwireStatus` with an extraneous
`{ data: { provider: "duckduckgo" } }` envelope was silently accepted. The extra property
was ignored without error, so the caller never realized the mistake.

**Root cause:** apigen-cli generates MCP input schemas without `additionalProperties: false`.
The MCP SDK (and Zod, if used) silently discards unknown properties by default.

**Impact:** Consumer mistakes are invisible — agents can pass invalid parameters and get
a successful response back, with no indication the parameter was unused.

**Suggested fix:** Generate input schemas with `additionalProperties: false` in the JSON
Schema output, or configure the MCP server to reject unknown properties. This applies
to the `dispatch` path in the generated server template and/or the runtime MCP adapter.

**Affected tools:** All zero-argument functions (`listProviders`, `chromeStatus`,
`tripwireStatus`, `launchChrome`) plus any function where extra params could silently
be ignored.

**Workaround (consumer side):** Add guard clauses to exported functions that log warnings
for unexpected parameters. This was applied to `search-mcp-source.ts` in agent-browser.

---

### BUG-APIGEN-018 — Tool descriptions don't include default parameter values

**Reported:** 2026-07-06
**Source:** scratch-agent-search MCP surface (`search-mcp-source.ts`)

**Observed:** Functions have parameter defaults in their TypeScript signature
(e.g. `search(provider = '', query = '', strategy = 'auto', ...)`), but the
generated MCP tool input schema `description` fields don't communicate these
defaults. A consumer calling `search()` doesn't know that `strategy` defaults
to `"auto"`, `includeContent` to `false`, or `maxContentSize` to `0`.

**Impact:** Consumers either guess defaults, hardcode them unnecessarily, or
pass `undefined` for every optional parameter.

**Suggested fix:** Include the JSDoc `@default` tag (or inline default value)
in the generated parameter description. If the function parameter has a
TypeScript initializer, apigen-cli should extract that value and emit it as
`description: "... (default: auto)"` in the schema.

---

### BUG-APIGEN-019 — Union return types produce weak MCP schemas

**Reported:** 2026-07-06
**Source:** scratch-agent-search MCP surface (`search-mcp-source.ts`)

**Observed:** The `search()` function has a return type of
`SearchResponse | Record<string, unknown>`. The first arm is the real result
shape; the second arm is the help/no-query response. apigen-cli generates a
schema that represents this as a very permissive `object` type, which gives
consumers no structured information about what fields to expect in either case.

**Impact:** Agents can't statically determine the response shape. They have
to infer from runtime examples rather than from the tool schema itself.

**Suggested fix:** Support discriminated union return types in the generated
schema (e.g. `oneOf` with `discriminator`), or allow the consumer to define
multiple return types per tool and let the schema reflect which fields
appear under which `outcome` values.

---

### BUG-APIGEN-020 — Generated tool schemas don't document the `data` envelope

**Reported:** 2026-07-06
**Source:** scratch-agent-search consumer (agent-browser project)

**Observed:** apigen-cli wraps all function parameters in a `data` envelope
for the MCP transport. The actual call structure is:
```typescript
callTool({ name: "search", arguments: { data: { provider: "npm", query: "test" } } })
```
But the generated tool name (`search_search`) and the `data` envelope convention
are not documented in the tool descriptions or the server metadata. Consumers
have to discover this from trial and error.

**Impact:** Every new consumer spends a round-trip figuring out the calling
convention. The `data` envelope and underscored tool names are apigen-specific
conventions that differ from standard MCP tool usage.

**Suggested fix:** Add the tool naming convention and data-envelope structure
to either (a) the generated server metadata, (b) each tool's description
string, or (c) a standard response from a meta-tool.

---

### FEAT-APIGEN-022 — Auto-hoist actions with properly-typed primitive params to GET, across all HTTP api types

**Requested:** 2026-07-19 by the user, directly.

**Ask:** apigen should be able to project a function to `GET` automatically when its
parameters are "properly typed" primitives, instead of requiring the manual
`--opt http.verb.<id>=GET` override for every such function — and it should apply
uniformly across every HTTP-emitting api type, not per-plugin.

**Current state, verified:**

1. **Verb is never derived from parameter types anywhere in the pipeline today** — only
   from the categorical `kind` field, which is `'action'` for *every* function export
   regardless of its signature. `kind: 'action'` hardcodes `safe: false`
   (`apigen-core-client/src/lib/extract.ts:511-514`, comment `// action → false per §4` —
   a fixed default, not an inference). `kind: 'query'` (→ `safe: true`, `extract.ts:540-543`)
   is reserved for non-function serializable *data constants* — the extractor only reaches
   it in the `else` branch after ruling out `ArrowFunction`/`FunctionExpression`/
   `ObjectLiteralExpression` initializers (`extract.ts:261-275`); a function is never routed
   there. `apigen-engine-naming`'s `project()` — the single source of truth for HTTP verb —
   then derives the verb purely from `op.safe`: `op.safe ? 'GET' : 'POST'`
   (`apigen-engine-naming/src/lib/naming.ts:140`). No parameter types are inspected by any
   of this.
2. **The only way to get `GET` today is the manual per-operation override**
   (`--opt http.verb.<id>=GET` or an equivalent `--config` file entry, i.e.
   `ProjectionConfig.http.verb`), consumed by an identical `httpVerb()` helper duplicated at
   all four HTTP-transport call sites: `apigen-plugin-api-express/src/lib/run.ts:26-34` +
   `apigen-plugin-api-express/src/lib/generate.ts:14-17`, and the fastify equivalents,
   `apigen-plugin-api-fastify/src/lib/run.ts:25-34` (approx.) +
   `apigen-plugin-api-fastify/src/lib/generate.ts:11-26`.
3. **Even the manual override is unsafe for non-string params today.** The `GET` branch in
   both `run.ts`s (`apigen-plugin-api-express/src/lib/run.ts:234-262`, fastify mirrors) and
   both `generate.ts`s (`apigen-plugin-api-express/src/lib/generate.ts:92-106`,
   `apigen-plugin-api-fastify/src/lib/generate.ts:103-121`) sources domain args straight
   from `req.query`/`request.query` with a bare `as Record<string, unknown>` cast — no
   parsing or coercion. The shared validate-Layer's Ajv instance is constructed with no
   `coerceTypes` (`apigen-engine-runtime/src/lib/validate-layer.ts:51`:
   `new Ajv({ allErrors: true })`), so any param typed `number`/`boolean`/`integer` arrives
   as a raw query-string and fails its `type` check, hard-rejecting the call with
   `ApiError{invalid_argument}` before the target function is ever dispatched. Confirmed by
   code inspection this session, not yet reproduced against a live route — needs a spawned-
   bin e2e regression fixture (same pattern as BUG-APIGEN-021's fix) before any of this
   ships, both to prove the current break and to guard the eventual coercion fix.
4. **"Properly typed primitives" needs a hard, explicit boundary** — query-string
   serialization isn't reliable for anything else. `string`/`number`/`boolean`/`integer` are
   safe; `array`/`object`/union/logical types (e.g. `decimal` as a wire string) are not
   reliably round-trippable without a serialization convention apigen doesn't currently
   define anywhere in this pipeline. Express's default `qs` query parser supports
   bracket-notation nesting (`?a[x]=1`), but nothing here emits or documents that encoding,
   and Fastify's default query parser doesn't support nested objects at all — so even if one
   plugin were made to cope, behavior would diverge across "all api types" unless the
   primitive-only boundary is enforced centrally.

**Design risk to flag before implementing:** auto-hoisting by param shape alone conflates
"GET-representable" with "safe/idempotent" — two different questions. apigen currently has
**no signal anywhere** for whether a function has side effects; `kind: 'action'` is assigned
to every function indiscriminately (point 1 above). A zero/primitive-arg function like
`resetCounter(): Promise<void>` or `deleteUser(id: string)` is trivially "primitive-typed"
by this proposal's own criterion, yet very much unsafe to expose as a cacheable,
prefetchable, browser-history-and-proxy-logged `GET`. Hoisting purely on parameter shape,
without *also* requiring an explicit safety signal, would silently make destructive actions
GET-cacheable. This needs a design decision (e.g.: primitive-typing only relaxes the
*param-shape precondition* for hoisting; the actual safe/unsafe decision still requires an
explicit opt-in — a `kind: 'query'` extension once purity is inferable, or an explicit
per-function marker — never an automatic default from typing alone).

**Suggested fix (staged):**

1. Add param-shape validation to the *existing* manual-override path first (reject or warn
   when `--opt http.verb.<id>=GET` targets an operation with a non-primitive-typed param) —
   closes the currently-broken manual path with the least risk, independent of auto-hoist.
2. Add query-value coercion to the validate-Layer (Ajv `coerceTypes: true`, scoped to the
   query-args validation pass only — must not affect body/POST validation) so primitive
   params actually round-trip once `GET` is chosen, manually or automatically.
3. Only then implement auto-hoisting, gated behind an explicit safety signal rather than
   parameter shape alone (see design risk above) — never silently promote every
   all-primitive-param function to `GET` by default.
4. Implement the derivation once in `apigen-engine-naming`'s `project()` (already the single
   source of truth for verb derivation) so all four call sites (express/fastify × run/
   generate) inherit it automatically instead of needing four separate patches.

**Status:** OPEN. Scope: `apigen-core-client` (extract.ts `kind`/`safe` derivation),
`apigen-engine-naming` (`project()` verb default), `apigen-engine-runtime` (validate-Layer
coercion), `apigen-plugin-api-express` (`run.ts`, `generate.ts`), `apigen-plugin-api-fastify`
(`run.ts`, `generate.ts`).

Citations: [session 2026-07-19, self-verified by direct file read:
`apigen-core-client/src/lib/extract.ts:261-275,511-514,540-543`;
`apigen-engine-naming/src/lib/naming.ts:10,140`;
`apigen-core-client/src/lib/descriptor.ts:195-200`;
`apigen-core-client/src/lib/descriptor.schema.json:54-56`;
`apigen-plugin-api-express/src/lib/run.ts:26-34,234-286`;
`apigen-plugin-api-express/src/lib/generate.ts:7-17,84-106`;
`apigen-plugin-api-fastify/src/lib/run.ts:25-34(approx),271-313`;
`apigen-plugin-api-fastify/src/lib/generate.ts:11-26,95-121`;
`apigen-engine-runtime/src/lib/validate-layer.ts:51`;
`entrypoint/apigen-cli/src/lib/orchestrator.ts:149-170` (override parsing)]

---

### FEAT-APIGEN-023 — Zero-parameter, zero-envelope operations still require an empty `data: {}` (or full envelope) in the published schema

**Requested:** 2026-07-19 by the user, directly.

**Ask:** a route/tool/command with no parameters shouldn't require a caller to send
`data`, a body, an envelope, etc. — calling it should need nothing beyond the
name/path.

**Current state, verified:** this is not an oversight — it is a **named, deliberate
invariant** in the code, and the request conflicts with it directly.
`apigen-core-client/src/lib/compose-schemas.ts:89` states:
`// data: {} wrapper — always present, even for zero-param fns
[inv:data-wrapper-always-present]`, and the outer composed schema unconditionally
includes `'data'` in its `required` array regardless of whether the function has
any parameters (`compose-schemas.ts:101-102`:
`required: [...envelopeRequired, 'data']`). The *nested* `data` object's own
`required` is correctly omitted when the function has no domain params
(`compose-schemas.ts:95`: `...(domainRequired.length > 0 ? { required:
domainRequired } : {})`), but the wrapper key itself is never optional — so the
published `inputSchema` for a truly zero-arg function (e.g. `listProviders`,
`tripwireStatus` — see BUG-APIGEN-017) still tells every consumer `data` is a
required top-level property, just one that happens to validate against `{}`.
`composeSchemas()` is the single point that feeds every transport
(`apigen-engine-runtime/src/lib/api-package.ts:61`,
`entrypoint/apigen-cli/src/lib/pipeline.ts:42`,
`entrypoint/apigen-cli/src/lib/orchestrator.ts:355`), so this affects the
generated/published schema for MCP, api-express, and api-fastify uniformly (and
by extension anything else that reads `ComposedSchemas`).

**Important distinction — this is a *schema/documentation* issue, not (yet) a
runtime one.** At every transport actually inspected this session, an omitted
body/args/data already defaults to `{}` at runtime and nothing crashes:
- HTTP POST: `const { data = {} } = req.body ?? {}`
  (`apigen-plugin-api-express/src/lib/run.ts:267`, fastify mirrors).
- HTTP GET: `domainArgs: req.query as Record<string, unknown>` — an empty query
  string is already `{}` (`apigen-plugin-api-express/src/lib/run.ts:254`).
- MCP: `const { name, arguments: args = {} } = req.params;` then
  `const domainData = (args['data'] ?? {})`
  (`apigen-plugin-mcp/src/lib/run.ts:93,105`).
- The validate-Layer itself always *synthesizes* `{ data: call.domainArgs,
  ...call.envelope }` server-side before validating
  (`apigen-engine-runtime/src/lib/validate-layer.ts:122-125`) — so `data` is
  present in the object being validated regardless of what the wire caller sent.

So the friction is specifically that the **published schema** (what an MCP host,
an LLM tool-caller, or any strict schema-driven client reads to decide how to
call the tool) asserts `data` is mandatory even for an operation with nothing to
put in it — adding unnecessary ceremony/tokens for callers and, for any client
that validates arguments against `inputSchema` before sending (unlike apigen's
own permissive server-side defaults), a real hard requirement to send `{"data":
{}}` for something that conceptually takes no input at all.

**Suggested fix:** in `composeSchemas()`, only include `'data'` in the outer
`required` array when there's something that actually makes it non-optional —
i.e. `domainRequired.length > 0` (the function has ≥1 required param) — mirroring
the exact same condition already used for the nested schema's own `required`
(`compose-schemas.ts:95`). Keep the `data` *property* declared either way (so
`{"data": {}}` still validates, for callers who send it out of habit or
symmetry) — only the top-level `required` entry becomes conditional. Same
treatment for `envelopeRequired` if a specific envelope field is itself
optional. This directly relaxes `[inv:data-wrapper-always-present]` for the
no-required-anything case; the invariant's uniform-shape rationale (stated in
`buildEnvelopeDescription`'s JSDoc, `compose-schemas.ts:8-17`) still holds for
every function that has at least one required param or envelope field, so this
is a narrow carve-out, not a wholesale removal of the convention.

**Status:** OPEN. Scope: `apigen-core-client/src/lib/compose-schemas.ts` (the
single fix point — propagates to MCP, api-express, api-fastify automatically
since they all consume `ComposedSchemas`).

Citations: [session 2026-07-19, self-verified by direct file read:
`apigen-core-client/src/lib/compose-schemas.ts:8-17,42-58,89-116`;
`apigen-engine-runtime/src/lib/api-package.ts:61`;
`entrypoint/apigen-cli/src/lib/pipeline.ts:42`;
`entrypoint/apigen-cli/src/lib/orchestrator.ts:355`;
`apigen-plugin-api-express/src/lib/run.ts:254,267`;
`apigen-plugin-mcp/src/lib/run.ts:93,105`;
`apigen-engine-runtime/src/lib/validate-layer.ts:122-125`]

---

### BUG-APIGEN-024 — `--use openapi` mount produces an empty OpenAPI doc (`paths: {}`) on live `run`

**Discovered:** 2026-07-19, while answering whether exposing an OpenAPI schema would be
simple — it turns out `@adhd/apigen-plugin-openapi` already exists and is a real,
spec-conformant implementation (`toOpenApi()` in `packages/apigen/codegen/openapi/src/lib/
to-openapi.ts`, wired as a `mount` capability at `apigen-plugin-openapi/src/lib/
plugin.ts:72-105`), but it's non-functional through `run` today.

**Reproduced live:** built `apigen-plugin-openapi`, ran
`node dist/entrypoint/apigen-cli/index.js run --source
entrypoint/apigen-cli/src/test/fixtures/api.ts --type api-express --use
./dist/packages/apigen/apigen-plugin-openapi/index.mjs --opt port=3902` (2 real functions,
`getUser`/`sendEmail`), then `curl http://localhost:3902/_meta/openapi` →
`{"openapi":"3.1.0","info":{"title":"API","version":"0.0.0"},"paths":{}}` — the route
mounts and returns a well-formed document shell, but `paths` is empty; neither real
operation appears.

**Root cause:** `collectMountRoutes()` — identical in both HTTP transports
(`apigen-plugin-api-express/src/lib/run.ts:180`, `apigen-plugin-api-fastify/src/lib/
run.ts:186`) — constructs a synthetic descriptor with operations hardcoded empty before
calling the mount plugin:
```ts
const descriptor = { host, operations: [] as unknown[] };
const ops = cap.operations(descriptor, useOptions[plugin.id]);
```
The openapi plugin's handler correctly calls `toOpenApi(descriptor.operations, ...)`
(`apigen-plugin-openapi/src/lib/plugin.ts:99`) — but `descriptor.operations` is always
`[]` by construction, regardless of what the real package actually extracted. This
appears to be a generic helper originally sized for plugins like `health` that don't need
real operations at all, never extended for a mount plugin (openapi) that does.

**Compounding gap:** `PluginInput.packages[]` (`apigen-core-client/src/lib/types.ts:52-58`)
doesn't carry the raw `Operation[]` descriptor at all today — only `id`, the already-
composed `ComposedSchemas`, `importPath`, `fns`, `createClient`. The real descriptor is
consumed and discarded earlier in the pipeline (`composeSchemas()` call sites:
`apigen-engine-runtime/src/lib/api-package.ts:61`, `entrypoint/apigen-cli/src/lib/
pipeline.ts:42`, `entrypoint/apigen-cli/src/lib/orchestrator.ts:355`). So the fix isn't
just "stop passing `[]`" — the real `Operation[]` needs a path from extraction through to
`RunInput` (e.g. a new `packages[].descriptor` field threaded alongside `schemas`), or
`toOpenApi` needs an alternate entry point that can work from `ComposedSchemas` +
`pkg.id` instead of the raw descriptor.

**Also:** `generate.ts` (static codegen, both `apigen-plugin-api-express` and
`apigen-plugin-api-fastify`) never calls `collectMountRoutes` at all — `--use openapi`
only has any effect on `run` (live server), not `generate` (static output). Worth deciding
if that's intentional (mount plugins as a live-server-only concept) or a gap.

**Status:** OPEN. Scope: `apigen-core-client` (thread real descriptor into `PluginInput`),
`apigen-plugin-api-express`/`apigen-plugin-api-fastify` (`collectMountRoutes` in both
`run.ts`), possibly `apigen-plugin-openapi` (alternate `ComposedSchemas`-based entry point
if full descriptor-threading is deferred).

Citations: [session 2026-07-19, self-verified: live repro via built
`dist/entrypoint/apigen-cli/index.js` + built `apigen-plugin-openapi`, curl output above;
`apigen-plugin-openapi/src/lib/plugin.ts:72-105`;
`packages/apigen/codegen/openapi/src/lib/to-openapi.ts:1-20`;
`apigen-plugin-api-express/src/lib/run.ts:180`;
`apigen-plugin-api-fastify/src/lib/run.ts:186`;
`apigen-core-client/src/lib/types.ts:51-68`;
`apigen-engine-runtime/src/lib/api-package.ts:61`;
`entrypoint/apigen-cli/src/lib/pipeline.ts:42`;
`entrypoint/apigen-cli/src/lib/orchestrator.ts:355`]

---

### BUG-APIGEN-025 — `x-apigen-safe` is read by `httpVerb()` but never written anywhere in the real pipeline

**Discovered:** 2026-07-19, while investigating BUG-APIGEN-024 above.

**Observed:** both HTTP transports derive the default verb like this
(`apigen-plugin-api-express/src/lib/run.ts:26-34`, fastify identical):
```ts
function httpVerb(fnId, schema, config): 'GET' | 'POST' {
  const override = config.http?.verb?.[fnId];
  if (override === 'GET' || override === 'POST') return override;
  return (schema['x-apigen-safe'] as boolean | undefined) ? 'GET' : 'POST';
}
```
i.e. absent a manual override, the verb should fall back to whether the composed schema
carries `x-apigen-safe: true`. But `composeSchemas()` — the one function that builds every
schema this reads (`apigen-core-client/src/lib/compose-schemas.ts:59-119`, read in full) —
never sets an `x-apigen-safe` key anywhere in its output, on either the nested `data`
schema or the outer envelope schema. Repo-wide, `x-apigen-safe` is only ever *written* in
hand-constructed test fixtures (`apigen-plugin-api-express/src/test/plugin.spec.ts:63-76`,
fastify's spec mirrors it) that manually stamp `'x-apigen-safe': true` on a synthetic
schema object to unit-test `httpVerb()` in isolation — never by the real extraction →
compose pipeline. Confirmed via `grep -rln "x-apigen-safe"` across `packages/apigen` +
`entrypoint/apigen-cli`: only the two `run.ts` readers and the two `*.spec.ts` fixtures
reference it; zero writers outside test fixtures.

**Impact:** currently masked because every function export is `kind: 'action'`/`safe:
false` (see FEAT-APIGEN-022/023's analysis of `extract.ts`) — the only source of a real
`safe: true` operation today is `kind: 'query'` (a plain serializable `const` export, via
`buildQueryOp`, `extract.ts:526-549`), and it's unclear any such const is currently routed
through a live HTTP transport in a way that would surface this. But it's a real latent
correctness gap: the moment a `safe: true` operation IS exposed over `run --type
api-express`/`api-fastify` without an explicit `--opt http.verb.<id>=GET` override, it will
incorrectly default to `POST` instead of `GET`, because the signal `httpVerb()` needs was
never wired from `extract.ts`'s `op.safe` through `composeSchemas()`'s output. (Not a
factor for `apigen-plugin-openapi`'s `toOpenApi()` — that path reads `op.safe` directly off
the real `Operation` via `project()`, bypassing `ComposedSchemas`/`x-apigen-safe`
entirely, so the OpenAPI doc's verb derivation is correct even though the live server's
isn't.)

**Suggested fix:** `composeSchemas()` should accept (or `GeneratedSchemas` should already
carry) the operation's `safe` flag and stamp `'x-apigen-safe': op.safe` onto the outer
composed schema, so `httpVerb()`'s fallback actually reflects the real descriptor instead
of always reading `undefined` → always `POST`.

**Status:** OPEN. Scope: `apigen-core-client/src/lib/compose-schemas.ts` (write the field),
whatever upstream call site has `op.safe` available at compose time.

Citations: [session 2026-07-19, self-verified: `apigen-plugin-api-express/src/lib/
run.ts:26-34`; `apigen-core-client/src/lib/compose-schemas.ts:59-119` (full read, no
`x-apigen-safe` write); `apigen-plugin-api-express/src/test/plugin.spec.ts:63-76,172-192`;
`grep -rln "x-apigen-safe" packages/apigen entrypoint/apigen-cli` → only 2 `run.ts` readers
+ 2 `*.spec.ts` fixtures, zero real writers; `apigen-core-client/src/lib/extract.ts:526-549`
(`buildQueryOp`, the only `safe: true` source today)]

---

### BUG-APIGEN-026 — named-type params generate a dangling `$ref`/`definitions`, crashing every call at AJV compile time — HIGH, live-broken

**Reported:** 2026-07-19, live user report against `@adhd/sox-memory-core`-adjacent
consumer `scratch-agent-search` (agent-browser project): `POST
/agent-browser/search` with a valid body returned
`{"code":"internal","message":"can't resolve reference #/definitions/ProviderName from id #"}`.

**Root cause, fully traced and empirically confirmed:**

1. `search(provider: ProviderName, ...)` — `ProviderName` is a plain named type alias
   (`export type ProviderName = keyof typeof PROVIDERS`, `search-providers.ts:417` in the
   agent-browser project). apigen's extractor resolves this via **Path 1**
   (`apigen-core-client/src/lib/schema-builders/ts-json-schema.ts:963-984`) — any named
   type ts-json-schema-generator "can look up by name" goes through
   `runScalarAwareGenerator()` → `gen.createSchema('ProviderName')`.
2. **`ts-json-schema-generator`'s `Config` is built with no `topRef` override**
   (`ts-json-schema.ts:965-970`: `{ path, type, skipTypeCheck: true, tsconfig }`), so it
   uses the library's own default, confirmed by reading the installed package directly
   (`node_modules/ts-json-schema-generator/dist/src/Config.js`:
   `exports.DEFAULT_CONFIG = { ..., topRef: true, ... }`). With `topRef: true`, ANY named
   type — not just this one — comes back wrapped as `{ $ref: "#/definitions/<Name>",
   definitions: { <Name>: {...} } }` instead of inlined.
3. **Reproduced exactly** via `apigen generate --type jsonschema --source
   search-mcp-source.ts` against the real, unmodified file — the emitted
   `search.json`'s `input.properties.data.properties.provider` is verbatim:
   ```json
   {
     "$schema": "http://json-schema.org/draft-07/schema#",
     "$ref": "#/definitions/ProviderName",
     "definitions": { "ProviderName": { "type": ["string"] } },
     "default": "", "description": "(default: )"
   }
   ```
4. **Nothing dereferences or hoists this before it's embedded as a nested property.**
   `runScalarAwareGenerator`'s only post-processing is `filterZodDefinitions` +
   `validateSchemaRefs` (BUG-APIGEN-CORE-001) — both operate on `rawSchema` **in
   isolation**, where the `$ref` and its sibling `definitions` genuinely do resolve
   against each other, so they pass clean. `normalizeTopLevelUnion` only rewrites a
   top-level `anyOf`→`oneOf`; it's a no-op here (this shape is `$ref`, not `anyOf`). The
   result is returned as-is and `extract.ts` splices it straight into
   `properties[paramName]` (`extract.ts:479`) several levels deep inside the composed
   function schema (`compose-schemas.ts`'s `data` wrapper).
5. **JSON-Schema `$ref` resolution is root-relative, not fragment-relative** — a `$ref:
   "#/definitions/ProviderName"` nested at
   `input.properties.data.properties.provider.$ref` means "look up `definitions` at the
   root of whatever document AJV is compiling" (`input`), not at
   `...provider.definitions` where the sibling actually landed. `composeSchemas()`'s
   outer `input` object never has a top-level `definitions` key. `validate-layer.ts`
   compiles exactly `schema.input` per function (`ajv.compile(schema.input)`,
   `validate-layer.ts:132`) with no shared multi-schema registry — so the ref is
   permanently dangling in the compiled document, and this is a **compile-time** AJV
   error, not a data-validation error: it fails for **every** call to `search()`
   regardless of what `provider` value is sent, not just this one request.

**Blast radius:** any function parameter (or, less urgently since it's not
runtime-validated, any return type) whose TS type is a plain named alias/interface that
Path 1 resolves — not limited to `keyof typeof` unions. `search-mcp-source.ts` happens to
have exactly one such parameter today (`provider: ProviderName`); any other apigen
consumer with a named-type parameter is equally exposed. Scalar named types (`Date`,
`Decimal`, etc.) are unaffected — they're intercepted by `SCALAR_SCHEMAS` before ever
reaching Path 1 (`ts-json-schema.ts:930-931`).

**Suggested fix, verified empirically:** pass `topRef: false` in the `Config` at
`ts-json-schema.ts:965-970`. Confirmed via a standalone `createGenerator()` call against
the same real file/type: with `topRef: false`, the identical request returns
`{ "$schema": "...", "type": ["string"], "definitions": {} }` — no `$ref`, nothing
dangling. Two caveats to design around, not just apply blindly:
- This is the minimal fix for the *reported crash*, but embedding a schema fragment that
  assumes it owns the document root will always be structurally fragile wherever apigen
  splices raw generator output into a larger composed document. The robust fix is to
  fully dereference/inline `rawSchema` inside `buildSchema()` itself (or hoist &
  rewrite any surviving internal `$ref`s to the actual eventual root) so no fragment
  returned by this function ever depends on its position in the final document — matters
  most for genuinely self-referential/cyclic named types, where `topRef: false` alone may
  not be sufficient (ts-json-schema-generator may still need internal `$ref`s to model a
  cycle; those need root-relative rewriting, not just suppression).
- Secondary, lower-severity fidelity loss noticed in passing: even with `topRef: false`,
  `ProviderName` resolves to bare `type: ["string"]`, not `type: "string", enum: [...]`
  with the actual provider names — `skipTypeCheck: true` (already set,
  `ts-json-schema.ts:968`) apparently loses the literal-union enumeration for a `keyof
  typeof` expression. Separate from the crash; worth a follow-up but not blocking.

**Status:** OPEN, HIGH — this is a live, currently-broken endpoint for at least one real
consumer, not a latent/theoretical gap like BUG-APIGEN-025. Scope:
`apigen-core-client/src/lib/schema-builders/ts-json-schema.ts` (`runScalarAwareGenerator`'s
`Config`, `ts-json-schema.ts:965-970`, plus ideally a general dereference/hoist step
before `buildSchemaUncached` returns Path 1's result).

Citations: [session 2026-07-19, self-verified: live user repro (`POST
/agent-browser/search` → `"can't resolve reference #/definitions/ProviderName from id #"`);
`search-providers.ts:417` (`ProviderName` definition, agent-browser project);
`apigen-core-client/src/lib/schema-builders/ts-json-schema.ts:963-984` (Path 1 dispatch),
`:539-620` (`runScalarAwareGenerator`, zod-only post-processing), `:930-931` (SCALAR_SCHEMAS
short-circuit), `:522-537` (`normalizeTopLevelUnion`, no-op for this shape);
`node_modules/ts-json-schema-generator/dist/src/Config.js` (`DEFAULT_CONFIG.topRef: true`,
read directly from the installed package); `apigen-core-client/src/lib/extract.ts:479`
(where the raw fragment is spliced into `properties[name]`);
`apigen-engine-runtime/src/lib/validate-layer.ts:122-132` (`ajv.compile(schema.input)`,
no shared registry); reproduced via `node dist/entrypoint/apigen-cli/index.js generate
--type jsonschema --source search-mcp-source.ts` → `search.json` (exact structure quoted
above); `topRef:false` fix verified via a standalone `createGenerator()` call against the
same file/type]
