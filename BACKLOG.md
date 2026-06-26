# BACKLOG

## Bugs

### BUG-APIGEN-001 — ctx-param functions return wrong results via generated servers (being fixed)
**Discovered:** 2026-06-23, by the apigen v2 capstone DoD probe (dod.1).
**Symptom:** a function whose first param is `ctx` but which has NO session middleware (e.g. `getUser(ctx, userId)` in `packages/apigen/cli/src/test/fixtures/real-api.ts`) returns wrong results through the generated MCP server: `callTool(getUser,{data:{userId:'abc'}})` → `{}` while direct `getUser(ctx,'abc')` → `{id:'abc'}`. Non-ctx functions are fine.
**Root cause:** `packages/apigen/runtime/src/lib/dispatch.ts` injects `ctx` only when `needsEnvelopeField(schema,'session') && createClient` (gated on the *session* envelope). A `ctx`-param fn without session middleware falls through to `fns[fnName](...args)`, so the first domain arg lands in the `ctx` slot. The extractor detects `ctx` (name-only exclusion, `[inv:ctx-name-only]`) but never *records* it for dispatch to inject.
**Fix direction:** record ctx-param presence during extraction → carry it on the schema/descriptor → `dispatch()` injects `ctx` whenever the fn declares a `ctx` first param (independent of session). Must keep dod.3 (ctx absent from schema) + dod.4 (session override) green.
**Fix landed:** `GeneratedSchemas`/`ComposedSchemas` now carry an optional `hasCtx` flag (`packages/apigen/core/src/lib/types.ts`); `generateSchemas` sets `hasCtx:true` when the first param is named `ctx` while still excluding it from `input.properties` (`packages/apigen/core/src/lib/generate-schemas.ts`); `composeSchemas` threads the flag through (`packages/apigen/core/src/lib/compose-schemas.ts`); `dispatch()` injects `ctx` (via `createClient(envelope)` if a client exists, else `undefined`) whenever `schema.hasCtx`, independent of session (`packages/apigen/runtime/src/lib/dispatch.ts`).
**Status:** FIXED. Verified by EXIT CODE: `run` probe (mcp/stdio/deep-equal) exit 0 — `getUser` now deep-equals `{id:'abc'}`; negative control confirmed (pristine dispatch → PROBE FAIL exit 1, fix → exit 0). apigen-core / apigen-runtime / apigen-cli test suites all exit 0 (ctx-exclusion + session-suppression integration tests included). `generate-parity` and `cli-output` probes are blocked by BUG-APIGEN-002 below (a separate, pre-existing module-resolution defect that also fails on pristine code) — not by this fix.

### BUG-APIGEN-002 — generated MCP servers / CLIs can't resolve `@modelcontextprotocol/sdk` when run outside the repo tree
**Discovered:** 2026-06-23, while verifying BUG-APIGEN-001 via the dod.2 (`generate-parity`) and dod.cli (`cli-output`) probes.
**Symptom:** `probe_mcp.mjs generate-parity` / `cli-output` write the generated `server.ts` / `cli.ts` to an OS tmpdir, then run it with `npx tsx <file>` (cwd=REPO_ROOT). The generated file's bare import `@modelcontextprotocol/sdk/server/index.js` throws `Error: Cannot find module … code: 'MODULE_NOT_FOUND'`, so the MCP client sees `McpError -32000: Connection closed` and the probe exits non-zero.
**Root cause:** Node/tsx resolve bare specifiers from the *generated file's* directory upward. The tmpdir has no `node_modules` ancestry to the repo, and `@modelcontextprotocol/sdk` is a real npm package (not a `@adhd/*` tsconfig path alias), so it never resolves. The `generate` command (`packages/apigen/cli/src/lib/commands/generate.ts`) emits only the plugin's `.ts` files — no `node_modules` symlink, no `tsconfig.json`, no `package.json` — so generated output is not self-resolving anywhere except inside the repo tree.
**Proof it is independent of BUG-APIGEN-001:** restoring the pristine (pre-fix) `core`+`runtime` files and rebuilding reproduces the *identical* `Cannot find module '@modelcontextprotocol/sdk/server/index.js'` failure. The error is thrown at the generated file's import phase, before any dispatch/ctx code runs.
**Fix direction (NOT done — outside this task's core+runtime scope):** make `generate` emit resolution scaffolding into `--out-dir` — e.g. symlink the repo `node_modules` into the out-dir and emit a `tsconfig.json` that maps `@adhd/*` to the repo source — so generated servers/CLIs run anywhere. Lives in `packages/apigen/cli` (+ possibly the mcp/cli plugin templates), not in core/runtime.
**Status:** RESOLVED/VERIFIED 2026-06-23 (reconciled by pseudosky) — fixed in apigen-v2 via the **Option-A "publish" model**: `generate` emits a clean publishable `package.json` with real `^<version>` deps (`@modelcontextprotocol/sdk`, `@adhd/apigen-runtime`/-core) + `tsconfig.json`; the pre-publish workspace bridge is the default-off `--link-workspace` flag. dod.2 (`generate-parity`) and dod.cli (`cli-output`) pass inside the apigen-client-generation **final audit 117/117** (re-verified green this session). **Follow-on (open, tracked):** the per-surface 3rd-party **dep-manifest emission** for logical/rich types is owned by `docs/plan/apigen-logical-types` → state `lt-dep-manifest` / `[dod.gen-deps]`. (Earlier OPEN status was stale relative to the completed plan.)

### BUG-APIGEN-003 — generated MCP server's SSE transport is unreachable (dod.1-sse)
**Discovered:** 2026-06-23, apigen v2 capstone dod.1-sse.
**Symptom:** `run --type mcp --opt transport=sse` → the probe's SSE client (`http://127.0.0.1:<port>/sse`) gets `TypeError: fetch failed`. The `streaming-http` transport (`/mcp`) works (dod.1-streaming-http passes) and stdio works (dod.1 passes) — only SSE fails.
**Root cause (CONFIRMED, not the original guess):** the SSE *transport* was already correct — `packages/apigen/plugins/mcp/src/lib/run.ts` binds `GET /sse` (emits the `endpoint` event) + `POST /messages?sessionId=` and guards the SDK's "SSEServerTransport already started!" crash. The probe's earlier `fetch failed`/`port not bound` was a **harness** defect: the probe's DEFAULT CLI target is the TS source (`packages/apigen/cli/src/index.ts`) spawned via `npx --yes tsx`, which **cannot resolve `@adhd/apigen-core` from repo root** (tsx-tsconfig-cwd gotcha) → the server crashes on module load → never binds → blind 15s timeout. The audit never hit this because it invokes the probe with `--cli dist/packages/apigen/cli/index.js` (the built bin), where `@adhd/*` resolves.
**Fix VERIFIED 2026-06-23:** (a) direct MCP-SDK `SSEClientTransport` round-trip against the dist bin → `listTools` = 5 tools, `callTool(getUser,{data:{userId:'abc'}})` → `{"id":"abc"}` (deep-equals ground truth), exit 0; (b) `probe_mcp.mjs run … --transport sse --cli dist/packages/apigen/cli/index.js` → `PROBE OK: tools/list + callTool parity for 5 derived tools`, exit 0. Probe robustness bumped (`waitForPort` 15s→60s) for cold ts-morph compiles.
**Residual (minor, tracked):** running `probe_mcp.mjs` WITHOUT `--cli` hits the broken TS-source default and fails with a confusing "port not bound" instead of a clear "server exited before binding (@adhd/* unresolved)" message — a probe-ergonomics footgun, not a product bug.
**Status:** RESOLVED/VERIFIED — dod.1-sse passes via the audit's real invocation; SSE transport reachable on stdio + streaming-http + sse.

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

### BUG-APIGEN-004 — `run`/`generate` do not fail fast on 0 extracted functions; crash with a confusing module-resolution error instead
**Discovered:** 2026-06-23, while diagnosing a user `run --source ./tmp/apigen-generate-out/index.ts --type api-fastify` failure.
**Symptom:** pointing `--source` at a file with no plain exported functions (here, apigen's *own generated output* `index.ts`, which exports only `toolMetas`/`groupFns`/`groupCreateClient`) logs `extracted 0 functions` and then proceeds to scaffold + load a wrapper anyway, crashing with `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@adhd/apigen-runtime'`. The user gets a cryptic dependency-resolution stack trace for what is actually a "wrong input file / 0 functions" condition.
**Root cause:** the v2 orchestrator (`packages/apigen/cli/src/lib/commands/run.ts` → extract step) does not treat `extracted 0 functions` as a terminal, actionable error. It continues to compose/scaffold/run, so the failure surfaces downstream as an unrelated `@adhd/apigen-runtime` import-resolution error (same dependency-boundary family as BUG-APIGEN-002, but reached only because the empty extraction wasn't gated).
**Fix direction:** (a) fail fast when extraction yields 0 functions — emit an actionable message naming the source path and likely cause ("no exported functions found in <file>; is this a source module? it looks like generated apigen output — run its `server.ts` directly, or point --source at the original source"); (b) optionally detect generated output (imports `@adhd/apigen-runtime` + exports `toolMetas`/`groupFns`) and special-case the hint. Lives in `packages/apigen/cli` (run/generate command guards).
**Status:** OPEN — usability defect; not a correctness regression (apigen extracts + serves correctly when pointed at a real source file with funcs). **tracked-by: `docs/plan/apigen-logical-types` → state `lt-fail-fast` / `[dod.fail-fast]` (shared guard: 0-functions AND missing optional rich-type dep).**

### BUG-APIGEN-005 — language-specific serializable types (Date, BigInt, Map, Set, Uint8Array) are not handled: untyped schema + no input rehydration + broken output for no-toJSON types
**Discovered:** 2026-06-23, user report ("Date -> object"), reproduced with `/tmp/apigen-date-probe/date-api.ts` (`whenIso(label): {label, at: Date}` and `echoDate(d: Date): Date`).
**Symptom (three independent modes, all proven):**
1. **Schema:** ts-json-schema/morphFallback emit `Date` as `{}` (empty, untyped). Generated `toolMetas` for `whenIso` shows `"at":{}` and for `echoDate` `"d":{}` + `output:{}`. Consumers (`tools/list`, OpenAPI, codegen, the validation Layer) get no type → treat it as an opaque object. Should be `{type:"string", format:"date-time"}`.
2. **Input rehydration:** `packages/apigen/runtime/src/lib/dispatch.ts` passes `domainArgs[k]` straight to the function (`const args = paramNames.map(k => domainArgs[k])`). A `Date` parameter arrives over JSON as a **string**, so the function receives a string; `d.getTime()`/`d.toISOString()` is `undefined`/throws. No `string→Date` coercion via the schema `format`.
3. **Output for types without `toJSON`:** `JSON.stringify({...new Date()})` → `{}`; `JSON.stringify(1n)` **throws** ("Do not know how to serialize a BigInt"); `Map`/`Set`/`Uint8Array` serialize to `{}`/garbage. `Date` output alone survives because `Date.prototype.toJSON` → ISO string; every other built-in is broken on output too.
**Root cause:** apigen has no codec/transform layer for non-JSON-native built-ins. The schema builders (`packages/apigen/core/src/lib/schema-builders/{ts-json-schema,morph-fallback}.ts`) fall through to `{}` for any non-primitive/array/union/anon-object type; dispatch does no encode-on-output / decode-on-input keyed by schema `format`.
**Fix direction (canonical, NOT a workaround):**
- **Schema:** special-case well-known built-ins before the `{}` fallthrough — `Date`→`{type:"string",format:"date-time"}`, `bigint`→`{type:"string",format:"int64"}`, `Uint8Array`/`Buffer`→`{type:"string",format:"byte"}` (base64), `Map`→`{type:"array",items:[...]}` (or object), `Set`→`{type:"array"}`, `RegExp`→`{type:"string",format:"regex"}`.
- **Runtime codec** (`packages/apigen/runtime`, new `codec.ts`): `encode(schema,value)` (JS→wire: Date→ISO, BigInt→string, bytes→base64, Map/Set→array) and `decode(schema,value)` (wire→JS, inverse), both keyed by schema `format`. `dispatch()` calls `decode` on args before invoke and `encode` on the result; apply recursively over object/array properties.
- **Conformance:** add date-time / bytes / bigint vectors to `packages/apigen/conformance` so the TS and Python hosts must agree on the wire format (TS ISO ↔ Python `datetime.isoformat()`); extend the Python host (`packages/apigen/python`) to match.
- **DoD/fixture:** add a temporal/binary case to `real-api.ts` + a `negative-control` so this can't silently regress.
**Generalization — custom classes are the same mechanism:** built-in well-known types (Date/int64/decimal/bytes) are just pre-registered instances of the logical-type registry; a user-defined class is the general case — a *nominal* logical type tagged by `$ref:"#/$defs/<Name>"` (+ a `$type`/const-tag discriminator on the wire only at polymorphic/union positions) with an *object* wire shape instead of a scalar. Same `LogicalTypeCodec` (`matches`/`encode`/`decode`), bound to each host's native class hook (TS `toJSON()`/static `fromJSON()`; Python `JSONEncoder.default`/`object_hook`/pydantic `model_dump`/`model_validate`; Jackson `@JsonTypeInfo`/`StdSerializer`; Go `Marshal/UnmarshalJSON`; serde derive + `#[serde(tag)]`). apigen's `core` already extracts class shapes and the descriptor IR already represents named types as `$def`+`$ref` and unions as `oneOf`+const-tag+`$ref` — the missing piece is the SAME runtime transcoder: on decode, a `$ref:<Class>` position must call the registered constructor (not leave a prototype-stripped object); on encode, call `toJSON()`. New class-specific concerns the scalar path doesn't have: (a) polymorphic positions need a wire discriminator (`oneOf`+const-tag); (b) transports *data not behavior* + cyclic refs can't go over plain JSON (ref-track or forbid); (c) validate-against-schema-BEFORE-construct, and gate non-reconstructable classes (sockets/closures) via the extractor's existing opt-in-instances flag.
- **DoD additions for classes:** delivered-by + conformance vectors for (1) a user class round-tripping TS↔Python (nominal `$ref`), and (2) a discriminated union (polymorphic, wire discriminator), each with a negative control.
**Status:** OPEN — correctness gap (never handled). Affects every plugin (mcp/http/cli) and the cross-host contract. Scope spans well-known scalar types AND the full nominal/custom-class type system. **tracked-by: `docs/plan/apigen-logical-types/DESIGN.md` (this bug IS the plan).**

### DEBT-APIGEN-007 — `lt-dep-manifest` dep-collection is end-to-end blocked by missing `lt-extract-scalars`
**Discovered:** 2026-06-25, during `lt-dep-manifest` state execution.
**Symptom:** The dep-manifest machinery (`collectFormats` → `collectLogicalTypeDeps` → `patchPackageJsonDeps`) is implemented and works for schemas that carry `format: decimal`. However, when a TS source file uses `DecimalValue = string` (or any type alias that resolves to a primitive), `ts-morph`'s `p.getType().getText()` resolves the alias to `string` BEFORE passing the type text to `buildSchema` / `ts-json-schema-generator`. The `format` annotation on the alias is lost. The dep-collection step sees `{type: 'string'}` instead of `{type: 'string', format: 'decimal'}` and emits no dep.
**Root cause:** `packages/apigen/core/src/lib/extractors/named.ts` calls `p.getType().getText()` which eagerly resolves type aliases. Changing it to `p.getTypeNode()?.getText()` (the alias name) would preserve alias identity, allowing `ts-json-schema-generator` to look up the `@format` annotation.
**Fix direction:** in `lt-extract-scalars` (state in the `apigen-logical-types` plan): change `extractors/named.ts` to preserve the alias name (use `getTypeNode()?.getText()` for the type text), and add `DecimalString`/`DecimalValue` to `SCALAR_SCHEMAS` in `ts-json-schema.ts` (or rely on `ts-json-schema-generator` picking up the `@format` JSDoc from the exported type alias). Once extraction preserves format annotations, the `lt-dep-manifest` machinery activates end-to-end without further changes.
**Status:** OPEN — `lt-dep-manifest` infrastructure is green; activation gate is `lt-extract-scalars`. **tracked-by: `docs/plan/apigen-logical-types` → state `lt-extract-scalars`.**

### BUG-APIGEN-006 — `apigen-nx` generator package is built with the vite bundler; its `__files__` templates don't ship → published generator is non-functional
**Discovered:** 2026-06-23, during the apigen v2 npm publish (held back from publishing because of this).
**Symptom:** `@adhd/apigen-nx`'s `build` target uses `@nx/vite:build`, which **bundles** the generator into `index.js`/`index.mjs` and drops the on-disk file tree. The generator at runtime does `generateFiles(tree, path.join(__dirname, '__files__'), ...)` — i.e. it reads its EJS templates (`packages/apigen/nx/src/generators/plugin/__files__/**/*__tmpl__`) from disk. Those templates are **not** emitted to `dist` (build `assets` is only `["*.md"]`, and vite bundling doesn't preserve `src/generators/.../__files__`). A consumer who installs `@adhd/apigen-nx` and runs the `plugin` generator would get no templates → the generator cannot scaffold anything.
**Root cause:** wrong build executor for an nx generator/plugin package. Generator packages must preserve their directory structure + ship their template assets; they should be built with `@nx/js:tsc` (which keeps per-file output and honors `assets`), not `@nx/vite:build` (a bundler). Compounded by the missing `__files__` entry in build `assets`.
**Fix direction:** switch `packages/apigen/nx` `build` to `@nx/js:tsc`; add `assets` entries that copy `src/generators/**/__files__/**` and `src/generators/**/schema.json` to `dist` at the paths the compiled `generator.js` resolves via `__dirname`; verify by `npm pack`-ing the tarball and confirming the `__files__` templates + `generators.json`/`executors.json` are present, then dry-running the `plugin` generator from the packed artifact.
**Status:** OPEN — `apigen-nx` deliberately **NOT published** in the v2 `0.1.x` release until this is fixed (all 17 other packages shipped). Note: the v2 plugin-generator templates (`package.json__tmpl__` main→dist, `tsconfig.lib.json__tmpl__` test-exclude, `vite.config.ts__tmpl__` copy-readme, `README.md__tmpl__`) are already corrected in source; this bug is specifically the `apigen-nx` package's own build/packaging.

---

## apigen-logical-types — lt-code-review findings (2026-06-25)

The following non-blocking issues were discovered during the `lt-code-review` gate review of the logical-types implementation. None blocks plan advancement.

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
- **Symptom:** `echoReadonlyArray(xs: readonly string[])` generates `xs.items: {}` (schema-less) instead of `{type:"string"}`; at runtime each element is wrapped in the `$apigen` envelope and mis-encoded — `["a","b"]` → `[{"$apigen":"int64","v":"a"},{"$apigen":"int64","v":"b"}]`. A plain `number[]` correctly yields `items:{type:"number"}`.
- **Root cause (unverified):** the ts-json-schema extraction does not resolve the element type for the `readonly`-modified array type (ts-morph emits `readonly string[]`/`ReadonlyArray<string>` differently); the item schema falls through to `{}`, then the schema-less envelope path runs and defaults to the int64 codec.
- **Fix:** normalize `readonly T[]` / `ReadonlyArray<T>` to `T[]` before item-type resolution in `packages/apigen/core/src/lib/schema-builders/ts-json-schema.ts`; add an extraction test asserting `items:{type:"string"}`, plus a live round-trip test asserting `["a","b"]` survives unchanged.
- **Process note:** also a TEST-QUALITY bug in the demo — substring assertions (`grep -qF "a"`) are proxy evidence; tightened to exact-output matching so a wrong shape FAILs.

## DEBT-APIGEN-LINT-001 — `enforce-module-boundaries` crashes + flags static `@adhd/apigen-runtime` import in api-fastify/api-express run.ts — RESOLVED 2026-06-26
- **RESOLVED + orchestrator-VERIFIED (2026-06-26):** the "static import of lazy-loaded library" errors were fixed by converting the dynamic `import('@adhd/...')` in the offending spec files (api-fastify/api-express/mcp/logger/cli specs) to STATIC top-of-file imports, so the libs are no longer classified lazy-loaded — the legit `run.ts` static imports stay. The autofix ENOENT is gone (the 5 stub `index.ts` from LINT-002 now exist). **Verified:** `nx run-many -t lint` over all 21 apigen projects → **EXIT=0, 0 errors**; full apigen `nx run-many -t test` (19 projects) → **EXIT=0** (no behavior regression). Masking audit: zero severity downgrades, zero illegitimate `eslint-disable` (the only 4 added are on genuinely-lazy path-resolved `require()` in `ts-json-schema.ts`, with the disable directive corrected to the rule that actually fires).
- **Discovered:** 2026-06-25, while linting after the BUG-APIGEN-009/010 fix (pre-existing — reproduces identically on `git show HEAD:.../api-fastify/src/lib/run.ts`).
- **Symptom:** `nx lint apigen-plugin-api-fastify` (and api-express) errors: "Static imports of lazy-loaded libraries are forbidden — `apigen-runtime` is lazy-loaded in `stream.spec.ts`". The rule's autofix path additionally throws `ENOENT … packages/ai/agent-compiler/src/index.ts` (a separate missing-file issue in the workspace graph), aborting the lint task.
- **Root cause:** `api-fastify/src/test/stream.spec.ts` (and similar) dynamically `import('@adhd/apigen-runtime')`, so the `@nx/enforce-module-boundaries` rule treats every *static* import of that lib in the same project as forbidden — but `run.ts` legitimately needs the static import (`dispatch`/`createInvoker`/`makeValidateLayer`/…). Not introduced by the BUG-009/010 change; the static import predates it.
- **Fix direction:** either make the lazy import in the spec a static import (so the lib is no longer classified lazy-loaded), or scope/disable the rule for these plugin projects; separately, repair the missing `packages/ai/agent-compiler/src/index.ts` graph entry that makes the autofix throw ENOENT.

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

### BUG-PYFLASK-003 — extractor extracted imported classes (Decimal, datetime) as constructor ops
**Discovered:** 2026-06-25, via live CLI run `node dist/.../apigen/cli/index.js run --type py-flask --source /tmp/x.py`.
**Symptom:** `from decimal import Decimal; from datetime import datetime` in user module → `/t/Decimal` and `/t/datetime` appeared as `POST` routes (kind=constructor) alongside the user's functions.
**Root cause:** `extract_module` iterated `dir(mod)` (all non-`_` names) and the `isinstance(value, type)` branch in the extractor treated imported classes as constructor operations. No filter on `obj.__module__` to exclude imports.
**Fix landed 2026-06-25:** added `__module__` filter in `extract_module` — when `__all__` is absent, skip any name whose `__module__` differs from the loaded module's `__name__`. Tests: `extractor.pollution.decimal`, `extractor.pollution.datetime`, `extractor.pollution.only_user_fns` (run_tests.py §G).
**Status:** FIXED.

### DEFER-PYGRPC-001 — gRPC-Web support (sonora/grpclib) not included in py-grpc target
**Discovered:** 2026-06-25, while implementing the py-grpc apigen target.
**Detail:** gRPC-Web requires an HTTP/1.1-to-gRPC proxy or a pure-Python gRPC-Web server (e.g. `sonora`). `grpcio` alone serves native gRPC (HTTP/2); browser clients need gRPC-Web. The pure-Python option `sonora` exists (pip installable) but adds a non-trivial ASGI/WSGI dependency and was not verified in this env.
**When to address:** when browser-side gRPC-Web consumers are required. At that point: (a) verify `pip install sonora`; (b) add a `grpc_web` optional group to pyproject.toml; (c) wrap the server in a `sonora.asgi.grpcASGI` + uvicorn layer alongside the grpcio server, or use an Envoy sidecar.
**Status:** DEFERRED.

### DEFER-PYGRPC-002 — serve.ts gRPC host not wired (HTTP/2 front for the gateway)
**Discovered:** 2026-06-25, during py-grpc implementation.
**Detail:** `serve.ts` has a documented seam for a per-host `transport` tag and an HTTP/2 front. The standalone `--type py-grpc` target works and is fully verified. Wiring it into `serve.ts` requires: (a) an HTTP/2 server in Node (e.g. `@grpc/grpc-js` or an HTTP/2 proxy); (b) routing `/<namespace>.<Service>/<method>` to the Python subprocess; (c) forwarding gRPC metadata (x-adhd-*) to envelope. The architecture is clear from the py-grpc server design; execution is blocked on serve.ts HTTP/2 infrastructure.
**Fix (RESOLVED 2026-06-26):**
- `createFrontServer()` now uses a raw `net.Server` TCP mux that peeks the first 3 bytes (`PRI`) of each connection to distinguish h2c (gRPC) from HTTP/1.1. `socket.once('readable') + socket.read(3) + socket.unshift()` (paused-mode) correctly replays bytes to both parsers.
- Pure `http2.createServer()` (no `allowHTTP1`) handles gRPC streams; a separate `http.createServer()` handles HTTP/1.1. The `httpServer` is monkey-patched to delegate `listen/close/address` to the raw TCP server.
- `proxyGrpcStream()` proxies h2c streams to the gRPC backend via a cached `http2.connect()` session (`getGrpcSession()`). Key fixes: `waitForTrailers: true` in `stream.respond()` and `wantTrailers` event for `sendTrailers()`; `flags & 0x1` (END_STREAM in HEADERS) detection for zero-body gRPC error responses (UNIMPLEMENTED); `te: trailers` explicitly set in forwarded headers (grpcio strictly requires this header — strips it from HOP_BY_HOP caused RST_STREAM code=2 from Python gRPC backend).
- `sendGrpcUnavailable()` sends gRPC status 14 (UNAVAILABLE) for dead hosts, correctly using `waitForTrailers`.
- gRPC reflection (`/grpc.reflection.*`) routing to first alive gRPC host for grpcurl compatibility.
- `spawnGrpcHost()` reads `{"ready":true}` from stdout; `waitForGrpcReady()` polls TCP connect.
- Test: `spawnSync` replaced with async `spawn` wrapper in `serve.spec.ts` to avoid blocking the in-process h2 server's event loop.
- All 16 `serve.spec.ts` live tests pass; all 107 apigen-cli tests pass; 124/124 Python tests pass.
- **VERIFIED state-side by orchestrator (2026-06-26):** `te'] = 'trailers'` present at `serve.ts:720`; `APIGEN_LIVE=1 npx vitest run src/test/serve.spec.ts` → **16/16 EXIT=0** (drove the real cross-language h2c/HTTP1 front + grpcurl 1.9.3 + grpcio); Python `run_tests.py` → **124/124 EXIT=0** (real Flask + gRPC servers). Confirmed by use, not from the agent's report.
**Status:** FIXED.

### BUG-PYFLASK-004 — Decimal/datetime params not decoded from wire; integer accepted for decimal param
**Discovered:** 2026-06-25, via live CLI run. `add_decimal(amount: Decimal)` received a raw `str` from the wire (not decoded to `Decimal`) → `str + Decimal` → TypeError 500. Integer `999` for a decimal param returned HTTP 200 instead of 400.
**Root cause (three layers):**
1. `_py_type_hint_to_schema(Decimal)` and `_py_type_hint_to_schema(datetime)` returned `{}` (the open-schema fallback) — no `type` or `format` annotation. `_decode_params` calls `apigen_logical.decode(val, {})` → passthrough (no format → no decode). Amount arrived as `str`.
2. Empty schema `{}` passes validation for any value including integers → `amount=999` was accepted.
3. `Runtime._validate_input` re-validated decoded data (native `Decimal`) against the wire schema (`{type:string,format:decimal}`) → `Decimal` is not a `str` → HTTP 400 on valid input.
**Fix landed 2026-06-25:**
- `extractor._py_type_hint_to_schema`: added explicit mappings `Decimal → {type:string,format:decimal}`, `datetime → {type:string,format:date-time}`, `UUID → {type:string,format:uuid}`.
- `runtime.HostRequest`: added `pre_validated: bool = False` field.
- `runtime.Runtime._validate_input_if_needed`: skips re-validation when `req.pre_validated=True`.
- `flask_server._dispatch`: passes `pre_validated=True` to `HostRequest` (wire is validated before decode; runtime must not re-validate decoded values).
**Tests:** `extractor.schema.decimal_param`, `extractor.schema.datetime_param`, `cli_decimal.decimal.decode`, `cli_decimal.decimal.rejects_int`, `flask.validation.400` (run_tests.py §G and §H).
**Status:** FIXED.

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
- **apigen-schema:** `nx test apigen-schema` fails ("No test files found") — stub package with a `test` target but zero tests. Add a real, default-running test that exercises the package (per the live-testing rule, `passWithNoTests` is NOT acceptable). **Status: OPEN.**
- **Live-gating — PARTIALLY fixed (Python ✓ / TS serve ✗):**
  - **Python side (FIXED + orchestrator-VERIFIED 2026-06-26):** all `APIGEN_PYFLASK_LIVE`/`APIGEN_PYGRPC_LIVE` `skipIf` guards removed from `run_tests.py`; **124/124 run unconditionally, EXIT=0** (driven by orchestrator). *Doc-debt:* three stale comments remain (`run_tests.py:904,1318,1788` still say "gated behind APIGEN_PYFLASK_LIVE=1") — the gates are gone; the comments mislead. Clean them.
  - **TS serve side (FIXED + orchestrator-VERIFIED 2026-06-26):** the `APIGEN_LIVE` gate was an explicit CLAUDE.md violation (a local server / built artifact is not a third-party paid service). **Removed** `describe.skipIf(!process.env['APIGEN_LIVE'])` → plain `describe` at `serve.spec.ts:143`; added `dependsOn:["build"]` to the apigen-cli `test` target so the bundle is always present; rewrote the suite header to document run-by-default + the hard-fail-on-missing-`python3` / graceful-skip-only-for-optional-`grpcurl` policy. **Verified:** default `npx nx test apigen-cli` → **EXIT=0, 107 passed (107), 0 skipped** (was 105 passed | 2 skipped). The real cross-language serve front now runs on every test invocation. CLAUDE.md "Live testing is mandatory" was also rewritten to be progressive/teachable (principle → default → the one paid-3rd-party exception → the rationalization trap → hard-prereq-fails-loud vs optional-binary-self-skips).
  - **Doc-debt remaining:** the 3 stale "gated behind…" comments in `run_tests.py:904,1318,1788` (gates already gone) — cosmetic cleanup, still OPEN.

## DEBT-APIGEN-LINT-002 — broader workspace lint debt (surfaced fixing LINT-001) — RESOLVED 2026-06-26
- **RESOLVED + orchestrator-VERIFIED (2026-06-26).** Full `nx run-many -t lint` over all 21 apigen projects → **EXIT=0, 0 errors**; `nx run-many -t test` (19 projects) → **EXIT=0**. Breakdown:
  - **Stub `src/index.ts`** for the 5 unscaffolded packages confirmed present (resolves the autofix ENOENT). *Still true:* replace stubs with real exports when the agent-* plans execute (stubs are comment-marked) — tracked, not blocking.
  - **`vite.config.ts` boundary violation — fixed repo-wide:** every affected apigen project's `.eslintrc.json` now carries the same `ignorePatterns: [..., "vite.config.{js,ts,mjs,mts}"]` template as api-fastify (14 configs). No rule weakened.
  - **Pre-existing `nx lint` errors fixed by real code changes** (not suppressed): missing `package.json` deps added with correct version specifiers (`@adhd/apigen-errors`/`-logical` across runtime/core/cli/cli-output/mcp); `no-nested-ternary`, `no-useless-escape`, `no-loss-of-precision` (→ `Number('…')`, value-preserving, test negative-controls only), `prefer-const`, `require-yield`, `no-extra-semi`, `no-empty-interface`, `no-inner-declarations` each refactored surgically; the only `eslint-disable` additions are 4 legit lazy `require()` sites in `ts-json-schema.ts`.
- **Residual (non-gating):** warnings remain across several projects (`0 errors, N warnings`) — pre-existing, not part of this debt; a separate optional warning-cleanup pass if desired. The 3 stale "gated behind…" comments in `run_tests.py` (BUG-014) are still open cosmetic cleanup.

## DEBT-WORKSPACE-ARTIFACTS-001 — centralize ephemeral artifacts; move agent-mcp DB default out of repo root
**Done now (2026-06-26):** robust `.gitignore` for runtime/test artifacts (`/data/`, `*.db`/`*.sqlite` + `-wal`/`-shm`, `calc-server.*`); CLAUDE.md "Workspace Context" now codifies **one canonical ephemeral root `tmp/<package>/`**, no ad-hoc artifact dirs, tests must self-clean, persistent stores live in `~/.adhd/…` not the tree. Scratch strays removed.
**Still open (coordinated agent-mcp spec change):** `agent-mcp/src/db/client.ts:11` defaults `DATABASE_PATH` to `./data/agents.db`, so a bare run / drizzle migration from repo cwd materializes a repo-root `data/`. Move the default to a home/central path (`~/.adhd/agent-mcp/agents.db`) so the repo root stays clean even without `DATABASE_PATH`. This is coordinated: also update `drizzle.config.js` (`dbCredentials.url`), `.env.example`, and the SPEC/PLAN-MEMORY docs that pin `./data/agents.db`. Belongs to the in-flight agent-mcp/agent-registry initiative. Also: the one tracked `packages/ai/agent-mcp-budget/data/agents.db` is a runtime DB accidentally committed — untrack it (`git rm --cached`) when touching that package.

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

## DEBT-AGENTMCP-BUDGET-IMPORT-001 — `nx test agent-mcp` red: live-budget e2e can't resolve @adhd/agent-mcp-budget
`src/__tests__/integration/live-budget.e2e.test.ts` top-level-imports `@adhd/agent-mcp-budget`, which fails vite resolution ("Failed to resolve entry for package … incorrect main/module/exports"), failing the whole suite at COLLECTION time — before its `describe.skipIf(!AGENT_MCP_BUDGET_LIVE)` gate can skip it. So default `nx test agent-mcp` is RED (1 file failed / 211 passed). Pre-existing (orthogonal to the openai.ts apiKey fallback + secret redaction). Fix: correct `agent-mcp-budget` package.json `main`/`module`/`exports` (or build it) so the import resolves; consider a lazy/dynamic import so a live-gated suite never fails collection. Deferred agent-mcp/agent-registry initiative.
