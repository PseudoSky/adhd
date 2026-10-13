# apigen conformance review: policy-core initiative

Date: 2026-10-13. Reviewer: architect-reviewer (independent, read-only on source). Review baseline: branch `feat/policy-core`, the code as of `889522ec`, with the plan documents re-read at `a88b273b` (the commits in between change tests and docs only, not any reviewed source file). Every path below is relative to the worktree root `.worktrees/policy-core`, and every claim cites `file:line` that was opened and read.

**Question:** do the apigen-facing packages and plans from this initiative match the principles, structure and taxonomy of the apigen system, without one-off functionality or unique usage?

**Short answer: partly.** The parts that ride the established seams conform: the CLI, MCP and HTTP surfaces of `@adhd/policy`, the `ctx`-first operation convention, the Layer's short-circuit, error and stream semantics, and the package tags. Three things do not:

1. **The Layer cannot be configured through the documented `--use` channel.** No host populates per-plugin options, so the default export denies every call. The plugin works around this with a mount-capability hack and a module-scope singleton instead of fixing the contract gap.
2. **All three new packages are ESM-only.** This contradicts accepted ADR-0003.
3. **The `bin:` source work builds a parallel stack beside apigen's seams instead of on them.** It adds a bespoke MCP server, its own Layer composition, its own error type, hand-built operations with non-derived ids and a `run` verb that bypasses the CLI host. The owner's own direction (backlog f6bf8550) and the plan's own rule (T08 "do not build a stopgap shell") both rejected this shape.

---

## 1. Principles used as the yardstick (derived from primary sources)

| # | Principle | Where it is established |
|---|---|---|
| P1 | Tenet 0/1: the source functions are the single source of truth. All configuration is out-of-source: CLI flags, plugin `--opt` and config, never a source change. | `docs/apigen/SPEC.md:11-37` |
| P2 | The canonical descriptor: `id` is a deterministic slug, a pure function of `namespace/path`, and is never re-cased. A uniqueness check runs over the merged descriptor. | `docs/apigen/SPEC.md:104-126`, `:179-183` |
| P3 | The plugin is the distributable unit. Its only capabilities are `target`, `layer`, `mount`, `envelope` (plus `extractLayer`, added later). `--type` picks a target and `--use` loads layer, mount and envelope plugins. There is **no `source` capability**. | `SPEC.md:222-241`; `apigen-core-client/src/lib/plugin.ts:723-766` |
| P4 | `ctx` is the typed request-extension map threaded Layer to Layer to fn. Inter-Layer data travels on `ctx`. The envelope is the transport-metadata side channel keyed `x-<pluginId>-<field>`. | `SPEC.md:329-330`, `:373-375`, `:389-424`; `plugin.ts:54-81`, `:101-111` |
| P5 | There is one harness. Every transport is a thin adapter over `invoke = Layers -> validate -> dispatch`, and validation is a built-in Layer that is always innermost. | `SPEC.md:196-200`, `:325-328`; `apigen-engine-runtime/src/lib/package-invoker.ts:143-162` |
| P6 | There is one error taxonomy. An `ApiError{code}` maps per transport through `HTTP_STATUS` and `CLI_EXIT_CODE`, and the gateway's own distributed-system errors are also `ApiError` with `details`. | `SPEC.md:397-406`; `apigen-base-errors/src/lib/errors.ts:40-83`; `apigen-engine-gateway/src/lib/gateway.ts:81-127` |
| P7 | Packaging: neutral content (descriptor in, artifact out) is common, and anything that runs a server or touches host functions is per-language. The gateway is listed as COMMON. | `SPEC.md:483-517` |
| P8 | The gateway seam is `HostAdapter` (start, ready, invoke, onExit, stop, hopCost) with the §13.1 failure model: partial availability, readiness, supervision, deadlines. | `SPEC.md:538-554`; `gateway.ts:182-236`, `:395-467` |
| P9 | Shared primitives already exist and must be reused: `createPackageInvoker`, `adaptCoreLayer`, `readUseOptions` (serve-core promotion, dod.13), `syntheticOp` (BUG-APIGEN-SYNTHETICOP) and the ir-cache artifact target. | `package-invoker.ts:1-19`; `plugin.ts:496-594`; `apigen-plugin-ir-cache/src/index.ts:1-21`; `docs/plan/apigen-serve-core/README.md:160` |
| P10 | Opts-aware plugins use a factory. `ExtractLayerCapability.createLayer(opts)` exists because "a plain layer built once at module-import time can never see a caller's `--use <id> --opt` value". The dispatch-side per-plugin `UseOptions` shape is something "nothing in apigen-cli populates today". | `plugin.ts:351-383` |
| P11 | Sibling Layer plugins (logger, tracing) export a `Plugin<Opts>` from core-client with `optionsSchema`, `description` and `language`, a fixed-default default export, and a `make<Name>Plugin(opts)` factory. | `apigen-plugin-tracing/src/lib/plugin.ts:140-160`, `:400-451`; `apigen-plugin-logger/src/lib/plugin.ts:238-320` |
| P12 | ADR-0003: `@adhd/*` publishes CommonJS-only. That means `main` only, `type` unset, no `module`, no `exports`, and the ESM half "must not be reintroduced piecemeal". | `docs/decisions/0003-adhd-packages-publish-commonjs-only.md:12-14`, `:42-53` |
| P13 | ADR-0002 and AGENTS.md §8 Two-Use rule: correct the source, never shim, duplicate or work around at the consumer. | `docs/decisions/0002-correct-the-source-never-work-around.md:10-12` |
| P14 | ADR-0009 lanes: unit `test` has no subprocess, and `e2e` owns every real-process proof. AGENTS.md §7: a feature is proven only through its real entrypoint. | `docs/decisions/0009-test-lanes-unit-vs-e2e.md:12-22` |
| P15 | Source-kind taxonomy. Modelling `--source` as a source-plugin (DEBT-APIGEN-SERVE-CORE-011, "Phase 4") is PARKED, with a revisit condition: "when a second TS-side source kind ... is actually proposed with a concrete consumer, re-open Phase 4 as its own proposal". The owner wants foreign MCP servers and commands to enter apigen "as source kinds beside source files, so every host and Layer works on them unchanged, instead of hand-written proxy shells". | `docs/apigen/proposals/transport-serve-core-refactor.md:217-225`; `docs/plan/apigen-serve-core/README.md:146-148`; backlog f6bf8550 body item 1 |
| P16 | Tag taxonomy: `<domain>-<tier>-<name>`. Tags are `domain`, `pkg-kind`, `pkg-class`, `layer`, `platform` and `access`. A plugin depends on base and core. | AGENTS.md §2; `docs/contributing/conventions/package-naming.md`; `.adhd/workspace.json` (groups include `policy`) |

---

## 2. Findings by item

Severity key: **BLOCKING** (taxonomy or contract violation that breaks a documented behaviour or an accepted ADR), **SHOULD-FIX** (real divergence with a maintenance or behaviour cost), **NOTE** (consistency or documentation).

### 2.1 `packages/apigen/apigen-plugin-policy`

#### A1. The `--use` options channel is a mount-capability capture plus a module-scope singleton. Verdict: **DEVIATES, BLOCKING**

- **Principle:** P10 and P3. A Layer that needs options gets them through a factory, the way `ExtractLayerCapability.createLayer` does.
- **Evidence, part 1 (the hack):**
  - The default export's `mount.operations` stores the options in module state and returns `[]` (`plugin.ts:329-339`, `state.ts:13-24`).
  - The `layer` capability then delegates to a plugin built from that state (`plugin.ts:292-327`).
  - The README states "one configuration per process" (`README.md:34`).
- **Evidence, part 2 (the channel it relies on does not exist):**
  - Hosts pass `useOptions[plugin.id]` to `mount.operations` (`apigen-plugin-mcp/src/lib/run.ts:445`, `apigen-plugin-cli-output/src/lib/run.ts:586`, `apigen-plugin-api-fastify/src/lib/run.ts:323`), but **nothing fills `useOptions`**.
  - `rg useOptions entrypoint/apigen-cli/src` has zero hits. `run.ts:321-324` sets only `options.usePlugins`, and `plugin.ts:357-363` says so explicitly.
- **Consequence:** the README's own canonical command, `adhd-apigen run --use <auth layer> --use @adhd/apigen-plugin-policy --type mcp` (`README.md:22-26`), loads a plugin that throws `ApiError('internal', 'no decider configured')` on every call (`plugin.ts:296-299`). The only working path is the programmatic `createPolicyLayerPlugin`, which is what the wrapper uses (`entrypoint/policy/src/wrapper/gate.ts:46`).
- **Cost:**
  - A documented behaviour that cannot work.
  - Process-global mutable state, in a repo whose invariant is parallel-process and multi-mount.
  - A precedent of "abuse `mount` as a config hook" that other plugins would copy.
  - The plan codifies the workaround as a decision (D-14 and D-19, `INTERFACES.md:31`, `:34`) instead of fixing the source (P13).
- **Cheapest conforming alternative:**
  1. Add `createLayer?(opts)` to `LayerCapability` (`plugin.ts:305-330`), mirroring `ExtractLayerCapability.createLayer` (`plugin.ts:369-383`).
  2. Have `createPackageInvoker(schemas, usePlugins, useOptions?)` (`package-invoker.ts:149-162`) prefer `createLayer(useOptions[id])`.
  3. Have apigen-cli build `useOptions` from `--opt` (or from a namespaced `--opt <id>.<key>=`).
  4. Delete `state.ts` and the mount capture, and follow the sibling shape: default export plus `makePolicyPlugin(opts)` (P11).

#### A2. Module format is ESM-only, contradicting ADR-0003. Verdict: **DEVIATES, BLOCKING** (cross-cutting, see X1)

- **Evidence:**
  - `package.json:4` has `"type": "module"`.
  - `:5-14` has `main`, `module` and an `exports` map.
  - `vite.config.mts:54` has `formats: ['es']`.
  - Every sibling plugin has no `type`, no `exports` and a dual `es`/`cjs` build (`apigen-plugin-tracing/vite.config.ts:34`, `apigen-plugin-batch/vite.config.ts:37`, `apigen-plugin-logger/vite.config.ts:37`).
  - The `.mts` config forced a custom `test` command override (`project.json:52-58`; backlog ec74a394).
- **Plan defect:** REVIEW-FIXES L7 tells the implementer to "add `exports`/`files` to package.json mirroring sibling plugins" (`docs/plan/policy-core/REVIEW-FIXES.md:40`). No sibling has `exports`, and ADR-0003 D1 forbids it (`0003-...md:42-45`). The fix therefore moved the package further from the standard.
- **Cost:** It reopens the exact interop class ADR-0003 closed. The dynamic `import()` of a decider in `load-decider.ts:47` behaves differently under CJS, which is the format the package must publish in.
- **Alternative:** Emit CJS (`formats: ['cjs']`), unset `type`, drop `module` and `exports`, and rename to `vite.config.ts` so the inferred test target works without the override. The root cause is upstream: `workspace-codegen-nx`'s shared generator accepts Nx 23's `.mts` ESM scaffold as is (`packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:155-171`). Fix it there so the next package is born conforming.

#### A3. Contract surface: typed against the runtime, not the core plugin contract. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:**
  - The plugin imports `UsePlugin` and `Call` from `@adhd/apigen-engine-runtime` (`plugin.ts:2`) and reads the runtime shape `call.domainArgs` (`plugin.ts:227`, `:256`). The core contract's `Call` carries `.data` (`apigen-core-client/src/lib/plugin.ts:96-126`), which `adaptCoreLayer` aliases (`package-invoker.ts:133-141`).
  - The plugin has no `optionsSchema`, `description` or `language` (compare `apigen-plugin-tracing/src/lib/plugin.ts:400-425`).
  - The factory is named `create...` where siblings use `make...` (P11).
- **Mitigation:** `apigen-plugin-batch` also depends on `apigen-engine-runtime` (`apigen-plugin-batch/package.json`), so the dependency edge has precedent.
- **Cost:** Coupling to the runtime's internal `Call` instead of the published core contract. A Layer written this way breaks if `adaptCoreLayer` ever stops aliasing.
- **Alternative:** Type against `Plugin` and `Call` from `@adhd/apigen-core-client`, read `call.data`, and declare `optionsSchema` so `--use ... --opt` can be validated.

#### A4. Attribute channel: an undeclared envelope key `attributes` written by one Layer and read by another. Verdict: **DEVIATES, SHOULD-FIX**

- **Principle:** P4. Inter-Layer data belongs on `ctx`, a typed extension map (§8.1 rule 3). Envelope keys are transport metadata named `x-<pluginId>-<field>` (`SPEC.md:420-424`).
- **Evidence:**
  - The plugin reads `envelope['attributes']` (`plugin.ts:83-106`) and declares no envelope field. The wrapper's Layer writes the same key (`entrypoint/policy/src/wrapper/attributes-layer.ts:24-25`).
  - The safety argument rests on "do not add one" (`README.md:18`, `INTERFACES.md:33` D-18).
  - The review itself asked to move the channel to `call.ctx` if there was any doubt (`REVIEW-FIXES.md:36`, L3).
  - The risk is already open as backlog f4d95c61.
- **Cost:** Security depends on a documentation convention. The key name is outside the §9.1 namespace scheme. Any future auth plugin must reproduce an undeclared, unnamespaced key.
- **Alternative:** Export a typed key class (for example `PolicyAttributes`) and have the auth or attributes Layer `call.ctx.set(PolicyAttributes, attrs)` and the policy Layer `call.ctx.get(PolicyAttributes)`. `ctx` is `new LayerContext()` per call and never client-fed (`dispatch-for-plan.ts:93`, cited in T07.md:79), so the safety property comes from the type, not from prose.

#### A5. Layer semantics: short-circuit, error, stream, signal. Verdict: **CONFORMS**

- **Evidence:**
  - Deny throws `ApiError('permission_denied', reason, {code:'policy-denied'})` without calling `next` (`plugin.ts:281-285`), which is §8.1 rules 1-2.
  - Streaming results pass through untouched because `return next()` is used (`plugin.ts:285`).
  - The decider gets `call.signal` combined with a deadline signal (`plugin.ts:236-247`).
  - Fail-closed on every failure (`plugin.ts:270-273`).
- `permission_denied` maps to CLI exit 3 and HTTP 403 through the shared tables (`errors.ts:40-66`).

#### A6. Decider loading. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** `load-decider.ts:31-61` reimplements the specifier-or-path to file-URL to `import()` resolution that apigen-cli already has in `loadUsePlugins` (`entrypoint/apigen-cli/src/lib/commands/run.ts:193-228`). Bare specifiers resolve from the plugin's install location (backlog d35b0dd2).
- **Alternative:** Move one `loadModuleSpecifier(spec, baseDir)` into `apigen-engine-runtime` (or core-client) and use it in both places.

#### A7. Standard files and docs. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:**
  - `files` lists `CHANGELOG.md` (`package.json:15-18`), but the package has none; every sibling ships one (directory listings of logger, tracing, batch, health).
  - The package is missing from the apigen package table (`packages/apigen/README.md:42-61`).
  - Its README covers behaviour, ordering and options (`README.md:1-49`).

#### A8. Tags and tier. Verdict: **CONFORMS**

- **Evidence:** `project.json:13-20` has `domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain`. This is identical to `apigen-plugin-tracing`, `-batch` and `-ir-cache`, and the name follows `<domain>-<tier>-<name>`.

### 2.2 `packages/apigen/apigen-engine-gateway/src/lib/sources/*` and the gateway's tags and exports

#### B1. Home and taxonomy: `bin:` sources and an MCP server inside the neutral gateway. Verdict: **DEVIATES, SHOULD-FIX**

- **Principles:** P7, P8 and P15. The contract has no `source` plugin capability, and the brief's framing of one does not match the code: capabilities are target, layer, mount, envelope and extractLayer only (`plugin.ts:723-766`). The established answer for "a second source kind" is the parked source-plugin Phase 4, whose revisit condition **has now fired** (`transport-serve-core-refactor.md:225`).
- **Evidence:**
  1. The package moved `platform:shared` to `platform:node` (`git diff ebd24f9c HEAD -- packages/apigen/apigen-engine-gateway/project.json`). It gained runtime deps on `@adhd/apigen-engine-runtime` and `@modelcontextprotocol/sdk` (`package.json` diff) for a module that "shares no symbols with `gateway.ts`" (`T08-discovery.md:31`).
  2. `sources/types.ts:1` is headed "Source kinds for `adhd-policy run|serve`". `SourceIntent = 'run' | 'serve'` (`types.ts:17-18`) names the policy wrapper's verbs.
  3. The only consumer is `entrypoint/policy` (`rg apigen-engine-gateway -g package.json`: `entrypoint/policy/package.json:13` only). `resolveSource` throws for `file` ("resolved by apigen-cli") and `remote` (`resolve-source.ts:50-53`), and apigen-cli has no `bin:` handling at all (`rg "bin:|resolveSource" entrypoint/apigen-cli/src`, no hits). So `adhd-apigen run --source bin:x --type <any>` does not exist.
- **Assessment by half:**
  - Spawning processes is legitimate for the gateway: §13.1 says the gateway "spawns, monitors, and restarts" sidecars (`SPEC.md:545`), so the retag is correct. The launcher and upstream-client half is in a defensible package but bypasses that package's own `HostAdapter` seam (see B5).
  - The MCP server half (B8) is a transport target and does not belong here.
- **Cost:** A new source kind reachable only through one product entrypoint is the definition of ONE-OFF. The neutral gateway now carries TS-runtime and MCP-transport coupling.
- **Cheapest conforming alternative:**
  1. Re-open DEBT-APIGEN-SERVE-CORE-011 scoped to `bin:` and `remote:` as its concrete consumers.
  2. Place source resolution at the EXTRACT stage, so the apigen-cli orchestrator accepts `--source bin:<cmd>` beside files and every `--type` and `--use` works unchanged (f6bf8550 item 1).
  3. Express invocation of foreign upstreams as `HostAdapter`s (B5).
  4. Move the host-side server to `apigen-plugin-mcp` (B8).

#### B2. `parseSourceSpec` and `resolveSource`. Verdict: **ONE-OFF, NOTE**

- **Evidence:** The `remote:` and `file` arms are parsed (`parse-source.ts:25-41`), but nothing resolves them (`resolve-source.ts:50-53`). The parser is generic, but the dispatcher it feeds is `adhd-policy`-only (B1.3).

#### B3. Argv-fallback operation construction. Verdict: **DEVIATES, SHOULD-FIX**

- **Principles:** P2 and P9.
- **Evidence:**
  - `buildArgvOperation` hand-builds a full `Operation` (`argv-operation.ts:38-75`) instead of using `syntheticOp` (`apigen-core-client/src/lib/plugin.ts:562-594`), which exists to stop hand-rolled operation boilerplate.
  - `id = fnName` is a bare basename with `namespace = path[0] = seg` (`argv-operation.ts:39-45`). That is "a literal override of the derived slug" (`T08-discovery.md:45`), not `buildId(namespace, path)`.
  - `host: 'ts'` is stamped on an external process (`:43`).
  - `fns` are positional wrappers that depend on dispatch's internal property-order convention (`resolve-source.ts:93-97`; `T08-discovery.md:18`).
  - **`Call.signal` does not reach the child through the apigen path.** The fn takes `(argv, cwd)` only (`resolve-source.ts:95-96`), and `createInvoker`'s core service calls `dispatch(fns, createClient, schema, fnName, envelope, domainArgs)` with no signal (`apigen-engine-runtime/src/lib/invoke.ts:197-205`). Cancellation works only through the process-wide `deps.signal` (`resolve-source.ts:74-77`), so a per-request MCP or HTTP cancel would not kill the child. Review fix G9 ("honor `Call.signal`", `REVIEW-FIXES.md:14`) is met for the `run` verb only.
- **Cost:** The ids bypass the §5 uniqueness check and the id grammar (see B4). Cancellation silently degrades on any host other than the policy CLI verb.
- **Alternative:** Build the operation with `syntheticOp('<ns>/<cmd>', d, {input, output, async:true})`. Thread `call.signal` into `dispatch` and the fns, which is a runtime fix that benefits every host. Mark foreign operations with a non-`ts` host tag (for example `bin`) so gateway routing can distinguish them.

#### B4. MCP source operations. Verdict: **DEVIATES, SHOULD-FIX**

- **Evidence:**
  - `id = '<source>.<tool>'` (`mcp-source.ts:187`) uses a `.` separator that SPEC's `/`-joined slug grammar does not have (`SPEC.md:106`, `:122`). Policy `tool:` keys therefore have two grammars (`policy/check` versus `fs.read_file`).
  - `host: 'ts'` (`:192`).
  - `composeSchemas` is called, and then `x-apigen-safe` is overwritten to `false` (`mcp-source.ts:246-250`). This works around a core-client rule in which an explicit `safe:false` loses to the primitive-only heuristic: `safe = fnSchema.safe === true || isPrimitiveOnlyInputSchema(...)` (`apigen-core-client/src/lib/compose-schemas.ts:231-232`). That is a consumer-side patch of a source gap (P13).
  - Positional `fns` drop undeclared arguments (`mcp-source.ts:214-230`; open backlog bd7f5327).
- **Cost:** The id grammar splits. The safe-override fix lives in the wrong package, and any other consumer that needs `safe:false` must repeat it.
- **Alternative:** Let `composeSchemas` honour an explicit `safe: false` (a tri-state in `GeneratedSchemas`). Derive ids with the core `buildId` (export it), for example `<source>/<tool>`. If the policy `tool:` grammar must keep the upstream tool name verbatim, carry it as an operation attribute instead of overloading `id`.

#### B5. Process launcher and environment allowlist. Verdict: **CONFORMS-WITH-NOTES, SHOULD-FIX**

- **Evidence:**
  - `IProcessLauncher` is a clean injectable port (`process.ts:22-25`).
  - `INHERITED_ENV` (`process.ts:48-57`) re-implements the MCP SDK's own `DEFAULT_INHERITED_ENV_VARS` and `getDefaultEnvironment()` (`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js:15-49`) with a different list. It has no Windows list, as the README admits (`README.md:56-57`), and no skip of `()`-prefixed function values.
  - Wrapped entries lose their declared env (open backlog c6ca91d6).
  - None of the sources code implements `HostAdapter` (`gateway.ts:191-236`), even though an MCP upstream maps onto it one to one: `start` is spawn plus handshake, `ready` is handshake ok, `invoke` is `tools/call`, `onExit` is `onClose`, `stop` is `dispose`, and `hopCost` is 1. Restart, partial availability and deadlines (`gateway.ts:395-480`) are therefore not inherited. The aggregation assessment confirms this from the product side (`GATEWAY-AGGREGATION-ASSESSMENT.md:32-33`).
- **Alternative:** Use `getDefaultEnvironment()` from the SDK as the base set (extend, do not fork). Wrap a resolved MCP upstream as `createMcpHostAdapter(source)` so `createGateway` supervises it.

#### B6. `launcher-transport.ts`. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** It re-implements newline-JSON framing (`launcher-transport.ts:26-56`) that the SDK exports as `ReadBuffer`, `serializeMessage` and `deserializeMessage` (`node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/stdio.js:3-30`). The launcher port is a valid reason for a custom `Transport`, but not for custom framing.
- **Alternative:** Build the transport on `ReadBuffer` and `serializeMessage`, keeping the 8 MiB cap as a wrapper.

#### B7. `stdio-host-transport.ts`. Verdict: **DEVIATES, SHOULD-FIX** (duplicated fix)

- **Evidence:** It monkeypatches `StdioServerTransport.start` and `close` to close on stdin EOF (`stdio-host-transport.ts:13-37`). `apigen-plugin-mcp` already solves the same SDK gap with its own stdin `end`/`close` watcher (`apigen-plugin-mcp/src/lib/run.ts:858-892`).
- **Cost:** Two independent fixes for one SDK behaviour, in two packages, that can drift.
- **Alternative:** Export one `watchStdioEof(transport, stdin)` from a single owner (for example `apigen-plugin-mcp` or runtime) and use it in both places.

#### B8. `serveMcpPassthrough`: a bespoke MCP server and Layer composition. Verdict: **ONE-OFF, SHOULD-FIX** (highest-impact should-fix)

- **Principles:** P5, P3 and P15.
- **Evidence:**
  1. It builds its own SDK `Server` and handlers (`mcp-passthrough-server.ts:123-165`) and says outright that it is "not `mcpPlugin.run`" (`:73-75`).
  2. It re-implements Layer composition with `layers.reduceRight(...)` (`:150`). That is the body of `createInvoker` (`invoke.ts:207-212`), duplicated because `createInvoker` hard-codes `dispatch` as the terminal.
  3. It has no validate Layer (`:81-82`), by design (G5).
  4. `envelope: {}` always (`:136`). The §9.1 MCP binding `_meta["x-<id>-<field>"]` is never read, so any envelope-declaring `--use` plugin (tracing `envelopeAttrs`, a future auth `x-auth-session`) gets nothing.
  5. `mount` capabilities are ignored (`:116-119` reads only `layer`). The plugin-policy default export's option capture (A1) can never fire here, and `_meta/health` and `_batch` mounts are not served.
  6. Error mapping: `permission_denied` becomes an `isError` result. Every other `ApiError` code (invalid_argument, not_found, unauthenticated) becomes generic text (`:154-163`), unlike the shared table where each code maps (`errors.ts:70-83`).
  7. It is MCP-only and single-source. One upstream exit shuts the whole server (`:187-189`).
  8. **The plan's own rule and the owner's direction rejected this shape.** T08 says "If no seam exists: stop, write the finding, file a backlog item, do not build a stopgap shell" (`tickets/T08.md:6`, `:36`). f6bf8550 asks for source kinds "instead of hand-written proxy shells". Discovery found the blocker B-1 (`T08-discovery.md:53-61`), and T08b then built the shell (`tickets/T08.md:100-115`). The proper fix is open as backlog e64f06e4 and recorded as "the alternative, filed as backlog, not built" (`INTERFACES.md:36`, D-21).
- **Transport asymmetry:** A `bin:` MCP source can be fronted only over MCP stdio. HTTP and CLI hosts can reach it only through the positional `fns` path, which drops arguments (bd7f5327).
- **Cost:**
  - A second MCP host implementation to maintain beside `apigen-plugin-mcp`.
  - It does not follow the serve-core `TransportAdapter`/`OpPlan` migration that every other host now uses (`docs/plan/apigen-serve-core/state.json`, all adapter states complete).
  - Every future MCP-host fix (output-size limits, streaming, `listChanged`, spec 2026-07-28) must be made twice.
- **Cheapest conforming alternative:**
  1. Add a passthrough mode to `apigen-plugin-mcp`'s `TransportAdapter`: per-op `mcp.name` override, flat arguments (no `{data}` wrap), verbatim `CallToolResult` (e64f06e4).
  2. Add a terminal override to the runtime, `createInvoker(layers, {terminal})` or an exported `composeLayers(layers, final)`, so a non-dispatch final step reuses the one composition.
  3. Serve the upstream as a `HostAdapter`-backed package. Then `serve` becomes `mcpPlugin.run({..., options:{passthrough:true}})` and gets mounts, envelope binding and the standard error mapping for free.

#### B9. `SourceError`: a parallel error taxonomy. Verdict: **DEVIATES, SHOULD-FIX**

- **Evidence:**
  - `class SourceError extends Error` with its own codes (`types.ts:66-79`), in the same package whose existing errors are `ApiError` with `details.gatewayCode` (`gateway.ts:87-127`).
  - The wrapper maps it by duck-typing `error.name === 'SourceError'` to exit 2 or 1 (`entrypoint/policy/src/wrapper/verbs/failure.ts:15-17`), outside `CLI_EXIT_CODE`.
- **Cost:** Every host must learn a second error type. HTTP and MCP hosts would map it to `internal` / 500.
- **Alternative:** Raise `ApiError('invalid_argument', ...)` for `invalid-spec`. Use the gateway's `makeUnavailableError` for `spawn-failed` and `handshake-failed`, so the mapping is `CLI_EXIT_CODE` and `HTTP_STATUS` with no wrapper code.

#### B10. Gateway docs, exports and tags. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:**
  - `src/index.ts` gained `export * from './lib/sources'` (git diff), which is additive.
  - The README still says "Minimal/reserved package" (`README.md:8`), while `gateway.ts` is a 658-line §13.1 implementation (`wc -l`).
  - The tags are `layer:logic, platform:node` only (`project.json:15-18`). This is the same two-tag set as `apigen-engine-runtime`, `-naming` and `apigen-plugin-mcp`, `-logger`, `-health`, while backlog, tracing and batch carry the full six-tag set.
  - Open backlog 25c1d7ef ("tagged platform:shared but imports node:child_process") is now satisfied by the retag and can be resolved.

#### B11. Tests and lanes. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:**
  - Unit specs mock `node:child_process` (`src/test/sources-process.spec.ts:2`, `:12-13`) or use a stub launcher (`sources-mcp-source.spec.ts:19`), which conforms to ADR-0009.
  - None of the three projects has an `e2e` target (`rg e2e` over the three `project.json`s, no hits). No gated test drives the built `adhd-policy serve bin:` against a real upstream over real stdio.
  - This is owner-directed ("NOT run (owner: no e2e)", `docs/plan/policy-core/README.md:13`), but it conflicts with AGENTS.md §7 ("drive the real tools ... never a bypass"). T08's real-process proof was a throwaway driver (`tickets/T08.md:127`).

### 2.3 `entrypoint/policy` and its use of apigen

#### C1. `mount.ts`: the CLI, MCP and HTTP surfaces. Verdict: **CONFORMS**

- **Evidence:**
  - It uses `cliPlugin.run`, `mcpPlugin.run` and `apiFastifyPlugin.run` with `{packages:[pkg], operations, options:{usePlugins}}` (`mount.ts:117-128`, `:136-142`, `:156-166`). This is exactly the backlog precedent (`T08-discovery.md:26`).
  - The `ok:false` report maps to exit 2 through the sanctioned `options.exitCode` hook (`mount.ts:77-83`, `:124`; `package-invoker.ts:96-119`).
  - Tracing comes from `makeTracingPlugin` (`wrapper/tracing.ts:4`), the factory pattern P11 prescribes.
- **Note:** `mount.ts:5-7` statically imports all three host plugins, so every bin loads Fastify. MEASUREMENTS attributes +7 to +14 MB of the `serve` wrapper's RSS to that unused import (`docs/plan/policy-core/MEASUREMENTS.md:54`). The fix is to load each host lazily.

#### C2. `package.ts` `buildPolicyPackage`. Verdict: **DEVIATES, SHOULD-FIX** (Two-Use)

- **Evidence:** `package.ts:30-71` copies `buildBacklogApigenPackage` (`entrypoint/backlog/src/server.ts:630-700`) line for line in structure: the `pkg` type, the action filter, schemas keyed by the last path segment, `composeSchemas(generated, [])`, and a `createClient` thunk. This is the second use, which triggers AGENTS.md §8. Backlog 689af7c3 asks only for documentation of the pattern.
- **Alternative:** A `buildApigenPackage({namespace, operations, fns, createClient, version})` export in `apigen-engine-runtime` (or core-client) that backlog and policy both import. That is also the natural place to apply the deref (C4) once.

#### C3. Baked IR (`ir.ts`, `ir-artifact.ts`, `ir-live.ts`). Verdict: **DEVIATES, SHOULD-FIX**

- **Evidence:**
  - `ir.ts:8-198` re-implements format-version, extractor-version and surface-digest checks, an atomic write, dist-directory discovery and a stale-fallback warning. It also has a hidden `ir-artifact --out` subcommand (`ir-artifact.ts:14-34`) and a build target that runs the built bin (`project.json` build command `vite build && node dist/cli.js ir-artifact --out dist/api.ir.json`).
  - This is the second copy of backlog's private bake (`entrypoint/backlog/src/cli.ts:56`, `:368-372`; `extract-live.ts:16`, `:32`). The apigen-owned home for the concept already exists: `apigen-plugin-ir-cache`'s ARTIFACT mode (`--type ir-cache --opt cache=artifact`, `apigen-plugin-ir-cache/src/index.ts:15-17`; `src/lib/target.ts:1-25`), with `CURRENT_FORMAT_VERSION` and `computeCacheKey` exported (`index.ts:52-56`).
- **Cost:** Three implementations of "bake the IR at build time". Freshness and version rules can diverge, for example in surface-digest scope.
- **Alternative:** Produce `api.ir.json` with the ir-cache target, add the digest check there if it is missing, and read it with an ir-cache reader. One owner for the artifact format.

#### C4. `dereference.ts`. Verdict: **DEVIATES, SHOULD-FIX** (already tracked)

- **Evidence:** The file header states that it duplicates backlog's `dereferenceSchema` and that the duplicate is tracked (`dereference.ts:1-14`; backlog 5eccaaa0). The root cause is run-mode dispatch being unable to resolve `$ref` (backlog 1bb4b5d5).
- **Alternative:** Fix `$ref` resolution in `apigen-engine-runtime` dispatch, then delete both copies (P13).

#### C5. `verbs/run.ts`: a programmatic invoke that bypasses the CLI host. Verdict: **DEVIATES, SHOULD-FIX**

- **Evidence:**
  - It builds a `Call` by hand and invokes `createInvoker(layers)` directly (`run.ts:53-72`). That skips `cliPlugin.run` and **skips `createPackageInvoker`**, so there is no validate Layer, against P5 and `package-invoker.ts:158-161`.
  - `envelope: {}` (`run.ts:62`).
  - No tracing. Run and serve get none (`rg tracing` in `verbs/` and `gate.ts`, no hits), while every apigen-hosted path does (`mount.ts:123`, `:140`, `:163`).
  - The planned design was "T09 wires `resolveSource` into `mcpPlugin.run` / `cliOutputPlugin.run`" (`T08-discovery.md:35`). The implementation diverged from that.
- **Exit-code note:** The child's exit status is returned raw (`run.ts:75`), so a child exiting 3 cannot be told apart from a policy refusal (3) or `invalid_argument` (2) in the `CLI_EXIT_CODE` space.
- **Alternative:** `createPackageInvoker(resolved.pkg.schemas, [tracingPlugin, ...gate.usePlugins])`, or better, `cliPlugin.run` over the resolved package. Pass `call.signal` (B3). Document or reserve an exit range for "refused before start".

#### C6. `verbs/serve.ts`. Verdict: **DEVIATES, SHOULD-FIX** (inherits B8)

- **Evidence:** It fronts the upstream with `serveMcpPassthrough` and `createStdioHostTransport` (`serve.ts:47-53`) and loads no tracing.

#### C7. `gate.ts` and `attributes-layer.ts`: wrapper-side Layer wiring. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** It builds `[attributesLayer, createPolicyLayerPlugin({decider})]` (`gate.ts:45-47`), which follows LP-14 ordering. It uses the programmatic factory only because A1 makes `--use` unusable. The attributes Layer writes the undeclared envelope key (A4).

#### C8. `flags.ts` and `attributes-from-flags.ts`: hand-rolled verb argv and a binding-lookalike flag. Verdict: **DEVIATES, NOTE**

- **Evidence:**
  - `splitPolicyArgv` (`flags.ts:29-78`) is a second CLI front-end in front of apigen's own (`mount.ts:102-115`). D-03 says "No hand-written flag parsing" (`INTERFACES.md:18`), which was written for operation inputs, and the verbs fall outside it.
  - `--adhd-attributes` uses the §9.1 rule-3 **builtin** binding syntax `--adhd-<field>` (`SPEC.md:422-423`), but it is not an envelope field. Its env var is `ADHD_POLICY_ATTRIBUTES` (`attributes-from-flags.ts:6`), not the rule-3 form `APIGEN_ATTRIBUTES`.
- **Cost:** Users will read it as an apigen envelope flag that works on every host. It works only on `run` and `serve`.
- **Alternative:** Rename to a product flag (`--attributes`, or `--policy-attributes`, which matches pluginId `policy`). Alternatively, make attributes a real declared envelope or ctx input of an auth plugin, so all hosts get the §9.1 binding.

#### C9. `prefix.ts`. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** It derives the namespace prefix from `@adhd/apigen-engine-naming`'s `project()` (`prefix.ts:9-15`), which is the right source of truth. It then rewrites argv before apigen sees it (`prefix.ts:17-22`), a small CLI-host concern that `apigen-plugin-cli-output` could own as a `dropNamespace` option.

#### C10. `failure.ts` and `run-entry.ts`: exit codes. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** `ApiError` maps through `CLI_EXIT_CODE` (`failure.ts:14`, `run-entry.ts:9-15`). The one non-conforming branch is the `SourceError` duck-type (`failure.ts:15-17`), which disappears with B9.

#### C11. `mcp-json/*`. Verdict: **CONFORMS** (no apigen seam involved)

- **Evidence:** This is a product verb that rewrites `.mcp.json` (`verbs/mcp-json.ts`, `mcp-json/init.ts`). It does not touch apigen contracts.

#### C12. Configuration and environment variables. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:**
  - `ADHD_POLICY_LOG_LEVEL` is read raw from `env` with default `warn` (`log-level.ts:17-22`; `mount.ts:126`), while the environment spec declares the same variable with default `info` (`packages/policy/policy-core-client/src/service/config/env-spec.ts:43-48`). The two disagree, and config files cannot set the level.
  - `ADHD_POLICY_HTTP_PORT` is not in the spec at all (`http-port.ts:4`; `mount.ts:152`).
  - `ask.timeoutMs` / `ADHD_POLICY_ASK_TIMEOUT_MS` is declared (`env-spec.ts:37-41`), but the gate never passes `timeoutMs` to the Layer (`gate.ts:46`), so the setting is only reported by `doctor` (`ctx-env.ts:13-14`).
- **Alternative:** Read all three through `buildPolicyEnv`, and wire `ask.timeoutMs` to `createPolicyLayerPlugin({timeoutMs})`.

#### C13. Package format (`entrypoint/policy/package.json`). Verdict: **DEVIATES, BLOCKING** (see X1)

- **Evidence:** `"type": "module"` (`package.json:4`). The sibling entrypoints `apigen-cli` and `backlog` leave `type` unset (their `package.json`).

#### C14. Tags. Verdict: **CONFORMS**

- **Evidence:** `project.json` tags are `domain:entrypoint, pkg-kind:entrypoint, pkg-class:entrypoint, layer:entrypoints, platform:node, access:public`, the same as `entrypoint/backlog` except for `access`.

### 2.4 `packages/policy/policy-core-client`: the apigen-facing surface

#### D1. `service/api.ts` and the `(ctx, input)` convention. Verdict: **CONFORMS**

- **Evidence:** Every operation is `(ctx: IPolicyCtx, input)` (`api.ts:60-324`). The extractor recognises `ctx` by name and excludes it (`apigen-core-client/src/lib/extract.ts:753-754`; SPEC §4 "ctx first-param excluded", `SPEC.md:142-143`). `createClient` supplies it per call (`entrypoint/policy/src/wrapper/package.ts:67`). This is the same convention backlog uses (`INTERFACES.md:16`, D-01).
- **Note:** The forced `ctx` name on `draft`, which ignores it (`api.ts:308-319`), is the cost of a by-name convention. It is apigen's convention, not a deviation.

#### D2. Error and exit semantics. Verdict: **CONFORMS**

- **Evidence:**
  - `check` throws `ApiError('permission_denied', reason, {decision})`, which is exit 3 (`api.ts:223-232`).
  - Input defects are `invalid_argument` (`api.ts:42-49`).
  - Load failures are `internal` (`api.ts:105-115`).
  - `verify` and `doctor` report `ok:false`, which the wrapper maps through the runtime's `exitCode` hook (C1).

#### D3. `createDecider` and the `IDecider` structural port. Verdict: **CONFORMS-WITH-NOTES, NOTE**

- **Evidence:** It is "structurally identical to the Layer package's `IPolicyDecider`" (`service/decider.ts:19-22`, versus `apigen-plugin-policy/src/ports.ts:8-27`). Deliberate ports-and-adapters with no import edge is a sound choice.
- **Duplication:** Attribute-value validation now exists three times: `apigen-plugin-policy/src/plugin.ts:83-106`, `entrypoint/policy/src/wrapper/attributes-source.ts:13-37`, and the client's attribute narrowing. A contract test that pins the port shape is the conforming guard (`INTERFACES.md:11`).

#### D4. Package format. Verdict: **DEVIATES, BLOCKING** (see X1)

- **Evidence:**
  - `"type": "module"`, an `exports` map, and `main: "./index.js"` without the `dist/` prefix used by every sibling source manifest (`package.json:4-20`).
  - `formats: ['es']` (`vite.config.mts:54`).

#### D5. Tags and name. Verdict: **CONFORMS**

- **Evidence:** `domain:policy, pkg-kind:core, pkg-class:foundation, layer:logic, platform:node, access:public` (`project.json`). The `policy` group is registered in `.adhd/workspace.json`, and `pkg-class:foundation` is also used by `environment-builder` and `environment-core-node`.

### 2.5 Plans and specs (`docs/plan/policy-core/**`)

| ID | Item | Verdict | Evidence and reason |
|---|---|---|---|
| E1 | D-14 and D-19 ("options reach only `mount.operations`; the Layer captures them there") | **DEVIATES** | `INTERFACES.md:31`, `:34`. The decision records a workaround of an apigen contract gap instead of fixing it (P10, P13). See A1. |
| E2 | D-18 (envelope key `attributes`) | **DEVIATES** | `INTERFACES.md:33`. This should be `ctx` (P4). See A4. |
| E3 | D-20 (`bin:` lives in `apigen-engine-gateway`) | **CONFORMS-WITH-NOTES** | `INTERFACES.md:35`. The home is acceptable for the launcher and `HostAdapter` half only (B1, B5). |
| E4 | D-21 (passthrough server, not `mcpPlugin.run`) | **ONE-OFF** | `INTERFACES.md:36`. Contradicts `tickets/T08.md:6` and `:36` ("do not build a stopgap shell") and f6bf8550. See B8. |
| E5 | D-07 and D-08 operation ids (`touch`, `<source>.<tool>`) | **DEVIATES** | `INTERFACES.md:22-23`; `T08-discovery.md:45`, `:47` ("a literal override of the derived slug"). Violates SPEC §4 derivation (B3, B4). |
| E6 | D-01 (`ctx` first parameter) | **CONFORMS** | `INTERFACES.md:16`. Matches extractor behaviour (D1). |
| E7 | D-03 ("No hand-written flag parsing") versus `flags.ts` | **CONFORMS-WITH-NOTES** | The verbs fall outside D-03's operation scope, but the plan never states that the verbs are a second CLI front-end (C8). |
| E8 | `T08-discovery.md` D1-D9 | **CONFORMS-WITH-NOTES** | An accurate and well-cited discovery: B-1 correctly identifies the `mcpPlugin.run` gap (`:53-61`). D3 and D5 accept non-derived ids, and `:35` promised `mcpPlugin.run` / `cliOutputPlugin.run` wiring that T09 did not do (C5). |
| E9 | REVIEW-FIXES L7 ("add exports mirroring sibling plugins") | **DEVIATES** | `REVIEW-FIXES.md:40`. The premise is false: no sibling has `exports`, and ADR-0003 D1 forbids it (A2). |
| E10 | `GATEWAY-AGGREGATION-ASSESSMENT.md` | **CONFORMS-WITH-NOTES** | See section 3. |
| E11 | Plan README: "no e2e" | **CONFORMS-WITH-NOTES** | `README.md:13`. Owner-directed, but leaves `serve` with no real-process proof in any gate (B11, P14). |
| E12 | `MEASUREMENTS.md` | **CONFORMS** (evidence) | It measures `serve` at about +114 MB and +1 process per wrapped server, with 7 to 14 MB attributable to an unused Fastify import (`MEASUREMENTS.md:44`, `:54`). It supports C1's lazy-load note and the aggregation assessment's RAM argument. |

### X1. Cross-cutting: module format for all three packages. Verdict: **DEVIATES, BLOCKING**

`apigen-plugin-policy` (A2), `policy-core-client` (D4) and `entrypoint/policy` (C13) all publish ESM. ADR-0003 D2 says the ESM half "must not be reintroduced piecemeal" (`0003-...md:47-53`). The generator template is the shared root cause (`workspace-codegen-nx/src/generators/shared/generator.ts:155-171`).

---

## 3. Whether `bin:`, passthrough, `remote:` and the aggregator fit the system's seams

- **There is no `source` plugin capability** (`plugin.ts:723-766`). Within the established architecture, a source kind has three parts:
  - an **extract-stage** producer of `Operation[]`, which per-language extractors provide today (`SPEC.md:41-68`, `:521-536`; the ir-cache `extractLayer` wraps this stage, `plugin.ts:332-383`);
  - an **invocation** path, which is the TS harness for in-process code or a gateway `HostAdapter` for anything out of process (`gateway.ts:182-236`);
  - unchanged `--type` hosts and `--use` Layers on top.

  The parked source-plugin proposal is the designated place to define the first part for non-file sources, and `bin:` is exactly its revisit trigger (`transport-serve-core-refactor.md:225`).
- **`bin:` (argv):** extraction is trivial (one synthetic operation). Invocation belongs in a `HostAdapter` or in a runtime terminal that receives `call.signal`. It should be reachable from `adhd-apigen run --source bin:<cmd> --type cli|mcp|api-fastify`, not only from `adhd-policy run`.
- **`bin:` (MCP upstream) and `remote:` (MCP over HTTP, OpenAPI):** both are "extract over a protocol, then invoke over a protocol". They fit the same pair: an extractor that turns `tools/list` or an OpenAPI document into the IR, and a `HostAdapter` with `hopCost: 1`. `remote:` differs only in transport, so building `bin:` on `HostAdapter` makes `remote:` mostly free. Building it on the bespoke passthrough would need a second bespoke path.
- **Passthrough serving** (names and arguments unchanged for an unmodified MCP host) is a **target** concern and belongs in `apigen-plugin-mcp` as a mode (e64f06e4), not in the gateway.
- **Aggregator / fan-in** (`GATEWAY-AGGREGATION-ASSESSMENT.md`):
  - The assessment is right that today's code is single-source (`:33`) and that `createGateway` routes by `operation.host` (`:32`; `gateway.ts:398`, `:417-422`).
  - The conclusion "reusable only as a specification, not code" holds only because the sources were not built as `HostAdapter`s. With per-upstream adapters and distinct routing keys (for example `host: 'mcp:<source>'`), `createGateway` would supply, unchanged, the partial availability, readiness, restart-with-backoff and deadlines that the assessment's MVP lists as must-build (`:63`, `:102`).
  - The design question this raises is whether `host` may mean "routing key" and not only "language runtime". That needs an ADR-level decision; it does not justify a third parallel implementation.
  - This is offered as a check on the assessment, not a verdict on whether to build fan-in.

---

## 4. Conformance matrix

| # | Item | Verdict | Severity |
|---|---|---|---|
| A1 | plugin-policy `--use` options via mount capture and singleton | DEVIATES | BLOCKING |
| A2 | plugin-policy ESM-only (`type`, `exports`, `es`) | DEVIATES | BLOCKING |
| A3 | plugin-policy typed to runtime `UsePlugin`/`Call`; no optionsSchema | CONFORMS-WITH-NOTES | NOTE |
| A4 | attributes via undeclared envelope key | DEVIATES | SHOULD-FIX |
| A5 | Layer short-circuit, error, stream, signal semantics | CONFORMS | - |
| A6 | decider module loading duplicates `loadUsePlugins` | CONFORMS-WITH-NOTES | NOTE |
| A7 | CHANGELOG missing; not in apigen README table | CONFORMS-WITH-NOTES | NOTE |
| A8 | plugin-policy tags and tier | CONFORMS | - |
| B1 | sources in the neutral gateway; source-kind taxonomy | DEVIATES | SHOULD-FIX |
| B2 | parse/resolve reachable only from adhd-policy; remote/file dead arms | ONE-OFF | NOTE |
| B3 | argv operation hand-built; non-derived id; `call.signal` not propagated | DEVIATES | SHOULD-FIX |
| B4 | MCP-source ids `<source>.<tool>`; safe post-mutation workaround | DEVIATES | SHOULD-FIX |
| B5 | process launcher and env allowlist; not a `HostAdapter` | CONFORMS-WITH-NOTES | SHOULD-FIX |
| B6 | launcher transport re-implements SDK framing | CONFORMS-WITH-NOTES | NOTE |
| B7 | stdio EOF fix duplicated from apigen-plugin-mcp | DEVIATES | SHOULD-FIX |
| B8 | bespoke passthrough MCP server and Layer composition | ONE-OFF | SHOULD-FIX |
| B9 | `SourceError` parallel error taxonomy | DEVIATES | SHOULD-FIX |
| B10 | gateway README stale; tag set | CONFORMS-WITH-NOTES | NOTE |
| B11 | unit lanes fine; no real-process proof | CONFORMS-WITH-NOTES | NOTE |
| C1 | mount.ts via cliPlugin, mcpPlugin, fastify, exitCode hook | CONFORMS | NOTE (lazy load) |
| C2 | `buildPolicyPackage` copy of the backlog builder | DEVIATES | SHOULD-FIX |
| C3 | baked IR, second copy beside ir-cache artifact | DEVIATES | SHOULD-FIX |
| C4 | `dereferenceSchema` duplicate | DEVIATES | SHOULD-FIX |
| C5 | `run` verb bypasses cliPlugin and `createPackageInvoker` | DEVIATES | SHOULD-FIX |
| C6 | `serve` verb rides the passthrough | DEVIATES | SHOULD-FIX |
| C7 | gate and attributes Layer wiring | CONFORMS-WITH-NOTES | NOTE |
| C8 | verb argv parser; `--adhd-attributes` resembles §9.1 | DEVIATES | NOTE |
| C9 | prefix.ts argv rewrite | CONFORMS-WITH-NOTES | NOTE |
| C10 | failure.ts and run-entry exit mapping | CONFORMS-WITH-NOTES | NOTE |
| C11 | mcp-json verbs | CONFORMS | - |
| C12 | env vars bypass the environment spec; ask.timeoutMs unwired | CONFORMS-WITH-NOTES | NOTE |
| C13 | entrypoint ESM (`type: module`) | DEVIATES | BLOCKING |
| C14 | entrypoint tags | CONFORMS | - |
| D1 | `(ctx, input)` operations | CONFORMS | - |
| D2 | ApiError and exit semantics | CONFORMS | - |
| D3 | structural decider port; triplicated attribute validation | CONFORMS-WITH-NOTES | NOTE |
| D4 | client ESM, `exports`, `main` path | DEVIATES | BLOCKING |
| D5 | client tags and name | CONFORMS | - |
| E1 | D-14 / D-19 | DEVIATES | BLOCKING (with A1) |
| E2 | D-18 | DEVIATES | SHOULD-FIX |
| E3 | D-20 | CONFORMS-WITH-NOTES | NOTE |
| E4 | D-21 | ONE-OFF | SHOULD-FIX |
| E5 | D-07 / D-08 ids | DEVIATES | SHOULD-FIX |
| E6 | D-01 | CONFORMS | - |
| E7 | D-03 versus verbs | CONFORMS-WITH-NOTES | NOTE |
| E8 | T08-discovery D1-D9 | CONFORMS-WITH-NOTES | NOTE |
| E9 | REVIEW-FIXES L7 | DEVIATES | BLOCKING (with A2) |
| E10 | aggregation assessment | CONFORMS-WITH-NOTES | NOTE |
| E11 | plan "no e2e" | CONFORMS-WITH-NOTES | NOTE |
| E12 | MEASUREMENTS.md | CONFORMS | - |
| X1 | module format across all three packages | DEVIATES | BLOCKING |

**Counts (51 rows):**

| Verdict | Count |
|---|---|
| CONFORMS | 10 |
| CONFORMS-WITH-NOTES | 17 |
| DEVIATES | 21 |
| ONE-OFF | 3 |

By severity: 7 rows are BLOCKING, and they collapse to 2 root causes (A1 options, X1 format). 16 are SHOULD-FIX. The rest are notes or clean.

---

## 5. Top 10 remediation items (ranked)

| Rank | Remediation | Owner package | Fixes |
|---|---|---|---|
| 1 | Add `LayerCapability.createLayer(opts)` (mirroring `ExtractLayerCapability`). Have `createPackageInvoker` pass `useOptions[id]`, and apigen-cli populate `useOptions` from `--opt`. Then delete the plugin's mount capture and `state.ts` and adopt default export plus `makePolicyPlugin` with `optionsSchema`. | `apigen-core-client` + `apigen-engine-runtime` + `apigen-cli`, then `apigen-plugin-policy` | A1, A3, E1, C7 |
| 2 | Re-emit `apigen-plugin-policy`, `policy-core-client` and `entrypoint/policy` as CommonJS-only per ADR-0003. Fix the generator so new packages are born conforming. Correct REVIEW-FIXES L7. | `workspace-codegen-nx` + the three packages | A2, C13, D4, E9, X1 |
| 3 | Add a passthrough mode (name override, flat arguments, verbatim result) to `apigen-plugin-mcp`'s adapter. Add a `terminal` option to `createInvoker`. Retire `serveMcpPassthrough`. | `apigen-plugin-mcp` + `apigen-engine-runtime` | B8, C6, E4, B7 |
| 4 | Re-open DEBT-APIGEN-SERVE-CORE-011 with `bin:` and `remote:` as the concrete consumers. Make `--source bin:<cmd>` an extract-stage source in the apigen-cli orchestrator, so every `--type` and `--use` works. | `apigen-cli` orchestrator + `apigen-core-client` | B1, B2, f6bf8550 |
| 5 | Implement MCP-upstream and argv sources as `HostAdapter`s (`hopCost: 1`). Base the env on SDK `getDefaultEnvironment()`. This also unblocks fan-in with §13.1 supervision for free. | `apigen-engine-gateway` | B5, B6, section 3 |
| 6 | Move the attribute channel to a typed `ctx` key exported by the policy plugin, and have the attributes or auth Layer `ctx.set` it. | `apigen-plugin-policy` + `entrypoint/policy` | A4, E2, C7 |
| 7 | Derive source operation ids with the core `buildId` and `syntheticOp`. Let `composeSchemas` honour an explicit `safe:false`. Use a non-`ts` host tag for foreign operations. | `apigen-core-client` (+ gateway callers) | B3, B4, E5 |
| 8 | Thread `call.signal` into `dispatch` and the fns, and make the `run` verb use `createPackageInvoker` (validate Layer, tracing) or `cliPlugin.run`. | `apigen-engine-runtime` + `entrypoint/policy` | B3, C5 |
| 9 | Extract `buildApigenPackage(...)` and fix dispatch `$ref` resolution. Then delete both copies of `buildXApigenPackage` and `dereferenceSchema`, and bake the IR through the `apigen-plugin-ir-cache` artifact target. | `apigen-engine-runtime` / `apigen-core-client` / `apigen-plugin-ir-cache`; consumers `entrypoint/backlog`, `entrypoint/policy` | C2, C3, C4 |
| 10 | Replace `SourceError` with `ApiError` (`invalid_argument` / gateway `unavailable`), and drop the duck-typed branch in `failure.ts`. | `apigen-engine-gateway` + `entrypoint/policy` | B9, C10 |

---

## 6. Backlog candidates (titles only; not filed)

**Existing items to update or cross-link (do not duplicate):**
- e64f06e4: apigen-plugin-mcp passthrough mode. Add B8's evidence and the T08.md:6 contradiction.
- bd7f5327: positional dispatch drops undeclared arguments.
- f6bf8550: `remote`/`bin` source kinds. Add the DEBT-011 revisit trigger and the `HostAdapter` mapping.
- c6ca91d6: wrapped entries lose env. Add the SDK `getDefaultEnvironment` duplication.
- 5eccaaa0: `dereferenceSchema` duplicate.
- 1bb4b5d5: dispatch cannot resolve `$ref`.
- 689af7c3: programmatic apigen usage pattern. Extend it to "extract `buildApigenPackage`".
- f4d95c61: attributes channel protected only by documentation. Add the `ctx` remedy.
- ec74a394: `.mts` test-config override.
- d35b0dd2: bare decider specifier resolution.
- 25c1d7ef: gateway platform tag. Now satisfied by the retag, so it can be resolved after verification.
- 292bd882: serve-core EPIC (parent of DEBT-011).

**New titles:**
1. `LayerCapability` has no opts-aware factory and apigen-cli never populates `useOptions`: `--use @adhd/apigen-plugin-policy` denies every call (no decider).
2. `apigen-plugin-policy`, `policy-core-client` and `entrypoint/policy` publish ESM (`type: module`, `exports`, `es`-only) against ADR-0003. The workspace-codegen-nx generator emits `.mts` ESM scaffolds.
3. `createInvoker` hard-codes `dispatch` as the terminal step, so `serveMcpPassthrough` re-implements Layer composition with `reduceRight`.
4. `dispatch()` never passes `call.signal` to fns: per-request cancellation cannot reach a `bin:` child on MCP and HTTP hosts.
5. `composeSchemas` cannot honour an explicit `safe: false`; mcp-source overwrites `x-apigen-safe` after the fact.
6. Gateway `bin:` source ids are not derived from namespace/path (`touch`, `<source>.<tool>`): two id grammars and no §5 collision check.
7. `SourceError` is a parallel error type outside `ApiError`/`CLI_EXIT_CODE`, mapped by `error.name` in the policy wrapper.
8. stdio stdin-EOF shutdown is implemented twice (`apigen-plugin-mcp` `run.ts:858-892` and the gateway's `stdio-host-transport.ts`).
9. Gateway `bin:` sources do not implement `HostAdapter`: no supervision, restart, partial availability or deadlines for MCP upstreams.
10. `adhd-policy run` bypasses `cliPlugin`/`createPackageInvoker`: no validate Layer and no tracing; child exit codes collide with `CLI_EXIT_CODE`.
11. `buildPolicyPackage` duplicates `buildBacklogApigenPackage`, and the baked-IR bake is hand-rolled twice beside the `apigen-plugin-ir-cache` artifact target.
12. `--adhd-attributes` uses the §9.1 builtin-envelope flag syntax but is not an envelope field (env var `ADHD_POLICY_ATTRIBUTES`, not `APIGEN_ATTRIBUTES`).
13. The policy wrapper reads `ADHD_POLICY_LOG_LEVEL`/`ADHD_POLICY_HTTP_PORT` raw (default mismatch with the environment spec), and `ask.timeoutMs` is never applied to the Layer.
14. The `apigen-engine-gateway` README still says "Minimal/reserved package"; `packages/apigen/README.md` omits `apigen-plugin-policy` (and the `bin:` sources).
15. `apigen-plugin-policy` lists `CHANGELOG.md` in `files` but ships none.
16. `entrypoint/policy` statically imports Fastify in every bin (+7 to 14 MB RSS on `serve`, MEASUREMENTS.md:54).
17. No gated real-process proof of `adhd-policy serve bin:` against a real upstream over stdio (e2e lane absent for policy, gateway and plugin-policy).
