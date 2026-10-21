# Top 10 highest-ROI bugs (adhd repo)

Run: dispatch-1014. Base commit: 9f71bd89. Source: `adhd-backlog query` (open `kind:bug`, 1134 open; 300 read, HIGH/CRITICAL screened = 47) plus code verification in this worktree.

ROI = severity (user-visible/shipped) x blast radius (dependents) / effort. Dependents = count of other `package.json` files that name the package (rg, self excluded; approximate, not a gx graph query).

## Dropped after verification (do not dispatch)

| uid | reason |
|---|---|
| 9b46c50f CI publish refused | `.github/workflows/pull-request.yml:200-207` now writes and satisfies the manifest; item is also in_progress |
| a66aca5d ir-cache key omits options | `ir-cache-layer.ts:281-293` `callIdentity` hashes the whole `extractorOptions` bag (dropFileSegment, tsconfig); fixed |
| e4d0ad86 decode strips unknown keys | `runmode.ts:237` now passes undeclared keys through; fixed |
| 0db2c26e backlog --help placebo | `entrypoint/backlog/src/install.ts:334` and `install-skill-usage.e2e.ts:53` cover --help; real schema help prints; fixed |
| ba753770 mergeItems drops provenance | `mergeItems` no longer exists in `entrypoint/backlog/src` or `packages` (v1 API gone) |
| 1a379374 path-escape EPIC, 7cec72b6 red gate, fe5efe0d sox-graph-store | belong to sox-ecosystem / memory repos, not adhd |
| c48ecbaf apigen build targets 500 off-root | could not reproduce from project.json inspection; needs-triage, below the cut |

Runner-up (not in top 10): 6b5a9f60 bare `JSON.parse` on DB columns, still real at `agent-store-runtime/src/store/task-store.ts:130,132,214` and `session-store.ts:198,221,658,659`; M, ready; blast radius 1 package.

## Ranking

### 1. 1bb4b5d5 - run-mode `dispatch()` cannot resolve any JSON-Schema `$ref`
- ROI: severity HIGH (any mounted tool whose types are named, e.g. backlog `createItem`, throws at call time) x `apigen-engine-runtime` 10 dependents / `apigen-core-client` 24 dependents / effort M = highest.
- Evidence: `packages/apigen/apigen-base-logical/src/lib/runmode.ts:42-45` (`resolve` is a permanent throwing stub); `runmode.ts:80-82` (`encodeNode` calls `ctx.resolve(ref)`); `packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:15,86,101` (module-level frozen `_transcoder`, no resolver passed).
- ACs:
  - AC1 Dispatching an op whose input/output schema contains `{"$ref":"#/definitions/X"}` with `definitions` on the schema root returns the decoded value; no `cannot be resolved in run-mode` error.
  - AC2 Same for `$defs` roots and for a recursive (self-referential) type.
  - AC3 A `$ref` to a missing definition fails with an error naming the ref and the op id.
  - AC4 Red test in `apigen-engine-runtime` fails on current main and passes after.
- Write scope: `packages/apigen/apigen-base-logical/src/lib/runmode.ts`, `packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts`, their specs.
- Size: M. DoR: ready (root cause named in backlog body and confirmed at the lines above).

### 2. 03be9e42 - safe-op to GET heuristic routes state-mutating operations as GET
- ROI: severity HIGH (non-idempotent writes reachable by prefetch/crawler/cache/retry) x every apigen HTTP host (`apigen-plugin-api-fastify`, `-express`, openapi, naming) / effort M.
- Evidence: `packages/apigen/apigen-core-client/src/lib/compose-schemas.ts:230-231` (`safe = fnSchema.safe === true || isPrimitiveOnlyInputSchema(fnSchema.input)`); `packages/apigen/apigen-core-client/src/lib/get-safety.ts:1-20` (param-shape-only criterion); comment at `compose-schemas.ts:221-225` admits `kind:'action'` is always `safe:false` yet is hoisted anyway.
- ACs:
  - AC1 An op with `kind:'action'` and all-scalar params is routed POST on fastify, express, and openapi output.
  - AC2 An op explicitly marked safe (`x-apigen-safe`/annotation) with scalar params is still routed GET.
  - AC3 The existing manual `--opt http.verb.<id>=GET` override still wins.
  - AC4 Conformance vectors (`apigen-engine-conformance`) updated and green for the TS and Python hosts.
- Write scope: `packages/apigen/apigen-core-client/src/lib/{compose-schemas,get-safety}.ts`, `packages/apigen/apigen-engine-naming/src`, conformance vectors, specs.
- Size: M. DoR: needs-spec. Missing ingredient: a contract decision on the safety signal (explicit annotation vs naming convention vs read-kind inference) and the breaking-change policy for consumers currently relying on auto-GET (FEAT-APIGEN-022). Route to architect.

### 3. 8a62ced2 - streaming op with a non-empty output schema returns `{}` instead of SSE
- ROI: severity HIGH (silent, wrong payload, no error) x fastify host (3 dependents) plus all hosts sharing `dispatch` / effort S.
- Evidence: `packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:96-101` (`encodeResult` only bypasses on an EMPTY output schema; otherwise `_transcoder.encode(asyncGenerator, outputSchema)` runs on the stream object); `packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:279` (SSE branch only fires if the result is still an `ApiStream`). This matches the reporter's field isolation (non-empty `output` alone breaks it).
- ACs:
  - AC1 A streaming op with a declared non-empty chunk output schema delivers incremental SSE frames through the fastify host (>=2 frames observed before stream end).
  - AC2 `encodeResult` returns an `ApiStream` result unchanged (`isApiStream` bypass).
  - AC3 Each emitted chunk is encoded against the chunk schema (a Date chunk arrives as RFC 3339).
  - AC4 Red test fails on main.
- Write scope: `packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts`, `packages/apigen/apigen-plugin-api-fastify/src/lib/{run,stream}.ts`, specs.
- Size: S. DoR: ready (cause read from code; the red test is the confirmation step).

### 4. 969e36f4 - `apigen generate --type mcp` emits invalid TypeScript for hyphenated namespaces
- ROI: severity HIGH (generate exits 0, output unparsable; hyphenated ids are the repo norm) x 3 dependents / effort S.
- Evidence: `packages/apigen/apigen-plugin-mcp/src/lib/generate.ts:34,36,83` splice raw `pkg.id` into identifiers (`import * as ${pkg.id}_ns`).
- ACs:
  - AC1 `generate --type mcp --source packages/data/data-base-transforms/src/lib/text.ts` produces an `index.ts` that parses (esbuild/tsx exit 0).
  - AC2 Identifiers derived from `pkg.id` are sanitized; the string-keyed map entry at line 83 keeps the original id.
  - AC3 Two ids that sanitize to the same identifier produce a disambiguated name, not a duplicate-declaration error.
  - AC4 Red test (hyphenated id) fails on main.
- Write scope: `packages/apigen/apigen-plugin-mcp/src/lib/generate.ts`, its spec; reuse the sanitizer from the BUG-APIGEN-032 fix in express/fastify if one exists.
- Size: S. DoR: ready.

### 5. 087ec253 - batch request coerces null/undefined items to `{}`
- ROI: severity HIGH (silent no-arg invocation of a possibly destructive op after an upstream serialization bug) x batch is portable across all hosts (3 dependents) / effort S.
- Evidence: `packages/apigen/apigen-plugin-batch/src/lib/plugin.ts:197` (`domainArgs: (item ?? {})`); `parseBatchRequest` checks only `Array.isArray(items)`.
- ACs:
  - AC1 A batch with a `null` or `undefined` item is rejected with an `ApiError` naming the item index; no operation is invoked.
  - AC2 No `?? {}` remains on the item path.
  - AC3 A batch of valid items is unchanged (existing spec green).
- Write scope: `packages/apigen/apigen-plugin-batch/src/lib/plugin.ts`, `plugin.spec.ts`.
- Size: S. DoR: ready.

### 6. f67c2645 - gateway `start()` partial failure orphans running adapters
- ROI: severity HIGH (leaked child processes and supervision timers, caller holds no handle) x 1 dependent but long-running host / effort S.
- Evidence: `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:586-588` (`await Promise.all(... bringUp(entry))` with no cleanup on rejection).
- ACs:
  - AC1 When one host's `bringUp` rejects, `start()` stops every already-started host before rethrowing the original error.
  - AC2 After the rejected start no adapter process is live and no supervision timer is scheduled.
  - AC3 `gateway.spec.ts` test "start() stops already-started adapters when one host fails to come up" fails on main.
- Write scope: `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts`, `gateway.spec.ts`.
- Size: S. DoR: ready (ACs already written on the backlog item).

### 7. 0b80a7b5 - dispatch `dag.json` written with a fixed temp name and no lock
- ROI: severity HIGH (irrecoverable loss of observed guard output, token counts, dispatch log under concurrent cycles; ADR-0012 makes concurrent processes a supported mode) x 2 dependents (`dispatch-orchestrator`, `dispatch-cli`) / effort M.
- Evidence: `packages/dispatch/dispatch-serializer-json/src/index.ts:32,38` (`.${filename}.tmp` fixed name, `renameSync`, no mutual exclusion).
- ACs:
  - AC1 Two concurrent `write` calls to the same dag path never lose either caller's `dispatch_log` entries (latch/barrier test, no sleeps).
  - AC2 Temp file names are unique per writer; no leftover `.tmp` after success or failure.
  - AC3 A reader never observes a partial file.
- Write scope: `packages/dispatch/dispatch-serializer-json/src/index.ts`, its spec; possibly `dispatch-orchestrator` call sites if read-modify-write needs a lock held across the cycle.
- Size: M. DoR: needs-spec. Missing ingredient: whether the fix is unique temp + last-writer-wins (insufficient for the lost-update case) or a lock/merge around read-modify-write; decide the concurrency contract first.

### 8. ccd12999 - python-env `run-extractor` spawn has no timeout
- ROI: severity HIGH (hung extractor stalls CI/serve forever, no output) x python-env used by py-flask and py-grpc hosts / effort S.
- Evidence: `packages/apigen/python-env/src/lib/run-extractor.ts:22,50` (`spawn(` with no timeout/kill/abort; rg for `timeout|kill` in the file finds none).
- ACs:
  - AC1 The extractor spawn has a configurable timeout (documented default); on expiry the child is killed and the promise rejects with an error naming the command.
  - AC2 After rejection the child pid is no longer live.
  - AC3 `run-extractor.spec.ts` sleep-fixture test hangs/fails on main and passes after.
- Write scope: `packages/apigen/python-env/src/lib/run-extractor.ts`, spec, README option note.
- Size: S. DoR: ready.

### 9. ab545ef8 - Javalin dispatcher template interpolates parameter names unescaped
- ROI: severity HIGH (generated Java does not compile; fails only at mvn time with no op attribution) x 1 plugin, third host / effort S.
- Evidence: `packages/apigen/apigen-plugin-java-javalin/src/lib/dispatcher-template.ts:252-253` (`body.get("${p.name}")`, `__p_${p.name}`); no identifier validation found in the plugin `src/lib`.
- ACs:
  - AC1 A parameter name outside the Java identifier grammar fails `generate` with an error containing the operation id.
  - AC2 Names containing `"` or `\` cannot break out of the JSON-key string literal.
  - AC3 `GeneratedDispatcher.java` compiles for every operation in the conformance corpus (`runJavaMatrix`).
- Write scope: `packages/apigen/apigen-plugin-java-javalin/src/lib/dispatcher-template.ts`, `dispatcher-template.spec.ts`.
- Size: S. DoR: ready.

### 10. 273dd29b - budget plugin cap boundary asymmetric; truncation notice exceeds the limit
- ROI: severity HIGH-MEDIUM (agent responses exceed the cap that triggered truncation; cap type changes semantics at exactly `limit`) x 2 dependents (agent-mcp host path) / effort S.
- Evidence: `packages/agent/agent-plugin-budget/src/index.ts:1856` (`current >= limit`) vs `:1938` (`totalChars <= limit` skip).
- ACs:
  - AC1 `evaluateCap` and `enforceResponseSize` treat `current == limit` identically.
  - AC2 For every input, final serialized response length including the notice is <= limit.
  - AC3 `enforcement-plugin.test.ts` test described on the item fails on main.
- Write scope: `packages/agent/agent-plugin-budget/src/index.ts`, `enforcement-plugin.test.ts`.
- Size: S. DoR: ready (semantics choice for the boundary is small; item states both ACs).

## Summary
- 10 entries: 8 ready, 2 needs-spec (#2 safety-signal contract, #7 concurrency contract), 0 needs-triage.
- All 10 are filed in the backlog (uids above); none unfiled.
- Suggested dispatch order for parallel work (disjoint write scopes): #1+#3 share `dispatch.ts`, so serialize them; #4, #5, #6, #8, #9, #10 are disjoint and parallel-safe.
