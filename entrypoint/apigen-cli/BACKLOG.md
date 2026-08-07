### BUG-APIGEN-041 — `--use <path>` crashes for any plugin dist that transitively depends on `@adhd/apigen-core-client`; builtin slugs unaffected — NOT FIXABLE AT RUNTIME

**Status:** UNKNOWN

**Reported:** live user testing, post-merge: `--use dist/packages/apigen/apigen-plugin-openapi/index.js` crashes.

**Root cause:** The targeted dist is built with `@nx/vite:build` + `external: []`, which inlines the
entire transitive dep tree — including `@adhd/apigen-core-client` → `ts-morph` → `typescript` →
`perf_hooks`. TypeScript's module-level perf init (`performance.timeOrigin`) crashes inside
`@rollup/plugin-commonjs`'s broken CJS stub. The crash is in module evaluation, before any plugin code runs.

**Impact scope:**
- ✅ `--use openapi` / `--use health` / `--use logger` (builtin slugs) — works. Statically imported into the CLI's own bundle; no second copy of TypeScript runs.
- ❌ `--use <path>` pointing to any dist built with `@nx/vite:build` + `external: []` — crashes. This affects any apigen plugin dist that transitively reaches `@adhd/apigen-core-client`.
- ❌`--use ./local-plugin.ts` — also crashes today, because `loadUsePlugins` only loads JavaScript dist files (it does `import()` on the built CJS/ESM output). No `.ts`-source loading path exists yet.

**Why it can't be fixed in the dist build:** The transitive dep tree (`apigen-core-client` →
`ts-morph` → `typescript` → `perf_hooks`) is too complex for Rollup's CJS handling. Externalizing
`typescript`/`ts-morph` just reveals the next bundled dep with the same issue. Externalizing all
`@adhd/*` deps breaks because pnpm doesn't hoist them to root `node_modules`. This is a systemic
build-tool-selection issue, not a runtime bug — tracked at repo root as `INVESTIGATION-BUILD-TOOL-001`.

**Fix direction:** Two separate tracks:
1. **Systemic (INVESTIGATION-BUILD-TOOL-001):** Audit which `platform:node` packages should switch
   from `@nx/vite:build` to `@nx/js:tsc` (preserves `require()` chains, no Rollup stubs).
2. **Runtime (this bug):** Change `loadUsePlugins` to support loading `.ts` source files via tsx
   when `--use` points to a source path. This sidesteps the bundling issue entirely — tsx
   transpiles each file individually, Node resolves deps from `node_modules` normally, and
   TypeScript's module init succeeds (no Rollup stubs involved).

**Severity:** HIGH for `--use <path>`, but the feature is only needed for non-builtin plugins that
haven't been registered as builtin slugs. Builtin slugs cover all first-party plugins. Workaround:
register the plugin in `BUILTIN_USE_PLUGINS` in `run.ts` instead of using `--use <path>`.

**Suggested fix (optional, LOW):** add a fallback check in the `isLocal` detection that treats any spec containing a `/` (path separator) as a local path, regardless of file extension. This would catch bare directory paths like `--use dist/my-plugin` without needing a trailing `/index.js`. The `import()` would fail with a clearer error if the directory doesn't have a package.json or index.js.

**Updated status:** TRIAGED — not critical. Narrow remaining edge case: file paths without a recognizable extension fall through to bare-package resolution.

---

### BUG-APIGEN-042 — the generated OpenAPI doc's paths don't match the API plugins' actual served routes; architectural misalignment between `toOpenApi` and HTTP route registration — TRIAGED

**Status:** UNKNOWN

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

### BUG-APIGEN-031 — `generate --type cli` output silently mishandles array-typed params: crashes or returns a wrong value instead of the real result

**Status:** OPEN

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

**Citations:** [/Users/nix/dev/node/adhd/entrypoint/apigen-cli/BACKLOG.md]

### BUG-APIGEN-037 — `py-flask`/`py-grpc` are unconditional eager imports; unpublished on npm, so an installed CLI never reaches argument parsing — MEDIUM

**Status:** OPEN

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

### BUG-APIGEN-039 — (Open, filed not fixed, low-severity, follow-up to BUG-APIGEN-034) — `opMatchesExportMode()`'s "known residual limitation" now also covers anonymous default exports (Shape 4 anon sub-case + Shape 5), not just named default functions

**Status:** OPEN

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

### BUG-APIGEN-032 — `generate --type api-express`/`api-fastify` `-registry` output emits invalid TypeScript for any hyphenated package name (unsanitized identifier splice)

**Status:** OPEN

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
