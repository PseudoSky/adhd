# Policy-core remediation plan

**Owner:** pseudosky. **Branch:** `feat/policy-remediation` (worktree `.worktrees/policy-remediation`).
**Inputs:** `TAXONOMY-CONFORMING-DESIGNS.md` (segments S1–S10, decisions BA-1…BA-11, E1…E8), `SOURCE-MODEL-GAP-ANALYSIS.md` (steps 0–12, decisions O-1…O-14, findings F-1…F-11), `APIGEN-CONFORMANCE-REVIEW.md` §5 (top-10 remediations), `REVIEW-FIXES.md`, `INTERFACES.md`, `DOD.md`, `tickets/T18.md`, `docs/decisions/0003-*.md`, `docs/decisions/0004-*.md`, `docs/apigen/SPEC.md`.
**Accepted ADRs (`docs/decisions/`):**
- [adhd ADR-0017](../../decisions/0017-apigen-source-model.md): vocabulary, the transport/extractors/runtime/targets layout, `Operation.binding`, IR generation centralized in apigen-core-client.
- [adhd ADR-0018](../../decisions/0018-mcp-adapter-string-results-iserror-metadata.md): raw-text string results, the `isError` mapping for every `ApiError`, tool metadata (amends adhd ADR-0004).
- [adhd ADR-0019](../../decisions/0019-layer-create-layer-operation-tool-cancellation.md): `createLayer`, `Operation.binding` / `Operation.tool`, cancellation and the dispatch terminal. The normative text is in `docs/apigen/SPEC.md` §4, §7.1, §8.1.

`SOURCE-MODEL-GAP-ANALYSIS.md` is cited by section, not line (last commit `4f743bc6`).

---

## 0. Scope

### 0.1 In the slice

- The policy path: TAXONOMY segments S1–S10 remediated as segments R1–R14 below.
- TS-only apigen foundations: `LayerCapability.createLayer` (E4), `Operation.binding` (O-1), `Operation.tool` (E3), the shared source resolver (O-2), IR generation centralized in apigen-core-client (the orchestration entry, whose result carries the IR and the files each extractor read; G-2), `apigen-plugin-ir-cache` reduced to keying, storing and validating, the binding-aware dispatch terminal for flat arguments (D1, first slice), cancellation threading, `buildApigenPackage`, dispatch `$ref` resolution.
- The TS subprocess extractor and its measurement (O-10, SPEC §14).
- The MCP adapter changes BA-2 / BA-3 / BA-4, general for every apigen MCP service, and the audit of `content[0].text` readers (G-5).
- `adhd-policy serve bin:<executable>` through `serveMcpPassthrough` as the degenerate proxy target, tool names projected through the standard BA-1 projection.
- D-24 telemetry for the policy CLI: retention 14 days and 100 MB per file.
- CommonJS-only re-emit of the three policy packages and the generator fix (X1).

### 0.2 Out of the slice (owner decision; not reopened)

Python, Java, Rust and Go extractors and hosts; remote sources; `bin:` in adhd-apigen; per-source option grammar (O-3); binding adapters for py/java; generate-vs-live parity (O-11); the sandbox; E2 (not adopted); `entrypoint/backlog` edits (separate gated segment R13).

### 0.3 Packages approved for edits

| Package | Path |
| --- | --- |
| apigen-core-client | `packages/apigen/apigen-core-client` |
| apigen-cli | `entrypoint/apigen-cli` |
| apigen-engine-runtime | `packages/apigen/apigen-engine-runtime` |
| apigen-plugin-mcp | `packages/apigen/apigen-plugin-mcp` |
| workspace-codegen-nx | `packages/workspace/workspace-codegen-nx` |
| policy-core-client | `packages/policy/policy-core-client` |
| policy (entrypoint) | `entrypoint/policy` |
| apigen-plugin-policy | `packages/apigen/apigen-plugin-policy` |
| apigen-engine-gateway, `src/lib/sources` | `packages/apigen/apigen-engine-gateway/src/lib/sources` |
| apigen-engine-gateway, the routing line only (G-1) | `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts` (~590-591) |
| apigen-plugin-ir-cache (G-2) | `packages/apigen/apigen-plugin-ir-cache` |
| `content[0].text` readers (G-5), each audited first and edited only where a raw string breaks it | `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`, `packages/agent/agent-plugin-budget`, `entrypoint/agent-mcp`, `entrypoint/backlog` e2e suites |

No new packages. Edits the slice needs outside this list are listed in §9 (open owner items) and are never started without approval: `apigen-base-logical` (only if the `$ref` fix cannot stay in the runtime), `@adhd/sox-telemetry` (only if its file-mode, disable or retention knobs are missing), `entrypoint/backlog` beyond the G-5 reader audit (R13).

---

## 1. Execution rules

1. **Implementer.** Every source and test edit is made by the `performance` agent and no other agent. Each dispatch names its segment, its files, and its read-only context ranges from §3, and nothing else.
2. **Phases.**
   - **Phase A, source:** every segment's source edits, in the wave order of §6. Phase A changes no test file except where a segment says a test must be re-pointed to compile (typecheck-spec).
   - **Phase B, review:** after each package's Phase A segments complete, one large code review of that package's diff. Then a **blind review**: the reviewer receives the diff and the single word `Review`, and nothing else (no context, no rationale, no prior state). Findings are fixed by the `performance` agent before Phase C.
   - **Phase C, tests:** the test segments T-R1…T-R12 in §7, written last.
3. **Lane.** Unit lane only: no subprocess and no `*.e2e.*` file is added or run by this plan. Every behavioural test drives the consumer seam in-process: an in-process `cliPlugin.run` / `mcpPlugin.run`, an in-memory MCP transport or stream pair, the fake process launcher (`entrypoint/policy/src/test/helpers/fake-launcher.ts`), and the stub MCP upstream (`…/helpers/stub-mcp-upstream.ts`). The TS subprocess extractor (R8) is proven in the unit lane through an injected launcher; its real-spawn proof and the measurement script are run on demand, outside the gates.
4. **Teeth.** Every behavioural test carries a negative control: revert the fix, or run a deliberately wrong variant, and record that the test goes red. The control is recorded in the segment's evidence table, in the style of `REVIEW-FIXES.md`.
5. **Assertions** name consumer-visible outcomes: exit codes, stdout/stderr text, MCP `tools/list` / `tools/call` payloads, policy decisions, files written. Never "function X was called".
6. **Scratch** under `tmp/policy/` (DOD) and `tmp/apigen/`, removed in teardown.
7. **Gates, per segment, after its last edit:**
   - `npx nx affected -t lint,typecheck,typecheck-spec`
   - `npx nx affected -t test`
   - `npx nx run <project>:verify-dist-load` for every changed publishable package
   A non-zero exit stops the segment. The segment's report carries a `Gates:` list with each command and exit code.
8. **Git.** Commit per segment by explicit pathspec (`git commit -- <paths>`); never `git add -A`, `git commit -a`, `git stash`, `git reset --hard`; no push; no AI attribution.

---

## 2. Segment overview

| Wave | Segment | Package(s) | Deliverable | Depends on | Size |
| --- | --- | --- | --- | --- | --- |
| 0 | R0 | docs | adhd ADR-0017/0018/0019 accepted and filed; SPEC §4, §7.1, §8.1, §13 carry the accepted text | — | done (docs) |
| 0 | R1 | apigen-core-client | Contracts: `LayerCapability.createLayer`, `Operation.binding`, `Operation.tool`, `MountedOperation.tool`, `descriptor.schema.json` (`binding`, `hasCtx`), one exported `buildId` | R0 | not estimated |
| 0 | R11a | workspace-codegen-nx | Generator emits CommonJS-only packages (ADR-0003) | — | not estimated |
| 1 | R2 | apigen-core-client | `resolveSourceReference` + types + detection order (O-2) | R1 (shared `index.ts`) | gap analysis step 1: ≈180 src + 200 test |
| 1 | R3 | apigen-engine-runtime | `createLayer` in `UsePlugin`/`createPackageInvoker`; signal to dispatch; ctx continuity in the mount branch; `buildApigenPackage`; dispatch `$ref` resolution | R1 | not estimated |
| 1 | R3a | apigen-engine-runtime | `coercibleType` resolves the non-null branch of `oneOf` / `anyOf` / a `type` array, so a query-string value for a nullable param is coerced (backlog 9429470e) | R3 (same package, serial after R3); parallel with D1 only if it leaves `src/index.ts` alone, otherwise after D1 | not estimated |
| 1 | D1 | apigen-engine-runtime | Binding-aware dispatch terminal for flat arguments: `Terminal`, `createInvoker(layers, { terminal })`, `createPackageInvoker(..., { terminal })`; built with `Operation.binding` (R1) and consumed by the orchestration entry's foreign extractors (R5, R7b) | R1, R3 (same files, serial after R3) | gap analysis: ≈150 src + 150 test |
| 2 | R4 | apigen-plugin-mcp | adhd ADR-0018 (BA-2, BA-3, BA-4 for every `ApiError` code); `extra.signal`; layer options; injectable stdio streams | R1, R3 | not estimated |
| 2 | R5 | apigen-cli + apigen-core-client | `--use` plugins materialise `createLayer` from the flat `--opt` bag; resolver adoption; IR generation entry promoted into core-client, whose result carries the IR and the files each extractor read | R2, R3, D1 | gap analysis steps 2+3: ≈80 src + 110 test; promotion not estimated |
| 2 | R5a | apigen-cli | The `--opt http.verb.<id>=GET` overrides parsed by `parseOverrides` reach the projection on `generate` and `run` (backlog 0bc4f3f6) | R5 (same file `orchestrator.ts`, serial after R5, before R8) | not estimated |
| 2 | R8p | apigen-plugin-ir-cache | The cache keys, stores and validates from the extraction result; `collectLocalImportPaths` leaves the cache path; no extractor option hides in a closure; tsconfig `extends` chain reported in `sourceFiles`; comment fixes (088745d2); residual regression tests | R5 (the result type; serial inside the wave) | not estimated |
| 2 | R6 | apigen-plugin-policy | E4: `makePolicyPlugin` default export with `optionsSchema`; `PolicyAttributes` ctx key; deletes `state.ts`, `load-decider.ts`, the mount capability | R1, R3 | not estimated |
| 2 | R7a | gateway `sources/` | `SourceError` → `ApiError`; ids via core `buildId`/`syntheticOp`; `host`/`binding` producers; node `ISourceProbe`; `resolveSource` keyed by translator; `operationsFromMcpTools` split | R1, R2, R3 | gap analysis step 5: ≈120 src + 120 test |
| 3 | R7b | gateway `sources/` + `gateway.ts` routing line | argv and MCP extractors registered with the entry (each reports its dependencies); `HostAdapter`s for argv and MCP stdio; D1 terminal wiring; the routing line reads `binding ?? host` (G-1); finite supervision; `serveMcpPassthrough` consumes IR | R5, R7a, D1 | not estimated |
| 3 | R8 | apigen-core-client + apigen-cli | TS extractor drivable as a subprocess (reports its files like the in-process extractor); `ExtractionSession.dispose()` before serve; measurement script under `tmp/` | R5, R8p | not estimated |
| 3 | R9 | entrypoint/policy | `gate.ts` on `makePolicyPlugin` + ctx attributes; `run` via `createPackageInvoker`/`dispatchForPlan` + tracing; `serve` via `createGateway` + `mcpPlugin.run` (`serve bin:` via `serveMcpPassthrough` as the degenerate proxy target); startup-failure contract; resolver; `buildApigenPackage`; delete `dereference.ts`; `failure.ts`; D-24 telemetry (14 days, 100 MB per file) | R3, D1, R4, R6, R7b | not estimated |
| 3 | R10 | policy-core-client + entrypoint/policy fixtures | BA-5: `/` ids in policy files and `draft` output; loader error naming the new id; migration command | R7a | not estimated |
| 4 | R12 | entrypoint/policy | IR baked through the apigen-plugin-ir-cache artifact target (S8): the artifact the cache stores, produced by the core-client entry; reader; parity proof; old bake deleted | R9, R11d, R8p | not estimated |
| 4 | R11b–d | plugin-policy, policy-core-client, entrypoint/policy | CommonJS-only re-emit (ADR-0003), one package each | R6 / R10 / R9 respectively; R11a | not estimated |
| — | R13 | entrypoint/backlog (**not approved**) | Move `buildBacklogApigenPackage` and `extract-live.ts` onto `buildApigenPackage` and the entry | owner (G-3); R3, R5 | not estimated |
| 3 | R15 | G-5 reader packages | Audit every `content[0].text` reader of a string-returning apigen tool; edit only those a raw string breaks | R4 | audit first; edits not estimated |
| B | RV-* | per package | Large code review, then blind review (§1 rule 2) | each package's Phase A | — |
| C | T-R1…T-R12, T-D1, T-R8p, T-R15 | per segment | Phase C tests (§7) | Phase B of the package | not estimated |
| 5 | R14 | docs | fce1647f: `docs/policy-reference.md`, `docs/attributes.md`; plugin/gateway READMEs; INTERFACES supersessions | Phase C | not estimated |
| 5 | T18 | docs + gates | Demo reconciliation to the `--input` CLI form; `DONE.md`; final gates | R14 | not estimated |

---

## 3. Segments

Each segment lists: files (verified paths), interface BEFORE/AFTER, behaviour changes, dependencies, read-only context for the implementer, risk, rollback, tests, size. "Rollback" is always a revert of the segment's own commit; the column says what else must revert with it.

### R0 — Accepted ADRs and SPEC text (docs)

- **Files:** `docs/decisions/0017-apigen-source-model.md`, `0018-mcp-adapter-string-results-iserror-metadata.md`, `0019-layer-create-layer-operation-tool-cancellation.md`, `docs/decisions/README.md`, `docs/decisions/0004-*.md` (amendment note); `docs/apigen/SPEC.md` §4 (`binding`, `tool`), §7.1 (`createLayer`), §8.1 (cancellation), §13 (the `Call` carries `operation.host` and `operation.binding`, finding F-7).
- **Behaviour change:** none (docs).
- **Fixes:** the field names (`binding`, `tool`, `_meta["adhd/error"]`) and every BA-4 row.
- **Risk:** low. **Rollback:** none needed.

### R1 — Core-client contracts (apigen-core-client)

- **Files:** `packages/apigen/apigen-core-client/src/lib/plugin.ts`, `src/lib/descriptor.ts`, `src/lib/descriptor.schema.json`, `src/lib/extract.ts`, `src/lib/extract-classes.ts`, `src/index.ts`.
- **Interface changes:**

  ```ts
  // BEFORE plugin.ts:305-330
  export interface LayerCapability {
    envelopeFields?: Record<string, JSONSchema>;
    layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>;
  }
  // AFTER
  export interface LayerCapability<Opts = Record<string, unknown>> {
    envelopeFields?: Record<string, JSONSchema>;
    layer?(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>;
    createLayer?(opts: Opts): (call: Call, next: Next) => Promise<Result> | AsyncIterable<Chunk>;
  }

  // BEFORE descriptor.ts:148-251 — Operation { id; host; …; hasCtx? }
  // AFTER  — adds:
  binding?: string;                                                     // O-1
  tool?: { title?: string; annotations?: Record<string, unknown> };    // E3

  // BEFORE plugin.ts:478-494 — MountedOperation (no tool metadata)
  // AFTER  — adds the same optional `tool`

  // BEFORE extract.ts:914 and extract-classes.ts:411 — two module-private copies of
  //        function buildId(ns: Segment, opPath: Segment[]): string
  // AFTER  — one exported buildId (extract.ts), imported by extract-classes.ts, re-exported from src/index.ts
  ```

  `descriptor.schema.json`: add `binding` `{type:string, minLength:1}`, `tool` `{type:object}`, and the missing `hasCtx` `{type:boolean}` (finding F-4, backlog c5cf9472).
- **Behaviour changes:** none at runtime. Type-level: a `LayerCapability` with neither `layer` nor `createLayer` must fail typecheck (a discriminated union or an overload; the implementer picks the form that rejects `{}`).
- **Dependencies:** R0 (names).
- **Read-only context:** `plugin.ts:40-199` (Extensions, Call), `:305-383` (Layer and ExtractLayer capabilities), `:478-594` (MountedOperation, syntheticOp), `:703-766` (Plugin); `descriptor.ts:148-252`; `extract.ts:900-930`; `extract-classes.ts:405-420`.
- **Risk:** medium. `LayerCapability.layer` becoming optional breaks every reader that calls `cap.layer(...)` unguarded. Readers found by rg must be updated in R3/R4/R9; before editing, run `gitnexus_impact` on `LayerCapability` and report the blast radius.
- **Rollback:** revert R1 with R3, R4, R6 (they consume the new types).
- **Tests:** T-R1.
- **Size:** not estimated.

### R2 — Shared source resolver (apigen-core-client)

- **Files:** `packages/apigen/apigen-core-client/src/lib/source-language.ts`, `src/index.ts`.
- **Interface (AFTER, additive; BEFORE `source-language.ts:27-67` unchanged):** `AssetKind`, `TranslatorId`, `SourceLocator`, `BindingSpec`, `ISourceResolution`, `SourceResolutionError`, `ISourceProbe`, `resolveSourceReference(reference, probe?)`, exactly as `SOURCE-MODEL-GAP-ANALYSIS.md` §3a and adhd ADR-0017 D4.
- **Behaviour changes:** new function. Detection order §5.5 with the PATH fallback last and unguarded (O-2); the `invalid-reference` message names every interpretation tried: scheme, URL, code extension, schema extension, existing path, PATH lookup. String-pure: no `node:path`/`node:fs` import added to this `platform:shared` package (finding F-6).
- **Dependencies:** R1 (shared `index.ts`).
- **Read-only context:** `source-language.ts:1-150`; `apigen-engine-gateway/src/lib/sources/parse-source.ts:11-42`; gap analysis §3a, §5.4, §5.5.
- **Risk:** low (additive). **Rollback:** revert R2 with R5, R7a.
- **Tests:** T-R2. **Size:** gap analysis estimate ≈180 src + 200 test.

### R3 — Runtime invoker (apigen-engine-runtime)

- **Files:** `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts`, `invoke.ts`, `dispatch.ts`, `dispatch-for-plan.ts`, `src/index.ts`; new module `src/lib/build-apigen-package.ts` (a module inside the approved package, not a package).
- **Interface changes:**

  ```ts
  // BEFORE package-invoker.ts:39-44
  layer?: { layer: (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown> };
  // AFTER
  layer?: {
    layer?: (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown>;
    createLayer?: (opts: Record<string, unknown>) =>
      (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown>;
  };

  // BEFORE package-invoker.ts:149
  export function createPackageInvoker(schemas: ComposedSchemas, usePlugins: UsePlugin[]): InvokeFn
  // AFTER — createLayer called once per plugin at composition time; it wins over layer
  export function createPackageInvoker(
    schemas: ComposedSchemas, usePlugins: UsePlugin[],
    options: { layerOptions?: Record<string, unknown> } = {}   // D1 adds `terminal?: Terminal`
  ): InvokeFn

  // BEFORE dispatch.ts:120-127 — dispatch(fns, createClient, schema, fnName, envelope, domainArgs)
  // AFTER  — dispatch(fns, createClient, schema, fnName, envelope, domainArgs, signal?)
  //          createClient(envelope, { signal }) on the ctx paths (dispatch.ts:137-155); positional args unchanged

  // NEW build-apigen-package.ts (TAXONOMY C2 signature)
  export function buildApigenPackage(input: {
    id: string; version: string; importPath: string;
    operations: Operation[]; fns: Record<string, (...a: unknown[]) => unknown>;
    createClient?: (envelope: Record<string, unknown>, o?: { signal?: AbortSignal }) => Promise<unknown>;
  }): { pkg: { id; version; importPath; schemas: ComposedSchemas; fns; createClient? }; operations: Operation[] };
  ```

- **Behaviour changes:**
  1. A `--use` plugin with `createLayer` receives the invocation's options; one with only `layer` is unchanged. `adaptCoreLayer` (`package-invoker.ts:133-141`) accepts either form.
  2. `call.signal` reaches `dispatch` and, through `createClient`, a `ctx`-taking function. An aborted signal before dispatch rejects with `ApiError('internal')` carrying "aborted" (wording pinned by T-R3).
  3. Mount branch (`dispatch-for-plan.ts:109-116`): the core call's `ctx` today is a fresh `createExtensions()`, separate from the `LayerContext` the Layers saw (`:93`). AFTER: the mount handler receives the same per-call map the Layers wrote, so a ctx key set by an outer Layer (R6's `PolicyAttributes`) is visible. If `Extensions` and `LayerContext` cannot be unified without a core-client type change, the unification lands in R1; the implementer reports which.
  4. `buildApigenPackage` composes schemas from IR with `$ref` resolved: `dispatch` supplies a definitions-backed `resolve()` to the transcoder instead of hitting the run-mode stub (`apigen-base-logical/src/lib/runmode.ts:40-46`: "cannot be resolved in run-mode without a descriptor root. Supply a resolve() in the ctx override"). Whether `_transcoder.decode`/`encode` (`dispatch.ts:13-15, 84-101`) accept that ctx override is UNVERIFIED; if they do not, the fix needs `apigen-base-logical`, which is not approved (§9 G-4).
- **Dependencies:** R1.
- **Read-only context:** `package-invoker.ts:1-162`; `invoke.ts:60-216`; `dispatch.ts:1-159`; `dispatch-for-plan.ts:1-128`; `apigen-base-logical/src/lib/runmode.ts:30-90`; `entrypoint/policy/src/wrapper/dereference.ts:1-68` (behaviour to preserve: unresolved or cyclic `$ref` throws naming the schema path); `entrypoint/policy/src/wrapper/package.ts:30-71` (the shape `buildApigenPackage` replaces); TAXONOMY §9 S3, S6.
- **Risk:** high — every apigen host composes through `createPackageInvoker` and `dispatch`. `gitnexus_impact` on `createPackageInvoker`, `createInvoker`, `dispatch`, `dispatchForPlan` before editing; report HIGH/CRITICAL to the owner before proceeding.
- **Rollback:** revert R3 with D1, R4, R5, R6, R7b, R9.
- **Tests:** T-R3. **Size:** not estimated.

### R3a — Nullable query-string coercion (apigen-engine-runtime)

Backlog 9429470e-4362-4c8b-9ce4-936e8aff0574.

- **Files:** `packages/apigen/apigen-engine-runtime/src/lib/coerce-query.ts`; `src/index.ts` only if the fix exports a new symbol.
- **Behaviour change:** `coercibleType` skips a schema of the form `oneOf: [{ type: 'null' }, T]` (and the `anyOf` and `type: ['null', T]` equivalents), so a query-string value for a nullable param stays a string. The non-null branch of `oneOf` / `anyOf` / a `type` array is resolved before coercing; a nullable integer or boolean param is coerced like its non-nullable form. Schemas without a null branch are unchanged.
- **Dependencies:** R3 (same package; serial after R3).
- **Risk:** low. **Rollback:** revert R3a alone.
- **Tests:** T-R3a. **Size:** not estimated.

### D1 — Binding-aware dispatch terminal for flat arguments (apigen-engine-runtime)

Part of the first slice; built with the orchestration entry (R5) and `Operation.binding` (R1). adhd ADR-0017 D7, adhd ADR-0019 D4.

- **Files:** `packages/apigen/apigen-engine-runtime/src/lib/invoke.ts`, `package-invoker.ts`, `src/index.ts`.
- **Interface changes:**

  ```ts
  // BEFORE invoke.ts:183
  export function createInvoker(layers: readonly Layer[] = []): InvokeFn
  // AFTER
  export type Terminal = (fnName: string, call: Call, opts: InvokeOptions) => Promise<LayerResult>;
  export function createInvoker(layers: readonly Layer[] = [], options: { terminal?: Terminal } = {}): InvokeFn

  // package-invoker.ts options (after R3): { layerOptions?: Record<string, unknown>; terminal?: Terminal }
  ```

- **Behaviour changes:** when a terminal is supplied, the innermost service is `terminal(call)` and `dispatch` is never called; the terminal receives the whole `Call` including `signal` and the flat argument object. A terminal routes by `operation.binding ?? operation.host`. Without a terminal the existing `dispatch` path is unchanged.
- **Dependencies:** R1, R3 (shared files; serial after R3).
- **Read-only context:** `invoke.ts:60-216`; `package-invoker.ts:1-162`; `dispatch.ts:120-159`; `entrypoint/policy/src/wrapper/verbs/run.ts:53-72` (the hand-built terminal this replaces).
- **Risk:** high (every apigen host composes through `createInvoker`); `gitnexus_impact` on `createInvoker` before editing. **Rollback:** revert D1 with R5, R7b, R9.
- **Tests:** T-D1. **Size:** ≈150 src + 150 test.

### R4 — MCP adapter (apigen-plugin-mcp)

- **Files:** `packages/apigen/apigen-plugin-mcp/src/lib/run.ts` only. One segment, one implementer, because every change below edits this file.
- **Interface changes:**

  ```ts
  // BEFORE run.ts:146-150
  interface ToolListMeta { description: string; inputSchema: unknown; outputSchema?: Record<string, unknown> }
  // AFTER
  interface ToolListMeta { description: string; inputSchema: unknown; outputSchema?: Record<string, unknown>;
                           title?: string; annotations?: Record<string, unknown> }

  // BEFORE run.ts:335-345 — writeError(_raw, err, _plan): void  { …; throw err; }
  // AFTER  — writeError(raw, err, plan): void — for every ApiError sets raw.output = { content:[{type:'text',
  //          text:`${code}: ${message}`}], isError: true, _meta: { 'adhd/error': { code, gatewayCode? } } }
  //          (adhd ADR-0018 D2); re-throws only a non-ApiError value. Unknown tools and malformed requests stay
  //          JSON-RPC protocol errors on their existing paths.

  // BEFORE run.ts:685 — server.setRequestHandler(CallToolRequestSchema, async (req) => …)
  // AFTER  — async (req, extra) => …; the dispatched call carries signal: extra.signal

  // BEFORE run.ts:512, :568, :598 — createPackageInvoker(schemas, usePlugins)
  // AFTER  — createPackageInvoker(schemas, usePlugins, { layerOptions: input.options })

  // BEFORE run.ts:960 — const t = new StdioServerTransport();
  // AFTER  — new StdioServerTransport(stdin?, stdout?) from an optional input.options['stdio'] stream pair
  //          (in-process test seam; default process stdio)
  ```

- **Behaviour changes (general, every apigen MCP service):**
  1. A string return is raw text (BA-2); non-strings unchanged (ADR-0004).
  2. Every `ApiError` code (`permission_denied`, `unauthenticated`, `not_found`, `invalid_argument`, gateway `unavailable`, plain `internal`) is an `isError` result; the SDK client's `callTool` resolves instead of rejecting. Protocol errors remain for unknown tools, malformed requests and thrown non-`ApiError` values.
  3. `tools/list` carries `title`/`annotations` from `Operation.tool` / `MountedOperation.tool` when present.
  4. Client cancellation aborts the dispatched call.
- **Dependencies:** R1, R3.
- **Read-only context:** `run.ts:130-346` (adapter), `:433-454` (mount collection), `:461-638` (tool table), `:674-731` (server and handler), `:900-970` (transport selection); `apigen-base-errors/src/lib/errors.ts:24-70`; `apigen-engine-gateway/src/lib/gateway.ts:87-103`.
- **Risk:** high (all MCP services). Readers of `content[0].text` are audited and, where a raw string breaks them, edited in R15 (G-5).
- **Rollback:** revert R4 alone (R9 then cannot pass its serve tests).
- **Tests:** T-R4. **Size:** not estimated.

### R5 — apigen-cli adoption and the IR-generation entry (apigen-cli, apigen-core-client)

IR generation is centralized in apigen-core-client (adhd ADR-0017 D5). The entry is the one function that produces IR for `generate`, `run`, `serve` and the policy wrapper's baked artifact (R12). Its result carries the IR and the files the extractor read; each extractor reports its own dependencies.

- **Files:** `entrypoint/apigen-cli/src/lib/commands/run.ts`, `commands/generate.ts`, `commands/run-registry.ts`, `commands/generate-registry.ts`, `commands/serve.ts`, `src/lib/orchestrator.ts`; `packages/apigen/apigen-core-client/src/lib/` new orchestration-entry module + `src/index.ts`.
- **Interface changes:**

  ```ts
  // BEFORE commands/run.ts:193
  export async function loadUsePlugins(specifiers: string[]): Promise<Plugin[]>
  // AFTER — materialises createLayer once with the invocation's flat --opt bag, so every target
  //         (mcp, fastify, express, cli-output) receives configured layers without editing those plugins
  export async function loadUsePlugins(specifiers: string[], layerOptions: Record<string, unknown> = {}): Promise<Plugin[]>

  // BEFORE orchestrator.ts:177-194 detectLang(file): 'ts'; :311-360 extractSource (TS-only branch)
  // AFTER  — extractSource delegates to the core-client entry:
  export function createExtractorRegistry(): ExtractorRegistry;              // keyed by ExtractCall.host
  export interface IExtractionResult { operations: Operation[]; files: string[] }  // files = what the extractor read
  export async function extractSourceEntry(input: {
    reference: string; resolution: ISourceResolution; namespace?: string;
    usePlugins: Plugin[]; extractLayerOptions: Record<string, unknown>;
    session?: ExtractionSession; registry: ExtractorRegistry; logger?: Logger;
  }): Promise<IExtractionResult>;
  //         TS registered first; detectLang stays exported as a thin wrapper (orchestrator.e2e.ts imports it)
  ```

  The exact export names are the implementer's to choose inside the gap analysis §3d contract; the plan pins behaviour, not names.
- **Behaviour changes:**
  1. `--use @adhd/apigen-plugin-policy --opt k=v` reaches the policy Layer's `createLayer` under every target.
  2. `--source` classification errors come from the resolver (gap analysis §3b table); valid inputs unchanged.
  3. `generate`, `run`, `serve` extract TS through one entry; output identical (pinned by golden comparison in T-R5).
  4. The TS extractor reports, in `sourceFiles`, the source files its program loaded (including the resolved tsconfig `extends` chain, R8p); the `argv` and `mcp` extractors (R7b) report the executable or an empty list.
- **Dependencies:** R2, R3, D1. R5's two halves share `orchestrator.ts` and land serially inside the segment.
- **Read-only context:** `commands/run.ts:180-345`; `commands/generate.ts:160-270`; `orchestrator.ts:110-150, 170-200, 290-360, 430-470, 620-715`; `apigen-core-client/src/lib/extract-invoker.ts:1-176`; `entrypoint/backlog/src/extract-live.ts:200-230` (second caller; not edited).
- **Risk:** medium. The promotion moves code that `entrypoint/backlog` duplicates; R13 is the gated follow-up. `entrypoint/apigen-cli` and `apigen-plugin-ir-cache` both call the entry's result type, so R5 publishes the type before R8p starts.
- **Rollback:** revert R5 with R8p, R7b, R8.
- **Tests:** T-R5. **Size:** gap analysis steps 2+3 ≈80 src + 110 test; the promotion is not estimated.

### R5a — `http.verb` override pass-through (apigen-cli)

Backlog 0bc4f3f6-cf5e-4eb4-9d1c-791d593d7cd1.

- **Files:** `entrypoint/apigen-cli/src/lib/orchestrator.ts` (`parseOverrides`, `:210`), `commands/generate.ts`, `commands/run.ts`.
- **Behaviour change:** `--opt http.verb.<id>=GET` is parsed by `parseOverrides` but the parsed overrides are not passed to the projection on `generate` and `run`. Both commands pass them into the projection, so the override changes the projected verb of operation `<id>` in `generate` output and `run` dispatch.
- **Dependencies:** R5 (shares `orchestrator.ts`; serial after R5, before R8).
- **Risk:** low. **Rollback:** revert R5a alone.
- **Tests:** T-R5a. **Size:** not estimated.

### R8p — IR cache residuals on the merged extraction-result cache (apigen-plugin-ir-cache, apigen-core-client)

The extraction result already reports `sourceFiles`, and the cache key already covers the whole `ExtractCall` (main `0bf369d5`; pinned by `ir-cache-invalidation.spec.ts` and `extract-source-files.spec.ts`). R8p is the remainder. It lands in the same wave as the orchestration entry (serial after R5), before R12 and before any step relies on the cache (adhd ADR-0017 D6).

- **Files:** `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts`, `src/lib/backends/fs-backend.ts`, `src/lib/ir-cache-layer.spec.ts`; the TS extractor in `packages/apigen/apigen-core-client` (the `sourceFiles` report); the R5 entry's `ExtractOptions` construction.
- **Interface and behaviour:**
  1. The cache takes its dependency list only from the extraction result's `sourceFiles` (G-2). The `collectLocalImportPaths` import and both fallback uses leave `ir-cache-layer.ts`; an extractor that reports no `sourceFiles` gets a source-only key and a source-only staleness record. `collectLocalImportPaths` stays exported from core-client for the TS extractor.
  2. No extractor option can hide in a closure: the R5 entry builds `ExtractOptions` only from `ExtractCall` fields (`source`, `namespace`, and `extractorOptions.{dropFileSegment,tsconfig,session}`), so everything that affects extraction is part of the key. The one live violator, `entrypoint/backlog/src/extract-live.ts:271` (passes `extractorOptions: {}` while a closure hard-codes `dropFileSegment`; its `tsconfig` branch is dead), is fixed by moving both into `extractorOptions` under R13, which is gated because `entrypoint/backlog` is outside §0.3.
  3. The TS extractor reports the resolved tsconfig `extends` chain in `sourceFiles` (backlog 9025607e), so editing a base tsconfig invalidates the entry without the cache walking `extends`.
  4. Comment-only: "fire-and-forget" is corrected where the layer now awaits `writeThrough` (backlog 088745d2) at `backends/fs-backend.ts:30` and `ir-cache-layer.spec.ts:238`. The backlog `env.ts` part of 088745d2 goes to R13.
  5. The artifact target produces the artifact through the core-client entry; the artifact the cache stores is the artifact the policy wrapper reads (R12).
- **Dependencies:** R5.
- **Read-only context:** `ir-cache-layer.ts` (key computation, `dependencyPaths`, `sourceFilesOf` use); the cache's `target` module; `ExtractResult.sourceFiles` and `extract-invoker.ts` in core-client; backlog items 9025607e, 088745d2, bbf1f0e3.
- **Risk:** medium (cache invalidation is silent when wrong). **Rollback:** revert R8p with R12.
- **Tests:** T-R8p. **Size:** not estimated.

### R6 — Policy Layer plugin on E4 (apigen-plugin-policy)

- **Files:** `packages/apigen/apigen-plugin-policy/src/plugin.ts`, `src/index.ts`, `src/ports.ts`, new `src/attributes.ts`, `package.json` (dependencies only: drop `@adhd/apigen-engine-runtime`, add `@adhd/apigen-core-client`), `README.md`; delete `src/state.ts`, `src/load-decider.ts`.
- **Interface changes:**

  ```ts
  // BEFORE index.ts:1-4
  export { default } from './plugin.js';
  export { createPolicyLayerPlugin } from './plugin.js';
  export type { IPolicyLayerOptions, PolicyErrorPhase } from './plugin.js';
  // BEFORE plugin.ts:16-20 — IPolicyLayerOptions { decider: IPolicyDecider | string; deciderOptions?; … }
  // BEFORE plugin.ts:292-343 — default export: layer delegates to module-singleton options captured by a
  //        mount capability that returns no operations

  // AFTER (TAXONOMY item 1 + item 6)
  export interface IPolicyLayerOptions { readonly decider: IPolicyDecider; readonly ask?: IPolicyAskHandler;
    readonly timeoutMs?: number; readonly onError?: (e: unknown, info: { phase: PolicyErrorPhase }) => void }
  export function makePolicyPlugin(options?: IPolicyLayerOptions): Plugin<{ timeoutMs?: number }>;
  declare const policyPlugin: Plugin<{ timeoutMs?: number }>;   // = makePolicyPlugin(); id 'policy', optionsSchema
  export default policyPlugin;
  export class PolicyAttributes { constructor(readonly values: Readonly<Record<string, string | number | readonly string[]>>) {} }
  ```

  `makePolicyPlugin(...).capabilities.layer.createLayer(opts)` validates `opts.timeoutMs` against `optionsSchema` and returns the Layer. With no decider configured it returns a Layer that refuses every call with `ApiError('permission_denied')` whose reason says how to configure a decider.
- **Behaviour changes:**
  1. Attributes are read from `call.ctx.get(PolicyAttributes)`; `call.envelope.attributes` is never read (supersedes D-18; remedy for f4d95c61).
  2. A bare `--use @adhd/apigen-plugin-policy` denies everything (`permission_denied`, not today's `internal`, `plugin.ts:295-298`).
  3. Two configurations in one process are independent (no module singleton).
  4. The string-decider form and the `load` error phase are removed (A6, d35b0dd2).
- **Dependencies:** R1, R3.
- **Read-only context:** `plugin.ts:1-343`; `ports.ts:1-32`; `state.ts:1-24`; `load-decider.ts:1-61`; TAXONOMY §1 (lines 95-115) and §6 (lines 296-317); `entrypoint/policy/src/wrapper/gate.ts:31-47` (only production consumer).
- **Risk:** medium. Cross-bundle class-key caveat (TAXONOMY §6, line 314).
- **Rollback:** revert R6 with R9 and R11b.
- **Tests:** T-R6. **Size:** not estimated.

### R7a — Gateway sources: errors, ids, producers, probe (gateway `src/lib/sources`)

- **Files:** `packages/apigen/apigen-engine-gateway/src/lib/sources/types.ts`, `argv-operation.ts`, `mcp-source.ts`, `parse-source.ts`, `resolve-source.ts`, `index.ts`, new `source-probe.ts`.
- **Interface changes:**

  ```ts
  // BEFORE types.ts:66-79 — export class SourceError extends Error { code: 'unsupported'|'handshake-failed'|'spawn-failed'|'invalid-spec' }
  // AFTER  — deleted; ApiError('invalid_argument') for invalid-spec/unsupported,
  //          makeUnavailableError(host, '(start)', reason) for spawn/handshake (gateway.ts:87-103)

  // BEFORE argv-operation.ts:38-44 — { id: fnName, host: 'ts', namespace: seg, path: [seg], … }
  // AFTER  — syntheticOp-built: id `bin/<base>`, host 'argv', binding `bin:<base>`

  // BEFORE mcp-source.ts:187-194 — id `${server}.${tool.name}`, host 'ts'
  // AFTER  — id from exported buildId (`<source>/<tool>`), host 'mcp', binding `mcp:<source>`, safe:false,
  //          tool: { title, annotations } from the upstream tools/list entry (E3)

  // NEW — export function operationsFromMcpTools(rawTools, name, onWarn) → { operations, skipped, hints, tools }
  // NEW — export const nodeSourceProbe: ISourceProbe
  // BEFORE resolve-source.ts — resolveSource(spec, intent, deps) keyed by intent
  // AFTER  — resolveSource(resolution, deps) keyed by translator; intent only fills an unset translator
  ```

- **Behaviour changes:** `unsupported` source exits 2 (was 1); ids change separator (BA-5); foreign operations stop claiming `host: 'ts'` (F-3, c62f9b13); the `x-apigen-safe` rewrite (`mcp-source.ts:246-250`) is deleted.
- **Dependencies:** R1, R2, R3.
- **Read-only context:** `sources/*.ts` (all, 1,169 lines total); `gateway.ts:87-127, 300-330, 404-420, 585-620`; TAXONOMY §7 (lines 321-345); gap analysis §3e.
- **Risk:** medium (D-07/D-08 paths; parity proven by s3/s7/s8 re-pointed in Phase C).
- **Rollback:** revert R7a with R7b, R9, R10.
- **Tests:** T-R7. **Size:** gap analysis step 5 ≈120 src + 120 test.

### R7b — Gateway sources: extractors, adapters, IR proxy (gateway `src/lib/sources`)

- **Files:** `sources/mcp-source.ts`, `resolve-source.ts`, `launcher-transport.ts`, `mcp-passthrough-server.ts`, `index.ts`, new `sources/mcp-upstream-adapter.ts` (TAXONOMY item 2 spec), new `sources/argv-adapter.ts`, new `sources/extractors.ts` (registers `argv` and `mcp` with R5's registry; each reports its dependencies in the extraction result); and `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts` for the routing line only (G-1).
- **Interface (AFTER):**
  - `createMcpUpstreamAdapter(spec): HostAdapter` (binding key `mcp:<source>`); `createArgvAdapter(spec): HostAdapter` (binding key `bin:<base>`). Each enforces its own call timeout and receives `call.signal`.
  - `registerSourceExtractors(registry)`: `argv` and `mcp` translators.
  - `serveMcpPassthrough({ operations, gateway, … })` — consumes IR and a gateway (O-8), never a live `IResolvedSource`. It is the degenerate proxy target for `adhd-policy serve bin:<executable>`: the argv operation is IR and its tool name is projected through the standard BA-1 projection.
  - `gateway.ts`: the routing line reads `req.operation.binding ?? req.operation.host` (~590-591).
  - Supervision: callers pass `createGateway({ adapters, backoff: { delayMs, maxRestarts: N } })` with finite `N` (`GatewayOptions.backoff`, `gateway.ts:318-324, 409`; `defaultBackoff.maxRestarts: 0` means unlimited, `:305-311`). `gateway.ts` itself is not edited for this.
- **Behaviour changes:** an MCP upstream is IR plus a binding (O-4); a crashed upstream restarts up to `N` times and is `unavailable` in between (BA-6); passthrough naming follows the projection (BA-1).
- **Dependencies:** R5 (registry), R7a, D1 (terminal). The routing edit (G-1, approved) is what lets two upstreams both tagged `host: 'mcp'` coexist: the gateway's host map (`gateway.ts:417-422`) keys on the routing value.
- **Read-only context:** `gateway.ts:1-130, 180-240, 290-330, 395-658` (edited: the routing line only; `gitnexus_impact` on the routing function before the edit); `sources/*.ts`; TAXONOMY item 2 (adapter spec) and item 8 (lines 348-375).
- **Risk:** high (new runtime path; supervision timing). Tests use latches, never sleeps.
- **Rollback:** revert R7b with R9.
- **Tests:** T-R7 (two-upstream aggregator acceptance included). **Size:** not estimated.

### R8 — TS subprocess extractor and measurement (apigen-core-client, apigen-cli)

- **Files:** `packages/apigen/apigen-core-client/src/lib/extract.ts` (subprocess entry), `extraction-session.ts` (dispose contract), `entrypoint/apigen-cli/src/lib/commands/run.ts`, `commands/serve.ts`; measurement script `tmp/apigen/measure-extract.mjs` (uncommitted, not a package).
- **Interface:** an extractor registration `ts-subprocess` behind the same registry contract as `ts` (it returns the same `IExtractionResult`, `files` included), driving the extractor through an injected launcher; `ExtractionSession.dispose()` called before serving begins.
- **Behaviour change:** none by default. The ir-cache miss default is **not** changed here; it is an owner decision after the measurement (O-10).
- **Measurement:** hit vs in-process miss vs subprocess miss; peak RSS and wall time; N runs each; results written to `docs/plan/policy-core/MEASUREMENTS.md` as a new section.
- **Prerequisite:** R8p (39c4e00c, a66aca5d) lands first, so the cache the measurement exercises keys and validates from the extraction result.
- **Dependencies:** R5, R8p.
- **Read-only context:** `extraction-session.ts:1-442`; `extract.ts:1-120, 850-930`; `orchestrator.ts:290-360`; gap analysis §5.6, §10.
- **Risk:** medium. Whether `ExtractionSession.dispose()` releases ts-morph memory is UNVERIFIED (gap analysis §10).
- **Rollback:** revert R8 alone.
- **Tests:** T-R8. **Size:** not estimated.

### R9 — Policy entrypoint rework (entrypoint/policy)

- **Files:** `entrypoint/policy/src/wrapper/gate.ts`, `attributes-layer.ts`, `verbs/run.ts`, `verbs/serve.ts`, `verbs/failure.ts`, `verbs/deps.ts`, `package.ts`, `mount.ts`, `telemetry.ts`, `tracing.ts`; delete `dereference.ts`.
- **Interface changes:**

  ```ts
  // BEFORE gate.ts:46
  usePlugins: [createAttributesLayerPlugin(deps.attributes), createPolicyLayerPlugin({ decider: createDecider(ctx) })]
  // AFTER
  usePlugins: [tracingPlugin, createAttributesLayerPlugin(deps.attributes), makePolicyPlugin({ decider: createDecider(ctx) })]

  // BEFORE attributes-layer.ts:24-25 — call.envelope['attributes'] = attributes / delete …
  // AFTER  — if (attributes !== undefined) call.ctx.set(PolicyAttributes, new PolicyAttributes(attributes))

  // BEFORE verbs/run.ts:53-72 — hand-built createInvoker over adaptCoreLayer + LayerContext
  // AFTER  — buildOpPlan + createPackageInvoker(schemas, usePlugins, { terminal: argvTerminal }) + dispatchForPlan(plan, …),
  //          transport 'cli', signal from deps.signal

  // BEFORE verbs/serve.ts:47-56 — serveMcpPassthrough({ source: resolved, usePlugins, serverInfo, transport, signal })
  // AFTER  — const gateway = createGateway({ adapters: [createMcpUpstreamAdapter(…)], backoff: { …, maxRestarts: N } });
  //          try { await gateway.start(); await mcpPlugin.run({ packages: [], operations: ir, options: { usePlugins, … } }) }
  //          finally { await gateway.stop() }

  // BEFORE verbs/failure.ts:15-17 — structural SourceError branch
  // AFTER  — deleted; ApiError only

  // BEFORE package.ts:30-71 — hand-composed schemas + dereferenceSchema
  // AFTER  — buildApigenPackage({ id:'policy', version, importPath, operations, fns, createClient })
  ```

- **Behaviour changes:**
  1. `run`: same exit codes (refusal 3, invalid argument 2, else child's code); now traced.
  2. `serve`: tool names follow the projection (BA-1); results are raw text for string returns (BA-2); `tools/list` carries title/annotations (BA-3); every `ApiError`, a refusal included, is an `isError` result (BA-4); a crashed upstream restarts up to `N` times (BA-6); a failed startup handshake exits non-zero (startup-failure contract: `onExit` fires only after `start()` resolves; `gateway.stop()` in `finally`). `serve bin:<executable>` runs `serveMcpPassthrough` as the degenerate proxy target over the argv operation's IR, with the tool name projected through the standard BA-1 projection.
  3. Accepted risk (O-2): `serve` spawns the upstream at startup, before any gating, to list its tools.
  4. D-24 telemetry: metrics and event logs on by default at full detail; disabled by configuration; log file mode `0600`; retention 14 days and 100 MB per file, both configuration values (not a feature toggle). `telemetry.ts:9-17` calls `initTelemetry({ service: 'policy', role, logSink: 'file' })` from `@adhd/sox-telemetry`; whether that package exposes file mode, disable and retention knobs is UNVERIFIED — an edit to `@adhd/sox-telemetry` is requested only if a knob is missing (G-6).
- **Dependencies:** R3, D1, R4, R6, R7b (and R10 for id-bearing fixtures in Phase C).
- **Read-only context:** `verbs/*.ts` (all); `gate.ts:1-48`; `attributes-layer.ts:1-31`; `package.ts:1-71`; `mount.ts:1-168`; `telemetry.ts:1-18`; `tracing.ts:1-30`; `apigen-plugin-mcp/src/lib/run.ts:900-970`; `gateway.ts:300-330, 404-520`; TAXONOMY item 2 (startup-failure contract).
- **Risk:** high (user-visible names and error shapes change; see §4).
- **Rollback:** revert R9 with R12, R11d.
- **Tests:** T-R9. **Size:** not estimated.

### R10 — `/` operation ids in policies (policy-core-client, entrypoint/policy)

- **Files:** `packages/policy/policy-core-client/src/core/compile/*` (the loader/compile step that reads `tool:`), `src/service/draft.ts` (`tool: operation.name`, line 134), `schema/policy.schema.json` (`tool`, lines 56-74), a migration entry in the CLI verb set (`entrypoint/policy/src/wrapper/verbs/index.ts`).
- **Behaviour changes:**
  1. `draft` output writes `/` ids.
  2. Loading a policy whose `tool:` value uses the old `.` form of a known operation fails with a message naming the new id (for example: `tool "files.read" uses the old separator; use "files/read"`). The exact rule for "old form" (a `.` in a position where an operation id has `/`) is pinned by T-R10; dotted attribute and context paths (`child.read_roots`, `runtime.calls`) are untouched.
  3. A migration command rewrites `tool:` values in a policy file in place and prints each change.
- **Dependencies:** R7a (id shape).
- **Read-only context:** `core/compile/index-builder.ts:1-45`; `core/evaluate/select.ts:1-30`; `service/draft.ts:60-150`; `schema/policy.schema.json:40-80`.
- **Risk:** medium (user files change). **Rollback:** revert R10 alone; policies written by the new `draft` stay valid only with R10.
- **Tests:** T-R10. **Size:** not estimated.

### R11a–d — CommonJS-only re-emit (X1, ADR-0003)

- **R11a — generator** (`packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts`). The scaffolder patches the vite config (`patchViteConfig`, `:173-245`) and the in-source dist paths (`patchInSourceDist`, `:402-434`) but neither rewrites the library `formats` nor normalises `package.json` `type`/`exports`. AFTER: `patchViteConfig` sets `formats: ['cjs']` and a patch step removes `type: "module"` and `exports` from the scaffolded `package.json`, leaving `main: ./dist/index.js` (ADR-0003 D1/D2). Where the `@nx/js:library` template injects `type`/`exports` was not read: UNVERIFIED; the generator test (T-R11) asserts the scaffolded output, not the injection site.
- **R11b — apigen-plugin-policy:** `package.json` (`type`, `module`, `exports` at lines 4-14 removed), `vite.config.mts` → `vite.config.ts` with `formats: ['cjs']` (today `['es']`, line 54), `project.json` test override per TAXONOMY X1 table. After R6 (R6 deletes `load-decider.ts`, whose `import(fileURL)` at line 47 does not survive CJS).
- **R11c — policy-core-client:** `package.json` (`type` line 4, `exports` line 14), `vite.config.mts` (`formats: ['es']` line 54). After R10.
- **R11d — entrypoint/policy:** `package.json` (`type` line 4), `vite.config.ts` (`formats: ['es']` line 26) → `['cjs']` + `importMetaUrlCjs()`; entry files use `void runEntry(...)`. After R9. `ir.ts:174, 187` use `await import('./ir-live')`; under a CJS bundle this must stay a lazily loaded chunk so the baked-artifact path never loads ts-morph — verified by R12's parity test and by `verify-dist-load`.
- **Also:** correct `REVIEW-FIXES.md` L7 ("add exports") to ADR-0003 (no `exports`).
- **Risk:** medium (`verify-dist-load` is the proof). **Rollback:** per package.
- **Tests:** T-R11 plus `verify-dist-load` on all three. **Size:** not estimated.

### R12 — IR through the ir-cache artifact target (entrypoint/policy)

- **Files:** `entrypoint/policy/src/wrapper/ir.ts`, `ir-artifact.ts`, `ir-live.ts`, `project.json` (build target); delete the hidden `ir-artifact` bake once parity holds.
- **AFTER:** bake = `vite build && node <apigen-cli dist bin> generate --source packages/policy/policy-core-client/src/service/api.ts --type ir-cache --opt cache=artifact --opt filename=api.ir.json --out-dir dist` (TAXONOMY C3); read = `createSingleFileBackend(...).get('')` plus a `CURRENT_FORMAT_VERSION` check. The baked artifact is the artifact the ir-cache stores, produced by the same core-client entry function (adhd ADR-0017 D5); no second extraction path remains in `entrypoint/policy`.
- **Parity proof (required):** the new artifact deep-equals the current `dist/api.ir.json`.
- **Dependencies:** R9 (shared `package.ts`/`mount.ts`), R11d, R8p.
- **Read-only context:** `ir.ts:1-198`; `ir-artifact.ts:1-34`; `ir-live.ts:1-25`; `apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts:230-270` and its `target` module (read only; not approved for edits).
- **Risk:** medium. **Rollback:** revert R12 alone (the old bake returns).
- **Tests:** T-R12. **Size:** not estimated.

### R15 — `content[0].text` readers (G-5)

- **Audit first.** For each reader, record whether it reads a string-returning apigen tool and whether it parses the text: `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:499`; `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts`; `entrypoint/agent-mcp/src/__tests__/traced-transport.test.ts` and the agent-mcp `*.e2e.*` suites; the `entrypoint/backlog` `*.e2e.*` suites. Also `packages/apigen/apigen-plugin-mcp/src/test/flat-content-payload.spec.ts` and `stream.spec.ts` (re-pointed in T-R4).
- **Edit only where a raw string breaks it.** A reader that does not parse the text of a string-returning tool is not edited. Each edit lands with a test that fails against the raw string input.
- **Output:** the audit table (reader, tool, parses text yes/no, action) is appended to this plan under R15 before any edit.
- **Dependencies:** R4. **Risk:** medium. **Rollback:** per reader.
- **Tests:** T-R15.

#### R15 audit table

Basis: R4 (`apigen-plugin-mcp/src/lib/run.ts`) returns a string result as the raw `content[0].text` with no `structuredContent` (D1), and maps every `ApiError` to an `isError` result with text `<code>: <message>` and `_meta['adhd/error']`, so `callTool` resolves (D2, K3). A non-`ApiError` throw and a stream (`projectStreamMcp`) are unchanged. `entrypoint/agent-mcp` serves its own tools (`server.ts` `toMcpContent` = `JSON.stringify(value, null, 2)`, `toMcpErrorContent` = `[CODE] message`) and has no `@adhd/apigen-*` dependency. `entrypoint/backlog` mounts through `apigen-plugin-mcp`; every mounted verb in `api.ts` returns an `IOutcomeEnvelope` object and catches its own throws into the envelope (`envelope()`, `api.ts:630-640`), so no backlog tool returns a string and no backlog verb raises an `ApiError` from its body.

| Reader (file:line) | Tool it reads | String-returning apigen tool? | Parses text? (`JSON.parse`?) | Breaks under raw string / K3? | Action |
|---|---|---|---|---|---|
| `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:499` (`AgentMcpRunner.callTool`) | agent-mcp `agent_read`, `agent_create`, `task`, `result`, `task_cancel`, `usage_query` (`:519-640`) | no (agent-mcp, not apigen) | yes, `JSON.parse` (`:507`); `isError` text matched by `[CODE]` (`:502`) | no; K3 no (agent-mcp returns `isError` itself) | none |
| `packages/agent/agent-plugin-budget/src/index.ts:1919-1931` (`enforceResponseSize`) | any tool result through `transform:tool_result` | may be | no (sums `text.length`) | no | none |
| `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts:1076` | literal fixture `{ text: 'small file' }` | no | no | no | none |
| `entrypoint/agent-mcp/src/__tests__/traced-transport.test.ts:49,68` | in-test SDK `Server` `add` (`String(a+b)`) | no | `:68` parses the JSON-RPC body, reads `text` as-is | no | none |
| `entrypoint/agent-mcp/src/__tests__/pricing-tools-mcp.test.ts:51,74,77` | agent-mcp `pricing_refresh`, `pricing_history` | no | yes | no | none |
| `entrypoint/agent-mcp/src/__tests__/tasks-batch-string-args.e2e.test.ts:147`, `live/tracing-live.e2e.test.ts:264,338` | agent-mcp tools | no | yes | no | none |
| `entrypoint/agent-mcp/src/__tests__/agent-list-reflects-store.e2e.test.ts:145,184,194`; `integration/{native-web-tools:108, tasks-batch:91, provider-selection:85, agent-prompt-projection:62, tracing-e2e:218, default-mcp-servers:81, provider-selection-global:99}.e2e.test.ts`; `provider-wire.e2e.test.ts:253`; `r10-s4-delegation-text.test.ts:123` | agent-mcp tools | no | varies | no | none |
| `entrypoint/backlog/src/test/helpers/spawn-mcp-host.ts:94-114` (`callToolJson`, used by `mcp-host`, `contract-matrix`, `production-write-gate` e2e) | backlog verbs | no (envelope objects) | yes | no; K3 no (domain failures are `ok:false` envelopes; no case sends schema-invalid input — `contract-matrix.e2e.ts:186` `limit:-5` has no schema bound and reaches the domain) | none |
| `entrypoint/backlog/src/server.mcp.e2e.ts:108,170,187`; `serve.e2e.ts:150,171`; `serve.singleton.e2e.ts:123,147`; `store/acked-write-durability.e2e.ts:116` | backlog verbs | no | yes | no | none |
| `entrypoint/backlog/src/server.verbs.e2e.ts` | none (lists mounts; no `callTool`) | n/a | no | no | none |
| `packages/apigen/apigen-plugin-mcp/src/test/flat-content-payload.spec.ts:107,123` | object and union returns | no | yes | no | none |
| `packages/apigen/apigen-plugin-mcp/src/test/stream.spec.ts:40-212` | `projectStreamMcp` output | stream chunks (unchanged by R4) | yes | no | none |

Production readers: one (`agent-runner.ts:499`); none breaks; no source edit. K3 production callers relying on a rejected `callTool`: none in the G-5 paths (the only production `callTool` caller is `agent-runner.ts`, which targets agent-mcp).

Readers outside the G-5 list that break (not edited here; test re-point owed):

| Reader (file:line) | Tool it reads | String-returning apigen tool? | Parses text? | Breaks? | Action |
|---|---|---|---|---|---|
| `entrypoint/apigen-cli/src/test/e2e/bug-apigen-033-anonymous-default-dispatch.e2e.ts:143-146` | default export returning `'hello Ada'` | yes | `JSON.parse` | yes (D1) | T-R15 |
| `entrypoint/apigen-cli/src/test/e2e/import-source-cjs-format.e2e.ts:92-95` | `greet` returning `'hello world'` | yes | `JSON.parse` | yes (D1) | T-R15 |
| `entrypoint/apigen-cli/src/test/e2e/real-consumer.e2e.ts:236-237,445-448` | `text.ts` exports (`upperFirst`, `trim`, …) | yes | `JSON.parse` | yes (D1) | T-R15 |
| `packages/apigen/apigen-plugin-mcp/src/test/transport-http-parity.e2e.ts:281-286,367-372` | `get_thing` `'missing'` throws `ApiError('not_found')` | n/a | `rejects.toThrow()` | yes (K3: resolves `isError`) | T-R4 |
| `packages/apigen/apigen-plugin-mcp/src/test/run.e2e.ts:1444-1447` | malformed input, `ApiError('invalid_argument')` | n/a | `rejects.toThrow()` | yes (K3) | T-R4 |
| `packages/apigen/apigen-plugin-mcp/src/test/run.e2e.ts:1282-1300` (parity harness) | error fixtures recorded as `ok:false`/`errorCode` from a catch | n/a | catch path | yes (K3: error fixtures now resolve) | T-R4 |
| `packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-source.ts:~302` | upstream MCP `content` (production client) | may be | not audited (outside G-5 paths; under concurrent edit) | unknown | audit owed |

### R13 — Backlog migration (gated; off the critical path)

Moves `entrypoint/backlog`'s `buildBacklogApigenPackage` copy and `extract-live.ts:213-222` onto `buildApigenPackage` and the orchestration entry. **Not started without explicit owner approval (G-3).** Nothing else depends on it.

### R14 — Documentation (docs item fce1647f)

- Create `docs/policy-reference.md` (policy file reference: `tool:` ids with `/`, effects, args operators, attributes, discovery) and `docs/attributes.md` (attribute sources, precedence D-06, the `PolicyAttributes` ctx key, the `--adhd-attributes` flag). Neither file exists today (verified by `ls`).
- Update `packages/apigen/apigen-plugin-policy/README.md` (`makePolicyPlugin`, `--use` + `--opt`), the gateway README (sources, adapters, binding), `packages/apigen/README.md` table, `INTERFACES.md` (D-07, D-08, D-14, D-18, D-19, D-20, D-21 superseded; D-04/U12 kept), and SPEC per R0.

---

## 4. The existing behavioural contract (369 tests) and its re-pointing

The 369 existing behavioural tests are the contract: library (policy-core-client) 48, Layer (apigen-plugin-policy) 55, gateway 133, policy entrypoint 165. Every one keeps passing after its segment, except the assertions below, which pin a shape this plan changes on purpose. Each re-pointing lands in the Phase C segment named, and each re-pointed assertion keeps a negative control.

| Changed shape | Pinned at | Re-pointed to | Segment |
| --- | --- | --- | --- |
| `.`-separated operation ids (BA-5) | `packages/apigen/apigen-engine-gateway/src/test/sources-parse-resolve.spec.ts:116` (`node.read_file`); `…/sources-passthrough.spec.ts:126` (`files.write_file`) | the `/` id rendered by the exported `buildId` | T-R7 |
| Policy `tool:` values with `.` | `entrypoint/policy/src/test/functional/s2-check-evaluate.spec.ts` lines 36, 46, 59, 68, 80, 91, 92, 117, 145, 162, 171; `…/s5-narrow.spec.ts:134` (`agent.spawn`); `…/s6-verify-explain-draft.spec.ts:90, 99, 107, 119`; `…/http-entry.spec.ts:94`; `entrypoint/policy/src/test/helpers/fixtures.ts` tool lines 15, 17, 21, 24, 31, 48, 57, 72, 74, 76 | `/` ids | T-R10 |
| **Not** migrated (attribute and context paths, basename stripping) | `fixtures.ts:53-56, 77`; `s6-verify-explain-draft.spec.ts:76`; gateway `sources-parse-resolve.spec.ts:75-86` | unchanged | — |
| Raw upstream tool names in `serve` (BA-1) | `entrypoint/policy/src/test/functional/s7-serve.spec.ts:33-160` (`notes_add` …); `…/s8-serve-handshake-and-precedence.spec.ts` at 26, 217, 240-246 | the projected name. The rendered projection format is UNVERIFIED until R7b lands; T-R9 pins it | T-R9 |
| Upstream names the stub receives | `s7:86, 97-98, 160` (`stub.calls`) | unchanged: the upstream still receives its own tool name | — |
| Tool metadata in `tools/list` | `s7:72` (`title: 'Add'`, `annotations`) | unchanged; carried by E3 through `mcpPlugin.run` | T-R4, T-R9 |
| Unknown tool | `s7:124` (`/Unknown tool/`) | unchanged (protocol error) | — |
| Injected host transport | `s7:285`; `s8:51`; `test/helpers/mcp-memory-client.ts:29-57` | the `mcpPlugin.run` stdio stream seam (R4) | T-R9 |
| `SourceError` codes | 39 matching lines in four gateway specs (`rg -c "SourceError\|spawn-failed\|handshake-failed\|invalid-spec\|'unsupported'"`): `apigen-engine-gateway/src/test/sources-mcp-source.spec.ts` (13), `sources-parse-resolve.spec.ts` (18), `sources-passthrough.spec.ts` (1), `sources-process.spec.ts` (7); none in `entrypoint/policy/src/test` | `ApiError` code + `detail.gatewayCode`; exit codes per §3 R7a | T-R7, T-R9 |
| Envelope attributes | `apigen-plugin-policy/src/test/layered-decisions.spec.ts:13, 84`; `fail-closed.spec.ts:29, 179`; `review-fixes-layer.spec.ts:39, 49, 57, 66, 91` | `ctx.get(PolicyAttributes)` | T-R6 |
| Bare plugin refuses with `internal` | `review-fixes-layer.spec.ts:334-339` (no captured configuration), `:386-389` (options without a decider) | `permission_denied` | T-R6 |
| String-decider and `load` phase | `fail-closed.spec.ts:107-130` (three `load`-phase cases), `:231-276` (module-reference decider, `deciderOptions`); `review-fixes-layer.spec.ts:122`; the mount-capture describe at `review-fixes-layer.spec.ts:325` | deleted with the feature (A6) | T-R6 |
| JSON-quoted string results over MCP | `apigen-plugin-mcp/src/test/flat-content-payload.spec.ts`, `stream.spec.ts` | raw text for string returns only | T-R4 |

Line numbers in the "Pinned at" column were read at plan time; the Phase C implementer re-locates each by its asserted literal before editing.

---

## 5. Collision matrix

A cell lists the segments that edit the same file. Two segments sharing a file never run in parallel; the order is the order shown.

| File | Segments (in order) |
| --- | --- |
| `apigen-core-client/src/index.ts` | R1 → R2 → R5 → R8 |
| `apigen-core-client/src/lib/extract.ts` | R1 (buildId) → R8 (subprocess entry) |
| `apigen-core-client/src/lib/plugin.ts`, `descriptor.ts` | R1 (R3 only if ctx unification needs a type change, after R1) |
| `apigen-engine-runtime/src/lib/*` | R3 → D1 (`invoke.ts`, `package-invoker.ts`) |
| `apigen-engine-runtime/src/lib/coerce-query.ts` | R3 → R3a |
| `apigen-engine-runtime/src/index.ts` | R3 → D1 → R3a (R3a only if it exports a symbol; otherwise R3a runs parallel with D1) |
| `apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts` | R8p only (after R5) |
| gateway `gateway.ts` (routing line) | R7b only |
| `apigen-plugin-mcp/src/lib/run.ts` | R4 only |
| `apigen-cli/src/lib/orchestrator.ts`, `commands/run.ts`, `commands/generate.ts`, `commands/serve.ts` | R5 → R5a → R8 (R5a edits `orchestrator.ts`, `commands/generate.ts`, `commands/run.ts`) |
| `entrypoint/agent-mcp`, `dispatch-orchestrator`, `agent-plugin-budget` readers | R15 only |
| gateway `sources/mcp-source.ts`, `resolve-source.ts`, `index.ts` | R7a → R7b |
| `apigen-plugin-policy/src/plugin.ts`, `index.ts` | R6 only |
| `apigen-plugin-policy/package.json` | R6 (dependencies) → R11b (module format) |
| `policy-core-client/package.json`, `vite.config.mts` | R11c only (after R10) |
| `entrypoint/policy/src/wrapper/package.ts`, `mount.ts` | R9 → R12 |
| `entrypoint/policy/package.json`, `vite.config.ts` | R9 (if deps change) → R11d |
| `entrypoint/policy/src/wrapper/verbs/index.ts` | R10 only (R9 edits `run.ts`, `serve.ts`, `failure.ts`, `deps.ts`, not `index.ts`) |
| `entrypoint/policy/src/wrapper/ir.ts` | R12 (R11d reads it, does not edit) |
| `entrypoint/policy/src/test/helpers/fixtures.ts` | T-R10 → T-R9 |
| `docs/apigen/SPEC.md` | R0 → R14 |

---

## 6. Critical path and parallelism

**Critical path (longest chain):**

```
R0 ─► R1 ─► R3 ─► D1 ─► R4 ───────┐
            │                     ├─► R9 ─► R12 ─► RV ─► T-R9/T-R12 ─► R14 ─► T18
            ├─► R6 ───────────────┤
R1 ─► R2 ─► R5 ─► R8p ─► R7b (needs R7a, D1) ┘
                   R11d (after R9) ─► R12 (also after R8p)
```

1. R0 owner decision on field names and mapping rows.
2. R1 core-client contracts.
3. R3 runtime invoker (createLayer, signal, `buildApigenPackage`), then D1 (the binding-aware terminal).
4. R2 resolver, then R5 CLI adoption and the IR-generation entry, then R8p (the cache takes its dependency list from the entry's result).
5. R7a gateway ids/errors/producers, then R7b adapters and the routing line.
6. R4 MCP adapter, in parallel with R5/R6/R7a; R15 reader audit after R4.
7. R9 policy entrypoint rework (joins R4, R6, R7b).
8. R11d CJS re-emit, then R12 IR artifact.
9. Phase B reviews, Phase C tests.
10. R14 docs, T18 demo reconciliation, `DONE.md`, final gates.

**Parallel lanes** (each lane one `performance` dispatch; lanes share no file per §5):

| Wave | Runs in parallel |
| --- | --- |
| 0 | R1 ∥ R11a (R0 is the owner, outside the lanes) |
| 1 | R2 ∥ R3 → D1 ∥ R3a (R2 only touches `source-language.ts` and, after R1, `index.ts`; D1 follows R3 on the shared runtime files; R3a follows R3 on `coerce-query.ts` and runs parallel with D1 only if it leaves `src/index.ts` alone, otherwise D1 → R3a) |
| 2 | R4 ∥ R5 → R5a ∥ R8p ∥ R6 ∥ R7a (R5a follows R5 on `orchestrator.ts` and precedes R8) |
| 3 | R7b → then R9; R8 ∥ R10 ∥ R11b (after R6) ∥ R11c (after R10) ∥ R15 (after R4) |
| 4 | R11d → R12 |
| B | one review per finished package, in any order |
| C | T-R1…T-R12 in parallel per package; T-R10 before T-R9 (shared fixtures) |
| 5 | R14 → T18 |

R8, R10, R11a–c, R13, R15 and R14's README items are off the critical path.

---

## 7. Phase C: tests, acceptance and Definition of Done

Every scenario is written from the user's usage. Every DoD clause names a real entrypoint and an observable result. "Control" is the negative control the implementer runs and records.

### T-R1 — contracts

```gherkin
Scenario: a layer plugin exposes only createLayer
  Given a plugin whose layer capability has createLayer and no layer
  When it is typechecked against Plugin from @adhd/apigen-core-client
  Then it compiles
  And a capability with neither layer nor createLayer fails typecheck
```

- DoD: `descriptor.schema.json` validates an operation carrying `binding`, `tool`, `hasCtx` and rejects `binding: ""`. Control: remove `binding` from the schema → the validation test goes red.
- DoD: `buildId` exported from `@adhd/apigen-core-client` returns the same id as the extractor for a fixture namespace + path. Control: change the separator in the shared copy → both the extract golden and the `buildId` test go red.

### T-R2 — resolver

```gherkin
Scenario Outline: classifying a source reference
  Given a probe that reports <probe state>
  When resolveSourceReference("<reference>") runs
  Then the resolution is <kind> with translator <translator>

Scenario: nothing matches
  When resolveSourceReference("no-such-thing") runs with an empty probe
  Then it fails with invalid-reference
  And the message names scheme, URL, code extension, schema extension, existing path and PATH lookup
```

- DoD: one row per detection step of gap analysis §5.5, plus the PATH-fallback-last row (O-2). Control: move the PATH lookup ahead of the extension check → the `./api.ts`-on-PATH row goes red.

### T-R3 — runtime

```gherkin
Scenario: options reach a createLayer plugin
  Given a package invoker composed with a plugin whose createLayer records its options
  And layerOptions { timeoutMs: 50 }
  When an operation is invoked
  Then the plugin's layer saw timeoutMs 50
  And createLayer ran once for two invocations

Scenario: cancellation reaches a ctx-taking function
  Given a service function that takes ctx and awaits its signal
  When the caller aborts the invocation
  Then the invocation rejects with an aborted ApiError

Scenario: a ctx key set by an outer layer is visible to a mount handler
  Given a --use plugin whose mount handler returns the value of a ctx key
  And an outer layer that sets that key to "core"
  When the mounted operation is invoked
  Then the result is "core"

Scenario: a $ref schema dispatches without the run-mode stub error
  Given a service whose input type references a named definition
  When an operation of the package built by buildApigenPackage is invoked with valid input
  Then the function's result is returned
  And no "cannot be resolved in run-mode" error occurs
```

- DoD: `buildApigenPackage` for the policy service IR produces schemas that dispatch `check`; asserted by the returned decision. Control: skip `$ref` resolution → "cannot be resolved in run-mode" and red.

### T-R3a — nullable query coercion

```gherkin
Scenario: a nullable integer query param is coerced
  Given an operation whose query param schema is oneOf [{ type: "null" }, { type: "integer" }]
  When the query string carries "n=5"
  Then the function receives the number 5

Scenario: a nullable boolean query param is coerced
  Given a query param schema of type ["null", "boolean"]
  When the query string carries "b=true"
  Then the function receives the boolean true
```

- DoD: both scenarios drive the HTTP query path of the runtime. Control: revert the non-null branch resolution in `coercibleType` → both cases receive strings and go red.

### T-D1 — binding-aware terminal

```gherkin
Scenario: a flat-argument operation runs through the terminal
  Given an operation with host "mcp" and binding "mcp:notes"
  And a terminal that records the call it receives and returns "saved"
  When the operation is invoked through createInvoker with that terminal and the argument object { text: "hi" }
  Then the caller receives "saved"
  And the terminal received { text: "hi" } as one object and the call's signal
  And dispatch was not called
```

- DoD: `createInvoker(layers, { terminal })` routes to the terminal and never calls `dispatch`; asserted by the terminal's return value reaching the caller. Control: drop the terminal option → the result is the dispatch result and the test goes red.
- DoD: without a terminal, a TS operation dispatches exactly as before (golden call result). Control: always use the terminal → the TS scenario goes red.

### T-R4 — MCP adapter (in-memory transport, real `mcpPlugin.run`)

```gherkin
Scenario: a string result is raw text
  Given an apigen MCP service whose operation returns "ok"
  When a host calls the tool
  Then content[0].text is ok (no quotes)

Scenario: a refusal is a readable tool result
  Given the operation throws ApiError permission_denied "blocked by rule r1"
  When a host calls the tool
  Then the result has isError true
  And content[0].text is "permission_denied: blocked by rule r1"
  And _meta["adhd/error"].code is permission_denied

Scenario Outline: every ApiError code is a readable tool result
  Given the operation throws ApiError <code> "<message>"
  When a host calls the tool
  Then the result has isError true
  And content[0].text is "<code>: <message>"
  And _meta["adhd/error"].code is <code>
  # codes: unauthenticated, not_found, invalid_argument, internal; the gateway
  # unavailable error (internal with detail.gatewayCode unavailable) renders "unavailable: <message>"
  # with _meta["adhd/error"] { code: internal, gatewayCode: unavailable }

Scenario: a non-ApiError throw stays a protocol error
  Given the operation throws a plain Error
  When a host calls the tool
  Then the host's callTool rejects with a JSON-RPC error

Scenario: an unknown tool stays a protocol error
  When a host calls a tool name that does not exist
  Then the host's callTool rejects matching /Unknown tool/

Scenario: tools/list carries title and annotations from Operation.tool
  Given an operation with tool { title: "Add", annotations: { readOnlyHint: false } }
  When a host lists tools
  Then that entry has title "Add" and the annotations
  And an extracted TS operation's entry has neither field

Scenario: the host cancels a call
  Given an operation that waits on its signal
  When the host cancels the in-flight request
  Then the operation observes an aborted signal and stops
```

- Each BA-4 row gets one scenario. Control per scenario: revert that branch of `writeError`/`writeResult`.

### T-R5 — apigen-cli

```gherkin
Scenario: --opt reaches a --use layer under every target
  Given a fixture --use plugin whose createLayer echoes opts.k into the result
  When apigen run --use <plugin> --opt k=v invokes an operation through the cli target in-process
  Then stdout contains v

Scenario: an unclassifiable --source is reported with every interpretation tried
```

- DoD: `generate` for the fixture TS source writes output byte-identical to the pre-R5 golden. Control: perturb the entry's namespace default → golden diff red.

### T-R5a — `http.verb` override

```gherkin
Scenario: an http.verb override changes the projected verb
  Given a fixture TS source with an operation <id> projected as POST
  When apigen generate and apigen run are invoked with --opt http.verb.<id>=GET
  Then the generated output and the run projection both expose <id> as GET
```

- DoD: asserted on `generate` output and on `run` dispatch. Control: drop the override pass-through in `generate` or `run` → that command still projects POST and the case goes red.

### T-R6 — policy Layer

```gherkin
Scenario: bare --use denies with configuration guidance
  Given the default plugin with no decider
  When a call is made
  Then it fails permission_denied and the reason says how to configure a decider

Scenario: attributes come from the ctx, not the envelope
  Given a decider that allows only when attribute team is "core"
  And PolicyAttributes { team: "core" } on the call ctx
  And envelope.attributes { team: "other" }
  Then the call is allowed

Scenario: two configurations in one process are independent
  Given makePolicyPlugin with a decider allowing files/read
  And makePolicyPlugin with a decider denying files/read, in the same process
  When files/read is invoked through each
  Then the first is allowed and the second fails permission_denied
```

- Control: read the envelope instead of ctx → the second scenario goes red; reintroduce the module singleton → the third goes red.

### T-R7 — gateway sources (fake launcher, stub upstream)

```gherkin
Scenario: an MCP upstream's operations are IR with a binding
  When the stub upstream exposing add is resolved as source notes
  Then the operation id is the buildId rendering of notes and add
  And host is mcp and binding is mcp:notes and title/annotations are copied

Scenario: two upstreams aggregate through one gateway
  Given upstreams a and b both expose add
  When each tool is called
  Then each call reaches its own upstream

Scenario: a crashed upstream restarts at most N times and is unavailable in between
  Given a gateway with backoff maxRestarts 2 and an upstream the fake launcher crashes on demand
  When the upstream crashes and a tool is called before the restart completes
  Then the call fails internal with gatewayCode unavailable
  And after the third crash no further spawn happens

Scenario: an unsupported source exits 2 with ApiError invalid_argument
  Given a --source value no translator accepts
  When the source is resolved
  Then resolution fails with ApiError invalid_argument naming the value
  And the CLI marshal maps it to exit code 2
```

- The two-upstream scenario requires the routing edit (G-1, approved). Restart scenarios use latches on the fake launcher, never sleeps. Control: route by `host` instead of `binding ?? host` → the aggregator scenario goes red.

### T-R8 — subprocess extractor (injected launcher)

- DoD: the `ts-subprocess` registration returns operations deep-equal to the in-process `ts` extractor for the fixture source. Control: drop one operation in the subprocess decoder → red.
- Measurement is not a gate; its numbers go to `MEASUREMENTS.md`.

### T-R8p — IR cache residual tests (cases the specs merged with `0bf369d5` do not pin)

```gherkin
Scenario: calls differing only in dropFileSegment are a cache miss
  Given a cached extraction through the core-client entry with dropFileSegment true
  When the same source is extracted with dropFileSegment false
  Then the cache does not return the first entry

Scenario: an extractor that reports no sourceFiles gets a source-only key
  Given an extractor whose result carries no sourceFiles
  When the extraction is cached and an imported file then changes
  Then the cached entry is still a hit
  And the staleness record lists only the source
  And the cache module does not walk imports itself

Scenario: editing a base tsconfig invalidates the entry (9025607e)
  Given a TS extraction whose tsconfig extends a base tsconfig
  When the base tsconfig changes and the source is extracted again
  Then the result is re-extracted
  And the extractor's reported sourceFiles include the base tsconfig

Scenario: no extractor option is built outside ExtractCall
  Given two ExtractCalls that differ in one ExtractCall field
  When the entry builds ExtractOptions for each
  Then the options differ in exactly that field
  And no option is present that is not derived from an ExtractCall field
```

- Control: restore the `collectLocalImportPaths` fallback in `ir-cache-layer.ts` → the second scenario goes red; drop the tsconfig `extends` chain from the extractor's `sourceFiles` → the third goes red; read `dropFileSegment` from a closure instead of the call → the first and fourth go red. Each control is recorded.
- The `fire-and-forget` comment edits (088745d2) are comment-only and carry no test.

### T-R9 — policy entrypoint (in-process `cliPlugin.run` / `mcpPlugin.run`)

```gherkin
Scenario: policy run refuses a denied command
  Given a policy file denying bin/rm
  When the user runs policy run for the rm executable with arguments -rf tmp (exact argv form reconciled in T18)
  Then the exit code is 3 and stderr names the rule

Scenario: policy serve gates an MCP upstream
  Given a policy denying notes/delete
  When a host calls the projected delete tool
  Then the result is isError with text starting "permission_denied:"
  And the upstream never received the call

Scenario: a string answer from the upstream reaches the host as raw text
  Given the stub upstream's tool answers with the text "saved"
  When a host calls the projected tool through policy serve
  Then content[0].text is saved

Scenario: a failed upstream handshake exits non-zero and leaves no child running
  Given the fake launcher starts an upstream that never completes the MCP handshake
  When the user starts policy serve for it
  Then serve exits non-zero with a message naming the source
  And the fake launcher records the child as stopped

Scenario: policy serve bin: projects the executable as a tool and gates it
  Given an executable on a fake launcher and a policy denying bin/<base>
  When a host lists tools and calls the projected tool through policy serve bin:<base>
  Then the tool name is the BA-1 projection and the result is isError with text starting "permission_denied:"
  And the executable never ran

Scenario: telemetry defaults are 14 days and 100 MB per file
  Given a fresh home directory under tmp/policy and no telemetry configuration
  When the effective telemetry configuration is read
  Then retention is 14 days and the per-file cap is 100 MB

Scenario: telemetry writes a 0600 log file by default and none when disabled
  Given a fresh home directory under tmp/policy
  When the user runs policy check with defaults
  Then a telemetry log file exists with mode 0600
  When the user runs it again with telemetry disabled by configuration
  Then no new log entry is written
```

- Control per scenario: revert the corresponding line in `serve.ts` / `run.ts` / `telemetry.ts` and record red.

### T-R15 — readers of `content[0].text`

- DoD: for every reader the audit marks "parses text", a test feeds it a raw (unquoted) string result and asserts the reader's consumer-visible outcome. Control: feed the old JSON-quoted form → the test shows the reader's previous behaviour, and the raw-string form is red against the unedited reader.

### T-R10 — `/` ids in policies

```gherkin
Scenario: draft writes / ids
  Given the policy service IR
  When the user runs policy draft
  Then every tool value in the output uses /

Scenario: an old-separator tool value fails with the new id named
  Given a policy with tool "files.read"
  When it is loaded
  Then loading fails and the message names "files/read"
Scenario: migrate rewrites a policy file and prints each change
  Given a policy file with tool "files.read" and tool "files.write"
  When the user runs the migrate command on it
  Then the file has "files/read" and "files/write"
  And stdout lists both changes

Scenario: attribute paths with dots are untouched
  Given a policy using child.read_roots and runtime.calls
  When the user runs the migrate command
  Then those paths are unchanged and the policy still loads
```

- Control: disable the old-separator check → the second scenario goes red.

### T-R11 — CommonJS

- DoD: `nx g @adhd/workspace-codegen-nx:core --dry-run` for a fixture name shows `formats: ['cjs']` and a `package.json` without `type`/`exports` (generator spec using the nx devkit tree). Control: remove the patch → red.
- DoD: `npx nx run <project>:verify-dist-load` exits 0 for apigen-plugin-policy, policy-core-client and policy.

### T-R12 — IR artifact

- DoD: the artifact built by the ir-cache target deep-equals the existing `dist/api.ir.json`; `policy check` through the built CLI reader produces the same decision on the fixture. Control: corrupt `CURRENT_FORMAT_VERSION` in the fixture artifact → the reader fails with a version message.

---

## 8. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner of decision |
| --- | --- | --- | --- | --- | --- |
| K1 | `LayerCapability.layer` optional breaks unguarded readers repo-wide | medium | high | `gitnexus_impact` before R1; every reader updated in R3/R4/R9; typecheck gate | implementer |
| K2 | MCP raw-text change breaks readers that parse `content[0].text` | medium | high | R15 audit first, edits only where a raw string breaks a reader (G-5, approved); string results only; adhd ADR-0004 D6 republish order | implementer |
| K3 | `isError` mapping changes a caller's reject path into resolve for every `ApiError` code | medium | medium | decided (G-7); one scenario per row in T-R4; R15 audit covers callers that relied on a rejected `callTool` | implementer |
| K4 | Two upstreams collide on `host: 'mcp'` | certain without the routing edit | high | the routing line reads `binding ?? host` (G-1, approved; R7b) | implementer |
| K5 | `$ref` resolution needs `apigen-base-logical` | unknown (UNVERIFIED) | medium | G-4; check in R3 first | owner |
| K6 | CJS bundle breaks `ir.ts` lazy `import('./ir-live')` and loads ts-morph eagerly | medium | medium | R11d after R9; `verify-dist-load`; R12 parity | implementer |
| K7 | Mount-branch ctx differs from Layer ctx, so `PolicyAttributes` is invisible to mounts | high (observed in code) | medium | R3 behaviour change 3 + T-R3 scenario | implementer |
| K8 | Cross-bundle class-key identity for `PolicyAttributes` | medium | medium | single import path `@adhd/apigen-plugin-policy`; T-R6 | implementer |
| K9 | Supervision tests flake | medium | medium | latches on the fake launcher; no sleeps | implementer |
| K10 | ir-cache staleness (39c4e00c) or key collision (a66aca5d) makes R8/R12 serve stale IR | medium | medium | R8p lands with the entry, before R12 and before any cache reliance; `0bf369d5`'s specs plus T-R8p (G-2, approved) | implementer |
| K11 | Telemetry knobs absent in `@adhd/sox-telemetry` | unknown (UNVERIFIED) | low | the values are decided (14 days, 100 MB per file); an edit to the package is requested only if a knob is missing (G-6) | owner |
| K12 | Users' policy files with `.` ids stop loading | certain | medium | loader message names the new id; migrate command (R10) | owner (BA-5 decided) |
| K13 | `serve` spawns the upstream before gating | certain | low | accepted risk O-2; documented in R14 | owner (decided) |
| K14 | Package boundary: R5 promotes orchestration into core-client, duplicated by `entrypoint/backlog` until R13 | certain | low | R13 gated; duplication recorded | owner |
| K15 | Cache and extractor disagree about dependencies, or an extractor omits `files` | medium | medium | one source of truth: the extraction result; T-R5 and T-R8p assert `files` for the TS extractor; an extractor reporting nothing yields a source-only key | implementer |
| K16 | D1 terminal bypasses the default `dispatch` path for TS operations | low | high | the terminal is selected only when supplied; T-D1 asserts the default path unchanged | implementer |

---

## 9. Owner decisions

### Decided

| ID | Decision | Value | Segments |
| --- | --- | --- | --- |
| G-1 | The gateway routes by `binding ?? host`; the edit to `apigen-engine-gateway/src/lib/gateway.ts` (~590-591) is in scope | `req.operation.binding ?? req.operation.host` | R7b |
| G-2 | IR generation is centralized in apigen-core-client (the orchestration entry promoted from `entrypoint/apigen-cli` `orchestrator.ts` `extractSource`). The extraction result carries the IR and the files the extractor read; each extractor reports its own dependencies. `apigen-plugin-ir-cache` keys, stores and validates, takes the dependency list from the result, and does not walk imports (`collectLocalImportPaths` leaves the cache path). The IR artifact baked for the policy wrapper (R12) is the artifact the cache stores, produced by the same function. Backlog 39c4e00c and a66aca5d get regression tests that fail if the bugs return | R8p, in the same step as the orchestration entry, before R12 and before any reliance on the cache | R5, R8p, R8, R12 |
| G-5 | Readers of `content[0].text` in `dispatch-orchestrator` (`agent-runner.ts:499`), `agent-plugin-budget`, `agent-mcp` and the `backlog` e2e suites are in scope; each is audited first and edited only where a raw string breaks it | audit table, then targeted edits | R15 |
| G-7 | BA-4: every `ApiError` code (`permission_denied`, `unauthenticated`, `not_found`, `invalid_argument`, gateway unavailable, plain `internal`) returns a tool result with `isError: true`; JSON-RPC protocol errors remain only for unknown tools, malformed requests and thrown non-`ApiError` values | adhd ADR-0018 D2 | R4 |
| G-11 | The three ADRs and the names `binding`, `tool`, `_meta["adhd/error"]` | adhd ADR-0017, 0018, 0019 | R0, R1, R4 |
| D1 | The binding-aware dispatch terminal for flat arguments is in the first slice, built with the orchestration entry and `Operation.binding` | `Terminal`, `createInvoker(layers, { terminal })` | D1, R5, R7b |
| serve | `adhd-policy serve bin:<executable>` uses `serveMcpPassthrough` as the degenerate proxy target; tool names are projected through the standard BA-1 projection | — | R7b, R9 |
| D-24 | Telemetry retention | 14 days and 100 MB per file; configuration values, not a feature toggle | R9 |

### Open

| ID | Item | Why it blocks | Proposed default (pending owner confirmation) |
| --- | --- | --- | --- |
| G-3 | Backlog entrypoint migration R13 (`entrypoint/backlog` is not approved beyond the G-5 reader audit) | nothing on the critical path | R13 is not started; `entrypoint/backlog` stays outside this slice and keeps its duplicated `buildBacklogApigenPackage` until the owner approves R13. |
| G-4 | `apigen-base-logical` edit, only if dispatch cannot pass a `resolve()` override to the transcoder | R3 `$ref` resolution | no `apigen-base-logical` edit; dispatch resolves `$ref` inside apigen-engine-runtime (landed in R3, 24156bf8). |
| G-6 | `@adhd/sox-telemetry` edit, only if its file-mode, disable or retention knobs are missing (the retention values are decided under D-24) | R9 D-24 | no `@adhd/sox-telemetry` edit; R9 uses the knobs the package exposes and records any missing knob as a backlog deferral. |
| G-8 | Confirm E2 stays unadopted | scope | E2 stays unadopted. |
| G-9 | createLayer reach: fastify, express and cli-output targets are not approved; the plan reaches them through `loadUsePlugins` materialisation in apigen-cli (R5) without editing them. Confirm that this boundary is acceptable | R5 | the boundary is accepted: fastify, express and cli-output receive configured layers through apigen-cli `loadUsePlugins` materialisation (R5) and are not edited. |
| G-10 | INTERFACES supersessions (D-07, D-08, D-14, D-18, D-19, D-20, D-21) | R14 | INTERFACES D-07, D-08, D-14, D-18, D-19, D-20, D-21 are marked superseded in R14; D-04/U12 kept. |

---

## 10. UNVERIFIED register

Each item was not read, or could not be confirmed from code; the segment that first depends on it confirms it before editing.

1. Whether `_transcoder.decode`/`encode` in `apigen-engine-runtime/src/lib/dispatch.ts` accept a ctx `resolve()` override (R3; G-4).
2. The `StdioServerTransport` constructor's stream arguments in the installed MCP SDK (R4).
3. How the TS extractor obtains the resolved tsconfig `extends` chain from its program (R8p; 9025607e; T-R8p pins the outcome).
4. Where the `@nx/js:library` template injects `type`/`exports` into a scaffolded `package.json` (R11a).
5. Whether `@adhd/sox-telemetry` exposes file mode, disable and retention options for the decided values (R9; G-6 opens only if a knob is missing).
6. Whether each listed reader of `content[0].text` reads a string-returning apigen tool (R15 audits each before any edit; G-5).
7. The rendered BA-1 projected tool-name format for `serve` and `serve bin:` (R7b; T-R9 pins it).
8. Whether `ExtractionSession.dispose()` releases ts-morph memory (R8).
9. Whether any reader of `descriptor.schema.json` rejects unknown properties (R1).
10. `naming.ts:155-156` (`<source>_<tool>` aggregator naming) is cited from TAXONOMY item 8, not opened for this plan.
11. The exact `policy run` argv form used in T-R9 (`--input` CLI form per T18); T18 reconciles it.
12. Whether unifying the mount-branch `Extensions` with `LayerContext` (R3 behaviour change 3) needs a core-client type change.

---

## 11. Closing segments

### R14 — documentation (fce1647f)

As specified in §3 R14. DoD: both new files exist, every `tool:` example in them loads through `policy check` on a fixture, and every flag they name appears in `policy --help` output. Control: a deliberately `.`-separated example fails the doc-example test.

### T18 — demo reconciliation, DONE.md, final gates

- Reconcile `tickets/T18.md` demo commands to the `--input` CLI form; each demo command is run and its exit code recorded.
- Write `docs/plan/policy-core/DONE.md`: every segment, its commit, its evidence table, its gates.
- Final gates, all exit 0:
  - `npx nx affected -t lint,typecheck,typecheck-spec`
  - `npx nx affected -t test`
  - `npx nx run apigen-plugin-policy:verify-dist-load`, `npx nx run policy-core-client:verify-dist-load`, `npx nx run policy:verify-dist-load`, and `verify-dist-load` for every other changed publishable package (apigen-core-client, apigen-engine-runtime, apigen-plugin-mcp, apigen-engine-gateway, apigen-cli).
