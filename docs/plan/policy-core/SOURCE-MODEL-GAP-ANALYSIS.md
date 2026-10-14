# Source model gap analysis: transport, extractor, runtime and target layout

Date: 2026-10-13. Role: debugger/architect (read-only on source). Baseline: branch `feat/policy-core` at `a7fa35ad`. Paths are relative to the worktree root. A `file:line` citation means those lines were opened and read for this document. A citation marked **(rg hit)** means only the matching line was seen in `rg` output. A bare path comes from a directory listing.

## Contents

- 0. The target model: vocabulary, the four-group layout, composition rules, settled decisions
- 1. Q1: where each primitive lives today, how far it is from the model, and what it is fused with
- 2. Q2: can `Operation` express a binding separate from the translator?
- 3. Q3: the minimal change set
- 4. Q4: reconciliation with TAXONOMY-CONFORMING-DESIGNS.md and APIGEN-CONFORMANCE-REVIEW.md
- 5. Q5: hazards and the smallest safe rule for each
- 6. Q6: where the model is (not) documented, and where to record it
- 7. Findings (bugs and drift found while tracing)
- 8. Change sequence around the orchestration entry
- 9. Open decisions for the owner
- 10. Translation versus execution environment
- 11. `run` versus `generate`
- 12. Compatibility matrix and unlock order

---

## 0. The target model and its nearest existing names

### 0.1 Vocabulary: owner terms, SPEC terms, and the primitives used in this document

| Owner term | SPEC term | Primitive in this document | Code today |
|---|---|---|---|
| Detector | The orchestrator's "detect lang per file" (SPEC §1) | Asset kind detection | Three copies: `languageOfSource`, `detectLang`, `parseSourceSpec` (section 1.2) |
| Locator + Translator | The two halves of the Extractor (SPEC §1, §14) | Locator (the transport step) and translator (an extractor as a whole) | Section 1.3 |
| Runtime / host | The language runtime plus Harness (SPEC §13); SPEC §13.1 supervision covers lifecycle | Local execution binding | `apigen-engine-runtime`, `runtime.py`, `ApigenJavalinServer` (section 1.5) |
| Binding | The execution binding on an `Operation` | Execution binding | Conflated in `Operation.host` (section 2) |
| Effects | `Operation.kind` and `Operation.safe` (already exist) | Part of the IR | `Operation` (`apigen-core-client/src/lib/descriptor.ts:148-252`) |
| Target | `TargetCapability`: generate and/or serve | Projection | The plugins (section 1.6) |

Terminology in the body: "locator" means the transport step that turns a reference into raw assets. "Translator" means an extractor as a whole. "Target" keeps the SPEC meaning. The word "Executor" is not used for frameworks.

### 0.2 The primitives and their nearest existing code

| Model primitive | Nearest existing code concept | Evidence |
|---|---|---|
| Source reference | The `--source <path>` string. apigen-cli `run`, `serve` and `generate` each declare it as a file path. adhd-policy reads a positional argument instead. | `entrypoint/apigen-cli/src/lib/commands/run.ts:249`; `serve.ts:1569-1574`; `generate.ts:191` (rg hit); `entrypoint/policy/src/wrapper/flags.ts:33-41` |
| Locator | Implicit `path.resolve(...)`, plus the gateway's `SourceSpec` (`file`/`remote`/`bin`) | `run.ts:325`; `serve.ts:214`; `packages/apigen/apigen-engine-gateway/src/lib/sources/types.ts:12-15` |
| Asset kind | None. The code has only "language", derived from the file extension. | `packages/apigen/apigen-core-client/src/lib/source-language.ts:27-41` |
| Translator | "Extractor". The extract stage is keyed by `ExtractCall.host`. | `apigen-core-client/src/lib/extract-invoker.ts:49-73`, `:15-23` |
| IR | `Operation[]` / `Descriptor` | `apigen-core-client/src/lib/descriptor.ts:148-252`; `plugin.ts:221-234` |
| Execution binding | Spread across several mechanisms: in-process `fns` tables, target plugins that spawn their own language server, `HostAdapter`, and the gateway source closures | `run.ts:405-420`; `apigen-plugin-py-flask/src/lib/plugin.ts:177-209`; `gateway.ts:191-236`; `sources/resolve-source.ts:94-97` |
| Projection | `target` / `mount` / `layer` plugin capabilities | `apigen-core-client/src/lib/plugin.ts:723-754` |

SPEC already has the three-stage shape the model refines. It names "extract (per-language extractors → merged descriptor) · generate · run" (`docs/apigen/SPEC.md:62-68`). It defines a first-class host as "Extractor" plus "Runtime/harness" plus "Server plugins" plus "Gateway adapter" (`SPEC.md:558-569`). In model terms that is translator + local binding + projection + remote binding. SPEC has no locator, no asset kind, and no notion of a binding that differs from the language that produced the operation.

### 0.3 The four-group layout

Each group is a registry plus its contributors. The groups are a conceptual grouping, not new tiers: the tiers in `docs/contributing/conventions/package-naming.md` stay `base`, `core`, `store`, `engine`, `serializer`, `plugin`, `generator`, `query`, and adding a tier or a package needs owner approval. No new plugin capability kinds are introduced.

| Group | Role | Kinds | Contributors in the code today |
|---|---|---|---|
| `transport/` | Detectors and resolvers of raw assets and execution descriptors | remote (file, data, zip, package-manager); fs; bin; raw | `parseSourceSpec` (`sources/parse-source.ts`), `resolveSource` (`sources/resolve-source.ts`), `process.ts`, `launcher-transport.ts`, `source-language.ts` |
| `extractors/` | Receive the transport result and assets, return IR | language (ts, py, java; later rs, go); protocol (mcp, graphql); standard (openapi, jsonschema); ir descriptor (reads a Descriptor / ir-cache artifact) | ts: `apigen-core-client/src/lib/extract.ts`. py: `apigen_python/extractor.py` plus `apigen/python-env`. java: `ApigenJavaExtractor`. The others have no code (section 1.3). |
| `runtime/` | Per language, owns `run` (takes runnable code and runs it) and `serve` (serves it): typescript, python, java; later rust, go. A remote protocol client is also a runtime/binding kind. | | `apigen-engine-runtime`; Python `runtime.py`, `validator.py`, `errors.py`; `ApigenJavalinServer` |
| `targets/` | Per framework or protocol: cli, mcp, api (fastify, express), flask, grpc, spring/javalin, graphql, fast-api, proxy passthrough. `generate` takes descriptors plus the transport spec and produces runnable code or a live handle. | | The plugins; `flask_server.py` and `grpc_server.py` as the framework servers inside the Python module |

### 0.4 Composition and dependency rules

- The source side is a pipeline: transport → extractor → IR.
- The run side is a matrix: target × runtime.
- Extractors know only asset and IR types. Transport knows nothing downstream. Targets know IR and the transport spec. Runtimes know no frameworks. Only the orchestration entry wires them together.

### 0.5 Settled decisions

1. SPEC's term "Target" stays. No new plugin capability kinds and no new tiers.
2. Remote MCP, and remote anything, is an execution **binding** (a client runtime), not a framework. A "proxy" target is only the degenerate case where the source protocol equals the target protocol.
3. Protocol targets (cli, mcp, api) are implemented once, hosted in the TS process, and reach other runtimes through binding adapters over the sidecar gateway. SPEC §13 already makes the sidecar gateway the confirmed default for mixed hosts: one local-IPC hop per operation, with the SPEC §13.1 failure model. Language-native frameworks (flask, grpc, javalin) run in their own language and accept only same-language sources.
4. Orchestration, not only registration: every source kind goes through **one** orchestration entry that builds the `ExtractCall`, composes the `extractLayer` onion (ir-cache, tracing) around a registry terminal keyed by `ExtractCall.host`, shares the `ExtractionSession`, merges sources and logs. Only TS goes through it today (`orchestrator.ts` `extractSource`, lines 311-360, read). Python and Java extraction happens inside the `py-flask`, `py-grpc` and `java-javalin` `run()`, so those sources bypass the onion and cannot be cached.
5. Extraction is removed from the framework plugins. The host (language module) keeps both halves: `extract(source) → Descriptor JSON` and `serve(plan, binding)`. The orchestrator invokes extract through the registry. The Node-side wrapper of the host registers it (`python-env` for Python). The framework plugin receives the Descriptor and passes it through.

---

## 1. Q1: each primitive today

### 1.1 Source reference and locator

**apigen-cli.** All three commands treat `--source` as a filesystem path, and each resolves it separately.
- `run`: `requiredOption('--source <path>', 'Path to TypeScript source file')` (`run.ts:249`), then `path.resolve(opts.source)` (`run.ts:325`).
- `serve`: `path.resolve(src)` inside `resolveHosts` (`serve.ts:214`).
- `generate`: `path.resolve(opts.source)` (`generate.ts:246`, read at `:240-300`).

None of them checks that the path exists before choosing a language. A mistyped `.ts` path therefore fails later, inside extraction or import, with no bin or remote interpretation. This is the behaviour the model's "unchanged for `.ts`/`.py`/`.java`" constraint must keep.

**Gateway (this initiative).** `parseSourceSpec` (`sources/parse-source.ts:11-42`) is a prefix parser. It maps `bin:<command>` to `bin`, `remote:<http(s) url>` to `remote`, and anything else to `file`. It executes nothing and stats nothing (`:4-10`).

Distance from the model: `SourceSpec` (`types.ts:12-15`) mixes two dimensions.
- `remote` is a pure locator (a URL with an unknown asset kind).
- `file` is a pure locator (a path with an unknown asset kind).
- `bin` is a locator (a name resolved on PATH, at spawn time: `process.ts:120-126`) **and** an asset kind (executable) at once.

### 1.2 Asset kind and detection: three detectors, three supported sets

The owner's premise is that "`--source` auto-detects (today by extension via `languageOfSource`)". That holds for `serve` only. There are three independent detectors:

| Detector | Used by | Supported set | Evidence |
|---|---|---|---|
| `languageOfSource` (`EXTENSION_MAP`) | `serve` only (`resolveHosts`) | `.ts .tsx .mts .cts .py .rs .go .java` | `source-language.ts:27-41`, `:64-67`; `serve.ts:215`, `:1455` |
| `detectLang` | the orchestrator (`run` TS path, `generate`, registries) | `.ts .tsx .mts .cts` only; anything else throws | `orchestrator.ts:177-194`, `:318` |
| `parseSourceSpec` | adhd-policy `run`/`serve` only | prefixes `bin:` / `remote:` / else file | `parse-source.ts:11-42`; `verbs/run.ts:27`; `verbs/serve.ts:32` |

`run` does not detect the source at all. It picks its pipeline from the **target plugin's** declared language: `const pluginLang = effectiveLanguage(plugin)` (`run.ts:358`). When that is not `'ts'`, it passes the raw path to `plugin.run` with empty schemas (`run.ts:367-379`). So the source kind is implied by `--type`, not by the source.

The other two helpers in `source-language.ts`, `pluginConsumesSource` and `sourcesForPlugin` (`:115-150`), have no production caller. Their only references are the barrel (`apigen-core-client/src/index.ts:83-85`, rg hit) and `src/test/source-language.spec.ts` (rg hits).

There is no asset kind other than "code in language X". No detector recognises a schema document (OpenAPI, MCP manifest, GraphQL SDL, JSON Schema) or a live endpoint, and only adhd-policy recognises an executable.

### 1.3 Translators (extractors)

| Translator | Where it lives | Reached from | Pure? | Fused with |
|---|---|---|---|---|
| TS (`extract()`, ts-morph) | `apigen-core-client/src/lib/extract.ts`; invoked at `orchestrator.ts:327-348` | the extract stage (orchestrator), so `generate`, `run` and the registries all reach it, wrapped by the `extractLayer` onion | Static analysis | Nothing. It is the one translator at the model's position. |
| Python (`apigen_python.extractor --emit-json`) | `packages/apigen/python/apigen_python/extractor.py`; spawned by `runExtractorEmitJson` (`python-env/src/lib/run-extractor.ts:42-82`) | **only** inside the `py-flask` and `py-grpc` target plugins' `run()` (`apigen-plugin-py-flask/src/lib/plugin.ts:203-209`; `apigen-plugin-py-grpc/src/lib/plugin.ts:202` (rg hit)) | **No.** It imports and executes the user module: `spec_from_file_location` then `spec.loader.exec_module(mod)` (`extractor.py:373-387`). | The projection (an HTTP/gRPC server) and the binding (a Python subprocess), all inside one `run()` |
| Java (`ApigenJavaExtractor --emit-json`) | `packages/apigen/java/...`; spawned by `runExtractorEmitJsonJava` (`apigen-plugin-java-javalin/src/lib/plugin.ts:88-110`) | **only** inside `java-javalin`'s `run()` (`plugin.ts:497` (rg hit)) | Source parsing (JavaParser, per `plugin.ts:11-25` (rg hit)) | Projection + binding, as for Python |
| Rust, Go | — | — | — | `EXTENSION_MAP` maps `.rs`/`.go` (`source-language.ts:35-38`), but there is no extractor, and `DEFAULT_PLUGIN_FOR_LANGUAGE` has no entry for them (`serve.ts:91-95`). `serve --source x.rs` therefore fails at `serve.ts:237-243`. |
| argv (executable → one `{argv,cwd}` operation) | `sources/argv-operation.ts:38-75` (`buildArgvOperation`) | adhd-policy `run` only, through `resolveSource(spec,'run')` (`resolve-source.ts:73`) | **Yes** ("Pure construction: nothing is started", `:33-37`) | Already split from its binding (`createArgvInvoker`, `:116-165`) |
| MCP (`tools/list` → `Operation[]`) | `sources/mcp-source.ts:151-231` | adhd-policy `serve` only (`resolve-source.ts:56-72`) | The mapping is pure, but it sits inside one function that also spawns the process (`:75-80`) and opens the client (`:83-129`) | Locator + binding (see 1.6) |
| OpenAPI, GraphQL, JSON Schema (inbound) | **none** | — | — | `codegen/openapi` exports only `toOpenApi` (`codegen/openapi/src/lib/to-openapi.ts:121`, rg hit), which is IR → OpenAPI, a projection. `apigen-plugin-jsonschema` is generate-only (`apigen-plugin-jsonschema/src/lib/plugin.ts:1-30`). No `graphql` file exists under `packages/apigen` (rg over the tree returned none). This settles f6bf8550 item 6 ("unverified whether apigen already ingests OpenAPI or JSON Schema"): it does not. |

**Headline gap.** The extract stage holds exactly one translator. `extractSource` handles `lang === 'ts'` and otherwise throws `host "${lang}" extractor not implemented` (`orchestrator.ts:318-359`). But `detectLang` already throws for anything that is not TS, so that branch is unreachable (`:185-193`).

Consequences:
- **Python and Java IR never reaches a projection other than their own server.** `py-flask`'s and `java-javalin`'s `generate()` return `{files: []}` (`py-flask/plugin.ts:374-377`; java `plugin.ts:632` (rg hit)). `adhd-apigen generate --source api.py --type openapi` throws in `detectLang`.
- **The extract onion never wraps the Python or Java extractors.** Its only callers are the orchestrator and backlog's `extract-live.ts` (rg: `orchestrator.ts:327`, `entrypoint/backlog/src/extract-live.ts:217`). So ir-cache cannot cache them.

The extract onion was built for this generalisation. Its contract says `ExtractCall` is "HOST-NEUTRAL by construction... a future subprocess-based extractor must be able to sit under the identical onion without redesigning it" (`extract-invoker.ts:15-23`). `ExtractCall.host` is documented as the "declared owning language runtime tag" (`:56`). **In the model, `ExtractCall.host` is the translator id, and the terminal `runExtractor` is the translator registry.** No new capability kind is needed.

### 1.4 IR

`Operation` (`descriptor.ts:148-252`) is the canonical IR. The descriptor header states that "Nothing downstream sees source — only this descriptor" (`descriptor.ts:3-6`). The `Descriptor` wrapper adds `host` and `namespace` (`plugin.ts:221-234`).

The conflating field is `host` (section 2).

There is a second, drifted copy of the contract: `descriptor.schema.json` is `additionalProperties: false` (`:7`), it requires `host` and eleven other keys (`:8-21`), and it omits `hasCtx`, which the TS type carries (`descriptor.ts:251`; `rg hasCtx descriptor.schema.json` returns nothing). No code loads the schema (`rg descriptor.schema` over `packages`/`entrypoint` matches only the file itself and a backlog fixture corpus).

### 1.5 Execution bindings (today)

| Binding (model) | How it is realised today | Evidence |
|---|---|---|
| Local language host, in process (TS) | `importSource` + `buildFnTable` produce `fns`, which the target plugin dispatches positionally | `run.ts:405-420`; `apigen-engine-runtime/src/lib/dispatch.ts:120-133` |
| Local language host, subprocess (py, java) | The **target plugin** spawns its own server, after extracting | `py-flask/plugin.ts:177-209`, `:254-280` |
| Local language host, subprocess, behind a front (serve) | Each source becomes a child `adhd-apigen run --type <plugin>` on a free port, behind serve's own HTTP/H2 proxy | `serve.ts:502-550`, `:564-622`, `:1232` (rg hit), `:1483-1495` |
| Generic host router | `createGateway` routes by `operation.host` to a `HostAdapter`. It has **no production caller**: only `gateway.spec.ts` and `gateway-mixed-host.e2e.ts` use it (rg). `gx impact createGateway` returns 0 upstream. | `gateway.ts:191-236`, `:585-600` |
| Local process, argv | `createArgvInvoker` through `IProcessLauncher` | `argv-operation.ts:116-165`; `process.ts:114-137` |
| Local process, MCP over stdio | An SDK `Client` over `createLauncherTransport`. It is exposed twice: as positional `pkg.fns` closures and as `IMcpUpstream.callTool` | `mcp-source.ts:83-88`, `:214-244`; `types.ts:31-42` |
| Remote host (http/mcp/grpc), derived from the asset | **none**. `remote` throws `unsupported` | `resolve-source.ts:50-51` |

**The plugin `language` field fuses three primitives.** `OutputPlugin.language` / `Plugin.language` is "the source language this plugin consumes" (`types.ts:127-138`; `plugin.ts:696-707`).
- For `py-flask` (`language: 'py'`, `plugin.ts:365`), it names the translator, the binding and the projection's runtime at once.
- For `mcp` / `api-fastify` / `cli-output` (`language: 'ts'`; rg hits at `apigen-plugin-mcp/src/lib/plugin.ts:14`, `api-fastify/.../plugin.ts:13`, `cli-output/.../plugin.ts:14`), it means "the binding is in-process TS fns". The projection itself is language-neutral.

The `types.ts:134-136` doc ("All first-party plugins explicitly declare `language: 'ts'`") is false: `py-flask`, `py-grpc` and `java-javalin` declare `'py'`/`'py'`/`'java'` (rg hits `py-flask plugin.ts:365`, `py-grpc plugin.ts:334`, `java-javalin plugin.ts:623`).

### 1.6 Fusion map: each component and which primitives it fuses

| Component | Reference | Locator | Asset kind | Translator | Binding | Projection | Notes |
|---|---|---|---|---|---|---|---|
| `languageOfSource` / `EXTENSION_MAP` (`source-language.ts:27-67`) | | | ✓ (code only) | ✓ (language = translator id) | | | Language doubles as asset kind and translator id |
| `detectLang` (`orchestrator.ts:185-194`) | | | ✓ | ✓ | | | A second table, TS-only |
| `resolveHosts` / `Host` / `DEFAULT_PLUGIN_FOR_LANGUAGE` (`serve.ts:91-128`, `:207-259`) | ✓ | ✓ (`path.resolve`) | ✓ | ✓ (`language`) | ✓ (child process, port, `transport`) | ✓ (`plugin`) | `Host` is all six at once. `DEFAULT_PLUGIN_FOR_LANGUAGE` maps a translator to a projection-plus-binding plugin. Its error text omits `.java` (`:218-219`) although `java` is mapped (`:94`). |
| `run.ts --source` (`run.ts:325-423`) | ✓ | ✓ | (implied by `--type`) | ✓ (TS path) or delegated to the plugin | ✓ (`fns`) | ✓ (`--type`) | Translator selection is driven by the projection (`:358`, `:367`) |
| orchestrator `extractSource` (`orchestrator.ts:311-360`) | | | | ✓ (translator registry with one entry) | | | Already the right seam (`ExtractCall`) |
| `ExtractCall` / `runExtractor` / `extractLayer` / ir-cache (`extract-invoker.ts:49-176`; `plugin.ts:369-383`) | | | | ✓ | | | Clean. ir-cache keys on `call.host` and hashes `call.source` as a **local file** (`apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts:236-250`), so a remote asset must be materialised locally before the onion (section 5) |
| `Operation.host` (`descriptor.ts:164-169`) | | | | ✓ ("which host's extractor produced it") | ✓ ("which host can serve it") | | The field itself is the conflation (section 2) |
| TS extractor (`extract.ts`) | | | | ✓ | | | Pure, static |
| py / java plugins | ✓ (`importPath` carries the path, `py-flask plugin.ts:183-196`) | | ✓ (`.py` check, `:192-196`) | ✓ (`:203-209`) | ✓ (spawn, `:269-280`) | ✓ (HTTP/gRPC server) | Everything in one `run()` |
| `HostAdapter` / `createGateway` (`gateway.ts:182-236`, `:585-600`) | | | | | ✓ | | Clean binding abstraction, keyed by `operation.host`, unused in production |
| serve's own front proxy (`serve.ts:24-49`, `:1232`) | | | | | ✓ (router) | ✓ (front) | A second router. It keys by URL namespace, not by `operation.host` |
| mount capability (`plugin.ts:443-494`) | | | | (synthesises ops) | ✓ (`handler`) | | A mount op carries its own binding (`handler`), bypasses translators, and is never seen by `generate` or `extractLayer` |
| op-plan / `dispatchForPlan` (`apigen-engine-runtime/src/lib/dispatch-for-plan.ts:84-128`) | | | | | ✓ (positional `fns`, or mount `handler`) | (host side) | Never reads `op.host`. The runtime `Call` carries only `operation: { id }` (`:94`) |
| `sources/parse-source.ts` (`:11-42`) | ✓ | ✓ | ✓ (`bin` only) | | | | Locator parser, with an asset kind hard-wired into `bin:` |
| `sources/resolve-source.ts` (`:44-104`) | | | | ✓ **selected by the CLI verb** (`intent === 'serve'` → MCP translator, else argv, `:56`, `:73`) | ✓ (`fns` closure, `:94-97`) | | **The core conflation in the new code.** The asset (an executable) does not decide its translator; the caller's verb does. |
| `sources/argv-operation.ts` | | | | ✓ `buildArgvOperation` (`:38-75`) | ✓ `createArgvInvoker` (`:116-165`) | | Already split cleanly. Stamps `host: 'ts'` (`:43`) |
| `sources/mcp-source.ts` `resolveMcpStdioSource` (`:54-275`) | | ✓ spawn (`:75-80`) | | ✓ `tools/list` → ops (`:134-231`) | ✓ client, `fns`, `callTool` (`:83-129`, `:214-244`) | | One function covers three primitives. Stamps `host: 'ts'` (`:192`) |
| `sources/mcp-passthrough-server.ts` `serveMcpPassthrough` (`:101-203`) | | | | | ✓ (calls `upstream.callTool` directly, `:144-149`) | ✓ (an MCP SDK server, `:123-165`) | **A projection that bypasses the IR.** `tools/list` returns the upstream's raw `Tool` objects (`:121`, `:124`), not operations. It reads operations only to give Layers an `operation` (`:110-114`, `:133-140`). |
| `sources/process.ts`, `launcher-transport.ts` | | ✓ (spawn, PATH at exec time) | | | ✓ (substrate) | | Binding substrate |
| `sources/stdio-host-transport.ts` | | | | | | ✓ (host-facing transport) | Not a source primitive at all |
| `entrypoint/policy` `verbs/run.ts` (`:20-81`) | ✓ (positional) | ✓ (`parseSourceSpec`) | ✓ (`bin` only, `:28-30`) | via `resolveSource(spec,'run')` (`:42-46`) | ✓ (`resolved.pkg.fns`) | ✓ (its own `createInvoker` composition, a CLI-like projection, `:53-72`) | |
| `entrypoint/policy` `verbs/serve.ts` (`:26-61`) | ✓ | ✓ | (any; `file`/`remote` throw in the resolver) | via `resolveSource(spec,'serve')` (`:41-47`) | ✓ | ✓ (`serveMcpPassthrough`, `:48-54`) | |
| `entrypoint/policy` `mount.ts` / `package.ts` / `ir.ts` / `ir-live.ts` | fixed (the policy client's `service/api.d.ts`) | ✓ `locateClientApi` (`ir.ts:69-82`) | code (TS) | ✓ TS `extract()` (`ir-live.ts`, read in full) behind a baked-artifact cache (`ir.ts:123-175`) | ✓ in-process `policyOperations` fns (`package.ts:66`) | ✓ `cliPlugin`/`mcpPlugin`/`apiFastifyPlugin` (`mount.ts:116-166`) | **Already model-conformant**: located asset → TS translator → in-process binding → projection. The baked IR is an `extractLayer`-shaped cache written by hand (review C3), not a model gap. |

**Classification of the new gateway code:**

| Role | Code |
|---|---|
| Locator | `parse-source.ts`; the `launcher.start` half of `process.ts` and `mcp-source.ts:75-80` |
| Translator | `buildArgvOperation`; `mcp-source.ts:151-231` (the per-tool `Operation` mapping, skip rules, hints) |
| Binding | `createArgvInvoker`; `launcher-transport.ts`; the `Client` and `callTool` in `mcp-source.ts:83-129`, `:214-244`; `IMcpUpstream`; `process.ts` |
| Projection | `mcp-passthrough-server.ts`; `stdio-host-transport.ts` |
| Fusing | `resolve-source.ts` (the verb picks the translator); `resolveMcpStdioSource` (locator + translator + binding); `IResolvedSource` (`types.ts:45-64`: IR + binding `fns` + MCP binding + lifecycle in one record) |

---

## 2. Q2: can `Operation` express a binding separate from the translator?

**No.** The relevant fields:

```ts
// apigen-core-client/src/lib/descriptor.ts:164-169
/**
 * The owning language runtime / host for this operation, e.g. 'ts', 'py', 'rust'.
 * Identifies which host's extractor produced it and which host can serve it
 * same-process. Polyglot descriptors mix hosts.
 */
host: string;
```

Nothing else on `Operation` (`descriptor.ts:148-252`) names where or how the operation runs. `typeText.lang` is presentation only (`:104-111`). The `Descriptor` wrapper has one `host` for all operations (`plugin.ts:225-228`).

**Every reader of `Operation.host` / `Descriptor.host` (rg over non-test `*.ts` in `packages/apigen`, `entrypoint/apigen-cli`, `entrypoint/policy` and `entrypoint/backlog`, plus Python and Java sources):**

| Reader | What it does with it | Evidence |
|---|---|---|
| `createGateway().route` | **Routing key**: `hosts.get(req.operation.host)`; an unknown key gives `unavailable` | `gateway.ts:591-600`; adapters keyed at `:417-423` |
| `syntheticOp` | Copies `descriptor.host` onto every mount op | `plugin.ts:577-579` |
| `apigen-plugin-health` | Returns `host: descriptor.host` in the health body | `apigen-plugin-health/src/lib/plugin.ts:105` (rg hit) |
| Python conformance test | Asserts every extracted op has `host == "python"` | `packages/apigen/python/run_tests.py:584-590` |
| Layers | **Cannot read it on package ops.** The runtime `Call` carries only `operation: { id: plan.op.id }` | `dispatch-for-plan.ts:89-95` |

`ExtractCall.host` is a different field (the translator id). ir-cache hashes it into the cache key (`ir-cache-layer.ts:244`) and into the default cache file name (`default-cache-file.ts:63`, rg hit). The orchestrator e2e test pins it: `expect(calls.map((c) => c.call.host)).toEqual(['ts','ts'])` (`entrypoint/apigen-cli/src/test/orchestrator.e2e.ts:858`, rg hit).

**Producers and the values they stamp. The vocabulary is already inconsistent:**

| Producer | `host` value | Evidence |
|---|---|---|
| TS extractor | `'ts'` | `extract.ts:866`, `:896`; `extract-classes.ts:242`, `:313`, `:389` (rg hits); `orchestrator.ts:345` (`ExtractCall`) |
| Python extractor | `"python"` | `extractor.py:465-467` |
| `py-flask`, building a `Descriptor` from those same ops | `'py'` | `py-flask/plugin.ts:234` |
| `PluginLanguage` | `'py'` | `types.ts:122` |
| Java extractor | `"java"` | `ApigenJavaExtractor.java:239` (rg hit) |
| argv translator (gateway) | `'ts'` | `argv-operation.ts:43` |
| MCP translator (gateway) | `'ts'` | `mcp-source.ts:192` |

So one `py-flask` run already pairs operations tagged `"python"` with a `Descriptor` tagged `'py'`. Routed through `createGateway`, a Python adapter registered under `'py'` would receive nothing, because `route` keys on `operation.host` (`gateway.ts:591`). The argv and MCP operations claim `'ts'` although no TS extractor produced them.

**What breaks if translator language and binding are split.**
- **Splitting by redefining `host` as the binding key** (TAXONOMY BA-7, `TAXONOMY-CONFORMING-DESIGNS.md:428`): no type change.
  - It loses the producer identity for foreign ops (an MCP op would read `mcp:fs`, not `mcp`).
  - It forces the vocabulary to be fixed first (`python` vs `py`), and that breaks `run_tests.py:587` and the conformance `gate.spec.ts:440` `expect(m.host).toBe('python')` (rg hit), which assert `'python'`.
  - It leaves one string carrying two meanings, with no way to tell which.
- **Splitting by adding an optional binding key:** nothing breaks. No production code reads a binding today. The gateway is the only routing reader, and it reads `op.binding ?? op.host`, so every existing producer, which emits no `binding`, routes exactly as before.
  - The TS change is additive: an optional property.
  - The JSON contract `descriptor.schema.json` is `additionalProperties:false` (`:7`). It must gain the property in the same change, and it should gain the missing `hasCtx` too. No loader exists, so no runtime breaks.
  - Python and Java emit plain dicts and never need the key. `py-flask` writes ops into a plan file for `flask_server.py` (`plugin.ts:252-261`). Python reads keys by name, so an absent optional key is a no-op. That a present unknown key is tolerated was **not verified**, because `_build_state` was not opened. It is irrelevant while no Python-bound op carries the field.
  - ir-cache stores whole ops. Old cache entries lack the field and remain valid, because it is optional.

**Why the binding must be per operation, not only per source.**
- The gateway routes per operation (`gateway.ts:591`).
- OpenAPI allows `servers` per path item and per operation. One schema-document asset can therefore yield operations with different remote bindings.
- Under the model, one merged descriptor mixes bindings: `serve a.ts b.py c-openapi.json` gives in-process ts, local py and remote http.

A per-source binding table is still needed for the details (URL, command, protocol, credentials). The per-operation field should be a **key** into that table, never the details themselves. Codegen projections (`toOpenApi`, clients) consume `Operation`, and must not leak a command line or an upstream URL into generated artifacts. **Recommendation:** `binding?: string`. The table is the set of `HostAdapter`s, whose `host` member becomes "binding key" (`gateway.ts:192-193`). That makes `HostAdapter` the model's execution binding, unchanged.

**Blast radius (gitnexus, upstream).** All LOW:
- `languageOfSource`: 2 direct.
- `effectiveLanguage`: 3, 1 process (`registerRunCommand`).
- `resolveSource`: 2 (`runVerb`, `serveVerb`).
- `parseSourceSpec`: 2.
- `serveMcpPassthrough`: 1.
- `buildArgvOperation`: 3.
- `createGateway`: 0.

The gitnexus index is incomplete for this area. It reports 0 upstream for `resolveHosts`, `detectLang` and `resolveMcpStdioSource`, which have real callers at `serve.ts:1455`, `orchestrator.ts:318` and `resolve-source.ts:57`. The rg evidence above is therefore authoritative.

---

## 3. Q3: the minimal change set

Principles:
- No new package (new packages need owner approval).
- No new tier and no new plugin capability kind.
- Today's `.ts`/`.py`/`.java` behaviour is unchanged.
- Every new kind that is not built returns a typed "unsupported" from **one** place.

### 3a. One resolver, replacing extension-only detection

**Where:** `packages/apigen/apigen-core-client/src/lib/source-language.ts`, beside `languageOfSource`.
- Both apigen-cli and the gateway already depend on core-client: `entrypoint/apigen-cli/package.json:9`, and the gateway `package.json` dependencies, read above.
- adhd-policy depends on it too (`entrypoint/policy/package.json`, dependencies, read above).
- The resolver is **string-pure**. Filesystem and PATH checks are injected through a probe port, the same way `IResolveDeps.launcher` injects process start (`resolve-source.ts:11-13`).
- core-client is tagged `platform:shared` (`apigen-core-client/project.json:15-18`). It already imports `node:path`/`node:fs` elsewhere (`source-language.ts:13`, `extraction-session.ts:38`), which is drift (finding F-6). The new code must not add to it, so it uses string operations instead of `path.extname`.
- The node probe lives in `apigen-engine-gateway/src/lib/sources/` (`platform:node`, `apigen-engine-gateway/project.json:15-18`), which already owns the process launcher.
- No new package is needed. A new package would only be justified if apigen-cli must not depend on the gateway. apigen-cli does not list the gateway today (`entrypoint/apigen-cli/package.json:8-28`), but it needs the probe only from step 10 onward.

```ts
// BEFORE (source-language.ts:27-67)
const EXTENSION_MAP: ReadonlyMap<string, PluginLanguage>;
export function languageOfSource(file: string): PluginLanguage | undefined;

// AFTER (additive; EXTENSION_MAP and languageOfSource unchanged, the resolver calls them)
export type AssetKind = 'code' | 'schema-document' | 'endpoint' | 'executable';
/** Translator id == ExtractCall.host. Code translators reuse PluginLanguage values. */
export type TranslatorId = PluginLanguage | 'argv' | 'mcp' | 'openapi' | 'graphql' | 'jsonschema';
export type SourceLocator =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'command'; readonly command: string };
/** Pure data; never a URL or command inside Operation (see 3c). */
export type BindingSpec =
  | { readonly kind: 'in-process'; readonly runtime: 'ts' }
  | { readonly kind: 'local-host'; readonly runtime: PluginLanguage }
  | { readonly kind: 'process'; readonly command: string; readonly protocol: 'argv' | 'mcp-stdio' }
  | { readonly kind: 'remote'; readonly protocol: 'http' | 'mcp' | 'grpc'; readonly url: string }
  | { readonly kind: 'from-asset' };          // decided by the translator (OpenAPI servers, MCP URL)
export interface ISourceResolution {
  readonly reference: string;
  readonly locator: SourceLocator;
  readonly asset: AssetKind;
  /**
   * Absent only for an executable with no `protocol` option. The resolver is pure
   * and never sees the caller's verb, so the caller fills this in (3e).
   */
  readonly translator?: TranslatorId;
  readonly binding: BindingSpec;
  readonly options: Readonly<Record<string, string>>;  // per-source options (3e/§5); {} today
}
export type SourceResolutionError = {
  readonly code: 'unsupported' | 'not-found' | 'invalid-reference';
  readonly message: string;
};
export interface ISourceProbe {
  /** Path exists and is a regular file. */
  isFile(path: string): boolean;
  /** Path exists and carries an exec bit. */
  isExecutable(path: string): boolean;
}
export function resolveSourceReference(
  reference: string,
  probe?: ISourceProbe
): { ok: true; value: ISourceResolution } | { ok: false; error: SourceResolutionError };
```

**Rules.** Each row below is one unit test.

| Input | Result | Today |
|---|---|---|
| `x.ts` / `.tsx` / `.mts` / `.cts` | `code`, `ts`, `in-process ts` (no stat) | unchanged (`source-language.ts:29-32`) |
| `x.py` | `code`, `py`, `local-host py` | unchanged |
| `x.java` | `code`, `java`, `local-host java` | unchanged |
| `x.rs` / `x.go` | `code`, `rust` / `go`, `local-host` | unchanged mapping. Consumers still reject them for lack of an extractor or plugin. |
| `bin:<cmd>` | `executable`, `process`. The translator comes from the `protocol` option (`argv` or `mcp`). With no option it is left unset, and the caller supplies the default from its verb (3e). | same parse as `parse-source.ts:12-24` |
| `remote:<url>`, `http(s)://…` | `{ok:false, code:'unsupported'}` "remote sources are not implemented yet" | today `remote` throws in the resolver (`resolve-source.ts:50-51`) and is an unknown extension in apigen-cli |
| `.json` / `.yaml` / `.yml` / `.graphql` | `unsupported` "schema-document sources are not implemented yet" | today an unrecognised extension |
| any other path, with a probe, `isExecutable` | `executable`, `process`, translator unset (as for `bin:` with no option) | today an error |
| anything else | `invalid-reference`, listing the accepted forms | today an error (`serve.ts:216-221`) |

**Back-compat.**
- `EXTENSION_MAP` and `languageOfSource` stay exactly as they are. The resolver calls `languageOfSource` at its code-extension step; the dependency never runs the other way.
- Back-compat therefore holds by construction. `languageOfSource('https://x/a.ts')` still returns `'ts'`, because `languageOfSource` never consults the resolver's URL step.
- `pluginConsumesSource`/`sourcesForPlugin` stay as they are. They have no production caller (1.2).

**Tests:** extend `apigen-core-client/src/test/source-language.spec.ts` (default `test` lane). Add `source-reference.spec.ts` for the table above. Every row must fail if the order of the detection steps (§5.5) is changed.

### 3b. apigen-cli calls the resolver

| File | BEFORE | AFTER |
|---|---|---|
| `orchestrator.ts:177-194`, `:318` | `detectLang(file): 'ts'` throws for non-TS | `extractSource` calls `resolveSourceReference(entry.file)`. Translator `'ts'` keeps today's branch, byte-identical. Any other translator throws the same message `unsupported source extension "${ext}"`. `detectLang` stays exported as a thin wrapper, because `orchestrator.e2e.ts:91-102` imports it and matches `/unsupported source extension/` (rg hits). |
| `serve.ts:207-259` | `languageOfSource(source)`; `DEFAULT_PLUGIN_FOR_LANGUAGE[language]` | `const r = resolveSourceReference(source)`. Non-code assets and `!r.ok` throw `--source ${src}: ${message}`. `Host.language = r.value.translator`. The table is documented as "default projection+binding plugin per translator". The error text lists `.java`. |
| `run.ts:358-379` | The pipeline is chosen by `effectiveLanguage(plugin)` | Resolve the source first. If `r.value.translator !== effectiveLanguage(plugin)`, fail early: `--type ${id} hosts ${lang} sources; --source ${src} is ${translator}`. Today that case fails late, inside the plugin (`py-flask/plugin.ts:192-196`) or in `detectLang`. The pipeline choice itself is unchanged. |

- **Back-compat:** identical for every valid input. Only error timing and wording change, and only for inputs that already failed.
  - A URL-shaped `--source` (`https://x/a.ts`) is classified as a URL and reported as `unsupported`.
  - Today such a value goes through `path.resolve` into a nonexistent local path. In the TS path it then fails inside extraction or import.
  - So the change affects only an input that already failed downstream.
- **Blast radius:**
  - `resolveHosts` ← `startServe` (`serve.ts:1455`).
  - `detectLang` ← `extractSource` (`orchestrator.ts:318`).
  - `effectiveLanguage` ← `registerRunCommand` (`run.ts:358`).
  - All in apigen-cli.
- **Tests that must keep passing:**
  - Default lane (directory listing): `entrypoint/apigen-cli/src/test/{orchestrator,serve,run,generate}.spec.ts`.
  - **e2e lane, not run by `nx affected -t test`:** `orchestrator.e2e.ts` (`detectLang` at `:91-102`; `call.host` at `:858`) and `serve.e2e.ts` (`resolveHosts` at `:108-146`) (rg hits); also `run.e2e.ts` and `generate.e2e.ts`.
  - These must be run on demand: `npx nx affected -t e2e --parallel=1`.
- **Tests to add (default lane):** `run.spec.ts` gets the plugin/source mismatch case. `serve.spec.ts` gets the `.java` message and an `.rs` "no default plugin" message.

### 3c. IR: optional per-operation binding key

```ts
// descriptor.ts: AFTER (additive)
export interface Operation {
  /* ...unchanged... */
  /**
   * Producer tag: the translator that emitted this operation ('ts', 'python', 'java', 'argv', 'mcp').
   * Unchanged values for existing producers.
   */
  host: string;
  /**
   * Execution binding key: the HostAdapter that runs this operation.
   * Absent means `host` (today's behaviour).
   */
  binding?: string;
}
// gateway.ts:591: BEFORE  const host = req.operation.host;
//                 AFTER   const host = req.operation.binding ?? req.operation.host;
// gateway.ts:192-193, :319, :398: doc "keyed by operation.binding ?? operation.host"
// descriptor.schema.json: add `binding` {type:string, minLength:1} and the missing `hasCtx` {type:boolean}
```

- **Producer fixes in the same step.** These are value-level and have no type change:
  - `argv-operation.ts:43` becomes `host: 'argv'`, `binding: 'bin:<base>'`.
  - `mcp-source.ts:192` becomes `host: 'mcp'`, `binding: 'mcp:<name>'`.
  - No test pins `'ts'` for these: rg over `sources-*.spec.ts` for `host` returned only unrelated lines.
- **Back-compat:** additive. Every existing producer omits `binding`, so routing is unchanged. The `ExtractCall.host` values for TS are unchanged, so ir-cache keys are unchanged (`ir-cache-layer.ts:244`).
- **What this replaces:** BA-7. The Python `python`/`py` drift becomes harmless, because the binding key is assigned by the resolver (`local-host py` → key `py`), never by the extractor's string.
- **Blast radius:** `Operation` is consumed repo-wide, but the change only adds an optional member. Readers are listed in section 2.
- **Tests:** `apigen-engine-gateway/src/test/gateway.spec.ts` must stay green. Add one case: two ops with the same `host` and different `binding` route to two adapters, and an op without `binding` routes by `host`.
- **Sequenced later (D2):** extending the translator result from `Operation[]` (`extract-invoker.ts:79`) to `{operations, bindings}`, so a schema-document translator can emit its binding table. That is needed only by the remote extractor.

### 3d. Orchestration entry and extractor registry

One entry builds the `ExtractCall`, composes the `extractLayer` onion around a registry terminal keyed by `ExtractCall.host`, shares the `ExtractionSession`, merges sources and logs. Today that entry is `extractSource` in apigen-cli (`orchestrator.ts:311-360`, read), and it serves TS only. `entrypoint/backlog/src/extract-live.ts:217` (rg hit) also calls the onion path. The two-use rule (CLAUDE.md section 8) therefore makes `extractSource` a candidate to promote from apigen-cli into `apigen-core-client`. Placement is the owner's decision (O-9).

```ts
// orchestrator.ts:311-360: BEFORE
//   if (lang === 'ts') { ...extract()... }  throw 'host "${lang}" extractor not implemented'
// AFTER (one entry; location per O-9)
type Extractor = (call: ExtractCall) => Promise<Operation[]>;
const EXTRACTORS: Partial<Record<TranslatorId, Extractor>> = {
  ts: (call) => extract({ sourceFile: call.source, namespace: call.namespace, /* exactly as :330-340 */ }),
};
const extractor = EXTRACTORS[resolution.translator];
if (!extractor) throw new Error(`apigen-orchestrator: no ${resolution.translator} extractor is registered`);
const ops = await createExtractInvokerFromPlugins(usePluginObjects, extractor, extractLayerOptions)({
  source: entry.file, host: resolution.translator, namespace, extractorOptions: { tsconfig, session } });
```

- The registry **is** the `runExtractor` terminal that `extract-invoker.ts:118-133` describes ("run the real extractor for `call.host`"). It is not a new capability kind.
- Output for TS is identical for `generate`, `run` and `serve`. The `:858` `['ts','ts']` assertion in `orchestrator.e2e.ts` stays true.
- Registration is done by the Node-side wrapper of each host: `python-env` for Python (`python-env/src/lib/run-extractor.ts:42-82`; apigen-cli already depends on `@adhd/apigen-python-env`, `package.json:27`). Java has no Node-side wrapper package: `runExtractorEmitJsonJava` lives inside `java-javalin` `plugin.ts:88-110`. Its home is the owner's decision (O-12). This document does not recommend a package.
- Python through this entry (step 6) puts Python in `descriptor.operations`. `buildDescriptor` (`orchestrator.ts:435-610`) has three TS assumptions that the Python branch must handle:
  - `extractSource`'s TS branch resolves a tsconfig and a tsconfig-derived namespace (`:321-324`). A Python branch must take `entry.namespace` or a folder default instead.
  - The per-source `exportMode` filter classifies ops by TS path shape (`opMatchesExportMode`, applied at `:571`). It must be skipped for non-TS translators.
  - `packageSchemas[...].importPath` is the source file (`:559`). A target that **emits code importing `importPath`** would import a `.py` file. Only projections that read schemas or operations alone (`openapi`, `jsonschema`) can be claimed until each target is checked. The same translator/target compatibility guard as 3b's `run` check must reject the rest.
- `py-flask` and `py-grpc` consume `RunInput.operations` instead of calling `runExtractorEmitJson`. `RunInput.operations` already exists (BUG-APIGEN-024, per the comment in `apigen-plugin-api-fastify/src/lib/generate.ts`), and `PluginInput.operations?` is at `apigen-core-client/src/lib/types.ts:109`. The TS path fills it. The Python path does not, because extraction occurs inside the plugin (`run.ts:367-379` passes the raw path with empty schemas). No new `RunInput` field is needed. During the migration, the plugin uses the Descriptor when supplied and extracts as it does today otherwise. The phase-2 plan file is unchanged.
- The proof spawns Python, so its test is `*.e2e.ts` (adhd ADR-0009).
- **Tests:** `orchestrator.spec.ts` / `orchestrator.e2e.ts`.

### 3e. Gateway sources and adhd-policy on the same path

| File | Change | Moved, kept or deleted |
|---|---|---|
| `sources/parse-source.ts` | `parseSourceSpec(text)` maps `resolveSourceReference(text)` back to `SourceSpec` for back-compat, or is deleted once the two policy verbs call the resolver directly | Moved to core-client |
| `sources/resolve-source.ts:44-104` | Keyed by **translator**, not intent. `resolveSource(resolution, deps)` dispatches `'argv'` → argv and `'mcp'` → MCP. When `resolution.translator` is unset (an executable with no `protocol` option, 3a), `intent` fills it in: `run` → `argv`, `serve` → `mcp`. That is the only remaining use of `intent`, and it keeps D-07/D-08 behaviour unchanged. `file` returns typed `unsupported` with "use adhd-apigen" (`:52-53` today). | Kept, re-keyed |
| `sources/mcp-source.ts:151-231` | Extract the pure translator `operationsFromMcpTools(rawTools, name, onWarn) → {operations, skipped, hints, tools}`. `resolveMcpStdioSource` becomes locator (spawn) + `client` binding + a call to that translator. The remote MCP URL later reuses the translator unchanged. | Split, no deletion |
| `sources/argv-operation.ts` | `host`/`binding` values only (3c) | Kept |
| `sources/types.ts` | `IResolvedSource` gains `binding: BindingSpec`. `SourceIntent` stays until the decision on BA-6/E1-E2 (section 4). | Kept |
| `sources/mcp-passthrough-server.ts`, `stdio-host-transport.ts` | Unchanged. They are a projection; their fate is the E1/E2/E3 decision (section 4). | Kept |
| `entrypoint/policy/src/wrapper/verbs/run.ts:27-30` | `resolveSourceReference(positional, nodeSourceProbe)`. Require `asset === 'executable'`. Then `resolveSource(resolution, {...})`. | 3 to 6 lines |
| `entrypoint/policy/src/wrapper/verbs/serve.ts:32`, `:41-47` | Same. `serve api.ts` reports "file sources are served by adhd-apigen" from the resolver, not a gateway `SourceError('unsupported')`. | 3 to 6 lines |

- **How adhd-policy stops being the only entrance.**
  - After 3a, 3b and 3e there is one classifier for every `--source` string in the repo.
  - apigen-cli reports `bin:` as a known kind ("executable sources are served by adhd-policy run/serve; adhd-apigen support: step 10") instead of "unrecognised extension".
  - The entrance is fully shared once step 10 lands (apigen-cli's terminal binds `process` resolutions through the gateway).
- **Tests that must keep passing (directory listing):**
  - `apigen-engine-gateway/src/test/{sources-argv,sources-mcp-source,sources-parse-resolve,sources-passthrough,sources-process,sources-transports,gateway}.spec.ts`.
  - `entrypoint/policy/src/test/functional/{s3-run-bin,s7-serve,s8-serve-handshake-and-precedence,review-fixes-entrypoint}.spec.ts`.
- **Tests to add:**
  - An `operationsFromMcpTools` unit spec covering the skip rules (moved cases).
  - `serve` over a `.ts` positional giving the resolver's message.
  - A `resolveSource` keyed by an explicit `protocol` option.

### 3f. Sequenced after the orchestration entry (steps 10 and 11)

| # | Change | Why it is sequenced later | Files |
|---|---|---|---|
| D1 | **Binding-aware dispatch terminal.** An op whose binding is not `in-process` dispatches its argument object, plus `call.signal`, to the binding's `invoke`, instead of positional `fns`. | Today positional dispatch builds the argument list from `dataParamNames(schema)` (`dispatch.ts:127-132`), so undeclared keys are dropped. The terminal is hard-wired to `dispatch` with no signal (`invoke.ts:197-205`). Every foreign source through a standard host needs this. It is the model's answer to the flat-arguments reason TAXONOMY used mounts (section 4). It is the same item as review remediation #3's "`terminal` option to `createInvoker`" (`APIGEN-CONFORMANCE-REVIEW.md:463`). | `apigen-engine-runtime` `invoke.ts`, `package-invoker.ts`; hosts unchanged |
| D2 | `{operations, bindings}` translator result | Needed only by schema-document translators | `extract-invoker.ts:79` |
| D3 | URL locator: fetch, materialise to a content-addressed local file, classify, **re-delegate at the asset step** (§5.1) | The remote extractor | core-client resolver + a node fetcher in the gateway |
| D4 | MCP-over-HTTP binding (`HostAdapter`) and the OpenAPI/GraphQL/JSON Schema translators | The remote extractor | gateway |
| D5 | Wiring `bin:` and remote resolutions through `serve.ts` (whose `spawnHost` always spawns `adhd-apigen run`, `serve.ts:516-529`) | Needs D1 and a decision on F7, the two routers | apigen-cli |

**Rejected as not needed:**
- A `source` plugin capability (the parked Phase 4 source plugin, `transport-serve-core-refactor.md:217-225`). The extract onion already keys translators by `ExtractCall.host`, and `HostAdapter` already models bindings. The model is expressible without a new capability kind.
- A new package.
- Redefining `Operation.host` (BA-7). It loses producer identity, and fixing the vocabulary first would break `run_tests.py:587` and `gate.spec.ts:440`.

### 3g. Out of scope

- Remote fetching and trust.
- Inbound OpenAPI/GraphQL/JSON Schema translators.
- A help-text translator for executables (f6bf8550 item 3).
- The passthrough's verbatim-name and verbatim-result behaviours (TAXONOMY E1/E2/E3).
- Unifying `serve`'s front proxy with `createGateway` (TAXONOMY F7).
- Moving Java extraction out of `java-javalin` (step 8; gated on O-12).
- The per-source option grammar beyond the `options` slot (decision O-3).

---

## 4. Q4: reconciliation with the two plan documents

### 4.1 The central tension: mount operations versus extract-stage IR

TAXONOMY brings foreign upstream tools in as **mount** operations:
- `createUpstreamMountPlugin` → `mount.operations` (`TAXONOMY-CONFORMING-DESIGNS.md:175-190`, item 2; item 8 at `:366-393`; item 3 "Contribute a foreign upstream's operations → `mount`", `:228`).

Its reasons are real:
- Mount ops get flat `raw.args` and their own `inputSchema`.
- Package ops get a `{data}` wrapper and positional `fns` that drop undeclared keys (`:125-131`).
- The second part is confirmed at `dispatch.ts:127-132`.

The model puts foreign tools at the **extract** stage as IR. The two placements are opposite. Under the model:

| TAXONOMY / REVIEW element | Verdict under the model | Reason |
|---|---|---|
| `createUpstreamMountPlugin` (TAXONOMY items 2, 8) | **Contradicted; do not build** | Mount ops are produced at run time by a host (`plugin.ts:461-465`). They are invisible to `generate` and never pass through `extractLayer`/ir-cache. Their binding is an in-closure `handler`, not a routable key. The flat-arguments benefit is recovered by D1 instead. |
| `createMcpUpstreamAdapter` as a `HostAdapter` (TAXONOMY `:156-173`; REVIEW B5 `:175-176`, remediation #5) | **Subsumed** as the model's binding half | `HostAdapter` is the binding (3c) |
| Gateway as the single router (TAXONOMY item 8) | **Aligned** | Routed by `binding ?? host` |
| Startup-failure contract (TAXONOMY `:208-211`) | **Still needed** for any process binding | Unchanged |
| BA-7 (`host` may name a non-language runtime) | **Superseded** by `Operation.binding` (3c) | `host` keeps its producer meaning |
| TAXONOMY item 3 verdict: E5 "not needed", needs a "Phase 4 source plugin" (`:233`, `:442`) | **Contradicted** | Under the model `--source bin:` in adhd-apigen is the main path. It needs no source capability: a translator id at the existing terminal plus a binding (3d, D1). E5 is therefore not a taxonomy extension. |
| REVIEW B1 ("place source resolution at the EXTRACT stage", `APIGEN-CONFORMANCE-REVIEW.md:138-139`) and remediation #4 (`:464`) | **Aligned / subsumed** by 3a, 3b, 3d and step 7 | |
| REVIEW B2 (dead `remote`/`file` arms) | **Subsumed** | One typed `unsupported` in the resolver |
| REVIEW B3 (argv op hand-built, non-derived id, signal) | Translator/binding split: **already true** (`argv-operation.ts`). Derived id: **still needed** (orthogonal). Signal: **subsumed by D1**. | |
| REVIEW B4 (MCP ids with `.`, `safe` overwrite) | **Still needed** (orthogonal to the model) | |
| REVIEW B8 / TAXONOMY item 2 (passthrough) | The passthrough is a projection that bypasses the IR (`mcp-passthrough-server.ts:121`), which contradicts the model's "projections consume only IR". The verbatim behaviours remain owner decisions E1/E2/E3. | |
| REVIEW B9 / TAXONOMY item 7 B9 (`SourceError` → `ApiError`) | **Still needed** | The resolver returns a typed result, and the CLI edges map it to `ApiError` |
| REVIEW remediation #7 "use a non-`ts` host tag for foreign operations" (`:467`) | **Aligned** (3c producer fixes) | |
| REVIEW remediation #3 "`terminal` option to `createInvoker`" (`:463`) | **Same as D1** | |
| REVIEW E3 (D-20, `bin:` in the gateway: acceptable for the launcher/`HostAdapter` half only, `:352`) | **Aligned**: bindings stay in the gateway. Classification moves to core-client. | |
| REVIEW E5 (D-07/D-08 ids, `:354`) | **Still needed** (orthogonal) | |
| TAXONOMY items 1, 4, 5, 6 (policy Layer config, `run` on serve-core, CommonJS, `ctx` attributes) | **Unaffected** | |
| TAXONOMY E1 (MCP name override), E2 (raw result), E3 (tool metadata) | **Still needed** if verbatim N=1 wrapping is wanted. E3 becomes an IR question: `Operation` has no slot for MCP `title`/`annotations`. The MCP translator currently keeps them only in the side `hints`/`tools` maps (`mcp-source.ts:207-213`, `:189`). | |
| TAXONOMY E4, E6 | **Unaffected** | |
| TAXONOMY E5 | The model's main path, not a capability extension | |
| TAXONOMY E7 (per-host deadline) | Becomes per-binding; **still an extension** | |
| TAXONOMY E8 (dynamic tool list) | Equals f6bf8550 item 4 ("remote IR ... refreshed on change notification"); **still an extension** | |

### 4.2 Places where either document is wrong

1. **REVIEW §3 says per-language extractors provide the extract stage today.** The text is "an **extract-stage** producer of `Operation[]`, which per-language extractors provide today" (`APIGEN-CONFORMANCE-REVIEW.md:372`). Only the TS extractor sits at the extract stage. Python and Java run inside the target plugins' `run()` (1.3), and `generate --source x.py` throws (`orchestrator.ts:185-193`).
2. **Both documents treat a non-file source kind as needing the parked "Phase 4 source plugin"** (TAXONOMY `:442`; REVIEW B1 `:128`, `:138`). The extract onion is already host-neutral and keyed by `ExtractCall.host` (`extract-invoker.ts:15-23`, `:56`), and its terminal is documented as "run the real extractor for `call.host`" (`:118-123`). A translator registry is enough, with no capability kind.
3. **TAXONOMY §0 lists `--use` loading and capabilities as "the only building blocks"** (`:24-41`). It omits `ExtractCall`/`runExtractor`, which is the seam this model needs. Its item 3 table therefore has no row for "translate a foreign asset into IR".
4. **SPEC, cited by both as authority, is itself wrong in two places:**
   - "Layers/plugins are host-agnostic (the `Call` carries `operation.host`)" (`SPEC.md:535-536`). The runtime `Call` for package ops carries only `{ id }` (`dispatch-for-plan.ts:94`).
   - SPEC §4's `Operation` (`SPEC.md:104-118`) omits `hasCtx`, like `descriptor.schema.json`.
5. **TAXONOMY 0.1 item 6 and F7** are correct that `createGateway` has no production caller. Confirmed: rg finds it only in `gateway.spec.ts` and `gateway-mixed-host.e2e.ts`, and `gx impact` returns 0.

### 4.3 Remote and proxy under the model

- A remote MCP server, a remote OpenAPI service, or any other remote asset contributes in two parts: a protocol extractor that produces extract-stage IR, and a remote-client **binding** that executes the operations. It is not a mount upstream and not a framework.
- A "proxy" target is only the degenerate case where the source protocol equals the target protocol. `serveMcpPassthrough` is that case for MCP (section 4.1, B8 row).
- The MCP `tools/list` → `Operation` mapping is currently fused with the process and client in `resolveMcpStdioSource` (`mcp-source.ts:54-275`). Splitting it out is step 5 of the sequence (3e) and is the first piece of the protocol extractor.

---

## 5. Q5: hazards and the smallest safe rule for each

### 5.1 Recursion and cycles on re-delegation

**Hazard:** a fetched asset could resolve to another URL (a redirect, an index document, an OpenAPI `servers` entry, an MCP URL), which is fetched again, possibly forever.

**Rule:** a fetched asset re-enters resolution **only at the asset-kind step, never at the locator step**, and at depth 1.
- URLs found inside an asset (OpenAPI `servers`, an MCP endpoint) become **bindings**, never new sources.
- HTTP redirects are the fetcher's own concern, capped by a fixed count.

Cycles are impossible by construction, because the locator step runs once per user reference.

### 5.2 Trust of fetched assets

**Hazard:** a remote `.py` is a code asset whose default binding is a local Python host. The Python translator already **executes** the module at extraction time (`extractor.py:373-387`), so even translating a remote `.py` runs untrusted code. That is a stronger statement than "binding it later is unsafe".

**Rules:**
- A fetched **code** asset is unsupported unless an explicit per-source opt-in is given together with a pinned digest (`sha256`). The digest pin follows the anchor `{locator, digest}` pattern in adhd ADR-0007 (`docs/decisions/0007-backlog-target-public-interface.md:39`, rg hit).
- Schema documents are data and may be translated. Their derived remote binding is limited to the same origin as the fetched document unless overridden per source (anti-SSRF).
- Fetched bytes are materialised to a content-addressed local file before the extract onion, for two reasons:
  - ir-cache hashes `call.source` as a local file (`ir-cache-layer.ts:240`).
  - The digest becomes `ExtractCall.versionHint` (`extract-invoker.ts:66-72`).
- `serve` must resolve once, in the parent. Today it re-passes `--source <path>` to each child `run` (`serve.ts:516-529`). For a remote reference, that would let each child re-fetch and possibly translate a different asset than the parent (time-of-check/time-of-use). The child must receive the materialised path and digest instead.

### 5.3 Per-source option syntax collisions

**Hazard:** `?` and `#` are legal in URLs (query and fragment) and in POSIX file names. A single `:` occurs in URLs (scheme, port), in Windows drive letters (`C:\`) and in `bin:`. `::` occurs in IPv6 URL literals (`http://[::1]:8080/mcp`).

**Rule:**
- Options exist **only on the explicit scheme form**, with a closed scheme list: `<scheme>[k=v,…]:<ref>`. Examples: `bin[protocol=mcp,name=fs]:mcp-server-filesystem`, `file[namespace=api]:./x.ts`, later `remote[protocol=mcp]:https://h/mcp`.
- The reference after the first `:` that follows the closing bracket is taken verbatim, so URL and path characters are never parsed.
- A Windows path never matches, because a single drive letter is not in the closed scheme list.
- An unprefixed reference has no options.
- `./`, `../`, `/` and `~` force the filesystem locator.
- Values containing `,` or `]` are refused, not escaped (the smallest grammar).

This also replaces the policy wrapper's `--name` flag (`flags.ts:17`, `:66-68`) as a per-source option once the grammar is approved.

### 5.4 The bin-fallback mistyped-path footgun

**Hazard:** an "existing resolvable executable" fallback turns a typo into an execution. `api.tss` could match nothing and fall through; a bare `api` intended as `./api.ts` could run `/usr/bin/api`. In adhd-policy `run`, execution is immediate (`verbs/run.ts:57-75`).

**Rule:**
- PATH lookup is **never** applied to an unprefixed reference. `bin:` is the only way to name a PATH command.
- The unprefixed `executable` kind applies only to a reference that is an **existing path** (it contains a separator), carries an exec bit, and has **no** recognised code or schema extension.
- A path-like reference that does not exist is `not-found`, never `bin`.
- Code extensions are matched before the executable test, so an executable `./tool.py` with a shebang goes to the Python translator (f6bf8550 item 3's intent).

If the owner wants the bare-name PATH fallback anyway (decision O-2), restrict it to bare names with no `.` and no separator, and print the resolved absolute path on stderr before any spawn.

### 5.5 Detection order and precedence

1. A closed-list scheme prefix (explicit; options allowed).
2. `http://` / `https://` (URL locator; today `unsupported`).
3. A recognised code extension, with no stat: today's behaviour, unchanged. This step must come after the URL step, because `https://x/function.py` has a `.py` extension.
4. A recognised schema-document extension (today `unsupported`).
5. An existing path with an exec bit (with a probe) → executable.
6. Anything else → `invalid-reference` or `not-found`, with the accepted forms listed.

Each step is a pure function of the string plus the probe.

### 5.6 Extractor dependency declaration and ir-cache staleness

**Hazard:** the ir-cache layer records transitive local-import dependencies and their mtimes in its staleness snapshot (`ir-cache-layer.ts` header, lines 19-30; the `deps` field at lines 83-85 and the collection at lines 265-294 are rg hits only). `ExtractResult` is `Operation[]` (`extract-invoker.ts:79`), which carries no dependency list. A non-TS extractor placed behind the onion would therefore probably be cached on its entry file only, and a changed sibling module could serve stale IR. The collector function itself was not read: UNVERIFIED (finding F-11).

**Rule:** a non-TS extractor is not cacheable until it declares its dependencies to the onion (step 7). Python and Java are registered through the orchestration entry first and cached only after step 7. UNVERIFIED: whether ir-cache supports excluding one host in the interim.

### 5.7 The Python extractor executes the user module

**Hazard:** `extractor.py:373-387` imports and executes the user module (`spec_from_file_location`, then `spec.loader.exec_module(mod)`). Registering Python through the orchestration entry makes that execution reachable from `generate`, which a user may run on code they have not reviewed.

**Rule:** a guard is decided before Python is reachable from `generate` (decision O-13). §5.2 already refuses remote code assets without an opt-in and a pinned digest. The guard here covers local files.


---

## 6. Q6: is the model documented anywhere?

**No, not under these names.**
- `rg` for `locator|translator|execution binding|re-deleg|asset kind|source kind|source-plugin|source plugin` over `docs/apigen`, `docs/decisions` and `docs/plan/apigen-serve-core` matches only two things:
  - the parked Phase 4 proposal (`transport-serve-core-refactor.md:185`, `:219-225`);
  - an unrelated backlog anchor `{locator, digest}` (adhd ADR-0007).
- The closest existing statements:
  - SPEC's three stages and host contract (`SPEC.md:41-68`, `:521-569`);
  - the extract onion's host-neutral `ExtractCall` contract (`extract-invoker.ts:12-33`);
  - backlog f6bf8550 (items 2-4: `remote:` probes, extracts to IR and executes through a network invoker; `bin:` classifies and re-delegates to an existing extractor);
  - REVIEW §3's three-part source kind (`APIGEN-CONFORMANCE-REVIEW.md:371-374`, which lacks locator and asset).

**Where to record it** (not written here):
1. **A new adhd ADR** in `docs/decisions/`. It takes the next free number at authoring time, per the catalog rule at `docs/decisions/README.md` ("numbering is claimed at authoring time"), and is indexed there. It names the seven primitives, the vocabulary mapping of section 0.1, the four-group layout of section 0.3 and the decisions in section 9.
2. **`docs/apigen/SPEC.md`:**
   - §1 diagram: the EXTRACT box gains "reference → locator → asset → translator".
   - §4: `host` is the producer, and `binding` is added; `hasCtx` is added.
   - §13: run topologies are bindings.
   - §14: "Extractor" = translator, "Gateway adapter" = binding.
   - Correct the `Call carries operation.host` sentence.
3. `apigen-core-client/src/lib/descriptor.ts:164-169` and `descriptor.schema.json`.
4. `docs/apigen/proposals/transport-serve-core-refactor.md:217-225`: the Phase 4 verdict is superseded by the ADR (translator registry, not a source capability).

---

## 7. Findings: bugs and drift found while tracing

| ID | Finding | Evidence | Backlog |
|---|---|---|---|
| F-1 | `generate`/`run` through the orchestrator reject `.py`/`.java` although a Python and a Java translator exist. Python and Java IR cannot reach openapi, jsonschema, mcp or ts-types projections, or ir-cache. | `orchestrator.ts:185-193`, `:318-359`; `py-flask/plugin.ts:203-209`, `:374-377` | f7f25391 |
| F-2 | Host vocabulary drift: the Python extractor emits `host: "python"`, while `PluginLanguage` and `py-flask`'s own `Descriptor` say `'py'`. `createGateway` would mis-route Python ops. | `extractor.py:467`; `types.ts:122`; `py-flask/plugin.ts:234`; `gateway.ts:591` | 103b16f0 (relates 819100bd) |
| F-3 | Foreign ops claim `host: 'ts'` (argv, MCP) | `argv-operation.ts:43`; `mcp-source.ts:192` | c62f9b13 (citation added) |
| F-4 | `descriptor.schema.json` is `additionalProperties:false` yet lacks `hasCtx`, so it rejects real TS ops. Nothing loads it, so the drift is invisible. | `descriptor.schema.json:7-21`; `descriptor.ts:251` | c5cf9472 |
| F-5 | Three source detectors with three supported sets. `serve`'s error message omits `.java`; `.rs`/`.go` map to a language with no extractor and no default plugin. | `source-language.ts:27-41`; `orchestrator.ts:185-194`; `parse-source.ts:11-42`; `serve.ts:91-95`, `:216-221` | f168f4ef (relates f6bf8550) |
| F-6 | `apigen-core-client` is tagged `platform:shared` but imports `node:path`, `node:fs` and `node:module` | `project.json:15-18`; `source-language.ts:13`; `extraction-session.ts:38`; `esm-require.ts:30` (rg hit) | 5cbde2a7 (relates 25c1d7ef) |
| F-7 | SPEC says the `Call` carries `operation.host`; for package ops it carries `{id}` only | `SPEC.md:535-536`; `dispatch-for-plan.ts:94` | 15ec76ac |
| F-8 | Stale docs: `OutputPlugin.language` says "all first-party plugins declare `'ts'`"; `source-language.ts` says its helpers route serve's files, but `pluginConsumesSource`/`sourcesForPlugin` have no production caller | `types.ts:134-136`; `source-language.ts:2-8`, `:115-150` | 5ec6e8bf |
| F-9 | gitnexus index misses `resolveHosts`←`startServe`, `detectLang`←`extractSource`, `resolveMcpStdioSource`←`resolveSource` | `serve.ts:1455`; `orchestrator.ts:318`; `resolve-source.ts:57` | not filed (gitnexus index gap, not a repo defect) |
| F-10 | The gateway barrel's marker string names the package `@adhd/apigen-gateway`; the package is `@adhd/apigen-engine-gateway` | `apigen-engine-gateway/src/index.ts:1`; `package.json:2` | 2b7cd592 |
| F-11 | Extractor dependency declaration: ir-cache records transitive local-import dependencies and mtimes in its staleness snapshot, but `ExtractResult` is `Operation[]` and carries no dependency list, so a non-TS extractor behind the onion would probably be cached on its entry file only and a changed sibling module could serve stale IR. The collector function was not read: UNVERIFIED. | `ir-cache-layer.ts` header lines 19-30; `extract-invoker.ts:79`; `deps` field at `ir-cache-layer.ts:83-85` and collection at `:265-294` (rg hits) | Backlog: pending |

---

## 8. Change sequence around the orchestration entry

Each step can land and ship on its own. Gates per step:
- `npx nx affected -t lint,typecheck,typecheck-spec`
- `npx nx affected -t test`
- for steps that touch apigen-cli or spawn processes, `npx nx affected -t e2e --parallel=1` (the `resolveHosts`/`detectLang` tests live in the e2e lane).

Sizes are estimates, based on the measured files: `source-language.ts` 150 lines, `orchestrator.ts` 767, `serve.ts` 1681, `run.ts` 426, `resolve-source.ts` 104, `mcp-source.ts` 275, `gateway.ts` 658. Steps whose size is not estimated say so.

| # | Step | Depends on | Risk | Files touched | ≈ LOC |
|---|---|---|---|---|---|
| 0 | ADR + SPEC wording: the vocabulary mapping (0.1), the host (producer) / binding (key) split, `hasCtx`, and the `Call` sentence at `SPEC.md:535-536`. Needs owner approval before the ADR is written. | owner approval | none (docs) | ADR (new), `docs/decisions/README.md`, `SPEC.md`, `transport-serve-core-refactor.md` | 150 |
| 1 | `resolveSourceReference` + types in core-client. It calls the unchanged `languageOfSource` at its extension step. Pure, with the probe port. (3a) | 0 | LOW (additive; published export unchanged) | `source-language.ts`, `index.ts`, 2 specs | 180 src + 200 test |
| 2 | apigen-cli adopts it: `extractSource`, `resolveHosts`, an early plugin/source mismatch check in `run`. `detectLang` becomes a wrapper. (3b) | 1 | LOW (errors only) | `orchestrator.ts`, `serve.ts`, `run.ts`, 2 to 3 specs | 50 src + 80 test |
| 3 | Orchestration entry: promote `extractSource` into `apigen-core-client` as the single entry, driven by a registry keyed by `ExtractCall.host`. TS is registered first, with identical output for `generate`, `run` and `serve`. (3d; placement O-9) | 2 | LOW for the registry; the promotion depends on O-9 | `orchestrator.ts`, core-client, spec | registry restructure 30 src + 30 test; promotion size not estimated |
| 4 | Optional `Operation.binding` + `descriptor.schema.json` (`binding`, `hasCtx`); the gateway routes `binding ?? host`; argv/MCP producers get `host:'argv'|'mcp'` and their binding keys. (3c, O-1) | 1 | LOW (optional field; no reader changes meaning) | `descriptor.ts`, `descriptor.schema.json`, `gateway.ts`, `argv-operation.ts`, `mcp-source.ts`, `gateway.spec.ts` | 30 src + 50 test |
| 5 | Gateway + adhd-policy use the shared resolver: the verbs call it; `resolveSource` is keyed by translator (intent is only the default); `operationsFromMcpTools` is split out of `resolveMcpStdioSource`; the node probe is exported. (3e) | 1, 4 | MEDIUM (touches the D-07/D-08 paths; parity proven by `s3`/`s7`/`s8`) | `parse-source.ts`, `resolve-source.ts`, `mcp-source.ts`, `types.ts`, new `source-probe.ts`, `verbs/run.ts`, `verbs/serve.ts`, specs | 120 src + 120 test |
| 6 | Register Python through the orchestration entry, with the three `buildDescriptor` guards from 3d. `py-flask` and `py-grpc` consume `RunInput.operations` (Descriptor if supplied, else extract as today during the migration); the phase-2 plan file is unchanged. This makes `generate --source x.py --type openapi\|jsonschema` work. Other targets are rejected until each is checked. Decision O-13 precedes it. Proof in `*.e2e.ts`. | 3, O-13 | MEDIUM (spawns Python; end-to-end unverified) | `orchestrator.ts`, `generate.ts`, `py-flask/plugin.ts`, `py-grpc/plugin.ts`, an e2e spec | registration 80 src + 120 test; plugin changes not estimated |
| 7 | Extractor dependency declaration, so ir-cache staleness is correct for non-TS extractors. It lands before Python or Java are cached (5.6, F-11). | 3 | MEDIUM (cache correctness) | `extract-invoker.ts`, `ir-cache-layer.ts`, extractors | size not estimated |
| 8 | Register Java through the orchestration entry. The Node-side wrapper's home is decided first (O-12). | 3, 7, O-12 | MEDIUM | `java-javalin/plugin.ts` or the wrapper's home, `orchestrator.ts`, an e2e spec | size not estimated |
| 9 | Make the TS extractor drivable as a subprocess (SPEC §14) and use it on a cache miss for `run`/`serve` children, so the serving process never loads ts-morph (decision O-10). Call `ExtractionSession.dispose()` before serving if `run` does not (section 10). | 3 | MEDIUM | `extract.ts` entry, `run.ts`, `serve.ts` | size not estimated |
| 10 | Binding-aware dispatch (D1) and binding adapters for py/java under the B targets (section 12); `bin:` in adhd-apigen (argv translator + process binding). Decision O-14 precedes it. | 4, 6 or 8 | MEDIUM | `apigen-engine-runtime` `invoke.ts`/`package-invoker.ts`, `run.ts`, gateway, specs | D1 150 src + 150 test; adapters not estimated |
| 11 | Remote locator and transport, protocol extractors, remote-client binding, trust rules (D2, D3, D4; section 5). | 10 | HIGH | core-client, gateway, apigen-cli | 600+ |
| 12 | A shared extractor conformance suite in `apigen-engine-conformance`: golden, schema-valid operations per registered extractor. Added alongside each registration (steps 3, 6, 8). | 3 | LOW | `apigen-engine-conformance` | size not estimated |

The dependency order is 0 → 1 → (2, 4) → 3 (after 2; steps 2 and 3 share `orchestrator.ts`, so they land serially) → 5 (after 1 and 4) → 6 → 7 → 8 → 9 → 10 → 11. Step 12 accompanies every registration.

Small drift fixes (docs and typing only): the `types.ts:134-136` claim, the `serve` error text that omits `.java`, the SPEC §13 `Call` sentence, and `hasCtx` in `descriptor.schema.json`.

---

## 9. Open decisions for the owner

| ID | Decision | Recommendation |
|---|---|---|
| O-1 | Binding representation: an optional `Operation.binding` key (3c), or redefine `host` (BA-7) | `binding` key. It is additive, keeps producer identity, and neutralises the `python`/`py` drift. |
| O-2 | Unprefixed bare-name PATH fallback (the owner's "final fallback") | Off. `bin:` is required for PATH names; an unprefixed executable must be an existing path (§5.4). |
| O-3 | Per-source option grammar | `<scheme>[k=v,…]:<ref>`, prefixed forms only (§5.3) |
| O-4 | Mount-based upstream representation (TAXONOMY items 2/8) versus extract-stage IR plus a binding. Remote is a binding; a proxy target is the degenerate case where source protocol equals target protocol. | Extract-stage IR plus a binding. Do not build `createUpstreamMountPlugin`. |
| O-5 | Canonical Python host tag (`python` vs `py`) | Leave the producer tag `python` (two tests pin it). Key bindings by the resolver's `py`. |
| O-6 | Remote code assets | Unsupported unless an opt-in plus a pinned digest; the Python translator executes code (§5.2) |
| O-7 | Whether step 6 (Python through the orchestration entry) is in the first slice | Yes, after O-13. It is the cheapest proof that the registry generalises, and it closes F-1. |
| O-8 | Fate of `serveMcpPassthrough` | Decide E1/E2/E3 first. Under the model it is the degenerate proxy target (source protocol equals target protocol) and a projection, and it should consume IR, not raw upstream `Tool`s. |
| O-9 | Where the orchestration entry lives: `apigen-core-client` (the two-use rule, since `extract-live.ts:217` (rg hit) also calls the onion path) or stays in apigen-cli | Owner decision. The two-use rule favours `apigen-core-client`. |
| O-10 | Whether `run` extracts in a subprocess by default on a cache miss: a clean serving process versus one spawn per miss | Decide with the section 10 measurements, which do not exist yet. |
| O-11 | Live mount versus generate parity: keep two renderers over one `OpPlan`, or make `run` execute exactly what `generate` emits (section 11) | Decide with section 11's cost trade-off. No recommendation without a parity-failure history. |
| O-12 | Home of the Node-side wrapper for the Java host (new packages need owner approval) | Owner decision; no recommendation. |
| O-13 | Guard for the Python extractor, which executes the user module, before it is reachable from `generate` (5.7) | Owner decision; the guard must exist before step 6. |
| O-14 | Confirm that protocol targets are hosted once in TS with binding adapters (the SPEC §13 default) rather than re-implemented per language | Yes. Language-native frameworks stay in their own language and accept only same-language sources. |

---

## 10. Translation versus execution environment

Translation (turning source into IR) and execution (serving the operations) have different environments, and today they share a process only for TS.

- **TS is the one in-process translator.** `extract.ts:33` imports ts-morph only as types. ts-morph is loaded lazily with `lazyRequire` in `extraction-session.ts` (lines 44-56), `format-alias.ts` (31-39) and `extract-classes.ts` (30-49), deliberately because "a static import pulls the whole ts-morph".
- **The ir-cache layer sits above the terminal `runExtractor`.** On a HIT, "the real extractor is never invoked at all" (`apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts` header, lines 1-60).
- **`ExtractionSession` exposes `dispose()`** (`extraction-session.ts:27-32`, `81-89`, `329-341`).
- **Python and Java extractors are already subprocesses.** SPEC §1 and §14 already specify per-language extractors as subprocesses with JSON out ("drivable: apigen-<lang>-extractor <files> -> JSON").
- **What `dispose()` can and cannot free.** Node cannot unload a required module, so `dispose()` frees AST and program heap but not module code. Only not loading the translator (a cache hit, or prebuilt IR, which is what adhd-policy does; see `docs/plan/policy-core/MEASUREMENTS.md`) or a process boundary keeps the translator out of the serving process.

UNVERIFIED:
- whether `createExtractionSession` forces ts-morph to load;
- whether `run` calls `dispose()` before serving;
- any memory figures (none were measured).

Consequence for the sequence: step 9 makes the TS extractor drivable as a subprocess and uses it on a cache miss, and calls `dispose()` before serving if `run` does not. Whether subprocess extraction is the default is O-10.

---

## 11. `run` versus `generate`

- `run` in `api-fastify` (`run.ts:423-431`) and `mcp` (`run.ts:523-553`) uses `buildOpPlan` + `dispatchForPlan` directly (a live mount) and does **not** call `generate`.
- `api-fastify` `generate.ts:73` emits source that uses the same `buildOpPlan`, and its header comment says generated routes stay byte-identical to the OpenAPI document.
- What is shared is the resolved `OpPlan`. There are two renderers, live and emitted. Parity is tested, not guaranteed by construction. The repo's CLAUDE.md names a golden-parity gate (DEBT-PROCESS-DISPATCH-RESIDUE-001 mention); the gate itself was not opened.
- Python's plan file is the serialized form of the same plan (`flask_server.py` docstring, lines 8-40, and lines 858-871: the server "no longer self-extracts" and takes a plan whose `operations` are the extractor's Operation dicts, a two-phase extract/serve split). The Python host therefore already accepts a Descriptor. Whether `ApigenJavalinServer` accepts a plan the same way is UNVERIFIED.
- **Owner decision (O-11):** keep two renderers over one `OpPlan`, or make `run` execute exactly what `generate` emits. The second gives parity by construction. Its cost is a codegen step at startup and the loss of the zero-codegen live mount for dynamic hosts.

---

## 12. Compatibility matrix and unlock order

Target groups:
- **A, emitters:** openapi document, jsonschema, ts-types, docs, clients. IR in, files out, no runtime.
- **B, TS-hosted protocol targets:** cli, mcp, fastify, express.
- **C, language-native frameworks:** flask, grpc, javalin.

Plugin `language:` declarations (rg over `src/lib/plugin.ts`): `'ts'` for api-express, api-fastify, batch, cli-output, health, jsonschema, logger, mcp, openapi, tracing, ts-types; `'py'` for py-flask and py-grpc; `'java'` for java-javalin. `generate` returns no files for py-flask (`plugin.ts:374-377`), py-grpc and java-javalin (`plugin.ts:632`, rg hit). jsonschema and ts-types are generate-only.

| Source | A emitters | B cli / mcp / api | C native frameworks |
|---|---|---|---|
| ts | works | works (in-process) | n/a |
| py | fails today (`detectLang` throws); unlocked by the extractor registry plus the orchestration entry | fails; needs a binding adapter (`createGateway`, `HostAdapter` and `gateway_adapter.py` exist; `createGateway` has no production caller) | works (flask, grpc) |
| java | same as py | same as py | works (javalin) |
| rs / go | no extractor | no | no extractor, no runtime |
| bin | no in apigen (adhd-policy has a bespoke path) | adhd-policy only | n/a |
| remote MCP / OpenAPI | no extractor, no transport | no remote binding | n/a |

Unlock order:
1. Extractor registry + orchestration entry (steps 3, 6, 8). This opens column A for py and java, and makes them cacheable once dependency declaration exists (step 7).
2. Binding adapters for column B, for py and java (step 10).
3. `bin` as a source: `buildArgvOperation`, `createArgvInvoker` and `process.ts` exist in the gateway sources (step 10).
4. Remote: transport, a protocol extractor (the MCP `tools/list` mapping is currently fused in the gateway), and a remote-client binding (step 11).
5. rs / go: an extractor plus a runtime (no step assigned; size not estimated).
