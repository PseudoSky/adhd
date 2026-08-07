# Agent Package Feature Inventory — 2026-07-17T18:15:08Z

Full raw inventory of every feature across all packages/agent/*. Each entry lists
the exact file path and line numbers where the feature was found. No commentary,
no recommendations — raw facts only.

---

## 1. Error Taxonomy

### 1.1 Canonical Error Codes (AgentMcpErrorCode)

Source: `packages/agent/agent-base-types/src/errors.ts`

| lines | Code |
|-------|------|
| 2 | `AGENT_NOT_FOUND` |
| 3 | `AGENT_ALREADY_EXISTS` |
| 4 | `AGENT_HAS_ACTIVE_SESSIONS` |
| 5 | `SESSION_NOT_FOUND` |
| 6 | `SESSION_CLOSED` |
| 7 | `TASK_NOT_FOUND` |
| 8 | `TASK_NOT_CANCELLABLE` |
| 9 | `TASK_NOT_RESUMABLE` |
| 10 | `DELEGATION_NOT_ALLOWED` |
| 11 | `MAX_DEPTH_EXCEEDED` |
| 12 | `MAX_TOOL_LOOPS_EXCEEDED` |
| 13 | `PROVIDER_ERROR` |
| 14 | `MCP_CLIENT_ERROR` |
| 15 | `VALIDATION_ERROR` |
| 16 | `CONTEXT_WINDOW_EXCEEDED` |
| 17 | `PROVIDER_TIMEOUT` |
| 18 | `PROVIDER_AUTH_ERROR` |
| 19 | `PROVIDER_RATE_LIMITED` |
| 20 | `BUDGET_EXCEEDED` |
| 21 | `COMPOSED_PROMPT_NOT_FOUND` |

### 1.2 ToolError class

- `packages/agent/agent-engine-orchestrator/src/validation/errors.ts` lines 30-40 — ToolError with code + data fields
- `packages/agent/agent-store-runtime/src/validation/errors.ts` lines 5-15 — Duplicate ToolError (same shape)

### 1.3 Zod errorCodeSchema

- `packages/agent/agent-engine-orchestrator/src/validation/errors.ts` lines 3-24 — errorCodeSchema enum validation

### 1.4 Per-store error codes

| lines | File | Error Class | Codes |
|-------|------|-------------|-------|
| 12-18 | `agent-store-prompts/src/store/component-store.ts` | ComponentError | `COMPONENT_NOT_FOUND`, `COMPONENT_TYPE_NOT_FOUND`, `COMPONENT_VERSION_NOT_FOUND` |
| 16-27 | `agent-store-prompts/src/store/composition-store.ts` | CompositionError | `AGENT_NOT_FOUND`, `COMPONENT_VERSION_NOT_FOUND`, `REQUIRED_COMPONENT_EXCLUDED` |
| 11-19 | `agent-store-prompts/src/store/agent-store.ts` | AgentError | `AGENT_NOT_FOUND`, `CATEGORY_NOT_FOUND` |
| 15-23 | `agent-store-prompts/src/store/usecase-store.ts` | UseCaseError | `USE_CASE_NOT_FOUND`, `USE_CASE_ALREADY_EXISTS` |
| 52-55 | `agent-store-prompts/src/store/composed-prompt-store.ts` | ComposedPromptError | `NOT_FOUND` |
| 12-14 | `agent-core-policy/src/store/policy-template-store.ts` | PolicyError | `POLICY_TEMPLATE_NOT_FOUND`, `POLICY_TEMPLATE_ALREADY_EXISTS` |
| 17-20 | `agent-core-policy/src/store/agent-policy-store.ts` | AgentPolicyError | `AGENT_POLICY_ALREADY_ATTACHED`, `CATEGORY_POLICY_ALREADY_ATTACHED`, `AGENT_CATEGORY_ALREADY_JOINED` |
| 46-49 | `agent-core-provider/src/store/tool-format-store.ts` | ToolFormatStoreError | `TOOL_FORMAT_ALREADY_EXISTS`, `TOOL_FORMAT_NOT_FOUND` |
| 32-34 | `agent-core-provider/src/store/provider-store.ts` | ProviderStoreError | `PROVIDER_ALREADY_EXISTS`, `PROVIDER_NOT_FOUND` |
| 52-55 | `agent-core-provider/src/store/model-store.ts` | ModelStoreError | `MODEL_ALREADY_EXISTS`, `MODEL_NOT_FOUND`, `MODEL_BINDING_NOT_FOUND` |
| 46-49 | `agent-store-tools/src/store/tool-store.ts` | ToolStoreError | `TOOL_ALREADY_EXISTS`, `TOOL_NOT_FOUND`, `TOOL_TYPE_NOT_FOUND` |
| 56-59 | `agent-store-tools/src/store/binding-store.ts` | BindingStoreError | `BINDING_NOT_FOUND`, `PLATFORM_NOT_FOUND`, `BINDING_ALREADY_EXISTS` |
| 40-42 | `agent-store-tools/src/store/mcp-server-store.ts` | McpServerStoreError | `MCP_SERVER_ALREADY_EXISTS`, `MCP_SERVER_NOT_FOUND` |
| 74-77 | `agent-store-tools/src/store/agent-tool-store.ts` | AgentToolStoreError | `GRANT_ALREADY_EXISTS`, `GRANT_NOT_FOUND` |

### 1.5 UnsupportedNativeToolError

- `packages/agent/agent-core-provider/src/runtime/emit-tools.ts` lines 38-54 — `UnsupportedNativeToolError` with code `UNSUPPORTED_NATIVE_TOOL`

---

## 2. Streaming Contracts

### 2.1 StreamChunk discriminated union

- `packages/agent/agent-base-types/src/domain.ts` lines 341-343 — `{ type: 'text'; text: string } | { type: 'tool_call'; id: string; name: string; arguments: string }`

### 2.2 ProviderAdapter interface

- `packages/agent/agent-base-types/src/domain.ts` lines 353-359 — `stream(messages, tools, model): AsyncIterable<StreamChunk>`

### 2.3 ProviderAdapterImpl

- `packages/agent/agent-core-provider/src/adapter/provider-adapter.ts` lines 22-54 — Implements `ProviderAdapter` from base-types; resolves model via ModelStore, yields single text chunk

### 2.4 LLMProvider.chat (non-streaming)

- `packages/agent/agent-engine-orchestrator/src/providers/types.ts` lines 5-21 — `ProviderChatRequest` + `ProviderChatResponse` + `LLMProvider` interface
- `packages/agent/agent-engine-orchestrator/src/providers/types.ts` lines 23-25 — `chat(request: ProviderChatRequest): Promise<ProviderChatResponse>`

### 2.5 SSE streaming URL

- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 303-307 — `stream_url` from `sseBaseUrl/tasks/{taskId}/stream`

---

## 3. Task / DAG Lifecycle

### 3.1 7 task statuses

- `packages/agent/agent-base-types/src/domain.ts` lines 40-47 — `'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting' | 'awaiting_input'`
- `packages/agent/agent-store-runtime/src/validation/schemas.ts` lines 66-74 — Zod enum for task status
- `packages/agent/agent-store-runtime/src/db/schema.ts` lines 55-57 — `tasksTable.status` column enum

### 3.2 6 task event types

- `packages/agent/agent-base-types/src/domain.ts` lines 48-55 — `'MODEL_REQUEST' | 'MODEL_RESPONSE' | 'TOOL_CALL' | 'TOOL_RESULT' | 'TASK_COMPLETED' | 'TASK_FAILED' | 'TASK_CANCELLED'`
- `packages/agent/agent-engine-orchestrator/src/validation/task.ts` lines 39-47 — Zod enum

### 3.3 Task interface

- `packages/agent/agent-base-types/src/domain.ts` lines 57-79 — Full Task shape with all fields

### 3.4 DagEngine

- `packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts` lines 9-27 — `DagTaskStore` interface
- `packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts` lines 29-33 — `DagQueue` interface
- `packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts` lines 35-163 — `DagEngine` class
- `packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts` lines 48-79 — `validateNoCycle()` — BFS traversal checking for cycles
- `packages/agent/agent-engine-orchestrator/src/engine/dag-engine.ts` lines 81-163 — `dispatchReady()` — Optimistic lock, `onUpstreamFailure: 'fail' | 'skip'`, upstream input passing

### 3.5 BackgroundQueue

- `packages/agent/agent-engine-orchestrator/src/engine/queue.ts` lines 1-39 — `BackgroundQueue` wrapping p-queue with configurable concurrency

### 3.6 HITL resume

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 30-48 — HITL builtin tool definition
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 63-71 — `resolveHitl()` — resolves HITL promise by taskId
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 486-533 — HITL flow: resumeToken, await_input, status change, task events
- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 485-515 — `taskResume()` — validates resumeToken match, calls resolveHitl

### 3.7 Cancellation

- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 463-483 — `taskCancel()` — checks cancellableStatuses, calls taskStore.cancel
- `packages/agent/agent-store-runtime/src/store/task-store.ts` lines 196-221 — `registerCancellation`/`unregisterCancellation`/`cancel` — AbortController map

### 3.8 TaskStore

- `packages/agent/agent-store-runtime/src/store/task-store.ts` lines 13-222 — Full TaskStore: create, updateStatus, read, list, appendEvent, cancellation

### 3.9 enqueueExistingTask

- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 347-454 — Re-dispatches persisted tasks on server restart; ephemeral tasks fail with "context lost"

### 3.10 Session vs Ephemeral mode

- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 70-180 — `runEphemeralTask` — no DB rows, no session store, no HITL
- `packages/agent/agent-engine-orchestrator/src/tools/task.ts` lines 182-345 — `taskTool()` — full session-backed flow with background/stream modes

---

## 4. Plugin Hook Lifecycle

### 4.1 13 Hook events

- `packages/agent/agent-base-types/src/hooks.ts` lines 63-84 — `HookEventMap`:
  - `task:start` (line 64)
  - `pre:model_request` (line 65)
  - `post:model_response` (line 66)
  - `pre:tool_call` (line 67)
  - `post:tool_call` (line 68)
  - `transform:tool_result` (line 77)
  - `message:appended` (line 78)
  - `task:completed` (line 79)
  - `task:failed` (line 80)
  - `task:cancelled` (line 81)
  - `session:created` (line 82)
  - `agent:mutated` (line 83)

### 4.2 Hook payload types

- `packages/agent/agent-base-types/src/hooks.ts` lines 10-14 — `TaskStartPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 15-19 — `PreModelRequestPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 20-25 — `PostModelResponsePayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 26-31 — `PreToolCallPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 32-39 — `PostToolCallPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 40-43 — `MessageAppendedPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 44-47 — `TaskCompletedPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 48-51 — `TaskFailedPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 52-54 — `TaskCancelledPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 55-57 — `SessionCreatedPayload`
- `packages/agent/agent-base-types/src/hooks.ts` lines 58-61 — `AgentMutatedPayload`

### 4.3 Observational vs Enforcement

- `packages/agent/agent-base-types/src/hooks.ts` lines 91-118 — `IEnforcementError` marker interface (line 98-102), `IToolWarning` marker (lines 113-118)
- `packages/agent/agent-base-types/src/hooks.ts` lines 120-125 — Enforcement events: only `pre:model_request` and `pre:tool_call`
- `packages/agent/agent-base-types/src/hooks.ts` lines 127-144 — `IHookRegistry`: register(), emit(), registerEnforcement(), enforce()

### 4.4 HookRegistry implementation

- `packages/agent/agent-base-types/src/registry.ts` lines 23-80 — HookRegistry with Map<HookEvent, handlers[]> + Map<EnforcementEvent, handlers[]>
- `packages/agent/agent-base-types/src/registry.ts` lines 30-34 — `register()` — pushes handler
- `packages/agent/agent-base-types/src/registry.ts` lines 36-54 — `emit()` — observational, catches + console.warn errors
- `packages/agent/agent-base-types/src/registry.ts` lines 56-63 — `registerEnforcement()`
- `packages/agent/agent-base-types/src/registry.ts` lines 70-79 — `enforce()` — runs serially, throws propagate

### 4.5 Plugin interface + PluginFactory

- `packages/agent/agent-base-types/src/hooks.ts` lines 146-149 — `Plugin`: name + install(hooks)
- `packages/agent/agent-base-types/src/hooks.ts` lines 151-165 — `PluginContext`: db + config
- `packages/agent/agent-base-types/src/hooks.ts` lines 167-183 — `PluginFactory`: (ctx: PluginContext) => Plugin
- `packages/agent/agent-base-types/src/hooks.ts` lines 167-183 — configSchema pattern (zod)

### 4.6 3-phase tool execution

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 472-578 — Phase 1: serial pre-dispatch (HITL + hooks + enforcement + policy)
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 580-702 — Phase 2: Promise.all concurrent execution with delegation tracking
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 704-764 — Phase 3: serial result append with transform:tool_result

### 4.7 External plugin loader

- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 1-281 — Full external plugin loading pipeline
- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 56-94 — `findConfigFile()` — searches multiple paths
- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 102-136 — `loadConfigFile()` — JSON parse + zod validation
- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 140-164 — `resolveSpecifier()` — absolute/relative/npm resolve
- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 168-247 — `loadOnePlugin()` — import, validate config, call factory, install
- `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts` lines 260-281 — `loadExternalPlugins()` — orchestrates all

---

## 5. Agent Compilation Pipeline

### 5.1 compileAgent

- `packages/agent/agent-engine-compiler/src/compile.ts` lines 59-69 — `CompileInput`: agentSlug, platform, context, db
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 72-94 — `CompiledAgent`: id, content, tools, componentVersions
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 175-396 — `compileAgent()` — orchestrates all layers

### 5.2 4 resolve layers

- `packages/agent/agent-engine-compiler/src/compile.ts` lines 178-182 — Layer 1: agent metadata via AgentStore
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 186-196 — Layer 2: body sections + component versions via CompositionStore
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 263-266 — Layer 3: tools via resolveTools
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 268-269 — Layer 4: model via resolveModel
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 271-273 — Layer 5: policy constraints via resolvePolicyConstraints

### 5.3 3 emit formats

- `packages/agent/agent-engine-compiler/src/compile.ts` lines 275-298 — `yaml_frontmatter` dispatch (claude_code)
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 301-368 — `json_object` dispatch (claude_api/openai/bedrock)
- `packages/agent/agent-engine-compiler/src/compile.ts` lines 371-395 — `none` format (cursor/vscode)
- `packages/agent/agent-engine-compiler/src/emit/markdown.ts` lines 73-123 — `emitYamlFrontmatter()` — name, description, tools, model, body, policies
- `packages/agent/agent-engine-compiler/src/emit/json.ts` lines 84-123 — `emitJsonObject()` — { name, systemPrompt, model, tools }

### 5.4 Context condition evaluator

- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 72-98 — `evaluateCondition()` — every JSON predicate key must match ctx

### 5.5 Component head/version split

- `packages/agent/agent-store-prompts/src/db/schema.ts` lines 61-76 — `componentsTable` (identity head: slug PK)
- `packages/agent/agent-store-prompts/src/db/schema.ts` lines 96-114 — `componentVersionsTable` (history: version_id surrogate PK, slug+version unique)
- `packages/agent/agent-store-prompts/src/store/component-store.ts` lines 84-454 — ComponentStore: create (atomic head+v1), read, readVersion, version (bump), list

### 5.6 Version pinning

- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 133-161 — `attach()` with versionPin (version_id) or pinVersion (human number)
- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 169-189 — `resolvePinVersionId()`
- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 316-376 — `_resolveComponentVersion()` — null pin → latest, int pin → exact version

### 5.7 Resolve layers (individual)

- `packages/agent/agent-engine-compiler/src/resolve/composition.ts` lines 53-75 — `resolveBody()` — delegates to CompositionStore
- `packages/agent/agent-engine-compiler/src/resolve/tools.ts` lines 64-118 — `resolveTools()` — AgentToolStore + BindingStore
- `packages/agent/agent-engine-compiler/src/resolve/model.ts` lines 44-79 — `resolveModel()` — ModelStore.resolveModelId with canonical fallback
- `packages/agent/agent-engine-compiler/src/resolve/policy.ts` lines 57-88 — `resolvePolicyConstraints()` — AgentPolicyStore + PolicyTemplateStore

### 5.8 Context rules (additive)

- `packages/agent/agent-store-prompts/src/db/schema.ts` lines 261-284 — `contextRulesTable`: agentSlug, condition, componentSlug, position
- `packages/agent/agent-store-prompts/src/store/usecase-store.ts` lines 193-237 — `addContextRule()` / `contextRulesFor()`

### 5.9 Fixture seeder

- `packages/agent/agent-engine-compiler/src/seed/fixtures.ts` lines 38-174 — `seedFixtureAgent()` + constant export for e2e tests

---

## 6. Composed Prompt Cache

### 6.1 SHA-256 context hash

- `packages/agent/agent-store-prompts/src/store/composed-prompt-store.ts` lines 37-46 — `contextHash()` — sorted-key JSON canonicalization → SHA-256 hex
- `packages/agent/agent-engine-compiler/src/cache/composed-prompt-cache.ts` lines 62-83 — `computeContextHash()` — 3-part hash (context part + componentVersions + platform)

### 6.2 3-part cache key

- `packages/agent/agent-engine-compiler/src/cache/composed-prompt-cache.ts` lines 62-83 — Algorithm per Decision D: SHA-256(contextHash + " " + sortedJSON(componentVersions) + " " + platform)

### 6.3 Cache bypass

- `packages/agent/agent-engine-compiler/src/compile.ts` lines 198-262 — Cache HIT: return persisted {id, content} WITHOUT re-running resolve layers

### 6.4 ComposedPrompt types

- `packages/agent/agent-base-types/src/domain.ts` lines 286-301 — `ComposedPrompt`: id, agentSlug, contextHash, content, componentVersions, createdAt
- `packages/agent/agent-store-prompts/src/store/composed-prompt-store.ts` lines 64-81 — ComposedPromptWriteInput

### 6.5 Cache store operations

- `packages/agent/agent-engine-compiler/src/cache/composed-prompt-cache.ts` lines 107-118 — `lookup()` by (agentSlug, platform, context, componentVersions)
- `packages/agent/agent-engine-compiler/src/cache/composed-prompt-cache.ts` lines 135-152 — `write()` — inserts new row on MISS
- `packages/agent/agent-store-prompts/src/store/composed-prompt-store.ts` lines 96-205 — ComposedPromptStore: write(), lookup(), read()

### 6.6 Cache table schema

- `packages/agent/agent-store-prompts/src/db/schema.ts` lines 306-328 — `composedPromptsTable`: id (autoIncrement PK), agentSlug, contextHash, content, componentVersions, createdAt

---

## 7. Context Window Management

### 7.1 Cache-preserving strategy

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 5-21 — Strategy doc: append-only growth, compact only when REAL context nears TRUE window
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 208-270 — Implementation in orchestrator loop

### 7.2 contextWindowFor

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 31-46 — CONTEXT_WINDOWS lookup table (12 model families)
- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 48-60 — `contextWindowFor(model)` — longest-prefix match, fallback 128K

### 7.3 decideCompaction

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 105-134 — `decideCompaction()` — uses provider-reported inputTokens, trigger at 75% of true window

### 7.4 compactMessages

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 136-196 — `compactMessages()` — preserve system head, keep N recent units (default 4), summarise middle via injected callback

### 7.5 groupIntoAtomicUnits

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 86-103 — `groupIntoAtomicUnits()` — assistant+tool pairs as one indivisible unit

### 7.6 estimateMessageTokens

- `packages/agent/agent-engine-orchestrator/src/engine/context-window.ts` lines 67-76 — `estimateMessageTokens()` — ~4 chars/token over full wire form (content + toolCalls + toolResults)

### 7.7 windowMessages

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 901-919 — Hard token-limit cap, contiguous drop from oldest, always preserve system message

### 7.8 flattenForSummary

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 892-899 — Flattens messages to plain text for summariser

---

## 8. Tool Advertisement Modes

### 8.1 ToolAdvertisementMode

- `packages/agent/agent-engine-orchestrator/src/engine/tool-advertisement.ts` line 3 — `'names' | 'full'`
- `packages/agent/agent-base-types/src/domain.ts` lines 278 — `toolAdvertisement` field on AgentDefinition

### 8.2 toNameOnlyTools

- `packages/agent/agent-engine-orchestrator/src/engine/tool-advertisement.ts` lines 85-95 — Strips schema to `{ type: 'object', properties: {}, additionalProperties: true }`, truncates description to 140 chars

### 8.3 renderToolPromptDoc

- `packages/agent/agent-engine-orchestrator/src/engine/tool-advertisement.ts` lines 41-83 — Full markdown doc with sorted tools, parameter schemas, types, required flags

### 8.4 First-line description truncation

- `packages/agent/agent-engine-orchestrator/src/engine/tool-advertisement.ts` lines 16-25 — `firstLine()` truncates at 140 chars
- `packages/agent/agent-engine-orchestrator/src/engine/tool-advertisement.ts` lines 27-39 — `describeType()` renders JSON schema type/array/enum

### 8.5 Orhestration wiring

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 169-192 — 'names' mode prepends tool doc as system message; 'full' passes JSON schemas

---

## 9. MCP Transport Details

### 9.1 4 transport types

- `packages/agent/agent-base-types/src/domain.ts` lines 214-233 — Transport config discriminated union:
  - `stdio`: command + args + env + timeoutMs (lines 215-221)
  - `http`: url + headers + timeoutMs (lines 222-227)
  - `sse`: url + headers + timeoutMs (lines 228-233)
- `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts` lines 1-128 — `StdioMcpClient`: subprocess via MCP SDK StdioClientTransport, SIGTERM → SIGKILL after 5s (lines 109-127)
- `packages/agent/agent-engine-orchestrator/src/clients/http-client.ts` lines 10-63 — `BaseHttpMcpClient` abstract
- `packages/agent/agent-engine-orchestrator/src/clients/http-client.ts` lines 65-92 — `HttpMcpClient`: StreamableHTTPClientTransport
- `packages/agent/agent-engine-orchestrator/src/clients/http-client.ts` lines 94-128 — `SseMcpClient`: SSEClientTransport
- `packages/agent/agent-engine-orchestrator/src/clients/in-process.ts` lines 1-40 — `InProcessMcpClient`: direct handler call, zero network

### 9.2 Transport config validation

- `packages/agent/agent-engine-orchestrator/src/validation/mcp.ts` lines 14-20 — mcstdio zod schema
- `packages/agent/agent-engine-orchestrator/src/validation/mcp.ts` lines 22-27 — mcpHttp config zod schema
- `packages/agent/agent-engine-orchestrator/src/validation/mcp.ts` lines 29-34 — mcpSse config zod schema
- `packages/agent/agent-engine-orchestrator/src/validation/mcp.ts` lines 36-40 — `mcpServerConfigSchema` discriminated union

### 9.3 Per-server tool filters

- `packages/agent/agent-base-types/src/domain.ts` lines 235-240 — `McpServerConfig`: allowedTools[], disallowedTools[]

### 9.4 Client registry

- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 11-197 — `McpClientRegistry`: lazy connection, dedup via connectPromises Map
- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 48-117 — `getOrCreateClient()` — dedup, connect-retry eviction on failure (lines 100-106)
- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 138-165 — `listAllTools()` — iterates servers, collects tools with hiding

### 9.5 Self-referential guard

- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 28-40 — `isSelfReferential()` — detects `agent-mcp` name or matching URL → InProcessMcpClient

### 9.6 Claude CLI MCP config mapping

- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 48-61 — Claude MCP entry types
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 203-231 — `writeMcpConfigFile()` — converts to Claude-desktop JSON, temp file, `--mcp-config`

### 9.7 IMcpClient interface

- `packages/agent/agent-engine-orchestrator/src/clients/types.ts` lines 3-7 — `listTools()`, `callTool()`, `close()`

---

## 10. Tool Naming (server__tool)

### 10.1 Separator

- `packages/agent/agent-engine-orchestrator/src/clients/tool-naming.ts` line 1 — `TOOL_NAME_SEPARATOR = "__"`

### 10.2 normalizeToolName

- `packages/agent/agent-engine-orchestrator/src/clients/tool-naming.ts` lines 3-5 — `/[^A-Za-z0-9_]/g → _`

### 10.3 resolveToolCallName

- `packages/agent/agent-engine-orchestrator/src/clients/tool-naming.ts` lines 19-35 — If contains `__` → split; else normalize and match against advertised list; ambiguous tool name error if 2+ servers match

### 10.4 resolveToolName (registry-side)

- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 167-179 — Map lookup by raw + normalized; fallback to split on `__`

### 10.5 splitToolName

- `packages/agent/agent-engine-orchestrator/src/clients/tool-naming.ts` lines 12-17 — Split on `__` indexOf

### 10.6 ResolvedToolName

- `packages/agent/agent-engine-orchestrator/src/clients/tool-naming.ts` lines 7-10 — `{ server: string; tool: string }`

---

## 11. Allow / Deny Lists

### 11.1 MCP server tool filters

- `packages/agent/agent-base-types/src/domain.ts` lines 235-240 — allowedTools[] + disallowedTools[] per server
- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 123-129 — `isToolHidden()` — allowedTools acts as exclusive allowlist when set; disallowedTools also checked
- `packages/agent/agent-engine-orchestrator/src/clients/registry.ts` lines 131-136 — `assertToolAllowed()` — throws at tool call time

### 11.2 Agent delegation allowlist

- `packages/agent/agent-base-types/src/domain.ts` lines 242-244 — `AgentPermissions.allowedAgents[]`

### 11.3 Policy engine delegation check

- `packages/agent/agent-engine-orchestrator/src/engine/policy.ts` lines 90-111 — agent-specific → template allowlist → server-wide; throws `DELEGATION_NOT_ALLOWED`

### 11.4 Tool grant permission levels

- `packages/agent/agent-store-tools/src/store/agent-tool-store.ts` lines 11-17 — `PermissionLevel`: `'full' | 'read_only' | 'restricted'`
- `packages/agent/agent-store-tools/src/store/agent-tool-store.ts` lines 68 — `DEFAULT_PERMISSION_LEVEL = 'full'`

### 11.5 Tool platform binding availability

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 33-39 — `ToolPlatformBinding.availability`: `'available' | 'restricted' | 'unavailable' | 'requires_permission'`

### 11.6 Claude CLI builtin tool filter

- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 96-112 — 12 built-in tools enum
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 118-136 — `computeClaudeBuiltinArgs()` — computes `--disallowedTools` per tool, `--strict-mcp-config`

### 11.7 Claude CLI agent-spec mode

- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 138-167 — `extractAgentSpecName()`, `normalizeAgentSpec()` — spec frontmatter `tools:` governs access
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 252-259 — `systemPromptIsAgentSpec` mode bypasses `--disallowedTools`

### 11.8 HITL tool opt-in

- `packages/agent/agent-base-types/src/domain.ts` lines 272 — `allowHumanInput` on AgentDefinition
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 157-162 — HITL tool only added when `allowHumanInput === true && !isEphemeral`

### 11.9 Env-var name guard

- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 133-155 — `buildEnvNameGuard()` — only ADHD_AGENT_-prefixed names allowed
- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 157-181 — `assertEnvNamesAllowed()` — throws ZodError on violation

---

## 12. Agent Delegation Tracking

### 12.1 callingAgentName

- `packages/agent/agent-base-types/src/domain.ts` line 308 — `callingAgentName` on `ExecutionContext`

### 12.2 rootTaskId

- `packages/agent/agent-base-types/src/domain.ts` lines 310-311 — `rootTaskId` on ExecutionContext

### 12.3 parentTaskId

- `packages/agent/agent-base-types/src/domain.ts` line 65 — `parentTaskId` on Task
- `packages/agent/agent-base-types/src/domain.ts` line 309 — `parentTaskId` on ExecutionContext

### 12.4 delegationSessions set

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` line 141 — `delegationSessions = new Set<string>()`
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 631-641 — Detection: when `agent-mcp__agent` returns `session_id`, adds to set
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 863-871 — Cleanup on failure: all tracked delegation sessions closed

### 12.5 recursionDepth

- `packages/agent/agent-base-types/src/domain.ts` lines 64 — `recursionDepth` on Task
- `packages/agent/agent-base-types/src/domain.ts` lines 312 — `recursionDepth` on ExecutionContext

### 12.6 Session creation for delegation

- `packages/agent/agent-engine-orchestrator/src/tools/session.ts` lines 36-92 — `agentTool()` — creates sub-session for target agent, checks policy, resolves composed prompt

---

## 13. Policy Engine

### 13.1 PolicyEngine class

- `packages/agent/agent-engine-orchestrator/src/engine/policy.ts` lines 9-14 — `PolicyConfig`: serverMaxDepth, serverMaxToolLoops, serverAllowedAgents, policyTemplateRules
- `packages/agent/agent-engine-orchestrator/src/engine/policy.ts` lines 48-113 — `PolicyEngine.check()` — depth, tool loops, delegation allowlist

### 13.2 7 seeded policy types

- `packages/agent/agent-core-policy/src/seed/policy-types.ts` lines 20-49 — 7 types: permission, safety, audit, rate, scope, compliance, quality

### 13.3 9 seeded templates

- `packages/agent/agent-core-policy/src/seed/policy-templates.ts` lines 46-219 — `POLICY_TEMPLATES`:
  - `reviewer-posture` (safety) — lines 49-63
  - `no-credentials` (safety) — lines 65-85
  - `sox-audit-trail` (audit) — lines 89-105
  - `max-rework-3` (rate) — lines 109-124
  - `evidence-required` (quality) — lines 128-149
  - `originality-check` (quality) — lines 151-169
  - `read-only` (permission) — lines 173-186
  - `allowed-delegation` (permission) — lines 188-200
  - `phase-gate-required` (compliance) — lines 204-219

### 13.4 5 enforcement mechanisms

- `packages/agent/agent-core-policy/src/seed/policy-templates.ts` — Enforcement values per template: `agent` (reviewer-posture), `['agent', 'ci']` (no-credentials), `hook` (sox-audit-trail), `runtime` (max-rework-3), `settings` (read-only)

### 13.5 Category inheritance

- `packages/agent/agent-core-policy/src/store/agent-policy-store.ts` lines 230-258 — `attachToCategory()` — lazy, no fanout
- `packages/agent/agent-core-policy/src/store/agent-policy-store.ts` lines 310-357 — `resolveForAgent()` — 3-query merge: direct rows + category memberships + category policies
- `packages/agent/agent-core-policy/src/db/schema.ts` lines 69-89 — `categoryPoliciesTable`
- `packages/agent/agent-core-policy/src/db/schema.ts` lines 104-118 — `agentCategoriesTable`

### 13.6 Shallow-merge override

- `packages/agent/agent-core-policy/src/store/agent-policy-store.ts` lines 374-392 — `resolveEffectiveRules()` — templateRules + overrideConfig shallow merge

### 13.7 Rate policy plugin

- `packages/agent/agent-core-policy/src/index.ts` lines 42-48 — Rate plugin exports: `createPlugin`, `configSchema`, `evaluateRatePolicy`, `makeRatePolicyError`

### 13.8 Policy template store

- `packages/agent/agent-core-policy/src/store/policy-template-store.ts` lines 80-191 — PolicyTemplateStore: create, read, list

---

## 14. Provider Adapter Interface

### 14.1 LLMProvider interface

- `packages/agent/agent-engine-orchestrator/src/providers/types.ts` lines 5-21 — ProviderChatRequest: messages, tools?, signal?, executeTool?
- `packages/agent/agent-engine-orchestrator/src/providers/types.ts` lines 23-25 — LLMProvider.chat()

### 14.2 Provider factory

- `packages/agent/agent-engine-orchestrator/src/providers/factory.ts` lines 8-26 — `createProvider()` — discriminated union on type: anthropic | openai | claudecli

### 14.3 AnthropicProvider

- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 180-329 — Full provider: streaming messages, tool calls, usage normalisation
- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 22-39 — MODEL_MAX_TOKENS table
- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 54-78 — `normaliseAnthropicUsage()` — reconstructs true total from SDK fields
- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 94-113 — `buildAnthropicClient()` — API key vs OAuth detection
- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 304-326 — Retry via pRetry with abort/401 handling

### 14.4 OpenAIProvider

- `packages/agent/agent-engine-orchestrator/src/providers/openai.ts` lines 124-228 — OpenAI + DeepSeek + LM Studio
- `packages/agent/agent-engine-orchestrator/src/providers/openai.ts` lines 31-63 — `normaliseOpenAIUsage()` — handles prompt_tokens_details.cached_tokens + prompt_cache_hit/miss_tokens
- `packages/agent/agent-engine-orchestrator/src/providers/openai.ts` lines 212-224 — Retry via pRetry

### 14.5 ClaudeCliProvider

- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 171-440 — Full subprocess provider
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 192-201 — `buildSubprocessEnv()`
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 203-231 — `writeMcpConfigFile()`
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 233-241 — `writeAgentSpecDir()`
- `packages/agent/agent-engine-orchestrator/src/providers/claudecli.ts` lines 243-439 — `chat()` — stream-json protocol with tool execution

### 14.6 ProviderConfig

- `packages/agent/agent-base-types/src/domain.ts` lines 154-212 — Discriminated union ProviderConfig: anthropic | openai | claudecli

### 14.7 ProviderEnvBlock

- `packages/agent/agent-base-types/src/domain.ts` lines 145-152 — Env-var NAME pointers (never values): secret, base_url, model

### 14.8 ProviderAdapter (streaming)

- `packages/agent/agent-core-provider/src/adapter/provider-adapter.ts` lines 22-54 — `ProviderAdapterImpl` implements base-types ProviderAdapter

---

## 15. Retry / Config Handling

### 15.1 RetryConfig

- `packages/agent/agent-base-types/src/domain.ts` lines 126-131 — `RetryConfig`: retries, minTimeout, maxTimeout, factor
- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 7-12 — retryConfigSchema zod defaults

### 15.2 p-retry usage

- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 304-326 — pRetry on Anthropic
- `packages/agent/agent-engine-orchestrator/src/providers/openai.ts` lines 212-224 — pRetry on OpenAI

### 15.3 EngineConfig

- `packages/agent/agent-engine-orchestrator/src/interfaces.ts` lines 9-58 — EngineConfig: server.contextLimit, server.defaultMaxTokens, queue.concurrency, sse.baseUrl, plugins.configPath, getProviderConfig(), subprocessEnv(), isEnvNameAllowed()

### 15.4 EngineLogger

- `packages/agent/agent-engine-orchestrator/src/interfaces.ts` lines 66-71 — `EngineLogger`: info, warn, error, debug

### 15.5 Provider timeout

- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 272-277 — `AbortSignal.any([taskSignal, AbortSignal.timeout(provider.timeoutMs)])`
- `packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts` lines 354-412 — Provider error classification: abort, timeout, auth, rate-limit, context-window-exceeded
- `packages/agent/agent-engine-orchestrator/src/clients/stdio-client.ts` lines 85-91 — MCP server timeout via AbortSignal.any

---

## 16. Session Message Format

### 16.1 MessageRole

- `packages/agent/agent-base-types/src/domain.ts` line 101 — `'system' | 'user' | 'assistant' | 'tool'`

### 16.2 ToolCall

- `packages/agent/agent-base-types/src/domain.ts` lines 103-108 — `ToolCall`: id, server, tool, arguments

### 16.3 ToolResult

- `packages/agent/agent-base-types/src/domain.ts` lines 110-114 — `ToolResult`: toolCallId, result, isError

### 16.4 Message

- `packages/agent/agent-base-types/src/domain.ts` lines 116-124 — `Message`: id, sessionId, role, content?, toolCalls?, toolResults?, createdAt

### 16.5 Session

- `packages/agent/agent-base-types/src/domain.ts` lines 91-99 — `Session`: id, agentName, agentVersion, status (active|closed), timestamps
- `packages/agent/agent-base-types/src/domain.ts` line 89 — `SessionStatus`: 'active' | 'closed'

### 16.6 SessionStore

- `packages/agent/agent-store-runtime/src/store/session-store.ts` lines 22-213 — Full SessionStore: create, read, getAgentDefinition, list, close, clearMessages, appendMessage, getMessages
- `packages/agent/agent-store-runtime/src/store/session-store.ts` lines 28-58 — `create()` — stores agentData as JSON snapshot
- `packages/agent/agent-store-runtime/src/store/session-store.ts` lines 157-177 — `clearMessages()` — deletes all messages; throws SESSION_CLOSED if closed

### 16.7 Session DB schema

- `packages/agent/agent-store-runtime/src/db/schema.ts` lines 12-25 — `sessionsTable`: agentData, composedPromptId
- `packages/agent/agent-store-runtime/src/db/schema.ts` lines 30-44 — `messagesTable`

### 16.8 estimateTokens / windowMessages (session-store)

- `packages/agent/agent-store-runtime/src/store/session-store.ts` lines 215-226 — `estimateTokens()` — 4 chars/token
- `packages/agent/agent-store-runtime/src/store/session-store.ts` lines 228-253 — `windowMessages()` — system-preserving, contiguous-drop from oldest

### 16.9 Validation schemas

- `packages/agent/agent-store-runtime/src/validation/schemas.ts` lines 6-14 — sessionSchema
- `packages/agent/agent-engine-orchestrator/src/validation/session.ts` lines 3-14 — session validation

---

## 17. Usage Tracking

### 17.1 TokenUsage

- `packages/agent/agent-base-types/src/domain.ts` lines 15-38 — TokenUsage: inputTokens, outputTokens, stopReason, maxTokens, uncachedInputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens

### 17.2 Per-provider normalisation

- `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts` lines 54-78 — `normaliseAnthropicUsage()` — inputTokens = uncached + cacheRead + cacheCreation
- `packages/agent/agent-engine-orchestrator/src/providers/openai.ts` lines 31-63 — `normaliseOpenAIUsage()` — handles both OpenAI cached_tokens and DeepSeek cache_hit/miss

### 17.3 task_usage DB table

- `packages/agent/agent-store-runtime/src/db/schema.ts` lines 133-169 — `taskUsageTable`: taskId, rootTaskId, agentName, providerType, model, inputTokens, outputTokens, toolCallCount, modelCalls, latencyMs, isComplete, stopReason, maxTokens, cacheReadTokens, cacheCreationTokens, uncachedInputTokens, reasoningTokens, peakContextTokens, peakContextAt

### 17.4 UsagePlugin

- `packages/agent/agent-engine-orchestrator/src/plugins/usage-plugin.ts` lines 42-198 — Full plugin: task:start accumulators, post:model_response upsert, terminal handlers
- `packages/agent/agent-engine-orchestrator/src/plugins/usage-plugin.ts` lines 107-166 — SQL upsert with ON CONFLICT DO UPDATE, peakContextTokens = MAX

### 17.5 UsageClient

- `packages/agent/agent-store-runtime/src/runtime/usage-client.ts` lines 24-227 — In-memory + DB-scoped accumulator
- `packages/agent/agent-store-runtime/src/runtime/usage-client.ts` lines 50-61 — `recordModelCall()`
- `packages/agent/agent-store-runtime/src/runtime/usage-client.ts` lines 97-170 — `getTotals()` — scope-aware: task | session | agent

### 17.6 Grouped usage query

- `packages/agent/agent-engine-orchestrator/src/tools/usage.ts` lines 89-209 — `usageQuery()` — group_by agent|model|provider, with cache fields, peakContextTokens
- `packages/agent/agent-engine-orchestrator/src/tools/usage.ts` lines 211-232 — `buildTaskUsageReport()` — direct + subtree summaries

### 17.7 peakContextTokens invariant

- `packages/agent/agent-store-runtime/src/db/schema.ts` lines 159-163 — Comment: peakContextTokens is MAX, not SUM
- `packages/agent/agent-engine-orchestrator/src/plugins/usage-plugin.ts` lines 157-163 — peakContextTokens = MAX(COALESCE(current, 0), inputTokens)
- `packages/agent/agent-engine-orchestrator/src/tools/usage.ts` lines 50-57 — Doc: inputTokens is cumulative, peakContextTokens is max

---

## 18. Budget Plugin

### 18.1 9 cap dimensions

- `packages/agent/agent-plugin-budget/src/index.ts` lines 38-48 — FIELD_NAMES: tokens, inputTokens, outputTokens, calls, wallClock, modelMs, cost, toolCalls, responseSize
- `packages/agent/agent-plugin-budget/src/index.ts` lines 50-57 — capSchema: field, maximum, window, scope, mode, message

### 18.2 4 scopes

- `packages/agent/agent-plugin-budget/src/index.ts` line 54 — `z.enum(['task', 'session', 'agent', 'global'])`

### 18.3 2 modes

- `packages/agent/agent-plugin-budget/src/index.ts` line 55 — `z.enum(['warning', 'block'])`
- `packages/agent/agent-plugin-budget/src/index.ts` lines 741-744 — `warning` mode → IToolWarning, `block` mode → IEnforcementError

### 18.4 ISO8601 duration parser

- `packages/agent/agent-plugin-budget/src/index.ts` lines 20-34 — `parseIsoDuration()` — supports P[n]Y[n]M[n]DT[n]H[n]M[n]S

### 18.5 Config hierarchy

- `packages/agent/agent-plugin-budget/src/index.ts` lines 76-104 — `pluginConfigSchema`: defaults → agent (default + overrides) → provider (default + overrides) → tool (default + overrides)
- `packages/agent/agent-plugin-budget/src/index.ts` lines 361-391 — `resolveCaps()` — merges all layers

### 18.6 Backward compat flat config

- `packages/agent/agent-plugin-budget/src/index.ts` lines 112-147 — FIELD_MAP + flatFieldsToDimension
- `packages/agent/agent-plugin-budget/src/index.ts` lines 149-172 — `normalizeConfig()` — auto-detect flat vs structured

### 18.7 Response size enforcement

- `packages/agent/agent-plugin-budget/src/index.ts` lines 759-831 — `enforceResponseSize()` — transform:tool_result hook, truncate or replace content

### 18.8 Scope-aware DB queries

- `packages/agent/agent-plugin-budget/src/index.ts` lines 395-473 — `queryScopeTotals()` — task, session, agent SQL
- `packages/agent/agent-plugin-budget/src/index.ts` lines 475-538 — `queryWindowTokens()` — time-windowed totals

---

## 19. Sanitize Plugin

### 19.1 3 strategies

- `packages/agent/agent-plugin-sanitize/src/index.ts` lines 19 — `z.enum(['none', 'prefix', 'wrap'])`
- `packages/agent/agent-plugin-sanitize/src/index.ts` lines 38-43 — `prefixContent()` — prepend `[Sub-agent output from "agentName"]`
- `packages/agent/agent-plugin-sanitize/src/index.ts` lines 45-50 — `wrapContent()` — surround with delimiters

### 19.2 Delegation-only mode

- `packages/agent/agent-plugin-sanitize/src/index.ts` line 31 — `delegationOnly: z.boolean().default(true)`
- `packages/agent/agent-plugin-sanitize/src/index.ts` lines 59-61 — `isDelegation()` — checks `agent-mcp__task` or `agent-mcp__agent`
- `packages/agent/agent-plugin-sanitize/src/index.ts` line 75 — Skips non-delegation when delegationOnly

### 19.3 Per-agent overrides

- `packages/agent/agent-plugin-sanitize/src/index.ts` line 25 — `agents: z.record(z.string(), strategy)`

### 19.4 Install hook

- `packages/agent/agent-plugin-sanitize/src/index.ts` lines 70-121 — registers on `transform:tool_result`, mutates payload.result

---

## 20. Agent Definition & CRUD

### 20.1 AgentDefinition

- `packages/agent/agent-base-types/src/domain.ts` lines 246-281 — Full AgentDefinition: name, description, version, provider, systemPrompt, mcpServers, permissions, maxToolLoops, allowHumanInput, toolAdvertisement, timestamps

### 20.2 Agent CRUD (runtime)

- `packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts` lines 27-56 — agentCreate, agentRead, agentUpdate, agentDelete, agentList
- `packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts` lines 39-52 — `agentDelete(input.force)` — force closes active sessions before delete

### 20.3 Registry Agent (compiler-side)

- `packages/agent/agent-store-prompts/src/store/agent-store.ts` lines 49-66 — Agent: slug, displayName, description, status, modelHint, taxonomyCategory, defaultPosture
- `packages/agent/agent-store-prompts/src/store/agent-store.ts` lines 166-327 — AgentStore: create, read, update, delete, list

### 20.4 Agent status lifecycle

- `packages/agent/agent-store-prompts/src/store/agent-store.ts` line 26 — `AgentStatus = 'draft' | 'active' | 'deprecated'`

### 20.5 Agent posture

- `packages/agent/agent-store-prompts/src/store/agent-store.ts` line 29 — `AgentPosture = 'approve' | 'needs_work'`

### 20.6 Taxonomy categories

- `packages/agent/agent-store-prompts/src/store/agent-store.ts` lines 31-38 — `TaxonomyCategory`: slug, name, description, position, parentSlug
- `packages/agent/agent-store-prompts/src/store/agent-store.ts` lines 102-157 — TaxonomyStore: createCategory, listCategories
- `packages/agent/agent-store-prompts/src/db/schema.ts` lines 124-144 — `taxonomyCategoriesTable` with self-FK parentSlug

### 20.7 Agent validation schemas

- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 100-221 — Full agent schema: agentDefinitionSchema, agentCreateInputSchema, agentPatchSchema, agentUpdateInputSchema, etc.

### 20.8 Legacy shim

- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 55-85 — `legacyShim()` — coerces `lmstudio`→`openai`, `apiKeyEnv`→`env.secret`, removes legacy fields

---

## 21. Tool Stores (Registry-Side)

### 21.1 Canonical Tool

- `packages/agent/agent-store-tools/src/store/tool-store.ts` lines 18-27 — Tool: name, type, description, version, requiresApproval, isDestructive, dependencyToolIds[], capabilities[]
- `packages/agent/agent-store-tools/src/store/tool-store.ts` lines 67-177 — ToolStore: seedToolType, listToolTypes, create, read, list

### 21.2 ToolType

- `packages/agent/agent-store-tools/src/store/tool-store.ts` lines 12-15 — ToolType: slug, description

### 21.3 AgentToolGrant

- `packages/agent/agent-store-tools/src/store/agent-tool-store.ts` lines 28-34 — AgentToolGrant: agentSlug, toolName, permission, contextCondition
- `packages/agent/agent-store-tools/src/store/agent-tool-store.ts` lines 101-214 — AgentToolStore: grant, listForAgent, revoke

### 21.4 ToolPlatformBinding

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 33-39 — ToolPlatformBinding: toolName, platformId, platformToolName, availability, requiresMcp, invocationNote

### 21.5 Forward resolve

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 194-214 — `resolve(canonicalToolName, platformId)` → platformToolName

### 21.6 Reverse resolve

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 245-265 — `resolveCanonical(platformToolName, platformId)` → toolName

### 21.7 List for platform

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 271-285 — `listForPlatform(platformId)`

### 21.8 Platform

- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 12-17 — Platform: id, name, headerFormat, supportsToolSelection
- `packages/agent/agent-store-tools/src/store/binding-store.ts` lines 98-133 — readPlatform, listPlatforms

### 21.9 McpServer (registry)

- `packages/agent/agent-store-tools/src/store/mcp-server-store.ts` lines 19-24 — McpServer: id, transport, name, providedToolIds[], configSchema
- `packages/agent/agent-store-tools/src/store/mcp-server-store.ts` lines 60-143 — McpServerStore: create, read, list

### 21.10 Seed data

- `packages/agent/agent-store-tools/src/seed/tool-types.ts` lines 16-41 — 8 tool types: io, compute, network, memory, ui, meta, lsp, notebook
- `packages/agent/agent-store-tools/src/seed/tools.ts` lines 19-125 — 15 canonical tools
- `packages/agent/agent-store-tools/src/seed/platforms.ts` lines 18-55 — 6 platforms: claude_code, claude_api, openai, bedrock, cursor, vscode
- `packages/agent/agent-store-tools/src/seed/bindings.ts` lines 22-178 — Platform bindings for claude_code + claude_api

### 21.11 DB schema

- `packages/agent/agent-store-tools/src/db/schema.ts` lines 17-20 — `toolTypesTable`
- `packages/agent/agent-store-tools/src/db/schema.ts` lines 29-56 — `toolsTable`
- `packages/agent/agent-store-tools/src/db/schema.ts` lines 67-75 — `platformsTable`
- `packages/agent/agent-store-tools/src/db/schema.ts` lines 85-108 — `toolPlatformBindingsTable`
- `packages/agent/agent-store-tools/src/db/schema.ts` lines 123-138 — `mcpServersTable`
- `packages/agent/agent-store-tools/src/db/schema.ts` lines 153-173 — `agentToolsTable`

---

## 22. Prompt Component System

### 22.1 PromptComponent

- `packages/agent/agent-store-prompts/src/store/component-store.ts` lines 38-53 — PromptComponent: slug, type, version, versionId, content, isShared, timestamps

### 22.2 PromptType

- `packages/agent/agent-store-prompts/src/store/component-store.ts` lines 32-36 — PromptType: slug, description, isSystem

### 22.3 ComponentStore

- `packages/agent/agent-store-prompts/src/store/component-store.ts` lines 84-454 — Full store:
  - `upsertType()` — lines 93-104
  - `readType()` — lines 107-126
  - `create()` (atomic head+v1) — lines 137-183
  - `read()` (latest) — lines 190-222
  - `readVersion()` (specific) — lines 229-262
  - `resolveVersionId()` — lines 271-291
  - `version()` (bump) — lines 299-354
  - `list()` (with type/shared filters) — lines 360-424

### 22.4 CompositionStore

- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 110-404 — Full store:
  - `attach()` — lines 133-161 (with version pin + context condition + isRequired)
  - `resolvePinVersionId()` — lines 169-189
  - `resolveComposition()` — lines 243-300 (ordered, filtered, versioned)
  - `_resolveComponentVersion()` — lines 316-376 (null pin → latest, int pin → exact)

### 22.5 ResolvedComponent

- `packages/agent/agent-store-prompts/src/store/composition-store.ts` lines 41-50 — ResolvedComponent: componentSlug, position, resolvedVersion, component

### 22.6 CompositionContext

- `packages/agent/agent-store-prompts/src/store/composition-store.ts` line 38 — `CompositionContext = Record<string, string>`

### 22.7 UseCaseStore

- `packages/agent/agent-store-prompts/src/store/usecase-store.ts` lines 88-238 — UseCaseStore:
  - `createUseCase()` — lines 100-109
  - `getUseCase()` — lines 112-121
  - `listUseCases()` — lines 124-130
  - `linkComponent()` — lines 145-158
  - `componentsFor()` — lines 166-177
  - `addContextRule()` — lines 193-215
  - `contextRulesFor()` — lines 224-237

### 22.8 Context rules

- `packages/agent/agent-store-prompts/src/store/usecase-store.ts` lines 61-69 — ContextRule: id, agentSlug, condition, componentSlug, position

---

## 23. Schemas & Tests

### 23.1 Validation schemas (orchestrator)

- `packages/agent/agent-engine-orchestrator/src/validation/mcp.ts` lines 42-44 — McpStdioConfig, McpHttpConfig, McpSseConfig types
- `packages/agent/agent-engine-orchestrator/src/validation/agent.ts` lines 218-221 — AgentCreateInput, AgentUpdateInput, AgentReadInput, AgentDeleteInput types
- `packages/agent/agent-engine-orchestrator/src/validation/session.ts` lines 44-49 — AgentToolInput, AgentToolOutput, SessionListInput, SessionCloseInput, SessionClearInput, SessionClearOutput types
- `packages/agent/agent-engine-orchestrator/src/validation/message.ts` lines 33-38 — MessageRole, ToolCall, ToolResult, Message types
- `packages/agent/agent-engine-orchestrator/src/validation/task.ts` lines 105-109 — TaskToolInput, TaskToolOutput, TaskListInput, TaskCancelInput, ResultInput types
- `packages/agent/agent-engine-orchestrator/src/validation/usage.ts` lines 14-68 — TaskUsageInput, TaskUsageReport, UsageSummary, GroupedUsageRow types

### 23.2 Validation schemas (store-runtime)

- `packages/agent/agent-store-runtime/src/validation/schemas.ts` lines 14-51 — sessionSchema, agentDefinitionStoredSchema
- `packages/agent/agent-store-runtime/src/validation/schemas.ts` lines 60-94 — taskSchema, TaskListInput

### 23.3 Test files

| lines | File | Content |
|-------|------|---------|
| Full | `agent-engine-orchestrator/src/__tests__/dag-engine.test.ts` | DAG cycle detection, dispatch, dependency resolution |
| Full | `agent-engine-orchestrator/src/__tests__/orchestrator.test.ts` | Full orchestrator loop, HITL, tool execution |
| Full | `agent-engine-orchestrator/src/__tests__/tool-naming.test.ts` | Tool naming separator, normalization, resolution |
| Full | `agent-engine-orchestrator/src/__tests__/policy.test.ts` | Policy depth limits, delegation allowlist |
| Full | `agent-engine-orchestrator/src/__tests__/context-window.test.ts` | Compact decision, message grouping, atomic units |
| Full | `agent-engine-orchestrator/src/__tests__/window-messages.test.ts` | windowMessages, token estimation |
| Full | `agent-engine-orchestrator/src/__tests__/env-name-guard.test.ts` | Env-var name guard validation |
| Full | `agent-engine-orchestrator/src/__tests__/registry-connect-retry.test.ts` | MCP registry connect retry failure eviction |
| Full | `agent-engine-orchestrator/src/__tests__/usage-query.test.ts` | Usage query, grouping, peak computation |
| Full | `agent-engine-orchestrator/src/__tests__/usage-normalisation.test.ts` | Per-provider usage normalisation |
| Full | `agent-engine-compiler/src/__tests__/compile-agent.test.ts` | Full compilation, resolve layers, emit formats |
| Full | `agent-engine-compiler/src/__tests__/compile-cli.test.ts` | CLI compile command |
| Full | `agent-engine-compiler/src/__tests__/compile-cache.test.ts` | Composed prompt cache hit/miss |
| Full | `agent-engine-compiler/src/__tests__/compile-e2e.test.ts` | End-to-end compilation with real fixture data |
| Full | `agent-engine-compiler/src/__tests__/skeleton.test.ts` | Package scaffold smoke test |
| Full | `agent-engine-compiler/src/__tests__/tool-header.test.ts` | Tool header resolution tests |
| Full | `agent-engine-compiler/src/__tests__/model-policy.test.ts` | Model + policy constraint resolution |
| Full | `agent-engine-compiler/src/__tests__/composition-resolve.test.ts` | Composition resolution with context conditions |
| Full | `agent-core-policy/src/__tests__/agent-policy-store.test.ts` | Policy CRUD, category inheritance |
| Full | `agent-core-policy/src/__tests__/inheritance.test.ts` | Category inheritance resolution |
| Full | `agent-core-policy/src/__tests__/roundtrip.test.ts` | Policy store persistence |
| Full | `agent-core-policy/src/__tests__/enforcement-plugin.test.ts` | Rate policy enforcement |
| Full | `agent-core-policy/src/__tests__/policy-template-store.test.ts` | Template store CRUD |
| Full | `agent-store-tools/src/__tests__/tool-store.test.ts` | Tool store CRUD |
| Full | `agent-store-tools/src/__tests__/binding-store.test.ts` | Binding forward/reverse resolve |
| Full | `agent-store-tools/src/__tests__/agent-tool-store.test.ts` | Agent tool grants, permission defaults |
| Full | `agent-store-tools/src/__tests__/mcp-server-store.test.ts` | MCP server store CRUD |
| Full | `agent-store-tools/src/__tests__/roundtrip.test.ts` | Tool store persistence round-trip |
| Full | `agent-core-provider/src/__tests__/model-store.test.ts` | Model store CRUD, resolveModelId, resolveCanonicalId |
| Full | `agent-core-provider/src/__tests__/tool-format-store.test.ts` | Tool format store CRUD |
| Full | `agent-core-provider/src/__tests__/binding-store.test.ts` | Provider model-platform bindings |
| Full | `agent-core-provider/src/__tests__/emit-tools.test.ts` | Tool emitter: custom, server_side, unsupported |
| Full | `agent-core-provider/src/__tests__/roundtrip.test.ts` | Provider-package persistence |
| Full | `agent-core-provider/src/__tests__/adapter-resolve.test.ts` | ProviderAdapter model resolution |
| Full | `agent-store-runtime/src/__tests__/session-store.test.ts` | Session CRUD, message append, clear |
| Full | `agent-store-runtime/src/__tests__/task-store.test.ts` | Task CRUD, cancellation, events |
| Full | `agent-store-runtime/src/__tests__/usage-client.test.ts` | UsageClient accumulators, scope queries |
| Full | `agent-plugin-budget/src/__tests__/budget-plugin.test.ts` | Budget plugin enforcement, cap evaluation |
| Full | `agent-plugin-sanitize/src/__tests__/sanitize-plugin.test.ts` | Sanitize plugin strategies, delegation-only |
| Full | `agent-generator-plugin/src/test/generator.spec.ts` | Generator plugin smoke test |

### 23.4 Seed data factories

- `packages/agent/agent-core-provider/src/seed/providers.ts` lines 18-86 — Provider seed (anthropic, openai, bedrock, lmstudio, claudecli)
- `packages/agent/agent-core-provider/src/seed/models.ts` lines 21-91 — Model seed (4 Claude models)
- `packages/agent/agent-core-provider/src/seed/bindings.ts` lines 27-93 — Model-platform bindings (claude_code + claude_api)
- `packages/agent/agent-core-policy/src/seed/policy-types.ts` lines 20-49 — 7 policy types
- `packages/agent/agent-core-policy/src/seed/policy-templates.ts` lines 46-219 — 9 policy templates
- `packages/agent/agent-store-tools/src/seed/tool-types.ts` lines 16-41 — 8 tool types
- `packages/agent/agent-store-tools/src/seed/tools.ts` lines 19-125 — 15 canonical tools
- `packages/agent/agent-store-tools/src/seed/platforms.ts` lines 18-55 — 6 platforms
- `packages/agent/agent-store-tools/src/seed/bindings.ts` lines 22-178 — Platform bindings

---

*End of inventory — 23 sections, raw file-by-file with exact line numbers.*
