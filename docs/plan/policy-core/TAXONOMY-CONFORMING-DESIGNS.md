# Taxonomy-conforming designs for the policy-core apigen surfaces

Date: 2026-10-13. Role: architect (read-only on source). Baseline: branch `feat/policy-core` at `c890c591`. Paths are relative to the worktree root. A `file:line` citation means the cited lines were opened and read for this document. A bare path with no line numbers comes from an `rg` hit or a directory listing. Claims taken from `APIGEN-CONFORMANCE-REVIEW.md` without re-reading the source are marked **unverified**.

**Owner constraint (hard):** a design is approvable only if it uses apigen's **pre-existing, documented** taxonomy. New capability kinds, new plugin-contract members and new seams are extensions, and extensions are listed separately for the owner (section 10). Fixing code so that it honours a contract that already exists is not an extension: it is the "correct the source" rule of adhd ADR-0002 (`docs/decisions/0002-correct-the-source-never-work-around.md:11-15`).

ADR catalog read: adhd ADR-0001 through ADR-0009 and the proposed ADR-0016. The ones that bind this document are ADR-0002 (fix the source), ADR-0003 (CommonJS-only, item 5), ADR-0004 (MCP output is the flat payload on `content`, item 2), ADR-0009 (process-spawning proofs live in the `e2e` lane, section 9). ADR-0001's ban on environment toggles (`0001-...md:13`, `:63`) is about feature switches, not configuration values; it is applied in item 1.

## Verdict summary

| # | Item | Verdict |
|---|---|---|
| 1 | A1/A3: configuring the policy Layer loaded by `--use` | **CONFORMING-DESIGN-EXISTS** (local `--use` module + `make…Plugin` factory). Configuring through `--use <package> --opt k=v` uses extension E4, which is adopted (BA-8). |
| 2 | B8/E4: fronting an upstream MCP server through the standard Layer stack | **Decided (O-4).** Upstream tools enter at the extract stage as IR plus `Operation.binding`; `createUpstreamMountPlugin` is not built. Wrapped tool names come from the standard projection (BA-1), a string result is emitted as raw text by a general `apigen-plugin-mcp` fix (BA-2), tool metadata is carried (BA-3, E3), and a refusal is an `isError` tool result (BA-4). E1 and E2 are not adopted. |
| 3 | B1: where `bin:`/`remote:` sources and an aggregator belong | **Decided.** `bin:` and `remote:` are extract-stage sources through the translator registry plus a binding (E5 is satisfied by O-4); `bin:` in `adhd-apigen` and remote sources are out of the slice. An aggregator is N sources through the gateway (backlog 79e1c3d9), not a separate feature. |
| 4 | C5/C2/C3: `run`/`serve` through the standard host primitives, package builder, baked IR | **CONFORMING-DESIGN-EXISTS.** C2 needs one plain helper export. That is not a taxonomy member (BA-10). C3 carries one required parity proof. |
| 5 | X1: ESM against adhd ADR-0003 | **CONFORMING-DESIGN-EXISTS.** The ADR shape is the authority. No CommonJS-only sibling exists yet, so siblings are copied only where they agree with the ADR. |
| 6 | A4: inter-Layer attributes | **CONFORMING-DESIGN-EXISTS** (typed `ctx` key, SPEC §8.1 rule 3). |
| 7 | B3/B4/B9: operation ids, `safe`, error type | **CONFORMING-DESIGN-EXISTS** (`syntheticOp`, `ProjectionConfig.http.verb`, `ApiError` and the gateway error builders). |
| 8 | Multi-host gateway as the shared single-server and aggregator mechanism | **Decided.** The gateway routes by `Operation.binding ?? host` (O-1); a crashed upstream is supervised with a finite `maxRestarts` (BA-6). Per-host deadlines (E7) and a dynamic tool list (E8) are not adopted. |

---

## 0. The pre-existing taxonomy (the only building blocks used below)

| Member | What it is | Evidence |
|---|---|---|
| Plugin capabilities | `target`, `layer`, `mount`, `envelope`, `extractLayer`. There is no `source` capability. | `packages/apigen/apigen-core-client/src/lib/plugin.ts:723-766`; `docs/apigen/SPEC.md:233-241` |
| `--use` loading | `--use` accepts "a package specifier OR a local path". The loader takes a module's `default` export, its `plugin` export, or any export carrying `capabilities`. | `SPEC.md:226-228`; `entrypoint/apigen-cli/src/lib/commands/run.ts:193-228` |
| Layer contract | `layer(call, next)` and nothing else. A Layer receives no options at call time. | `plugin.ts:305-330`; tracing says so outright: `apigen-plugin-tracing/src/lib/plugin.ts:140-145` |
| `ctx` | A typed extension map keyed by class, threaded from Layer to Layer to fn. A new one is built per call. | `plugin.ts:54-81`; `SPEC.md:373-375`; `apigen-engine-runtime/src/lib/dispatch-for-plan.ts:93` |
| Envelope | Transport metadata keyed `x-<pluginId>-<field>`, filled only from declared fields. | `SPEC.md:389-424`; `op-plan.ts:240-265` |
| Mount | `operations(descriptor, opts?, hostBridge?)` returns `MountedOperation[]`, each with an in-process `handler`. Mount operations flow through the same `--use` Layers. | `plugin.ts:443-494`; `dispatch-for-plan.ts:11-29`, `:99-125` |
| `syntheticOp` | The shared builder for runtime-contributed operations: `"<ns>/<path…>"` ids, `safe`/`input`/`output`/`async` fields. | `plugin.ts:496-594` |
| Serve-core primitives | `createPackageInvoker` (`--use` Layers outermost, then the validate Layer innermost), `buildOpPlan`, `dispatchForPlan`, `TransportAdapter`. | `package-invoker.ts:149-162`; `op-plan.ts:364-395`; `dispatch-for-plan.ts:84-128` |
| Host options | `options.usePlugins`, `useOptions`, `exitCode`, `projection`, `toolDescriptions`, `transport`. | `package-invoker.ts:91-124`; `apigen-plugin-mcp/src/lib/run.ts:464-469`, `:923-925` |
| Projection overrides | `ProjectionConfig` has `http.verb[id]` only. | `apigen-engine-naming/src/lib/naming.ts:116-123`, `:152` |
| Uniqueness | `checkCollisions(operations, config)` throws on any cross-transport collision. | `naming.ts:254-271` |
| Gateway | `HostAdapter {host, hopCost, start, ready, invoke, onExit, stop}` and `createGateway`, with partial availability, readiness, restart with backoff and deadlines. | `apigen-engine-gateway/src/lib/gateway.ts:162-236`, `:395-658`; `SPEC.md:538-567` |
| IR artifact | `--type ir-cache --opt cache=artifact` emits a `CachedExtractEntry`. Exports: `CURRENT_FORMAT_VERSION` and `createSingleFileBackend`. | `apigen-plugin-ir-cache/src/index.ts:15-17`, `:52-66`; `src/lib/target.ts:43-69` |
| Errors | `ApiError{code}` → `CLI_EXIT_CODE`/`HTTP_STATUS`. Gateway errors are `ApiError('internal')` with `details.gatewayCode`. | `SPEC.md:397-406`; `gateway.ts:87-127` |

### 0.1 Where the review is wrong or incomplete (checked against source)

1. **Flat MCP arguments already exist on the standard path, for mount operations.** `T08-discovery.md:58` (B-1.2) and review B8 both say the standard MCP host forces a `{data}` wrapper. That holds only for package operations. For a mount operation the adapter passes `raw.args` straight through (`apigen-plugin-mcp/src/lib/run.ts:300-302`). The advertised `inputSchema` is the mount's own `input`, unchanged when it is `type:'object'` (`run.ts:382-386`, `:615`, `:631`). The validate Layer is a no-op for mounts (`dispatch-for-plan.ts:19-25`), which matches the current passthrough's G5. Neither document saw the mount path. It is the basis of items 2, 3 and 8.
2. **A1 overstates the gap.** The `--use` channel is configurable today: `--use ./policy.plugin.mjs` whose default export is a factory-built plugin (`SPEC.md:226-228`; `run.ts:203-225`). Only `--use <package> --opt k=v` is unavailable. The review's fix (`LayerCapability.createLayer`) is a contract extension (E4).
3. **A2/X1: "copy the siblings" is half wrong.** The siblings still ship `module: ./dist/index.mjs` and build `formats: ['es','cjs']` (`apigen-plugin-tracing/vite.config.ts:34`; the tracing, logger, backlog and environment-core-node `package.json` files carry `module`). ADR-0003 D1/D2 forbid both (`0003-...md:42-53`). `rg "formats: \['cjs'\]"` over every vite config returns no hits, so no CommonJS-only package exists in the repo yet. The ADR, not the siblings, is the shape to copy.
4. **B3 understates the signal gap.** `dispatch` passing no signal (`invoke.ts:197-205`) is one part. In addition, the MCP host never fills `Call.signal` for any operation: the `tools/call` handler ignores the SDK's `extra` argument (`run.ts:685`), and `readCall` returns no `signal` (`run.ts:283-304`). Per-request MCP cancellation therefore reaches no operation in any apigen MCP server. That breaks the contract documented at `plugin.ts:114-119` and `SPEC.md:465-466` (finding F1).
5. **B4's alternative is broader than needed.** A tri-state `safe` in `composeSchemas` is a core-client change. Mount operations never go through `composeSchemas`, so `safe:false` comes from `syntheticOp`'s own field. `project()` still hoists primitive-only inputs to `GET` regardless of `safe` (`naming.ts:150-151`). The existing `ProjectionConfig.http.verb[id]='POST'` override corrects that (item 7).
6. **Section 3 is right that `HostAdapter` fits, but it misses that nothing wires `createGateway` into a host.** `gx impact createGateway` reports 0 upstream callers; the only consumer is `entrypoint/apigen-cli/src/test/integration/gateway-mixed-host.e2e.ts`. `adhd-apigen serve` runs its own HTTP/H2 front proxy instead (`entrypoint/apigen-cli/src/lib/commands/serve.ts:1-60`). The mount capability is the missing wiring (item 8).
7. **Confirmed as stated:** A1 evidence (`apigen-plugin-policy/src/plugin.ts:292-343`, `state.ts:13-24`, apigen-cli never fills `useOptions`); B8 points 1-6 (`mcp-passthrough-server.ts:73-165`); B1.3 (`resolve-source.ts:49-53`); C5 (`verbs/run.ts:53-72`); B9 (`types.ts:66-79`, `failure.ts:15-17`); C2 (`package.ts:30-71`). Also verified: the MCP SDK exports `getDefaultEnvironment`/`DEFAULT_INHERITED_ENV_VARS` (`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js:6-7`, `:35`) and `ReadBuffer`/`serializeMessage`/`deserializeMessage` (`.../shared/stdio.js:10`, `:31`, `:34`).
8. **Unverified (not re-opened):** the MEASUREMENTS.md RSS figures; `log-level.ts`; `launcher-transport.ts` framing (B6); the backlog-side bake (`entrypoint/backlog/src/cli.ts:56`, `:368-372`).

---

## 1. A1/A3: configuring the policy Layer loaded by `--use`

**Verdict: CONFORMING-DESIGN-EXISTS.** Option-by-option configuration with `--use <package> --opt` uses extension E4, which is adopted (BA-8): `LayerCapability.createLayer(opts)`, `createPackageInvoker` passes the options, and apigen-cli fills them from `--opt` as one flat bag per invocation (same as `extractLayer`). A bare `--use` with no decider still denies everything.

### Option channels examined

| Channel | Reaches a dispatch Layer? | Evidence |
|---|---|---|
| Flat `--opt` bag → `RunInput.options` | No. It reaches the target plugin only. | `run.ts:307-308`, `:391-423` |
| `useOptions[pluginId]` | No. The type and reader exist, but hosts pass it only to `mount.operations`, and apigen-cli never fills it (`rg useOptions entrypoint/apigen-cli/src`: 0 hits). | `package-invoker.ts:83-84`, `:121-124`; mcp `run.ts:445`; cli `run.ts:586` |
| `ExtractLayerCapability.createLayer(opts)` | No. It wraps the extract stage only. | `plugin.ts:351-383`; `extract-invoker.ts:173` |
| Mount options (D-19) | Only by abusing `mount` as a configuration hook (today's hack). | `apigen-plugin-policy/src/plugin.ts:329-339` |
| Factory `make<X>Plugin(opts)` | Yes, programmatically. | tracing `plugin.ts:441-449`; logger `plugin.ts:310-323` |
| **`--use <local path>` whose default export is a factory result** | **Yes**, through the documented CLI channel. | `SPEC.md:226-228`; `run.ts:203-225` |
| Environment cascade read by a default export | Yes, at call time. | ir-cache `index.ts:79-93`, `:120-127`; `default-cache-file.ts:77-100` |
| `--config apigen.config.json` | No. It carries projection overrides only. | `run.ts:275-278`, `:381-382` |

### How sibling plugins configure themselves

| Sibling | Capability | Configuration |
|---|---|---|
| tracing | layer | Default export with a fixed `serviceName:'apigen'` (`plugin.ts:431-436`); `makeTracingPlugin(opts)` (`:441-449`). |
| logger | layer | Default export with a fixed root logger (`plugin.ts:291-293`); `makeLoggerPlugin(opts)` (`:310-323`). |
| ir-cache | extractLayer + target | `createLayer(opts)` from the flat `--opt` bag, falling back to `APIGEN_IR_CACHE_FILE` then `@adhd/environment` (`index.ts:81-93`, `:120-133`). |
| batch | mount | `mount.operations(descriptor, opts, hostBridge)` reads `opts` (`apigen-plugin-batch/src/lib/plugin.ts:285-293`), which hosts fill from `useOptions['batch']` (mcp `run.ts:445`). apigen-cli never fills `useOptions`, so `--use batch` always runs with defaults; only a programmatic host can configure it. |

**Choice: follow the layer siblings (tracing/logger) exactly, and document the local `--use` module as the configuration channel.** The environment-cascade alternative conforms (ir-cache precedent) but is rejected for two reasons. First, a decider is an object built from a context: `createDecider(ctx: IPolicyCtx, …)` (`packages/policy/policy-core-client/src/service/decider.ts:31`) cannot be expressed as a string setting. Second, it would add a second configuration surface for no gain. It does not violate ADR-0001, which bans toggles and not configuration values.

### Design

`packages/apigen/apigen-plugin-policy/src/plugin.ts`:
```ts
// BEFORE
export function createPolicyLayerPlugin(options: IPolicyLayerOptions): UsePlugin;      // typed against apigen-engine-runtime
const plugin: UsePlugin = { id: 'policy', capabilities: { layer: { layer: delegate… }, mount: { operations: capture… } } };
export default plugin;
export interface IPolicyLayerOptions { readonly decider: IPolicyDecider | string; readonly deciderOptions?: …; ask?; timeoutMs?; onError? }

// AFTER
import type { Plugin, Call, Next } from '@adhd/apigen-core-client';
export interface IPolicyLayerOptions {
  readonly decider: IPolicyDecider;            // an object; the config module builds it
  readonly ask?: IPolicyAskHandler;
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown, info: { phase: PolicyErrorPhase }) => void;
}
/** Configured factory (tracing/logger precedent). */
export function makePolicyPlugin(options: IPolicyLayerOptions): Plugin<IPolicyLayerOptions>;
/** Fixed default: a deny-all decider whose reason says how to configure. Fails closed with permission_denied. */
export const policyPlugin: Plugin<IPolicyLayerOptions>;   // id 'policy', description, language 'ts', optionsSchema
export default policyPlugin;
```
- The Layer reads `call.data` (alias of `domainArgs`, `package-invoker.ts:133-141`) and `call.ctx` (item 6). `set` merges onto `call.data`, which is the same object dispatch and mount handlers receive (`dispatch-for-plan.ts:111`).
- **Deleted:** `src/state.ts`; the `mount` capability; `delegate()`/`cached` (`plugin.ts:292-343`); `src/load-decider.ts` and the string-decider form. Removing them also resolves A6's duplicate module loader and d35b0dd2. The `load` error phase goes away. `createPolicyLayerPlugin` is renamed without an alias: `npm view @adhd/apigen-plugin-policy` returns 404, so it was never published.
- **Dependency change:** `@adhd/apigen-engine-runtime` is dropped; the package needs `@adhd/apigen-core-client` and `@adhd/apigen-base-errors` only (A3; tracing precedent `plugin.ts:5`).
- **Documented channel** (README): `policy.plugin.mjs` contains `export default makePolicyPlugin({ decider: await createMyDecider(), timeoutMs: 5000 })`. Run `adhd-apigen run --source api.ts --type mcp --use ./auth.mjs --use ./policy.plugin.mjs`. Top-level await is valid because `loadUsePlugins` awaits `import()` (`run.ts:211`).

**Blast radius:** the only production consumer is `entrypoint/policy/src/wrapper/gate.ts:3`, `:46` (rg over `createPolicyLayerPlugin`).
**Tests that must stay green, updated:** `packages/apigen/apigen-plugin-policy/src/test/{fail-closed,layered-decisions,review-fixes-layer}.spec.ts`. Delete the mount-capture and decider-load cases; add one case where the default export denies. Indirectly: `entrypoint/policy/src/test/functional/*.spec.ts`.
**Order:** runs after item 6 (same file) and after the item 5 `package.json` edit (same file).

---

## 2. B8/E4: fronting an upstream MCP server through the standard Layer stack

**Verdict: decided (O-4).** Upstream tools enter at the extract stage as IR plus a per-operation binding. The host-visible behaviours of today's bespoke `serveMcpPassthrough` are resolved one by one in the table below; the decision for each is in section 10.

### Two candidate representations on the standard path

The decided representation is neither column: foreign tools are extract-stage package operations carrying `Operation.binding`, and flat arguments reach the upstream through a binding-aware dispatch terminal (`SOURCE-MODEL-GAP-ANALYSIS.md` §3f D1). The columns record what the standard hosts do today for each shape.

| | Package operations (`pkg.fns` + `composeSchemas`) | Mount operations (not chosen, O-4) |
|---|---|---|
| Arguments | `{data:{…}}` wrapper (`run.ts:302`); positional `fns` drop undeclared keys (`dispatch.ts:128-133`) | Flat `raw.args`, undeclared keys kept (`run.ts:300-302`) |
| Advertised `inputSchema` | Composed `{data}` schema | The upstream's own schema (`run.ts:382-386`, `:615`, `:631`) |
| Validate Layer | Runs | No-op (`dispatch-for-plan.ts:19-25`), same as G5 today |
| Signal to the invocation | None (`invoke.ts:197-205`) | `call.signal` reaches the handler (`dispatch-for-plan.ts:115`), once F1 is fixed |
| Served on CLI/HTTP too | Yes, wrapped | Yes, flat. cli projects the mount input to flags (cli `run.ts:736-743`). fastify reads the body or query unwrapped for mounts (fastify `run.ts:238-264`). This answers the review's transport-asymmetry point. |

### Each passthrough behaviour on the standard hosts

The cells describe the standard MCP host's current behaviour for flat-argument operations (the mount path). The Status column records the decision.

| Bespoke behaviour (`mcp-passthrough-server.ts`) | Standard mount path | Status |
|---|---|---|
| Tool name verbatim (`:121`, `:124`) | `project(op).mcp.name` = namespace and path words joined with `_` (`naming.ts:155-156`); `syntheticSegment` lowercases and splits on case, `-` and `_` (`plugin.ts:508-516`). So `readFile` in source `fs` becomes `fs_read_file`. | **Decided (BA-1):** names come from the standard projection; no E1 override |
| Full `Tool` object (title, annotations, outputSchema) | `ToolListMeta` carries only `description`/`inputSchema`/`outputSchema` (`run.ts:146-150`); mounts never bind an output schema. Descriptions can come from the existing `options.toolDescriptions` (`run.ts:466-467`, `:627`), but `buildToolDescription` appends the input description and a synthesized example (`apigen-engine-runtime/src/lib/tool-description.ts:59-73`). | **Decided (BA-3, E3):** operations carry title, annotations and outputSchema |
| Flat arguments, undeclared keys included (`:137`, `:144-149`) | `raw.args` (`run.ts:300-302`). Caveat: apigen reads `_meta` from inside `arguments` (`run.ts:692`), and for mounts that key stays in the arguments (finding F6, unverified against the MCP spec). | **Expressible** |
| No validate Layer (G5) | No-op for mounts | **Parity** |
| Layer stack, `set` reaches upstream (`:144-150`) | Mount calls run through `createPackageInvoker({}, usePlugins)` (`run.ts:598`, `:633-635`); `coreCall.data === domainArgs` | **Expressible** |
| `envelope: {}` (`:136`) | `plan.envelope` is `[]` for schema-less mounts (`op-plan.ts:368`), so the envelope is `{}` | **Parity** (both lack §9.1 for mounts, F2) |
| Per-request cancel via `extra.signal` (`:132`) | The host ignores `extra` (`run.ts:685`) | **Bug F1**, fixed at the source, no extension |
| Verbatim `CallToolResult` (`:152`) | `writeResult` emits `content:[{type:'text', text: JSON.stringify(result)}]`, plus `structuredContent` only for bound object schemas (`run.ts:319-332`). **Every plain-text upstream result therefore reaches the model as a JSON string literal**, with quotes and escaped newlines, on every call. Returning the content array instead is worse: the model sees the serialised array. Images and resources are serialised as JSON; upstream `isError` cannot be emitted. | **Decided (BA-2):** general fix in `apigen-plugin-mcp` (a string result is raw text); no E2 |
| Refusal → `isError` result (`:154`) | `writeError` rethrows (`run.ts:335-345`). The SDK maps a non-integer `code` to `-32603` with the message (`node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js:402`). SPEC §9 lists MCP as "error" for every code (`SPEC.md:400-406`). | **Decided (BA-4):** a refusal is an `isError` tool result carrying the code and reason; `writeError` changes generally |
| Upstream `McpError` code verbatim (`:160-161`) | Rethrown; an integer code survives `protocol.js:402` | **Expressible** |
| Unknown tool → `InvalidParams` (`:129`) | `throw new Error('Unknown tool')` → `-32603` (`run.ts:689`) | Minor difference |
| Upstream exit shuts the server (`:189`) | Gateway supervision (item 8) | **Decided (BA-6)** |
| stdin EOF shutdown (`stdio-host-transport.ts`) | Already in the MCP plugin (`run.ts:850-892`, see B7) | **Expressible** on the standard host; whether the proxy target (O-8) keeps its own host-facing transport is UNVERIFIED |
| `serverInfo` = `adhd-policy` | `packages[0].id ?? 'apigen-mcp'` (`run.ts:666-672`) | Cosmetic, accepted (BA-9) |
| Injectable host `Transport` (6e27d320) | `options.transport` is a string (`run.ts:923`). Tests use the `process.stdin` spy precedent (`apigen-plugin-mcp/src/test/run-lifecycle.spec.ts:186-193`) or in-process loopback `streaming-http`, which DoD #10 allows. | **Expressible**; whether `IVerbDeps.hostTransport` is retained for the proxy target is UNVERIFIED |

### Decided design (O-4; shared with item 8; the single-server wrap is N=1)

Foreign upstream tools enter at the extract stage as IR plus a per-operation binding. `createUpstreamMountPlugin` is not built: mount operations are produced at run time by a host, are invisible to `generate`, never pass through `extractLayer`/ir-cache, and carry an in-closure `handler` instead of a routable key (`SOURCE-MODEL-GAP-ANALYSIS.md` §4.1). Components:

1. **Translator** (gateway `sources/`). A pure `operationsFromMcpTools(rawTools, name, onWarn)` returns `{operations, skipped, hints, tools}` (gap analysis §3e). Each operation has id `<source>/<tool>` (BA-5), `host: 'mcp'`, `binding: 'mcp:<name>'` (O-1), `safe: false` (D-08) and the upstream's input schema. Tool `title`, `annotations` and `outputSchema` ride on the operation (BA-3, E3). The skip rules are unchanged: a non-object schema, a duplicate or a reserved name is skipped and reported, never fatal.
2. **Binding.** One `HostAdapter` per upstream, keyed `mcp:<name>`, supervised by `createGateway`:
```ts
// NEW packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-upstream-adapter.ts
export interface IMcpUpstreamSpec {
  readonly name: string;                                   // user alias, never serverInfo.name (G2)
  readonly transport:
    | { kind: 'stdio'; command: string; args: readonly string[]; cwd: string; env?: Record<string, string> }
    | { kind: 'http'; url: string };                       // remote: out of the slice (O-6)
}
export interface IMcpUpstreamAdapter extends HostAdapter {  // host = `mcp:${name}`, hopCost: 1
  readonly sourceName: string;
  tools(): readonly Tool[];                                // the list from the first successful start()
}
export function createMcpUpstreamAdapter(
  spec: IMcpUpstreamSpec,
  deps: { launcher?: IProcessLauncher; handshakeTimeoutMs?: number; callTimeoutMs?: number; onWarn?: (l: string) => void }
): IMcpUpstreamAdapter;
// start: spawn (launcher) + initialize + tools/list. Idempotent. ready: connected && client.ping().
// invoke(req, signal): tools/call {name, arguments: req.data} with {signal, timeout: callTimeoutMs}.
// onExit: client.onclose. stop: dispose.
```
3. **Routing and dispatch.** The gateway routes by `operation.binding ?? operation.host`. A binding-aware dispatch terminal (gap analysis §3f D1, in `apigen-engine-runtime`) hands the argument object and `call.signal` to the binding's `invoke`, so undeclared keys survive. Standard targets (mcp, cli, fastify) host the operations; the `--use` Layers wrap them outermost, so policy is outermost for every upstream by `usePlugins` order.
4. **Proxy target.** `serveMcpPassthrough` is kept only as the degenerate proxy target (source protocol equals target protocol) and is rewritten to consume the IR operations instead of raw upstream `Tool` objects (O-8).
5. **Result and error shaping.** A string result is emitted as raw text content and a refusal is an `isError` tool result, both through general `apigen-plugin-mcp` fixes (BA-2, BA-4); they are specified in the ADR-0004 follow-up, which is drafted for approval and not yet written.

Open: the gap analysis sequences D1 inside step 10 (deferred); S5 needs it for flat arguments. The decisions register does not state where D1 lands relative to S5.

**Startup-failure contract (required).** `bringUp` subscribes `onExit` *before* it calls `adapter.start()` (`gateway.ts:448-456`). `defaultBackoff.maxRestarts` is `0`, which means unlimited (`gateway.ts:305-311`). If a failed handshake killed the child and fired `onExit`, `supervise()` would respawn in the background forever while `gateway.start()` rejected, and `serve bin:<not-an-mcp-server>` would never exit (against D-08 and `s8-serve-handshake-and-precedence.spec.ts`). Three rules, all within existing members, prevent this:
1. **Adapter contract:** `onExit` fires only for an exit that happens after `start()` resolved. A start that fails rejects and fires nothing.
2. **Wrapper:** `try { await gateway.start(); … } finally { await gateway.stop(); }`. `stop()` sets `retired`, which ends every supervise loop (`gateway.ts:647-655`, `:474-479`).
3. **Wrapper:** a finite `backoff.maxRestarts` (`gateway.ts:298-303`; BA-6).

**Removed from the branch:** the serve arm of `resolve-source.ts` and `IResolvedSource.mcp` (the translator and binding replace them), and `SourceError` (item 7). `resolveMcpStdioSource` folds into the translator plus the adapter.

**Source fix, not an extension (F1):** `apigen-plugin-mcp/src/lib/run.ts` changes the `tools/call` handler to `async (req, extra)` and threads `extra.signal` through `McpRaw` into `readCall`'s return value. `gx impact McpTransportAdapter`: LOW, 4 nodes.

**Blast radius:** the gateway `sources/*` consumers are `entrypoint/policy/src/wrapper/verbs/{run,serve}.ts`, `failure.ts` and the test helpers listed under item 7. `mcpPlugin.run` changes for F1, BA-2 and BA-4.
**Tests:** `apigen-plugin-mcp/src/test/{run,run-lifecycle,flat-content-payload,transport-http-parity}.spec.ts` must stay green after F1 (the BA-2 and BA-4 changes update the cases that pin the JSON string literal and the rethrow). `apigen-engine-gateway/src/test/{gateway,sources-mcp-source,sources-process}.spec.ts` are kept and extended. `entrypoint/policy/src/test/functional/{s7-serve,s8-serve-handshake-and-precedence}.spec.ts` move to the stdin-spy or loopback seam where the host transport is no longer injected.
**Order:** F1, BA-2/BA-4 and item 7 come before the wrapper change.

---

## 3. B1: where `bin:`/`remote:` sources and an aggregator belong

**Verdict: CONFORMING-DESIGN-EXISTS.** Each source concern maps to a member that already exists:

| Concern | Existing member | Evidence |
|---|---|---|
| Contribute a foreign upstream's operations | The extract stage: a translator registered by `ExtractCall.host` returns IR, and `Operation.binding` names the executing `HostAdapter` (O-4) | `extract-invoker.ts:15-23`, `:56`; `SOURCE-MODEL-GAP-ANALYSIS.md` §3c, §3d. The `mount` capability (`SPEC.md:238`; `plugin.ts:443-494`) is not used for upstreams. |
| Invoke out of process (local stdio or remote http) | `HostAdapter` + `createGateway` | `gateway.ts:191-236`, `:407-658`; SPEC §13.1/§14.4 (`SPEC.md:538-567`) |
| Host it on any transport | Every standard `target`, consuming the IR operations | mcp `run.ts:590-637`; cli `run.ts:710-745`; fastify `run.ts:313-323` (mount-path hosting evidence) |
| Govern it | `layer` through `--use` | `dispatch-for-plan.ts:15-29` |
| `bin:` argv one-shot (`run` verb) | Package operation through the serve-core primitives (item 4) | — |
| `adhd-apigen run --source bin:<cmd>` (f6bf8550 item 1) | An extract-stage source: the source resolver classifies it, the argv translator emits IR and the process binding executes it. No source capability is needed (E5 is satisfied by O-4). | Deferred: `bin:` in `adhd-apigen` is out of the slice. |

**Home:** the adapter and the MCP translator stay in `apigen-engine-gateway` (engine tier, already `platform:node`, already depending on `@adhd/apigen-core-client`). It gains `@adhd/apigen-engine-naming` for `checkCollisions` and drops the branch's `@adhd/apigen-engine-runtime` edge, whose only user is the passthrough's `adaptCoreLayer`. No new package is created. `sources/types.ts:1`'s "for `adhd-policy run|serve`" header and `SourceIntent` (`:17-18`) are deleted.

---

## 4. C5/C2/C3: `run`/`serve` on the standard primitives

**Verdict: CONFORMING-DESIGN-EXISTS** for all three. C2 needs one plain helper export (BA-10). C3 needs one parity proof before merge.

### C5: the `run` verb

`serve` is covered by item 2. For `run`, the primary design uses the serve-core primitives, so the validate Layer, the `--use` Layers and tracing all run, and the verb still forwards raw child output and the child's exit status (`tickets/T09.md:18`, `:114`).
```ts
// entrypoint/policy/src/wrapper/verbs/run.ts
// BEFORE: createInvoker(layers)(fnName, hand-built Call, {fns, schemas})   (run.ts:53-72; no validate Layer, no tracing)
// AFTER
const { operation: op, schemas, fns, createClient } = buildArgvSource(command, { launcher, signal }); // keyed by op.id
const plan = buildOpPlan({ op, schema: schemas[op.id], transport: 'cli' });
const invoke = createPackageInvoker(schemas, [tracingPlugin, ...gate.usePlugins]);
const r = await dispatchForPlan(plan, invoke, { domainArgs: { argv, cwd }, envelope: {}, signal }, { fns, schemas, createClient });
// write r.stdout / r.stderr raw, return r.exitCode
```
- Precedent: hosts re-key by `op.id` before `dispatchForPlan` (cli `run.ts:650-675`).
- `createPackageInvoker` takes the runtime's structural `UsePlugin[]` (`package-invoker.ts:36-81`, `:149-152`). Core-client `Plugin` objects may need the same cast the hosts already apply in `readUsePlugins` (`package-invoker.ts:91-94`).
- The process-wide signal reaches the child through `createArgvInvoker`'s construction-time `signal` (`argv-operation.ts:28-29`, `:129`). For a one-shot CLI that is the per-request signal.
- The exit-code collision (child exit 3 against refusal 3) remains. A refusal never starts the child and writes the `ApiError` to stderr (D-04). This is documented, not changed.
- **Alternative:** `cliPlugin.run` over the same operation, with the `exitCode` hook `r => r.exitCode` (`package-invoker.ts:112-119`; `mount.ts:124` precedent). It prints `{"exitCode","stdout","stderr"}` JSON (cli `run.ts:551`) and breaks T09's transparent `echo` expectation (`T09.md:114`). It needs BA-11 or extension E6, so it is not recommended.

### C2: `buildPolicyPackage` copies `buildBacklogApigenPackage`

```ts
// NEW export in packages/apigen/apigen-engine-runtime (helper only, not a capability or contract member)
export function buildApigenPackage(input: {
  id: string; version: string; importPath: string;
  operations: readonly Operation[];
  fns: Record<string, (...a: unknown[]) => unknown>;
  createClient?: (envelope: Record<string, unknown>) => Promise<unknown>;
}): { pkg: RunInput['packages'][number]; operations: Operation[] };
```
- Precedent for promoting duplicated host code into the runtime: `package-invoker.ts:4-13` (dod.13).
- Consumers: `entrypoint/policy/src/wrapper/package.ts:30-71`, `entrypoint/backlog/src/server.ts:630-700`, and the gateway's argv source.
- C4 (`dereference.ts`) is deleted after the dispatch `$ref` fix (backlog 1bb4b5d5). That is a source fix under ADR-0002.

### C3: baked IR

- **Build:** `vite build && node <apigen-cli dist bin> generate --source packages/policy/policy-core-client/src/service/api.ts --type ir-cache --opt cache=artifact --opt filename=api.ir.json --out-dir dist`. The target is already registered (`entrypoint/apigen-cli/src/index.ts:37`), and the build gains a `dependsOn` on `apigen-cli:build`.
- **Read:** `createSingleFileBackend(<dist>/api.ir.json).get('')`, then `entry.formatVersion === CURRENT_FORMAT_VERSION`; anything else is `ApiError('internal')`. Then `buildApigenPackage`.
- **Freshness** is owned by Nx build ordering, which is the artifact contract (`apigen-plugin-ir-cache/src/lib/target.ts:23-26`).
- **Deleted:** `ir-artifact.ts`, `ir-live.ts`, the digest, atomic-write and stale-fallback parts of `ir.ts`, the hidden `ir-artifact` subcommand (`mount.ts:96-99`), and the `node dist/cli.js ir-artifact` half of the build command (`entrypoint/policy/project.json`, build target).
- **Required proof (otherwise this item is UNDETERMINED):** apigen-cli's extraction of `api.ts` must produce the same `operations[]` as today's `ir-live` extraction of the built `.d.ts`. A deep-equality check against the current `dist/api.ir.json` runs once before the swap.

**Tests:** `entrypoint/policy/src/test/functional/{s2-check-evaluate,s3-run-bin,s5-narrow,s6-verify-explain-draft,http-entry,review-fixes-entrypoint}.spec.ts`. Functional specs that need operations depend on `build`.
**Order:** C2 → C3. C5 follows item 7's argv operation.

---

## 5. X1: ESM against adhd ADR-0003

**Verdict: CONFORMING-DESIGN-EXISTS.** All three packages change.

| File | BEFORE | AFTER (ADR-0003 D1/D2) | Sibling precedent kept |
|---|---|---|---|
| `packages/apigen/apigen-plugin-policy/package.json` | `type:module`, `main`/`module` `./dist/index.js`, `exports` map | `main: ./dist/index.js`, `types`, `files`; no `type`, `module` or `exports` | tracing `package.json` minus `module` |
| `…/apigen-plugin-policy/vite.config.mts` | `.mts`, `formats:['es']`, `import.meta.dirname` | Renamed `vite.config.ts`, `formats:['cjs']`, `__dirname` | tracing `vite.config.ts:1-55` with `:34` → `['cjs']` |
| `…/apigen-plugin-policy/project.json` | `test` command override (`.mts`); `manifestRootsToUpdate: ["dist/{projectRoot}"]` | Override deleted (the inferred test target works); release block aligned | tracing `project.json:6-11`, `:32-35` |
| `packages/policy/policy-core-client/package.json` | `type:module`, `main: ./index.js`, `exports` | `main: ./dist/index.js`; no `type` or `exports` | same |
| `…/policy-core-client/vite.config.mts` | `formats:['es']` | `vite.config.ts`, `formats:['cjs']` | same |
| `entrypoint/policy/package.json` | `type:module` | `type` removed; `bin` unchanged (`dist/{cli,mcp,http}.js`) | backlog `package.json` minus `module` |
| `entrypoint/policy/vite.config.ts` | `formats:['es']`, no `importMetaUrlCjs` | `formats:['cjs']`; add `importMetaUrlCjs()` (`tools/vite-plugins/import-meta-url-cjs.mjs:1-30`) because `ir.ts:14`, `:43` use `import.meta.url` | backlog `vite.config.ts:91-96` |
| `entrypoint/policy/src/entry/{cli,mcp,http}.ts` | Top-level `await runEntry(…)` | `void runEntry(…)`. Top-level await is invalid in CommonJS. | backlog `src/index.ts:356` |

- **Root cause:** `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:155-171` accepts Nx 23's `.mts` ESM scaffold. It should emit `vite.config.ts`, CommonJS-only output, and no `type`/`exports`. That is a source fix, so new packages are born conforming.
- **Required checks, not assumptions:** `npx nx run <each>:verify-dist-load` (ADR-0003 D3; DoD 12). If item 1 is not taken and string deciders remain, a dist-level test must load a decider through the built CommonJS `import()` (precedent: apigen-cli's dual-built `loadUsePlugins`, `run.ts:211`).
- **REVIEW-FIXES L7** (`REVIEW-FIXES.md:40`, "add `exports`") is withdrawn.
- **Finding F4:** the siblings themselves still violate D1/D2.

**Order:** first. It touches only build manifests and entry files.

---

## 6. A4: inter-Layer attributes, envelope or `ctx`

**Verdict: CONFORMING-DESIGN-EXISTS.** SPEC §8.1 rule 3 says inter-Layer data travels on `ctx`, a map owned by the request (`SPEC.md:373-375`). The envelope is client-supplied transport metadata (`SPEC.md:389-394`).

```ts
// NEW packages/apigen/apigen-plugin-policy/src/attributes.ts (exported)
export class PolicyAttributes {
  constructor(readonly values: Readonly<Record<string, string | number | readonly string[]>>) {}
}
// Policy Layer — BEFORE: readAttributes(call.envelope)      (plugin.ts:83-86, :230)
//                AFTER:  readAttributes(call.ctx.get(PolicyAttributes)?.values)   (same validation, envelope never read)
// Wrapper attributes Layer (entrypoint/policy/src/wrapper/attributes-layer.ts)
//   BEFORE: call.envelope['attributes'] = attributes / delete …   (:24-25)
//   AFTER:  if (attributes !== undefined) call.ctx.set(PolicyAttributes, new PolicyAttributes(attributes))
```
- **Precedents:** `TraceHandle` as a class key (tracing `plugin.ts:161-173`, `:350`) and `Logger` (logger; `SPEC.md:283-285`).
- **Safety comes from structure:** `ctx` is `new LayerContext()` per call (`dispatch-for-plan.ts:93`), and the mount-fan-out inner calls also get a fresh `LayerContext` and re-run the same Layers (mcp `run.ts:575`; cli `run.ts:695`).
- **Superseded:** D-18 and the envelope half of D-06's wiring; this is the remedy for backlog f4d95c61. Precedence under D-06 is unchanged.
- **Cross-bundle caveat (recorded, not blocking):** a class key matches only the same module instance. A separately bundled `--use` auth plugin carrying its own copy of `@adhd/apigen-plugin-policy` would get a different class, the lookup would miss, and the Layer would decide with no attributes. In the wrapper both Layers come from one bundle. Under apigen-cli both resolve the same `node_modules` file. `Symbol.for` would avoid this, but core `Extensions` accepts class keys only (`plugin.ts:75-80`), even though `LayerContext` accepts symbols (`invoke.ts:41-55`).

**Tests:** `apigen-plugin-policy/src/test/layered-decisions.spec.ts`, `entrypoint/policy/src/test/functional/s8-serve-handshake-and-precedence.spec.ts`.
**Order:** before item 1 (same file).

---

## 7. B3/B4/B9: ids, `safe`, errors

**Verdict: CONFORMING-DESIGN-EXISTS.**

- **B3 (argv):**
  - `buildArgvOperation` (`argv-operation.ts:38-75`, `host:'ts'` at `:43`) becomes `syntheticOp(\`bin/${base}\`, {host: 'bin', operations: []}, {input: ARGV_INPUT, output: ARGV_OUTPUT, async: true, safe: false})`.
  - The id is `bin/touch`, `namespace.raw` is `bin` and the path tail is `touch`, which meets `operationFor`'s join key (`T08-discovery.md:17`). The schemas are then keyed by `op.id` for `dispatchForPlan`.
  - The producer tag is `argv` and the binding key is `bin:<base>` (O-1; BA-7 is superseded). The argv operation is never routed through the gateway.
- **B4 (MCP):**
  - The id is `<source>/<tool>` (BA-5), assigned by the MCP translator (item 2).
  - `safe:false` is set on each translated operation (D-08), and the `x-apigen-safe` rewrite (`mcp-source.ts:246-250`) is deleted.
  - HTTP exposure forces `POST` through the existing `ProjectionConfig.http.verb` (`naming.ts:116-123`, `:152`).
  - Policy `tool:` keys and `draft` output change from `fs.read_file` to `fs/read_file` (BA-5).
- **B9:**
  - `SourceError` (`types.ts:66-79`) is deleted.
  - `invalid-spec`/`unsupported` → `ApiError('invalid_argument')` (exit 2; `unsupported` was 1).
  - `spawn-failed`/`handshake-failed` → `makeUnavailableError(host, '(start)', reason)` (`gateway.ts:87-104`), which is `ApiError('internal')`, exit 1, the same code as today.
  - `failure.ts:15-17` is deleted.

**Blast radius:**
- `rg SourceError|resolveSource` → gateway `sources/*`, `verbs/{run,serve,failure}.ts`, `entrypoint/policy/src/test/helpers/stub-mcp-upstream.ts:6`, and gateway `src/test/sources-*.spec.ts`.
- **Coordinate with the agent currently editing `entrypoint/policy` tests.**

**Tests:** `apigen-engine-gateway/src/test/{sources-argv,sources-parse-resolve}.spec.ts`; `entrypoint/policy/src/test/functional/s3-run-bin.spec.ts`.

---

## 8. One mechanism for the single-server wrap and the multi-server aggregator

**Ask:** can `createGateway` front a set of MCP upstreams through the standard Layer stack with no extension? Where does it fall short, and how do single-wrap and aggregator share one mechanism?

**Mechanism (O-4):** upstream specs (local stdio `bin:`; remote `http` is out of the slice) → one `IMcpUpstreamAdapter` each (`HostAdapter`, binding key `mcp:<source>`) plus the pure MCP translator → IR operations carrying `Operation.binding` → `createGateway({adapters})` routing by `binding ?? host` → **any** standard apigen host (`mcpPlugin.run` over stdio or streaming-http, or `cliPlugin`/fastify), with `usePlugins: [tracing, attributes, policy]`. Policy is outermost relative to every upstream by `usePlugins` order. The single-server `serve bin:x` is exactly N=1, and an aggregator is N sources through the same gateway (backlog 79e1c3d9; the acceptance test runs two upstreams in the gateway segment). `serve --from mcp.json` is N>1. Remote upstreams differ only in the client transport inside the adapter and are out of the slice.

| Topic | Today | Conforming answer | Shortfall → decision |
|---|---|---|---|
| Routing key | Gateway routes by `operation.host`, one adapter per host, throws on duplicates (`gateway.ts:417-422`, `:591`); every MCP source op is stamped `host:'ts'` (`mcp-source.ts:192`) | `Operation.host` stays the producer tag (`mcp`); `Operation.binding` carries `mcp:<source>` and the gateway routes `binding ?? host` | **Decided (O-1);** BA-7 is superseded |
| `serve` uses the gateway | No (`serve.ts:41-54`); the gateway has 0 production callers | Binding-aware dispatch → `gateway.route` | See the open D1 sequencing note in item 2 |
| Partial availability, restart | Passthrough exits on upstream close (`mcp-passthrough-server.ts:189`) | Supervision with backoff (`gateway.ts:474-503`); `unavailable` names the host (`:87-104`, `:608-614`) | **Decided (BA-6):** supervise with a finite `maxRestarts` |
| Per-upstream timeout | Gateway deadline is global (`gateway.ts:321-322`, `:408`, `:617`) | The adapter enforces its own `callTimeoutMs` through the SDK request timeout; the gateway default is ≥ the maximum | True per-host deadline: E7 is not adopted |
| Tool list | — | `mount.operations` is synchronous and called once (`plugin.ts:461-465`; mcp `run.ts:590-596`, dod.12), so all upstreams start eagerly before the host and the list is fixed. This matches spec 2026-07-28's constant-list rule (assessment `GATEWAY-AGGREGATION-ASSESSMENT.md:35`). | Lazy start, `listChanged`, policy-edit refresh: E8 is not adopted |
| Name collisions | `registerRoute` is a `Map` keyed by MCP name, so the last writer wins silently (`run.ts:241`) | `checkCollisions` over the host's operations including the translated upstream operations; skip and warn (SPEC §5, `SPEC.md:179-183`) | — (F3 for apigen generally) |
| Aggregate health | — | A `_meta/upstreams` operation over `gateway.health()` (`gateway.ts:620-637`). It cannot be named `_meta/health`, or it would collide with `--use health`. | — |
| Hide denied tools | Denied tools are listed (D-08) | Static `include` predicate evaluated once when the IR operations are built | Dynamic filtering needs E8, which is not adopted |
| Names | — | `<source>_<tool>` (`naming.ts:155-156`). For an aggregator, the MCP spec says SHOULD prefix (assessment `:36`). | **Decided (BA-1):** standard projection with the mount namespace as `<source>`; E1 is not adopted |
| Per-upstream env (c6ca91d6) | Fixed allowlist of 8 names plus `spec.env` (`sources/process.ts:48-57`), a different list from the SDK's | The adapter spec carries `env`; base it on SDK `getDefaultEnvironment()` (verified `stdio.js:7`, `:35`) | — |
| Remote upstream | `remote:` throws (`resolve-source.ts:50-51`) | Same adapter with the SDK streamable-HTTP client transport (class name **unverified**), `hopCost: 1`. Out of the slice (O-6). | — |
| Remote front | — | `mcpPlugin.run({transport:'streaming-http'})` (`run.ts:923-925`) | — |
| Two gateway implementations | `adhd-apigen serve` has its own proxy (`serve.ts:1-60`) | Out of scope; recorded as F7 | — |

**Reusing apigen-generated MCP hosts (local or remote) behind one policy-fronted gateway.**
- A remote apigen MCP server (any `mcpPlugin.run({transport:'streaming-http'})`) is an `http` upstream like any other. Local stdio apigen servers (`adhd-backlog`, `adhd-policy-mcp`) are `stdio` upstreams.
- In-process apigen packages need no gateway hop. They go in the same `mcpPlugin.run` call as `packages: [pkg]`, next to the upstream operations, under the same `usePlugins` Layer stack. This is the existing `startPolicyMcp` shape (`entrypoint/policy/src/wrapper/mount.ts:136-142`). Policy's own operations can be exposed this way if wanted.
- In-process package operations and upstream operations then share one route `Map` (`run.ts:241`). Collision checking therefore runs over the host's whole operation list, not over the upstream operations only.

**Not reusable without an extension:** none of the core mechanism. The verbatim-name and verbatim-result needs of the N=1 wrap are resolved as in item 2 (BA-1, BA-2).

---

## 9. Remediation sequence (single ordered list, with parallelism)

| Wave | Segment | Items | Depends on | Parallel with |
|---|---|---|---|---|
| 0 | S1: CommonJS-only re-emit of the three packages + generator fix | X1 | — | S2, S3 |
| 0 | S2: MCP host wires `extra.signal` into `Call.signal` (`apigen-plugin-mcp`) | F1 | — | S1, S3 |
| 0 | S3: dispatch `$ref` resolution, then delete both `dereferenceSchema` copies | C4 (1bb4b5d5) | — | S1, S2 |
| 1 | S4: plugin-policy `ctx` key, then `makePolicyPlugin`, default deny-all, core-client typing; delete `state.ts`, the mount capability and `load-decider.ts` | A4, A1, A3, A6 | S1 (shared `package.json`) | S5, S6 |
| 1 | S5: gateway sources as extract-stage IR + `Operation.binding` (source-model steps 0, 1, 4, 5), not `createUpstreamMountPlugin`: `createMcpUpstreamAdapter` binding, `operationsFromMcpTools` and argv translators, `ApiError`; `serveMcpPassthrough` rewritten to consume IR; delete `SourceError` and the serve arm | B3, B4, B5, B6, B7, B8, B9 | S2 for the cancel proof; source-model steps 0, 1, 4, 5 | S4, S6 |
| 1 | S6: `buildApigenPackage` helper in runtime + backlog migration | C2 | BA-10 (decided); the `entrypoint/backlog` migration stays gated on separate approval | S4, S5 |
| 2 | S7: wrapper `gate.ts` (`makePolicyPlugin`, `ctx` attributes), `serve` via gateway + `mcpPlugin.run`, `run` via `createPackageInvoker`/`dispatchForPlan` + tracing, `failure.ts` | C5, C6, C7, A4 | S4, S5 (BA-1 to BA-6 are decided, section 10a) | — |
| 2 | S8: IR through the ir-cache artifact target + reader; delete the bake | C3 | S1, S6, and the parity proof | after S7 (shared `mount.ts`/`package.ts`) |
| 3 | S9: tests. Functional specs on the stdin-spy or loopback seam. Real stdio proof in an `e2e` target per ADR-0009 (`0009-...md:19-25`); the owner's "no e2e" (`docs/plan/policy-core/README.md:12`) still governs whether it runs locally. | all | S7, S8 | S10 |
| 3 | S10: docs. INTERFACES D-07, D-08, D-14, D-18, D-19, D-20, D-21 superseded (D-21 by the O-8 proxy target); plugin and gateway READMEs; `packages/apigen/README.md` table | all | S7 | S9 |

**Gates for every segment:** `npx nx affected -t lint,typecheck,typecheck-spec`; `nx affected -t test`; `verify-dist-load` on the three packages.

---

## 10. Decisions register

Owner: pseudosky. Status values: Decided, Deferred (out of slice), Open. Source-model decisions O-1 to O-14 are in `SOURCE-MODEL-GAP-ANALYSIS.md` §9. Slice: the policy path (S1 to S10), TS-only apigen foundations and the TS subprocess extractor; Python, Java, remote, `bin:` in adhd-apigen, Rust and Go are out. Packages approved for edits: `apigen-core-client`, `apigen-cli`, `apigen-engine-runtime`, `apigen-plugin-mcp`, `workspace-codegen-nx`; `entrypoint/backlog` is not approved.

### 10a. Behaviour-change acceptances

| ID | Topic | Decision | Status |
|---|---|---|---|
| BA-1 | Wrapped tool names | Names come from the standard projection/naming engine, with the gateway mount namespace as `<source>` (`readFile` in source `fs` becomes `fs_read_file`). No E1 override. Users' `mcp__<server>__<tool>` host rules change after `mcp-json init`. | Decided |
| BA-2 | Upstream results over MCP | A general fix in `apigen-plugin-mcp` for every service: a string result is emitted as raw text content, not a JSON string literal. Object results keep ADR-0004 behaviour. An ADR-0004 follow-up is drafted for approval and not yet written. | Decided |
| BA-3 | Tool metadata in `tools/list` | Adopt E3: mounted operations carry tool metadata (title, annotations, outputSchema). | Decided |
| BA-4 | Policy refusal shape | A refusal is a tool execution error: a result with `isError: true` carrying the code and reason (MCP spec 2025-06-18, Error Handling: business-logic failures are tool execution errors, protocol errors are JSON-RPC). This keeps D-04/U12. The general `apigen-plugin-mcp` `writeError` change (today it re-throws every `ApiError`, `run.ts:335-345`) belongs to the same ADR follow-up; which other `ApiError` codes map to `isError` is proposed in the ADR draft. | Decided |
| BA-5 | Operation id separator | Operation ids use `/` per SPEC §4 (`fs/read_file`, `bin/touch`); policy files and `draft` output migrate. | Decided |
| BA-6 | Crashed upstream | Supervise and restart a crashed upstream with a finite `maxRestarts`. A failed startup handshake still exits non-zero (the startup-failure contract in item 2). | Decided |
| BA-7 | `Operation.host` meaning | Superseded by O-1: `host` keeps its producer meaning and `Operation.binding` carries the executing binding. | Decided |
| BA-8 | Layer options through `--use` | Adopt E4: `LayerCapability.createLayer(opts)`, `createPackageInvoker` passes the options, and apigen-cli fills them from `--opt` as one flat bag per invocation (same as `extractLayer`). A bare `--use` with no decider still denies everything. | Decided |
| BA-9 | MCP `serverInfo` fallback | Cosmetic; accepted (`apigen-mcp`). | Decided |
| BA-10 | `buildApigenPackage` helper | Add `buildApigenPackage` to `apigen-engine-runtime`. Migrating `entrypoint/backlog` stays gated on separate approval. | Decided |
| BA-11 | `cliPlugin` JSON report for `run` | Not applicable: `cliPlugin` is not chosen for `run`. | Decided |

### 10b. Taxonomy extensions

| ID | Extension | Member it would add | Note | Decision | Status |
|---|---|---|---|---|---|
| E1 | MCP tool-name override | `ProjectionConfig.mcp.name[id]` (`naming.ts:116-123`) | SPEC Tenet 1 already names "name" as a projection-override category (`SPEC.md:30-31`), but the type lacks it | Not adopted (BA-1). | Decided |
| E2 | Raw `CallToolResult` passthrough | `McpTransportAdapter.writeResult` channel for pre-shaped results (`run.ts:306-333`) | Interacts with ADR-0004 D1. SPEC §9's "complete opt-out → raw passthrough" (`SPEC.md:395-396`) is documented but not built. | Not adopted: BA-2 and BA-4 are solved generally in the adapter. | Decided |
| E3 | Tool metadata passthrough for mounts | `MountedOperation`/`ToolListMeta` fields (`plugin.ts:478-494`; `run.ts:146-150`) | — | Adopted (BA-3). | Decided |
| E4 | `--use <pkg> --opt` for Layers | `LayerCapability.createLayer(opts)` + apigen-cli filling `useOptions` (`plugin.ts:305-330`; `run.ts:321-324`) | Review remediation #1 | Adopted (BA-8). | Decided |
| E5 | `--source bin:`/`remote:` in apigen-cli | Phase 4 source plugin (DEBT-APIGEN-SERVE-CORE-011, epic 292bd882; `transport-serve-core-refactor.md:217-225`) | Its revisit trigger has fired (review P15) | Satisfied by O-4: `bin:` and `remote:` are extract-stage sources through the registry and `Operation.binding`; no source capability. `bin:` in adhd-apigen is deferred. | Decided |
| E6 | cli-output raw-output mode | New cli-output option | Only with BA-11 | Not applicable (BA-11). | Decided |
| E7 | Per-host gateway deadline | `GatewayOptions`/`HostAdapter` field | Only if adapter-level timeouts are insufficient | Not adopted. | Decided |
| E8 | Dynamic tool list (lazy start, `listChanged`, filtered refresh) | A tools/list hook for Layers or mounts | Spec 2026-07-28 tension (assessment §4.8) | Not adopted. | Decided |

## 11. Findings discovered while verifying (not filed: this run had no backlog write access)

- **F1** — The apigen MCP host never wires per-request cancellation into `Call.signal` for any operation (`apigen-plugin-mcp/src/lib/run.ts:685`, `:283-304`; contract at `plugin.ts:114-119`).
- **F2** — Mount operations never receive §9.1 envelope fields on any host, because `plan.envelope` is empty without a composed schema (`op-plan.ts:368`).
- **F3** — Mount operations are not collision-checked; the MCP route `Map` overwrites silently (`run.ts:241`).
- **F4** — tracing, logger, backlog and environment-core-node still emit an `.mjs` build and declare `module`, against ADR-0003 D1/D2 (their `package.json` files; `apigen-plugin-tracing/vite.config.ts:34`). Possibly a99fe8dd.
- **F5** — `apigen-plugin-policy` and `policy-core-client` use `manifestRootsToUpdate: ["dist/{projectRoot}"]`, while siblings use the project root (tracing `project.json:6-11`).
- **F6** — The MCP adapter reads `_meta` from inside `tools/call` `arguments` (`run.ts:692`) and leaves it in a mount's arguments (`run.ts:300-302`). Whether `_meta` belongs at `params` level per the MCP spec is **unverified**.
- **F7** — Two gateway implementations exist: `createGateway` has no production caller, and `adhd-apigen serve` uses its own proxy (`entrypoint/apigen-cli/src/lib/commands/serve.ts:1-60`).
