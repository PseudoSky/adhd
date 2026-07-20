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

