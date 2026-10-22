# ADR-0017 — apigen source model: transport, extractors, runtime, targets; `Operation.binding`; one IR-generation entry

**Status:** ACCEPTED (2026-10-14).
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** `docs/plan/policy-core/REMEDIATION-PLAN.md` segments R1 (core-client contracts), R2 (resolver), R3 (binding-aware terminal), R5 (orchestration entry), R7a/R7b (gateway sources, extractors and adapters), R8 (TS subprocess extractor and measurement), R8p (IR generation and cache keying), R12 (IR baked for the policy wrapper); backlog `39c4e00c` and `a66aca5d`; owner decisions O-1, O-2, O-4, O-8, O-9, O-10, G-1, G-2.
**Grounding:** owner approvals 2026-10-14 (G-1: the gateway routes by `binding ?? host`; G-2: IR generation centralized in apigen-core-client; D1: the binding-aware dispatch terminal ships in the first slice; `adhd-policy serve bin:` uses `serveMcpPassthrough` as the degenerate proxy target); `docs/plan/policy-core/SOURCE-MODEL-GAP-ANALYSIS.md` §0, §3a–§3f, §5.4–§5.6, §7, §8 (cited by section); `docs/apigen/SPEC.md` §1, §4, §13, §14; the code cited under Evidence.

## TL;DR for the next agent

- A source is processed by a pipeline: **transport** (a locator turns a reference into assets) -> **extractor** (a translator turns assets into IR) -> **IR** (`Operation[]`). Execution is a matrix: **target** x **runtime** (binding).
- `Operation.host` names the extractor that produced the operation. Optional `Operation.binding` names the runtime that executes it. The gateway routes by `binding ?? host` (`packages/apigen/apigen-engine-gateway/src/lib/gateway.ts`, the routing line near 590-591).
- One string-pure resolver, `resolveSourceReference(reference, probe?)`, in `apigen-core-client/src/lib/source-language.ts`, replaces the three extension detectors. An unprefixed reference that matches nothing else falls back to a PATH executable, last.
- **IR generation lives in apigen-core-client.** One orchestration entry (promoted from `entrypoint/apigen-cli` `orchestrator.ts` `extractSource`) builds the `ExtractCall`, wraps the `extractLayer` onion around an extractor registry keyed by `ExtractCall.host`, and is the only extract path for `generate`, `run`, `serve` and the policy wrapper's baked IR. Its result carries the IR and the files the extractor read.
- `apigen-plugin-ir-cache` keys, stores and validates. It takes its dependency list from the extraction result and does not walk imports itself.
- Foreign upstreams (a PATH executable, an MCP server) are extract-stage IR plus a binding, never a `mount` plugin. `serveMcpPassthrough` is the degenerate proxy target and consumes IR.

## Context

1. **Three detectors with three supported sets.** `languageOfSource` (`apigen-core-client/src/lib/source-language.ts:27-41`), apigen-cli's `detectLang` (`orchestrator.ts:177-194`), and the gateway's `parseSourceSpec` (`apigen-engine-gateway/src/lib/sources/parse-source.ts:11-42`) classify a `--source` string differently (gap analysis §1.2, finding F-5).
2. **`host` is overloaded.** `Operation.host` is documented as both "which host's extractor produced it" and "which host can serve it same-process" (`apigen-core-client/src/lib/descriptor.ts:164-169`). Foreign operations claim `host: 'ts'`: the argv operation (`sources/argv-operation.ts:38-44`) and every MCP upstream tool (`sources/mcp-source.ts:187-192`). The gateway routes on `req.operation.host` (`gateway.ts:590-591`), and duplicate hosts throw (`gateway.ts:417-422`).
3. **Ids are hand-built and use `.`.** The argv operation's id is the bare command basename (`argv-operation.ts:39-42`); the MCP tool id is `` `${server}.${tool.name}` `` (`mcp-source.ts:187`). Core ids are `/`-joined slugs (`descriptor.ts:148-162`) built by the module-private `buildId` (`extract.ts:914`, duplicated at `extract-classes.ts:411`), or by the exported `syntheticOp` (`plugin.ts:562-594`).
4. **IR generation is spread over three places.** Only TS goes through the extract onion, and only in apigen-cli's `extractSource` (`orchestrator.ts:311-360`); `ExtractCall` is host-neutral by construction (`extract-invoker.ts:15-23, 49-58`). `entrypoint/backlog/src/extract-live.ts:213-222` builds the same onion for its own TS source. The policy wrapper bakes its IR through a separate path (`entrypoint/policy/src/wrapper/ir-artifact.ts`, `ir.ts`). `apigen-plugin-ir-cache` computes its cache key and its staleness dependency list itself (`packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts`), including its own walk of local imports (`collectLocalImportPaths`). Two filed defects follow from that split: `39c4e00c` (the TS staleness record is written with `deps: []`) and `a66aca5d` (`computeCacheKey` omits the extraction options).
5. **Typed source failures bypass the error contract.** The gateway's `SourceError` carries its own codes (`sources/types.ts:66-79`); `entrypoint/policy/src/wrapper/verbs/failure.ts:15-17` matches it structurally to pick an exit code. Every other apigen failure is an `ApiError` mapped through `CLI_EXIT_CODE` (`apigen-base-errors/src/lib/errors.ts:58-64`).
6. **The policy serve path is a parallel MCP server.** `adhd-policy serve` fronts the upstream with `serveMcpPassthrough` and its own SDK server (`entrypoint/policy/src/wrapper/verbs/serve.ts:47-56`) instead of the gateway and `mcpPlugin.run`.
7. **Flat-argument upstreams.** An MCP upstream or argv executable receives one argument object, not the positional binding `dispatch` performs (`apigen-engine-runtime/src/lib/dispatch.ts:128-133`). Without a terminal that hands the argument object to the binding adapter, such operations cannot run through the invoker.

## Decision

### D1 — Vocabulary and layout

| Term | Meaning | Group |
| --- | --- | --- |
| Source reference | The `--source` string or adhd-policy positional | - |
| Locator | Turns a reference into raw assets (path, URL, command) | `transport/` |
| Asset kind | `code` \| `schema-document` \| `endpoint` \| `executable` | `transport/` |
| Extractor (translator) | Turns assets into IR and reports the files it read; keyed by `ExtractCall.host` | `extractors/` |
| IR | `Operation[]` / `Descriptor` | - |
| Runtime (binding) | Executes an operation: in-process TS, a local language host, a process (argv, MCP stdio), a remote client | `runtime/` |
| Target | `TargetCapability` projection: cli, mcp, api, ...; "proxy" is the degenerate target whose protocol equals the source protocol | `targets/` |

The groups are conceptual. They add no plugin capability kind, no tier and no package. Composition rules: extractors know only assets and IR; transport knows nothing downstream; targets know IR and the transport spec; runtimes know no framework; only the orchestration entry wires them.

### D2 — Host tag and binding

- `Operation.host` names the producing extractor. Values: `ts`, `argv`, `mcp` in the first slice; `py`, `java`, ... when those extractors register.
- `Operation.binding?: string` names the runtime adapter. Absent means `host`. The argv producer sets `host: 'argv'`, `binding: 'bin:<base>'`; the MCP producer sets `host: 'mcp'`, `binding: 'mcp:<name>'`.
- The gateway selects the adapter by `operation.binding ?? operation.host`. The routing line in `apigen-engine-gateway/src/lib/gateway.ts` is edited to read `req.operation.binding ?? req.operation.host`.
- `descriptor.schema.json` carries `binding` (`string`, `minLength: 1`) and `hasCtx` (`boolean`).

### D3 — Ids

Foreign operation ids are built by core helpers, never by string templates: `syntheticOp` (`plugin.ts:562-594`) or a single exported `buildId` shared by `extract.ts` and `extract-classes.ts`. The separator is `/`: an MCP tool's id is `<source namespace>/<tool>` as rendered by the exported `buildId`, whose segment rendering the contract tests pin. Policy files use `/` in their `tool:` values.

### D4 — One resolver

`resolveSourceReference(reference, probe?)` in `apigen-core-client/src/lib/source-language.ts` returns `{ ok: true, value: ISourceResolution } | { ok: false, error }` with the types `AssetKind`, `TranslatorId`, `SourceLocator`, `BindingSpec`, `ISourceResolution`, `ISourceProbe` specified in gap analysis §3a. It is string-pure; filesystem and PATH checks go through the injected `ISourceProbe`, whose node implementation lives in `apigen-engine-gateway/src/lib/sources/`.

Detection order, each step a pure function of the string plus the probe:

1. closed-list scheme prefix (`bin:`; `remote:` returns `unsupported`);
2. `http://` / `https://` -> `unsupported`;
3. code extension (no stat);
4. schema-document extension -> `unsupported`;
5. existing path with an exec bit -> `executable`;
6. PATH fallback (`probe.onPath`) -> `executable`, unguarded, last;
7. anything else -> `invalid-reference`, naming every interpretation tried: scheme, URL, code extension, schema extension, existing path, PATH lookup.

A mistyped bare word can run a real PATH binary. `adhd-policy run` executes it immediately after gating; `adhd-policy serve` spawns it at startup, before any policy gating, to list its tools.

### D5 — IR generation is centralized in apigen-core-client

- apigen-cli's `extractSource` (`orchestrator.ts:311-360`) is promoted into apigen-core-client as the single IR-generation entry.
- The entry builds the `ExtractCall`, composes `createExtractInvokerFromPlugins(usePlugins, registryTerminal, extractLayerOptions)` (`extract-invoker.ts:167-176`), shares the `ExtractionSession`, merges sources and logs.
- The registry terminal is keyed by `ExtractCall.host`. TS is registered first. The `argv` and `mcp` extractors register from the gateway's `sources/` module: they receive the locator's live handle and return IR.
- **The extraction result carries the IR and the files the extractor read.** Each extractor reports its own dependencies: the TS extractor reports the source files its program loaded; the `argv` and `mcp` extractors report the executable or none.
- The IR artifact baked for the policy wrapper is the artifact the cache stores, produced by the same function (the entry, driven by the `apigen-plugin-ir-cache` artifact target).
- Output for TS is identical for `generate`, `run` and `serve`.
- `entrypoint/backlog/src/extract-live.ts:217` is a second caller of the same onion. Moving it onto the entry is a separate gated segment, because `entrypoint/backlog` is not an approved package.

### D6 — The ir-cache keys, stores and validates

- `apigen-plugin-ir-cache` computes the cache key (source content, extraction options, format version), stores the artifact and validates freshness against the dependency list in the extraction result. It does not walk imports: `collectLocalImportPaths` leaves the cache path.
- `computeCacheKey` includes the extraction options (backlog `a66aca5d`). The staleness record carries the extractor-reported dependency list, never `deps: []` (backlog `39c4e00c`). Both are covered by regression tests that fail when either defect returns: a changed extraction option produces a different key, and a change to an imported file invalidates a cached entry.
- This change lands in the segment that promotes the orchestration entry (before the policy wrapper's IR bake and before any step relies on the cache). The edits in `packages/apigen/apigen-plugin-ir-cache` are owner-approved.

### D7 — Foreign upstreams are IR plus a binding

- An MCP upstream's `tools/list` is translated by a pure `operationsFromMcpTools` (split out of `resolveMcpStdioSource`, `mcp-source.ts:54-231`) into IR carrying `host: 'mcp'`, a `binding`, and tool metadata (`Operation.tool`, adhd ADR-0019).
- **Execution goes through a binding-aware dispatch terminal** (`createInvoker(layers, { terminal })`, adhd ADR-0019 D4), which hands the flat argument object and `call.signal` to the binding adapter. The terminal is built in the first slice together with the orchestration entry and `Operation.binding`.
- Serving goes through `createGateway` plus `mcpPlugin.run`. `adhd-policy serve bin:<executable>` uses `serveMcpPassthrough` as the degenerate proxy target: the argv operation is IR, and its tool names are projected through the standard BA-1 projection. `serveMcpPassthrough` consumes IR and a gateway, never a live upstream handle.

### D8 — Source errors are `ApiError`

`SourceError` (`sources/types.ts:66-79`) is replaced by `ApiError`: `invalid-spec` and `unsupported` -> `invalid_argument`; `spawn-failed` and `handshake-failed` -> `makeUnavailableError` (`gateway.ts:87-103`, code `internal`, `detail.gatewayCode: 'unavailable'`). `failure.ts` has no structural `SourceError` branch.

### D9 — Extraction cost

The TS extractor is drivable as a subprocess (SPEC §14). `ExtractionSession.dispose()` runs before serving. A measurement script under `tmp/` compares an ir-cache hit, an in-process miss and a subprocess miss for memory and time. The miss default is a later owner decision informed by those numbers.

## Consequences

- One classifier for every `--source` string; apigen-cli reports `bin:` as a known kind.
- Every foreign operation is visible to every target through the same IR, so projection naming (BA-1), envelope fields and collision checks apply to it as they do to TS operations.
- `Operation` gains two optional members (`binding`, and `tool`, adhd ADR-0019). Producers that omit them keep today's behaviour.
- The cache cannot disagree with the generator about what an extraction read, because both consume the same result. A new extractor (py, java) gets correct cache invalidation by reporting its files, with no cache change.
- Edits outside the originally approved package list are in scope: `apigen-engine-gateway/src/lib/gateway.ts` (routing line) and `apigen-plugin-ir-cache`.
- Republish order follows the dependency graph: apigen-core-client, apigen-engine-runtime, apigen-plugin-ir-cache and apigen-engine-gateway before apigen-cli and the policy packages.

## Alternatives considered

- **Mount plugins for upstream tools** (TAXONOMY `createUpstreamMountPlugin`). REJECTED: mounts receive no envelope fields (`apigen-engine-runtime/src/lib/op-plan.ts:368`) and no collision check (`apigen-plugin-mcp/src/lib/run.ts:597-636`), and they bypass extract-stage caching.
- **A new `source` plugin capability.** REJECTED: the extractor registry is the `runExtractor` terminal the onion already describes (`extract-invoker.ts:118-133`).
- **A new package for the resolver or the entry.** REJECTED: core-client is already a dependency of apigen-cli, the gateway and adhd-policy.
- **Fix `39c4e00c` and `a66aca5d` inside the cache and keep its import walk.** REJECTED: the cache would keep a second, divergent notion of what an extraction depends on.

## What does NOT change

`Operation.host` keeps its producer meaning; `Operation.id` derivation for TS; the TS dispatch argument order; the HTTP and CLI error marshals. Python, Java, Rust and Go extractors and hosts, remote sources, `bin:` in adhd-apigen, the per-source option grammar and generate-vs-live parity are outside this decision's slice. This ADR does not decide the MCP result and error channel (adhd ADR-0018) or the layer-options contract (adhd ADR-0019).

## References

- Owner decisions 2026-10-14: G-1, G-2, D1 in the first slice, `serve bin:` as the degenerate proxy target.
- `packages/apigen/apigen-core-client/src/lib/source-language.ts:27-41`; `descriptor.ts:148-169, 251`; `extract-invoker.ts:15-23, 49-58, 118-133, 167-176`; `plugin.ts:562-594`; `extract.ts:914`; `extract-classes.ts:411`.
- `packages/apigen/apigen-engine-gateway/src/lib/sources/argv-operation.ts:38-44`; `mcp-source.ts:54, 187-192`; `parse-source.ts:11-42`; `types.ts:66-79`; `gateway.ts:87-103, 300-311, 417-422, 590-591`.
- `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts`.
- `entrypoint/apigen-cli/src/lib/orchestrator.ts:177-194, 311-360, 634-641`; `entrypoint/policy/src/wrapper/verbs/serve.ts:47-56`; `verbs/failure.ts:11-19`; `entrypoint/backlog/src/extract-live.ts:213-222` (read only).
- `docs/plan/policy-core/SOURCE-MODEL-GAP-ANALYSIS.md` §0.1–§0.5, §3a–§3f, §5.4–§5.6, §7 (F-1...F-11), §8.
