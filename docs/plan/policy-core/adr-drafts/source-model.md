# ADR draft — apigen source model: transport, extractors, runtime, targets; `Operation.binding`; one orchestration entry

**Status:** Proposed (draft for owner approval; takes the next free number in `docs/decisions/` only when the owner accepts it).
**Owner:** pseudosky.
**Drives:** REMEDIATION-PLAN segments R1 (core-client contracts), R2 (resolver), R3 (binding-aware terminal), R5 (orchestration entry), R7a/R7b (gateway sources, extractors and adapters), R8 (TS subprocess extractor and measurement); owner decisions O-1, O-2, O-4, O-8, O-9, O-10.
**Grounding:** `docs/plan/policy-core/SOURCE-MODEL-GAP-ANALYSIS.md` §0, §3a–§3f, §5.4–§5.6, §7, §8 (cited by section: that document has uncommitted edits in the working tree, so its line numbers are not stable); `docs/apigen/SPEC.md` §1, §4, §13, §14; the code cited below.

## TL;DR for the next agent

- A source is processed by a pipeline: **transport** (a locator turns a reference into assets) → **extractor** (a translator turns assets into IR) → **IR** (`Operation[]`). Execution is a matrix: **target** × **runtime** (binding).
- `Operation.host` names the extractor that produced the operation (unchanged meaning). New optional `Operation.binding` names the runtime that executes it. The gateway routes by `binding ?? host`.
- One string-pure resolver, `resolveSourceReference(reference, probe?)`, in `apigen-core-client/src/lib/source-language.ts`, replaces the three extension detectors. An unprefixed reference that matches nothing else falls back to a PATH executable, last.
- One orchestration entry, promoted from apigen-cli's `extractSource` into apigen-core-client, builds the `ExtractCall`, wraps the `extractLayer` onion around an extractor registry keyed by `ExtractCall.host`, and is the only extract path for `generate`, `run` and `serve`. TS is registered first.
- Foreign upstreams (a PATH executable, an MCP server) become extract-stage IR plus a binding, never a `mount` plugin. `serveMcpPassthrough` remains only as the degenerate proxy target and consumes IR.

## Context

1. **Three detectors with three supported sets.** `languageOfSource` (`apigen-core-client/src/lib/source-language.ts:27-41`), apigen-cli's `detectLang` (`orchestrator.ts:177-194`), and the gateway's `parseSourceSpec` (`apigen-engine-gateway/src/lib/sources/parse-source.ts:11-42`) each classify a `--source` string differently (gap analysis §1.2, finding F-5).
2. **`host` is overloaded.** `Operation.host` is documented as both "which host's extractor produced it" and "which host can serve it same-process" (`apigen-core-client/src/lib/descriptor.ts:164-169`). Foreign operations therefore claim `host: 'ts'`: the argv operation (`sources/argv-operation.ts:38-44`) and every MCP upstream tool (`sources/mcp-source.ts:187-192`). The gateway routes on `req.operation.host` (`apigen-engine-gateway/src/lib/gateway.ts:590-591`).
3. **Ids are hand-built and use `.`.** The argv operation's id is the bare command basename (`argv-operation.ts:39-42`). The MCP tool id is `` `${server}.${tool.name}` `` (`mcp-source.ts:187`). Core ids are `/`-joined slugs (`descriptor.ts:148-162`) built by the module-private `buildId` (`extract.ts:914`, duplicated at `extract-classes.ts:411`), or by the exported `syntheticOp` (`plugin.ts:562-594`).
4. **Only TS goes through the extract onion.** `ExtractCall` is host-neutral by construction (`extract-invoker.ts:15-23, 49-58`), but apigen-cli's `extractSource` handles only TS (gap analysis §0.5 item 4, §3d). `entrypoint/backlog/src/extract-live.ts:213-222` builds the same onion for its own TS source.
5. **Typed source failures bypass the error contract.** The gateway's `SourceError` carries its own codes (`sources/types.ts:66-79`); `entrypoint/policy/src/wrapper/verbs/failure.ts:15-17` matches it structurally to pick an exit code. Every other apigen failure is an `ApiError` mapped through `CLI_EXIT_CODE` (`apigen-base-errors/src/lib/errors.ts:58-64`).
6. **The policy serve path is a parallel MCP server.** `adhd-policy serve` fronts the upstream with `serveMcpPassthrough` and its own SDK server (`entrypoint/policy/src/wrapper/verbs/serve.ts:47-56`) instead of the gateway and `mcpPlugin.run`.

## Decision

### D1. Vocabulary and layout

| Term | Meaning | Group |
| --- | --- | --- |
| Source reference | The `--source` string or adhd-policy positional | — |
| Locator | Turns a reference into raw assets (path, URL, command) | `transport/` |
| Asset kind | `code` \| `schema-document` \| `endpoint` \| `executable` | `transport/` |
| Extractor (translator) | Turns assets into IR; keyed by `ExtractCall.host` | `extractors/` |
| IR | `Operation[]` / `Descriptor` | — |
| Runtime (binding) | Executes an operation: in-process TS, a local language host, a process (argv, MCP stdio), a remote client | `runtime/` |
| Target | `TargetCapability` projection: cli, mcp, api, … ; "proxy" is the degenerate target whose protocol equals the source protocol | `targets/` |

The groups are conceptual. They add no plugin capability kind, no tier, and no package (gap analysis §0.3, §0.5).

Composition rules: extractors know only assets and IR; transport knows nothing downstream; targets know IR and the transport spec; runtimes know no framework; only the orchestration entry wires them.

### D2. Host tag and binding (O-1)

- `Operation.host` keeps its producer meaning. Values: `ts`, `argv`, `mcp` in the slice; `py`, `java`, … when those extractors register.
- `Operation.binding?: string` names the runtime adapter. Absent means `host`. The argv producer sets `host: 'argv'`, `binding: 'bin:<base>'`; the MCP producer sets `host: 'mcp'`, `binding: 'mcp:<name>'`.
- The gateway selects the adapter by `operation.binding ?? operation.host`. This is a one-line change at `gateway.ts:591`, a file outside the approved gateway scope (`src/lib/sources` only); the plan lists it for owner confirmation.
- `descriptor.schema.json` gains `binding` (`string`, `minLength: 1`) and the missing `hasCtx` (`boolean`) (gap analysis F-4).

### D3. Ids

Foreign operation ids are built by core helpers, never by string templates: `syntheticOp` (`plugin.ts:562-594`) or a single exported `buildId` (deduplicating `extract.ts:914` and `extract-classes.ts:411`). The separator is `/` (BA-5): an MCP tool's id is `<source namespace>/<tool>` as rendered by the exported `buildId`, whose exact segment rendering the R1 tests pin. Policy files migrate their `tool:` values from `.` to `/` (REMEDIATION-PLAN R10).

### D4. One resolver (O-2)

`resolveSourceReference(reference, probe?)` in `apigen-core-client/src/lib/source-language.ts` returns `{ ok: true, value: ISourceResolution } | { ok: false, error }` with the types `AssetKind`, `TranslatorId`, `SourceLocator`, `BindingSpec`, `ISourceResolution`, `ISourceProbe` as specified in gap analysis §3a. It is string-pure; filesystem and PATH checks go through the injected `ISourceProbe`, whose node implementation lives in `apigen-engine-gateway/src/lib/sources/`.

Detection order (gap analysis §5.5), each step a pure function of the string plus the probe:

1. closed-list scheme prefix (`bin:`; `remote:` returns `unsupported`);
2. `http://` / `https://` → `unsupported`;
3. code extension (no stat; today's `languageOfSource`, unchanged);
4. schema-document extension → `unsupported`;
5. existing path with an exec bit → `executable`;
6. **PATH fallback** (`probe.onPath`) → `executable` — unguarded, last;
7. anything else → `invalid-reference`, naming every interpretation tried: scheme, URL, code extension, schema extension, existing path, PATH lookup.

**Accepted risk (O-2).** A mistyped bare word can run a real PATH binary. `adhd-policy run` executes it immediately after gating; `adhd-policy serve` spawns it at startup, before any policy gating, to list its tools.

### D5. One orchestration entry (O-9)

- apigen-cli's `extractSource` (`orchestrator.ts:311-360`) is promoted into apigen-core-client as the single orchestration entry.
- It builds the `ExtractCall`, composes `createExtractInvokerFromPlugins(usePlugins, registryTerminal, extractLayerOptions)` (`extract-invoker.ts:167-176`), shares the `ExtractionSession`, merges sources, and logs.
- The registry terminal is keyed by `ExtractCall.host`. TS is registered first. The `argv` and `mcp` extractors register from the gateway's `sources/` module: they receive the locator's live handle and return IR (O-4).
- Output for TS is identical for `generate`, `run` and `serve`.
- `entrypoint/backlog/src/extract-live.ts:217` is a second caller of the same onion. Moving it onto the entry is a separate segment that needs approval, because `entrypoint/backlog` is not an approved package.

### D6. Foreign upstreams are IR plus a binding (O-4, O-8)

- An MCP upstream's `tools/list` is translated by a pure `operationsFromMcpTools` (split out of `resolveMcpStdioSource`, `mcp-source.ts:54-231`) into IR carrying `host: 'mcp'`, a `binding`, and E3 tool metadata.
- Execution goes through a binding-aware dispatch terminal (`createInvoker(layers, { terminal })`, SPEC §7.1 edit draft D4), which hands the argument object and `call.signal` to the binding adapter. This replaces the flat-argument reason TAXONOMY used `createUpstreamMountPlugin`, which this ADR rejects.
- Serving goes through `createGateway` plus `mcpPlugin.run`. `serveMcpPassthrough` (`sources/mcp-passthrough-server.ts`) survives only as the degenerate proxy target and consumes IR, not a live upstream.

### D7. Source errors are `ApiError`

`SourceError` (`sources/types.ts:66-79`) is replaced by `ApiError`: `invalid-spec` and `unsupported` → `invalid_argument`; `spawn-failed` and `handshake-failed` → `makeUnavailableError` (`gateway.ts:87-103`, code `internal`, `detail.gatewayCode: 'unavailable'`). `failure.ts` loses its structural `SourceError` branch.

### D8. Extraction cost (O-10)

The TS extractor becomes drivable as a subprocess (SPEC §14). `ExtractionSession.dispose()` runs before serving. A measurement script under `tmp/` compares an ir-cache hit, an in-process miss, and a subprocess miss for memory and time. The miss default is a later owner decision informed by those numbers. Before step 9 relies on the cache, backlog 39c4e00c (TS staleness record written with `deps: []`) and a66aca5d (`computeCacheKey` omits extraction options) are verified and fixed. `computeCacheKey` lives in `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts` (rg), a package outside the approved list; the plan lists that for owner confirmation.

## Consequences

- One classifier for every `--source` string; apigen-cli reports `bin:` as a known kind instead of "unrecognised extension".
- Every foreign operation is visible to every target through the same IR, so projection naming (BA-1), envelope fields and collision checks apply to them as they do to TS operations.
- `Operation` gains two optional members (`binding`, and `tool` from the SPEC §7.1 edit draft). Producers that omit them keep today's behaviour.
- Python, Java, Rust/Go extractors and hosts, remote sources, `bin:` in adhd-apigen, per-source option grammar (O-3), py/java binding adapters, and generate-vs-live parity (O-11) are outside this decision's slice.

## Alternatives

- **Mount plugins for upstream tools** (TAXONOMY `createUpstreamMountPlugin`). Rejected (O-4): mounts receive no envelope fields (`apigen-engine-runtime/src/lib/op-plan.ts:368`) and no collision check (`apigen-plugin-mcp/src/lib/run.ts:597-636`), and they bypass extract-stage caching.
- **A new `source` plugin capability.** Rejected: the extractor registry is the `runExtractor` terminal the onion already describes (`extract-invoker.ts:118-133`).
- **A new package for the resolver.** Rejected: core-client is already a dependency of apigen-cli, the gateway and adhd-policy.

## Evidence

- `packages/apigen/apigen-core-client/src/lib/source-language.ts:27-41`; `descriptor.ts:148-169, 251`; `extract-invoker.ts:15-23, 49-58, 118-133, 167-176`; `plugin.ts:562-594`; `extract.ts:914`; `extract-classes.ts:411`.
- `packages/apigen/apigen-engine-gateway/src/lib/sources/argv-operation.ts:38-44`; `mcp-source.ts:54, 187-192`; `parse-source.ts:11-42`; `types.ts:66-79`; `gateway.ts:87-103, 300-311, 590-591`.
- `entrypoint/apigen-cli/src/lib/orchestrator.ts:177-194, 311-360, 634-641`.
- `entrypoint/policy/src/wrapper/verbs/serve.ts:47-56`; `verbs/failure.ts:11-19`.
- `entrypoint/backlog/src/extract-live.ts:213-222` (read only).
- `docs/plan/policy-core/SOURCE-MODEL-GAP-ANALYSIS.md` §0.1–§0.5, §3a–§3f, §5.4–§5.6, §7 (F-1…F-11), §8.
