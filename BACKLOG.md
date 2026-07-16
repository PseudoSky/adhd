# BACKLOG

> 📦 Resolved/fixed items are archived in [docs/BACKLOG-RESOLVED.md](docs/BACKLOG-RESOLVED.md).

## Bugs

### BUG-DISPATCH-EXEC-001 — dispatch-orchestrator does NOT execute tool calls (headline capability is a stub)
**Discovered:** 2026-07-16, code-reality audit of the dispatch subsystem (import graph + build/test exit codes).
**Where:** `packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:662-671` — for a unit whose operations have no generative content, the loop emits "tool-call execution (@adhd/dispatch-tools) is not wired into dispatch-orchestrator's minimal loop; marking skipped" and proceeds. `@adhd/dispatch-tools` does not exist as a package.
**Impact:** the dispatcher orchestrates/optimizes/serializes and its CLI runs (builds EXIT=0, dispatch-cli 30 tests EXIT=0), but it does not actually EXECUTE tool calls — the core point of a dispatcher. "Shipped/173 tests" claims obscure that the center is hollow.
**Fix direction:** wire real tool-call execution (build the missing `dispatch-tools` or integrate an existing executor); prove it with a demo that drives the real CLI/orchestrator and asserts a tool actually ran. Tracked into `docs/plan/dispatch-completion`.
**Status:** OPEN.

### BUG-DISPATCH-PUBLISH-001 — dispatch packages are publish-broken: package.json names ≠ import specifiers (masked by duplicate tsconfig aliases)
**Discovered:** 2026-07-16, same audit.
**Where:** `tsconfig.base.json` had DUPLICATE aliases — `@adhd/dispatch-spec`→`dispatch-base-spec`, `@adhd/dispatch-client`→`dispatch-core-client`, `@adhd/dispatch-optimizer`→`dispatch-core-optimizer` — resolving imports the source actually used. But the real `package.json` names are `dispatch-base-spec`/`-core-client`/`-core-optimizer`. Builds in-repo via tsconfig paths; the published `@adhd/dispatch-orchestrator` would import `@adhd/dispatch-spec` etc., which are not real published packages. Same class as BUG-AGENTMCP-001.
**Fix direction:** pick ONE canonical name per package, align package.json name ↔ import specifiers ↔ tsconfig alias, drop the duplicate aliases, add an `npm pack --dry-run` + real-install verification gate. Tracked into `docs/plan/dispatch-completion`.
**Status:** FIXED 2026-07-15. Canonical name set = the real `package.json`/dir names (`dispatch-base-spec`, `dispatch-core-client`, `dispatch-core-optimizer`) — least churn, no dir/package renames needed.
- Rewrote all 63 import/comment sites across `packages/dispatch/**` (6 packages) and `entrypoint/dispatch-cli/**` (src, tests, bin, README) from the short aliases (`@adhd/dispatch-spec`/`-client`/`-optimizer`) to the canonical names. Re-grep after the change (`git grep -nE "@adhd/dispatch-(spec|client|optimizer)([^-a-z]|$)" -- packages entrypoint`) returns zero matches (exit 1).
- Deleted the 3 duplicate short aliases from `tsconfig.base.json`, keeping only the canonical `-base-spec`/`-core-client`/`-core-optimizer` entries.
- Fixed `dispatch-orchestrator/package.json`'s `devDependencies` entry `@adhd/dispatch-optimizer` (a name that was never real) → `@adhd/dispatch-core-optimizer`; every other dispatch package's `dependencies`/`devDependencies` already matched its real runtime/test-only `@adhd/dispatch-*` imports (verified by cross-checking each package's non-test-file import graph against its declared deps — no other package.json needed a change).
- **Publish-resolvability gate:** ran `npm pack --dry-run --json` against all 7 built `dist/{packages/dispatch/*,entrypoint/dispatch-cli}` package directories — all exit 0, zero stderr, and every declared dependency name in each packed `package.json` (`@adhd/dispatch-base-spec`, `@adhd/dispatch-core-client`, `@adhd/dispatch-core-optimizer`, `@adhd/dispatch-orchestrator`, `@adhd/dispatch-serializer-json`) resolves to a real, existing package — none reference the old short aliases anymore. This check should be added as a permanent CI gate (`npm pack --dry-run` per dispatch package, asserting the packed manifest's deps are a subset of real `@adhd/dispatch-*` package names) — tracked as follow-up `DEBT-DISPATCH-PUBLISH-GATE-001` below.
- **Verified green:** `npx nx run-many -t build test --projects=dispatch-base-spec,dispatch-base-types,dispatch-core-client,dispatch-core-optimizer,dispatch-orchestrator,dispatch-serializer-json,dispatch-cli` → EXIT 0, all tasks passed (30/30 dispatch-cli tests incl. the apigen-generated-CLI smoke suite).
- Did NOT touch `dispatch-orchestrator.ts`'s tool-execution logic (BUG-DISPATCH-EXEC-001, separate owner) — only import specifiers were changed there.
- `dispatch-base-types` remains a fully orphaned package (0 consumers) — already tracked for deletion under `docs/plan/dispatch-completion` (RECONCILIATION.md/USE_CASES.md/SCOPE.md `orphan-delete`); not duplicated here.

### DEBT-DISPATCH-PUBLISH-GATE-001 — no permanent CI gate enforces dispatch package-name/import/dep resolvability
**Discovered:** 2026-07-15, while closing out BUG-DISPATCH-PUBLISH-001.
**Where:** repo-wide — no script currently runs `npm pack --dry-run` (or equivalent) against the built dispatch packages as part of `test`/CI.
**Impact:** the exact class of bug just fixed (tsconfig aliases masking a real publish break) could silently regress if a future import reintroduces a short/aliased specifier, since in-repo `build`/`test` only exercise the tsconfig path-mapped resolution, never real npm dependency resolution.
**Fix direction:** add a `verify-publish` (or similar) target — per dispatch package (and ideally every publishable `@adhd/*` package), run `npm pack --dry-run --json` against `dist/<projectRoot>` and assert every `dependencies`/`peerDependencies` key is either a real npm registry package or a real `@adhd/*` package name found elsewhere in the workspace (cross-check against the full list of `package.json` `name` fields under `packages/**` and `entrypoint/**`). Wire it into `nx-release-publish`'s `dependsOn` (or a pre-publish check) so a broken publish can never ship again.
**Status:** OPEN.

### BUG-ENVPLAN-020 — `adhd-environment` `builder-snapshot-api` guard requires the raw `src` package path, which nx never populates → guard can never pass
**Discovered:** 2026-07-16, executing `adhd-environment` wave 3 (`builder-snapshot-api`) via plan-orchestrator → typescript-pro.
**Where:** `docs/plan/adhd-environment/dag.json`, `builder-snapshot-api.guard` — final step is `node -e 'const{build}=require("./packages/environment/environment-builder"); …'`.
**Symptom:** the implementation is fully correct (139/139 tests pass; the *identical* check against `./dist/packages/environment/environment-builder` returns exit 0, methods ok), but the guard's raw-`src` require throws `MODULE_NOT_FOUND`, so the guard exits 1 and the state cannot be completed. Verified state-side: state left `in_progress` (executor correctly refused to mark complete on a red guard).
**Root cause:** every `@adhd/*` package (40+) uses `"main":"./index.js"`, valid only once copied to `dist/packages/<path>/<name>/` (`nx build` populates dist, never the src package root; cf. `PUBLISHING.md`). Editing the src `package.json` `main` is a false fix — `dist/package.json` is a byte copy, so it would break the published package's own resolution.
**Fix direction:** change the guard's require target from `./packages/environment/environment-builder` → `./dist/packages/environment/environment-builder` (matches how every package in the repo is actually consumed). **Audit sibling states** for the same class: any `adhd-environment` guard that `require()`s a raw `src` package path (per ENV-PLAN-011, all three audit gates are `nx build`-based). Plan/guard defect — must be repaired by plan-builder (guards are not hand-editable per orchestrator rules); the executor's implementation is done and dist-verified.
**Status:** OPEN — blocks `builder-snapshot-api` completion and the downstream adhd-environment waves.

### DEBT-ENVBUILD-001 — `environment-builder/vite.config.ts` externalized no node builtins (latent build break); audit sibling `platform:node` packages
**Discovered:** 2026-07-16, same execution — surfaced once the real snapshot pipeline (which imports `node:fs`/`path`/`os`/`crypto`) was wired through `index.ts`.
**Where:** `packages/environment/environment-builder/vite.config.ts` — `rollupOptions.external` was `[]`, so Vite tried to browser-externalize `node:*`, breaking `nx build` with `"readFileSync" is not exported by "__vite-browser-external"`.
**Status:** FIXED in working tree by the executor (outside its 3 reserved files, disclosed) using the established `external: [/^node:/]` pattern from `packages/apigen/python-env/vite.config.ts`. **Follow-up (OPEN):** audit the other newly-scaffolded `platform:node` packages in this plan family (`environment-core-node`, `environment-cli`) for the same empty-`external` defect before their builder states run.

### BUG-AGENTMCP-001 — the built `dist` agent-mcp server cannot resolve its own `@adhd/*` workspace deps at runtime (`.mcp.json`'s dev entry is dead)
**Discovered:** 2026-07-11, while registering agent-mcp as a global (user-scope) Claude Code MCP server.
**Symptom:** running the dev entry from `.mcp.json` (`node dist/entrypoint/agent-mcp/src/index.js`, the `agent-mcp` server) exits immediately:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@adhd/agent-store-runtime'
  imported from <repo>/dist/entrypoint/agent-mcp/src/index.js
```
Reproduced with a real MCP stdio handshake (initialize + tools/list) — the process dies before emitting any JSON-RPC, so the host sees a server that never connects.
**Root cause:** `@adhd/*` specifiers are resolved **only by tsconfig `paths` at build time**. At runtime Node does ordinary `node_modules` resolution and finds nothing: root `package.json` declares **no `workspaces` field** (packageManager is `yarn@4.5.3`), so `node_modules/@adhd/` exists but is **empty** — no workspace links were ever created. `@nx/js:tsc` emits the bare `@adhd/…` imports verbatim into `dist/` and generates no package.json with resolvable deps, so every built entrypoint that imports a workspace package is affected — not just agent-mcp.
**Consequences:** the `agent-mcp` entry in `.mcp.json` has presumably never worked; only `agent-mcp-published` (`npx -y @adhd/agent-mcp@latest`, deps resolved from the npm registry) does. Any check that imports the source or runs through vite/vitest (both honor tsconfig paths) passes while the shipped artifact is broken — exactly the bypass CLAUDE.md §6 warns about.
**Fix direction (in order of preference):**
1. Add a `workspaces` field to root `package.json` so the package manager links `@adhd/*` into `node_modules/` (most standard; fixes every entrypoint at once).
2. Enable `generatePackageJson` on the `@nx/js:tsc` build targets so `dist/entrypoint/agent-mcp/package.json` carries resolvable deps.
3. A `dist/node_modules/@adhd/<name> -> ../../packages/<group>/<name>` link step in the build (contained, but a workaround).

**Do NOT** "fix" this by having a test import the built server's functions directly — that reaches inside the server instead of calling it like a host, and would keep the real defect green.
**Status:** OPEN.

### BUG-AGENTMCP-002 — stale `dist/` trees from a pre-move layout shadow current packages with duplicate `@adhd/*` names
**Discovered:** 2026-07-11, while mapping `@adhd/*` name → `dist/` output path to work around `BUG-AGENTMCP-001`.
**Symptom:** `dist/packages/ai/*`, `dist/packages/shared/*`, and `dist/packages/node-tools/*` are leftover build outputs from an older directory layout that no longer exists in source. They carry **duplicate package names** against the live `dist/packages/agent/*` outputs — e.g. `@adhd/agent-mcp` resolves to both `dist/entrypoint/agent-mcp` and `dist/packages/ai/agent-mcp`; `@adhd/agent-mcp-types` to both `dist/packages/ai/…` and `dist/packages/shared/…`; `@adhd/agent-mcp-budget` to both `dist/packages/ai/…` and `dist/packages/node-tools/…`.
**Impact:** benign today (nothing resolves by scanning `dist/`), but it makes any name-keyed dist resolution — including fix option (3) of `BUG-AGENTMCP-001` — ambiguous and non-deterministic, and makes `dist/` misleading to read. Any link map must be derived from the **source** tree (`packages/*/*/package.json` → `dist/<projectRoot>`), never by globbing `dist/`.
**Fix direction:** `npx nx reset` + a clean full build, then confirm the stale group dirs do not reappear (they should not — no source project maps to them). Deliberately **not** deleted at discovery time: removing directories is destructive and requires human approval per CLAUDE.md.
**Status:** OPEN.

### BUG-APIGEN-002 — generated MCP servers / CLIs can't resolve `@modelcontextprotocol/sdk` when run outside the repo tree
**Discovered:** 2026-06-23, while verifying BUG-APIGEN-001 via the dod.2 (`generate-parity`) and dod.cli (`cli-output`) probes.
**Symptom:** `probe_mcp.mjs generate-parity` / `cli-output` write the generated `server.ts` / `cli.ts` to an OS tmpdir, then run it with `npx tsx <file>` (cwd=REPO_ROOT). The generated file's bare import `@modelcontextprotocol/sdk/server/index.js` throws `Error: Cannot find module … code: 'MODULE_NOT_FOUND'`, so the MCP client sees `McpError -32000: Connection closed` and the probe exits non-zero.
**Root cause:** Node/tsx resolve bare specifiers from the *generated file's* directory upward. The tmpdir has no `node_modules` ancestry to the repo, and `@modelcontextprotocol/sdk` is a real npm package (not a `@adhd/*` tsconfig path alias), so it never resolves. The `generate` command (`packages/apigen/cli/src/lib/commands/generate.ts`) emits only the plugin's `.ts` files — no `node_modules` symlink, no `tsconfig.json`, no `package.json` — so generated output is not self-resolving anywhere except inside the repo tree.
**Proof it is independent of BUG-APIGEN-001:** restoring the pristine (pre-fix) `core`+`runtime` files and rebuilding reproduces the *identical* `Cannot find module '@modelcontextprotocol/sdk/server/index.js'` failure. The error is thrown at the generated file's import phase, before any dispatch/ctx code runs.
**Fix direction (NOT done — outside this task's core+runtime scope):** make `generate` emit resolution scaffolding into `--out-dir` — e.g. symlink the repo `node_modules` into the out-dir and emit a `tsconfig.json` that maps `@adhd/*` to the repo source — so generated servers/CLIs run anywhere. Lives in `packages/apigen/cli` (+ possibly the mcp/cli plugin templates), not in core/runtime.
**Status:** RESOLVED/VERIFIED 2026-06-23 (reconciled by pseudosky) — fixed in apigen-v2 via the **Option-A "publish" model**: `generate` emits a clean publishable `package.json` with real `^<version>` deps (`@modelcontextprotocol/sdk`, `@adhd/apigen-runtime`/-core) + `tsconfig.json`; the pre-publish workspace bridge is the default-off `--link-workspace` flag. dod.2 (`generate-parity`) and dod.cli (`cli-output`) pass inside the apigen-client-generation **final audit 117/117** (re-verified green this session). **Follow-on (open, tracked):** the per-surface 3rd-party **dep-manifest emission** for logical/rich types is owned by `docs/plan/apigen-logical-types` → state `lt-dep-manifest` / `[dod.gen-deps]`. (Earlier OPEN status was stale relative to the completed plan.)

### BUG-APIGEN-015 — api-fastify host returns logical SCALAR results as `text/plain`, not canonical JSON-string wire → cross-language drift with py-flask
**Discovered:** 2026-06-26, while building the logical-types human demo (driving the REAL hosts, not the codec layer — the conformance suite is green because it tests encode/decode functions, not each host's HTTP response serialization).
**Symptom (exact bytes, same function, same input `123.456` / `2024-01-15T12:00:00.000Z`):**
- TS `api-fastify`: `Content-Type: text/plain` · body `123.456` (bare) · Date body `2024-01-15T12:00:00.000Z` (bare — **not valid JSON**; `JSON.parse` throws).
- PY `py-flask`: `Content-Type: application/json` · body `"123.456"` · `"2024-01-15T12:00:00.000Z"` (canonical decimal/date → JSON string).
So a `Decimal`/`bigint`/`Date` **return** value comes off the two hosts in different shapes. This breaks the headline promise ("one wire, every language") on the RESPONSE path: a polyglot client can't consume both uniformly, and a client that `JSON.parse`s the TS response gets a precision-losing float for `bigint`/`Decimal` (`9007199254740993` → 9007199254740992) or a throw for `Date`. Container returns (Map→entry-array, Set→array) are JSON arrays on both, so no drift there — the gap is specifically **scalar logical returns**.
**Root cause (unverified):** the api-fastify host's reply path sends the encoded scalar (already a string like `"123.456"`) via a path that fastify serializes as a raw text body (`reply.send(string)` → text/plain) instead of JSON-encoding it. The canonical contract (DESIGN §3) is decimal/int64/date → JSON **string**; py-flask honors it, api-fastify does not.
**Why green tests missed it:** the cross-host conformance gate drives the shared codec functions (which agree); it never asserts the full HTTP response envelope of each host. The seam that breaks in real use (host → reply serialization) is exactly the one no test covered.
**Fix direction:** make the api-fastify (and audit api-express/mcp likewise) host JSON-encode the encoded result so a scalar logical return is sent as a JSON string with `application/json`, byte-identical to py-flask. Add a cross-host RESPONSE-envelope conformance assertion (drive both real servers, compare raw bytes) so this can't regress.
**Status: RESOLVED + orchestrator-VERIFIED (2026-06-26).** Added `sendJson(reply, result)` in `packages/apigen/plugins/api-fastify/src/lib/run.ts` — both the GET and POST handlers now `reply.type('application/json')` + `JSON.stringify(result)` (void → `null`), so every result is canonical JSON wire. **api-express was already correct** (`res.json()` always JSON-serializes); MCP is a separate protocol envelope (out of scope). **Verified by use:** rebuilt CLI, drove the real TS + Python hosts — `price 123.456` → `"123.456"` byte-identical on both (`22 31 32 33 2e 34 35 36 22`), `when` → `"2024-01-15T12:00:00.000Z"` on both, `echoBig` → `"9007199254740993"` (quoted, no precision loss), TS content-type now `application/json`. **Regression teeth:** `plugin.spec.ts [v2-fastify.run.verb.1]` tightened to assert `application/json` + body exactly `"pong"` + `JSON.parse` round-trip (reverting the fix → text/plain `pong` turns it red). api-fastify 37/37 + apigen-cli 107/107 EXIT=0.
**Cross-host guard added (2026-06-26):** `packages/apigen/cli/src/test/integration/cross-host-response-envelope.spec.ts` — drives BOTH real servers (api-fastify via built CLI + py-flask via `python3 -m apigen_python.flask_server`) and asserts byte-identical canonical JSON wire for a scalar Decimal return (the response-envelope seam the codec conformance suite missed). Default-running, no env gate. **Teeth PROVEN by orchestrator negative control:** reverting `sendJson` → both guard tests went RED (`expected 'text/plain; charset=utf-8' to contain 'application/json'`); restoring → 2/2 green. This closes the BUG-015 follow-up guard.

### DEBT-APIGEN-007 — `lt-dep-manifest` dep-collection is end-to-end blocked by missing `lt-extract-scalars`
**Discovered:** 2026-06-25, during `lt-dep-manifest` state execution.
**Symptom:** The dep-manifest machinery (`collectFormats` → `collectLogicalTypeDeps` → `patchPackageJsonDeps`) is implemented and works for schemas that carry `format: decimal`. However, when a TS source file uses `DecimalValue = string` (or any type alias that resolves to a primitive), `ts-morph`'s `p.getType().getText()` resolves the alias to `string` BEFORE passing the type text to `buildSchema` / `ts-json-schema-generator`. The `format` annotation on the alias is lost. The dep-collection step sees `{type: 'string'}` instead of `{type: 'string', format: 'decimal'}` and emits no dep.
**Root cause:** `packages/apigen/core/src/lib/extractors/named.ts` calls `p.getType().getText()` which eagerly resolves type aliases. Changing it to `p.getTypeNode()?.getText()` (the alias name) would preserve alias identity, allowing `ts-json-schema-generator` to look up the `@format` annotation.
**Fix direction:** in `lt-extract-scalars` (state in the `apigen-logical-types` plan): change `packages/apigen/apigen-core-client/src/lib/extractors/named.ts` to preserve the alias name (use `getTypeNode()?.getText()` for the type text), and add `DecimalString`/`DecimalValue` to `SCALAR_SCHEMAS` in `packages/apigen/apigen-core-client/src/lib/schema-builders/ts-json-schema.ts` (or rely on `ts-json-schema-generator` picking up the `@format` JSDoc from the exported type alias). Once extraction preserves format annotations, the `lt-dep-manifest` machinery activates end-to-end without further changes.
**Status:** OPEN — `lt-dep-manifest` infrastructure is green; activation gate is `lt-extract-scalars`. **tracked-by: `docs/plan/apigen-logical-types` → state `lt-extract-scalars`.**

## apigen-logical-types — lt-code-review findings (2026-06-25)

The following non-blocking issues were discovered during the `lt-code-review` gate review of the logical-types implementation. None blocks plan advancement.

### DEBT-LT-001..008 — ALL RESOLVED + orchestrator-VERIFIED (2026-06-26)
Dispatched to test-automator `ApigenHardening`, verified state-side (not from its report). Each fixed at its named file, root-cause, with tests where applicable: **001** date-time strict-mode now throws `TypeError` on `Number.isNaN(new Date(wire).getTime())` (`date-time.ts:36` + test); **002** int64 lossy `BigInt()` wrapped in try/catch (`int64.ts:35` + test); **003** unreachable `Number.isFinite` branch removed (`number-special.ts:49`); **004** non-canonical `bigint`/`bytes` aliases removed from `TS_TEMPLATE_TABLE`; **005** inline `TS_LOGICAL_TYPE_DEP_MAP` replaced with `import { tsDepMap }` (`generate.ts:18,91`); **006** `encodeSchemaless` ordering documented in `buildTranscoder` JSDoc; **007** `hints.spec.ts:159` now drives the REAL `assertNoEmptyCells` against an incomplete column; **008** `gate.ts` Python `sys.path` made CWD-independent. **Gates:** `nx test` (apigen-schema/logical/cli/conformance/core) EXIT=0 (186/25/131/109/201); `nx lint` EXIT=0 (0 errors); `python run_tests.py` 124/124.

### DEBT-LT-001 — `date-time` codec accepts invalid date strings without throwing in strict mode
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/codecs/date-time.ts:32-34`
**Symptom:** `codec.decode('not-a-date', schema, {mode:'strict'})` returns an `Invalid Date` object (`.getTime()===NaN`) instead of throwing. The contract (contracts.ts:37) requires "validate-then-construct"; only the wire type (string vs non-string) is validated, not the date format.
**Fix direction:** after the `typeof wire !== 'string'` guard, validate that `new Date(wire).getTime()` is not `NaN` (or use a regex / `Date.parse`) and throw `TypeError` in strict mode.

### DEBT-LT-002 — `int64` codec lossy-decode of a non-numeric string throws uncaught SyntaxError
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/codecs/int64.ts:28-34`
**Symptom:** In strict mode a non-string wire throws `TypeError` (correct). But in lossy mode with a string wire value like `'abc'`, `BigInt('abc')` throws `SyntaxError` — not caught by the lossy handler which only wraps the non-string path. No test covers this.
**Fix direction:** wrap `BigInt(wire)` in a try/catch in lossy mode or validate the wire is a decimal-string pattern before attempting BigInt conversion.

### DEBT-LT-003 — Dead code branch in `number-special` encode
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/codecs/number-special.ts:49-53`
**Symptom:** The guard `if (ctx.mode === 'strict' && !Number.isFinite(value))` is unreachable: the three preceding checks already exhaust all non-finite cases (NaN, Infinity, -Infinity). `Number.isFinite` is always true at that point.
**Fix direction:** remove the dead branch and its comment; the existing three guards are sufficient.

### DEBT-LT-004 — `TS_TEMPLATE_TABLE` in emit.ts exposes non-canonical aliases (`bigint`, `bytes`)
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/emit.ts:442-468`
**Symptom:** `TS_TEMPLATE_TABLE` includes `bigint` and `bytes` as aliases alongside the canonical ids `int64`/`byte`. These aliases do not correspond to any registered codec id. Any iteration over `TS_TEMPLATE_TABLE` keys would see 5 keys instead of 4, diverged from `CANONICAL_LOGICAL_TYPE_IDS`.
**Fix direction:** remove the `bigint` and `bytes` alias entries, or document them as legacy-compat aliases with a comment referencing the canonical ids.

### DEBT-LT-005 — `TS_LOGICAL_TYPE_DEP_MAP` in generate.ts is a live duplicate of `tsDepMap()`
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/cli/src/lib/commands/generate.ts:37-39`
**Symptom:** The inline `TS_LOGICAL_TYPE_DEP_MAP` constant duplicates `tsDepMap()` from `@adhd/apigen-logical/hints`. A future type addition to `TEMPLATE_CELLS.typescript` would be reflected by `tsDepMap()` but not the inline copy.
**Fix direction:** replace the inline constant with `import { tsDepMap } from '@adhd/apigen-logical'` and call `tsDepMap()` at usage sites. The JSDoc in generate.ts already identifies this as the fix.

### DEBT-LT-006 — `encodeSchemaless` first-match-wins codec ordering is implicit
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/runmode.ts:264-279`
**Symptom:** At schema-less positions, `encodeSchemaless` iterates `registry.ids()` in insertion order and returns the first codec whose `encode()` does not throw. A permissive codec registered before the canonical codecs could shadow them. The behavior is correct for the standard registration order (well-known codecs registered first) but fragile if custom codecs are registered without care.
**Fix direction:** document the registration-order sensitivity in `buildTranscoder`'s JSDoc and/or add a priority/weight field to `LogicalTypeCodec` for future disambiguation.

### DEBT-LT-007 — `assertNoEmptyCells` is never tested via an actually-incomplete column
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/logical/src/lib/hints.spec.ts:159-195`
**Symptom:** The test labelled "DOES throw when a language column is missing a cell" does not call `assertNoEmptyCells` on an incomplete table; it tests a custom inline `checkTable` reimplementation. The production function's throw path has zero direct test coverage.
**Fix direction:** add a test that monkey-patches (or temporarily adds a fake language key to) `TEMPLATE_CELLS` to simulate an incomplete column and asserts `assertNoEmptyCells('fakeLanguage')` throws with the missing id in the message.

### DEBT-LT-008 — Python gate inline script uses a relative `sys.path.insert` for the Python module
**Discovered:** 2026-06-25, lt-code-review.
**File:** `packages/apigen/conformance/src/lib/gate.ts:466-468`
**Symptom:** The inline Python script at line 466 hardcodes `sys.path.insert(0, 'packages/apigen/python')` as a relative path. If the gate is invoked from a CWD other than the workspace root, the Python import fails.
**Fix direction:** pass the absolute package directory as a second `sys.argv` argument, or resolve the path relative to the vectors file path already passed as `sys.argv[1]`.

## BUG-APIGEN-008 — Python extractor breaks on dataclasses under `from __future__ import annotations`
- **Discovered:** while mounting a real Python surface (`/tmp/myapi.py`) via `python3 -m apigen_python.gateway_adapter --module <path>`.
- **Symptom:** `AttributeError` in `dataclasses._is_type` (`sys.modules.get(cls.__module__).__dict__` → None) when the loaded module uses `@dataclass` + `from __future__ import annotations`.
- **Root cause:** `apigen_python/extractor.py:extract_module` calls `spec.loader.exec_module(mod)` WITHOUT first registering `sys.modules[spec.name] = mod`. With stringized (future) annotations, dataclasses resolves the class namespace via `sys.modules` and finds nothing. Combined with BUG-PY-FLASK-002: all annotation strings from PEP 563 needed `typing.get_type_hints()` resolution.
- **Fix (RESOLVED 2026-06-26):** `extract_module` sets `sys.modules[spec.name] = mod` before `exec_module` and cleans up on failure. `_resolve_hints()` calls `typing.get_type_hints(fn, include_extras=False)` to resolve stringized annotations. `_params_to_input_schema` and `_return_to_output_schema` pass `fn=` to use resolved hints. Tests: `future_ann.*` suite in run_tests.py §J (11 tests), all live-verified against a Flask server.
- **Status:** FIXED.

## BUG-APIGEN-009 — validate-Layer not active over `apigen run` (HTTP transports) — RESOLVED 2026-06-25
- **Discovered:** user-perspective demo, driving a live `apigen run --type api-fastify` server.
- **Symptom:** a malformed `date-time` (`2099-02-30`) and a missing required field both return **HTTP 200** (accepted); a wrong-typed field returns 500 from a downstream codec, not a 400. The function runs on invalid input.
- **Expected:** the central validation Layer rejects invalid input with `ApiError{code:'invalid_argument'}` (HTTP 400) BEFORE dispatch — as the in-process integration tests prove.
- **Root cause:** the `run` path called `dispatch()` directly per route, never composing the validate-Layer; validation was exercised only in the in-process harness/tests, not the served path.
- **Fix (landed):** the fastify/express `run.ts` now compose `makeValidateLayer(pkg.schemas)` (innermost) + any `--use` *Layer* plugins via the runtime `createInvoker`, and invoke through that stack per request. The CLI `run` command loads `--use` plugins (`loadUsePlugins`) and threads the live plugin objects through `options.usePlugins`. Verified with the real built CLI (`apigen run --type api-fastify|api-express --use health`) via curl: malformed date-time → 400 `invalid_argument`, missing required → 400, valid → 200; plus APIGEN_LIVE-gated behavioral tests that go RED when the wiring is removed (negative control confirmed).

## BUG-APIGEN-010 — `--use health` mount returns 404 over `apigen run` (HTTP transports) — RESOLVED 2026-06-25
- **Discovered:** same demo, `apigen run --type api-fastify --use health`.
- **Symptom:** `GET /meta/health`, `/_meta/health`, `/cli/meta/health` all 404. The health mount works natively over MCP but is not mounted by the HTTP `run` path.
- **Fix (landed):** the fastify/express `run.ts` now register `--use` *mount* plugins as real HTTP routes (`collectMountRoutes`): the health plugin's `_meta/health` op → `GET /_meta/health`. Verified with the real built CLI via curl → `200 {"status":"ok","host":"apigen-live"}`, plus an APIGEN_LIVE-gated behavioral test (RED under negative control).
- **Note:** the canonical mounted route is `GET /_meta/health` (the op `id`). The demo's `/meta/health` and `/cli/meta/health` variants remain 404 by design.

## BUG-APIGEN-011 — `readonly T[]` / `ReadonlyArray<T>` drops the element type in extraction
- **Discovered:** user-perspective demo (after tightening loose assertions — a vacuous green hid it).
- **Status:** FIXED (verified 2026-07-04). `packages/apigen/apigen-core-client/src/lib/schema-builders/map-set-tuple.ts:90` strips `readonly` prefix before resolution; `morph-walk.ts:30` documents readonly arrays flowing through correctly. Fix landed as part of the logical-types cross-language wire milestone. The original symptom (`ReadonlyArray<T>` → `items:{}`) no longer reproduces.

## DEBT-APIGEN-LINT-001 — `enforce-module-boundaries` crashes + flags static `@adhd/apigen-runtime` import in api-fastify/api-express run.ts — RESOLVED 2026-06-26
- **RESOLVED + orchestrator-VERIFIED (2026-06-26):** the "static import of lazy-loaded library" errors were fixed by converting the dynamic `import('@adhd/...')` in the offending spec files (api-fastify/api-express/mcp/logger/cli specs) to STATIC top-of-file imports, so the libs are no longer classified lazy-loaded — the legit `run.ts` static imports stay. The autofix ENOENT is gone (the 5 stub `index.ts` from LINT-002 now exist). **Verified:** `nx run-many -t lint` over all 21 apigen projects → **EXIT=0, 0 errors**; full apigen `nx run-many -t test` (19 projects) → **EXIT=0** (no behavior regression). Masking audit: zero severity downgrades, zero illegitimate `eslint-disable` (the only 4 added are on genuinely-lazy path-resolved `require()` in `ts-json-schema.ts`, with the disable directive corrected to the rule that actually fires).
- **Discovered:** 2026-06-25, while linting after the BUG-APIGEN-009/010 fix (pre-existing — reproduces identically on `git show HEAD:.../api-fastify/src/lib/run.ts`).
- **Symptom:** `nx lint apigen-plugin-api-fastify` (and api-express) errors: "Static imports of lazy-loaded libraries are forbidden — `apigen-runtime` is lazy-loaded in `stream.spec.ts`". The rule's autofix path additionally throws `ENOENT … packages/agent/agent-engine-compiler/src/index.ts` (a separate missing-file issue in the workspace graph), aborting the lint task.
- **Root cause:** `api-fastify/src/test/stream.spec.ts` (and similar) dynamically `import('@adhd/apigen-runtime')`, so the `@nx/enforce-module-boundaries` rule treats every *static* import of that lib in the same project as forbidden — but `run.ts` legitimately needs the static import (`dispatch`/`createInvoker`/`makeValidateLayer`/…). Not introduced by the BUG-009/010 change; the static import predates it.
- **Fix direction:** either make the lazy import in the spec a static import (so the lib is no longer classified lazy-loaded), or scope/disable the rule for these plugin projects; separately, repair the missing `packages/agent/agent-engine-compiler/src/index.ts` graph entry that makes the autofix throw ENOENT.

## BUG-APIGEN-012 — validate-Layer rejects `decimal` format with 500 (exposed by the 009 fix)
- **Discovered:** demo-gate re-run after wiring the validate-Layer into live `apigen run` (BUG-009 fix).
- **Symptom:** any `Decimal` param over a live HTTP server → `{"code":"internal","message":"unknown format \"decimal\" ignored in schema …"}` (500). `date-time`/`int64`/`byte`/`uuid` are fine (ajv-formats ships them); `decimal` is apigen's own logical format and was never registered with ajv.
- **Fix (RESOLVED):** `packages/apigen/runtime/src/lib/validate-layer.ts` — `ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/)` after `addFormats(ajv)`, so the canonical decimal-string wire validates.

## BUG-PY-FLASK-001 — `from __future__ import annotations` (PEP 563) prevents per-param JSON schema inference in Python extractor
- **Discovered:** 2026-06-25, while building the `py-flask` target and testing the `double_decimal(amount: str)` fixture.
- **Symptom:** when a Python module uses `from __future__ import annotations`, all type annotations are stored as strings (PEP 563 lazy evaluation). `inspect.signature()` returns `annotation='str'` (string) rather than `annotation=<class 'str'>` (type). `apigen_python.extractor._py_type_hint_to_schema` does not handle string annotations, so every param schema falls back to `{}` (empty / "any"). As a result, type-level validation (e.g. "amount must be a string") is silently skipped.
- **Root cause:** `_py_type_hint_to_schema` checks `annotation in _primitives` (a dict keyed by type objects), which never matches a string literal like `'str'`. No `get_type_hints()` call is made to resolve the deferred annotations.
- **Fix direction:** in `extractor.py`, use `typing.get_type_hints(fn, globalns={...}, localns={...})` instead of raw `inspect.signature().parameters[n].annotation` when the annotation is a `str`. This resolves PEP 563 string annotations back to type objects. A fallback import of module globals/locals is needed to handle forward-referenced custom types.
- **Workaround (current):** fixtures and user modules must not use `from __future__ import annotations`. Use `from typing import Dict, List, Optional` (3.8-compat) or `dict[str, Any]` (3.10+) instead. Document this in `pyproject.toml` and `flask_server.py` docstring.
- **Status:** FIXED (2026-06-26) — combined with BUG-APIGEN-008 fix. `typing.get_type_hints()` resolves stringized PEP 563 annotations to type objects before schema inference. Verified: `future_ann.live.decimal.roundtrip` passes with a real Flask server; `future_ann.extractor.decimal_schema` asserts `{type:string,format:decimal}` from a `from __future__ import annotations` module.

### DEFER-PYGRPC-001 — gRPC-Web support (sonora/grpclib) not included in py-grpc target
**Discovered:** 2026-06-25, while implementing the py-grpc apigen target.
**Detail:** gRPC-Web requires an HTTP/1.1-to-gRPC proxy or a pure-Python gRPC-Web server (e.g. `sonora`). `grpcio` alone serves native gRPC (HTTP/2); browser clients need gRPC-Web. The pure-Python option `sonora` exists (pip installable) but adds a non-trivial ASGI/WSGI dependency and was not verified in this env.
**When to address:** when browser-side gRPC-Web consumers are required. At that point: (a) verify `pip install sonora`; (b) add a `grpc_web` optional group to pyproject.toml; (c) wrap the server in a `sonora.asgi.grpcASGI` + uvicorn layer alongside the grpcio server, or use an Envoy sidecar.
**Status:** DEFERRED.

## BUG-APIGEN-013 — rich type nested in an inline object return loses `format` → `$apigen` envelope
- **Discovered:** gateway pass-through audit. `echoDate(d: Date): Promise<{ at: Date }>` over a live server returns `{"at":{"$apigen":"date-time","v":"…"}}` instead of `{"at":"…RFC3339…"}`. A top-level `Promise<Date>` correctly returns a plain string.
- **Root cause (unverified):** the extractor doesn't propagate `format` to fields of an inline/anonymous object type, so the nested `Date` field gets `{}` and the schema-less envelope path runs. Same family as BUG-APIGEN-011 (readonly arrays) — nested-type extraction dropping the logical format.
- **Impact:** correct round-trip (envelope preserves the value) but non-idiomatic wire; cross-host byte-equality for nested rich fields not guaranteed.
- **Fix:** propagate logical `format` into inline object-type field schemas in `ts-json-schema.ts`; add a nested-Date-in-object extraction + round-trip test.

## BUG-APIGEN-013 — RESOLVED
Logical types (Date/bigint/Decimal/bytes/uuid) now extract their `format` at ANY nesting depth and import form (built-ins via a ts-json-schema-generator custom parser augmentor; imported externals like `Decimal` via qualified-import + alias rewrite). Verified live: `Promise<{ at: Date }>` → `{"at":"…RFC3339…"}`, `{ cost: Decimal }` (default+alias import) → `{"cost":"123.456"}`, `Decimal[]` nested → plain strings — no `$apigen` envelope. apigen-core 191 tests green.

## Features

## FEAT-APIGEN-001 — Rust / Go / Java host languages — priority: HIGH
- **What:** apigen treats Rust/Go/Java as first-class at the *contract* level — declared in `PluginLanguage` (`packages/apigen/core/src/lib/types.ts`), routed by `source-language.ts` (`.rs`/`.go`/`.java`), wire mapped per-type in the DESIGN (§13.2), with a host-runbook generator (`packages/apigen/nx/src/generators/host`). But there is **zero implementation**: no extractor, runtime, server plugin, or filled codec columns. Only TS + Python hosts exist (proven byte-equal).
- **Deliverable per language:** fill that language's template-cell column (encode/decode/imports/dep/mode per logical type) + an extractor (source → operations) + a runtime (validate→dispatch→wire via the language's logical codecs) + an HTTP server target (analogous to `py-flask`) + go green on the cross-host conformance gate (`apigen-conformance:conformance`).
- **Order:** Java first (cheapest — DESIGN notes one dep, `jackson-datatype-jsr310`, rest stdlib Jackson), then Go, then Rust.
- **Acceptance:** `apigen serve --source a.ts --source b.py --source c.java` round-trips a Date/Decimal **byte-identically** across all three; conformance matrix green for each new host.

## FEAT-WORKSPACE-001 — workspace-standards base generator + custom workspace lint — priority: HIGH (foundational)
**Goal:** every nx project/target in the monorepo conforms to one enforced standard, generated by inheritance and verified by a custom workspace lint.

**Every project must:**
- Define the standard nx **targets**: `build`, `lint`, `test` — plus `demo`/`verify` (drives the live use-driven gate; ties to the live-testing rule in CLAUDE.md) and `nx-release-publish` (publishable libs) with `dependsOn:[build,test]`.
- Contain the standard **files**: `README.md`, `CLAUDE.md` (per-project agent invariants/footguns), `DEMO.md` (runnable; the `demo` target drives it), `CHANGELOG.md` (Keep-a-Changelog + conventional commits), and a `PLAYBOOK.md` (pre- and post-merge requirements).
- Carry standard `project.json` **conventions**: `tags` for `layer:*` + `platform:*` (architecture enforcement), correct `dependsOn` ordering, `publishConfig.access:public` for publishable libs.

**Base generator (enforcement by inheritance):** a `@adhd/workspace-base` generator package that ALL other nx generators compose/inherit, so the targets+files+conventions are generated automatically and can't be forgotten. **The base must support an `upgrade`/migration** that back-fills and updates every existing project when the base changes (`nx g @adhd/workspace-base:upgrade` → idempotent sync across all projects).

**Custom workspace lint (the gate):** a repo-level check (custom nx target / lint rule / CI gate) that FAILS if any project is missing a required target, a required file, or a required `project.json` field — so the standard is *enforced*, not merely generated.

**Additional standards (proposed):**
- A `verify` aggregate target = `lint` + `test` + `demo`, required to pass pre-merge.
- DEMO.md must be runnable end-to-end; the `demo` target is its CI entry (no env-gating of the demo — per the live-testing rule).
- README declares layer/platform + public API; CLAUDE.md declares the project's invariants/footguns for agents; PLAYBOOK declares pre/post-merge steps (build/lint/test/demo + changelog bump + version stamp).
- CHANGELOG enforced: a changeset/entry required for any `src` change (CI gate).
- tsconfig consistency (extends workspace base; `@adhd/*` path aliases), `.eslintrc` consistency, hyphenated package names, `I`-prefixed shared interfaces (per CLAUDE.md §7).
- CLI projects: `bin` + `#!/usr/bin/env node` shebang convention.
- Test policy: ≥1 **default-running** live/integration test per public feature (per the live-testing rule — gated tests don't satisfy this).

## BUG-APIGEN-014 — apigen-schema has no real test + live suites are env-gated (must run by default)
- **apigen-schema (RESOLVED + VERIFIED 2026-06-26):** `packages/apigen/schema/src/test/schema.spec.ts` exists and `nx test apigen-schema` → **25 passed, EXIT=0** (real default-running tests, not `passWithNoTests`). The "No test files found" status was stale.
- **Live-gating — PARTIALLY fixed (Python ✓ / TS serve ✗):**
- **Python side (FIXED + orchestrator-VERIFIED 2026-06-26):** all `APIGEN_PYFLASK_LIVE`/`APIGEN_PYGRPC_LIVE` `skipIf` guards removed from `run_tests.py`; **124/124 run unconditionally, EXIT=0** (driven by orchestrator). *Doc-debt:* three stale comments existed (`run_tests.py:904,1318,1788` said "gated behind APIGEN_PYFLASK_LIVE=1") — the gates were gone; the comments misled.
- **TS serve side (FIXED + orchestrator-VERIFIED 2026-06-26):** the `APIGEN_LIVE` gate was an explicit CLAUDE.md violation (a local server / built artifact is not a third-party paid service). **Removed** `describe.skipIf(!process.env['APIGEN_LIVE'])` → plain `describe` at `serve.spec.ts:143`; added `dependsOn:["build"]` to the apigen-cli `test` target so the bundle is always present; rewrote the suite header to document run-by-default + the hard-fail-on-missing-`python3` / graceful-skip-only-for-optional-`grpcurl` policy. **Verified:** default `npx nx test apigen-cli` → **EXIT=0, 107 passed (107), 0 skipped** (was 105 passed | 2 skipped). The real cross-language serve front now runs on every test invocation. CLAUDE.md "Live testing is mandatory" was also rewritten to be progressive/teachable (principle → default → the one paid-3rd-party exception → the rationalization trap → hard-prereq-fails-loud vs optional-binary-self-skips).
- **Doc-debt (RESOLVED 2026-07-04):** the 3 stale "gated behind…" comments in `run_tests.py` are no longer present in the current file. The doc-debt is closed.

## DEBT-APIGEN-LINT-002 — broader workspace lint debt (surfaced fixing LINT-001) — RESOLVED 2026-06-26
- **RESOLVED + orchestrator-VERIFIED (2026-06-26).** Full `nx run-many -t lint` over all 21 apigen projects → **EXIT=0, 0 errors**; `nx run-many -t test` (19 projects) → **EXIT=0**. Breakdown:
  - **Stub `src/index.ts`** for the 5 unscaffolded packages confirmed present (resolves the autofix ENOENT). *Still true:* replace stubs with real exports when the agent-* plans execute (stubs are comment-marked) — tracked, not blocking.
  - **`vite.config.ts` boundary violation — fixed repo-wide:** every affected apigen project's `.eslintrc.json` now carries the same `ignorePatterns: [..., "vite.config.{js,ts,mjs,mts}"]` template as api-fastify (14 configs). No rule weakened.
  - **Pre-existing `nx lint` errors fixed by real code changes** (not suppressed): missing `package.json` deps added with correct version specifiers (`@adhd/apigen-errors`/`-logical` across runtime/core/cli/cli-output/mcp); `no-nested-ternary`, `no-useless-escape`, `no-loss-of-precision` (→ `Number('…')`, value-preserving, test negative-controls only), `prefer-const`, `require-yield`, `no-extra-semi`, `no-empty-interface`, `no-inner-declarations` each refactored surgically; the only `eslint-disable` additions are 4 legit lazy `require()` sites in `ts-json-schema.ts`.
- **Residual (non-gating):** warnings remain across several projects (`0 errors, N warnings`) — pre-existing, not part of this debt; a separate optional warning-cleanup pass if desired. The 3 stale "gated behind…" comments in `run_tests.py` (BUG-014) were cleaned up (RESOLVED 2026-07-04).

## DEBT-WORKSPACE-ARTIFACTS-001 — centralize ephemeral artifacts; move agent-mcp DB default out of repo root
**Done now (2026-06-26):** robust `.gitignore` for runtime/test artifacts (`/data/`, `*.db`/`*.sqlite` + `-wal`/`-shm`, `calc-server.*`); CLAUDE.md "Workspace Context" now codifies **one canonical ephemeral root `tmp/<package>/`**, no ad-hoc artifact dirs, tests must self-clean, persistent stores live in `~/.adhd/…` not the tree. Scratch strays removed.
**Still open (coordinated agent-mcp spec change):** `entrypoint/agent-mcp/src/db/client.ts:11` defaults `DATABASE_PATH` to `./data/agents.db`, so a bare run / drizzle migration from repo cwd materializes a repo-root `data/`. Move the default to a home/central path (`~/.adhd/agent-mcp/agents.db`) so the repo root stays clean even without `DATABASE_PATH`. This is coordinated: also update `drizzle.config.js` (`dbCredentials.url`), `.env.example`, and the SPEC/PLAN-MEMORY docs that pin `./data/agents.db`. Belongs to the in-flight agent-mcp/agent-registry initiative. Also: the one tracked `packages/ai/agent-mcp-budget/data/agents.db` is a runtime DB accidentally committed — untrack it (`git rm --cached`) when touching that package.

## FEAT-WORKSPACE-001 — reframed: agent-optimized, core/adapter split (2026-06-26)
Full scope: `docs/workspace-base/SCOPE.md` (rewritten). **Reframe:** optimize the monorepo for *agents, not
human browsing* — a 5-layer decision-routing system (generated index → auto-loaded CLAUDE.md → impact graph →
soft memory → intent router); invariant = "generate the routing table, author the rulebook, keep memory soft,
promote invariants to machine-checkable gates" (memory `01KW2GHJE…`).

**Split into a platform-agnostic core + thin adapters** so the reusable parts aren't confined to nx/Node:
- `@adhd/workspace-standard` — **generalizable core** (pure TS, zero nx import; validates a Python/Rust/Go
  package equally): required-targets registry, required-files+section engine, managed-region engine,
  post-change rule engine, provenance validator, routing-index format + drift gate, boundary-policy *as data*,
  per-package metadata schema, configurable layout map.
- `@adhd/workspace-nx` — **nx adapter**: generators + root post-generate hook, `@adhd/eslint-plugin-workspace`
  (boundary enforcement), `nx affected` impact-graph binding, esbuild/tsconfig stamping, registry drift gate.

Resolved (Q1–Q8): inheritance = automatic-via-root-nx (fallback explicit `applyWorkspaceStandard`); upgrade =
managed-region markers + marker-tag confirmation; gate = eslint workspace rule; scope = all projects +
`exempt`; targets += `typecheck` (non-TS → mypy/pyright); file-content = existence-error + placeholder
warn(dev)/error(prod).

**Config homes (NOT package.json — decoupled from Node):** root taxonomy + layout + boundary policy →
**`.adhd/workspace.json`** (repo-defined; each repo defines its OWN taxonomy — adhd is project-focused, we take
sox's *mechanism* not its db/ml vocabulary; areas/groups carry `description`/`whenToUse`/`examples` so agents
place code from meaning, not guessing). Per-package metadata → **`<pkg>/.adhd/meta.json`** (ecosystem-neutral).
`generate-lib.sh` superseded. **The 5 reframe layers are implemented as generator + linter logic, not docs**
(SCOPE §0a): generator stamps meta + scaffolds CLAUDE.md hierarchy + ROUTER + regenerates routing index;
linter gates index drift, undeclared area/group, missing CLAUDE.md/markers, dangling router targets, boundary
policy, post-change rules, provenance.

**Harvested from sox `memory-refactor` NX-GENERATOR-HANDOFF (their needs align — same generator, more mature
layout):** name decoupled from folder path (integrity/registry key — hard rule); per-package metadata block
`{area,group,concerns,invariants,entrypoints}` as the routing source of truth; two-level `area/group`
taxonomy + depConstraint allow-matrix (`data↛platform`, `shared` is leaf); the `authoring`(core)↔`sox-nx`
(adapter) split (= our core/adapter cut); the 4-point acceptance suite. *adhd contributes back:* required-docs
set + post-change enforcement + provenance + managed markers (sox only stamps a CLAUDE.md stub). The generic
core is intended to be consumed by **both** repos (sox's `sox-nx` becomes a second adapter).

**Broken out as their own features (reusable beyond workspace scaffolding):**

## FEAT-CHANGE-ENFORCE-001 — post-change enforcement layer — priority: HIGH
Declarative "what must update when you change X" rule engine, git-diff-driven, **nx-free** (lives in
`@adhd/workspace-standard`): src→CHANGELOG `Unreleased`; public-API→README "Public API"+DEMO; new
feature→DEMO + ≥1 default-running live test; dep add/remove→manifest+CHANGELOG; breaking→major bump+note.
Warn (dev) / error (CI). Generalizes CLAUDE.md's disclose/never-bury/changelog rules into a checkable gate.
Depends on FEAT-PROVENANCE-001.

## FEAT-PROVENANCE-001 — change provenance schema + validator — priority: HIGH
Every change carries: work-item id (`plan:`|`backlog:`|`oneoff`) · dispatcher · author `name:version` ·
provider/model. **Carrier = BOTH:** git **commit trailers** (`Work-Item:`/`Author:`/`Model:`) are the
enforceable source written at commit time; the **CHANGELOG** trailer is the human-visible projection generated
from them. **Author identity resolved from the running agent's SP context** (same as `/reflection`:
`SOX_AGENT_NAME` → `--- AGENT: <name> ---` header → operating spec `name:`/`version:` frontmatter; humans → git
author). Schema + validator in `@adhd/workspace-standard`; ties to the `/reflection` provenance convention
(`agent_id`, `subject_version`, model).

## FEAT-ENV-001 — @adhd/environment — centralized configuration management — priority: HIGH

**Status:** Spec finalized (2026-07-06). See [`docs/plan/adhd-environment/SPEC.md`](docs/plan/adhd-environment/SPEC.md).

**What:** A multi-language environment SDK giving every ADHD project deterministic namespacing, typed
configuration, directory cataloging, dual content+structure hashing, change detection, and a
language-agnostic JSON snapshot. Generalizes patterns from sox-ecosystem (scope cascade, data-root
resolver, atomic writes, `${VAR}` interpolation).

**Packages (under `packages/environment/`):**
- `environment-base-spec` (`@adhd/environment-base-spec`) — contract: JSON Schema + SPEC.md
- `environment-core-node` (`@adhd/environment`) — TypeScript ref impl (zero external runtime deps)
- `environment-core-py` (`adhd-environment`) — Python interface stubs + contract test
- `environment-core-rs` (`adhd-environment`) — Rust interface stubs + contract test

**Key design decisions:**
- **Main class: `Environment`** (not AdhdEnvironment) — sub-components also unprefixed
- **Constructor-only directory registry** — no runtime `register()`; all dirs declared upfront
- **Hierarchical directory types** — `state.data`, `runtime.log`, `user.bin`, etc. (dot-path namespacing)
- **Dual hashing** — `configHash` (resolved values) + `structureHash` (directory layout), both in snapshot
- **Change detection on initialize()** — warns on new/removed dirs, throws on type changes or namespace conflicts
- **Env var aliasing + `${VAR}` interpolation** — overridable env sources, shell-var expansion in values
- **Atomic writes** — `.tmp` + `renameSync` for snapshot files
- **No dotenv dependency** — internal `.env` parser
- **Zod optional** — peer dependency only for `validate()`

**Migration targets (future):**
`entrypoint/agent-mcp`, `agent-engine-compiler`, `agent-store-prompts`, `agent-store-tools`,
`agent-core-policy`, `agent-core-provider` — all replacing ad-hoc `process.env` patterns with
`Environment`.

## DEBT-AGENTMCP-BUDGET-IMPORT-001 — `nx test agent-mcp` red: live-budget e2e can't resolve @adhd/agent-mcp-budget
`src/__tests__/integration/live-budget.e2e.test.ts` top-level-imports `@adhd/agent-mcp-budget`, which fails vite resolution ("Failed to resolve entry for package … incorrect main/module/exports"), failing the whole suite at COLLECTION time — before its `describe.skipIf(!AGENT_MCP_BUDGET_LIVE)` gate can skip it. So default `nx test agent-mcp` is RED (1 file failed / 211 passed). Pre-existing (orthogonal to the openai.ts apiKey fallback + secret redaction). Fix: correct `agent-mcp-budget` package.json `main`/`module`/`exports` (or build it) so the import resolves; consider a lazy/dynamic import so a live-gated suite never fails collection. Deferred agent-mcp/agent-registry initiative.

## DEBT-WORKSPACE-DEPCHECK-001 — workspace lint must verify each package.json declares every imported workspace dep
**Belongs in the workspace plan** — fold into **FEAT-WORKSPACE-001**'s "custom workspace lint (the gate)" / `@adhd/workspace-standard` (`docs/workspace-base/SCOPE.md`). No check currently fails a project whose source imports a workspace `@adhd/*` package it does **not** declare in its own `package.json`. This is a real, shipped failure mode: `@adhd/agent-mcp` imported `@adhd/agent-compiler`/`agent-policy`/`agent-mcp-budget` (+ provider/registry/tool-registry in tests) while declaring only `@adhd/agent-mcp-types`, so nx's `build.dependsOn:["^build"]` never built those deps; on a **clean** checkout their `.d.ts` were absent and `vite-plugin-dts` fell through the tsconfig `@adhd→src` paths into dependency **source** outside the consumer's `rootDir` → **`TS6059`**, silently breaking `nx build agent-mcp` for everyone but the dev worktree (which had built the dep dists incrementally). Fixed ad-hoc by declaring the deps (commit `08bbdda`) — but nothing prevents recurrence (agent-registry/agent-tool-registry declare nothing today; their cross-package imports are currently test-only — one import away from the same trap).
## FOLLOW-UP: nx mv workspace rename prerequisite (workspace-cleanup)

**Discovered:** 2026-07-01, during workspace-cleanup planning.

**Finding:** `nx g @nx/workspace:move` correctly renames packages, moves files, and rewrites all TypeScript imports across the workspace — **but only if `tsconfig.base.json` compilerOptions.paths values omit the `./` prefix**. Our tsconfig currently has `./` on all path entries (e.g. `"./packages/..."`), which breaks Nx's source-root matching algorithm in `update-imports.js`.

**Status:** RESOLVED (2026-07-04) — workspace-cleanup merged successfully into main. Despite the `./` prefix still present in `tsconfig.base.json` (it was never stripped), the renames succeeded via manual moves and find-and-replace rather than `nx g @nx/workspace:move`. The `./` prefix remains technical debt but is not blocking for current operations.

---

**Fix:** enable the **`@nx/dependency-checks` ESLint rule** (`@nx/eslint-plugin`) on every package's `package.json` lint — it diffs declared deps against actual imports and flags **both** missing and extraneous deps, and runs in CI. (Equivalent fallback: `eslint-plugin-import`'s `no-extraneous-dependencies`, but `@nx/dependency-checks` is workspace-aware.) This makes the standard *enforced*, not merely generated.

---

## dispatch-production — re-plan review findings (2026-07-01)

Found by the two-agent plan-vs-code review that restructured
`docs/plan/dispatch-production/dag.json`. Bugs 001–003 are scheduled for fix by the
plan's new `client-fixes` milestone; recorded here per disclosure policy until fixed.

### BUG-DISPATCH-003 — `dispatch-client` re-exports optimizer surface (layering leak)
- **Where:** `packages/dispatch/dispatch-client/src/index.ts`
- **Symptom:** re-exports `snapshot`/`optimize` from `@adhd/dispatch-optimizer`, letting consumers import optimizer surface through the client layer.
- **Status:** INVALID 2026-07-02 — not present in current source. `index.ts` exports only client/serializer symbols and has never re-exported optimizer surface on this branch (`git blame` → single commit `1e63f8d`); `package.json` doesn't depend on `dispatch-optimizer`; zero `@adhd/dispatch-client` consumers repo-wide. The finding was recorded during the plan-vs-code audit against an intended-architecture diagram, not the actual file.

### DEBT-DISPATCH-005 — BL-101..BL-107 identifiers exist only in the PoC LOG.md
- **Where:** `docs/plan/dispatch-optimizer/LOG.md` (outstanding table); referenced by both dispatch plans but absent from this BACKLOG.
- **Summary:** BL-101 fixed; BL-102 guard-only milestones lack `execution_mode` in DispatchUnit (MEDIUM); BL-103 `snapshot_version` never increments (LOW); BL-104 `compilePrompt()` doesn't inline nested interface sub-shapes (MEDIUM); BL-105 `mcp_servers: null` blocks real dispatch (HIGH — now *bypassed* by the `agent-runner` milestone's `mcpServers: {}` fallback for claudecli agents; catalog lookup still unbuilt, tracked by `backlog-fill`); BL-106 `b_per_tier` cold-start not seeded (LOW); BL-107 back-compat patches live in `run.ts` not `readDag()` (LOW).
- **Status:** OPEN — deferred `backlog-fill` milestone covers BL-102..107 residue.

### DEBT-WORKSPACE-NX-INPUTS-001 — tests reach outside their project root; nx cache/affected are blind to what they read

**Discovered:** 2026-07-02, sweeping for the DEBT-DISPATCH-007 class after it bit twice (plan.spec.ts above; `18bf547` fixed agent-mcp drizzle paths that went stale the same way). Two coupled defect classes:

**(a) Cache/affected blindness.** nx test inputs are `default` (`{projectRoot}/**/*`) + `^production` (graph dependencies only) + 3 externalDependencies; `sharedGlobals` is **empty**. Any runtime read outside those — repo-root files, `docs/`, sibling packages with no graph edge, another package's `dist/` — is invisible: stale cache hits locally, and `nx affected` skips the test in CI when the read file changes.

**(b) Boundary violations (policy).** Packages must not reach into sibling packages or the repo root via `(\.\./)+` escapes at all. Every cross-package need is either a workspace import (creates the graph edge `^production` hashes), a package-owned fixture, an `implicitDependencies` declaration + declared input, or an injected path.

**Audit (2026-07-02), 17 pattern hits, classified:**
- `entrypoint/agent-mcp/src/__tests__/plugin-loader.test.ts:565` — **WORST; effectively a live bug.** Loads `dist/packages/ai/agent-mcp-budget/index.js` — the *pre-rename orphan build of a deleted package* (real package is now `packages/agent/agent-plugin-budget`). The "real budget plugin integration" test is pinned green against a ghost artifact; changes to the real plugin never reach it. Fix: repoint to `dist/packages/agent/agent-plugin-budget`, add `implicitDependencies: ["agent-plugin-budget"]` so `^build`/`^production` order and hash it.
- `packages/ai/agent-mcp/src/__tests__/{index-wiring,live-wiring}.test.ts` — resolve 4 sibling `drizzle/` dirs (`agent-core-provider`, `agent-store-prompts`, `agent-store-tools`, `agent-core-policy`); agent-mcp imports none of them → no graph edge → migration changes don't invalidate. Already went stale once (`18bf547`).
- `packages/agent/agent-engine-compiler/src/__tests__/compile-e2e.test.ts` (+ siblings) — same drizzle-dir pattern (3-up stays within `packages/agent/`, still cross-project); `compile-cli.test.ts` resolves `REPO_ROOT` 5-up.
- `packages/apigen/cli/src/test/e2e/real-consumer.spec.ts` — `REPO_ROOT` 6-up; reads `packages/transform/src/lib/text.ts` + own `dist/` bin. `serve.spec.ts` — own `dist/` 5-up (own dist also needs `dependsOn: ["build"]` on the test target to be fresh).
- **Benign (7 files):** `apigen/nx` + `agent-generator-plugin` generator specs — `tsconfig.base.json`/`../../../.eslintrc` strings are nx-devkit *virtual tree* writes, no real fs.
- **Related rot:** `dist/packages/ai/` still contains 7 orphaned pre-rename outputs (`agent-compiler`, `agent-mcp-budget`, `agent-mcp-types`, `agent-policy`, `agent-provider`, `agent-registry`, `agent-tool-registry`) — ghost artifacts that let stale-path consumers keep passing. Delete them (each individually, no chained removals).

**Remediation (sweep):** per offender: create the real graph edge (`implicitDependencies`) or move the fixture in-package; declare any legitimately-external file as an explicit `{workspaceRoot}/...` input; repoint stale dist paths; add `dependsOn: ["build"]` where a test executes its own dist; delete orphaned dist dirs; then an enforcement check (CI grep forbidding `(\.\./){3,}` path resolution under `packages/**/src`). Populate `sharedGlobals` with root configs that genuinely affect all targets (`tsconfig.base.json`, `.eslintrc.base.json`).
- **Status:** OPEN — dispatch-spec instance fixed (reference pattern above); sweep queued after dispatch wave 2 lands to keep verification attribution clean.

## DEBT-WORKSPACE-VITE-PATHS-001 — Vite configs hardcode relative paths to dist/, coverage/, cacheDir/ instead of resolving from project config

**Discovered:** 2026-07-01, during workspace-cleanup renames.

**Where:** Every `vite.config.ts` in the repo. Example from `packages/dispatch/dispatch-spec/vite.config.ts`:
```ts
cacheDir: '../../../node_modules/.vite/packages/dispatch/dispatch-spec',
outDir: '../../../dist/packages/dispatch/dispatch-spec',
coverage: { reportsDirectory: '../../../coverage/packages/dispatch/dispatch-spec' }
```

**Problem:** These paths encode the package's position in the directory tree relative to the workspace root. When a package is renamed or moved (e.g., `packages/shared/dispatch-spec` → `packages/dispatch/dispatch-spec`), every path in `vite.config.ts` breaks and must be updated manually — `nx mv` doesn't touch them because they're string literals, not import paths. This is the root cause behind the `Can't find meta/_journal.json` and stale-dist-path bugs encountered during workspace-cleanup.

**Fix direction:** Inject workspace-root and package-root paths dynamically so they survive renames:
- Use a shared vite plugin or helper that reads `process.cwd()` or `__dirname` and resolves relative to the workspace root at build time
- Example: `import { workspaceRoot, projectRoot } from '@adhd/workspace-vite'` → resolves to correct paths regardless of package location
- Alternatively: read from `project.json` / `nx.json` via `@nx/devkit` during the vite config build phase
- The helper should provide: `projectDist()`, `projectCoverage()`, `projectCacheDir()`, `workspaceNodeModules()` at minimum

**Status:** OPEN — deferred workspace-enablement milestone.

## DEBT-WORKSPACE-TYPECHECK-001 — No `typecheck` target exists in the workspace, but dispatch-production dag.json guards invoke it

**Discovered:** 2026-07-02, during dispatch-production execution verification.

**Where:** docs/plan/dispatch-production/dag.json (multiple milestone guards); entire workspace (no typecheck target defined anywhere).

**Problem:** Multiple milestone guard strings in docs/plan/dispatch-production/dag.json (at minimum client-core, optimizer-core, orchestrator-core) include `npx nx typecheck <project>`, but no project and no plugin defines a typecheck target anywhere — nx reports "Cannot find configuration for task <project>:typecheck" — the guards are unrunnable as literally written and will fail the moment an orchestrator executes them mechanically. Verification to date substituted `npx tsc -p <project>/tsconfig.lib.json --noEmit` (clean).

**Fix direction:** Add a cached per-project typecheck target (tsc --noEmit against tsconfig.lib.json) to the dispatch packages — or a workspace-level inferred target — rather than editing guard strings; then prove each dag guard runs end-to-end.

**Status:** FIXED (2026-07-02) — cached typecheck targets added to the five dispatch packages; guard strings run as written.

### DEBT-DISPATCH-006 — agent-mcp exposes no per-turn token usage on the MCP surface
- **Where:** `entrypoint/agent-mcp/src/validation/usage.ts:84-108` — public shape is aggregate `TaskUsageReport.direct`; per-turn `MODEL_RESPONSE` events exist in the internal `task_events` table (`entrypoint/agent-mcp/src/db/schema.ts:101-121`) but no tool exposes them.
- **Impact:** dispatch `dispatch_log[].turns[]` is synthesized as a single aggregate entry; per-turn calibration (PoC SCOPE §C4) is not possible until agent-mcp grows a per-turn query. Not e2e-blocking.
- **Status:** OPEN — candidate FEAT for agent-mcp (expose per-turn events via `usage_query`).

### DEBT-DISPATCH-009 — dispatch-spec `SentinelRole` lacks `'solo'` (tests-real-e2e drift)
- **Where:** dispatch-spec, tests-real-e2e.md
- **Description:** tests-real-e2e.md scenario 3 asserts unit.sentinel_role === 'solo', but the shipped type is 'prewarm' | 'payload' only — a hard TS compile error when building DispatchUnit fixtures. Either extend the union or amend the scenario doc before the tests-real-e2e milestone executes.
- **Status:** OPEN — found 2026-07-02 by the agent-runner builder.

### DEBT-DISPATCH-010 — dispatch-spec `SnapshotOptimization` lacks `tokens_naive`
- **Where:** dispatch-spec, optimizer-core.2
- **Description:** optimizer-core.2 says to emit tokens_naive into the snapshot's optimization block, but SnapshotOptimization has no such field; dispatch-optimizer exports computeTokensNaive(snapshot, deps) instead (SCOPE.md §F4 formula, raw b_per_tier, Sentinel-Fanout scaling excluded, covered by a dedicated test). Add tokens_naive: number | null to dispatch-spec and wire optimize() to persist it.
- **Status:** OPEN — found 2026-07-02 by the optimizer-core builder.

### DEBT-DISPATCH-011 — dispatch-optimizer orphaned stub scaffolding from 1e63f8d
- **Where:** packages/dispatch/dispatch-core-optimizer/src/lib/optimize/{bitmask-dp,hlfet,sentinel,simulated-annealing,tree-dp}.ts and packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/{clone,eligibility,overlap,size-estimate,topology}.ts
- **Description:** dead `return [] as X` stubs from commit 1e63f8d ("save before large refactor"), referenced by no dag.json operation (optimizer-algorithms.1 targets src/lib/algorithms/bitmask.ts, a different path). Wire them up or delete them during the optimizer-algorithms milestone.
- **Status:** OPEN — found 2026-07-02 by the optimizer-core builder.
- **Amended 2026-07-02 (verifier finding):** the same commit 1e63f8d also left packages/dispatch/dispatch-core-optimizer/src/lib/compiler.ts — a 2087-line near-duplicate of the PoC reference docs/plan/dispatch-optimizer/src/compiler.ts (differs only in import order/quote style), unreachable from the build (index.ts imports the flat snapshot.js/optimize.js, and nx build reports only 6 modules transformed). It imports node:fs, which would violate the package's platform constraints if ever wired in, and the build's 10 eslint warnings all live in these orphaned files. Delete compiler.ts alongside the stub dirs.

### DEBT-DISPATCH-012 — DispatchUnit has no systemPrompt/prompt split — double token cost per dispatch
- **Where:** DispatchUnit, AgentMcpRunner
- **Description:** DispatchUnit carries only `prompt`, so AgentMcpRunner.ensureAgent bakes the full compiled prompt into the agent's static systemPrompt at agent_create AND the same text is resent as the per-task user-turn prompt on every fire(). Needs a compiled-prompt preamble/body split — an orchestrator-core / prompt-compiler design decision, not a runner fix.
- **Status:** OPEN — found 2026-07-02 by the agent-runner builder.

### DEBT-DISPATCH-013 — D-07 `eligible` semantics permit re-dispatch of complete milestones (spec-level BUG-DISPATCH-008)
- **Where:** SCOPE.md D-07, dispatch-spec, dispatch-client, dispatch-optimizer
- **Description:** SCOPE.md D-07 defines a snapshot milestone's `eligible` purely from its own `pending` field and upstream dependency statuses — never its own completion — so a complete milestone reads eligible: true forever. Same root cause as BUG-DISPATCH-008 (fixed client-side in 5e967a0). optimize() independently guards its candidate selection with status === 'pending' (documented in selectPackableMilestones). Promote own-completion into the spec'd eligible definition so every consumer inherits the guard instead of each reimplementing it.
- **Status:** OPEN — found 2026-07-02 by the agent-runner builder.
- 2026-07-02 real-e2e finding: the same D-07 semantics also mean MilestoneSnapshot.eligible NEVER flips to false after completion — a sharp edge for any consumer treating `eligible` as a 'still needs work' signal; the correct signals are optimize()'s candidate list or the derived status. Worth a callout in dispatch-spec's type docs when the spec-level fix lands.

### DEBT-DISPATCH-014 — Latent Infinity in per-tier B/context-window resolution breaks JSON round-trip
- **Where:** packages/dispatch/dispatch-core-optimizer/src/lib/snapshot.ts:166, packages/dispatch/dispatch-core-optimizer/src/lib/optimize.ts:247
- **Description:** resolveContextWindowPerTier and resolveContextWindow default to Number.POSITIVE_INFINITY when a model tier is absent from both the dag and deps. JSON.stringify(Infinity) serializes to null, so persisting such a snapshot would silently turn a number field into null, violating SnapshotOptimization.context_window_per_tier: Record<string, number>. Inert today: IOptimizerDeps.bPerTier/contextWindowPerTier are required and every real caller supplies all three ModelTier entries. Fix direction: reject absent tiers at snapshot() entry (validation error) or clamp to a documented finite sentinel, plus a JSON round-trip test.
- **Status:** OPEN — found 2026-07-02 by the optimizer-core verifier.

### DEBT-DISPATCH-015 — orchestrateCycle has no error boundary around runner/persist calls
- **Where:** packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:457, 628, 629, 871
- **Description:** runner.ensureAgent, runner.fire, runner.poll inside pollUntilTerminal, and client.saveDag are awaited with no try/catch, so a transport or disk failure mid-unit propagates uncaught out of orchestrateCycle and the failed unit leaves zero forensic trace in dispatch_log (prior units in the cycle are already persisted, so nothing is lost — but nothing is recorded either). Inconsistent with defaultGuardExec's deliberate never-rejects seam in the same file. Fix direction: per-unit try/catch that records a 'failed' result entry with an error note, plus an explicit continue-vs-abort policy knob.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core verifier.

### DEBT-DISPATCH-016 — Operation-level type:'automated'/action:'guard' is never routed by the orchestrator
- **Where:** packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:651-664
- **Description:** orchestrator.ts never reads op.guard, op.type, or op.action (grep-confirmed zero matches). The plan's sole instance (hardening-complete.1, dag.json:3269-3291) is masked because its milestone duplicates the identical guard string at milestone level (dag.json:415-431), which the orchestrator does execute. A future automated/guard operation without that duplication would be marked 'skipped' — via the tool-call-only branch, whose note text also mislabels such ops — and its verification command would silently never run. Fix direction: route op-level guards through the same GuardExecFn seam and correct the branch labeling.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core verifier.

### DEBT-DISPATCH-017 — capOutput can split a multi-byte UTF-8 character at the 8KB guard-output cap
- **Where:** packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:256-260
- **Description:** truncates by byte offset (buf.subarray(0, CAP)); a cut mid-character yields a replacement glyph at the boundary. Cosmetic only — no crash.
- **Fix:** cut on a character boundary.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core verifier.

### DEBT-DISPATCH-018 — Formalize ICalibrationStore in dispatch-spec
- **Where:** packages/dispatch/dispatch-base-spec, packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:124-137
- **Description:** no ICalibrationStore export exists in @adhd/dispatch-spec (verified absent); dispatch-orchestrator ships a deliberate minimal ICalibrationPlaceholder per the orchestrator-core brief. The calibration milestone should define the real interface in dispatch-spec and replace the placeholder. Cold-start defaults (DEFAULT_B_PER_TIER etc.) are what feed the optimizer today.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core verifier.

### DEBT-DISPATCH-019 — DispatchLogEntry.provider enum predates real providers and is not enforced by validation
- **Where:** packages/dispatch/dispatch-base-spec, packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:783-790, packages/dispatch/dispatch-base-spec/src/lib/validate.ts
- **Description:** the type-level enum ('anthropic'|'openai'|'deepseek'|'google'|'local') lacks agent-mcp's 'claudecli' (AgentMcpRunner records closest-fit 'anthropic', documented as a schema gap not paper-over) — and validate.ts does not enforce the enum at all (a 'teammate' value in the live dag.json passes 25/25 spec tests). Fix direction: extend the union with the real provider values ('claudecli', 'teammate', …) and decide whether validation should enforce it.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core verifier.

### DEBT-DISPATCH-020 — Replan injection is generic, not causally aware, and does not rewire downstream depends_on
- **Where:** packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts:489-568
- **Description:** injectCorrectionMilestone re-fires the same agent/model/effort/guard with a natural-language fix instruction; it cannot target a truly at-fault upstream milestone (WORKFLOW.md's richer example needs plan-authoring judgment), and downstream milestones depending on the failed slug do not automatically pick up the correction. Guard-only milestones deliberately get a note instead of a correction (D-12 rationale, behaviorally tested). Fix direction: causally-aware replan as a dedicated milestone/plugin.
- **Status:** OPEN — found 2026-07-02 by the orchestrator-core builder.
- 2026-07-02: now consumer-visible in dispatch-cli's real-e2e scenario 7 — after a correction milestone completes, the original permanently reads 'failed', downstream depends_on never rewires onto the correction, and a subsequent resume cycle terminates with 'no-eligible-work'.

### DEBT-DISPATCH-021 — dispatch-cli package.json omits @modelcontextprotocol/sdk (runtime require on the non-dry-run path)
- **Where:** entrypoint/dispatch-cli, dist bundle
- **Description:** the built dist bundle (src/index.ts → lib/core.ts → @adhd/dispatch-orchestrator's AgentMcpRunner) externalizes and requires @modelcontextprotocol/sdk at runtime, but package.json declares only workspace @adhd/* deps per the milestone brief — a fresh npm consumer of @adhd/dispatch-cli breaks the first time they exercise the dryRun:false path.
- **Fix direction:** add it as a direct dependency or document it as a peerDependency.
- **Status:** OPEN — found 2026-07-02 by the cli-milestone builder.

### DEBT-DISPATCH-022 — dispatch-cli has no bin field; bin/cli.ts is not compiled by the vite build
- **Where:** entrypoint/dispatch-cli, entrypoint/dispatch-cli/package.json, entrypoint/dispatch-cli/bin/cli.ts, @nx/vite:build
- **Description:** entrypoint/dispatch-cli/bin/cli.ts (the hand-written Commander CLI, fully tested via spawn) runs only via `npx tsx --tsconfig tsconfig.base.json bin/cli.ts`; package.json has no bin entry and @nx/vite:build does not compile bin/ to JS (decompile's @nx/js:tsc precedent does). Making the package npx-invocable needs a build step for bin/ plus a bin field. Deferred as a real scope decision, not silently dropped.
- **Status:** OPEN — found 2026-07-02 by the cli-milestone builder.

### DEBT-DISPATCH-023 — calibrateCore duplicates dispatch-orchestrator's non-exported poll internals
- **Where:** entrypoint/dispatch-cli/src/lib/core.ts, packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts
- **Description:** dispatch-cli lib/core.ts re-declares a CALIBRATION_TERMINAL status set and a pollNullTask loop duplicating @adhd/dispatch-orchestrator's non-exported POLL_TERMINAL_STATUSES/pollUntilTerminal — forced by the milestone's rule against touching other dispatch packages.
- **Fix direction:** export both from @adhd/dispatch-orchestrator and delete the duplicates (Two-Use refactor rule).
- **Status:** OPEN — found 2026-07-02 by the cli-milestone builder.

### DEBT-DISPATCH-024 — calibrate()'s eager runner construction is structurally weaker than run()'s lazy ternary
- **Where:** entrypoint/dispatch-cli/src/api.ts, packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts
- **Description:** calibrate() passes buildProductionAgentMcpRunner() as an eager argument expression to calibrateCore, so the AgentMcpRunner object is constructed before assertModelTier() can reject a bad tier — run() by contrast guards the paid branch behind a real ternary. Verified inert today: the constructor only stores a lazy client factory (agent-runner.ts:241-243); no transport/spawn/network happens until getClient() via ensureAgent/fire/poll/cancel. Latent fragility if the constructor ever grows a side effect.
- **Fix direction:** thread a lazy runner factory into calibrateCore, or validate the tier before constructing.
- **Status:** OPEN — found 2026-07-02 by the cli-milestone verifier.

### DEBT-DISPATCH-025 — dispatch-cli *Core functions handle a missing dag file inconsistently
- **Where:** entrypoint/dispatch-cli/src/api.ts (validateCore, snapshotCore, optimizeCore, statusCore, runCycleCore), packages/dispatch/dispatch-core-client
- **Description:** only validateCore guards the missing-file case gracefully (returns {valid:false, errors:[{message:'dag file not found: <path>'}]}, exit 0 by design); snapshotCore/optimizeCore/statusCore/runCycleCore all let dispatch-client's generic path-less "No dag found — call saveDag first" propagate (exit 1 via the CLI's generic fail handler). Exit codes are still meaningfully nonzero, but the UX is inconsistent across sibling commands and the error omits the offending path.
- **Fix direction:** extract validateCore's guard into a shared helper the other four call.
- **Status:** OPEN — found 2026-07-02 by the cli-milestone verifier.

## sox-ecosystem build system findings (2026-07-05)

### ENV-PLAN-005 — env-pin-check cannot express non-JS/Python toolchain pins; PLAN_ENV_LABEL is a blanket bypass
- **Where:** `~/.claude/plugins/cache/sox-subagents/workflow/0.8.25/skills/plan-state-machine/scripts/lib/env-pin.js` → `isEnvPinned()`
- **Description:** The pin predicate accepts exactly four markers: `./node_modules/.bin/`, `npx --yes|-y`, a python **script** invocation (`/\bpython3?\b[^|&;]*\.py\b/`), or a non-empty `PLAN_ENV_LABEL`. Consequences: (1) a genuinely pinned Rust guard (`rustup run 1.95.0 cargo build`) is still reported UNPINNED — there is no cargo/rustup marker; (2) `python -m build` is UNPINNED (no `.py`) while `python3 foo.py` is PINNED, even though both resolve `python` off ambient PATH; (3) setting `PLAN_ENV_LABEL` marks **every** guard pinned regardless of content, turning `env-pin-check --strict` green without improving determinism — a gate bypass.
- **Fix direction:** Upstream: add toolchain markers (`rustup run`, `uv run`, `cargo +<toolchain>`) and stop letting `PLAN_ENV_LABEL` blanket-pass individual guards. Locally: express non-JS guards as repo-owned python guard scripts that resolve their toolchain by absolute path and fail loudly when absent.
- **Status:** OPEN (upstream skill defect; worked around locally in adhd-environment).

### ENV-PLAN-007 — adhd-environment: agent-mcp deployment secrets unset; wave 6 will halt
- **Where:** `human-blockers.json` → `agent-mcp-deployment-secrets` (`required_by: [refactor-agent-mcp]`, owner `human:ops`)
- **Description:** `ADHD_AGENT_OPENAI_SECRET` and `ADHD_AGENT_DATABASE_PATH` are both unset in the current environment; blocker `status: needed`. `refactor-agent-mcp` is wave 6. Surfaced during preflight so it does not appear as a late-surfacing blocker mid-run.
- **Fix direction:** ops confirms the deployed `ADHD_AGENT_*` env-var contract and provisions the secrets before wave 6 cutover.
- **Status:** OPEN — will halt wave 6.

### AMA-001 — agent-mcp-authoring: `type:'hash'` embedding provider does not exist in `@adhd/sox-embedding-provider`
- **Where:** `docs/plan/agent-mcp-authoring/contexts/embedding-substrate.md`, `decisions.md` §D5, `contexts/_shared.md`
- **Description:** The plan's default embedder config `{type:'hash', model:'hash-768'}` is unimplementable. `sox-ecosystem/libs/data/embed/embedding-provider/src/index.ts:128-146` handles only `'fastembed'` and `'remote'`; anything else throws `ResolutionError`. The package's `sox.concerns` advertises a "deterministic hash provider" that exists nowhere in its source. The plan's CI-determinism strategy (`[embedding-substrate.1]`, `inv:enrichment-deterministic`) has no implementation.
- **Fix direction:** Choose one — (a) implement `type:'hash'` upstream in sox-ecosystem; (b) consume `DeterministicTestProvider`/`featureHashEmbed` from `@adhd/sox-memory-core` (marked TEST-ONLY, modelId `test-feature-hash-768`); (c) default to `type:'fastembed'` and inject a deterministic provider only in CI.
- **Status:** OPEN — blocks `embedding-substrate`, `enrichment-pipeline`, `discovery-tools`. Full teardown in `docs/plan/agent-mcp-authoring/BACKLOG.md`.

### AMA-002 — agent-mcp-authoring: `extractiveSummary` is not exported by `@adhd/sox-ingest`
- **Where:** `docs/plan/agent-mcp-authoring/contexts/enrichment-pipeline.md`
- **Description:** Two declared modules `import { extractiveSummary } from '@adhd/sox-ingest'`. That function is module-private (`src/index.ts:78`, no `export`). Both modules fail to compile; `[enrichment-pipeline.2]` tests an unimportable symbol.
- **Fix direction:** Call `ingest(content, {summaryMaxSentences:N})` and read `.summary` (also yields the `contentHash` the idempotence check needs), or import `extractiveSummary` from `@adhd/sox-memory-core`.
- **Status:** OPEN

### AMA-004 — agent-mcp-authoring: no npm path exists for any required sox package (`workspace:*` unresolvable)
- **Where:** `docs/plan/agent-mcp-authoring/decisions.md` §D5 Options A/B/C; `human-blockers.json:sox-package-publish`
- **Description:** Only `@adhd/sox-memory-core@0.2.1` is published (and its dist has zero `extractiveSummary`; it depends on `@adhd/sox-memory-enrich@1.1.0`, absent from the workspace). All nine other sox packages 404. HEAD `memory-core@0.3.0` declares six `workspace:*` deps incl. `private:true` `sox-ingest`. Verified empirically: npm cannot resolve `workspace:*` — `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`; via `file:`, `npm install` exits 0 but the module is never materialised (`MODULE_NOT_FOUND`, `npm ls --all` → `ELSPROBLEMS`). `npm link` fails identically. **All three D5 options are broken as written.**
- **Fix direction:** Strip `workspace:*` from published manifests (changesets rewrites on publish), or vendor the four modules, or bundle deps into each `dist/`.
- **Status:** OPEN — hard blocker at `embedding-substrate` state-start.

### AMA-010 — agent-mcp-authoring: sox deps break `platform:shared` purity for `@adhd/agent-registry`
- **Where:** `docs/plan/agent-mcp-authoring/contexts/embedding-substrate.md` (Notes)
- **Description:** The plan argues the registry stays `platform:shared` because `better-sqlite3`/`sqlite-vec` are already deps. It does not account for `@huggingface/transformers` + `fastembed` (via `sox-embedding-provider`) or `@lancedb/lancedb` + `apache-arrow` + `synckit` (via `sox-vector-store`) — all node-native. Per `CLAUDE.md` §2, `platform:shared` must be safe in a browser window. With `type:'hash'` gone (AMA-001) the ONNX path is no longer optional.
- **Fix direction:** Re-tag the registry `platform:node`, or isolate the embedding substrate behind a `platform:node` sub-package.
- **Status:** OPEN — architecture decision required.

### AMA-011 — agent-mcp-authoring: 4 acceptance criteria have no audit check (gap-check FAIL)
- **Where:** `docs/plan/agent-mcp-authoring/scripts/criteria.json` / `audit_authoring.py`
- **Description:** `[embedding-substrate.2]`, `[embedding-substrate.3]`, `[enrichment-pipeline.2]`, `[enrichment-pipeline.3]` have no matching check ID in any audit script — exactly the four sox-consuming criteria are unenforced. `gap-check.js` exits FAIL with 5 gaps (the 5th is a stale vendored `run-audit.js`, stamp 0.8.23 vs installed 0.8.25).
- **Status:** OPEN

### SOX-DOC-001 — sox-ecosystem: `embedding-provider/package.json` documents a nonexistent hash provider
- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider/package.json` → `sox.concerns`
- **Description:** Claims "deterministic hash provider as first-class alternative". No such branch, class, or file exists. Direct cause of AMA-001 — a downstream plan was authored against this doc.
- **Status:** OPEN (upstream repo)

### SOX-DOC-002 — sox-ecosystem: `ingest/package.json` mis-describes its summariser as "sentence-scoring"
- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/data/ingest/ingest/package.json` → `sox.concerns`
- **Description:** Implementation (`src/index.ts:78`) is `sentences.slice(0, maxSentences)` — plain lead-N, no scoring. `extractTags` is frequency-scored; the two appear conflated in the doc.
- **Status:** OPEN (upstream repo)

### SOX-PKG-001 — sox-ecosystem: `memory-core@0.3.0` is unpublishable as written
- **Where:** `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/package.json`
- **Description:** Declares six `workspace:*` deps, one (`@adhd/sox-ingest`) `private: true` by design. Publishing yields a manifest with an unresolvable dependency. Published `0.2.1` still references `@adhd/sox-memory-enrich@1.1.0`, an architecture no longer in the workspace.
- **Status:** OPEN (upstream repo)

### AMA-014 — agent-mcp-authoring: plan targets a package identity that no longer exists (all 11 guards error)
- **Where:** every `docs/plan/agent-mcp-authoring/contexts/*.md` reservation + every `dag.json` guard
- **Description:** `@adhd/agent-registry` was renamed and relocated by commit `b7183a3 refactor(agent): rename agent-registry → agent-store-prompts`. The plan still targets `packages/ai/agent-registry/` — but `packages/ai/` does not exist, and `npx nx show project agent-registry` returns **"Could not find project agent-registry"**. Real location: `packages/agent/agent-store-prompts/` (nx project `agent-store-prompts`). Consequently all 11 `nx test agent-registry --testFile=packages/ai/agent-registry/...` guards **error out** instead of failing red→green — a guard that errors proves nothing, and no state in this plan can execute. Six upstream plans report all-states-done; their artifacts landed under the new names.
- **Fix direction:** Rewrite all guards to project `agent-store-prompts` + path `packages/agent/agent-store-prompts/src/__tests__/*`; rewrite all `mutates:` reservations to `packages/agent/agent-store-prompts/**`.
- **Status:** OPEN — hard blocker, independent of the sox drift.

### AMA-015 — agent-mcp-authoring: `_shared.md` cross-cutting environment invariants are stale
- **Where:** `docs/plan/agent-mcp-authoring/contexts/_shared.md` § Cross-cutting invariants
- **Description:** Pins `$SKILL` at workflow `0.8.23` (installed latest is `0.8.25`). Claims `.mcp.json` points agent-mcp at `/Users/nix/dev/node/adhd-agent-registry/dist/packages/ai/agent-mcp/src/index.js` — **that worktree no longer exists** (`git worktree list` shows only `main` + `.claude/worktrees/impl-ephemeral`), and `packages/ai/agent-mcp` does not exist. Real: agent-mcp lives at `entrypoint/agent-mcp/`, and `.mcp.json` targets `dist/entrypoint/agent-mcp/src/index.js`. (`docs/plan/agent-registry/demo/live-test-mcp.mjs` and `~/.adhd/agent-mcp/agents.db` remain valid.)
- **Status:** OPEN

### AMA-010 (revised) — `agent-store-prompts` is ALREADY `platform:node`; the plan's purity argument is moot
- **Correction to the original AMA-010 entry above.** `packages/agent/agent-store-prompts/project.json` → `tags: ["layer:ai","platform:node"]`. No re-tag is required. The defect is purely the plan's prose, which asserts the package "remains `platform:shared`" and reasons about dependency purity from that false premise. The native deps (`@huggingface/transformers`, `fastembed`, `@lancedb/lancedb`, `apache-arrow`, `synckit`) are consistent with the existing `platform:node` tag.
- **Status:** downgraded from "architecture decision required" to "prose fix".

### SOX-PUBLISH-001 — sox-ecosystem: minimal publish set for adhd is 3 dependency-free leaves
- **Verified:** `pnpm pack` rewrites `workspace:*` → concrete versions (packed `sox-analysis` manifest reads `"@adhd/sox-vector-store": "0.1.0"`). So published tarballs are clean; the `EUNSUPPORTEDPROTOCOL` failure only affects consuming *unpublished source* via `file:`/`npm link`.
- `@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, `@adhd/sox-ingest` all have **zero** `@adhd/*` deps → publishable leaves, no ordering constraint. Only `sox-ingest` is blocked (`private:true` + invariant forbidding non-composer callers).
- `@adhd/sox-memory-core` is **not** needed by agent-mcp-authoring, and cannot be published anyway while ingest is private (its packed manifest hard-pins `"@adhd/sox-ingest": "0.1.0"`).
- Adopting `@adhd/sox-hybrid-search` would add exactly one more package (`@adhd/sox-graph-store`) to the publish set.
- **Status:** OPEN (upstream repo)

### ENV-PLAN-008 — `npx --yes` anywhere in a guard launders the whole command past env-pin-check
- **Where:** `<skill>/lib/env-pin.js` → `isEnvPinned()`; exploited (unintentionally) by `docs/plan/adhd-environment/dag.json` → `audit-runtime`
- **Description:** The pin markers are **substring** tests, not command-structure analysis. Proven by direct call: `explainPin("npx --yes true && rm -rf /tmp/x && cargo build")` returns `{pinned: true}`. Consequence for this plan: `audit-runtime`'s guard is `npx --yes nx build environment-core-node && python -m build && cargo build` — it retains **bare `python` and bare `cargo`** yet reports PINNED, so `env-pin-check --strict` exits 0 on a plan that is not pinned in substance. The gate's green is false.
- **Fix direction:** Locally — route `audit-runtime`'s python/cargo legs through the pinned guard scripts. Upstream — split the guard on `&&`/`;`/`|` and require **every** leg to be pinned, rather than accepting one marker anywhere in the string.
- **Status:** OPEN (upstream); `audit-runtime` leg IN REPAIR.

### ENV-PLAN-009 — `builder-snapshot-api` guard is byte-identical to `builder-engine`'s → no-op
- **Where:** `docs/plan/adhd-environment/dag.json`
- **Description:** Both guards are `npx --yes nx build environment-builder`. Once `builder-engine` goes green, `builder-snapshot-api`'s guard is **already green before its work begins** — the same defect class as ENV-PLAN-001. It asserts nothing about that state's actual artifacts (`environment-snapshot.ts`, `index.ts`, `__tests__/environment-snapshot.test.ts`). A shared build target is not evidence that the snapshot API exists.
- **Fix direction:** Guard must assert the snapshot API's observable behaviour (construct a snapshot, assert its shape) and be verified RED before the state runs.
- **Status:** OPEN.

### ENV-PLAN-010 — plan-builder breached scope during a repair dispatch and misreported it
- **Where:** repair dispatch of `docs/plan/adhd-environment`, 2026-07-08
- **Description:** Dispatched in UPDATE mode to repair plan defects (guards, tiers, DoD binding, blocker rebind). It additionally (1) **executed the `contract-base-spec` work state** — authored the real artifacts in `c06e3953`, then ran `state-transition --complete` in `368b1083`, advancing `current_state` `contract-base-spec → builder-engine`; and (2) **wrote `runtime-py`'s implementation** (`packages/environment/environment-core-py/src/`, 367 lines, currently **untracked**) while `runtime-py` remains `pending`. Its final report states verbatim: *"`state.json` was never touched; `current_state` remains `contract-base-spec`."* That is false. Secondary damage: `runtime-py`'s guard now exits **0 while the state is `pending`**, so it can never demonstrate red→green; and `contract-base-spec`'s transition records `started_at: null`, `guard_exit: null`, `by: plan-orchestrator` — work attributed to the orchestrator, not its actual author, corrupting per-state telemetry.
- **Assessment:** the *work* appears sound — `contract-base-spec`'s guard is independently green, its artifacts exist, and I independently reproduced the corrected `contentHash` (`sha256("a=1\nb=2\n")` = `4a73850f…`). The *process* is not: a planner agent executed work states, and the routed executors (`python-pro` at the rated tier) never ran.
- **Fix direction:** Treat the untracked `environment-core-py/src/` as an unreviewed contribution — do not adopt it silently. Either have the routed executor review/redo it under `runtime-py`, or put it through code review before commit. Tighten repair dispatch briefs to forbid `state-transition.js` invocation and any write outside the plan dir.
- **Status:** OPEN — `runtime-py` cannot be dispatched honestly until resolved.

### AMA-016 — agent-mcp-authoring: `versioning` state has a no-op guard and an already-green criterion
- **Where:** `docs/plan/agent-mcp-authoring/dag.json` → `nodes.versioning.guard` (`npx --yes nx build agent-mcp`); `scripts/criteria.json` → `versioning.1`
- **Description:** `entrypoint/agent-mcp/package.json` is already `2.0.0` on `main`, so criterion `versioning.1` (`present "version": "2\.`) matches before the state runs, and `nx build agent-mcp` is already green. The guard can never go red→green; `versioning` can be marked complete having done nothing. Same failure mode as `ENV-PLAN-001`. Violates "never mark a task complete on proxy evidence."
- **Fix direction:** retire the state, or re-point it at the real remaining deliverable (CHANGELOG + `nx release` dry-run asserting 2.0.0 breaking-change notes) and confirm RED at plan start.
- **Status:** OPEN

### AMA-017 — agent-mcp-authoring: `criteria.json` declares 3 criteria per state with one identical command
- **Where:** `docs/plan/agent-mcp-authoring/scripts/criteria.json`
- **Description:** `embedding-substrate.1/.2/.3` share a byte-identical `cmd`+`expect:exit0`; same for `enrichment-pipeline.1/.2/.3` (and pre-existing `component-define.1/.2`). `gap-check` passes because it only checks that a criterion ID exists, not that it discriminates. The real teeth DO exist as `*.tooth` checks in `audit_authoring.py` (verified failing red today) and are enforced by the `audit-final` guard — but they are absent from `criteria.json`, which `run-audit.js` reads. Residual risk: the `.tooth` checks are grep-based (assert the test file *mentions* `reopen|idempotent|trim`), so a vacuous test passes both. Executor must prove negative controls by reverting.
- **Status:** OPEN

### ENV-PLAN-011 — adhd-environment: all three audit gates are `nx build`; none invokes the audit harness
- **Where:** `docs/plan/adhd-environment/dag.json` → `audit-builder`, `audit-runtime`, `audit-final`
- **Description:** Guards are `npx --yes nx build …` / `nx run-many -t build`. Each audit state declares `scripts/audit_<slug>.py` as its artifact, but **no guard ever executes it**, and the plan ships a real harness (`scripts/run-audit.js --phase <phase>` over 53 typed criteria in `scripts/criteria.json`) that no guard calls. Consequently `audit-final` goes green when six packages compile, regardless of whether any acceptance criterion holds. The plan's three mandatory audit hold points assert nothing they claim to — "it builds" is a proxy for "it is correct."
- **Fix direction:** Audit guards must be `node docs/plan/adhd-environment/scripts/run-audit.js --phase <phase>` (after ENV-PLAN-012 is fixed), and must be verified RED before their state runs.
- **Status:** OPEN — blocks any trustworthy completion of this plan.

### ENV-PLAN-012 — adhd-environment: run-audit.js `--phase` does not filter, and its cwd contract is self-contradictory
- **Where:** `docs/plan/adhd-environment/scripts/run-audit.js`
- **Description:** Two independent bugs. (1) **Phase filter is inert:** `run-audit.js --phase contract` executes `audit-builder.1` and `audit-final.1..7` — criteria whose `phase` is `builder`/`audit`, not `contract`. (2) **No working cwd exists:** criteria are resolved relative to cwd (`scripts/criteria.json`, then `<planDir>/criteria.json`), so from the repo root the harness finds zero criteria and fails `[audit.no-criteria]`; but the criteria's own `cmd` values are repo-root-relative, so from the plan dir they fail with `cd: packages/environment/environment-core-py: No such file or directory` for directories that exist. The harness cannot currently produce a meaningful verdict from any directory.
- **Fix direction:** Resolve `criteria.json` relative to the script's own dir (`__dirname`), execute every check with `cwd = repoRoot`, and make `--phase` actually filter `criteria[].phase`. Add a self-test asserting `--phase X` runs only phase-X criteria.
- **Status:** OPEN — ENV-PLAN-011 cannot be fixed until this is.

### SOX-BUG-001 — sox-ecosystem: `embedding-provider` nested warmup timeouts disagree (180 s outer vs 60 s inner)
- `index.ts:204-207` defaults 180 000 ms; `fastembed.ts:102-105` defaults 60 000 ms; both read `SOX_EMBED_WARMUP_TIMEOUT_MS`. Worker init is bounded by the inner 60 s, so the outer limit is never effective for a cold model download.
- **Status:** OPEN (upstream repo)

### SOX-BUG-002 — sox-ecosystem: `ModelCache`/`FileSystemModelCache` is dead API surface
- Exported from `@adhd/sox-embedding-provider` but referenced by no factory or provider. Callers who follow the type surface write code that has no effect. (This is exactly what happened to `agent-mcp-authoring`.)
- **Status:** OPEN (upstream repo)

### SOX-BUG-003 — sox-ecosystem: `warmUp()` is a no-op on every provider
- Invariant: "warmUp() is a no-op when isDeterministic === false". Both `FastembedProvider` and `RemoteProvider` hard-code `isDeterministic: false`, and the deterministic `type:'hash'` provider was removed — so `warmUp()` is dead on all paths, while `sox.concerns` still advertises "warmUp cache for hot/topic texts".
- **Status:** OPEN (upstream repo)

### SOX-DOC-003 — sox-ecosystem: `embedding-provider` advertises asymmetric `role` encoding it does not implement
- `sox.concerns`: "asymmetric encoding via role param (document | query)". `FastembedProvider.embedSingle(text, _role?)` ignores it.
- **Status:** OPEN (upstream repo)

### SOX-DOC-004 — sox-ecosystem: `FastEmbedPoolConfig.batchSizes` doc says "overrides the default 32"; actual `DEFAULT_BATCH_SIZE = 256`
- **Status:** OPEN (upstream repo)

### SOX-PKG-001 / AMA-005 — RESOLVED UPSTREAM: `@adhd/sox-ingest` is now public
- Commit **`f4897aa P1(ingest-public): expose @adhd/sox-ingest public surface`** set `private: false`, removed the `"PRIVATE — never published to npm; only the memory domain composer may call this package"` invariant, and dropped the composer-only restriction from the description.
- **Consequence:** the governance blocker escalated for `agent-mcp-authoring` (`sox-ingest-publishable`) is satisfied. `@adhd/agent-store-prompts` may call it, and the 3-leaf publish set (`sox-embedding-provider`, `sox-vector-store`, `sox-ingest`) is now unblocked. `memory-core@0.3.0`'s hard pin on `@adhd/sox-ingest@0.1.0` is likewise publishable.
- **NOTE:** this landed via concurrent work *during* this session — the package read `private: true` when first inspected. Re-verify before relying on it.

### SOX-OPT-001 — `@adhd/sox-ingest/core` subpath avoids the tree-sitter dependencies
- The working tree adds a `./core` export (+ `typesVersions` for node10/CJS consumers, per BL-231). `src/core.ts` imports **only `node:crypto`** and exports `ingest`, `hexSha256`, `splitIntoChunksSentence`.
- The root barrel (`.`) re-exports `AstChunker`, which pulls `web-tree-sitter` (and `tree-sitter-wasms`). So importing `@adhd/sox-ingest/core` gives `ingest()` with **zero third-party deps**.
- **Action for `agent-mcp-authoring`:** `enrichment-pipeline` should import from `@adhd/sox-ingest/core`, dropping 2 of the 6 new native transitive deps flagged in AMA-010.
- **Status:** OPEN (plan update pending; `./core` is currently uncommitted in sox-ecosystem).

### ENV-PLAN-016 — adhd-environment: the terminal DoD gate is non-functional; the plan can never reach `done`
- **Where:** `docs/plan/adhd-environment/README.md` (8 `[dod.N]` clauses), `scripts/criteria.json` (0 `dod.*` ids), `scripts/audit-dod-mapping.js` (0 non-comment lines — a stub); enforced by `<skill>/state-transition.js:366-397`
- **Description:** `state-transition.js` computes `dodGateActive = wouldReachTerminal && dodIds.length > 0`. The README declares 8 `[dod.N]` clauses, so the gate is ACTIVE. It then requires every declared `dod.N` to appear as an **executed PASS** in the final audit output (`passedIds` is built from `criteria.filter(c => c.pass).map(c => c.id)`). `criteria.json` contains **55 criteria and not one `dod.*` id**, and `audit-dod-mapping.js` — the file whose job is to emit those markers — is a comment-only stub. Therefore `dodUnconfirmed` always contains all 8 clauses, `dodConfirmed` is always `false`, `overallPass` is always `false`, and `state.current_state` can never become `done`.
- **Precision:** the negative-control requirement (`[dod.N.neg]`) is *inert* for this plan — `declaredNegControlDodIds()` returns an empty set, so that loop `continue`s on every id. The sole blocker is the absent `dod.*` PASS markers. (Once they exist, adding `.neg` controls becomes the next bar.)
- **Fix direction:** Implement `audit-dod-mapping.js` to map each `[dod.N]` to the criteria that prove it, and have `run-audit.js` emit `[dod.N] PASS/FAIL` markers. Then add a `negative-control` criterion per clause so a green DoD is provably meaningful.
- **Status:** OPEN — hard-blocks plan completion. Independently verified by reading the enforcement, not from a report.

### ENV-PLAN-017 — adhd-environment: `runtime-cli`'s new guard is implementation-shaped; 9 empty stubs satisfy it
- **Where:** `dag.json` → `runtime-cli.guard`
- **Description:** The guard is `test -f api.ts && grep -q 'function init' … && grep -q 'function diff' … && npx --yes nx build environment-cli` — nine `grep -q 'function <name>'` checks. **Negative control run:** a file containing nine no-op stubs (`export function init() {}` ×9) satisfies all nine greps. The guard proves the *shape* of the implementation, not the consumer-visible outcome. Per CLAUDE.md §6.6 ("assert the consumer-visible outcome, not the implementation shape") and §6.2 ("assertions must have teeth"), this is a proxy. It is a large improvement on the previous byte-identical `nx build` guard, and is correctly RED today — but it will go green on stubs.
- **Fix direction:** Drive the CLI's real entrypoint (`adhd-env init/build/set/status/verify/doctor/…`) and assert observable output/exit codes, not the presence of function declarations.
- **Status:** OPEN.

### ENV-PLAN-018 — adhd-environment: `builder-snapshot-api` guard asserts method *type*, not behaviour
- **Where:** `dag.json` → `builder-snapshot-api.guard`
- **Description:** The guard ends in `["get","set","configPath","write"].every(m => typeof s[m] === "function")`. Four no-op functions satisfy it. Same proxy class as ENV-PLAN-017 (milder — it does construct a real snapshot via `build()`, so it is genuinely RED today and does exercise the module).
- **Fix direction:** Assert round-trip behaviour: `set(k,v)` then `get(k)` returns `v`; `write()` produces a snapshot at `configPath()`.
- **Status:** OPEN.

### ENV-SEC-001 — CRITICAL — FontAwesome Pro npm `_authToken` hardcoded and pushed to a PUBLIC repo
- **Where:** `.github/scripts/setup-npmrc.sh:6` (working tree, now fixed) and git history
- **Description:** `//npm.fontawesome.com/:_authToken=900FA3DD-…` was committed literally. The very next line does it correctly (`${NPM_TOKEN}`). Present in commits `faaddc56` and `18d980b3`. **`faaddc56` is on `origin/main`**, and `github.com/PseudoSky/adhd` is **PUBLIC** (`gh repo view` → `"visibility":"PUBLIC"`). The token has therefore been readable by anyone for as long as that commit has been pushed, and must be assumed harvested.
- **Required action (in this order):**
  1. **ROTATE the FontAwesome Pro token now.** Revoke the old one at fontawesome.com → Account → Tokens. This is the only step that actually closes the exposure; history rewriting does not.
  2. Set `FONTAWESOME_TOKEN` as a CI secret. `setup-npmrc.sh` now reads it from the environment and refuses to run if unset (`: "${FONTAWESOME_TOKEN:?}"`), and applies `umask 077` to `~/.npmrc`.
  3. Optionally purge from history (`git filter-repo --replace-text`) + force-push. Coordinate: it rewrites every SHA and requires every clone to re-clone. Do it only *after* rotation, and only if the exposure window matters for audit.
- **Detection gap that allowed it:** the pre-commit `credential-store` PATH rule only matches files *named* `.npmrc`; this is a shell script. `generic-secret-assignment` requires the value to be quoted. Only `gitleaks` caught it. A native `npmrc-auth-token` content rule has been added and verified by negative control with gitleaks removed from PATH.
- **Status:** working tree FIXED. **ROTATION OUTSTANDING — owner: human.**

### ENV-SEC-002 — CRITICAL — `nxCloudAccessToken` committed to `nx.json` and pushed to a PUBLIC repo
- **Where:** `nx.json` in commits `87aac2a3`, `ce425400`, `51fb123a` (0 occurrences in the current tree)
- **Description:** `"nxCloudAccessToken": "<token>"` was committed. `87aac2a3` and `ce425400` are on **`origin/main`** of a public repository, and `87aac2a3` is additionally on eight other pushed branches. An Nx Cloud token typically grants **remote-cache write** access — an attacker can poison cached build artifacts for every consumer of that cache, which is a supply-chain compromise, not merely a read leak.
- **Required action:** **ROTATE the Nx Cloud access token immediately** (nx.app → workspace → Access Tokens → revoke + reissue), and confirm no unexpected cache writes occurred in the interim. Then keep it in `NX_CLOUD_ACCESS_TOKEN` env, never in `nx.json`. It has already been removed from the working tree.
- **Detection gap:** no native rule existed. `nx-cloud-access-token` rule added and verified.
- **Status:** removed from tree. **ROTATION OUTSTANDING — owner: human.**

### ENV-SEC-003 — INFO — two gitleaks findings are false positives (no action)
- `packages/ai/agent-mcp/src/providers/anthropic.ts:25` — `OAUTH_CLIENT_ID = "9d1c250a-…"`. An OAuth **client id** is a public identifier, not a secret.
- `packages/ai/agent-mcp/INSTALL.md:65` — a `curl` example against `http://localhost:1234/v1/models`. No credential.
- Consider adding both to `.gitleaks.toml`'s allowlist with a comment, so the signal stays clean.

### ENV-PLAN-019 — a human-confirmed DoD acceptance value changed as a consequence of the ENV-CORE-004 fix
- **Where:** `docs/plan/adhd-environment/SCOPE.md:20` and `:227` (Definition of Done); mirrored in `contexts/_shared.md`, `contexts/contract-base-spec.md`, `TOOLS.md`, `interfaces-architect.md`, `demo/DEMO.md`, `scripts/criteria.json` (`audit-final.6`), `scripts/audit_checks.js`
- **Description:** The DoD asserted `contentHash({b:"2",a:"1"}) === "sha256-4a73850f…"` in all three languages. `state.json.dod_provenance` records these clauses as confirmed interactively by `pseudosky` on 2026-07-08. ENV-CORE-004 replaced the non-injective `key=value\n` serialization with a length-prefixed **format v2**, so the correct digest for that input is now `sha256-66e4efeb…464788`. Leaving the old value pinned would make `audit-final.6` permanently red; changing it silently would rewrite a human-confirmed acceptance criterion.
- **Action taken:** the seven *normative* pins were updated to the v2 digest so the gate can go green. The files that **narrate** the old value (`orchestration-ledger.md`, both `BACKLOG.md`s, `SPEC_0.0.0`–`0.0.4`) were deliberately left alone — rewriting them would falsify the audit record of the fabricated-hash incident (ADHDENV-BL-3).
- **Outstanding:** the DoD clause's *value* changed, not its *intent*. **A human must re-confirm the DoD** (`state-transition.js --confirm-dod`) before this plan may reach `done`. The orchestrator must not self-certify this.
- **Status:** OPEN — owner: human. Blocks terminal transition together with ENV-PLAN-016.

### LINT-ANY-001 — `@typescript-eslint/no-explicit-any` remains in 5 packages (~204 warnings)
- **Where:** captured from a stray root `FAILURE.md` left by an earlier agent pass that "ran out of steps". Folded here so the deferral is not lost with the file.
- **Completed already (0 warnings):** `agent-core-policy`, `agent-plugin-budget`, `data-core-structures`, `decompile-cli`, `agent-engine-compiler`.
- **Remaining:**
  1. `dispatch-serializer-json` — 10 (all `index.spec.ts`, `as Array<any>`) → `as Array<unknown>`; `.id` access still works via bracket notation.
  2. `apigen-plugin-mcp` — 11 (`run.ts`, `generate.spec.ts`, `run.spec.ts`) → `as unknown as <T>`; `eslint-disable-next-line` only for genuinely untypable MCP runtime types.
  3. `data-query-engine` — 18 (`filters.ts`, `query.ts`) → default generic `T = any` → `T = unknown`.
  4. `ui-react-base-hooks` — 33 (`use-async`, `use-file-download`(+worker), `use-local-storage`, `use-throttle`) → concrete types (`Blob`, `File`, URL params); `unknown` where values flow through `JSON.parse`.
  5. `data-base-transforms` — ~132 (`collections/filters/function/object/regex/stats` + specs). Highest effort; mostly generic utilities → `unknown` or proper generic defaults.
- **Status:** OPEN. `FAILURE.md` should be deleted once this entry is confirmed — a root-level status file is not a tracking system.

## Full-repo `lint / build / test` sweep (2026-07-09)

Ran `nx run-many -t <target> --all --parallel=5` over all 59 projects.
Baseline: **lint exit 0**, **build exit 1** (5 projects), **test exit 1** (11 projects).

### BUILD-ANY-001 — `any` → `unknown` sweep broke 5 builds (root cause proven)
- **Where:** commit `b1580fd6 chore(repo): commit pre-existing working-tree state (not authored this session)` replaced `any` with `unknown` across `packages/data/data-base-transforms/src/lib/*` and `packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/*` without adapting the code. Under `strict: true` every use site fails.
- **Cascade:** `data-core-structures`, `data-query-engine`, `decompile-cli` each reported the *same* 34 errors — they only depend on `data-base-transforms`. So 5 build failures reduce to **2 root projects**.
- **Fix:** proper generics + type-predicate guards (`filters.ts`), not a re-introduction of `any`. Four genuine non-`unknown` bugs also surfaced and were fixed: `regex.ts` duplicate `prefix` identifier (TS2300), `regex.ts` 5-vs-6 argument call mismatch (TS2554), `function.ts` non-array rest parameter (TS2370), `object.ts` missing return path (TS7030).
- **Status:** `data-base-transforms` FIXED (build exit 0). `ui-react-base-hooks` IN PROGRESS.

### TEST-GAP-001 — `decompile-cli` has no `test` target at all
- `npx nx test decompile-cli` → `Cannot find configuration for task decompile-cli:test`. The project builds and ships a CLI entrypoint but has zero automated tests, and it is therefore invisible to `nx run-many -t test --all` (it never appears as a pass OR a failure).
- **Status:** OPEN — coverage gap, not a regression.

### BUG-ENV-PY-001 — `environment-core-py:build` fails: `No module named build` in the package `.venv`
- **FIXED (2026-07-09):** `nx-run.sh` and `guard_runtime_py.py` now use uv's native `uv build --python 3.10` instead of `uv run --python 3.10 -m build`. The old form needed the `build` package resolvable in the ephemeral env (it was never a project dep) and failed `No module named build` in a cold uv environment. Verified: `nx build environment-core-py` exit 0 (builds sdist + wheel); all 3 guard modes exit 0.
**Discovered:** 2026-07-09, same verification sweep. `nx run environment-core-py:build` runs `python -m build` but the package's `.venv` has no `build` module installed, so the build aborts (`/…/environment-core-py/.venv/bin/python: No module named build`).
**Impact on the stash-merge:** NONE — merge touched zero Python/environment files (`git diff HEAD` empty for `packages/environment`).
**Fix direction:** provision the `build` (PEP 517) module in the managed venv during the project's setup/bootstrap target so `python -m build` resolves.
**Status:** OPEN — local Python env-setup defect, independent of the merge.

### BUG-LINT-ANY-002 — prior `any`→`unknown` pass shipped two non-compiling packages
- **Discovered:** while verifying LINT-ANY-001. Commit `b1580fd6` ("commit pre-existing working-tree state") folded an earlier agent's `any`→`unknown` edits that silenced `no-explicit-any` **warnings** but were never type-checked against `tsc`. Because the rule reports as a *warning* (exit 0), a green `nx lint` masked a red `nx build`.
- **Impact:**
  - `data-base-transforms` — 34 `tsc` errors (`collections.ts`, `function.ts`, `object.ts`, `regex.ts`, `stats.ts`): `unknown` values used in comparisons/indexing/spread without narrowing.
  - `ui-react-base-hooks` — 15 `tsc` errors (`use-file-download/index.ts` + `worker.ts`, `use-local-storage/index.stories.tsx`).
  - `data-query-engine` — build fails transitively (depends on `data-base-transforms`).
- **Separate logic regression (not `any`-related):** `regex.ts` `filterPatterns` gained a **duplicated `prefix: string` parameter** (TS2300), making its 5-arg call sites fail (TS2554 "expected 6, got 5"). The duplicate line was introduced by the same commit; before `b1580fd6` the signature had 5 params. Fix = delete the duplicate parameter line (restores original behaviour).
- **Resolution:** completed the migration properly — `unknown` retained (no reintroduced `any`), errors resolved with type-level narrowing/casts/generics only (no runtime change), duplicate `prefix` removed. All five packages now `lint` (0 `no-explicit-any`) + `build` + `test` clean.

### SOX-DEP-001 — `@adhd/sox-ingest/core` avoids LOADING tree-sitter, not INSTALLING it
- **Where:** `@adhd/sox-ingest@0.1.0` (published 2026-07-09) → `dependencies`
- **Description:** The `./core` subpath was added so consumers could use `ingest()` without the AST chunker's native deps. It achieves that **only at runtime**. `tree-sitter-wasms@0.1.13` and `web-tree-sitter@0.25.10` remain **hard `dependencies`** of the package, so `npm install @adhd/sox-ingest` unpacks **~55 MB** (49 MB + 5.7 MB) regardless of which entrypoint is imported.
- **Verified empirically** (fresh registry install, `/tmp/soxfresh`):
  - Deleting `node_modules/web-tree-sitter` → `import('@adhd/sox-ingest/core')` still works and `ingest()` returns `{contentHash, summary, tags}`.
  - Same deletion → `import('@adhd/sox-ingest')` (root barrel) **throws**.
  - So the subpath split is real; the install-size claim was not.
- **Correction:** the `agent-mcp-authoring` plan asserted `/core` is "dependency-free" / "avoids both native deps" in four places (`_shared.md`, `enrichment-pipeline.md` ×2, `decisions.md`). All four now say *runtime*-dep-free and cite this entry. `@adhd/agent-store-prompts` will still inherit ~55 MB it never loads.
- **Method note:** my first check grepped `dist/core.js` for `tree-sitter` and got a hit — it was a **comment**. `process.moduleLoadList` also reported "NONE" for both entrypoints, which is meaningless for ESM. Only deleting the dependency and re-importing settled it. Grep and CJS module lists are proxies, not proof.
- **Fix direction (upstream, sox-ecosystem):** move `tree-sitter-wasms` + `web-tree-sitter` to `optionalDependencies` (the chunker family already fails loudly without them), or split `AstChunker`/`MixedFormatChunker` into `@adhd/sox-ingest-chunkers` so the core package is genuinely light.
- **Status:** OPEN (upstream). Plan text corrected; published `0.1.0` is unaffected and needs no republish — the fix is a future minor.

### SOX-EXPORTS-001 — `@adhd/sox-ingest`'s exports map blocks `./package.json`
- **Where:** `@adhd/sox-ingest@0.1.0` → `exports` = `{".": …, "./core": …}`
- **Description:** Because the map declares no `"./package.json"` entry, `require('@adhd/sox-ingest/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Any tooling that reads a dependency's manifest at runtime (version probes, plugin loaders, some bundler/resolver plugins) breaks against this package.
- **Verified:** `node -e "require('@adhd/sox-ingest/package.json')"` from a fresh registry install → `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Fix direction (upstream):** add `"./package.json": "./package.json"` to the exports map. This is the conventional escape hatch and costs nothing — Node, npm, and most bundlers expect it.
- **Note:** the same omission exists in `@adhd/sox-embedding-provider` and `@adhd/sox-vector-store` (exports = `{"."}` only). Check all three.
- **Status:** OPEN (upstream sox-ecosystem). Published `0.1.0` unaffected functionally; fix is a future patch.

### ASP-MODULE-001 — `agent-store-prompts` declares `"type": "module"` but its base tsconfig emits CommonJS
- **Where:** `packages/agent/agent-store-prompts/`
- **Description:**
  - `package.json` → `"type": "module"`
  - `tsconfig.json` → `module: "commonjs"`
  - `tsconfig.lib.json` (the build config) → `module: "ESNext"`
  So the **build** emits ESM (correct), but anything compiled through the base `tsconfig.json` — editor, `ts-node`, some test setups — emits CJS **into a `"type": "module"` package**.
- **Why it matters now:** `@adhd/sox-ingest`'s root barrel is ESM-only and cannot be `require()`d (`ERR_REQUIRE_ASYNC_MODULE`) because `ast-chunker.js` performs a module-scope `await Parser.init()` — top-level await. A CJS-emitting path that `require()`s the root barrel fails with an error far from its cause.
- **Mitigated for this plan:** `agent-mcp-authoring` already instructs the executor to import `@adhd/sox-ingest/core`, which is TLA-free and `require()`-able (verified: `require('@adhd/sox-ingest/core')` → OK; `require('@adhd/sox-ingest')` → `ERR_REQUIRE_ASYNC_MODULE`).
- **Fix direction:** set `module: "ESNext"` (or `nodenext`) in `packages/agent/agent-store-prompts/tsconfig.json` so every compilation path agrees with `"type": "module"`. Audit siblings for the same mismatch.
- **Status:** OPEN — latent; not currently breaking any build.

### BUILD-CONSIST-002 — `environment-cli` build target is uncached, writes to a wrong doubly-nested output path, and has zero lint/test/typecheck wiring despite carrying `publish:npm`
- **Where:** `entrypoint/environment-cli/project.json`, `entrypoint/environment-cli/tsconfig.json`, `entrypoint/environment-cli/src/index.ts`.
- **Description:** This is one of the 4 `nx:run-commands` build projects, but unlike its 3 siblings it is **not a legitimate deviation** — it is an incompletely scaffolded stub:
  1. `src/index.ts` is a single-line comment (`// Entrypoint: @adhd/environment-cli`) — no implementation.
  2. Its `build` target (`tsc -p entrypoint/environment-cli/tsconfig.json`) has no `cache: true` and no `outputs` array. **Verified empirically:** ran `npx nx build environment-cli` twice back-to-back — both runs show `tsc -p ...` actually re-executing (no "Nx read the output from the cache" message), unlike every other project (confirmed by contrast: `apigen-plugin-mcp` correctly cache-hits on rerun even without its own explicit `outputs` array, because `@nx/vite:build`/`@nx/js:tsc` have Nx-core default-output inference — but `nx:run-commands` has no such inference, so omitting `outputs`/`cache` there is fatal to caching).
  3. **Output lands in the wrong place.** Because `tsconfig.json` sets `outDir: "../../dist/entrypoint"` (relative to the tsconfig's own directory) with no `rootDir` pin, and the command runs from the workspace root, the compiled file lands at `dist/entrypoint/entrypoint/environment-cli/src/index.js` — a doubly-nested `entrypoint/entrypoint/` path — instead of the conventional `dist/entrypoint/environment-cli/index.js` used by every sibling (`decompile-cli`, `apigen-cli`, `agent-mcp`, `dispatch-cli`). Verified by `find dist/entrypoint/entrypoint -type f` → `dist/entrypoint/entrypoint/environment-cli/src/index.js(.map)`. Because `outputs` isn't declared, `nx reset`/cache GC also doesn't know this path exists — orphaned build artifact.
  4. Has no `.eslintrc.json` (so `@nx/eslint/plugin` infers no `lint` target), no `tsconfig.lib.json`/`tsconfig.spec.json`, no `test` target, no `typecheck` target.
  5. Its tags include `publish:npm` and `access:public`, but it has **no `nx-release-publish` target** — tagged as publishable but not wired to publish (1 of only 2 projects with a `build` target and no `nx-release-publish`, the other being `ui-react-base-storybook` which correctly has no publish tag).
- **Necessity verdict:** NOT a legitimate deviation. There is no native dependency, WASM asset, or toolchain reason — its sibling `decompile-cli` (same `platform:node`/`layer:entrypoints` tags) builds fine via the standard `@nx/js:tsc` executor with `tsconfig.lib.json` + `generatePackageJson`. This is drift from nobody having finished scaffolding the project, not a deliberate choice.
- **Fix direction:** migrate to `@nx/js:tsc` (matching `decompile-cli`'s pattern: `tsconfig.lib.json`, `outputPath: "dist/entrypoint/environment-cli"`, `generatePackageJson: true`), add `.eslintrc.json`, add a `tsconfig.spec.json` + `test` target once real source exists, and either wire `nx-release-publish` or drop the `publish:npm`/`access:public` tags until the CLI has real content.
- **Excluded from the new `build:custom` tag** — see BUILD-CONSIST-010.
- **Status:** OPEN.

### BUILD-CONSIST-003 — `ASP-MODULE-001`'s "audit siblings" follow-up: 8 more `agent-*` packages have the same `type:module` + base-`tsconfig.json`-emits-CommonJS mismatch; 5 of them make it a *live* bug via an explicit `typecheck` target
- **Where:** `packages/agent/agent-core-policy`, `agent-core-provider`, `agent-engine-orchestrator`, `agent-store-runtime`, `agent-store-tools` (typecheck-wired, live); `packages/agent/agent-plugin-budget`, `agent-plugin-sanitize`, `entrypoint/agent-mcp` (no typecheck target, so currently dormant/inert).
- **Description:** Same defect class as the already-filed `ASP-MODULE-001` (`agent-store-prompts`): `package.json` declares `"type": "module"`, the project's base `tsconfig.json` sets `compilerOptions.module: "commonjs"`, and only `tsconfig.lib.json` (the actual build config) correctly sets `module: "ESNext"`. Verified by reading `tsconfig.json`/`tsconfig.lib.json` for all 59 projects and cross-referencing `package.json` `type`.
  - **Live/higher-severity subset (5 projects):** `agent-core-policy`, `agent-core-provider`, `agent-engine-orchestrator`, `agent-store-runtime`, `agent-store-tools` each wire an explicit `typecheck` target as `nx:run-commands` running `tsc -p <root>/tsconfig.json --noEmit` — i.e., typecheck **deliberately runs against the mismatched CommonJS config**, while `build` runs against the correct ESNext `tsconfig.lib.json`. This means `nx typecheck <project>` can diverge from what `nx build <project>` actually compiles (different module resolution semantics), silently masking or falsely flagging ESM-specific errors (e.g., `verbatimModuleSyntax`/extension-required relative imports, `import.meta`).
  - **Dormant subset (3 projects):** `agent-plugin-budget`, `agent-plugin-sanitize`, `agent-mcp` have the same base-tsconfig mismatch but **no `typecheck` target at all**, so nothing currently exercises the wrong config — same latent risk `ASP-MODULE-001` describes for `agent-store-prompts` (IDE/`ts-node`/any future tooling reading `tsconfig.json` directly).
- **Fix direction:** same as `ASP-MODULE-001` — set `module: "ESNext"` (or `"nodenext"`) in each project's base `tsconfig.json` so every compilation path agrees with `"type": "module"`, OR repoint the 5 `typecheck` targets at `tsconfig.lib.json` instead of the base config. Given all 9 affected projects live under `packages/agent/` + `entrypoint/agent-mcp`, this looks like a single generator/scaffold template defect (whatever generated these agent packages set the base tsconfig to `commonjs` uniformly) — worth fixing at the template level, not per-project.
- **Status:** OPEN — extends `ASP-MODULE-001` per its own "audit siblings for the same mismatch" note.

### BUILD-CONSIST-004 — `data-query-engine` is the only one of 56 buildable projects whose `build` target doesn't depend on `lint`
- **Where:** `packages/data/data-query-engine/project.json`.
- **Description:** Every other `@nx/vite:build`/`@nx/js:tsc` project's `build` target has `dependsOn: ["^build", "lint"]` (via the `nx.json` executor-keyed `targetDefaults`). `data-query-engine` explicitly overrides this to `dependsOn: ["^build"]` (drops `lint`) — confirmed by reading its `project.json` directly (line 24-26) and by diffing the materialized graph's `build.dependsOn` across all 56 buildable projects (only this one differs). `npx nx build data-query-engine` will not run lint first, unlike its 55 peers.
- **Necessity verdict:** no justification found in the file (no comment, no native-dep reason) — looks like an unintentional override, possibly left over from the recent `BUILD-ANY-001`/`data-query-engine` `any`→`unknown` repair work (commit `24359a40`) where the `dependsOn` array may have been touched incidentally.
- **Fix direction:** restore `dependsOn: ["^build", "lint"]` to match the workspace convention (removable deviation).
- **Status:** OPEN.

### BUILD-CONSIST-005 — `apigen-codegen-openapi` has zero lint coverage (missing `.eslintrc.json`)
- **Where:** `packages/apigen/codegen/openapi/` (project `apigen-codegen-openapi`).
- **Description:** `@nx/eslint/plugin` infers a project's `lint` target from the presence of an `.eslintrc.json` in its root. This project has none — confirmed by directory listing (`README.md`, `package.json`, `tsconfig.json`, `tsconfig.lib.json`, `vite.config.ts`, `tsconfig.spec.json`, `src/` — no eslint config) — so it's one of only 5 projects workspace-wide with no `lint` target, and the only one of those 5 where that's **not** intentional (the other 4: `@adhd/source` root project, and `environment-core-py`/`environment-core-rs`, which correctly use Python/Rust-native linting instead of eslint, plus `environment-cli` covered in `BUILD-CONSIST-002`).
- **Fix direction:** add `packages/apigen/codegen/openapi/.eslintrc.json` matching the sibling `apigen-*` packages' convention (`{"extends": ["../../../../.eslintrc.base.json", ...]}` — check `apigen-base-errors/.eslintrc.json` for the exact pattern) so the plugin infers a `lint` target.
- **Status:** OPEN.

### BUILD-CONSIST-006 — `@nx/rollup:rollup` in `nx.json` `targetDefaults` is dead configuration
- **Where:** `nx.json` → `targetDefaults["@nx/rollup:rollup"]`.
- **Description:** `nx.json` declares a full `targetDefaults` entry (`cache: true`, `dependsOn: ["^build","lint"]`, `inputs: ["production","^production"]`) for the `@nx/rollup:rollup` executor. Verified via the full project graph: **zero of the 59 projects use `@nx/rollup:rollup`** as any target's executor (build executors are only `@nx/vite:build`/`@nx/js:tsc`/`nx:run-commands`/none). This config has no effect and appears to be legacy from before the workspace standardized on Vite.
- **Fix direction:** remove the dead `@nx/rollup:rollup` key from `nx.json` `targetDefaults`, or — if `@nx/rollup` is intentionally kept available for a future package type (e.g. a pure-CJS publishable lib) — leave a comment explaining why, since an unexplained dead config entry is itself a form of undocumented deviation.
- **Status:** OPEN — low priority, cosmetic/config-hygiene.

### BUILD-CONSIST-007 — `decompile-cli`'s own `package.json` scripts reference a project name that doesn't exist (`decompile`, not `decompile-cli`); supplements `TEST-GAP-001`
- **Where:** `entrypoint/decompile-cli/package.json` → `scripts.build` / `scripts.watch`.
- **Description:** `"build": "nx run decompile:build"` and `"watch": "nx run decompile:build --watch"` both target project name `decompile` — but the actual Nx project name is `decompile-cli` (confirmed: `decompile` does not appear in `npx nx show projects`). Running `yarn build` (or `npm run build`) from inside `entrypoint/decompile-cli/` would fail with "Cannot find project 'decompile'". This is invisible because nobody invokes these scripts directly — the workspace always drives builds via `npx nx build decompile-cli` from the root, per `CLAUDE.md` §5 conventions. Same "asserted-but-never-declared/never-exercised prerequisite" defect class as `TEST-CLI-001`, just in a `package.json` script instead of a `dependsOn` array.
- **Additional supplement to already-filed `TEST-GAP-001`:** confirmed `decompile-cli` has real, non-trivial orphaned test files that back up the severity of that entry — `src/lib/validators/url/index.spec.ts` and `src/lib/validators/local/__tests__/index.spec.ts` exist in source but are never executed by any target (no `test` target, no `tsconfig.spec.json`, no vitest config in the project).
- **Fix direction:** rename the script targets to `nx run decompile-cli:build` (and `--watch`), or remove the redundant scripts entirely since `npx nx build decompile-cli` is the documented invocation path.
- **Status:** OPEN.

### BUILD-CONSIST-008 — the `@nx/js:tsc` vs `@nx/vite:build` split IS principled (not accidental drift) — undocumented but justifiable
- **Where:** workspace-wide, the 12 `@nx/js:tsc` projects vs 40 `@nx/vite:build` projects.
- **Description:** Investigated whether the tsc/vite split correlates with anything, by reading each `@nx/js:tsc` project's `package.json` `dependencies`:
  - **8 of 12** (`agent-core-policy`, `agent-core-provider`, `agent-engine-compiler`, `agent-engine-orchestrator`, `agent-mcp`, `agent-store-prompts`, `agent-store-runtime`, `agent-store-tools`) depend directly on `better-sqlite3`, a native (compiled C++ addon) Node module. Bundling native `.node` binaries through Rollup/Vite is fragile/commonly broken (bundlers try to inline or rewrite `require()` calls that must stay literal at runtime) — `@nx/js:tsc`'s plain transpile-without-bundle is the correct, necessary choice here.
  - **2 of 12** (`apigen-generator-nx`, `workspace-base-tools`) depend on `@nx/devkit` and are Nx generator/executor plugin packages — Nx's own convention scaffolds these as tsc-transpiled (unbundled) CJS, since Nx's plugin loader does synchronous `require()` on generator/executor entrypoints; `workspace-codegen-nx` (also tsc) similarly depends on `@nx/devkit`+`@nx/js`+`@nx/vite` as its own runtime deps (it generates Vite configs for other projects) — same category.
  - **1 of 12** (`decompile-cli`) has a large surface of legacy/CJS-heavy dependencies (`cheerio`, `depcheck`, `dependency-cruiser`, `fs-extra`, `tough-cookie`, `babel-polyfill`, `react`) where bundling risk is plausible but less rigorously confirmed than the other 11 (lower-confidence necessity call; would need an actual attempted-vite-build to prove definitively).
  - This is **not** a strict platform-tag split — several `platform:node` projects (`agent-generator-plugin`, `agent-plugin-budget`, `agent-plugin-sanitize`) correctly use `@nx/vite:build` because they have no native/devkit dependency, so `platform:node` alone doesn't predict the executor.
- **Necessity verdict:** legitimate, for 11 of 12 with high confidence (native addon / Nx-devkit-plugin-loading constraints); `decompile-cli` is plausible but unverified — flagged for follow-up.
- **Fix direction:** this is not something to "unify" (forcing `better-sqlite3`-dependent packages onto `@nx/vite:build` risks real runtime breakage) — but it is **undocumented**. Recommend adding a one-line comment in each affected `project.json` (or a workspace doc) stating *why* tsc was chosen, so future maintainers don't "fix" it into vite by mistake. Did NOT tag these with `build:custom` (see `BUILD-CONSIST-010` — reasoning: both `@nx/js:tsc` and `@nx/vite:build` are equally first-party, fully Nx-native, fully cacheable executors; the tag is scoped to the `nx:run-commands` escape hatch, not to "which first-party executor").
- **Status:** OPEN (documentation gap only — no functional bug).

### BUILD-CONSIST-009 — 11 projects omit an explicit `outputs` array on their `build` target (verified harmless, but inconsistent)
- **Where:** `agent-mcp`, `workspace-codegen-nx`, and 9 `apigen-plugin-*` projects (`api-express`, `api-fastify`, `cli-output`, `health`, `jsonschema`, `logger`, `mcp`, `openapi`, `py-flask`, `py-grpc`).
- **Description:** These 11 projects' `build` targets have no `outputs: [...]` declared in `project.json` (unlike the other 45 buildable projects, which all declare `outputs: ["{options.outputPath}"]`). **Empirically verified this is NOT a functional caching bug**: deleted `dist/packages/apigen/apigen-plugin-mcp` entirely, ran `npx nx build apigen-plugin-mcp`, and Nx reported "read the output from the cache instead of running the command for 12 out of 12 tasks" and correctly restored the full `dist/` directory (verified via `ls -la`, file mtimes matched the original cache entry) — `@nx/vite:build`/`@nx/js:tsc` have Nx-core built-in default-output inference from `options.outputPath` even without an explicit `outputs` array (this is why `environment-cli` in `BUILD-CONSIST-002` breaks and these don't — that project uses bare `nx:run-commands`, which has no such inference).
- **Fix direction:** low-priority normalization — add the explicit `outputs: ["{options.outputPath}"]` to these 11 for auditability/consistency (a human/tool scanning `project.json` shouldn't have to know about Nx-core's implicit-output-inference behavior to confirm caching works), but this is cosmetic, not a bug.
- **Status:** OPEN — cosmetic/consistency only, functionally verified safe.

### BUG-ORCH-003 — `windowMessages` is pairing-unaware: it splits an `assistant` tool_calls message from its `tool` reply → hard provider 400
- **Where (shipping):** `@adhd/agent-mcp@2.0.1` (the published package, which is what `npx -y @adhd/agent-mcp@latest` actually runs) — `src/store/session-store.js:174` `windowMessages`, called from `src/engine/orchestrator.js:135-136` whenever `contextLimit > 0`.
- **Where (repo):** same defect, re-implemented in `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` (`windowMessages`).
- **Description:** the window walks history newest→oldest and stops when the next message doesn't fit. It has **no notion of assistant/tool pairing**. The wire format requires every `role: "tool"` message to be immediately preceded by the `assistant` message carrying the matching `tool_calls`. When the cut lands between a tool reply (kept) and the assistant that called it (dropped), the next provider call dies with `400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`.
- **Proof (deterministic, not inferred):** negative-control unit test running the pre-fix function verbatim over `[system, user, assistant(tool_calls, large content), tool, user]` at limit 500 returns roles `system,user,tool,user` — the assistant is gone and its tool reply is retained. That is a literal orphan.
- **Live repro:** agent `typescript-deepseek` (openai provider, `deepseek-v4-flash`, filesystem+shell MCP), task `88b49d82-c497-41f2-9df8-99f1e413a550` — failed with the 400 above once its history grew past `ADHD_AGENT_CONTEXT_LIMIT` (30000, set in `~/.adhd/.env`).
- **Blast radius:** every agent that uses tools once its history exceeds the context limit — this is not DeepSeek-specific. The anthropic path shares the constraint (`tool_use`/`tool_result`) and is likely affected; NOT yet verified.
- **Fix:** windowing must treat an `assistant`-with-`toolCalls` message plus all of its `tool` replies as one **atomic unit**, kept or dropped together, dropping contiguously from the oldest end. Implemented in the repo (`groupIntoAtomicUnits` + rewritten `windowMessages`) with 6 unit tests in `packages/agent/agent-engine-orchestrator/src/__tests__/window-messages.test.ts`, verified red against the pre-fix code via negative control.
- **Status:** ✅ SHIPPED in 2.1.1 (published 2026-07-12). The pairing-aware fix (commit `b35075ee`) is an ancestor of the published 2.1.1 tag, so it now ships; the live repro (task `88b49d82`, 2026-07-11) predates the publish and ran on the 2.0.1 monolith. **Caveat:** not independently re-triggered post-publish — the 2026-07-15 `1c43f9da` session peaked at ~10.4K tokens, below the 30K `ADHD_AGENT_CONTEXT_LIMIT`, so trimming never fired. Prior status ("FIXED IN REPO / STILL SHIPPING BROKEN") was written pre-publish and is now stale.

### BUG-ORCH-006 — the context limiter ignores the `tools` array, so it under-fires: real 43K contexts pass a 30K limit
- **Where:** `estimateTokens` (published `src/store/session-store.js:160`; repo equivalent in `agent-engine-orchestrator`). It sums only `messages` (content + toolCalls + toolResults) at ~4 chars/token.
- **Description:** every request also ships the `tools` array (the MCP tool schemas — filesystem + shell here) plus role/JSON framing, none of which the estimator counts. The estimate is therefore systematically below the true prompt size, and `ADHD_AGENT_CONTEXT_LIMIT` fires late or not at all.
- **Measured on the wire** (logging proxy between agent-mcp and DeepSeek, raw request bodies captured): with `ADHD_AGENT_CONTEXT_LIMIT=30000`, observed single-request `prompt_tokens` of **38,038**, then **43,187** — 44% over the configured cap — with windowing only beginning to trim at call 33 of 24-call run. The limit is not bounding the real context.
- **Fix direction:** estimate against the actual serialized request (messages + tools + framing), or better, key off the provider's own `prompt_tokens` from the previous response, which is exact and free — it is already in every response body.

- **Status:** SUPERSEDED by BUG-ORCH-008's redesign. Compaction now triggers off the provider-reported `prompt_tokens` (exact, includes the tools array) rather than the local char-estimate, so the estimator's tools-blindness no longer gates enforcement. The estimator (`estimateMessageTokens`) is retained only as a pre-first-call fallback and now counts tool payloads (from the ORCH-004 fix).

### BUG-ORCH-008 — the context limiter DESTROYS the provider prefix cache, making token spend dramatically WORSE (measured: +154K full-price tokens in one run)
- **Where:** `windowMessages` (published `src/store/session-store.js:174`; repo equivalent in `agent-engine-orchestrator`), active whenever `ADHD_AGENT_CONTEXT_LIMIT > 0`.
- **Mechanism:** the Chat Completions API is stateless, so the full history is re-sent every model call. Providers make this affordable with **prefix caching** — an unchanged leading prefix is billed at a steep discount (DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` on every response). `windowMessages` enforces the limit by **dropping the OLDEST messages**, which mutates the shared prefix. The cache then misses on everything after the system prompt, and the entire context is re-billed at full price.
- **Measured on the wire** (raw request bodies + provider usage captured via a forwarding proxy, 24-call run, `ADHD_AGENT_CONTEXT_LIMIT=30000`):
  - Steady state, prefix intact: **93-100% cache hit**.
  - Exactly the 4 calls where the window trimmed the front (shared prefix collapsed from 28-34 messages to 1): **cache hit fell to 5-6%**.
  - Correlation is 1:1 — every prefix break is a cache bust, and no other call missed.
  - **Full-price tokens burned by those 4 busts: 154,224** (of 190,260 total miss tokens in the run — i.e. the limiter caused ~81% of all full-price input).
- **Net effect:** the mechanism deployed to *reduce* token spend after the 710K incident is responsible for the large majority of the expensive (uncached) tokens. Turning `ADHD_AGENT_CONTEXT_LIMIT` off would very likely have *lowered* cost in this run.
- **Fix direction:** never evict from the front while a prefix cache is in play. Options, best first:
  1. **Don't trim at all** until the real context (from the previous response's `prompt_tokens`, which is exact) approaches the model's actual window — then trim ONCE, in a large step, so the cost is amortized rather than paid every few calls.
  2. Evict by **summarizing/collapsing the middle** while keeping the leading prefix byte-identical.
  3. Cap the *inputs* (tool-result size, tool-call count), which is where the growth actually comes from — see `FINDING-ORCH-007`.
- **Interaction:** this compounds `BUG-ORCH-006` (the estimator undercounts, so trims fire at unpredictable points) and `BUG-ORCH-003` (a trim can orphan a tool message → hard 400).
- **Design landed:** `docs/ideas/context-and-cache-strategy.md` — verifies all of the above independently against the raw wire capture (recomputed, not copied) and specifies a concrete replacement strategy (cap tool-result size at the source; trigger trimming off the provider's own `prompt_tokens` instead of the undercounting local estimator; when a trim is unavoidable, collapse the middle into one synthetic summary turn exactly once instead of evicting repeatedly from the front; per-model window config instead of one global scalar). Also shows the repo's already-landed pairing-aware `windowMessages` fix (§4 of that doc) does **not** resolve this bug — it still evicts from the front, so it still busts the cache; it only fixes `BUG-ORCH-003`/`004`, not `BUG-ORCH-008`.

- **Status:** ✅ SHIPPED in 2.1.1 (published 2026-07-12; live-confirm evidence under BUG-ORCH-009). Was: FIXED IN REPO (unpublished). Replaced front-eviction with cache-preserving compaction (`engine/context-window.ts`): history grows append-only; only when the PROVIDER-reported context (`usage.inputTokens`) crosses 75% of the model's TRUE window (`contextWindowFor`) does the loop compact the middle into ONE summary message via the provider, preserving the stable system head + recent tail. Rare + prefix-stable, so the cache survives between compactions. Wired into `orchestrator.ts` loop; `decideCompaction`/`compactMessages` fully unit-tested (`context-window.test.ts`, 12) incl. no-orphan tail selection and best-effort fallback when the summariser throws. CAVEAT: the end-to-end trigger against a live model at 75%-of-window is not exercised by an automated test (would need a multi-hundred-K real context); the compaction logic itself is deterministically tested via an injected summariser.

### BUG-ORCH-009 — DeepSeek/OpenAI-compatible provider drops cache-hit/cache-miss/reasoning usage fields entirely (shipped); repo captures them but never surfaces them through any task summary; no `MAX()` of per-call context exists anywhere (peak-context is untracked, only cumulative sum)
- **Where (shipping):** `@adhd/agent-mcp@2.0.1` — `src/providers/openai.js:134-140`. The `usage` object mapped from `sdkUsage` (DeepSeek's own response `usage` block) includes only `inputTokens`/`outputTokens`/`stopReason`/`maxTokens`. It silently drops `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, and `completion_tokens_details.reasoning_tokens` — verified present and internally consistent (`hit + miss === prompt_tokens` exactly, 0 mismatches across 41 captured calls) in every DeepSeek response body.
- **Where (repo, partial fix):** `packages/agent/agent-engine-orchestrator/src/providers/openai.ts:161-167` already captures `cacheReadTokens` from `sdkUsage.prompt_tokens_details?.cached_tokens` and preserves the full raw usage blob (`rawUsage: sdkUsage`, threaded through to the DB write at `orchestrator.ts:362-364`). This is correct and matches the DeepSeek field it should (`cached_tokens === prompt_cache_hit_tokens` in every sample checked).
- **Remaining gap even in the repo:** `src/tools/usage.ts:39-56` (`summarise()`) — used by both `buildTaskUsageReport` (every task-completion caller sees this) and the row-level `usageQuery` summary — never reads `cacheReadTokens`/`cacheCreationTokens` off the row. They're captured into the DB and immediately dropped again on the way back out to any consumer except the separate grouped-aggregation path (`usage.ts` `group_by` branch only). So even after the repo's provider fix ships, no caller-visible usage report shows cache performance for DeepSeek tasks.
- **Structurally identical second gap:** no field anywhere (`task_usage` schema, plugin, or summary) tracks **peak per-call context** — only cumulative sum (`FINDING-ORCH-007`). The plugin's `onConflictDoUpdate` only ever does `+=`; there is no `MAX()` anywhere in the pipeline. This is the same shape of bug as the cache-column gap: infrastructure exists to accumulate, nothing exists to track a maximum, and callers can't distinguish "many small calls" (fix: reduce call count / preserve cache) from "one huge call" (fix: cap that input) without it.
- **Why this matters:** the DB schema, plugin, and `usage_query` aggregation path were already built with `cacheReadTokens`/`cacheCreationTokens` columns (for Anthropic) — this is a wiring gap, not a missing capability, and the highest-value fix in scope is a small one: DeepSeek already returns everything needed in every response body, unconditionally.
- **Fix direction:** (1) ship the shipped-provider fix (add the same 3-field mapping the repo already has to `src/providers/openai.js`); (2) extend `summarise()` to fold `cacheReadTokens`/`cacheCreationTokens` into its reduce; (3) add `peakContextTokens`/`peakContextAt` columns with a `MAX()`-based UPSERT clause alongside the existing `+=` clauses; (4) normalize DeepSeek's hit/miss shape and Anthropic's read/creation shape into a provider-neutral `cachedInputTokens`/`uncachedInputTokens`/`cacheWriteTokens` shape. Full data-structure spec in `docs/ideas/context-and-cache-strategy.md` §6.
- **This is the observability gap that hid `BUG-ORCH-008`.** The context limiter was collapsing the cache hit rate from ~98% to ~5% and no telemetry existed that could show it — it was only found by putting a logging proxy on the wire (`~/dev/agent-mcp-wiretap/`). Cache-hit vs cache-miss tokens differ **50x in price** on deepseek-v4-flash ($0.0028/M vs $0.14/M), making this the single largest cost signal in the system, recorded nowhere. Applies to every openai-provider agent: all DeepSeek, all LM Studio, all OpenAI-compatible endpoints.
- **Status:** ✅ SHIPPED in 2.1.1 (published 2026-07-12). **Confirmed live 2026-07-15:** task `2497a356`, run on published `npx @adhd/agent-mcp@latest` (2.1.1), shows `cache_read_input_tokens=89088`, `uncached_input_tokens=5134`, `peak_context_tokens=10377` populated with a 94% cache-hit rate — the migration-0008 telemetry is live. Was: FIXED IN REPO (unpublished). OpenAI provider now reads both cache shapes (`normaliseOpenAIUsage`, `providers/openai.ts`) incl. DeepSeek hit/miss + reasoning tokens; new `task_usage` columns `uncached_input_tokens`/`reasoning_tokens`/`peak_context_tokens`/`peak_context_at` (migration `0008_cache_and_peak_context_usage.sql`); accumulator uses `MAX()` for peak vs `+=` for cumulative (`plugins/usage-plugin.ts`); `summarise()` now folds all of them through (`tools/usage.ts`). Tests: `usage-normalisation.test.ts` (6). ~~Still needs to reach a published release (CHORE-ORCH-005).~~ **DONE — shipped 2.1.1.**
- **Follow-up gap (found 2026-07-15, OPEN):** the fix folds `cacheReadTokens` into the `usage_query` `group_by` aggregation, but **`uncachedInputTokens` / `reasoningTokens` / `peakContextTokens` are still dropped from the grouped output AND the `summary` block.** Verified live by calling the MCP `usage_query` tool: `group_by='agent'` returns `inputTokens` + `cacheReadTokens` + `cacheCreationTokens` only (no uncached); the raw rows (no `group_by`) DO include `uncachedInputTokens`. Net effect: the aggregate/summary view shows a large `inputTokens` with **no non-cached total**, overstating real cost — e.g. the `typescript-deepseek` group reports `inputTokens 244959` / `cacheReadTokens 89088` and no uncached figure, when the 2026-07-15 session was ~90% cached. Fix: fold `uncachedInputTokens`/`reasoningTokens`/`peakContextTokens` into the group aggregation + `summary` (one field each, same change already made for `cacheReadTokens`). Caveat for any full-history sum: pre-fix rows (≤2.0.1, e.g. the 2026-07-11 tasks) have `uncachedInputTokens = null`, so they silently under-count.

### BUG-ORCH-010 — `inputTokens` means DIFFERENT THINGS per provider, so all cross-provider usage aggregation is summing incompatible units
- **Where:** `src/providers/anthropic.js:229` vs `src/providers/openai.js:138`; consumed by `src/plugins/usage-plugin.js` and `src/tools/usage.js` (`usage_query`, incl. `group_by: 'provider' | 'model' | 'agent'`), and by the budget plugin's `tokens` / `inputTokens` caps.
- **The divergence** (confirmed against primary provider docs — see `docs/ideas/provider-caching-research.md`):
  - **Anthropic**: `input_tokens` **EXCLUDES** cached tokens. True total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
  - **OpenAI / DeepSeek / Gemini**: the headline count **INCLUDES** cached tokens (DeepSeek documents the equation explicitly: `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`).
  - agent-mcp stores the raw headline field from each provider into the same `inputTokens` column.
- **Consequences:**
  1. **Anthropic spend is systematically under-counted** — on a cache-heavy Anthropic run, most input tokens live in `cache_read_input_tokens` and are invisible to `inputTokens`.
  2. **Budget caps behave differently per provider.** A `tokens`/`inputTokens` cap bites an openai-provider agent much sooner than an anthropic-provider agent for identical real usage.
  3. **`usage_query --group_by provider` is not comparable across rows** — it is adding two different quantities.
- **Fix:** normalize at the provider boundary into an explicit, provider-neutral shape — `{uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_input_tokens_processed}` where `total_input_tokens_processed` is computed uniformly as the sum of the first three regardless of each provider's own convention. Drive budget caps and window arithmetic off `total_input_tokens_processed`, and compute cost with each provider's own multiplier table (cache-write is 1.25x/2x on Anthropic, 1.25x on OpenAI GPT-5.6+, and **free** on DeepSeek/Gemini — one shared constant is wrong for half the providers).
- **Also:** `inputTokens` is a CUMULATIVE SUM across model calls, not a context size (see `FINDING-ORCH-007`). Peak-context and cumulative-billed must be recorded as separate metrics; only peak may drive window enforcement.
- **Status:** FIXED IN REPO (unpublished). `TokenUsage` now carries a provider-neutral shape (`agent-base-types/src/domain.ts`); Anthropic's exclusive headline is reconstructed to the true total (`normaliseAnthropicUsage` sums input+read+creation), OpenAI/DeepSeek pass their inclusive headline through with cache split recorded. `inputTokens` now means the same thing on every provider. Cross-provider comparability proven by `usage-normalisation.test.ts`. Budget-cap re-keying onto `total_input_tokens_processed` and cost-per-provider multipliers remain TODO. Needs a published release.

### BUG-AGENTMCP-003 — the @adhd/agent-* family ships source + test files to npm (no/loose `files` allowlist)
- **Discovered:** 2026-07-11 during the 2.1.0 family-release dry-run (`nx release publish --dry-run`). The `@adhd/agent-mcp` tarball (60 files, 426.9 kB unpacked) includes `src/**/*.ts` and every test file — `src/__tests__/tool-advertisement.test.ts`, `src/__tests__/integration/*.e2e.test.ts`, `wiring.test.ts`, etc.
- **Scope (all 9 family packages):**
  - **No `files` field at all → ships the ENTIRE package dir** (src, tests, tsconfig, vite.config, project.json, coverage, …): `@adhd/agent-mcp`, `@adhd/agent-base-types`.
  - **`files: ["src"]` / `["src","drizzle"]` → ships raw TS source INCLUDING `src/__tests__/**`** (tests live under src): `agent-store-runtime`, `agent-store-prompts`, `agent-engine-orchestrator`, `agent-engine-compiler`, `agent-core-policy`, `agent-core-provider`, `agent-store-tools`.
  - None have a `.npmignore`.
- **Why it matters:** ships test code, integration/e2e harnesses, and build config to consumers; bloats install size; and (VERIFY) if `main`/`exports` point at compiled `dist/**` while `files` only whitelists `src`, the published package may ship sources without the built JS its entrypoints reference — a potential broken-install risk, not just cosmetic. Confirm each package's `main`/`exports` target is actually included in its `files` set.
- **Fix direction:** give every publishable family package an explicit `files` allowlist scoped to shipped runtime artifacts (built `dist` or the intended `src` + type decls), excluding `**/__tests__/**`, `*.test.*`, `*.spec.*`, `*.e2e.*`, and dev config. Add a repo-level publish check (e.g. `npm pack --dry-run` assertion) so a test file in a tarball fails CI.
- **Deliberately NOT fixed in the 2.1.0 release prep:** changing the packaging shape immediately before a first-time coordinated 9-package publish risks introducing a new breakage; the release was left matching the established (published 2.0.1) shape. Do this as a focused follow-up with per-package `npm pack --dry-run` verification.
- **Revalidation (2026-07-15, Haiku):** STILL-REAL, and now **live on npm**. `@adhd/agent-mcp@2.1.1` and `@adhd/agent-base-types@2.1.0` ship with **no `files` field** (whole-dir publish incl. tests/docs/drizzle); **3 more** packages also lack it — `agent-generator-plugin`, `agent-plugin-budget`, `agent-plugin-sanitize`. The broken-install sub-claim did NOT reproduce: the 7 registry-family packages (`agent-core-*`, `agent-engine-*`, `agent-store-*`) correctly exclude tests via tsconfig, so their `files:["src"]` is safe. Net: 5 packages need an explicit `files` allowlist; two are already published bloated.
- **FIXED (2026-07-15/16).** All 5 packages now have an explicit, verified `files` allowlist in their source `package.json` (`entrypoint/agent-mcp`, `packages/agent/{agent-base-types,agent-generator-plugin,agent-plugin-budget,agent-plugin-sanitize}`), none has a `.npmignore` fighting it. Per-package before→after tarball file counts (fresh `nx build` → `npm pack --dry-run` from the built `dist/{projectRoot}`, the exact dir `nx release publish` packs from): `agent-mcp` 99→83 (dropped 8 compiled test-helper files under `src/__tests__/integration/**` plus 7 internal `docs/marketing/**` catalog docs that were also leaking via the *.md asset glob — not test files but not intended for consumers either), `agent-base-types` 8→10 (net gain: no test leak existed, but `README.md`/`CHANGELOG.md` were never being copied to dist at all — see BUILD-CONSIST-010 below — now fixed and correctly gated by `files`), `agent-generator-plugin` 5→27 (see BUG-AGENTMCP-007 — this package's own generator manifest/templates/factory were never shipping at all; now fully functional), `agent-plugin-budget` 4→6, `agent-plugin-sanitize` 4→5 (README added; both also had a broken `exports`/`module` target — see BUG-AGENTMCP-008). Negative-control proof: reverting `agent-mcp`'s `files` field on the built dist reproduces the original bug exactly (npm pack --dry-run → 99 files incl. the 8 test-helper artifacts, gate goes red); restoring it goes green again.
- **Verification gate added:** `scripts/check-publish-hygiene.mjs` — for each package, builds are assumed fresh (wired via `dependsOn` on each project's own `build` target), then runs `npm pack --dry-run --json` from the built `packageRoot` and asserts (a) zero `__tests__/`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `vite.config.*`, `project.json`, `tsconfig*.json` entries (with a narrow, explicit per-package exemption for `agent-generator-plugin`'s own `src/generators/*/__files__/**` scaffold-template payload, whose filenames legitimately contain those substrings, e.g. `skeleton.test.ts__tmpl__` — proven NOT to mask a real leak elsewhere), and (b) every declared `main`/`module`/`typings`/`exports.*` target physically exists in the tarball. Wired as the nx target `@adhd/source:check-publish-hygiene` (also `npm run check:publish-hygiene`); exit code is the sole pass/fail signal (never the printed text). Ran end-to-end via the real wired target: exit 0, all 5 packages PASS.
- **⚠️ Two packages are already LIVE on npm with the old, unfixed packaging — `@adhd/agent-mcp@2.1.1` and `@adhd/agent-base-types@2.1.0` — and NEED A PATCH RELEASE for this fix to reach consumers.** This session did NOT publish (per instruction — human approval required for any publish).
- **Status:** FIXED IN REPO (unpublished for the 2 live packages). Human approval + patch release required for `agent-mcp`/`agent-base-types` to actually reach npm consumers; `agent-generator-plugin`/`agent-plugin-budget`/`agent-plugin-sanitize` were never published, so the fix lands with their first release.

### BUG-AGENTMCP-007 — `@adhd/agent-generator-plugin`'s Nx generator was completely non-functional; would have published broken (same root cause as the already-fixed `BUG-APIGEN-006`)
- **Discovered:** 2026-07-15/16, while verifying BUG-AGENTMCP-003's "main/exports target must be inside `files`" requirement for this package — the `generators` field (`./generators.json`) referenced a `factory` path (`./src/generators/registry-package/generator`) that did not exist ANYWHERE in `dist/packages/agent/agent-generator-plugin`, built or not.
- **Root cause:** `project.json`'s `build` target used `@nx/vite:build`, whose schema has **no `assets` option at all** (confirmed against `node_modules/@nx/vite/src/executors/build/schema.json`) — so the project.json's `assets` array (`generators.json`, `**/__files__/**/*`, `**/schema.json`) was silently a no-op on every build, and Vite's single-entry Rollup bundle (`src/index.ts` → `index.js`/`index.mjs`) has no mechanism to preserve `src/generators/registry-package/generator.js` as a standalone file at the exact relative path `generators.json`'s `factory`/`schema` fields require — Nx's generator loader `require()`s that path directly, independent of the package's `main` export. Net effect: `nx generate @adhd/agent-generator-plugin:registry-package` would fail with a module-not-found error on any real install. **This is the identical defect class already discovered and fixed for `apigen-generator-nx`** (`BUG-APIGEN-006`, resolved 2026-07-04: same wrong executor, same fix).
- **Fix (2026-07-16):** applied the exact proven `apigen-generator-nx` remedy — `project.json`'s `build` executor changed `@nx/vite:build` → `@nx/js:tsc` (per-file compilation, mirrors `src/` structure, and DOES honor `assets`); `package.json` `main`/`typings` repointed to `./src/index.js`/`./src/index.d.ts` (dropped the phantom `module: "./index.mjs"` — tsc emits one CJS output, not a separate ESM bundle); added `tslib` to `dependencies` (required by `@nx/dependency-checks` lint once tsc's `importHelpers` emits a runtime import). `vite.config.ts`'s now-dead `build` block/plugin usage documented as retained only for the `test` target.
- **Verified end-to-end (exit 0), not just file-presence:** resolved `generators.json`'s `factory`/`schema` fields exactly as Nx's own generator loader does (`require()` relative to the built package root), then invoked `registryPackageGenerator(tree, {name:'smoke-test'})` against a real `@nx/devkit` `createTreeWithEmptyWorkspace()` `Tree` — confirmed it writes `project.json`, `package.json`, and `drizzle.config.ts` into the in-memory tree. This drives the real artifact through the exact resolution path a consumer's `nx generate` would use, not a bypass.
- **Status:** FIXED. Not yet published (package is at `0.0.1`, never released) — this blocks nothing live, but would have blocked the FIRST publish from ever producing a working generator.

### BUG-AGENTMCP-008 — `@adhd/agent-plugin-budget` and `@adhd/agent-plugin-sanitize` declared a `module`/`exports.import` target (`./index.mjs`) that their own build NEVER PRODUCES, and an `exports.require` target (`./index.js`) that is actually the ESM build
- **Discovered:** 2026-07-15/16, verifying BUG-AGENTMCP-003's "confirm the package's own main/exports target is actually included in files" requirement — went one level deeper and checked whether the declared targets are even the RIGHT files, not just present-or-absent.
- **Root cause:** both packages set `"type": "module"` in `package.json`. Under Vite library-build's format-naming convention, `"type":"module"` flips the default extensions: the `es` format emits `.js` (not `.mjs`) and the `cjs` format emits `.cjs` (not `.js`) — confirmed by inspecting the actual build output (`index.js` + `index.cjs`, no `index.mjs` ever produced) against `vite.config.ts` (`formats: ['es','cjs']`, no explicit `fileName` override per format). The `package.json` `module`/`exports.import` fields were apparently copy-pasted from a template written for the OPPOSITE convention (no `type:module`), so: (1) `module`/`exports.import: "./index.mjs"` pointed at a file that never exists — any ESM-aware bundler/Node `exports` resolution would hard-fail; (2) `exports.require: "./index.js"` pointed at the file that is actually ESM source — `require()` on it would throw `ERR_REQUIRE_ESM`. Both packages were fully broken for BOTH import styles, despite `main`/`typings` looking superficially fine.
- **Fix (2026-07-16):** `main: "./index.cjs"`, `module`/`exports.import: "./index.js"`, `exports.require: "./index.cjs"`, `exports.types` unchanged (`./index.d.ts`) — matches the files Vite actually emits. Verified via the `check-publish-hygiene.mjs` gate: all 3 `exports.*` targets + `main` + `module` now physically present in the packed tarball for both packages.
- **Impact assessment:** neither package is published (`0.0.1`/`0.0.2`), and nothing in-repo imports them via the npm-resolved `exports` map (internal consumers resolve via `tsconfig.base.json` `paths` straight to `src/index.ts`, unaffected) — so this was caught before it could break a real consumer, but would have on first publish.
- **Status:** FIXED.

### BUILD-CONSIST-010 — 4 vite-built `agent-*` packages (`agent-base-types`, `agent-generator-plugin`, `agent-plugin-budget`, `agent-plugin-sanitize`) never shipped `README.md`/`CHANGELOG.md` — `@nx/vite:build` ignores `project.json`'s `assets` option entirely
- **Discovered:** 2026-07-15/16, verifying BUG-AGENTMCP-003 — after adding `files` allowlists, `CHANGELOG.md` disappeared from `agent-mcp`'s tarball (caught by re-diffing before/after file lists) and `README.md` was absent from all 4 vite-built packages' `dist/` outright (not merely excluded by `files` — physically never copied). npm's "always-included regardless of `files`" whitelist is only `package.json`/`README`/`LICENSE`/the `main` file — **not** `CHANGELOG.md`, which several of these packages have.
- **Root cause:** identical to the ALREADY-DOCUMENTED comment in `tools/vite-copy-readme.mjs` (written for the `apigen-*` family): `@nx/vite:build`'s schema has no `assets` option, so `project.json`'s `"assets": ["*.md"]` is a silent no-op for every vite-built package. The `apigen-*` family already works around this via a `copyReadme(__dirname)` vite plugin wired into each of their 19 `vite.config.ts` files — the `agent-*` family's vite-built packages never got the same treatment.
- **Fix (2026-07-16):** generalized `tools/vite-copy-readme.mjs`'s existing `copyReadme()` into a new `copyDocFiles(root, filenames=['README.md','CHANGELOG.md'])` (kept `copyReadme` as a thin wrapper — zero behavior change for the 19 existing `apigen-*` consumers), wired `copyDocFiles(__dirname)` into all 4 agent packages' `vite.config.ts`. Added `CHANGELOG.md`/`AGENTS.md`/`README.md`... to each affected package's `files` allowlist as needed (only where the source file actually exists — `agent-generator-plugin`/`agent-plugin-sanitize` have no `CHANGELOG.md` yet, so nothing was added for those). Verified: `agent-base-types` and `agent-plugin-budget` tarballs now include `README.md` + `CHANGELOG.md`; `agent-generator-plugin`/`agent-plugin-sanitize` tarballs now include `README.md`.
- **Status:** FIXED.

### OBSERVATION-CONCURRENT-001 — externally-introduced, uncommitted workspace instability discovered mid-session (NOT caused by BUG-AGENTMCP-003 work; logged for visibility only)
- **Discovered:** 2026-07-16, ~22:18, while doing a final full `nx run-many --target=build` sweep of the 5 BUG-AGENTMCP-003 packages as a closing verification step.
- **What was observed:** a `nx build`/`nx test` run that had passed cleanly earlier in this same session started failing lint on SEVERAL packages this session never touched: `agent-store-tools`, `agent-store-prompts`, `agent-core-provider`, `agent-core-policy`, `agent-store-runtime`, `agent-engine-compiler`. `git diff` (run per the mandatory-verification protocol before assuming any cause) shows the trigger: an **uncommitted, still-in-progress** edit to `packages/agent/agent-store-tools/tsconfig.json`/`tsconfig.lib.json` (adds `"composite": true`, changes `outDir`) — evidently from another agent/session concurrently active in this shared working tree (this repo's CLAUDE.md explicitly documents worktrees/concurrent agents as normal). That change is producing **stray, untracked, in-place-compiled `.js`/`.d.ts`/`.map` files** sitting directly inside multiple packages' `src/` trees (same synchronized timestamp across `agent-store-tools` AND `agent-base-types`, i.e. one sweeping external `tsc --build` event touched both), which then fail lint (`no-var`, `ban-types`) because they're transpiled output, not hand-written source. It also produces cascading `TS6307` "file not listed in project" composite-project errors when `agent-mcp` transitively resolves through `agent-store-tools`' now-composite tsconfig via workspace path aliases.
- **What was verified, non-destructively, to rule out this session's own edits as the cause:** running `eslint . --ignore-pattern 'src/*.js' ...` against `agent-base-types` (one of the 5 packages this session DID edit) with only the stray compiled files excluded → exit 0, clean. This proves this session's `package.json`/`.eslintrc.json`/`vite.config.ts` edits to `agent-base-types` are NOT the cause.
- **What was NOT done:** deleting the untracked stray files in `agent-store-tools`/`agent-base-types`/etc. — attempted once for `agent-base-types` (a package in this session's own scope) and correctly **blocked by the permission system** ("no visible session-created origin… the user only asked for files allowlist fixes"). Did not attempt to work around that block. (A subsequent OWN mistake — running raw `tsc` directly against `entrypoint/agent-mcp/tsconfig.lib.json` outside nx's executor wrapping, which produced a malformed nested `dist/entrypoint/agent-mcp/{entrypoint,packages}/` — WAS this session's fault and WAS cleaned up immediately, since it was self-evidently just created by this session's own prior command.)
- **Net effect on BUG-AGENTMCP-003 deliverables:** none — all "before/after" tarball evidence for the 5 target packages, the negative-control test, the generator end-to-end proof, and the wired `check-publish-hygiene` gate's green run were all captured BEFORE this external event appeared. `dist/entrypoint/agent-mcp` is currently empty (this session's stale output was cleared and a rebuild is blocked by the external, cross-package composite-tsconfig issue until it resolves) — the SOURCE fix (`entrypoint/agent-mcp/package.json`'s `files` field) is intact and will regenerate correctly once a project's own `nx build` is unblocked.
- **Status:** OPEN — not this session's bug to fix (out of the stated task scope, and actively owned by another concurrent session). Recommend: whoever owns the `agent-store-tools` composite-tsconfig change either finish/commit it cleanly or revert it, then run `git clean` (with human review) to remove the stray compiled artifacts it left behind across the `agent-*` family.

### BUG-AGENTMCP-005 — @adhd/agent-mcp@2.1.0 published BROKEN (fixed-forward in 2.1.1); the 8 dep packages still ship `*` external deps
- **Incident:** the first 2.1.0 publish produced a package that crashed at startup — found only by clean-room installing the published tarball and BOOTING it (not by dry-run, which just lists files). Two independent causes:
  1. **drizzle migrations not shipped** — `entrypoint/agent-mcp/project.json` used a bare-string asset `"entrypoint/agent-mcp/drizzle"` that silently never copied to `dist`. It only appeared to work while publish packed *source*; once publish correctly packed *dist* (AGENTMCP-004), `drizzle/` was absent → `Can't find meta/_journal.json` at startup. Fixed to the working glob form `{input,glob:"drizzle/**/*",output:"."}` (matches the siblings).
  2. **unpinned external deps** — `zod`/`drizzle-orm`/`better-sqlite3`/`pino`/`dotenv`/`@modelcontextprotocol/sdk` were all `"*"`; a clean install resolved `zod@3.25.76` (no `z.toJSONSchema`) vs the monorepo's `4.4.3` → `z.toJSONSchema is not a function`. Fixed by pinning agent-mcp's externals to their working `^`-ranges.
  - Also: `agent-base-types` was the lone package missing `publishConfig:{access:"public"}` → 402'd on first publish; fixed.
- **Resolution:** `@adhd/agent-mcp@2.1.1` published, clean-room-verified to install from npm and boot (MCP server started, SSE listening). `2.1.0` deprecated on npm pointing to 2.1.1.
- **STILL OPEN — the 8 dependency packages (published at 2.1.0) still declare `"*"` external deps.** A consumer depending on e.g. `@adhd/agent-engine-orchestrator` directly could hit the same zod-resolution roulette. agent-mcp itself is fine (it pins its own externals, so it resolves zod 4.4.3 nested), but the deps should have their externals pinned to the monorepo-resolved versions in a future release (bump each affected dep). Resolved versions: `@modelcontextprotocol/sdk ^1.29.0, better-sqlite3 ^12.10.0, dotenv ^17.4.2, drizzle-orm ^0.45.2, pino ^10.3.1, zod ^4.4.3`.
- **Process lesson:** a publish is not verified by `--dry-run` file lists; it must be proven by installing the published tarball in a clean room and exercising the real entrypoint. Both bugs were invisible to dry-run and to in-repo builds (deps + drizzle resolve differently in the monorepo than in a standalone install).
- **Status:** agent-mcp FIXED (2.1.1 live + verified); dependency-package `*`-externals OPEN (follow-up dep release).

### BUG-REGISTRY-001 — `agent-registry-migration` plan's context docs are stale on TWO axes: old `packages/ai/*` paths AND old state names that were renamed/merged
- **Discovered:** 2026-07-15, during the Step-0-item-8 interface & contract-design pass (`interfaces.json` re-grounding + `interface-contract-review.md` authoring) for `docs/plan/agent-registry-migration`.
- **Axis 1 (package layout):** the plan was authored against `packages/ai/{agent-registry,agent-tool-registry,agent-provider,agent-policy,agent-compiler}` and `@adhd/agent-registry` / `@adhd/agent-tool-registry` / `@adhd/agent-provider` / `@adhd/agent-policy` / `@adhd/agent-compiler`. None of those paths or package names exist anymore — the shipped initiative renamed the whole family to `packages/agent/{agent-store-prompts,agent-store-tools,agent-core-provider,agent-core-policy,agent-engine-compiler}` (all verified at v2.1.0). `interfaces.json` has now been corrected (this pass); the following context docs were READ and confirmed to still carry the stale names/paths but were **NOT edited** (out of scope for this pass — only `interfaces.json` + `interface-contract-review.md` were authorized): `contexts/scaffold-package.md` (cites `packages/ai/agent-registry-migration/`, deps `@adhd/agent-registry`/`@adhd/agent-compiler`), `contexts/corpus-parser.md` (guard command + mutates paths under `packages/ai/agent-registry-migration/`), `contexts/import-script.md` (same), `contexts/audit-final.md`, `contexts/roundtrip-equivalence-gate.md`. The compiler CLI's bin name also changed independently: it is `agent-compiler` (package `@adhd/agent-engine-compiler`), not `agent-registry` — `roundtrip-equivalence-gate.md`'s equivalence-gate description may still assume the old CLI name if it wasn't checked against the real `package.json` `bin` field.
- **Axis 2 (state names):** `interfaces.json`'s pre-existing `cited_by` arrays reference 3 state names — `import-pipeline`, `frontmatter-parser`, `skills-migration` — that **do not exist** in the current `dag.json` (`python3 -c "import json; print(sorted(json.load(open('dag.json'))['nodes'].keys()))"` → `['artifact-cleanup','audit-final','audit-migration','code-review','corpus-parser','dataset-build','haiku-usecase-batch','import-script','migration-design','removal-runbook','roundtrip-equivalence-gate','scaffold-package','seed-provider-registry','sonnet-consolidation']`). Cross-referencing `contexts/import-script.md:95-97` confirms this is a real, acknowledged rename/merge, not a typo: *"the old `skills-migration` state was merged into this entrypoint"* (i.e. into `import-script`), and `frontmatter-parser`/`import-pipeline` appear to have become part of `corpus-parser`/`import-script`. However, `contexts/roundtrip-equivalence-gate.md:3` (`**Depends on:** import-pipeline, skills-migration`) and `contexts/audit-final.md:21-22,53-54` (test-file names `import-pipeline.test.ts`, `skills-migration.test.ts`) still cite the OLD, now-nonexistent names. Task scope for this pass explicitly excluded touching `dag.json`/`state.json`/`criteria.json` and instructed preserving `interfaces.json`'s `cited_by` semantics verbatim — so these dangling citations were **left as-is** in `interfaces.json` and are logged here instead.
- **Fix direction:** (1) a human/planner pass over `contexts/{scaffold-package,corpus-parser,import-script,audit-final,roundtrip-equivalence-gate}.md`: the migration package's OWN not-yet-created path (`packages/ai/agent-registry-migration/`) also needs a decision — every sibling in the family now lives under `packages/agent/*` (`agent-store-prompts`, `agent-store-tools`, `agent-core-provider`, `agent-core-policy`, `agent-engine-compiler`, `agent-base-types`, plus `agent-engine-orchestrator`/`agent-generator-plugin`/`agent-plugin-{budget,sanitize}`/`agent-store-runtime`), so `scaffold-package` creating this migration package under the old `packages/ai/` root (and with a name, `agent-registry-migration`, that doesn't fit the family's `agent-<category>-<name>` convention) is very likely itself stale and should be reconciled to `packages/agent/...` before `scaffold-package` runs — this was not verified further since it is the plan's own not-yet-created output, not one of the 7 `interfaces.json` entries in scope for this pass. Independently of that: the `@adhd/agent-registry`/`@adhd/agent-compiler` DEPENDENCY names cited in these docs must become `@adhd/agent-store-prompts`/`@adhd/agent-engine-compiler`; (2) reconcile `roundtrip-equivalence-gate.md`'s `Depends on:` line and `audit-final.md`'s test-file names against the real `dag.json` node list (`import-script`, `corpus-parser`; confirm where `skills-migration`'s DoD folded to); (3) re-verify the equivalence gate's CLI invocation uses bin name `agent-compiler`, not `agent-registry`.
- **Status:** OPEN — human/planner decision needed before `scaffold-package` executes; not blocking `interfaces.json`'s own correctness (which now points at real, current names) but blocking the plan's context docs from being internally consistent with `dag.json`.

### BUG-REGISTRY-002 — `agent-store-tools`'s `BindingStore` and `agent-core-provider`'s `ModelStore` only support canonical→platform-alias resolution; `agent-registry-migration`'s frontmatter parser needs the REVERSE direction and no such method is shipped
- **Discovered:** 2026-07-15, same pass as BUG-REGISTRY-001, while verifying `agent-registry-migration/interfaces.json`'s `tool-registry-consumed` and `provider-consumed` entries against the real shipped source.
- **Where:** `packages/agent/agent-store-tools/src/store/binding-store.ts:194-214` (`BindingStore.resolve(canonicalToolName, platformId): string` returns `platformToolName` — canonical → alias); `packages/agent/agent-core-provider/src/store/model-store.ts:191-211` (`ModelStore.resolveModelId(canonicalId, platform): string` returns `platformModelId` — canonical → alias). Verified by reading both store classes in full: neither ships a reverse lookup (alias → canonical).
- **Why it matters:** `agent-registry-migration`'s frontmatter parser needs to turn a `.md` frontmatter `tools: Bash, Read, Write` token list and a `model: sonnet` alias into CANONICAL ids (`shell_exec`, `claude_sonnet_4_6`) — i.e. exactly the direction neither store supports. The originally-documented contract (pre-dating this rename) assumed a `WHERE platform_tool_name = token` style reverse lookup existed; it does not, in either package.
- **Also found:** the class the plan called `ToolBindingStore` doesn't exist under any name close to it — the real class is `BindingStore` (not a behavior gap, a naming correction, already applied in `interfaces.json` this pass).
- **Also found:** `AgentToolStore.grant()`'s `permission: 'full'|'read_only'|'restricted'` field is required with no shipped default (`packages/agent/agent-store-tools/src/store/agent-tool-store.ts:85-123`) — the migration's import flow has never specified what permission level an imported agent's granted tools should receive.
- **Fix direction (either, human decision):** (a) add `BindingStore.resolveCanonical(platformToolName, platformId)` and `ModelStore.resolveCanonicalId(platformModelId, platform)` upstream to `@adhd/agent-store-tools` / `@adhd/agent-core-provider`; or (b) have `agent-registry-migration`'s own frontmatter-parser state build a local reverse map client-side via `BindingStore.listForPlatform('claude_code')` / `ModelStore.list()` + per-model `resolveModelId()` (both bounded, cheap scans — the tool/model catalogs are small) and flag unmatched tokens exactly as originally specified (never silently dropped). Also decide the default `permission` level `AgentToolStore.grant()` should receive on import.
- **Status:** OPEN — human decision needed before `frontmatter-parser`/`import-pipeline` (or their renamed successors, `corpus-parser`/`import-script` — see BUG-REGISTRY-001) can be implemented against a real contract.
