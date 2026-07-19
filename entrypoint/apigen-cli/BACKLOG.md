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
