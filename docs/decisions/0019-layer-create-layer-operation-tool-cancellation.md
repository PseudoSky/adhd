# ADR-0019 — Layer options (`createLayer`), `Operation.binding` and `Operation.tool`, cancellation through the dispatch terminal

**Status:** ACCEPTED (2026-10-14).
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** `docs/plan/policy-core/REMEDIATION-PLAN.md` segments R1 (core-client contracts), R3 (runtime invoker), R4 (MCP signal and layer options), R5 (apigen-cli `--opt`), R6 (plugin-policy); owner decisions BA-3 (E3), BA-8 (E4), O-1, G-11.
**Grounding:** owner approval 2026-10-14 (G-11: the names `binding`, `tool`, `_meta["adhd/error"]`); `docs/apigen/SPEC.md` §4, §7.1, §8.1 (the normative text is in the SPEC); `packages/apigen/apigen-core-client/src/lib/plugin.ts`, `descriptor.ts`; `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts`, `invoke.ts`, `dispatch.ts`.

## TL;DR for the next agent

- A `layer` capability supplies `createLayer(opts)` instead of (or alongside) `layer(call, next)`. The host calls it once per invocation with the invocation's single flat `--opt` bag, the bag `extractLayer.createLayer` already receives. When both are present, `createLayer` wins.
- `Operation` carries optional `binding` (the runtime that executes it; routing key `binding ?? host`, adhd ADR-0017 D2) and optional `tool` (`{ title?, annotations? }`, transport-facing display metadata).
- `Call.signal` reaches the dispatch terminal. A `ctx`-taking function receives it through `createClient(envelope, { signal })`, never as a positional argument.
- The trap: a reader that calls `capabilities.layer.layer(...)` unguarded breaks on a plugin that has only `createLayer`. Every reader accepts both forms.

## Context

1. `LayerCapability` was `{ envelopeFields?, layer(call, next) }` (`apigen-core-client/src/lib/plugin.ts:305-330`), and the runtime's structural `UsePlugin.capabilities.layer` has only `layer` (`apigen-engine-runtime/src/lib/package-invoker.ts:39-44`).
2. A layer plugin therefore cannot receive `--use` options. `createPackageInvoker(schemas, usePlugins)` reads only `capabilities.layer.layer` (`package-invoker.ts:149-162`). apigen-cli's `run` command parses `--opt` into one flat bag and attaches the loaded plugin objects as `options.usePlugins` (`entrypoint/apigen-cli/src/lib/commands/run.ts:307-323`); `readUseOptions` looks only at `options.useOptions` (`package-invoker.ts:121-124`).
3. The only `--use` capability that receives options is `mount.operations(descriptor, opts)` (`apigen-plugin-mcp/src/lib/run.ts:433-454`). apigen-plugin-policy captures options in a module-level singleton from a `mount` capability that returns no operations (`apigen-plugin-policy/src/plugin.ts:292-343`, `state.ts:13-24`), so one process holds one policy configuration.
4. The extract stage already has the pattern: `ExtractLayerCapability { layer?, createLayer?(opts) }` (`plugin.ts:351-383`; `entrypoint/apigen-cli/src/lib/orchestrator.ts:634-641`).
5. `Operation.host` documents both the producing extractor and the same-process serving host (`descriptor.ts:164-169`); foreign upstreams need a separate runtime key (adhd ADR-0017).
6. Neither SPEC §4 nor `Operation` carries tool display metadata, so `title` / `annotations` from an MCP upstream cannot reach `tools/list`.
7. The runtime `Call` has an optional `signal` (`invoke.ts:80-81`), but `createInvoker`'s core service calls `dispatch(...)` without it (`invoke.ts:197-205`), and `dispatch` has no signal parameter (`dispatch.ts:120-127`). `dispatch` binds arguments positionally from the schema's `data` properties (`dispatch.ts:128-133`), so a positional signal would change every TS service's call signature.

## Decision

### D1 — `LayerCapability.createLayer`

`LayerCapability<Opts = Record<string, unknown>>` has `layer?` and `createLayer?(opts: Opts)`; exactly one is required (a capability with neither fails typecheck); if both are present the host uses `createLayer`. A host calls `createLayer` at most once per plugin per invocation and reuses the returned layer for every request. The options bag is the invocation's whole flat `--opt` map, not namespaced per plugin; a plugin reads only its own keys and declares them in `Plugin.optionsSchema`. A `createLayer` that throws fails the invocation before serving starts. `mount.operations(descriptor, opts)` is unchanged. Normative text: SPEC §7.1.

Runtime mirror: `createPackageInvoker(schemas, usePlugins, options: { layerOptions?, terminal? } = {})`; `adaptCoreLayer` accepts either form. apigen-cli's `loadUsePlugins(specifiers, layerOptions)` materialises `createLayer` once with the invocation's `--opt` bag, so every target (mcp, fastify, express, cli-output) receives configured layers without editing those plugins.

### D2 — `Operation.binding`

Optional `binding?: string`, an opaque routing key naming the runtime that executes the operation; absent means `host`. An extracted TS operation has no `binding`; generate, run and serve output for TS sources is unchanged. Normative text: SPEC §4. The tag vocabulary is adhd ADR-0017 D2.

### D3 — `Operation.tool`

Optional `tool?: { title?: string; annotations?: Record<string, unknown> }`: advisory metadata copied from the source (for an MCP upstream, its `tools/list` entry). It never changes `id`, `input`, `output` or dispatch. `MountedOperation` carries the same field. MCP's `tools/list` emits `title` / `annotations` from it (adhd ADR-0018 D3).

### D4 — Cancellation and the dispatch terminal

- `type Terminal = (fnName: string, call: Call, opts: InvokeOptions) => Promise<LayerResult>`.
- `createInvoker(layers, { terminal? })`: the innermost service is `terminal(call)` when supplied, else the existing `dispatch`. The terminal receives the whole `Call`, including `signal`, and the flat argument object. Binding adapters (argv, MCP upstream) are terminals (adhd ADR-0017 D7).
- `dispatch` gains a trailing `signal?: AbortSignal` parameter. It never becomes a positional argument of a user function. A `ctx`-taking function receives it as `createClient(envelope, { signal })`.
- Every host with a transport-level signal passes it as `Call.signal`: MCP passes the SDK request handler's `extra.signal`.

### D5 — Names

The field names `binding` and `tool`, and the MCP result `_meta` key `adhd/error` (adhd ADR-0018 D2), are fixed.

## Consequences

- A `--use` plugin is configured per invocation, so two policy-gated services in one process carry different configurations.
- Every layer-capability reader accepts a capability with `createLayer` and no `layer`: `createPackageInvoker`, `adaptCoreLayer`, and every direct reader of `capabilities.layer.layer` (for example `entrypoint/policy/src/wrapper/verbs/run.ts:53-56`). `gitnexus_impact` on `LayerCapability` runs before the edit.
- `descriptor.schema.json` gains optional `binding` and `tool` (and the `hasCtx` it lacked). Readers that reject unknown properties are regenerated; whether any exists is checked by the segment that edits the schema.
- The terminal adds a code path in every apigen host composed through `createPackageInvoker`; the segment's tests cover the default (no terminal) path unchanged.

## Alternatives considered

- **Keep the module-singleton option capture in apigen-plugin-policy.** REJECTED: one configuration per process.
- **Namespace the options bag per plugin.** REJECTED: it would diverge from the flat bag `extractLayer.createLayer` already receives.
- **Pass the signal as a positional argument of user functions.** REJECTED: it changes every TS service's call signature.

## What does NOT change

`Plugin.capabilities.mount`, `envelope`, `extractLayer`; the meaning of `Operation.host`; `Operation.id` derivation; the TS dispatch argument order. This ADR does not decide the MCP result and error channel (adhd ADR-0018) or the source pipeline (adhd ADR-0017).

## References

- Owner decisions 2026-10-14: BA-3, BA-8, O-1, G-11.
- `docs/apigen/SPEC.md` §4, §7.1, §8.1.
- `packages/apigen/apigen-core-client/src/lib/plugin.ts:305-330, 351-383, 715`; `descriptor.ts:148-169`.
- `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts:39-44, 121-124, 133-141, 149-162`; `invoke.ts:80-81, 183-216`; `dispatch.ts:120-133`.
- `entrypoint/apigen-cli/src/lib/commands/run.ts:307-323`; `orchestrator.ts:634-641`; `packages/apigen/apigen-plugin-policy/src/plugin.ts:292-343`; `state.ts:13-24`.
