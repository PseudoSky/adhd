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

### BUG-APIGEN-029 (Open, filed not fixed) — `$ref` resolution / ajv strict-mode failures on complex external types (e.g. `better-sqlite3.Database`) at DISPATCH time, not extraction time — pre-existing, confirmed identical under both v1 and v2

**Where:** the request-validation/dispatch layer consumed by `apigen-plugin-api-express`'s
generated `routes.ts` (`dispatch()` in `@adhd/apigen-engine-runtime`, and/or
whatever ajv instance validates the composed schema before invoking the
handler — not root-caused to a specific file/line in this session, since it's
out of scope for the v1-retirement task; filed for someone to pick up).

**Symptom, reproduced during this task's required real-world verification**
against `~/dev/ai/sox-ecosystem/libs/memory-core/src/index.ts` (read-only
reference): several routes 500 instead of dispatching successfully —
`/memory/write` → `{"code":"internal","message":"can't resolve reference
#/definitions/WriteParams from id #"}`; `/memory/memoryListProjects` /
`/memory/memoryCurate` / `/memory/memoryListTopics` (all take a `db:
BetterSqlite3.Database` param) → `{"code":"internal","message":"can't resolve
reference #/definitions/BetterSqlite3.Database from id #"}`.

**Confirmed NOT a regression from BUG-APIGEN-028/BUG-APIGEN-CORE-005 (this
session's v1-retirement work):** started a server on the OLD, unfixed v1 2-route
path (`main` before this session's changes, no flags — the exact pre-existing
default) and curled `/memory/write` directly — it 500s with the same class of
error (`"can't resolve reference #/definitions/WriteParams from id #"`). This
type of function was one of v1's original 2 visible routes, so this failure mode
predates and is unrelated to the extraction-path fix; it just went unnoticed
because v1 never exposed the `BetterSqlite3.Database`-taking routes at all (they
were invisible re-exports), so those specific instances of the bug were
literally unreachable before this session's fix made them reachable.

**Confirmed the wiring itself is sound:** simpler previously-invisible-under-v1
routes with fully-resolvable schemas dispatch correctly end-to-end —
`POST /memory/memoryAllowlistRoot` (0 params) → `200`, real string response;
`POST /memory/isPathInMemoryAllowlist` (1 string param) → `400` with a correct,
detailed ajv validation error when called with the wrong param name, then `200`
with the correct boolean result once corrected. Routing, dispatch, and
JSON-Schema request validation all demonstrably work for schemas the
`$ref`-resolution layer CAN resolve — this bug is specifically about schemas
referencing certain complex/external types it cannot.

**Impact:** low urgency for the CLI's core purpose (route generation/dispatch
wiring, this session's actual task) but real: any source exposing functions
that take third-party class instances (SQLite handles, etc.) as params —
common in re-export-barrel files pulling in "everything", exactly the kind of
file BUG-APIGEN-028 just made fully visible for the first time — will 500 on
those specific routes. Worth fixing, but no repro/root-cause investigation
performed this session (out of scope; not silently worked around, filed here
per this task's explicit instruction to file anything found broken along the
way that isn't being fixed).

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

### BUG-APIGEN-033 — anonymous default-export functions (`export default (n) => ...`) are advertised as routes/tools but crash at dispatch time ("function not found") — regression introduced by the v1-retirement (v2-orchestrator) rewrite

**Discovered:** 2026-07-19, by an independent code-review agent reading `orchestrator.ts`
alongside `extract.ts` and `fn-table.ts` for the `fix/apigen-v1-retirement` (BUG-APIGEN-028)
diff. Confirmed by this session directly reading the same three files.

**Root cause:** `extract.ts` (Shape 5, anonymous default export — a real fn expression/arrow
with no name, e.g. `export default (n: number) => n * 2;`) synthesizes a stable operation name
from the source filename: `` normalizeFileName(fileName).replace(/-/g, '_') + '_default' ``
(e.g. `foo_default`) — this becomes the route/tool/schema key. But
`apigen-engine-runtime/src/lib/fn-table.ts`'s `buildFnTable()`, which builds the `name → fn`
table dispatch actually indexes into, keys every function by its **JS-inferred `.name`
property**, not by any apigen-synthesized name. For `export default (n) => n*2`, ECMAScript's
NamedEvaluation rule (`export default AssignmentExpression`) gives the function itself a
real `.name` of `"default"` (this is the language's own runtime behavior, not a apigen bug) —
`buildFnTable` therefore ends up with `fns['default'] = fn`, never `fns['foo_default']`. At
dispatch time, `fns[operationName]` (`operationName = 'foo_default'`) is `undefined`, and the
call fails ("function not found" or equivalent), even though the operation is correctly listed
in the served schema/route/tool listing.

**Why this is a genuine NEW regression, not pre-existing:** before this branch, Step 5 called
v1's `generateSchemas()`, whose `extractDefault()` never covered a bare anonymous-function
default export at all (only the default-*object* form, `export default { a, b }`) — so this
shape was silently *absent* from `ComposedSchemas` entirely. It is now *present but broken* —
worse for a caller, since it looks like a real, callable operation until invoked.

**Impact:** any TypeScript source using this export shape (uncommon but valid, real-world
idiom — a single-purpose module exporting one anonymous function) gets a listed-but-dead
route/tool for every apigen output plugin (this is upstream of plugin choice — the bug is in
`extract.ts`/`fn-table.ts`, shared by all of them).

**Suggested fix:** either (a) have `extract.ts` name the operation using the SAME rule
`buildFnTable` will resolve at runtime (i.e. detect that the runtime key will be `"default"`
and use that, or a normalized form of it) instead of a filename-derived synthetic name that
`buildFnTable` has no way to produce, or (b) teach `buildFnTable` to ALSO key by the
apigen-synthesized name when unwrapping a `WRAPPER_KEYS`-nested anonymous function (it already
has the export's file/module context available at the unwrap site) so both sides agree. Needs
an end-to-end `run`-mode dispatch test (not just the existing `extract()`-only unit coverage in
`entrypoint/apigen-cli/src/test/integration/export-shape-matrix.spec.ts:103-114`) proving a
real invocation of this shape actually returns a result, not just that it's present in the
schema.

**Status:** OPEN, filed not fixed (out of scope for the blocking-findings fix pass this
session prioritized). Should be fixed before this branch merges, alongside BUG-APIGEN-028.

Citations: [session 2026-07-19, sub-agent `review-cli-orchestrator-diff`, self-verified against
source by this session: `packages/apigen/apigen-core-client/src/lib/extract.ts:300-336`
(Shape 5 anonymous-default-export naming); `packages/apigen/apigen-engine-runtime/src/lib/
fn-table.ts` (full read — `buildFnTable`'s `.name`-keying + `WRAPPER_KEYS` unwrap logic);
ECMAScript `export default AssignmentExpression` NamedEvaluation behavior (language spec, not
apigen code) confirmed as the source of `fn.name === "default"` for this shape]

### BUG-APIGEN-034 (Open, filed not fixed, design question) — `--export <mode>` no longer scopes the served/generated route surface post-v1-retirement — a real behavior change, needs an explicit decision

**Discovered:** 2026-07-19, by the same code-review pass as BUG-APIGEN-033.

**Observed:** `orchestrator.ts:59-71` documents `SourceEntry.exportMode` as inert, since v2's
`extract()` always walks the full export-shape matrix regardless of `--export`. That part was
already true pre-diff (under the old `--v2` flag, collision-checking already ignored
`exportMode`). **What's new in this branch:** pre-diff, Step 5 still called v1's
`generateSchemas({ exportMode })`, so the actual schema/route surface SERVED or GENERATED was
correctly scoped to the requested export shape, even though the earlier collision-check step
wasn't. Post-diff, Step 5 derives directly from the same unscoped `operations` array used for
collision-checking, so the FULL export matrix is now published as routes/schemas regardless of
`--export` — a real, observable behavior change for any caller relying on `--export` to exclude
private/internal named exports from the served surface.

**Concrete scenario:** a source file with private named-export helpers alongside an
intentionally `--export default`-scoped public object — those named helpers are now extracted,
collision-checked, AND served as routes, where before this branch they were correctly excluded
from what got served (even though the underlying `descriptor.operations` already included them
internally for collision-checking purposes).

**Process note:** `orchestrator.ts`'s own comment says "See BACKLOG.md for the follow-up
decision" — grepped this file for exportMode/scoping terms before writing this entry; found no
prior matching entry, so that comment's reference was dangling until now. This entry is that
follow-up.

**Needs a decision, not just a fix:** either (a) restore scoping by filtering `operations` by
`exportMode` before composing schemas in Step 5 (recovers old behavior, but v2's own docstring
suggests this scoping was already considered obsolete/soft-deprecated even before this branch),
or (b) explicitly declare `--export` fully retired/inert going forward and update its `--help`
text + deprecation-warn callers who pass it, rather than silently changing behavior underneath
an existing flag that still appears to do something.

**Status:** OPEN, filed not fixed. Should be resolved (either direction) before this branch
merges — a silent, undocumented behavior change on an existing public flag is not acceptable to
ship as-is.

Citations: [session 2026-07-19, sub-agent `review-cli-orchestrator-diff`:
`entrypoint/apigen-cli/src/lib/orchestrator.ts:59-71` (exportMode doc comment + dangling
BACKLOG reference); repo-wide grep of `entrypoint/apigen-cli/BACKLOG.md` for exportMode/
scoping terms prior to this entry, zero matches found]

### BUG-APIGEN-035 (Open, filed not fixed, latent/low-severity) — orchestrator's namespace-keyed `groups` map silently last-source-wins on a duplicate namespace, with no guard or documented caller obligation

**Discovered:** 2026-07-19, by the same code-review pass as BUG-APIGEN-033/034.

**Observed:** `orchestrator.ts:399-411`'s `buildDescriptor` groups operations by namespace into
a `Map`, using plain `Map.set()` — a second source resolving to the same namespace as an
earlier one silently overwrites it, no error, no warning. **Not currently reachable**: registry
namespaces come from `fs.readdirSync` directory names within a single `discoverPackages()` call
(`registry.ts:39`), which are inherently unique by construction, and `generate`/`run` only ever
pass exactly one source. But nothing in the `SourceEntry`/`OrchestratorOptions` type
definitions documents namespace-uniqueness as a caller obligation — this is a latent trap for
any future caller (e.g. the SPEC §13 polyglot-host `serve` extension mentioned in
`orchestrator.ts`'s own file header, if it or anything else is ever changed to accept an
externally-supplied multi-source list rather than one derived from a single directory scan).

**Suggested fix:** either throw a clear "duplicate namespace: X (sources: A, B)" error in
`buildDescriptor` when a collision is detected, or add an explicit doc comment on
`OrchestratorOptions`/`SourceEntry` declaring namespace-uniqueness a caller-enforced invariant
this function does not itself check.

**Related, separate nitpick (same review pass, not worth its own entry):**
`entrypoint/apigen-cli/src/lib/commands/run-registry.ts:106-114` registers SIGINT/SIGTERM
handlers BEFORE the `sources.length === 0` early-return, so on the "nothing to run" path
they're registered for a run that never starts (harmless — process exits normally right after
anyway). `generate-registry.ts`'s equivalent check is ordered before any such setup; purely a
cosmetic ordering inconsistency between the two files worth aligning if either is touched again.

**Status:** OPEN, filed not fixed, low priority — does not block merge (currently unreachable).

Citations: [session 2026-07-19, sub-agent `review-cli-orchestrator-diff`:
`entrypoint/apigen-cli/src/lib/orchestrator.ts:399-411` (groups Map, silent overwrite);
`entrypoint/apigen-cli/src/lib/registry.ts:39` (namespace uniqueness source, single
`readdirSync`); `entrypoint/apigen-cli/src/lib/commands/run-registry.ts:106-114` vs
`generate-registry.ts` (signal-handler ordering nitpick)]

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

