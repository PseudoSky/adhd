# Taxonomy-conforming designs for the policy-core apigen surfaces

Date: 2026-10-13. Role: architect (read-only on source). Baseline: branch `feat/policy-core` at `c890c591`. Paths are relative to the worktree root. Every `file:line` below was opened and read for this document; claims taken from `APIGEN-CONFORMANCE-REVIEW.md` without re-reading the source are marked **unverified**.

**Owner constraint (hard):** a design is approvable only if it uses apigen's **pre-existing, documented** taxonomy. New capability kinds, new plugin-contract members and new seams are extensions, and extensions are listed separately for the owner (section 10). Fixing code so that it honours a contract that already exists is not an extension: it is the "correct the source" rule of adhd ADR-0002 (`docs/decisions/0002-correct-the-source-never-work-around.md:11-15`).

ADR catalog read: adhd ADR-0001 through ADR-0009 and the proposed ADR-0016. The ones that bind this document are ADR-0002 (fix the source), ADR-0003 (CommonJS-only, item 5), ADR-0004 (MCP output is the flat payload on `content`, item 2), ADR-0009 (process-spawning proofs live in the `e2e` lane, section 9). ADR-0001's ban on environment toggles (`0001-...md:13`, `:63`) is about feature switches, not configuration values; it is applied in item 1.

## Verdict summary

| # | Item | Verdict |
|---|---|---|
| 1 | A1/A3: configuring the policy Layer loaded by `--use` | **CONFORMING-DESIGN-EXISTS** (local `--use` module + `make…Plugin` factory). Configuring through `--use <package> --opt k=v` needs extension E4. |
| 2 | B8/E4: fronting an upstream MCP server through the standard Layer stack | **Split.** The fronting mechanism conforms (mount capability, `mcpPlugin.run`, `HostAdapter`). Verbatim tool names, verbatim `CallToolResult` and full `Tool` metadata need extensions E1, E2 and E3, or the owner accepts the standard projection (BA-1 to BA-4). |
| 3 | B1: where `bin:`/`remote:` sources and an aggregator belong | **CONFORMING-DESIGN-EXISTS** (`mount` contributes operations, `HostAdapter`/`createGateway` invokes them, any `target` hosts them). `adhd-apigen run --source bin:<cmd>` needs extension E5 and is not needed by policy. |
| 4 | C5/C2/C3: `run`/`serve` through the standard host primitives, package builder, baked IR | **CONFORMING-DESIGN-EXISTS.** C2 needs one plain helper export. That is not a taxonomy member (BA-10). C3 carries one required parity proof. |
| 5 | X1: ESM against adhd ADR-0003 | **CONFORMING-DESIGN-EXISTS.** The ADR shape is the authority. No CommonJS-only sibling exists yet, so siblings are copied only where they agree with the ADR. |
| 6 | A4: inter-Layer attributes | **CONFORMING-DESIGN-EXISTS** (typed `ctx` key, SPEC §8.1 rule 3). |
| 7 | B3/B4/B9: operation ids, `safe`, error type | **CONFORMING-DESIGN-EXISTS** (`syntheticOp`, `ProjectionConfig.http.verb`, `ApiError` and the gateway error builders). |
| 8 | Multi-host gateway as the shared single-server and aggregator mechanism (owner's mid-review ask) | **CONFORMING-DESIGN-EXISTS** for routing, supervision, partial availability and a policy-outermost front. It needs an ADR-level reading of `Operation.host` (BA-7, no type change). Per-host deadlines and a dynamic tool list would be extensions E7 and E8. |

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

**Verdict: CONFORMING-DESIGN-EXISTS.** Option-by-option configuration with `--use <package> --opt` would need extension E4, which the owner does not have to take.

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
| batch | mount | Options arrive through `mount.operations(…, opts)` (`apigen-plugin-batch/src/lib/plugin.ts:271`; mcp `run.ts:445`). |

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

**Verdict: split.** A conforming fronting mechanism exists. Three host-visible behaviours of today's bespoke `serveMcpPassthrough` cannot be expressed on the standard path. Each needs an extension, or the owner accepts the standard projection.

### Two candidate representations on the standard path

| | Package operations (`pkg.fns` + `composeSchemas`) | **Mount operations (chosen)** |
|---|---|---|
| Arguments | `{data:{…}}` wrapper (`run.ts:302`); positional `fns` drop undeclared keys (`dispatch.ts:128-133`) | Flat `raw.args`, undeclared keys kept (`run.ts:300-302`) |
| Advertised `inputSchema` | Composed `{data}` schema | The upstream's own schema (`run.ts:382-386`, `:615`, `:631`) |
| Validate Layer | Runs | No-op (`dispatch-for-plan.ts:19-25`), same as G5 today |
| Signal to the invocation | None (`invoke.ts:197-205`) | `call.signal` reaches the handler (`dispatch-for-plan.ts:115`), once F1 is fixed |
| Served on CLI/HTTP too | Yes, wrapped | Yes, flat (cli `run.ts:710-745`; fastify `run.ts:313-323`). This answers the review's transport-asymmetry point. |

### Each passthrough behaviour on the mount path

| Bespoke behaviour (`mcp-passthrough-server.ts`) | Standard mount path | Status |
|---|---|---|
| Tool name verbatim (`:121`, `:124`) | `project(op).mcp.name` = namespace and path words joined with `_` (`naming.ts:155-156`); `syntheticSegment` lowercases and splits on case, `-` and `_` (`plugin.ts:508-516`). So `readFile` in source `fs` becomes `fs_read_file`. | **Not expressible** → BA-1 or E1 |
| Full `Tool` object (title, annotations, outputSchema) | `ToolListMeta` carries only `description`/`inputSchema`/`outputSchema` (`run.ts:146-150`); mounts never bind an output schema. Descriptions can come from the existing `options.toolDescriptions` (`run.ts:466-467`, `:627`), but `buildToolDescription` appends the input description and a synthesized example (`apigen-engine-runtime/src/lib/tool-description.ts:59-73`). | **Partly** → BA-3 or E3 |
| Flat arguments, undeclared keys included (`:137`, `:144-149`) | `raw.args` (`run.ts:300-302`). Caveat: apigen reads `_meta` from inside `arguments` (`run.ts:692`), and for mounts that key stays in the arguments (finding F6, unverified against the MCP spec). | **Expressible** |
| No validate Layer (G5) | No-op for mounts | **Parity** |
| Layer stack, `set` reaches upstream (`:144-150`) | Mount calls run through `createPackageInvoker({}, usePlugins)` (`run.ts:598`, `:633-635`); `coreCall.data === domainArgs` | **Expressible** |
| `envelope: {}` (`:136`) | `plan.envelope` is `[]` for schema-less mounts (`op-plan.ts:368`), so the envelope is `{}` | **Parity** (both lack §9.1 for mounts, F2) |
| Per-request cancel via `extra.signal` (`:132`) | The host ignores `extra` (`run.ts:685`) | **Bug F1**, fixed at the source, no extension |
| Verbatim `CallToolResult` (`:152`) | `writeResult` emits `content:[{type:'text', text: JSON.stringify(result)}]`, plus `structuredContent` only for bound object schemas (`run.ts:319-332`). Images and resources are serialised as JSON; upstream `isError` cannot be emitted. | **Not expressible** → BA-2 or E2 |
| Refusal → `isError` result (`:154`) | `writeError` rethrows (`run.ts:335-345`). The SDK maps a non-integer `code` to `-32603` with the message (`node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js:402`). SPEC §9 lists MCP as "error" for every code (`SPEC.md:400-406`). | **Different, documented binding** → BA-4 |
| Upstream `McpError` code verbatim (`:160-161`) | Rethrown; an integer code survives `protocol.js:402` | **Expressible** |
| Unknown tool → `InvalidParams` (`:129`) | `throw new Error('Unknown tool')` → `-32603` (`run.ts:689`) | Minor difference |
| Upstream exit shuts the server (`:189`) | Gateway supervision (item 8), or the wrapper aborts `mcpPlugin.run` on `onExit` | BA-6 |
| stdin EOF shutdown (`stdio-host-transport.ts`) | Already in the MCP plugin (`run.ts:850-892`, see B7) | **Expressible**; delete the duplicate |
| `serverInfo` = `adhd-policy` | `packages[0].id ?? 'apigen-mcp'` (`run.ts:666-672`) | Cosmetic, BA-9 |
| Injectable host `Transport` (6e27d320) | `options.transport` is a string (`run.ts:923`). Tests use the `process.stdin` spy precedent (`apigen-plugin-mcp/src/test/run-lifecycle.spec.ts:186-193`) or in-process loopback `streaming-http`, which DoD #10 allows. | **Expressible**; `IVerbDeps.hostTransport` is deleted |

### Design (shared with item 8; the single-server wrap is N=1)

```ts
// NEW packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-upstream-adapter.ts
export interface IMcpUpstreamSpec {
  readonly name: string;                                   // user alias, never serverInfo.name (G2)
  readonly transport:
    | { kind: 'stdio'; command: string; args: readonly string[]; cwd: string; env?: Record<string, string> }
    | { kind: 'http'; url: string };
}
export interface IMcpUpstreamAdapter extends HostAdapter {  // host = `mcp:${name}`, hopCost: 1
  readonly sourceName: string;
  tools(): readonly Tool[];                                // the list from the first successful start()
}
export function createMcpUpstreamAdapter(
  spec: IMcpUpstreamSpec,
  deps: { launcher?: IProcessLauncher; handshakeTimeoutMs?: number; callTimeoutMs?: number; onWarn?: (l: string) => void }
): IMcpUpstreamAdapter;
// start: spawn (launcher) or connect + initialize + tools/list (skip rules of mcp-source.ts:165-186). Idempotent.
// ready: connected && client.ping(). invoke(req, signal): tools/call {name: req.operation.path.at(-1).raw,
// arguments: req.data} with {signal, timeout: callTimeoutMs}. onExit: client.onclose. stop: dispose.

// NEW packages/apigen/apigen-engine-gateway/src/lib/sources/upstream-mount.ts
export function createUpstreamMountPlugin(input: {
  gateway: Pick<Gateway, 'route' | 'health'>;
  upstreams: readonly IMcpUpstreamAdapter[];
  include?: (op: Operation) => boolean;                    // static filter, evaluated once (item 8)
  onWarn?: (line: string) => void;
}): { plugin: Plugin; projection: ProjectionConfig; toolDescriptions: Record<string, string> };
// mount.operations(d): per tool, op = syntheticOp(`${src}/${tool.name}`, {...d, host: adapter.host},
//   {input: tool.inputSchema, async: true, safe: false}). Skip and warn when syntheticOp throws (empty segment)
//   or a tool name contains '/'. Accept incrementally while checkCollisions([...accepted, op]) passes.
//   handler: call => gateway.route({operation: op, data: call.data, envelope: call.envelope,
//   transport: call.transport}, call.signal), then map the CallToolResult per ADR-0004: structuredContent,
//   else the single text item, else the content array. An upstream isError throws
//   ApiError('internal', text, {source, tool}).
//   projection: http.verb[op.id] = 'POST' for every op (naming.ts:150-152). toolDescriptions: name -> tool.description.
```
Wrapper `entrypoint/policy/src/wrapper/verbs/serve.ts`:
```ts
// BEFORE: resolveSource(spec,'serve') -> serveMcpPassthrough({source, usePlugins, serverInfo, transport, signal})
// AFTER
const adapters = specs.map((s) => createMcpUpstreamAdapter(s, deps));   // N=1 for `serve bin:x`
const gateway = createGateway({ adapters, defaultDeadlineMs: callTimeoutMs + 1_000 });
await gateway.start();                                                   // handshake failure rejects (D-08)
const up = createUpstreamMountPlugin({ gateway, upstreams: adapters });
await mcpPlugin.run({ packages: [], operations: [], outputDir: '', signal: deps.signal,
  options: { transport: 'stdio', usePlugins: [up.plugin, tracingPlugin, ...gate.usePlugins],
             projection: up.projection, toolDescriptions: up.toolDescriptions } });
await gateway.stop();
```
**Deleted from the branch:** `sources/mcp-passthrough-server.ts`, `sources/stdio-host-transport.ts`, the `serve` arm of `resolve-source.ts` and `IResolvedSource.mcp`, `IVerbDeps.hostTransport`, and `src/test/sources-passthrough.spec.ts`. `resolveMcpStdioSource` folds into the adapter.

**Source fix, not an extension (F1):** `apigen-plugin-mcp/src/lib/run.ts` changes the `tools/call` handler to `async (req, extra)` and threads `extra.signal` through `McpRaw` into `readCall`'s return value. `gx impact McpTransportAdapter`: LOW, 4 nodes.

**Blast radius:** the gateway `sources/*` consumers are `entrypoint/policy/src/wrapper/verbs/{run,serve}.ts`, `failure.ts` and the test helpers listed under item 7. `mcpPlugin.run` itself is unchanged except for F1.
**Tests:** `apigen-plugin-mcp/src/test/{run,run-lifecycle,flat-content-payload,transport-http-parity}.spec.ts` must stay green after F1. `apigen-engine-gateway/src/test/{gateway,sources-mcp-source,sources-process}.spec.ts` are kept and extended. `entrypoint/policy/src/test/functional/{s7-serve,s8-serve-handshake-and-precedence}.spec.ts` move to the stdin-spy or loopback seam.
**Order:** F1 and item 7 come before the wrapper change.

---

## 3. B1: where `bin:`/`remote:` sources and an aggregator belong

**Verdict: CONFORMING-DESIGN-EXISTS.** Each source concern maps to a member that already exists:

| Concern | Existing member | Evidence |
|---|---|---|
| Contribute a foreign upstream's operations | `mount` capability ("ADD operations") | `SPEC.md:238`; `plugin.ts:443-494`. The parked Phase-4 verdict itself names `--use` mounts as the mechanism that "already works today" (`docs/apigen/proposals/transport-serve-core-refactor.md:217`). |
| Invoke out of process (local stdio or remote http) | `HostAdapter` + `createGateway` | `gateway.ts:191-236`, `:407-658`; SPEC §13.1/§14.4 (`SPEC.md:538-567`) |
| Host it on any transport | Every `target` with mount support | mcp `run.ts:590-637`; cli `run.ts:710-745`; fastify `run.ts:313-323` |
| Govern it | `layer` through `--use`, which also wraps mounts | `dispatch-for-plan.ts:15-29` |
| `bin:` argv one-shot (`run` verb) | Package operation through the serve-core primitives (item 4) | — |
| `adhd-apigen run --source bin:<cmd>` (f6bf8550 item 1) | **None.** `--source` is a required file path, and its functions are imported from it (`run.ts:249`, `:405-420`). | **E5** (Phase 4 / DEBT-APIGEN-SERVE-CORE-011). Not needed for policy. |

**Home:** the adapter and mount factory stay in `apigen-engine-gateway` (engine tier, already `platform:node`, already depending on `@adhd/apigen-core-client`). It gains `@adhd/apigen-engine-naming` for `checkCollisions` and drops the branch's `@adhd/apigen-engine-runtime` edge, whose only user is the passthrough's `adaptCoreLayer`. No new package is created. `sources/types.ts:1`'s "for `adhd-policy run|serve`" header and `SourceIntent` (`:17-18`) are deleted.

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
  - The host tag falls under BA-7. The argv operation is never routed through the gateway.
- **B4 (MCP):**
  - The id is `<source>/<tool>` through `syntheticOp` (item 2).
  - `safe:false` comes from the `syntheticOp` field, and the `x-apigen-safe` rewrite (`mcp-source.ts:246-250`) is deleted because mounts never go through `composeSchemas`.
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

**Mechanism:** upstream specs (local stdio `bin:` or remote `http`) → one `IMcpUpstreamAdapter` each (`HostAdapter`, host `mcp:<source>`) → `createGateway({adapters})` → `createUpstreamMountPlugin` → **any** apigen host (`mcpPlugin.run` over stdio or streaming-http, or `cliPlugin`/fastify), with `usePlugins: [upstreamMount, tracing, attributes, policy]`. Policy is outermost relative to every upstream by `usePlugins` order. The single-server `serve bin:x` is exactly N=1. `serve --from mcp.json` is N>1. Remote upstreams differ only in the client transport inside the adapter.

| Topic | Today | Conforming answer | Shortfall → decision |
|---|---|---|---|
| Routing key | Gateway routes by `operation.host`, one adapter per host, throws on duplicates (`gateway.ts:417-422`, `:591`); every MCP source op is stamped `host:'ts'` (`mcp-source.ts:192`) | Stamp `mcp:<source>` per upstream (a string value; `Operation.host: string`, `descriptor.ts:165-169`) | Meaning of `host` beyond "language runtime" → **BA-7** (ADR-level reading, no type change) |
| `serve` uses the gateway | No (`serve.ts:41-54`); the gateway has 0 production callers | Mount handler → `gateway.route` | — |
| Partial availability, restart | Passthrough exits on upstream close (`mcp-passthrough-server.ts:189`) | Supervision with backoff (`gateway.ts:474-503`); `unavailable` names the host (`:87-104`, `:608-614`) | N=1 behaviour change → **BA-6** |
| Per-upstream timeout | Gateway deadline is global (`gateway.ts:321-322`, `:408`, `:617`) | The adapter enforces its own `callTimeoutMs` through the SDK request timeout; the gateway default is ≥ the maximum | True per-host deadline → **E7** (only if needed) |
| Tool list | — | `mount.operations` is synchronous and called once (`plugin.ts:461-465`; mcp `run.ts:590-596`, dod.12), so all upstreams start eagerly before the host and the list is fixed. This matches spec 2026-07-28's constant-list rule (assessment `GATEWAY-AGGREGATION-ASSESSMENT.md:35`). | Lazy start, `listChanged`, policy-edit refresh → **E8** |
| Name collisions | `registerRoute` is a `Map` keyed by MCP name, so the last writer wins silently (`run.ts:241`) | `checkCollisions` over the merged mount ops; skip and warn (SPEC §5, `SPEC.md:179-183`) | — (F3 for apigen generally) |
| Aggregate health | — | A `_meta/upstreams` mount over `gateway.health()` (`gateway.ts:620-637`) in the same plugin. It cannot be named `_meta/health`, or it would collide with `--use health`. | — |
| Hide denied tools | Denied tools are listed (D-08) | Static `include` predicate evaluated once at `mount.operations` | Dynamic filtering needs E8 |
| Names | — | `<source>_<tool>` (`naming.ts:155-156`). For an aggregator, the MCP spec says SHOULD prefix (assessment `:36`). | N=1 verbatim names → **BA-1/E1** |
| Per-upstream env (c6ca91d6) | Fixed allowlist of 8 names plus `spec.env` (`sources/process.ts:48-57`), a different list from the SDK's | The adapter spec carries `env`; base it on SDK `getDefaultEnvironment()` (verified `stdio.js:7`, `:35`) | — |
| Remote upstream | `remote:` throws (`resolve-source.ts:50-51`) | Same adapter with the SDK streamable-HTTP client transport (class name **unverified**), `hopCost: 1` | — |
| Remote front | — | `mcpPlugin.run({transport:'streaming-http'})` (`run.ts:923-925`) | — |
| Two gateway implementations | `adhd-apigen serve` has its own proxy (`serve.ts:1-60`) | Out of scope; recorded as F7 | — |

**Not reusable without an extension:** none of the core mechanism. The verbatim-name and verbatim-result needs of the N=1 wrap are the only gaps, and they are the same gaps as item 2.

---

## 9. Remediation sequence (single ordered list, with parallelism)

| Wave | Segment | Items | Depends on | Parallel with |
|---|---|---|---|---|
| 0 | S1: CommonJS-only re-emit of the three packages + generator fix | X1 | — | S2, S3 |
| 0 | S2: MCP host wires `extra.signal` into `Call.signal` (`apigen-plugin-mcp`) | F1 | — | S1, S3 |
| 0 | S3: dispatch `$ref` resolution, then delete both `dereferenceSchema` copies | C4 (1bb4b5d5) | — | S1, S2 |
| 1 | S4: plugin-policy `ctx` key, then `makePolicyPlugin`, default deny-all, core-client typing; delete `state.ts`, the mount capability and `load-decider.ts` | A4, A1, A3, A6 | S1 (shared `package.json`) | S5, S6 |
| 1 | S5: gateway `createMcpUpstreamAdapter`, `createUpstreamMountPlugin`, `syntheticOp` argv op, `ApiError`; delete passthrough, `stdio-host-transport`, `SourceError` and the serve arm | B3, B4, B5, B6, B7, B8, B9 | S2 for the cancel proof | S4, S6 |
| 1 | S6: `buildApigenPackage` helper in runtime + backlog migration | C2 | owner BA-10 | S4, S5 |
| 2 | S7: wrapper `gate.ts` (`makePolicyPlugin`, `ctx` attributes), `serve` via gateway + `mcpPlugin.run`, `run` via `createPackageInvoker`/`dispatchForPlan` + tracing, `failure.ts` | C5, C6, C7, A4 | S4, S5, and BA-1 to BA-6 decided | — |
| 2 | S8: IR through the ir-cache artifact target + reader; delete the bake | C3 | S1, S6, and the parity proof | after S7 (shared `mount.ts`/`package.ts`) |
| 3 | S9: tests. Functional specs on the stdin-spy or loopback seam. Real stdio proof in an `e2e` target per ADR-0009 (`0009-...md:19-25`); the owner's "no e2e" (`docs/plan/policy-core/README.md:12`) still governs whether it runs locally. | all | S7, S8 | S10 |
| 3 | S10: docs. INTERFACES D-07, D-08, D-14, D-18, D-19, D-20, D-21 superseded; plugin and gateway READMEs; `packages/apigen/README.md` table | all | S7 | S9 |

**Gates for every segment:** `npx nx affected -t lint,typecheck,typecheck-spec`; `nx affected -t test`; `verify-dist-load` on the three packages.

---

## 10. Owner decisions still required

### 10a. Behaviour-change acceptances (the conforming design needs no extension, only acceptance)

| ID | Accept… | Otherwise |
|---|---|---|
| BA-1 | Single-server wrap tool names become `<source>_<tool>`, with words snake-cased (`readFile` → `fs_read_file`). This breaks GW-03/D-08 and users' `mcp__<server>__<tool>` host rules after `mcp-json init`. | E1 |
| BA-2 | Upstream results projected per ADR-0004: flat payload on text `content`, images and resources serialised, upstream `isError` raised as an error | E2 |
| BA-3 | `tools/list` drops title, annotations and outputSchema; descriptions gain apigen's synthesized example | E3 |
| BA-4 | A refusal is a JSON-RPC `-32603` error carrying the reason (SPEC §9) instead of an `isError` result (D-04/U12) | E2 |
| BA-5 | Operation ids move from `.` to `/` (`fs/read_file`, `bin/touch`); policy files and `draft` output migrate | — |
| BA-6 | An N=1 upstream crash is supervised (restart, `unavailable`) rather than shutting the server down. The wrapper could instead abort on `onExit`. | — |
| BA-7 | `Operation.host` may name a non-language runtime (`mcp:<source>`, `bin`). An ADR-level clarification of `descriptor.ts:165-169`; no type change. | — |
| BA-8 | Bare `--use @adhd/apigen-plugin-policy` denies everything; configuration is a local `--use` module; string decider specifiers are dropped | E4 |
| BA-9 | MCP `serverInfo` falls back to `apigen-mcp` (cosmetic) | — |
| BA-10 | `buildApigenPackage` helper export in `apigen-engine-runtime` (a refactor helper, **not** a taxonomy member) | Duplicate stays (689af7c3) |
| BA-11 | Only if `cliPlugin` is chosen for `run`: JSON report output | E6 |

### 10b. True taxonomy extensions (decide only if the behaviour is wanted; none is required by the conforming designs)

| ID | Extension | Member it would add | Note |
|---|---|---|---|
| E1 | MCP tool-name override | `ProjectionConfig.mcp.name[id]` (`naming.ts:116-123`) | SPEC Tenet 1 already names "name" as a projection-override category (`SPEC.md:30-31`), but the type lacks it |
| E2 | Raw `CallToolResult` passthrough | `McpTransportAdapter.writeResult` channel for pre-shaped results (`run.ts:306-333`) | Interacts with ADR-0004 D1. SPEC §9's "complete opt-out → raw passthrough" (`SPEC.md:395-396`) is documented but not built. |
| E3 | Tool metadata passthrough for mounts | `MountedOperation`/`ToolListMeta` fields (`plugin.ts:478-494`; `run.ts:146-150`) | — |
| E4 | `--use <pkg> --opt` for Layers | `LayerCapability.createLayer(opts)` + apigen-cli filling `useOptions` (`plugin.ts:305-330`; `run.ts:321-324`) | Review remediation #1 |
| E5 | `--source bin:`/`remote:` in apigen-cli | Phase 4 source plugin (DEBT-APIGEN-SERVE-CORE-011, epic 292bd882; `transport-serve-core-refactor.md:217-225`) | Its revisit trigger has fired (review P15) |
| E6 | cli-output raw-output mode | New cli-output option | Only with BA-11 |
| E7 | Per-host gateway deadline | `GatewayOptions`/`HostAdapter` field | Only if adapter-level timeouts are insufficient |
| E8 | Dynamic tool list (lazy start, `listChanged`, filtered refresh) | A tools/list hook for Layers or mounts | Spec 2026-07-28 tension (assessment §4.8) |

## 11. Findings discovered while verifying (not filed: this run had no backlog write access)

- **F1** — The apigen MCP host never wires per-request cancellation into `Call.signal` for any operation (`apigen-plugin-mcp/src/lib/run.ts:685`, `:283-304`; contract at `plugin.ts:114-119`).
- **F2** — Mount operations never receive §9.1 envelope fields on any host, because `plan.envelope` is empty without a composed schema (`op-plan.ts:368`).
- **F3** — Mount operations are not collision-checked; the MCP route `Map` overwrites silently (`run.ts:241`).
- **F4** — tracing, logger, backlog and environment-core-node still emit an `.mjs` build and declare `module`, against ADR-0003 D1/D2 (their `package.json` files; `apigen-plugin-tracing/vite.config.ts:34`). Possibly a99fe8dd.
- **F5** — `apigen-plugin-policy` and `policy-core-client` use `manifestRootsToUpdate: ["dist/{projectRoot}"]`, while siblings use the project root (tracing `project.json:6-11`).
- **F6** — The MCP adapter reads `_meta` from inside `tools/call` `arguments` (`run.ts:692`) and leaves it in a mount's arguments (`run.ts:300-302`). Whether `_meta` belongs at `params` level per the MCP spec is **unverified**.
- **F7** — Two gateway implementations exist: `createGateway` has no production caller, and `adhd-apigen serve` uses its own proxy (`entrypoint/apigen-cli/src/lib/commands/serve.ts:1-60`).
