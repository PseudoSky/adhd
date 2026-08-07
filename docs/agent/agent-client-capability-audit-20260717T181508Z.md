# Agent-Client Capability Coverage Audit

**Generated:** 2026-07-17T18:15:08Z  
**Stubs audited:** `/Users/nix/dev/node/adhd/.worktrees/agent-client/entrypoint/agent-client/src/` (21 files, all `.ts`)  
**Inventories consulted:**
1. `docs/agent/agent-package-feature-inventory-20260717T181508Z.md` (1,034 lines — packages/agent/* features)
2. `docs/agent/plans/dispatch-completion-feature-inventory-20260717T181508Z.md` (590 lines — dispatch-completion plan)
3. `docs/agent/plans/agent-mcp-authoring-feature-inventory-20260717T181508Z.md` (694 lines — agent-mcp authoring plan)
4. `docs/agent/plans/adhd-environment-feature-inventory-20260717T181508Z.md` (1,337 lines — environment plan)
5. `docs/plan/agent-final/INVENTORY_JULY_17.md` (416 lines — user's own inventory)
6. `docs/agent/agent-runtime-service-design-20260717T181508Z.md` — does not exist (skipped)

## Summary

| Category | Count |
|----------|-------|
| GREEN (implemented — has real stub with correct types/signatures) | 83 |
| YELLOW (stub exists but incomplete or types are wrong) | 41 |
| RED (missing entirely or intentionally omitted) | 184 |
| **Total capabilities audited** | **308** |

---

## Coverage Table

| # | Capability | agent-client | origin | notes |
|---|-----------|-------------|--------|-------|
| | **1. Error Taxonomy** | | | |
| 1 | `AGENT_NOT_FOUND` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union at `types.ts:7-15` |
| 2 | `AGENT_ALREADY_EXISTS` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 3 | `AGENT_HAS_ACTIVE_SESSIONS` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 4 | `SESSION_NOT_FOUND` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 5 | `SESSION_CLOSED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 6 | `TASK_NOT_FOUND` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 7 | `TASK_NOT_CANCELLABLE` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 8 | `TASK_NOT_RESUMABLE` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 9 | `DELEGATION_NOT_ALLOWED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 10 | `MAX_DEPTH_EXCEEDED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 11 | `MAX_TOOL_LOOPS_EXCEEDED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 12 | `PROVIDER_ERROR` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 13 | `MCP_CLIENT_ERROR` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 14 | `VALIDATION_ERROR` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 15 | `CONTEXT_WINDOW_EXCEEDED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 16 | `PROVIDER_TIMEOUT` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 17 | `PROVIDER_AUTH_ERROR` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 18 | `PROVIDER_RATE_LIMITED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 19 | `BUDGET_EXCEEDED` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 20 | `COMPOSED_PROMPT_NOT_FOUND` | 🟢 GREEN | `agent-base-types/src/errors.ts` | In `AgentErrorCode` union |
| 21 | `POLICY_VIOLATION` | 🟢 GREEN | `agent-core-policy/src/plugin/rate-policy.ts` | Extra code not in canonical 20 (inventory miscounts as 21). Present in agent-client `AgentErrorCode` |
| 22 | `AgentError` class (code + data) | 🟢 GREEN | `agent-base-types/src/errors.ts` | `types.ts:17-26` — `AgentError` with `code: AgentErrorCode`, `data?: unknown` |
| 23 | Per-store error classes | 🔴 RED | `agent-store-prompts/src/store/component-store.ts` etc. | No `ComponentError`, `CompositionError`, `AgentError`, `PolicyError`, `ToolStoreError`, etc. Only `AgentError` class |
| 24 | Zod `errorCodeSchema` | 🔴 RED | `agent-engine-orchestrator/src/validation/errors.ts` | No zod schema; `AgentErrorCode` is a type union only |
| 25 | `ToolError` class | 🔴 RED | `agent-engine-orchestrator/src/validation/errors.ts` | No `ToolError` class |
| 26 | `UnsupportedNativeToolError` | 🔴 RED | `agent-core-provider/src/runtime/emit-tools.ts` | Not present |
| | **2. Streaming Contracts** | | | |
| 27 | `StreamChunk` discriminated union | 🟡 YELLOW | `agent-base-types/src/domain.ts:341-343` | Different shape: inventory has `text`/`tool_call`; agent-client has `text-delta`/`tool-call`/`tool-result`/`error`/`finish`. Compatible direction but not 1:1 |
| 28 | `ProviderAdapter.stream()` interface | 🔴 RED | `agent-base-types/src/domain.ts:353-358` | No `ProviderAdapter` interface. Agent-client uses AI SDK `LanguageModel`/`streamText` instead |
| 29 | `LLMProvider.chat()` (non-streaming) | 🔴 RED | `agent-engine-orchestrator/src/providers/types.ts` | No `LLMProvider`, `ProviderChatRequest`, `ProviderChatResponse` types |
| 30 | SSE streaming URL | 🔴 RED | `agent-engine-orchestrator/src/tools/task.ts:303-307` | No SSE server, no stream_url field |
| 31 | `streamTurn` AsyncGenerator | 🟡 YELLOW | `orchestrator.ts:77-83` | Stub exists with correct signature (`AsyncGenerator<StreamChunk>`), but body throws immediately with error chunk |
| | **3. Task / DAG Lifecycle** | | | |
| 32 | 7 task statuses | 🟢 GREEN | `agent-base-types/src/domain.ts:40-47` | `TaskStatus` in `types.ts:152-154` — all 7: `pending`, `running`, `completed`, `failed`, `cancelled`, `waiting`, `awaiting_input` |
| 33 | 7 task event types | 🟢 GREEN | `agent-base-types/src/domain.ts:48-55` | `TaskEventType` in `types.ts:156-158` — all 7 including `TASK_CANCELLED` |
| 34 | `Task` interface (full shape) | 🟢 GREEN | `agent-base-types/src/domain.ts:57-79` | `types.ts:162-180` — all fields: `id`, `sessionId`, `parentTaskId`, `recursionDepth`, `isEphemeral`, `status`, `prompt`, `result`, `error`, `dependsOn`, `onUpstreamFailure`, `inputs`, `resumeToken`, timestamps |
| 35 | `TaskEvent` interface | 🟢 GREEN | `agent-base-types/src/domain.ts` | `types.ts:182-188` — `id`, `taskId`, `type`, `payload`, `createdAt` |
| 36 | DAG engine (`validateNoCycle`, `dispatchReady`) | 🔴 RED | `agent-engine-orchestrator/src/engine/dag-engine.ts` | No DAG engine. `Task.dependsOn` field exists in schema but no cycle detection, no optimistic lock, no upstream input passing |
| 37 | `BackgroundQueue` | 🔴 RED | `agent-engine-orchestrator/src/engine/queue.ts` | No background queue abstraction |
| 38 | HITL resume flow | 🟡 YELLOW | `agent-engine-orchestrator/src/engine/orchestrator.ts:486-533` | `TaskService` has `generateResumeToken()`/`resume()` stubs (lines 108-118). `Task.resumeToken` field exists. But no HITL builtin tool, no orchestration flow |
| 39 | Task cancellation | 🟡 YELLOW | `agent-engine-orchestrator/src/tools/task.ts:463-483` | `TaskService.cancel()` stub exists (line 100-102). No cancellation status checks, no AbortController map |
| 40 | `TaskStore` full | 🔴 RED | `agent-store-runtime/src/store/task-store.ts` | `TaskService` has CRUD stubs but no `registerCancellation`/`unregisterCancellation`, no `appendEvent` |
| 41 | `enqueueExistingTask` | 🔴 RED | `agent-engine-orchestrator/src/tools/task.ts:347-454` | No re-dispatch of persisted tasks |
| 42 | Session vs Ephemeral mode | 🔴 RED | `agent-engine-orchestrator/src/tools/task.ts:70-345` | `Task.isEphemeral` field exists, `TaskService.create()` accepts `isEphemeral` param, but no mode-specific paths |
| 43 | `DependsOn` / `onUpstreamFailure` | 🟡 YELLOW | `agent-engine-orchestrator/src/engine/dag-engine.ts` | Types present (`Task.dependsOn[]`, `OnUpstreamFailure`), `TaskService.create()` accepts params, but no resolution logic |
| 44 | `getBlocked()` | 🟡 YELLOW | `task.ts:84-86` | Stub exists on `TaskService` — correct method signature |
| 45 | `getEvents()` | 🟡 YELLOW | `task.ts:76-78` | Stub exists on `TaskService` for audit log retrieval |
| | **4. Plugin Hook Lifecycle** | | | |
| 46 | 12 Hook events | 🟢 GREEN | `agent-base-types/src/hooks.ts:63-84` | `types.ts:334-338` — all 12: `task:start`, `pre:model_request`, `post:model_response`, `pre:tool_call`, `post:tool_call`, `transform:tool_result`, `message:appended`, `task:completed`, `task:failed`, `task:cancelled`, `session:created`, `agent:mutated`. Inventory says 13 but code enumerates 12 |
| 47 | Hook payload types per event | 🔴 RED | `agent-base-types/src/hooks.ts:10-61` | No typed payloads. Agent-client uses `unknown` for all: `HookHandler { (payload: unknown) }` |
| 48 | Observational vs Enforcement split | 🟡 YELLOW | `agent-base-types/src/hooks.ts:86-144` | `PluginService` has `fireHook()` (observational) and `runEnforcements()` (enforcement) stubs. But no typed `IEnforcementError` / `IToolWarning` markers |
| 49 | Enforcement events restriction | 🔴 RED | `agent-base-types/src/hooks.ts:121` | No restriction — `enforce()` accepts any `HookEvent`; inventory says only `pre:model_request` and `pre:tool_call` |
| 50 | `IEnforcementError` marker | 🔴 RED | `agent-base-types/src/hooks.ts:98-102` | No `isEnforcementError: true` duck-type. Agent-client has `EnforcementResult { ok: boolean; error? }` — different interface |
| 51 | `IToolWarning` marker | 🔴 RED | `agent-base-types/src/hooks.ts:113-118` | Not present at all |
| 52 | `Plugin` interface (name + install) | 🟢 GREEN | `agent-base-types/src/hooks.ts:146-149` | `types.ts:344-350` — `Plugin { name; install(hooks) }` |
| 53 | `PluginFactory` (ctx => Plugin) | 🔴 RED | `agent-base-types/src/hooks.ts:167-183` | No `PluginFactory` type. No `configSchema` (zod) export pattern |
| 54 | `PluginContext` | 🟢 GREEN | `agent-base-types/src/hooks.ts:162-165` | `types.ts:352-355` — `{ db: unknown; config: Record<string, unknown> }` |
| 55 | `HookRegistry` implementation | 🔴 RED | `agent-base-types/src/registry.ts:23-80` | `PluginService` is a stub, not a registry. No `Map<HookEvent, handlers[]>`, no `register()`/`emit()`/`registerEnforcement()`/`enforce()` with Map-based dispatch |
| 56 | 3-phase tool execution | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:472-764` | No serial pre-dispatch, no `Promise.all` concurrent, no serial result append |
| 57 | External plugin loader | 🔴 RED | `agent-engine-orchestrator/src/plugins/loader.ts` | No `findConfigFile`, `loadConfigFile`, `resolveSpecifier`, `loadOnePlugin`, `loadExternalPlugins` |
| | **5. Agent Compilation Pipeline** | | | |
| 58 | `compileAgent()` orchestrator | 🔴 RED | `agent-engine-compiler/src/compile.ts:175-396` | INTENTIONAL OMISSION — compiler deleted, replaced by `resolveComposedPrompt()` on `AgentService`. Marked RED per instructions |
| 59 | 4 resolve layers (body, tools, model, policy) | 🔴 RED | `agent-engine-compiler/src/resolve/` | INTENTIONAL OMISSION — compiler deleted |
| 60 | 3 emit formats (yaml_frontmatter, json_object, none) | 🔴 RED | `agent-engine-compiler/src/emit/` | INTENTIONAL OMISSION — compiler deleted |
| 61 | `resolveComposedPrompt()` | 🟡 YELLOW | `agent.ts:220-225` | Stub exists on `AgentService` as the compiler replacement. Correct intent but no implementation |
| 62 | `resolveComposition()` | 🟡 YELLOW | `agent.ts:206-211` | Stub exists with context parameter |
| 63 | Context condition evaluator | 🔴 RED | `agent-store-prompts/src/store/composition-store.ts:72-98` | `CompositionEntry.contextCondition` field exists in types but no `evaluateCondition()` function |
| 64 | Required component guard | 🔴 RED | `agent-store-prompts/src/store/composition-store.ts:260-269` | `CompositionEntry.isRequired` field exists but no guard logic |
| 65 | `CompiledAgent` type | 🔴 RED | `agent-engine-compiler/src/compile.ts:72-94` | INTENTIONAL OMISSION — replaced by `ResolvedComponent[]` |
| | **6. Composed Prompt Cache** | | | |
| 66 | SHA-256 context hash | 🔴 RED | `agent-store-prompts/src/store/composed-prompt-store.ts:37-46` | No `contextHash()` function. No `ComposedPrompt` type |
| 67 | 3-part cache key | 🔴 RED | `agent-engine-compiler/src/cache/composed-prompt-cache.ts:62-83` | No cache key computation |
| 68 | Cache bypass (hit → skip resolve) | 🔴 RED | `agent-engine-compiler/src/compile.ts:198-262` | No cache layer |
| 69 | `ComposedPrompt` type | 🔴 RED | `agent-base-types/src/domain.ts:286-301` | No `ComposedPrompt` interface in types.ts |
| 70 | `ComposedPromptStore` operations | 🔴 RED | `agent-store-prompts/src/store/composed-prompt-store.ts:96-205` | No cache store |
| 71 | `composed_prompts` DB table | 🔴 RED | `agent-store-runtime/src/db/schema.ts:306-328` | No equivalent table in schema.ts |
| 72 | Experiment assignments DB table | 🟢 GREEN | `agent-store-runtime/src/db/schema.ts:120-128` | `experimentAssignments` table in `schema.ts:115-121` with `sessionId`, `experimentSlug`, `variant` |
| | **7. Context Window Management** | | | |
| 73 | Cache-preserving strategy | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:1-21` | No context window logic at all |
| 74 | `contextWindowFor()` | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:48-60` | No model-family context window lookup |
| 75 | `decideCompaction()` | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:105-134` | No compaction decision logic |
| 76 | `compactMessages()` | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:136-196` | No compaction. `MessageService.compact()` stub exists (line 75-81) but is a simple mark-compacted, not summarise-middle |
| 77 | `groupIntoAtomicUnits()` | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:86-103` | No atomic unit grouping |
| 78 | `estimateMessageTokens()` | 🔴 RED | `agent-engine-orchestrator/src/engine/context-window.ts:67-76` | No token estimation |
| 79 | `windowMessages()` hard cap | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:901-919` | No hard token-limit cap |
| | **8. Tool Advertisement Modes** | | | |
| 80 | `toolAdvertisement` config field | 🟢 GREEN | `agent-base-types/src/domain.ts:278` | `AgentPolicy.toolAdvertisement?: 'names' | 'full'` in `types.ts:117` |
| 81 | `toNameOnlyTools()` | 🔴 RED | `agent-engine-orchestrator/src/engine/tool-advertisement.ts:85-95` | No schema-stripping function |
| 82 | `renderToolPromptDoc()` | 🔴 RED | `agent-engine-orchestrator/src/engine/tool-advertisement.ts:41-83` | No markdown tool doc rendering |
| 83 | `firstLine()` / `describeType()` | 🔴 RED | `agent-engine-orchestrator/src/engine/tool-advertisement.ts:16-39` | No description truncation or type rendering |
| 84 | Orchestration wiring (names mode) | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:169-192` | No prepend-tool-doc-as-system-message logic |
| | **9. MCP Transport Details** | | | |
| 85 | 4 transport types (stdio, http, sse, in-process) | 🟢 GREEN | `agent-base-types/src/domain.ts:214-233` | `McpTransport` union in `types.ts:266` — all four: `stdio`, `http`, `sse`, `in-process` |
| 86 | `McpServerConfig` (discriminated union) | 🟡 YELLOW | `agent-base-types/src/domain.ts:214-240` | `types.ts:268-277` — flat type with `command?`, `args?`, `url?`, `config?`. Not a discriminated union — missing `env`, `headers`, `timeoutMs` per transport |
| 87 | Transport config validation (zod) | 🔴 RED | `agent-engine-orchestrator/src/validation/mcp.ts` | No zod validation schemas |
| 88 | Per-server tool filters (`allowedTools`/`disallowedTools`) | 🟢 GREEN | `agent-base-types/src/domain.ts:235-240` | `McpServerConfig.allowedTools` / `disallowedTools` in `types.ts:275-276` |
| 89 | Client registry (`McpClientRegistry`) | 🔴 RED | `agent-engine-orchestrator/src/clients/registry.ts` | No client registry. `ToolService` has `discoverTools()` stub but no lazy connection, no dedup, no connect-retry eviction |
| 90 | Self-referential guard | 🔴 RED | `agent-engine-orchestrator/src/clients/registry.ts:28-40` | No `isSelfReferential()` detection |
| 91 | Claude CLI MCP config mapping | 🔴 RED | `agent-engine-orchestrator/src/providers/claudecli.ts:203-231` | No MCP config mapping for Claude CLI |
| 92 | `IMcpClient` interface | 🔴 RED | `agent-engine-orchestrator/src/clients/types.ts` | No `listTools()` / `callTool()` / `close()` interface |
| 93 | MCP server store (registry) | 🟡 YELLOW | `agent-store-tools/src/store/mcp-server-store.ts` | `ToolService` has `registerServer()`/`listServers()` stubs, `mcpServers` table in schema.ts, but no `McpServerStore` with full CRUD + `providedToolIds[]` + `configSchema` |
| 94 | `StdioMcpClient` | 🔴 RED | `agent-engine-orchestrator/src/clients/stdio-client.ts` | No stdio transport implementation |
| 95 | `HttpMcpClient` | 🔴 RED | `agent-engine-orchestrator/src/clients/http-client.ts:65-92` | No HTTP transport implementation |
| 96 | `SseMcpClient` | 🔴 RED | `agent-engine-orchestrator/src/clients/http-client.ts:94-128` | No SSE transport implementation |
| 97 | `InProcessMcpClient` | 🔴 RED | `agent-engine-orchestrator/src/clients/in-process.ts` | No in-process transport implementation |
| | **10. Tool Naming (server__tool)** | | | |
| 98 | `TOOL_NAME_SEPARATOR = "__"` | 🔴 RED | `agent-engine-orchestrator/src/clients/tool-naming.ts:1` | No separator constant |
| 99 | `normalizeToolName()` | 🔴 RED | `agent-engine-orchestrator/src/clients/tool-naming.ts:3-5` | No normalization function |
| 100 | `resolveToolCallName()` | 🔴 RED | `agent-engine-orchestrator/src/clients/tool-naming.ts:19-35` | No tool call name resolution (ambiguous detection) |
| 101 | `splitToolName()` | 🔴 RED | `agent-engine-orchestrator/src/clients/tool-naming.ts:12-17` | No split-on-`__` function |
| 102 | `ResolvedToolName { server, tool }` | 🔴 RED | `agent-engine-orchestrator/src/clients/tool-naming.ts:7-10` | No plain `{ server, tool }` type. `ResolvedToolCall` in types.ts uses `serverId` + `toolName` — different shape |
| 103 | `resolveToolName()` (registry-side) | 🔴 RED | `agent-engine-orchestrator/src/clients/registry.ts:167-179` | No registry-side Map lookup |
| | **11. Allow / Deny Lists** | | | |
| 104 | MCP server tool filters | 🟢 GREEN | `agent-base-types/src/domain.ts:235-240` | `McpServerConfig.allowedTools` + `disallowedTools` in types |
| 105 | `isToolHidden()` / `assertToolAllowed()` | 🔴 RED | `agent-engine-orchestrator/src/clients/registry.ts:123-136` | No filter enforcement logic |
| 106 | Agent delegation allowlist | 🟡 YELLOW | `agent-base-types/src/domain.ts:242-244` | `AgentPolicy.allowedDelegations?: string[]` exists in types. No enforcement in PolicyService |
| 107 | Policy engine delegation check | 🔴 RED | `agent-engine-orchestrator/src/engine/policy.ts:90-111` | No 3-layer resolution (agent → template → server) |
| 108 | `PermissionLevel` (`full` / `read_only` / `restricted`) | 🟢 GREEN | `agent-store-tools/src/store/agent-tool-store.ts:17` | `types.ts:294` — exact match |
| 109 | `AgentToolGrant` | 🟢 GREEN | `agent-store-tools/src/store/agent-tool-store.ts:28-34` | `types.ts:296-301` — `agentName`, `toolName`, `permission`, `contextCondition` |
| 110 | `ToolPlatformBinding` with `availability` | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:33-39` | No platform binding type. No availability states |
| 111 | Claude CLI builtin tool filter | 🔴 RED | `agent-engine-orchestrator/src/providers/claudecli.ts:96-112` | No 12 built-in tools enum, no `--disallowedTools` |
| 112 | Claude CLI agent-spec mode | 🔴 RED | `agent-engine-orchestrator/src/providers/claudecli.ts:138-167` | No agent-spec mode |
| 113 | HITL tool opt-in (`allowHumanInput`) | 🟡 YELLOW | `agent-base-types/src/domain.ts:272` | `AgentPolicy.allowHumanInput?: boolean` exists. No HITL builtin tool or condition check |
| 114 | HITL builtin tool definition | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:32-48` | No `builtin__request_human_input` tool |
| 115 | Env-var name guard | 🔴 RED | `agent-engine-orchestrator/src/validation/agent.ts:133-155` | No `buildEnvNameGuard()`, no `assertEnvNamesAllowed()` |
| | **12. Agent Delegation Tracking** | | | |
| 116 | `callingAgentName` | 🔴 RED | `agent-base-types/src/domain.ts:308` | No `ExecutionContext` type at all |
| 117 | `rootTaskId` | 🔴 RED | `agent-base-types/src/domain.ts:310-311` | No `ExecutionContext` type |
| 118 | `parentTaskId` on Task | 🟢 GREEN | `agent-base-types/src/domain.ts:65` | `Task.parentTaskId` in `types.ts:165` |
| 119 | `recursionDepth` on Task | 🟢 GREEN | `agent-base-types/src/domain.ts:64` | `Task.recursionDepth` in `types.ts:166` |
| 120 | `delegationSessions` Set tracking | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:141` | No delegation session tracking |
| 121 | Delegation session creation (`agentTool`) | 🔴 RED | `agent-engine-orchestrator/src/tools/session.ts:36-92` | No delegation tool |
| 122 | Delegation cleanup on failure | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:863-871` | No cleanup logic |
| | **13. Policy Engine** | | | |
| 123 | `PolicyEngine` class | 🔴 RED | `agent-engine-orchestrator/src/engine/policy.ts:48-113` | `PolicyService.evaluate()` stub exists but no depth/loop caps, no `PolicyConfig` |
| 124 | `PolicyConfig` (serverDepth, loops, allowlist) | 🔴 RED | `agent-engine-orchestrator/src/engine/policy.ts:9-14` | No server-level config |
| 125 | Policy template store | 🔴 RED | `agent-core-policy/src/store/policy-template-store.ts` | No `PolicyTemplateStore` with `create`/`read`/`list` |
| 126 | Agent policy store (attach, resolve) | 🔴 RED | `agent-core-policy/src/store/agent-policy-store.ts` | No `AgentPolicyStore` |
| 127 | Category inheritance (lazy, no fanout) | 🔴 RED | `agent-core-policy/src/store/agent-policy-store.ts:310-357` | `PolicyService` has `getEffectivePolicy()` stub but no 3-query merge |
| 128 | Shallow-merge override | 🔴 RED | `agent-core-policy/src/store/agent-policy-store.ts:374-392` | No `resolveEffectiveRules()` |
| 129 | 7 seeded policy types | 🔴 RED | `agent-core-policy/src/seed/policy-types.ts:20-49` | No `POLICY_TYPES` seed data |
| 130 | 9 seeded policy templates | 🔴 RED | `agent-core-policy/src/seed/policy-templates.ts:46-219` | No `POLICY_TEMPLATES` seed data |
| 131 | 5 enforcement mechanisms (`agent`, `ci`, `hook`, `runtime`, `settings`) | 🔴 RED | `agent-core-policy/src/seed/policy-templates.ts` | No enforcement mechanism support |
| 132 | Rate policy plugin | 🔴 RED | `agent-core-policy/src/index.ts:42-48` | No rate policy plugin |
| 133 | `evaluateRatePolicy()` | 🔴 RED | `agent-core-policy/src/plugin/rate-policy.ts` | No rate policy evaluator |
| 134 | `PolicyRule` type | 🟢 GREEN | `types.ts:309-320` — `id`, `name`, `scope`, `scopeName`, `ruleType`, `config`, `action`, `enabled`, timestamps |
| 135 | `PolicyVerdict` type | 🟢 GREEN | `types.ts:322-326` — `allowed`, `reason?`, `action?` |
| 136 | `EffectivePolicy` type | 🟢 GREEN | `types.ts:328-330` — `{ rules: PolicyRule[] }` |
| | **14. Provider Adapter Interface** | | | |
| 137 | `LLMProvider` interface | 🔴 RED | `agent-engine-orchestrator/src/providers/types.ts:23-25` | No `LLMProvider` interface. Uses AI SDK `LanguageModel` directly |
| 138 | `ProviderChatRequest` / `ProviderChatResponse` | 🔴 RED | `agent-engine-orchestrator/src/providers/types.ts:5-21` | No provider chat types |
| 139 | Provider factory (`createProvider`) | 🔴 RED | `agent-engine-orchestrator/src/providers/factory.ts:8-26` | `modelFromProvider()` stub exists but only wraps AI SDK — no discriminated union on provider type |
| 140 | Anthropic provider implementation | 🔴 RED | `agent-engine-orchestrator/src/providers/anthropic.ts` | No Anthropic-specific provider. Via AI SDK |
| 141 | OpenAI provider implementation | 🔴 RED | `agent-engine-orchestrator/src/providers/openai.ts` | No OpenAI-specific provider. Via AI SDK |
| 142 | Claude CLI provider implementation | 🔴 RED | `agent-engine-orchestrator/src/providers/claudecli.ts` | No Claude CLI subprocess provider |
| 143 | `ProviderConfig` (discriminated union) | 🔴 RED | `agent-base-types/src/domain.ts:154-212` | No discriminated union; `Account.providerType: string` + `AccountCredentials` union instead |
| 144 | `ProviderEnvBlock` (env-var NAME pointers) | 🔴 RED | `agent-base-types/src/domain.ts:145-152` | `AccountCredentials` has `env-ref` variant but no `secret?`/`base_url?`/`model?` pointer pattern |
| 145 | Provider timeout via `AbortSignal.any` | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:272-277` | No combined abort signal logic |
| 146 | Provider error classification | 🔴 RED | `agent-engine-orchestrator/src/engine/orchestrator.ts:354-412` | `classifyProviderError()` stub exists in `ai/classify-error.ts` but throws "Not implemented" |
| 147 | `ProviderAdapterImpl` (streaming) | 🔴 RED | `agent-core-provider/src/adapter/provider-adapter.ts:22-54` | No `ProviderAdapter` implementation. Via AI SDK |
| | **15. Retry / Config Handling** | | | |
| 148 | `RetryConfig` type | 🔴 RED | `agent-base-types/src/domain.ts:126-131` | No `RetryConfig` type in agent-client |
| 149 | `retryConfigSchema` (zod defaults) | 🔴 RED | `agent-engine-orchestrator/src/validation/agent.ts:7-12` | No zod retry schema |
| 150 | p-retry on providers | 🔴 RED | `agent-engine-orchestrator/src/providers/anthropic.ts:304-326` | No p-retry usage |
| 151 | `EngineConfig` | 🔴 RED | `agent-engine-orchestrator/src/interfaces.ts:9-58` | No engine config interface. Agent-client scopes config per-account and per-session |
| 152 | `EngineLogger` | 🔴 RED | `agent-engine-orchestrator/src/interfaces.ts:66-71` | No injectable logger |
| 153 | Provider timeout per config | 🔴 RED | `agent-base-types/src/domain.ts:163,178,187` | No `timeoutMs` on provider config |
| 154 | MCP server timeout | 🔴 RED | `agent-engine-orchestrator/src/clients/stdio-client.ts:85-91` | No MCP timeout |
| | **16. Session Message Format** | | | |
| 155 | `MessageRole` union | 🟢 GREEN | `agent-base-types/src/domain.ts:101` | `types.ts:192` — `'system' | 'user' | 'assistant' | 'tool'` |
| 156 | `ToolCall` type | 🟢 GREEN | `agent-base-types/src/domain.ts:103-108` | `types.ts:201-206` — `id`, `server`, `tool`, `arguments` |
| 157 | `ToolResult` type | 🟢 GREEN | `agent-base-types/src/domain.ts:110-114` | `types.ts:208-212` — `toolCallId`, `result`, `isError?` |
| 158 | `Message` type | 🟢 GREEN | `agent-base-types/src/domain.ts:116-124` | `types.ts:214-226` — adds `parentMessageId`, `generatedBy`, `compactedIds`, `compactedBy` beyond inventory |
| 159 | `MessageProvenance` type | 🟢 GREEN | N/A (agent-client addition) | `types.ts:194-199` — `accountId`, `model`, `agentName`, `providerType` |
| 160 | `Session` type | 🟢 GREEN | `agent-base-types/src/domain.ts:91-99` | `types.ts:131-141` — `id`, `agentName`, `agentSnapshot`, `accountId`, `model`, `status`, timestamps. Adds `accountId`+`model` binding and `agentSnapshot` over inventory |
| 161 | `SessionStatus` | 🟢 GREEN | `agent-base-types/src/domain.ts:89` | `'active' | 'closed'` in `Session.status` type |
| 162 | `SessionStore` behavior | 🔴 RED | `agent-store-runtime/src/store/session-store.ts` | `SessionService` has stubs but no `create` with agentData snapshot, no `clearMessages`, no `getAgentDefinition` |
| 163 | `composedPromptId` on sessions | 🔴 RED | `agent-store-runtime/src/db/schema.ts:24` | No `composedPromptId` field on sessions table |
| 164 | `agentData` / `agentSnapshot` on sessions | 🟢 GREEN | `agent-store-runtime/src/db/schema.ts:17` | `sessions.agentSnapshot` in `schema.ts:102` — JSON column |
| 165 | Session `fork` | 🟡 YELLOW | `session.ts:63-69` | Stub exists with correct signature. `Orchestrator.forkAndRun()` also stubbed |
| | **17. Usage Tracking** | | | |
| 166 | `TokenUsage` shape (fine-grained) | 🟢 GREEN | `agent-base-types/src/domain.ts:15-38` | `UsageRecord` in `types.ts:230-250` — all fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `uncachedInputTokens`, `reasoningTokens`, `peakContextTokens`. Also adds `cost`, `latencyMs`, `modelCalls` |
| 167 | Per-provider normalisation (Anthropic) | 🔴 RED | `agent-engine-orchestrator/src/providers/anthropic.ts:54-78` | `normalizeUsage()` stub in `ai/normalize-usage.ts` but throws "Not implemented" |
| 168 | Per-provider normalisation (OpenAI/DeepSeek) | 🔴 RED | `agent-engine-orchestrator/src/providers/openai.ts:31-63` | Same `normalizeUsage()` stub — no provider-specific logic |
| 169 | `task_usage` DB table | 🟡 YELLOW | `agent-store-runtime/src/db/schema.ts:133-169` | `usageRecords` table in `schema.ts:181-201` — similar shape but missing: `stopReason`, `maxTokens`, `toolCallCount`, `peakContextAt`, `isComplete` |
| 170 | `UsagePlugin` (hook-based recording) | 🔴 RED | `agent-engine-orchestrator/src/plugins/usage-plugin.ts:42-198` | No usage plugin. Usage recording is explicit via `UsageService.record()` |
| 171 | `UsageClient` (in-memory accumulator) | 🔴 RED | `agent-store-runtime/src/runtime/usage-client.ts` | `UsageService` has `record`/`rollup` stubs but no in-memory accumulator, no DB-scoped aggregation |
| 172 | Grouped usage query (`group_by`) | 🔴 RED | `agent-engine-orchestrator/src/tools/usage.ts:89-209` | No grouped query support |
| 173 | `buildTaskUsageReport()` | 🔴 RED | `agent-engine-orchestrator/src/tools/usage.ts:211-232` | No task usage report |
| 174 | `peakContextTokens` MAX (not SUM) invariant | 🔴 RED | `agent-store-runtime/src/db/schema.ts:159-163` | No peak context tracking logic |
| 175 | `UsageRollup` type | 🟢 GREEN | `types.ts:252-262` — `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `uncachedInputTokens`, `reasoningTokens`, `cost`, `modelCalls`, `latencyMs` |
| | **18. Budget Plugin** | | | |
| 176 | 9 cap dimensions | 🔴 RED | `agent-plugin-budget/src/index.ts:38-48` | No budget plugin at all |
| 177 | 4 scopes (task, session, agent, global) | 🔴 RED | `agent-plugin-budget/src/index.ts:54` | No budget plugin |
| 178 | 2 modes (warning, block) | 🔴 RED | `agent-plugin-budget/src/index.ts:56` | No budget plugin |
| 179 | Config hierarchy (defaults → agent → provider → tool) | 🔴 RED | `agent-plugin-budget/src/index.ts:75-104` | No budget plugin |
| 180 | ISO8601 duration parser | 🔴 RED | `agent-plugin-budget/src/index.ts:20-34` | No duration parser |
| 181 | Response size enforcement | 🔴 RED | `agent-plugin-budget/src/index.ts:759-831` | No budget plugin |
| 182 | Backward compat flat config | 🔴 RED | `agent-plugin-budget/src/index.ts:112-147` | No budget plugin |
| 183 | Scope-aware DB queries | 🔴 RED | `agent-plugin-budget/src/index.ts:395-538` | No budget plugin |
| | **19. Sanitize Plugin** | | | |
| 184 | 3 strategies (none, prefix, wrap) | 🔴 RED | `agent-plugin-sanitize/src/index.ts:19` | No sanitize plugin at all |
| 185 | Delegation-only mode | 🔴 RED | `agent-plugin-sanitize/src/index.ts:31` | No sanitize plugin |
| 186 | Per-agent overrides | 🔴 RED | `agent-plugin-sanitize/src/index.ts:25` | No sanitize plugin |
| 187 | `transform:tool_result` hook wiring | 🔴 RED | `agent-plugin-sanitize/src/index.ts:70-121` | No sanitize plugin |
| | **20. Agent Definition & CRUD** | | | |
| 188 | `Agent` type with lifecycle | 🟢 GREEN | `agent-base-types/src/domain.ts:246-281` | `types.ts:100-111` — `name`, `description`, `status` (draft/active/deprecated), `category`, `tools`, `policy`, `tags`, `version`, timestamps. Different from inventory's `AgentDefinition` (no `provider`, `systemPrompt`, `mcpServers` — scoped differently) |
| 189 | Agent CRUD methods | 🟡 YELLOW | `agent-engine-orchestrator/src/tools/agent-crud.ts` | `AgentService` has `create`, `get`, `list`, `update`, `delete` stubs. All throw "Not implemented" |
| 190 | Agent delete force (close active sessions) | 🟡 YELLOW | `agent-engine-orchestrator/src/tools/agent-crud.ts:39-52` | `delete(name, force?)` stub exists with correct signature |
| 191 | Agent patch (partial update) | 🟡 YELLOW | `agent-engine-orchestrator/src/validation/agent.ts:190-199` | `update()` stub exists with partial params |
| 192 | Agent status lifecycle (`draft` → `active` → `deprecated`) | 🟢 GREEN | `agent-store-prompts/src/store/agent-store.ts:26` | `Agent.status` type in `types.ts:103` |
| 193 | `AgentPosture` (`approve` / `needs_work`) | 🔴 RED | `agent-store-prompts/src/store/agent-store.ts:29` | Not present — agent-client doesn't have posture concept |
| 194 | Agent validation schemas (zod) | 🔴 RED | `agent-engine-orchestrator/src/validation/agent.ts:100-221` | No zod validation schemas |
| 195 | Legacy shim (`lmstudio`→`openai`, `apiKeyEnv`→`env.secret`) | 🔴 RED | `agent-engine-orchestrator/src/validation/agent.ts:55-85` | No legacy shim |
| 196 | `AgentPolicy` (inline on Agent) | 🟢 GREEN | `agent-base-types/src/domain.ts` | `types.ts:113-119` — `maxToolLoops`, `allowedDelegations`, `maxRecursionDepth`, `toolAdvertisement`, `allowHumanInput` |
| 197 | Taxonomy `Category` type | 🟢 GREEN | `agent-store-prompts/src/store/agent-store.ts:31-38` | `types.ts:90-96` — `slug`, `name`, `description`, `position`, `parentSlug` |
| 198 | Taxonomy category CRUD | 🟡 YELLOW | `agent-store-prompts/src/store/agent-store.ts:102-157` | `AgentService.createCategory()`/`listCategories()` stubs exist |
| | **21. Tool Stores (Registry-Side)** | | | |
| 199 | Canonical `Tool` type | 🟡 YELLOW | `agent-store-tools/src/store/tool-store.ts:18-27` | `ToolDef` in `types.ts:279-286` — has `name`, `type`, `description`, `inputSchema`, `requiresApproval`, `isDestructive`. Missing: `version`, `dependencyToolIds[]`, `capabilities[]` |
| 200 | `ToolType` (slug, description) | 🔴 RED | `agent-store-tools/src/store/tool-store.ts:12-15` | No separate `ToolType` concept |
| 201 | `ToolStore` full CRUD | 🟡 YELLOW | `agent-store-tools/src/store/tool-store.ts:67-177` | `ToolService` has `registerTool`, `getTool`, `listTools`, `updateTool`, `deleteTool` stubs. No `seedToolType`, `listToolTypes` |
| 202 | `AgentToolGrant` store | 🟡 YELLOW | `agent-store-tools/src/store/agent-tool-store.ts:101-214` | `ToolService` has `grantTool`, `listGrants`, `revokeGrant` stubs |
| 203 | `ToolPlatformBinding` | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:33-39` | No platform binding type. No binding store |
| 204 | Forward resolve (`resolve(canonical, platformId)`) | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:194-214` | No forward resolve |
| 205 | Reverse resolve (`resolveCanonical(platform, platformId)`) | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:245-265` | No reverse resolve |
| 206 | `listForPlatform()` | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:271-285` | No list-for-platform |
| 207 | `Platform` type (`id`, `name`, `headerFormat`, `supportsToolSelection`) | 🔴 RED | `agent-store-tools/src/store/binding-store.ts:12-17` | No platform type |
| 208 | `McpServer` registry type (with `providedToolIds[]`, `configSchema`) | 🔴 RED | `agent-store-tools/src/store/mcp-server-store.ts:19-24` | `McpServerConfig` in types is transport-oriented, not registry-oriented |
| 209 | Seed data (8 tool types, 15 tools, 6 platforms, bindings) | 🔴 RED | `agent-store-tools/src/seed/` | No seed data |
| | **22. Prompt Component System** | | | |
| 210 | `Component` type | 🟢 GREEN | `agent-store-prompts/src/store/component-store.ts:38-53` | `types.ts:54-61` — `slug`, `type`, `description`, `isShared`, timestamps. Missing: `version`, `versionId`, `content` (content is in `ComponentVersion`) |
| 211 | `ComponentVersion` type | 🟢 GREEN | `agent-store-prompts/src/db/schema.ts:96-114` | `types.ts:63-70` — `versionId` (autoIncrement), `slug`, `version`, `content`, timestamps |
| 212 | `PromptType` (slug, description, isSystem) | 🔴 RED | `agent-store-prompts/src/store/component-store.ts:32-36` | No `PromptType` concept. Component `type` is a plain string |
| 213 | `ComponentStore` (atomic head+v1 `create`) | 🟡 YELLOW | `agent-store-prompts/src/store/component-store.ts:84-454` | `AgentService.createComponent()` stub exists but no atomic head+v1, no `readVersion`, no `resolveVersionId`, no `version` (bump) |
| 214 | `resolveComponentVersion()` | 🟡 YELLOW | `agent.ts:153-155` | Stub exists — correct signature |
| 215 | `CompositionStore.attach()` with version pin | 🟡 YELLOW | `agent-store-prompts/src/store/composition-store.ts:133-161` | `AgentService.attachComponent()` stub exists with `versionPin`, `contextCondition`, `isRequired` opts |
| 216 | `CompositionEntry` type | 🟢 GREEN | `agent-store-prompts/src/store/composition-store.ts` | `types.ts:72-79` — `agentName`, `componentSlug`, `position`, `versionPin?`, `contextCondition?`, `isRequired?` |
| 217 | `ResolvedComponent` type | 🟢 GREEN | `agent-store-prompts/src/store/composition-store.ts:41-50` | `types.ts:81-86` — `componentSlug`, `position`, `resolvedVersion`, `content` |
| 218 | `CompositionContext` (`Record<string, string>`) | 🟢 GREEN | `agent-store-prompts/src/store/composition-store.ts:38` | `context?: Record<string, string>` on `resolveComposition()` |
| 219 | Composition reorder | 🟡 YELLOW | `agent.ts:195-197` | Stub exists — `reorderComponents(agentName, orderedSlugs)` |
| 220 | `UseCaseStore` | 🔴 RED | `agent-store-prompts/src/store/usecase-store.ts:88-238` | No use-case store. No use-case concept in agent-client |
| 221 | Context rules (additive, `contextRulesFor`) | 🔴 RED | `agent-store-prompts/src/store/usecase-store.ts:193-237` | No context rules concept. `CompositionEntry.contextCondition` exists but no additive resolution |
| 222 | Version pinning (null = latest, int = exact) | 🔴 RED | `agent-store-prompts/src/store/composition-store.ts:316-376` | No pinning resolution logic |
| 223 | `versionComponent()` (bump) | 🟡 YELLOW | `agent.ts:138-140` | Stub exists — `versionComponent(slug, content)` |
| 224 | Component search (FTS5 hybrid) | 🟡 YELLOW | `agent.ts:262-264` | Stub exists — `searchComponents(query, opts)`. No FTS5 or vector/Hybrid search |
| 225 | Component delete | 🟡 YELLOW | `agent.ts:161-163` | Stub exists — `deleteComponent(slug)` |
| 226 | `toSlug()` utility | 🟡 YELLOW | `agent.ts:297-299` | Stub exists — throws "Not implemented" |
| | **23. Compat Shim** | | | |
| 227 | Flat `systemPrompt` → component shim | 🟡 YELLOW | `agent-store-prompts` / `agent-mcp` compat | `AgentService.create()` accepts `systemPrompt` param, `shimFromSystemPrompt()` stub exists. `CompatShim` type in `types.ts:123-127`. No inline component creation logic |
| 228 | `systemPrompt` + `components` mutual exclusion | 🔴 RED | `entrypoint/agent-mcp/src/validation/agent.ts` | No mutual exclusion validation |
| | **24. Agent-MCP Authoring Tools** | | | |
| 229 | `component_define` (content-only upsert) | 🟡 YELLOW | `contexts/component-define.md` | `AgentService.createComponent()` stub — but no idempotent upsert, no `enrichComponent`, no auto-summary/use-cases |
| 230 | `component_delete` (symmetric) | 🟡 YELLOW | `contexts/component-define.md` | `AgentService.deleteComponent()` stub — but no orphan detection or shared-component consumer list |
| 231 | `agent_define` (transactional upsert) | 🟡 YELLOW | `contexts/agent-define.md` | `AgentService.create()` stub accepts `components` + `tools` + `policy` — but no transactional across stores, no compile step, no `composed_prompt_id` return |
| 232 | Discovery tools (read-only, 11 tools) | 🔴 RED | `contexts/discovery-tools.md` | No discovery lane tools. `AgentService.searchComponents()`/`searchAgents()` stubs exist but no `component_search`, `agent_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`, etc. |
| 233 | Bounded output (default limit + summary projection) | 🔴 RED | `contexts/discovery-tools.md` | No bounded-output enforcement |
| 234 | Name→slug translation seam (`registry-bridge`) | 🔴 RED | `contexts/name-slug-seam.md` | `AgentService.toSlug()` stub but no bridge module, no outbound slug-stripping |
| 235 | Embedding & vector infrastructure (5 sox packages) | 🔴 RED | `contexts/embedding-substrate.md` | No embedding provider, no vector store, no ingest, no hybrid search, no graph store |
| 236 | `enrichComponent` pipeline | 🔴 RED | `contexts/enrichment-pipeline.md` | No enrichment pipeline at all |
| 237 | Use-case anchors seed | 🔴 RED | `contexts/embedding-substrate.md` | No use-case anchor seed |
| 238 | 11-tool runtime hot path invariant | 🔴 RED | `contexts/_shared.md` | No delegation surface concept. No tool lane distinction |
| 239 | Provider matrix (3 real LLM providers for e2e) | 🔴 RED | `contexts/live-model-e2e.md` | `AccountService` covers multiple provider types but no provider matrix concept |
| 240 | Back-out guarantee (modification manifest) | 🔴 RED | `decisions.md §D3` | Not applicable — agent-client is a new entrypoint, not modifying agent-mcp |
| | **25. Dispatch-Orchestrator Overlap** | | | |
| 241 | `IDispatchAgentRunner` interface | 🟢 GREEN | `dispatch-completion inventory §12.1` | `types.ts:395-400` — `ensureAgent`, `fire`, `poll`, `cancel`. Correct signatures |
| 242 | `Orchestrator implements IDispatchAgentRunner` | 🟢 GREEN | `dispatch-completion inventory §12.1` | `orchestrator.ts:33` — `class Orchestrator implements IDispatchAgentRunner` |
| 243 | `DispatchUnit` type | 🟢 GREEN | `dispatch-completion inventory §12.1` | `types.ts:387-393` — `id`, `agentName`, `prompt`, `provider?`, `contextFiles?` |
| 244 | `AgentMcpRunner` (real implementation) | 🔴 RED | `dispatch-completion inventory §12.1` | `Orchestrator` serves as the runner but all IDispatchAgentRunner methods throw "Not implemented" |
| 245 | `SynthesizedTurn` | 🔴 RED | `dispatch-completion inventory §12.1` | No `SynthesizedTurn` type |
| 246 | `DispatchTaskStatus` | 🔴 RED | `dispatch-completion inventory §12.2` | `DispatchUnitStatus` in `types.ts:385` — `'pending' | 'in_progress' | 'complete' | 'failed'`. Different from dispatch-completion spec |
| 247 | `DispatchUsageReport` | 🔴 RED | `dispatch-completion inventory §12.1` | No `DispatchUsageReport` type |
| 248 | Orchestrator pipeline (load → snapshot → enrich → optimize → fire → poll → guard → log) | 🔴 RED | `dispatch-completion inventory §12.2` | `Orchestrator` is a turn-level loop, not a dispatch-orchestrator pipeline |
| 249 | Causal-aware replan (`injectCorrectionMilestone`) | 🔴 RED | `dispatch-completion inventory §5.6` | Not in scope — dispatch-orchestrator feature |
| 250 | Per-unit error boundary | 🔴 RED | `dispatch-completion inventory §5.1` | Not in scope |
| 251 | Op-level guard routing | 🔴 RED | `dispatch-completion inventory §5.2` | Not in scope |
| 252 | `ExecutionMode` (`generative` / `tool-call` / `guard-only`) | 🔴 RED | `dispatch-completion inventory §1.1` | Not in scope |
| 253 | `ICalibrationStore` | 🔴 RED | `dispatch-completion inventory §1.2` | Not in scope |
| 254 | `ReplanNote` type | 🔴 RED | `dispatch-completion inventory §1.5` | Not in scope |
| 255 | `TypeSpecEntry` type | 🔴 RED | `dispatch-completion inventory §1.4` | Not in scope |
| 256 | `system_prompt` / `task_prompt` split | 🔴 RED | `dispatch-completion inventory §1.6` | Not in scope |
| 257 | `mcp_servers` on MilestoneDag/DagJson | 🔴 RED | `dispatch-completion inventory §1.7` | Not in scope |
| 258 | `patchDag()` function | 🔴 RED | `dispatch-completion inventory §1.8` | Not in scope |
| 259 | Algorithm cascade (Bitmask DP, Tree DP, SA, HLFET) | 🔴 RED | `dispatch-completion inventory §10` | Not in scope — data-gated |
| 260 | Stepwise dispatch A/B experiment | 🔴 RED | `dispatch-completion inventory §11` | Not in scope |
| 261 | Live E2E testing (8 scenarios) | 🔴 RED | `dispatch-completion inventory §13` | Not in scope |
| | **26. DB Schema** | | | |
| 262 | `accounts` table | 🟢 GREEN | `schema.ts:11-20` | Full Drizzle schema |
| 263 | `agents` table | 🟢 GREEN | `schema.ts:26-37` | Full Drizzle schema |
| 264 | `components` table | 🟢 GREEN | `schema.ts:43-50` | Full Drizzle schema |
| 265 | `component_versions` table | 🟢 GREEN | `schema.ts:56-63` | Full Drizzle schema with `versionId` autoIncrement |
| 266 | `agent_components` table (composition junction) | 🟢 GREEN | `schema.ts:72-81` | Full Drizzle schema with `versionPin`, `contextCondition`, `isRequired` |
| 267 | `categories` table | 🟢 GREEN | `schema.ts:87-93` | Full Drizzle schema with `parentSlug` self-FK |
| 268 | `sessions` table | 🟢 GREEN | `schema.ts:99-109` | Full Drizzle schema with `agentSnapshot` JSON |
| 269 | `experiment_assignments` table | 🟢 GREEN | `schema.ts:115-121` | Full Drizzle schema |
| 270 | `tasks` table | 🟢 GREEN | `schema.ts:127-145` | Full Drizzle schema with DAG fields (`dependsOn`, `onUpstreamFailure`, `inputs`, `resumeToken`) |
| 271 | `task_events` table | 🟢 GREEN | `schema.ts:151-157` | Full Drizzle schema |
| 272 | `messages` table | 🟢 GREEN | `schema.ts:163-175` | Full Drizzle schema with `compactedIds`, `compactedBy` |
| 273 | `usage_records` table | 🟢 GREEN | `schema.ts:181-201` | Full Drizzle schema with fine-grained token fields |
| 274 | `tools` table | 🟢 GREEN | `schema.ts:207-214` | Full Drizzle schema |
| 275 | `mcp_servers` table | 🟢 GREEN | `schema.ts:220-229` | Full Drizzle schema |
| 276 | `agent_tools` table (grants) | 🟢 GREEN | `schema.ts:235-240` | Full Drizzle schema |
| 277 | `policy_rules` table | 🟢 GREEN | `schema.ts:246-257` | Full Drizzle schema |
| 278 | Indices (25 indices) | 🟢 GREEN | `schema.ts:263-286` | All indices defined |
| 279 | `createClient()` factory | 🟢 GREEN | `db/client.ts:13-18` | IMPLEMENTED — real code, not a stub. Creates `better-sqlite3` + Drizzle with WAL + FK pragmas |
| 280 | `migrate()` function | 🟡 YELLOW | `db/migrate.ts:12-14` | Stub — throws "Not implemented" |
| | **27. AI Utilities** | | | |
| 281 | `modelFromProvider()` | 🟡 YELLOW | `ai/build-model.ts:14-18` | Stub — throws "Not implemented". Correct signature returning AI SDK `LanguageModel` |
| 282 | `buildAisdkTools()` | 🟡 YELLOW | `ai/build-tool.ts:14-16` | Stub — throws "Not implemented". Correct signature returning AI SDK `ToolSet` |
| 283 | `normalizeUsage()` | 🟡 YELLOW | `ai/normalize-usage.ts:14-18` | Stub — throws "Not implemented". Correct signature |
| 284 | `classifyProviderError()` | 🟡 YELLOW | `ai/classify-error.ts:14-16` | Stub — throws "Not implemented". Correct signature |
| | **28. adhd-environment (ALL RED per instructions)** | | | |
| 285 | YAML static spec (`adhd.environment.yaml`) | 🔴 RED | `adhd-environment inventory §2` | SEPARATE PACKAGE — not in agent-client scope |
| 286 | Builder pipeline (17-step `build()`) | 🔴 RED | `adhd-environment inventory §3` | SEPARATE PACKAGE |
| 287 | Runtime client (`Environment<T>`) | 🔴 RED | `adhd-environment inventory §4` | SEPARATE PACKAGE |
| 288 | CLI (`adhd-env`, 9 commands) | 🔴 RED | `adhd-environment inventory §5` | SEPARATE PACKAGE |
| 289 | 3-tier scope cascade (system/global/project) | 🔴 RED | `adhd-environment inventory §6` | SEPARATE PACKAGE |
| 290 | `mergeFieldDefinitions()` | 🔴 RED | `adhd-environment inventory §6` | SEPARATE PACKAGE |
| 291 | Directory registry (type-first) | 🔴 RED | `adhd-environment inventory §7` | SEPARATE PACKAGE |
| 292 | Env var inference (`inferEnvVar`, `projectEnvPrefix`) | 🔴 RED | `adhd-environment inventory §8` | SEPARATE PACKAGE |
| 293 | `contentHash` (SHA-256, sorted key=value) | 🔴 RED | `adhd-environment inventory §9` | SEPARATE PACKAGE |
| 294 | `structureHash` (directory structure) | 🔴 RED | `adhd-environment inventory §9` | SEPARATE PACKAGE |
| 295 | Provenance tracking (`ProvenanceEntry`) | 🔴 RED | `adhd-environment inventory §10` | SEPARATE PACKAGE |
| 296 | JSON Schema generation (`generateFieldSchema`) | 🔴 RED | `adhd-environment inventory §11` | SEPARATE PACKAGE |
| 297 | Cross-language parity (Python + Rust) | 🔴 RED | `adhd-environment inventory §12` | SEPARATE PACKAGE |
| 298 | Validation & drift detection | 🔴 RED | `adhd-environment inventory §13` | SEPARATE PACKAGE |
| 299 | Agent-mcp refactor (delete `config.ts`) | 🔴 RED | `adhd-environment inventory §14` | SEPARATE — agent-mcp concern |
| 300 | Audit infrastructure (run-audit.js, criteria.json) | 🔴 RED | `adhd-environment inventory §15` | SEPARATE — plan infrastructure |
| 301 | Cross-language equivalence defects (ENV-CORE-001–007) | 🔴 RED | `adhd-environment inventory §12` | SEPARATE PACKAGE |
| 302 | Atomic snapshot writes (`.tmp` + `renameSync`) | 🔴 RED | `adhd-environment inventory §13` | SEPARATE PACKAGE |
| | **29. Runtime / Entrypoint** | | | |
| 303 | `Runtime` class (top-level wiring) | 🟢 GREEN | `runtime.ts:37-78` | IMPLEMENTED — real code. Wires all 9 services + orchestrator + DB |
| 304 | `Runtime.close()` | 🟡 YELLOW | `runtime.ts:87-89` | Stub — throws "Not implemented" |
| 305 | Console entrypoint (CLI runner) | 🔴 RED | `entrypoint/agent-client` | No CLI runner. Only library exports |
| | **30. Tests** | | | |
| 306 | Smoke test | 🟢 GREEN | `__tests__/smoke.spec.ts` | 12 assertions covering exports, types, constructor wiring, `IDispatchAgentRunner` interface conformance |
| 307 | Service method tests | 🔴 RED | Various `__tests__/` in `packages/agent/*` | Only one smoke test file. No service-specific tests |
| 308 | Integration / E2E tests | 🔴 RED | `dispatch-completion inventory §13` / `agent-mcp-authoring inventory §16` | No integration tests |

---

## Key Findings

### What's solid (GREEN = 83):
- **Types layer** is comprehensive — all core domain types (`AgentErrorCode`, `Task`, `Message`, `Session`, `UsageRecord`, `McpServerConfig`, `PolicyRule`, `Plugin`, `Component`, `ComponentVersion`, `IDispatchAgentRunner`, `DispatchUnit`, etc.) are correctly typed with matching signatures
- **DB schema** is fully defined with 16 tables + 25 indices in Drizzle
- **DB client** `createClient()` is real implemented code (not a stub)
- **Runtime** class wires all services and orchestrator with real constructor logic
- **Smoke test** validates the skeleton structure
- **Orchestrator** implements `IDispatchAgentRunner` with correct method signatures

### What's stubbed but incomplete (YELLOW = 41):
- **All 9 services** have correct method signatures but every method throws "Not implemented"
- **Orchestrator** has `runTurn`, `streamTurn`, `forkAndRun`, `runTask`, `ensureAgent`, `fire`, `poll`, `cancel` — all throwing
- **`resolveComposedPrompt()`/`resolveComposition()`** exist as the compiler replacement but are not implemented
- **`classifyProviderError()`, `normalizeUsage()`, `modelFromProvider()`, `buildAisdkTools()`** — AI utilities with correct signatures but no implementation
- **`migrate()`** — database migrator stub
- **`Runtime.close()`** — cleanup stub

### What's missing (RED = 184):
- **Agent compilation pipeline** — intentionally deleted (replaced by `resolveComposedPrompt()`)
- **Composed prompt cache** — no `ComposedPrompt` type, no SHA-256 context hash, no cache store
- **Context window management** — no compaction, no token estimation, no `contextWindowFor`
- **Tool naming** (`server__tool`) — no separator, no normalization, no ambiguous resolution
- **Provider adapter** — no `LLMProvider` interface, no factory, no concrete providers (offloaded to AI SDK)
- **Retry/config** — no `RetryConfig`, no p-retry, no `EngineConfig`, no `EngineLogger`
- **Budget plugin** — entire 9-dimension cap system absent
- **Sanitize plugin** — entire 3-strategy system absent
- **DAG engine** — no cycle detection, no `dispatchReady`, no optimistic locking
- **MCP transport implementations** — no stdio/HTTP/SSE/in-process clients (only schema)
- **Tool naming resolution** — no `normalizeToolName`, `resolveToolCallName`, `splitToolName`
- **HITL flow** — no builtin tool, no resolveHitl, no resumeToken generation flow
- **Agent delegation tracking** — no `ExecutionContext`, no `delegationSessions`, no cleanup
- **Policy engine** — no template store, no category inheritance, no rate policy, no 7 seeded types
- **Seed data** — no tool types, tools, platforms, bindings, policy templates, providers, models
- **All adhd-environment features** — separate package, intentionally out of scope
- **All dispatch-orchestrator features** (causal replan, algorithm cascade, stepwise dispatch, enrichment plugins, CLI) — separate package, intentionally out of scope
- **Agent-mcp authoring** — no discovery lane tools, no embedding/vector infrastructure, no enrichment pipeline, no name→slug bridge
- **Per-store error classes** — only `AgentError` class; no `ComponentError`, `CompositionError`, `PolicyError`, `ToolStoreError`, etc.
- **Plugin external loader** — no `findConfigFile`, `loadConfigFile`, `loadExternalPlugins`
- **3-phase tool execution** — no serial pre-dispatch, no concurrent execution, no transform hooks
- **Tool platform bindings** — no `ToolPlatformBinding`, no forward/reverse resolve, no `Platform` type
