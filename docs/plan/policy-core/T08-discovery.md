# T08 discovery: which apigen seam hosts the `bin:` source kind

Read-only findings, written before any T08 code. Citations are `file:line` at the commit this document was written on.

## Verdict

A seam exists. A source can be turned into a hand-built `{pkg, operations}` pair that `mcpPlugin.run` and `cliOutputPlugin.run` accept today, with no apigen change. `packages/apigen/apigen-engine-gateway` is a suitable home. T08 proceeds for the resolver pieces (parse, launcher port, argv operation, launcher transport, stdio-MCP resolver, resolve-source).

One finding limits what `serve` can promise and is a blocker for T09/T17 `@S7.2` (see "Blocking finding B-1"): apigen's MCP host cannot present an upstream MCP server's tool names or argument shapes unchanged. T08 builds the resolver correctly; it does not (and cannot, inside this package) fix B-1.

## (a) Constructing a valid `Operation` + schema entry for a runtime-built operation

- `Operation` is a plain interface (`apigen-core-client/src/lib/descriptor.ts:148-252`): `id, host, namespace: Segment, path: Segment[], kind, async, streaming, safe, input, output, envelope, typeText, hasCtx?`. Nothing is branded; a literal satisfies it. `Segment = {raw, words}` (`descriptor.ts:91-96`).
- Extraction builds operations with the private helpers `makeSeg` / `tokenize` / `buildId` (`apigen-core-client/src/lib/extract.ts:911-960`). `tokenize` is exported from `@adhd/apigen-core-client`; `makeSeg`/`buildId` are not. `buildId` is `[ns, ...path].map(words.join('-')).join('/')` (`extract.ts:911-914`). A runtime builder therefore constructs `Segment` literals itself; no extractor is invoked, so nothing is executed.
- `Operation.id` is only a key. It is used as the key of `schemasByOpId`/`fnsByOpId` (`apigen-plugin-mcp/src/lib/run.ts:496-501`) and as `call.operation.id`, which the policy Layer uses as the tool name (T07 spec, `INTERFACES.md` D-08). Setting `id = '<server>.<tool>'` (D-08) is therefore legal; nothing parses it.
- The schema entry is `GeneratedSchemas.schemas[fnName] = {input, output, hasCtx?, safe?}` (`apigen-core-client/src/lib/types.ts:7-26`) passed through `composeSchemas(generated, [])` (`compose-schemas.ts:169-281`). The reference shape is `buildBacklogApigenPackage` (`entrypoint/backlog/src/server.ts:630-700`): `{pkg: {id, version, schemas, importPath, fns, createClient}, operations}`. `composeSchemas` wraps the domain params in a `data` envelope and runs `validateComposedRefs`, which only fires when `definitions`/`$defs` are present.
- `fnName` is the join key: `operationFor` matches `op.kind === 'action' && op.namespace.raw === pkg.id && op.path[last].raw === fnName` and throws otherwise (`apigen-plugin-mcp/src/lib/tool-naming.ts:73-93`). So `pkg.id` must equal `namespace.raw` and the last path segment's `raw` must equal the `schemas`/`fns` key.
- `fns[fnName]` is called POSITIONALLY: `dispatch` computes `dataParamNames(schema)` (the key order of `input.properties.data.properties`) and calls `fns[fnName](...args)` (`apigen-engine-runtime/src/lib/dispatch.ts:30-39,128-158`). A source operation therefore needs a positional `fns` wrapper around the object-shaped invoker (argv op: `(argv, cwd)`; MCP op: arguments rebuilt by property name order).

## (b) How a `Call`'s `LayerContext` is created for programmatic invoke

`LayerContext` is a plain class with a no-arg constructor (`apigen-engine-runtime/src/lib/invoke.ts:37-61`). A `Call` is `{operation: Pick<Operation,'id'> & Partial<Operation>, ctx, envelope, domainArgs, signal?, transport}` (`invoke.ts:68-89`). Programmatic invoke is `createInvoker(layers)(fnName, call, {fns, createClient, schemas})` (`invoke.ts:183-216`): `new LayerContext()`, `envelope: {}`, `domainArgs` = the bare domain params (no `data` wrapper), `transport` set by the caller. The hosts do exactly this per request. T08 needs no direct `Call` construction (the resolver only returns operations and `fns`); T09/T19 can build one this way for unit-lane tests.

## (c) `run()` accepts a hand-built `{packages, operations}` with `options.usePlugins`

- `mcpPlugin.run(input)` iterates `input.packages` (requires `pkg.fns`), resolves each `fnName` through `operationFor(..., input.operations)`, and reads `options.usePlugins` / `options.useOptions` via `readUsePlugins`/`readUseOptions` (`apigen-plugin-mcp/src/lib/run.ts:460-469,482-501`; `readUsePlugins` in `apigen-engine-runtime/src/lib/package-invoker.ts`). `cliOutputPlugin.run` does the same (`apigen-plugin-cli-output/src/lib/run.ts:616,664,688`). The in-repo precedent passes `options: {transport: 'stdio', usePlugins: [tracingPlugin, batchPlugin]}` with `packages: [pkg], operations` (`entrypoint/backlog/src/server.ts:926-936`). Confirmed possible; nothing needs the operations to originate from `extract`.
- `createPackageInvoker(schemas, usePlugins)` composes the validate-Layer innermost and any `--use` layers outermost-first (`run.ts:512`), so the policy Layer sees every call before `fns` runs (GW-01).

## (d) Is `apigen-engine-gateway` a suitable home?

- Existing package, tags `layer:logic, platform:shared`, version 0.2.3, published (`published-state.json`). The ticket calls it a "reserved placeholder"; that is wrong: `src/lib/gateway.ts` (~600 lines, SPEC section 13/13.1 sidecar gateway: `createGateway`, `HostAdapter`, supervision/backoff, `GATEWAY_ERROR_CODES`) and `src/test/gateway.spec.ts` exist. The new code lives under `src/lib/sources/` and shares no symbols with `gateway.ts`; `src/index.ts` only gains exports.
- Dependents (rg over `*.ts`/`*.json`, excluding docs): `entrypoint/apigen-cli/src/test/integration/gateway-mixed-host.e2e.ts` imports it; `tsconfig.base.json` path alias; `published-state.json`. Additive exports cannot break that consumer.
- Imports available: `@adhd/apigen-core-client` and `@adhd/apigen-base-errors` are already dependencies. `@modelcontextprotocol/sdk` is added at `1.29.0` (the exact version `apigen-plugin-mcp/package.json:10` and the root `package.json:34` pin).
- Tag note: the package is `platform:shared`; `process.ts` imports `node:child_process`. The ticket allows it in `process.ts` only. Lint is the check (recorded in the Evidence block of `tickets/T08.md`); if the boundary rule rejects it the finding is filed, not worked around.
- Host-layer note: apigen-engine-gateway is not a hosting layer for the policy `serve` verb itself; T09 wires `resolveSource` into `mcpPlugin.run` / `cliOutputPlugin.run` from the entrypoint.

Conclusion: home confirmed (OD-32 / D-20).

## Deviations from the ticket's "File interface specs"

| # | Ticket text | Reality | Resolution |
|---|---|---|---|
| D1 | Home is a "reserved placeholder, `src/lib/` empty-ish" | Real sidecar gateway with `gateway.ts` and a spec | Home still valid; new code isolated under `src/lib/sources/`; wording corrected here. |
| D2 | `pkg.fns: Record<string, (...a: unknown[]) => unknown>` taking the object input | `dispatch` calls `fns[fnName]` positionally by `input.properties` key order | `fns` entries are positional wrappers around the object invokers. `createArgvInvoker` keeps the ticket's object signature. |
| D3 | `buildArgvOperation(command): { operation, fnName }` with `id = basename` | Needs `namespace.raw === pkg.id` and `path[last].raw === fnName` | `namespace = {raw: id, words: [id]}`, `path = [{raw: id, words: [id]}]`, `fnName = id`, `operation.id = id` (a literal override of the derived slug). `pkg.id = id`. `IResolvedSource.sourceId` stays `bin:<command>`. |
| D4 | Argv output schema `{exitCode, stdout, stderr}` | Schema must be JSON Schema | Emitted as `{type:'object', required:[...], additionalProperties:false, properties:{exitCode:{type:'number'}, stdout:{type:'string'}, stderr:{type:'string'}}}`. |
| D5 | MCP op id `<server>.<tool>`, `fns[opId]` | `fns`/`schemas` are keyed by `fnName` (path tail), not `op.id` | `fns`/`schemas` keyed by the upstream tool name verbatim; `operation.id = '<server>.<tool>'`; `namespace.raw = pkg.id = <server>`; path tail `raw` = tool name. Tool names that collide after sanitization fail with `SourceError('unsupported')`. |
| D6 | Tool `inputSchema` used as `input` | `dataParamNames` is derived from `properties`; an upstream schema with no `properties` or only `additionalProperties` yields zero positional params, so extra arguments would be dropped | A tool whose `inputSchema` has no `properties` object is exposed with an empty parameter list and the limitation is stated in the JSDoc; a non-object schema is `SourceError('unsupported')` (per ticket). |
| D7 | `launcher-transport.ts` imports SDK `Transport` | `@modelcontextprotocol/sdk/shared/transport.js` is the SDK 1.29.0 path | Used as specified. |

## Blocking finding B-1 (for T09 / T17 `@S7.2`, not fixable in T08)

D-08 and T17 `@S7.2` require that "the upstream tool names are listed unchanged" and that an unmodified MCP host works through `serve`. Serving a resolved MCP source through `mcpPlugin.run` cannot do that:

1. Tool name: the MCP tool name is `project(op).mcp.name = [op.namespace, ...op.path].map(words.join('_')).join('_')` (`apigen-engine-naming/src/lib/naming.ts:128-140`). There is always at least a namespace segment and a path segment, so the host sees `<server>_<tool>`; it can never equal `<tool>`.
2. Argument shape: `composeSchemas` publishes `{data: {...}}` as the tool input (`compose-schemas.ts:247-266`, calling convention stated in the schema `description`), and the MCP adapter reads `raw.args['data']` (`apigen-plugin-mcp/src/lib/run.ts:302`). An unmodified client sends the upstream's flat `arguments`.
3. Result shape: results go through `wrapMcpStructuredContent`/ output-schema handling, not a verbatim `CallToolResult` (an upstream `isError` result is returned as data, not as an MCP error).

The policy Layer itself is unaffected (it sees `call.operation.id` and `domainArgs`), but the host-visible contract (GW-02, GW-03, WM-01) is not met by `mcpPlugin.run` as it stands. Options for the owner (T09 decision, not taken here): (i) add a passthrough/flat-args mode and an explicit tool-name override to `apigen-plugin-mcp` (apigen change, blast radius covers every MCP host); (ii) have `adhd-policy serve bin:` run a small SDK `Server` proxy in the gateway package that dispatches through `createInvoker([policyLayer])` using the resolver's `operations`/`schemas`/`fns`, bypassing `mcpPlugin.run`. T08's resolver output serves both options unchanged. `bin:` + `run` (argv fallback) is not affected: `cliOutputPlugin.run` projects the operation `touch` with `argv`/`cwd` parameters.

## Safety (SRC-05 / SRC-06 / PS-28)

Nothing is spawned during parse, resolve for `intent: 'run'`, `buildArgvOperation`, or object construction. The process is started (a) by `createArgvInvoker`'s returned function when the operation is invoked, and (b) by `resolveMcpStdioSource` only when `resolveSource(…, 'serve', …)` is called. `spawn` is always `shell: false`; the command is a bare name or path (no whitespace, validated in `parseSourceSpec`) and arguments are an array.
