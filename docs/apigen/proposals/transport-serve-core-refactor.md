# Proposal: Transport-Neutral Serve-Core + Thin Adapters

**Status:** v0.2 draft (revised — see §9 Revision Notes)
**Date:** 2026-07-23 (v0.1) / 2026-07-23 (v0.2 revision)
**Scope:** `packages/apigen/apigen-engine-runtime`, `apigen-engine-naming`, every `apigen-plugin-*` transport, `packages/apigen/python`, and each plugin's `generate.ts`.
**Non-goal:** any change to the on-the-wire contract for existing consumers. Byte-identical output is the acceptance bar (see §6 for how that is proven, not just asserted).

---

## 1. Problem / evidence

Every apigen transport plugin re-implements the **full serve loop** — request→args, verb/route derivation, validate, dispatch, response encoding, error mapping, mount handling — instead of delegating it. Because the loop is copied N times, the *same* divergence has to be fixed N times.

**Correction (v0.2):** v0.1 framed the five bugs below as *currently open*, evidencing "this session fixed it five times." That overstates the present state. Per `BACKLOG.md:1173-1181`, `BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001` is **RESOLVED as of 2026-07-23** across all five transports — each transport now imports/re-derives `project()` via its own shim module. The bug isn't open; the *shim* is. What actually remains, verified by reading the current code:

- **Route / tool-name derivation is now centralized *per call site*, but the call site itself is duplicated 4 ways + reimplemented once in Python.** Four structurally-identical TS shim modules exist purely to correlate `(pkgId, fnName)` back to a real `Operation` and call `project()` on it: `apigen-plugin-api-fastify/src/lib/route-projection.ts` (`resolveRoute`/`resolveOperation`, lines 64-110), `apigen-plugin-api-express/src/lib/route.ts` (`resolveRoute`/`buildOperationIndex`/`synthesizeOperation`, lines 59-139), `apigen-plugin-mcp/src/lib/tool-naming.ts` (`deriveToolName`/`findOperation`, lines 50-145), and an inline `project(op).cli.path` call in `apigen-plugin-cli-output/src/lib/run.ts:137`. All four hand-roll the same "index `Operation[]` by `${namespace}:${terminalSegment}`, fall back to a synthesized single-segment `Operation` when none is supplied" logic. `packages/apigen/python/apigen_python/flask_server.py:252-314` carries a fifth, **necessarily** independent copy (`_route_for_op`/`_is_primitive_only_input_schema`/`_http_verb`) — Python cannot import the TS package, so this one is architecturally unavoidable *unless* the plan itself crosses the process boundary as data (§3d/§5 Phase 3 below).
- **`BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001` is genuinely OPEN** (`BACKLOG.md:1184-1190`, confirmed 2026-07-23 against `@adhd/backlog`'s live server: 11 of 14 GET-hoisted routes mutate state, including `mergeItems`/`softDeleteItem`). **This is a correction, not a duplication, bug** — `project()`'s own hoist rule (`naming.ts:150-151`, `isPrimitiveOnlyInputSchema(op.input)` promotes to GET regardless of safety) is wrong at the single source of truth. Centralizing consumption of `project()` does **not** fix this bug — every transport already calls the same (wrong) rule via the shims above. See §5 "Known-bug composition" for what this refactor does and does not do about it.
- **`--use` mount metadata is dropped per plugin** — confirmed still present in the current fastify/express `run.ts` (not previously fixed): `MountRoute { route; handler }` (`apigen-plugin-api-fastify/src/lib/run.ts:172-175`, mirrored in `apigen-plugin-api-express/src/lib/run.ts:165-168`) discards everything on `MountedOperation` (`apigen-core-client/src/lib/plugin.ts:359-375`) except `id` and `handler`; both `collectMountRoutes` functions (`fastify:189-210`, `express:182-203`) hardcode every mount route to `{ method:'GET', text:'', params:[] }` at the call site (`fastify:378-392`, `express:329-346`). No existing BACKLOG item tracks this specifically — v0.1 called it "already scoped" without a citation; there is none. It is filed fresh in §7/Part 2 below (`DEBT-APIGEN-SERVE-CORE-004`).
- **`generate.ts` and `run.ts` duplicate routing *within* each plugin** — `DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001` (RESOLVED per `BACKLOG.md:1181`/`CHANGELOG.md:22`) already threaded `PluginInput.operations` into both `orchestrateGenerate`/`orchestrateRun`, so `generate()` and `run()` share an `Operation[]` source — they still each re-run `project()`/the shim's correlation logic independently, but on the same input.
- **The `apigen serve` front proxy assumed a flat route shape** — `BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001` (CHANGELOG.md:26, **OPEN**, explicitly deferred/unfixed) — the front proxy forwards `/<namespace>/<op>` verbatim assuming a single-segment child route; post-canonicalization every op carries a file segment too, so it now double-segments (`/<ns>/<ns>/<op>`).

**New findings from reading the runtime (not in v0.1):**

- **`apigen-plugin-mcp/src/lib/run.ts` never composes `createInvoker`/`makeValidateLayer` at all.** Its `CallToolRequestSchema` handler calls `dispatch()` directly (`run.ts:143-154`; no `createInvoker`/`makeValidateLayer` import anywhere in the file's import list, `run.ts:1-22`). Every other transport (fastify `run.ts:298`, express `run.ts:244`, cli-output `run.ts:394`) validates input via `makeValidateLayer` **before** dispatch (SPEC §6/§8.1 rule 1). MCP does not. This is a live correctness gap: malformed MCP tool input reaches the domain function unvalidated, and no `--use` layer plugin (auth, logging, rate-limiting) can wrap an MCP call today. Filed as `BUG-APIGEN-SERVE-CORE-001` (Part 2).
- **Streaming (SPEC §11) is built but unwired for HTTP and MCP.** `apigen-engine-runtime/src/lib/stream.ts` (`createStream`/`isApiStream`, lines 101-227), `apigen-plugin-api-fastify/src/lib/stream.ts` (`sendStreamSse`, lines 76-148), and `apigen-plugin-mcp/src/lib/stream.ts` (`projectStreamMcp`/`projectStreamMcpFull`, lines 77-165) all exist and are exported (`apigen-plugin-api-fastify/src/index.ts:5`), but neither `run.ts` ever calls `isApiStream`/`sendStreamSse`/`projectStreamMcp` on the invoker's result — confirmed by grep: the only non-dist, non-spec references to `sendStreamSse`/`projectStreamMcp` are their own re-export lines. A `streaming:true` operation's `ApiStream` return value is today handed straight to `JSON.stringify()`/`reply.send()` — garbage output, not a graceful failure. v0.1 doesn't mention streaming at all; a serve-core rewrite must either wire this dead code live or explicitly defer it (§5, §8). Filed as `DEBT-APIGEN-SERVE-CORE-002`.
- **CLI's request→args extraction is not query/body — it's an argv flag table** (`apigen-plugin-cli-output/src/lib/run.ts:195-315`: `buildFlagTable`/`parseArgs` — kebab flag names, boolean `--no-` negation, JSON-typed flags, envelope env-var fallback via `envelopeCliFlag`/`envelopeEnvVar`). This is materially different from HTTP's query-vs-body split and MCP's `args.data`/`_meta` split; the "one `paramBinding: ParamInfo[]`" sketch in v0.1's `OpPlan` doesn't carry enough to drive it. See §3a.
- **py-flask's Python process never receives a TS-computed `Operation[]` at all** — confirmed in `apigen-plugin-py-flask/src/lib/plugin.ts:15-26` (module doc) and `run()` (`plugin.ts:108-182`): the TS plugin does nothing but resolve a module path and spawn `python3 -m apigen_python.flask_server --module <path> --namespace <ns>`; the Python process does its **own** independent extraction (`flask_server.py:572-580` calls `extract_module()`). There is no TS-side `Operation` to compute a plan from, and no existing IPC channel to send one down even if there were. "Inject the plan into py-flask as data" (v0.1 §3d) is not a small change — it requires a **new** two-phase extraction/serve split. See §5 Phase 3 for the corrected design.

Every one of these remaining issues is the *same* structural defect: the projection from `Operation` → wire is re-authored (or, for MCP, partially skipped) in each plugin, so they drift or diverge in capability, not just in correctness.

---

## 2. Current architecture — what is and isn't centralized

**Already centralized (good):**
- **Naming/projection** — `@adhd/apigen-engine-naming`'s `project(op, config?)` returns a `TransportProjection` (`naming.ts:94-121`): `{ http:{verb,route}, mcp:{name}, grpc:{package,service,method}, cli:{path[]} }`, with verb `safe→GET / !safe→POST` plus the FEAT-APIGEN-022 primitive-only-input hoist (`naming.ts:150-151`) — **this hoist rule is the source of `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001`; centralization does not make it correct, only consistently wrong** (§1, §5).
- **Envelope key derivation** — `envelopeKey`/`envelopeCliFlag`/`envelopeEnvVar`/`envelopeMetaKey` (`naming.ts:360-405`) compute the canonical `x-<pluginId>-<field>` / `--<pluginId>-<field>` / `APIGEN_<PLUGINID>_<FIELD>` forms. **Centralized as leaf functions, but the *walk* that discovers which envelope fields exist per-op (`schema.input.properties`, excluding `data`, cross-referenced against `x-apigen-envelope`) is reimplemented 4 times**: `extractEnvelopeFromHeaders` (near-identical in `apigen-plugin-api-fastify/src/lib/run.ts:46-66` and `apigen-plugin-api-express/src/lib/run.ts:39-59`), `extractEnvelopeFromMeta` (`apigen-plugin-mcp/src/lib/run.ts:34-54`), `envelopeBindings` (`apigen-plugin-cli-output/src/lib/schema-introspect.ts`, consumed at `run.ts:206-223`), and Python's `_extract_envelope` (`flask_server.py:187-232`).
- **Invoke/dispatch primitives** — `@adhd/apigen-engine-runtime` exports `createInvoker`, `LayerContext`, `makeValidateLayer`, `dispatch`, `needsEnvelopeField`, `dataParamNames`, `describeParams`, `coerceQueryParams`, `buildFnTable`, `buildContext`, `defineMiddleware`, `EventBus`/`wireObservers`, and (unwired, see §1) `createStream`/`isApiStream` (`apigen-engine-runtime/src/index.ts:1-67`).
- **`--use` layer/mount composition** — `buildInvokerForPackage` (near-identical in `apigen-plugin-api-fastify/src/lib/run.ts:153-166` and `apigen-plugin-api-express/src/lib/run.ts:146-159`) wraps `--use` layer plugins around `makeValidateLayer`. **MCP has none of this (§1); CLI has no `--use` support at all** (`cli-output/src/lib/run.ts` never reads `usePlugins`/`useOptions`).

**NOT centralized (re-done in every plugin, or missing entirely):**
- **request → args extraction** — three genuinely different shapes: HTTP query-string-vs-`{data:{…}}`-body (fastify/express), MCP's `args.data` + `args._meta` tool-call envelope, and CLI's argv flag table (§1). Not a single "query vs body" split as v0.1 implied.
- **response → canonical-JSON encoding** — `sendJson` (`apigen-plugin-api-fastify/src/lib/run.ts:227-230`) vs express's inline `res.json(result)` (no `undefined→null` normalization — a **latent parity gap**: fastify pins `application/json` and normalizes `undefined→null`; express's `res.json(undefined)` sends HTTP 204 with an empty body, not `null`. Filed as `DEBT-APIGEN-SERVE-CORE-003`).
- **`ApiError` → transport status / error-code mapping** — `toHttpStatus` duplicated verbatim in fastify (`run.ts:72-80`) and express (`run.ts:65-73`); MCP swallows the code entirely (`run.ts:169-171`: computes `MCP_ERROR_KIND['internal']` into an unused local, then just re-throws — the mapping table exists but is dead code here too); CLI's `CLI_EXIT_CODE` mapping (`run.ts:321-327`) is its own thing (necessarily — exit codes aren't HTTP statuses).
- **`--use` mount handling** — the lossy `MountRoute` (§1), and mount ops **bypass the composed invoker entirely**: `app.get(m.route, async (req) => { … return m.handler(call) })` (`fastify run.ts:380-391`, `express run.ts:331-345`) calls `handler(call)` directly, never through `invoke()` — so `--use` layer plugins (auth, logging) never wrap a mount op today, unlike a source op. This is a **behavior difference**, not just a metadata-fidelity gap (see §3e).
- **the route/tool registration loop** — iterating ops and calling `app.get`/`app.post`/`server.tool`/argv-matching.
- **codegen templates** — each `generate.ts` re-emits the routing in framework-specific source, and — like `run.ts` — re-derives route/verb via its own shim module rather than a precomputed plan.

So the primitives exist for HTTP+CLI; MCP is missing the validate/layer primitive entirely; streaming exists but is disconnected everywhere; and what's missing across the board is a **composition layer** that assembles the primitives into one request lifecycle plus a **port** that reduces each plugin to marshaling.

---

## 3. Proposed architecture

### 3a. Unified op→wire "plan" (`OpPlan`)

Resolve each `Operation` (+ its composed schema, when one exists) **once** into a transport-complete plan — an extension of `TransportProjection`. **Revised from v0.1**: the `paramBinding: ParamInfo[]` sketch under-specified CLI (whose binding is a flag table, not a param list) and left envelope-field discovery uncentralized. Corrected shape:

```ts
interface OpPlan {
  op: Operation;                    // or the MountedOperation for a mount op — see §3e
  http: { verb: HttpVerb; route: string };
  mcp:  { name: string };
  cli:  { path: string[] };
  grpc: { package: string; service: string; method: string };

  // Domain param shape — already cheap via describeParams(schema); kept as-is,
  // NOT reinvented. Absent for mount ops with no ComposedSchemas entry (§3e).
  params?: ParamInfo[];             // describe-params.ts's existing return

  // NEW vs v0.1 — the envelope-field WALK, not just the key-computation leaf
  // functions naming.ts already centralizes (envelopeKey/CliFlag/EnvVar).
  // Computed once from schema.input.properties (excluding 'data') + the
  // x-apigen-envelope pluginId map; each entry carries every transport's
  // binding key precomputed so no adapter re-derives envelopeKey() itself.
  envelope: Array<{
    field: string;
    pluginId: string;
    httpHeader: string;   // envelopeKey(pluginId, field)
    mcpMetaKey: string;   // envelopeMetaKey(pluginId, field) (alias of httpHeader today)
    cliFlag: string;      // envelopeCliFlag(pluginId, field)
    envVar: string;       // envelopeEnvVar(pluginId, field)
  }>;

  // NEW vs v0.1 — CLI's flag table cannot be derived from `params` alone
  // (kebab-casing + boolean/json valueKind + --no- negation are CLI-specific).
  // Precomputed once so cli-output's adapter is pure argv-walking, matching
  // apigen-plugin-cli-output's existing buildFlagTable() shape (run.ts:195-223).
  cliFlags: Map<string, { camelKey: string; kind: 'domain' | 'envelope'; valueKind: 'boolean' | 'json' | 'string' }>;

  streaming: boolean;               // op.streaming — drives dispatch/write branching, §3b/§3c
  isMount: boolean;                 // true for a --use mount op
  mountHandler?: (call: Call) => unknown | Promise<unknown> | AsyncIterable<unknown>;  // only when isMount
}
```

One source of truth for "how does this op hit the wire," built from `project(op)` + the composed schema (when present) + the envelope/flag derivation above. Computed once per op at plugin-instantiation time (`run()`/`generate()` entry), never per-request and never per-plugin.

**Correction vs v0.1 (§3e):** "mount ops produce a full `OpPlan` too — no degenerate GET/no-params special case" is *mostly* right but glosses over two real asymmetries: (1) a mount op has no `ComposedSchemas` entry, so `params` is derived directly from `MountedOperation.input`, not looked up in `pkg.schemas`; (2) dispatch for a mount op calls `op.handler(call)` directly, never the fn-table `dispatch()` — serve-core's dispatch step needs an explicit branch (`isMount ? mountHandler(call) : dispatch(fns, …)`), not an assumption that both paths converge. Whether a mount op should now be wrapped by `--use` layer plugins (a **behavior change** from today's bypass, §2) needs an explicit decision — recommended: yes, wrap it, since `makeValidateLayer` already no-ops gracefully on a schema-less operation (`validate-layer.ts:231-235`, `schemas[fnName] === undefined → next()`), so the only observable change is that `--use` layers (e.g. an auth layer) now also see mount-op calls, which is very likely the *intended* behavior, not a regression — but call it out in the phase 0/1 DoD as an explicit, reviewed behavior change, not an implicit side effect.

### 3b. Transport-neutral serve-core (`apigen-engine-runtime`)

**Correction vs v0.1:** v0.1's `serveOperation(plan, ctx, req: NeutralRequest): Promise<NeutralResponse>` invents a new `NeutralRequest`/`NeutralResponse` pair shaped like an HTTP request (method/path/query/body/headers ↔ status/body/headers). That shape doesn't fit MCP (no method/path/query) or CLI (no headers; argv instead), and it **duplicates a struct that already exists and is already transport-neutral**: `Call` (`apigen-engine-runtime/src/lib/invoke.ts:68-82` — `{ operation, ctx, envelope, domainArgs, signal }`, plus the SPEC §7.1 `Call` in `apigen-core-client/src/lib/plugin.ts:87-117` which additionally carries a `raw?: unknown` escape hatch, line 111-116, for exactly the cases a neutral struct can't express). Every adapter's real job — confirmed by reading fastify/express/mcp/cli's `run.ts` — is:

1. **Read**: raw framework request → `{ envelope, domainArgs, signal }` (already `Call` minus `operation`/`ctx`). This is transport-specific (query+coerce vs body vs `args.data`+`_meta` vs argv-parse) and **stays** in the adapter — it is exactly what `coerceQueryParams`/`extractEnvelopeFromHeaders` (HTTP), `extractEnvelopeFromMeta` (MCP), and `parseArgs` (CLI) already do.
2. **Invoke**: pass the `Call` to the composed invoker (`createInvoker([...usePluginLayers, makeValidateLayer(schemas)])`) — this part is **already** transport-neutral runtime code (`invoke.ts:176-209`); nothing new needed except building the invoker **once per package** (as fastify/express already do) rather than per-op, and applying it to MCP for the first time (§1 finding).
3. **Write**: result/error → raw framework response. Also transport-specific: `JSON.stringify` + `application/json` (HTTP), `{content:[…], structuredContent}` (MCP), `console.log`/exit code (CLI). **Cannot be neutralized further** — there is no common "status/body" shape across HTTP status codes, MCP `isError`/`structuredContent`, and CLI exit codes that isn't already `ApiError`/`ApiErrorCode` itself (which the adapter already receives untouched).

So the serve-core's actual, minimal job is **not** a `serveOperation(plan, ctx, req)` black box that owns request/response marshaling — it's the piece that was *already* transport-neutral (steps 2) plus package-level invoker composition, exposed as a small factory:

```ts
// apigen-engine-runtime — NEW, composes what run.ts currently inlines per-plugin
function createPackageInvoker(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[]           // shared UsePlugin/adaptCoreLayer/readUsePlugins/readUseOptions,
): InvokeFn                          // currently duplicated verbatim in fastify+express run.ts

// dispatches EITHER through the fn table OR a mount handler, branching on OpPlan.isMount —
// this is the one new piece of dispatch logic serve-core adds beyond what invoke.ts already has.
function dispatchForPlan(
  plan: OpPlan,
  invoke: InvokeFn,
  call: Omit<Call, 'operation' | 'ctx'>,
  opts: InvokeOptions
): Promise<unknown> | AsyncIterable<unknown>
```

`createPackageInvoker` absorbs `buildInvokerForPackage`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer` (byte-identical today between fastify and express — `run.ts:91-166` in both files) into one exported function. `dispatchForPlan` absorbs the mount-vs-source branch (§3a) and the streaming-vs-scalar result shape (`isApiStream(result)` check, currently performed nowhere — §1) into one place, returning the union type `invoke.ts`'s own `Next`/`LayerResult` already models (`Promise<unknown> | AsyncIterable<unknown>`, `invoke.ts:94-102`) rather than inventing a new streaming-incompatible signature.

### 3c. Minimal `TransportAdapter` port

**Revised from v0.1** (dropping the invented `NeutralRequest`/`NeutralResponse`, per §3b):

```ts
interface TransportAdapter<Raw = unknown> {
  /** Register one op; `dispatch` is `dispatchForPlan` bound to this op's invoker. */
  registerRoute(
    plan: OpPlan,
    dispatch: (call: Omit<Call, 'operation' | 'ctx'>) => Promise<unknown> | AsyncIterable<unknown>
  ): void;

  /** Raw framework request → the neutral Call shape. Transport-specific (query/body/argv/tool-args). */
  readCall(raw: Raw, plan: OpPlan): Omit<Call, 'operation' | 'ctx'> | Promise<Omit<Call, 'operation' | 'ctx'>>;

  /**
   * Write a successful result. MUST branch on `plan.streaming`/`isApiStream(result)`:
   * scalar → JSON write (HTTP)/content envelope (MCP)/stdout (CLI); stream → SSE frames
   * (HTTP, via the already-built-but-unwired sendStreamSse) / progressive content (MCP,
   * via projectStreamMcp) / not supported (CLI, py-flask — must reject explicitly, not
   * silently stringify an AsyncIterable).
   */
  writeResult(raw: Raw, result: unknown | AsyncIterable<unknown>, plan: OpPlan): void | Promise<void>;

  /** Map + write an ApiError. HTTP: status+JSON via HTTP_STATUS. MCP: isError content. CLI: exit code. */
  writeError(raw: Raw, err: unknown, plan: OpPlan): void | Promise<void>;
}
```

Flagged gaps a real transport needs that this port must still accommodate explicitly, not silently drop:

- **Streaming/SSE** — `writeResult` needing the raw framework object (`reply.hijack()` in `apigen-plugin-api-fastify/src/lib/stream.ts:147`) is why `Raw` stays a generic escape hatch rather than being abstracted away — SSE cannot be expressed as "write this neutral response object," it needs direct control of the wire.
- **MCP's tool-call envelope vs HTTP body** — `readCall` for MCP reads `args.data`/`args._meta` (`run.ts:127-139`), not a body; this is why `readCall` takes the *raw* framework request, not a pre-normalized "NeutralRequest."
- **CLI argv** — `readCall` for CLI is `parseArgs(rest, plan.cliFlags)` (§3a); no per-request object at all, `Raw` is the resolved argv slice.
- **py-flask/py-grpc** — do **not** implement this port; they remain code *emitters* (§3d) that consume `OpPlan` data across a process boundary, not an in-process `TransportAdapter`.
- **Per-request context / cancellation** — already solved by `Call.signal` (`invoke.ts:81`) and the `raw?: unknown` escape hatch on the core-client `Call` (`plugin.ts:111-116`); no new mechanism needed.

`api-fastify` and `api-express` become **near-identical adapters** differing only in `req`/`reply` vs `req`/`res` API — this claim from v0.1 holds and is now *stronger* than stated: reading both `run.ts` files side by side shows `extractEnvelopeFromHeaders`, `toHttpStatus`, `UsePlugin`/`adaptCoreLayer`/`buildInvokerForPackage`/`readUsePlugins`/`readUseOptions`, `collectMountRoutes`, and the `MountRoute` interface are **byte-identical** between the two files today (only route registration syntax and `reply.send`/`res.json` differ) — this refactor doesn't just reduce duplication, it deletes an already-existing exact duplicate.

### 3d. Codegen consumes the same plan

Each `generate.ts` renders its framework's source **from the `OpPlan`**, not from a re-derivation, closing the last `generate()`/`run()` duplication gap (§1). For py-flask/py-grpc, **the plan must cross a process boundary as data — this requires new plumbing, corrected from v0.1's "inject the plan into the emitters" framing**, which implied it was a simple data-passing change:

Today (`plugin.ts:108-182`), the TS `py-flask` plugin never extracts Python operations — it spawns `python3 -m apigen_python.flask_server --module <path> --namespace <ns>` and the Python process does its own extraction (`flask_server.py:572-611`, `extract_module()`). To inject a TS-computed plan, this must become a genuine **two-phase** flow:

1. **Extract-only mode**: `apigen_python.extractor.extract_module()` already emits the same `{raw, words}` Segment-shaped JSON the TS extractor produces (documented in `flask_server.py`'s module docstring, `flask_server.py:14-27`, as byte-for-byte mirroring the TS tokenizer). Add a CLI mode (`python3 -m apigen_python.extractor --module <path> --namespace <ns> --emit-json`) that runs extraction only and prints the `Operation[]` JSON to stdout, without starting a server.
2. **TS-side projection**: the TS `py-flask` plugin spawns step 1, parses its stdout as `Operation[]`, and calls the **real** `project()` (`naming.ts:143-177`) on each — no Python involved in verb/route computation at all.
3. **Serve with precomputed plan**: `flask_server.py`'s `_ServerState`/`_build_state` (currently lines 332-356/572-611) is changed to accept a `--plan <path-to-json>` argument carrying `{op, route, verb}` triples and build `route_map` directly from it, instead of calling `extract_module()` + `_route_for_op()`/`_http_verb()` a second time. `_route_for_op`/`_is_primitive_only_input_schema`/`_http_verb` (`flask_server.py:247-314`) are deleted entirely — this is the actual "kill the TS↔Python drift risk" outcome v0.1 promised, but it requires this extract/serve split, not just "pass the plan as data" to the existing single-phase server.

This is real, additional scope beyond a data-injection wrapper — call out its cost explicitly in planning (§5 Phase 3, §7 effort). The payoff is still correct: once done, the Python side carries **zero** re-derived projection logic, only a route-table lookup, and the byte-identical guarantee no longer depends on a human/agent manually keeping two independently-authored algorithms in sync.

### 3e. Everything is an `Operation`

Composes with two adjacent changes:
- **`--use` full-operation fix** (§3a, §7 `DEBT-APIGEN-SERVE-CORE-004`): mount ops keep `kind`/`safe`/`input`/`text` and flow through `dispatchForPlan`'s mount branch — the `MountRoute` bottleneck (`fastify run.ts:172-210`, `express run.ts:165-203`) is deleted, and (decision needed, §3a) mount ops start flowing through `--use` layer composition like source ops.
- **(Optional, larger — see §5 Phase 4 verdict: PARK) model `--source` itself as a built-in ts-extraction *source-plugin*.**

---

## 4. What each plugin becomes

| Concern | Today (per plugin) | After |
|---|---|---|
| route/verb derivation | re-wrapped `project()` via 4 near-identical shim modules + 1 Python reimplementation | read `plan.http`/`plan.mcp`/`plan.cli` |
| envelope field discovery | reimplemented 4 ways (`extractEnvelopeFromHeaders`×2, `extractEnvelopeFromMeta`, `envelopeBindings`, `_extract_envelope`) | read `plan.envelope` |
| arg parse (query/`{data}`/argv/tool-args) | per plugin | **adapter** (`readCall`) — genuinely transport-specific, stays |
| validate → dispatch | wired per plugin (fastify/express/cli); **missing entirely for MCP** | serve-core (`createPackageInvoker` + `dispatchForPlan`), now uniformly including MCP |
| response encode | per plugin (express has a latent `undefined`-handling gap vs fastify, `DEBT-APIGEN-SERVE-CORE-003`) | **adapter** (`writeResult`) — genuinely transport-specific, stays, but now consistent by construction since both HTTP adapters share one base |
| error → status/code | per plugin (MCP computes but discards the mapping) | **adapter** (`writeError`), now uniformly applied to MCP too |
| streaming | built (`stream.ts`×2) but unwired for HTTP+MCP; absent for CLI/py-flask | wired for HTTP+MCP via `writeResult`'s stream branch; explicitly rejected (not silently mis-serialized) for CLI/py-flask |
| `--use` mount | lossy + bypasses invoker, per plugin | full `OpPlan`, routed through `dispatchForPlan`'s mount branch and (decision, §3a) the composed invoker |
| framework req/res | per plugin | **adapter (stays)** |

**LOC evidence (not illustrative — measured):** `api-fastify/src/lib/run.ts` is 405 lines; `api-express/src/lib/run.ts` is 387 lines. Diffing the two shows `extractEnvelopeFromHeaders` (21 lines), `toHttpStatus` (9 lines), the `UsePlugin`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer`/`buildInvokerForPackage`/`MountRoute`/`collectMountRoutes` block (~120 lines) are line-for-line identical between the two files today — that block alone is the single largest concrete, measured duplication this refactor deletes, independent of route-derivation.

---

## 5. Phased migration (each phase independently shippable, parity-gated)

**Reordering vs v0.1**, based on the findings above:

- **Phase 0 — DROPPED as a standalone phase; folded into Phase 1.** v0.1's Phase 0 ("`--use` full-operation + mount-metadata fix... small, local, no core refactor") would edit the exact `fastify`/`express` `run.ts` code Phase 1 is about to delete and replace with an adapter — shipping it standalone is throwaway work. Worse, "mcp/cli gain mount support to reach parity" (v0.1) is **not small**: MCP has no invoker composition to attach mount support to yet (§1 finding) — building that scaffolding once, in Phase 1's `createPackageInvoker`/`dispatchForPlan`, and having every transport's migration pick it up for free, is strictly less total work than building it twice (once as a point-fix, once again when Phase 2 migrates MCP). Mount full-fidelity is a Phase 1/2 **design requirement** (§3a, §3e), not a precursor phase.
- **Phase 1 — extract serve-core (`OpPlan`, `createPackageInvoker`, `dispatchForPlan`) + `TransportAdapter` in `apigen-engine-runtime`; migrate `api-fastify` as the reference adapter, including full mount fidelity and wiring the existing-but-dead `sendStreamSse` live.** **Parity gate:** see §6. Fastify is the right reference: it already has full `--use` composition (§2) and the only working (if unwired) streaming projection, so it exercises the whole port surface.
- **Phase 2 — migrate `api-express` (collapse onto the shared adapter, closing `DEBT-APIGEN-SERVE-CORE-003`'s response-encoding gap for free), `mcp` (wiring `createPackageInvoker`/`makeValidateLayer` for the first time — closes `BUG-APIGEN-SERVE-CORE-001` — and `projectStreamMcp`), `cli-output` (adapter's `readCall`/`writeResult` become `parseArgs`/`console.log`+exit-code against `plan.cliFlags`).** Each independently parity-gated (§6) against its current output. MCP's migration is higher-risk than v0.1 implied — it is gaining validate-layer behavior for the first time, which is a **correctness fix presenting as a breaking change** (previously-accepted malformed input now rejects with `invalid_argument`); call this out explicitly in the phase's release notes, it is not pure refactor.
- **Phase 3 — unify codegen on the plan; implement the extract/serve split for py-flask (§3d) and py-grpc; remove the Python `project()` port** (`_route_for_op`/`_http_verb`/`_is_primitive_only_input_schema` in `flask_server.py`). Parity-gated against the live spawned Python server. **This phase's scope is larger than v0.1 stated** — it's a new two-phase extraction/serve protocol, not a data-injection tweak (§3d). Estimate accordingly (§7).
- **Phase 4 (§5.1 below) — PARK, do not schedule.**

### Phase 4 verdict: PARK

v0.1 asked whether modeling `--source` as a built-in ts-extraction source-plugin is worth it. Having read the code: **park it.** Reasons:
1. **No forcing function exists today.** There is exactly one TS source kind (`--source <file>` extraction) and `--use` mount plugins are already a separate, orthogonal mechanism (`MountCapability`, `plugin.ts:332-347`) that doesn't need "everything is a source-plugin" to work — it already works today, independent of this proposal.
2. **It doesn't touch the bug class this proposal fixes.** Every defect in §1 is about the `Operation → wire` projection (route/verb/envelope derivation), not about *how operations are discovered*. Modeling `--source` as a plugin changes discovery, not projection — it's a different refactor with different motivation, bundled into this one for no architectural necessity.
3. **It doesn't even unify py-flask**, the one place a second "source" conceptually exists today — Python extraction is a genuinely separate process/language boundary (§3d) that a TS `SourcePlugin` abstraction can't absorb; Phase 3's extract/serve split is the real fix for that asymmetry, and it doesn't need Phase 4's abstraction to work.
4. **Cost is real, non-trivial, and speculative** — reworking `--source X` into "sugar for a built-in source-plugin" touches the orchestrator's descriptor-building path (`entrypoint/apigen-cli/src/lib/orchestrator.ts`), which every other phase also depends on; doing it without a second real source-plugin consumer in flight is pure speculative generality (YAGNI, `AGENTS.md` §Architectural principles).

**Revisit condition:** if/when a second TS-side source kind (e.g. a proto-file source, a decorator-annotation source, or a "read `--use` mount ops as pseudo-sources for `apigen generate`") is actually proposed with a concrete consumer, re-open Phase 4 as its own proposal scoped to that consumer's real requirements.

---

## 6. Parity as the gate — concrete mechanism

v0.1 asserted "byte-identical, mandatory regression tests against live spawned servers" without specifying the mechanism. Concretized:

1. **Golden fixture set** (shared across all transports, extending existing fixtures rather than inventing new ones): reuse `apigen-plugin-api-fastify`/`apigen-plugin-api-express`'s existing multi-op TS fixtures (the `client-d`/`backlog`-shaped ones already exercised by `plugin.spec.ts`/`route-parity.spec.ts`) plus `apigen-plugin-py-flask/src/test/fixtures/test_api.py`/`decimal_api.py`. The set MUST cover, per op-class: (a) safe/scalar-only (GET-hoist path), (b) unsafe/mutating with a scalar-only input (the `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001` shape — included so the gate visibly does NOT silently fix it, per §5), (c) a `session`/envelope-bearing op, (d) a `streaming:true` op, (e) a `--use` mount op, (f) one deliberate validation-failure case and one deliberate domain `ApiError` case per op-class.
2. **Golden capture, pre-migration**: for each transport, a script drives the **current, unmigrated, live** server through its real consumer protocol — `fetch()` for HTTP, the real `@modelcontextprotocol/sdk` client for MCP, a spawned child process for CLI, `http.client`/curl for py-flask — never the plugin's internals (per `AGENTS.md` §7 "Proving an MCP server works"). Captures, per fixture op: method/route or tool-name or cli-path, full response body bytes, `Content-Type`/MCP `structuredContent` shape/CLI exit code, and the error-case status/code/exit-code. Commits the capture as JSON under `packages/apigen/<plugin>/src/test/golden/<transport>.snapshot.json`.
3. **Parity gate, post-migration**: extend the transport's existing spec (`apigen-plugin-api-fastify/src/test/plugin.spec.ts`, `apigen-plugin-api-express/src/test/route-parity.spec.ts`, `apigen-plugin-mcp/src/test/run.spec.ts`, `apigen-plugin-cli-output/src/test/run-cli-integration.spec.ts`, `apigen-plugin-py-flask/src/test/plugin.spec.ts` — all already do real-server driving per grep) with a suite that re-runs step 2's identical capture procedure against the **migrated** (adapter-based) live server and asserts deep-equality against the committed snapshot.
4. **Negative control is mandatory, not optional**, per `AGENTS.md` §7 point 2: for each phase, the migration must be reverted (or a deliberate one-line regression introduced — e.g. flip a kebab-case call) and the parity suite re-run to confirm it goes **RED**. Record this proof (commit message or a comment citing the reverted-diff run) — a parity suite that has never been shown to fail is not a gate, it's a green rubber stamp.
5. **Gate placement**: the parity suite for a transport MUST pass before that transport's phase is considered done (Phase 1 gates on fastify's suite; Phase 2 gates on each of express/mcp/cli-output independently; Phase 3 gates on py-flask's suite again, since the extract/serve split is a second, unrelated change to the same server that could reintroduce drift even after Phase 1's HTTP-side work is long done).
6. **Existing tests already prove the pattern works**: `apigen-plugin-api-fastify/src/test/plugin.spec.ts:768-1013`, `apigen-plugin-api-express/src/test/route-parity.spec.ts`, and `apigen-plugin-py-flask/src/test/plugin.spec.ts` are cited in `BACKLOG.md:1173-1181` as having already done exactly this capture-and-negative-control proof for the route-mismatch fix — this proposal's gate is that same pattern, generalized to cover the full plan (verb, envelope, mount, streaming, error mapping), not just route/verb.

---

## 7. Known-bug composition — what this refactor fixes, and what it does not

- **Fixes at the root**: route/tool-name/CLI-path drift (once, in `OpPlan`, instead of 4 shims + 1 Python port); the mount-metadata-loss + mount-bypasses-`--use`-layers gap (§3a/§3e); MCP's missing validate-layer (§1); streaming's unwired-ness (§1/§3c, if Phase 1/2 actually wire it rather than deferring — see open question §8); the express `undefined`-response encoding gap (§4, closed as a side effect of sharing one adapter base); the front-proxy double-segment bug (`BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001`) is **not directly** fixed by this refactor (it's in `entrypoint/apigen-cli/src/lib/commands/serve.ts`, outside this scope) but becomes trivially fixable once routes are read from `plan.http.route` (a single source of truth) instead of re-derived per child.
- **Does NOT fix**: `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001`. This is a correction to `project()`'s hoist rule itself (`naming.ts:150-151`), independent of how many times that rule is consumed. It should be fixed in `apigen-engine-naming` regardless of this refactor's timeline — and the parity gate (§6, fixture class (b)) is explicitly designed to make this refactor's non-effect on it visible and testable, not accidentally silent.
- **Does NOT fix**, and doesn't attempt to: `BUG-APIGEN-PYTHON-RUNTESTS-STALE-FIXTURE-PATH-001` and `DEBT-APIGEN-PYTHON-TEST-CACHE-INPUT-001` (unrelated Python test-tooling debt, both already filed and OPEN).

---

## 8. Open questions / unverifiable assumptions

1. **Should mount ops start flowing through `--use` layer composition (§3a)?** This is a behavior change (auth/logging layers now see mount calls that previously bypassed them entirely). Verified the mechanism is safe (validate-layer no-ops gracefully), not verified that every existing `--use` layer plugin in the wild tolerates being invoked for a mount op — **needs a human decision**, not an inference.
2. **Should Phase 1/2 actually wire the dead `sendStreamSse`/`projectStreamMcp` code live, or explicitly defer streaming with its own tracked gap?** Wiring it is more work inside "just build the adapter port," but shipping a serve-core rewrite that *still* silently mis-serializes a `streaming:true` op's `AsyncIterable` (current behavior) would be a known miss in a rewrite whose whole premise is "get this right once." Recommend wiring it in Phase 1 (fastify) and Phase 2 (mcp) as in-scope, not optional — but flagging because it enlarges those phases' estimated size beyond a pure refactor.
3. **py-flask/py-grpc's extract/serve split (§3d) assumes `apigen_python.extractor.extract_module()` can be safely invoked as a separate, side-effect-free process from `flask_server.py`'s own invocation of it** — not verified against `apigen_python/extractor.py`'s actual implementation (not read in this review; time-boxed out). If extraction has import-time side effects tied to the specific process that later serves (e.g., module-level state `flask_server.py`'s `_build_state` relies on beyond the returned `ops` list), the two-phase split needs adjustment. Flag before Phase 3 starts.
4. **gRPC** is listed as a `TransportProjection` target (`naming.ts:100-103`) and appears in `OpPlan`'s sketch, but no `apigen-plugin-*-grpc` TS plugin's `run.ts` was read in this review (only `py-grpc` was mentioned, not read) — the `TransportAdapter` port's fit against a real gRPC server (streaming semantics, metadata-vs-headers) is **unverified**. Do not assume gRPC parity-gates the same way HTTP does without reading `apigen-plugin-py-grpc` first.

---

## 9. Revision notes (v0.1 → v0.2)

Changed, and why:
- **Corrected bug-status framing (§1).** `BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001` is RESOLVED (`BACKLOG.md:1173-1181`), not open — v0.1's "this session fixed it five times" implied it still needed fixing. Reframed the problem as duplicated-shim debt, not open defects. `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001` confirmed genuinely OPEN and explicitly scoped as **not fixed** by this refactor (§7) — v0.1 implied the refactor addresses "this bug class" without distinguishing the two.
- **Replaced the invented `NeutralRequest`/`NeutralResponse` pair with the already-existing `Call` type** (`invoke.ts:68-82` / `plugin.ts:87-117`) as the request-side seam, and made response-writing an explicitly adapter-owned, per-transport responsibility rather than a synthesized neutral object — because no common status/body shape actually spans HTTP/MCP/CLI, and inventing one hides that instead of admitting it (§3b/§3c).
- **Added streaming as a first-class concern.** v0.1 never mentioned `stream.ts`/`sendStreamSse`/`projectStreamMcp`, all of which exist and are unwired today (§1). This is now an explicit open question (§8) and a phase-sizing input (§5), not a silent gap the rewrite would have inherited.
- **Added the MCP validate-layer gap** (§1) — MCP never composes `createInvoker`/`makeValidateLayer`, unlike every other transport. This changes Phase 2's MCP migration from "collapse onto shared adapter" to "collapse onto shared adapter AND fix a live correctness gap," which is riskier and larger than v0.1's framing.
- **Corrected Phase 3's py-flask scope** (§3d) from "inject the plan as data" to "build a new two-phase extract/serve split," since the TS side never sees a Python `Operation[]` today (`plugin.ts:15-26`) — there is no existing channel to inject anything into.
- **Dropped Phase 0 as a standalone phase**, folding its scope into Phase 1's design requirements — shipping it separately means throwaway work against code Phase 1 deletes, and its "small" framing undersold the MCP/CLI mount-support lift (§5).
- **Gave Phase 4 an explicit verdict (PARK)** with a revisit condition, instead of leaving it an open "optional, larger" bullet (§5.1).
- **Made the parity gate concrete** (§6): golden fixture classes, capture procedure, snapshot location, negative-control requirement, gate placement per phase — replacing v0.1's one-line "mandatory regression tests against live spawned servers."
- **Added §8 (open questions)** to separate verified findings from assumptions this review could not check in the time available (mount+layer interaction decision, streaming-wiring decision, Python extractor side-effect assumption, gRPC unverified).
- **Added measured evidence** (§4 LOC diff, §1/§2 line-numbered duplication) in place of v0.1's "illustrative" LOC sketch — every duplication claim here is now a citation, not an estimate.

*Companion context: `docs/apigen/SPEC.md` (projection/tenets), `packages/apigen/apigen-engine-naming/src/lib/naming.ts` (`project`/`TransportProjection`), `packages/apigen/apigen-engine-runtime/src/index.ts` (serve primitives), `packages/apigen/apigen-core-client/src/lib/plugin.ts:87-117,359-375` (`Call`/`MountedOperation`), `BACKLOG.md:1171-1207` (apigen transport defects session), `CHANGELOG.md:1-30` (route-canonicalization fix session).*
