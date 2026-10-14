# SPEC edit draft — §7.1 `LayerCapability.createLayer(opts)`, §4 `Operation.binding` and tool metadata, §8.1 cancellation

**Status:** Proposed (edit draft for `docs/apigen/SPEC.md`; owner approves before the SPEC is changed).
**Owner:** pseudosky.
**Drives:** REMEDIATION-PLAN segments R1 (core-client contracts), R3 (runtime invoker), R4 (MCP signal and layer options), R5 (apigen-cli `--opt`), R6 (plugin-policy E4); owner decisions BA-8 (E4), O-1, BA-3 (E3).
**Grounding:** `docs/apigen/SPEC.md` §4 (lines 102-154), §7.1 (lines 222-270); `packages/apigen/apigen-core-client/src/lib/plugin.ts`; `packages/apigen/apigen-core-client/src/lib/descriptor.ts`; `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts`, `invoke.ts`, `dispatch.ts`.

## TL;DR for the next agent

- A `layer` capability may supply `createLayer(opts)` instead of (or alongside) `layer(call, next)`. The host calls `createLayer` once per invocation with the invocation's single flat `--opt` bag, the same bag `extractLayer.createLayer` already receives. When both are present, `createLayer` wins.
- `Operation` gains optional `binding?: string`: the runtime that executes the operation. `host` keeps its producer meaning. The gateway routes by `binding ?? host`.
- `Operation` gains optional `tool?: { title?: string; annotations?: Record<string, unknown> }` for transport-facing metadata (E3). Only MCP reads it today.
- `Call.signal` reaches the dispatch terminal; a `ctx`-taking function receives it through `createClient`, never as a positional argument.

## Context

1. SPEC §7.1 defines `LayerCapability` as `{ envelopeFields?, layer(call, next) }` (`docs/apigen/SPEC.md:250-254`). The code matches: `LayerCapability` has `envelopeFields?` and a required `layer` (`apigen-core-client/src/lib/plugin.ts:305-330`), and the runtime's structural `UsePlugin.capabilities.layer` has only `layer` (`apigen-engine-runtime/src/lib/package-invoker.ts:39-44`).
2. A layer plugin therefore cannot receive `--use` options. `createPackageInvoker(schemas, usePlugins)` reads only `capabilities.layer.layer` (`package-invoker.ts:149-162`). apigen-cli's `run` command parses `--opt` into one flat bag and attaches the loaded plugin objects as `options.usePlugins` (`entrypoint/apigen-cli/src/lib/commands/run.ts:307-323`); it never sets `options.useOptions`, which is the only place `readUseOptions` looks (`package-invoker.ts:121-124`).
3. The only `--use` capability that receives options today is `mount.operations(descriptor, opts)`, via `useOptions[plugin.id]` (`apigen-plugin-mcp/src/lib/run.ts:433-454`). apigen-plugin-policy works around the gap by capturing options in a module-level singleton from a `mount` capability that returns no operations (`apigen-plugin-policy/src/plugin.ts:292-343`, `state.ts:13-24`). One process can then hold only one policy configuration.
4. The extract stage already has the pattern: `ExtractLayerCapability { layer?, createLayer?(opts) }` receives the invocation's flat `--opt` bag (`plugin.ts:351-383`; `entrypoint/apigen-cli/src/lib/orchestrator.ts:634-641`).
5. `Operation.host` means "the owning language runtime … which host's extractor produced it and which host can serve it same-process" (`descriptor.ts:164-169`). A foreign upstream (an MCP server, a PATH executable) is described by IR its extractor produced, but executes through a different runtime. Today the gateway sources stamp such operations `host: 'ts'` (`apigen-engine-gateway/src/lib/sources/argv-operation.ts:38-44`, `mcp-source.ts:187-192`) and the gateway routes by `req.operation.host` (`gateway.ts:590-591`).
6. Neither SPEC §4 (`SPEC.md:104-118`) nor `Operation` carries tool display metadata, so `title` / `annotations` from an MCP upstream cannot reach `tools/list`.
7. The runtime `Call` has an optional `signal` (`invoke.ts:80-81`), but `createInvoker`'s core service calls `dispatch(fns, createClient, schema, fnName, envelope, domainArgs)` without it (`invoke.ts:197-205`), and `dispatch` has no signal parameter (`dispatch.ts:120-127`). `dispatch` binds arguments positionally from the schema's `data` properties (`dispatch.ts:128-133`), so appending a positional argument would change the call signature of every TS service.

## Decision

### D1. §7.1 `LayerCapability` (BA-8, E4)

BEFORE (`SPEC.md:250-254`):

```ts
interface LayerCapability {
  envelopeFields?: Record<string, JSONSchema>   // merged into effective request envelope
  layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>
}
```

AFTER:

```ts
interface LayerCapability<Opts = Record<string, unknown>> {
  envelopeFields?: Record<string, JSONSchema>   // merged into effective request envelope
  // Exactly one of `layer` / `createLayer` is required; if both are present the host uses createLayer.
  layer?(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk>
  // Called ONCE per host invocation, before the first request, with the invocation's
  // single flat `--opt` bag (the same bag extractLayer.createLayer receives).
  // May throw to refuse startup (invalid options); the host reports the error and exits non-zero.
  createLayer?(opts: Opts): (call: Call, next: Next) => Promise<Result> | AsyncIterable<Chunk>
}
```

Normative text to add under §7.1:

- A host MUST call `createLayer` at most once per plugin per invocation and reuse the returned layer for every request.
- The options bag is the whole invocation's flat `--opt` map. It is not namespaced per plugin. A plugin reads only its own keys and SHOULD declare them in `Plugin.optionsSchema` (`plugin.ts:715`).
- A `createLayer` that throws fails the invocation before serving starts.
- `mount.operations(descriptor, opts)` is unchanged.

Runtime mirror (`package-invoker.ts`):

```ts
// BEFORE (package-invoker.ts:39-44, 149)
layer?: { layer: (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown> };
export function createPackageInvoker(schemas: ComposedSchemas, usePlugins: UsePlugin[]): InvokeFn

// AFTER
layer?: {
  layer?: (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown>;
  createLayer?: (opts: Record<string, unknown>) => (call: unknown, next: () => Promise<unknown>) => Promise<unknown> | AsyncIterable<unknown>;
};
export function createPackageInvoker(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[],
  options: { layerOptions?: Record<string, unknown>; terminal?: Terminal } = {}
): InvokeFn
```

### D2. §4 `Operation.binding` (O-1)

BEFORE: `Operation` has `host` (`SPEC.md:106`; `descriptor.ts:169`) and no binding.

AFTER (SPEC §4 jsonc and `descriptor.ts`, `descriptor.schema.json`):

```jsonc
"host":    "ts",            // producer: which extractor produced this IR (unchanged meaning)
"binding": "mcp-stdio",     // OPTIONAL. the runtime that executes it; absent ⇒ same as host
```

- `binding` is an opaque routing key. The gateway selects the adapter by `operation.binding ?? operation.host`.
- An extracted TS operation has no `binding`; generate, run and serve output for TS sources is byte-identical to today.
- A foreign operation carries a non-`ts` host tag naming its extractor and a `binding` naming its runtime. The tag vocabulary is defined in the source-model ADR draft (`adr-drafts/source-model.md`, D2).

### D3. §4 `Operation.tool` (BA-3, E3)

AFTER:

```jsonc
"tool": { "title": "Add", "annotations": { "readOnlyHint": false } }   // OPTIONAL, transport-facing display metadata
```

- `tool` is advisory metadata copied from the source (for an MCP upstream, its `tools/list` entry). It never changes `id`, `input`, `output` or dispatch.
- `MountedOperation` gains the same optional field.
- MCP's `tools/list` emits `title` / `annotations` from it (ADR draft `0004-followup-mcp-adapter.md`, Decision 3).

### D4. §8.1 cancellation

- `type Terminal = (fnName: string, call: Call, opts: InvokeOptions) => Promise<LayerResult>`; `createPackageInvoker`'s `options.terminal` (D1) is passed through to `createInvoker`.
- `createInvoker(layers, { terminal? })`: the innermost service is `terminal(call)` when supplied, else the existing `dispatch`. The terminal receives the whole `Call`, including `signal`. Binding adapters (argv, MCP upstream) are terminals.
- `dispatch` gains a trailing `signal?: AbortSignal` parameter. It never becomes a positional argument of a user function. A `ctx`-taking function receives it as `createClient(envelope, { signal })`.
- Every host that has a transport-level signal passes it as `Call.signal`: MCP passes the SDK request handler's `extra.signal`.

## Consequences

- A `--use` plugin can be configured per invocation, so two policy-gated services in one process can carry different configurations.
- Every layer-capability reader must accept a capability with `createLayer` and no `layer`: `createPackageInvoker`, `adaptCoreLayer` (`package-invoker.ts:133-141`), and every direct reader of `capabilities.layer.layer` (for example `entrypoint/policy/src/wrapper/verbs/run.ts:53-56`).
- `descriptor.schema.json` gains two optional properties. Readers that reject unknown properties must be regenerated. Whether any reader rejects them is UNVERIFIED.

## What does NOT change

`Plugin.capabilities.mount`, `envelope`, `extractLayer`; the meaning of `Operation.host`; `Operation.id` derivation; the TS dispatch argument order.

## Evidence

- `docs/apigen/SPEC.md:102-118, 250-254`.
- `packages/apigen/apigen-core-client/src/lib/plugin.ts:305-330, 351-383, 715`; `descriptor.ts:148-169`.
- `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts:39-44, 121-124, 133-141, 149-162`; `invoke.ts:80-81, 183-216`; `dispatch.ts:120-133`.
- `entrypoint/apigen-cli/src/lib/commands/run.ts:307-323`; `entrypoint/apigen-cli/src/lib/orchestrator.ts:634-641`.
- `packages/apigen/apigen-plugin-policy/src/plugin.ts:292-343`; `state.ts:13-24`.
- `packages/apigen/apigen-engine-gateway/src/lib/sources/argv-operation.ts:38-44`; `mcp-source.ts:187-192`; `gateway.ts:590-591`.
