# Complete Agent Package Feature Inventory

## 1. ERROR TAXONOMY

**21 error codes** defined in one canonical set (`AgentMcpErrorCode`):

| Source | File | Code(s) |
|--------|------|---------|
| Canonical union | `agent-base-types/src/errors.ts` | All 21: `AGENT_NOT_FOUND`, `AGENT_ALREADY_EXISTS`, `AGENT_HAS_ACTIVE_SESSIONS`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`, `TASK_NOT_FOUND`, `TASK_NOT_CANCELLABLE`, `TASK_NOT_RESUMABLE`, `DELEGATION_NOT_ALLOWED`, `MAX_DEPTH_EXCEEDED`, `MAX_TOOL_LOOPS_EXCEEDED`, `PROVIDER_ERROR`, `MCP_CLIENT_ERROR`, `VALIDATION_ERROR`, `CONTEXT_WINDOW_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED`, `BUDGET_EXCEEDED`, `COMPOSED_PROMPT_NOT_FOUND` |
| Zod schema | `agent-engine-orchestrator/src/validation/errors.ts` | Same 21 codes via `z.enum` + `ToolError` class with `.code` + `.data` |
| Re-exported | `agent-store-runtime/src/validation/errors.ts` | `ToolError` class re-replicated |
| Policy stores | `agent-core-policy/src/store/policy-template-store.ts` | `PolicyError` with codes: `POLICY_TEMPLATE_NOT_FOUND`, `POLICY_TEMPLATE_ALREADY_EXISTS` |
| Policy junction | `agent-core-policy/src/store/agent-policy-store.ts` | `AgentPolicyError` with codes: `AGENT_POLICY_ALREADY_ATTACHED`, `CATEGORY_POLICY_ALREADY_ATTACHED`, `AGENT_CATEGORY_ALREADY_JOINED` |
| Composition | `agent-store-prompts/src/store/composition-store.ts` | `CompositionError` with codes: `AGENT_NOT_FOUND`, `COMPONENT_VERSION_NOT_FOUND`, `REQUIRED_COMPONENT_EXCLUDED` |
| Components | `agent-store-prompts/src/store/component-store.ts` | `ComponentError` with codes: `COMPONENT_NOT_FOUND`, `COMPONENT_TYPE_NOT_FOUND`, `COMPONENT_VERSION_NOT_FOUND` |
| Composed prompt | `agent-store-prompts/src/store/composed-prompt-store.ts` | `ComposedPromptError` code: `NOT_FOUND` |
| Use cases | `agent-store-prompts/src/store/usecase-store.ts` | `UseCaseError` codes: `USE_CASE_NOT_FOUND`, `USE_CASE_ALREADY_EXISTS` |
| Agent (registry) | `agent-store-prompts/src/store/agent-store.ts` | `AgentError` codes: `AGENT_NOT_FOUND`, `CATEGORY_NOT_FOUND` |
| Tool store | `agent-store-tools/src/store/tool-store.ts` | `ToolStoreError` codes: `TOOL_ALREADY_EXISTS`, `TOOL_NOT_FOUND`, `TOOL_TYPE_NOT_FOUND` |
| Tool binding | `agent-store-tools/src/store/binding-store.ts` | `BindingStoreError` codes: `BINDING_NOT_FOUND`, `PLATFORM_NOT_FOUND`, `BINDING_ALREADY_EXISTS` |
| MCP server store | `agent-store-tools/src/store/mcp-server-store.ts` | `McpServerStoreError` codes: `MCP_SERVER_ALREADY_EXISTS`, `MCP_SERVER_NOT_FOUND` |
| Agent tool grants | `agent-store-tools/src/store/agent-tool-store.ts` | `AgentToolStoreError` codes: `GRANT_ALREADY_EXISTS`, `GRANT_NOT_FOUND` |
| Model store | `agent-engine-compiler/src/resolve/model.ts` | `ModelStoreError` code: `MODEL_BINDING_NOT_FOUND` |

**Key design**: Every store class throws typed error classes matching `AgentMcpErrorCode` or a local union — no generic `Error` leaks. A few store errors are `BUDGET_EXCEEDED` (budget plugin), `POLICY_VIOLATION` (rate policy plugin), but the canonical 21 codes are the contract.

---

## 2. STREAMING CONTRACTS

| Feature | File | Detail |
|---------|------|--------|
| StreamChunk discriminated union | `agent-base-types/src/domain.ts:341-343` | `{ type: 'text'; text: string }` \| `{ type: 'tool_call'; id: string; name: string; arguments: string }` |
| ProviderAdapter.stream() interface | `agent-base-types/src/domain.ts:353-358` | `AsyncIterable<StreamChunk>` — returns `(messages, tools, model) => AsyncIterable<StreamChunk>` |
| Stream URL in task output | `agent-engine-orchestrator/src/validation/task.ts:87` | `stream_url?: string` field on `taskToolOutputSchema` — only set when `stream && background` |
| SSE base URL config | `agent-engine-orchestrator/src/interfaces.ts:22-23` | `sse.baseUrl` config — public base URL used in `stream_url` links |
| Stream flag on task input | `agent-engine-orchestrator/src/validation/task.ts:62-76` | Both `sessionModeSchema` and `ephemeralModeSchema` have optional `stream: z.boolean()` |
| Claude CLI `--output-format stream-json` | `agent-engine-orchestrator/src/providers/claudecli.ts:269-271` | Subprocess reads stream-json events for `"result"` and `"assistant"` types |

**NOTE**: The `ProviderAdapter` interface is defined in `agent-base-types` but **there is no implementation in the packages listed**. The implementation lives in a separate `@adhd/agent-provider` package (not in scope). The actual `antrhopic.ts`/`openai.ts`/`claudecli.ts` in the orchestrator use a **non-streaming** `LLMProvider` interface (returns `Promise<ProviderChatResponse>`).

---

## 3. TASK / DAG LIFECYCLE

| Feature | File | Detail |
|---------|------|---------|
| **7 task statuses** | `agent-base-types/src/domain.ts:40-47` | `pending`, `running`, `completed`, `failed`, `cancelled`, `waiting`, `awaiting_input` |
| Task schema | `agent-base-types/src/domain.ts:57-79` | `id`, `sessionId`, `isEphemeral`, `parentTaskId`, `recursionDepth`, `status`, `prompt`, `result`, `error`, timestamps, DAG fields (`dependsOn`, `onUpstreamFailure`, `inputs`), HITL field (`resumeToken`) |
| **6 task event types** | `agent-base-types/src/domain.ts:48-55` | `MODEL_REQUEST`, `MODEL_RESPONSE`, `TOOL_CALL`, `TOOL_RESULT`, `TASK_COMPLETED`, `TASK_FAILED`, `TASK_CANCELLED` |
| TaskStore | `agent-engine-orchestrator/src/tools/task.ts:32-50` | Interface: `create`, `read`, `updateStatus`, `list`, `cancel`, `registerCancellation`, `unregisterCancellation`, `appendEvent` |
| TaskStore impl | `agent-store-runtime/src/store/task-store.ts` | SQLite/Drizzle backed, in-memory cancellation `Map<string, AbortController>` |
| DagEngine | `agent-engine-orchestrator/src/engine/dag-engine.ts` | `validateNoCycle()` — BFS check; `dispatchReady(taskId)` — queries `waiting` tasks, checks dependency completion, handles `onUpstreamFailure` (`'fail'` \| `'skip'`), pushes inputs from completed upstreams, optimistic-lock update to `pending` |
| BackgroundQueue | `agent-engine-orchestrator/src/engine/queue.ts` | `PQueue`-based concurrency limiter; `enqueue(taskId, fn)`, tracks `pending`/`size`, `onIdle()` |
| Session vs ephemeral | `agent-engine-orchestrator/src/tools/task.ts:70-180` vs `182-345` | Ephemeral: no session store, no streaming; Session-backed: full message history, background/sync dispatch, DAG integration |
| task_resume | `agent-engine-orchestrator/src/tools/task.ts:486-515` | Resolves HITL suspension via `resumeToken` match; fails task if process restarted |
| Cancellation | `agent-engine-orchestrator/src/tools/task.ts:456-483` | Throws `TASK_NOT_CANCELLABLE` if not in `pending\|running\|awaiting_input`; uses `AbortController` map |
| enqueueExistingTask | `agent-engine-orchestrator/src/tools/task.ts:347-454` | Re-dispatch persisted tasks on server restart (skips ephemeral) |
| Task usage report | `agent-engine-orchestrator/src/tools/usage.ts:211-232` | `buildTaskUsageReport()` — returns `{ direct, subtree, taskCount }` |
| Usage query | `agent-engine-orchestrator/src/tools/usage.ts:89-209` | Supports `group_by` (agent/model/provider), `since`, `include_incomplete`, `limit`; includes cache fields |

---

## 4. PLUGIN HOOK LIFECYCLE

| Feature | File | Detail |
|---------|------|---------|
| **13 hook events** | `agent-base-types/src/hooks.ts:63-84` | `task:start`, `pre:model_request`, `post:model_response`, `pre:tool_call`, `post:tool_call`, `transform:tool_result`, `message:appended`, `task:completed`, `task:failed`, `task:cancelled`, `session:created`, `agent:mutated` |
| Observational vs enforcement | `agent-base-types/src/hooks.ts:86-144` | `IHookRegistry` — `register()` + `emit()` (swallow errors) vs `registerEnforcement()` + `enforce()` (throws propagate) |
| Enforcement events | `agent-base-types/src/hooks.ts:121` | Only `'pre:model_request'` and `'pre:tool_call'` |
| IEnforcementError marker | `agent-base-types/src/hooks.ts:98-102` | Duck-type: `{ isEnforcementError: true, code: string, message: string }` |
| IToolWarning marker | `agent-base-types/src/hooks.ts:113-118` | Soft block: `{ isToolWarning: true, toolName, message, callId }` — orchestrator catches, injects error result to agent |
| Plugin interface | `agent-base-types/src/hooks.ts:146-149` | `{ name: string; install(hooks: IHookRegistry): void \| Promise<void> }` |
| PluginFactory | `agent-base-types/src/hooks.ts:183` | `(ctx: PluginContext) => Plugin \| Promise<Plugin>` |
| PluginContext | `agent-base-types/src/hooks.ts:162-165` | `{ db: unknown; config: Record<string, unknown> }` — cast to `BetterSQLite3Database` inside plugin |
| Config schema pattern | `agent-base-types/src/hooks.ts` (doc) | Plugins export `configSchema` (zod) for validation before factory call |
| HookRegistry impl | `agent-base-types/src/registry.ts` | Full `Map<HookEvent, HookHandler[]>` + `Map<EnforcementEvent, EnforcementHandler[]>` |
| **3-phase tool execution** | `agent-engine-orchestrator/src/engine/orchestrator.ts:472-764` | Phase 1: serial pre-dispatch (HITL + hooks + enforcement + policy check); Phase 2: Promise.all concurrent tool execution; Phase 3: serial result append with `transform:tool_result` |
| **Phased hook firing** | `agent-engine-orchestrator/src/engine/orchestrator.ts` | Observational -> Enforcement -> Tool Execution -> Post-tool hooks -> Transform hooks (each phase completes before next) |

---

## 5. AGENT COMPILATION PIPELINE

| Feature | File | Detail |
|---------|------|---------|
| `compileAgent()` orchestrator | `agent-engine-compiler/src/compile.ts:175-396` | 4 resolve layers: (1) body + component versions, (2) tools, (3) model, (4) policy constraints; then dispatch to emitter by `header_format` |
| CompileInput | `agent-engine-compiler/src/compile.ts:59-69` | `{ agentSlug, platform, context?, db }` |
| CompiledAgent | `agent-engine-compiler/src/compile.ts:72-94` | `{ id, content, tools, componentVersions }` |
| **3 header formats** | `agent-engine-compiler/src/compile.ts` | `yaml_frontmatter` (→ `emit/markdown.ts`), `json_object` (→ `emit/json.ts`), `none` (raw body text) |
| **4 resolve layers** | | |
| 1. Body + versions | `agent-engine-compiler/src/resolve/composition.ts` | Delegates to `CompositionStore.resolveComposition()` for junction-order, version-pinned, context-filtered component list |
| 2. Tools | `agent-engine-compiler/src/resolve/tools.ts` | `AgentToolStore.listForAgent()` → `BindingStore.listForPlatform()` → de-dup, drop `unavailable` bindings; returns `ResolvedTool[]` with `{ canonicalName, platformAlias, availability }` |
| 3. Model | `agent-engine-compiler/src/resolve/model.ts` | `AgentStore.read()` → `modelHint` → `ModelStore.resolveModelId()` → fallback to canonical id if no binding |
| 4. Policy constraints | `agent-engine-compiler/src/resolve/policy.ts` | `AgentPolicyStore.resolveForAgent()` → `PolicyTemplateStore.read()` for each → renders `Constraint[]` with `{ policySlug, text, isMandatory, inheritedFrom }` |
| YAML frontmatter emitter | `agent-engine-compiler/src/emit/markdown.ts` | `name:`, `description:`, `tools:`, `model:` (omitted when empty), `---`, then body (\n\n-joined sections), then `## Policies` block |
| JSON object emitter | `agent-engine-compiler/src/emit/json.ts` | `{ name, systemPrompt, model, tools }` — tools as `StructuredTool[]` via `emitToolsForProvider` |
| Context condition evaluator | `agent-store-prompts/src/store/composition-store.ts:72-98` | `evaluateCondition(condition, ctx)` — every key in JSON predicate must match ctx value |
| Component head/version split | `agent-store-prompts/src/db/schema.ts:61-114` | `registry_components` (identity) + `registry_component_versions` (history with `version_id` surrogate PK) |
| Version pinning | `agent-store-prompts/src/store/composition-store.ts:133-162` | `null` = latest-at-resolve; `versionPin` = `version_id` (surrogate); `pinVersion` = human version number (resolved to `version_id`) |
| Context rules (additive) | `agent-store-prompts/src/store/usecase-store.ts:193-238` | `contextRulesFor(agentSlug)` — additional components added when context condition matches, merged with junction components |
| Required component guard | `agent-store-prompts/src/store/composition-store.ts:260-269` | `isRequired` + condition fails → `REQUIRED_COMPONENT_EXCLUDED` error |

---

## 6. COMPOSED PROMPT CACHE

| Feature | File | Detail |
|---------|------|---------|
| ComposedPromptStore | `agent-store-prompts/src/store/composed-prompt-store.ts:96-204` | `lookup(agentSlug, contextHash)`, `write(input)`, `read(id)` |
| ComposedPrompt shape | `agent-base-types/src/domain.ts:286-301` | `{ id, agentSlug, contextHash, content, componentVersions, createdAt }` |
| contextHash() | `agent-store-prompts/src/store/composed-prompt-store.ts:37-46` | SHA-256 of sorted-key JSON canonicalization of context map |
| Compiler cache layer | `agent-engine-compiler/src/cache/composed-prompt-cache.ts` | `computeContextHash(context, componentVersions, platform)` — 3-part key; `lookup()` + `write()` wrappers |
| Cache hit → bypass assembly | `agent-engine-compiler/src/compile.ts:203-262` | On HIT, return persisted `{ id, content }` WITHOUT re-running resolve layers |
| Orchestrator cache integration | `agent-engine-orchestrator/src/engine/prompt-resolver.ts` | `resolveComposedPrompt()` — cache-first, falls back to `compileAgent()`, writes on miss |
| DB table | `agent-store-runtime/src/db/schema.ts:99-115` | `composed_prompts` with unique index on `(agent_slug, context_hash)` |
| Experiment assignments | `agent-store-runtime/src/db/schema.ts:120-128` | `experiment_assignments` table: `(sessionId, experimentSlug, variant)` |

---

## 7. CONTEXT WINDOW MANAGEMENT

| Feature | File | Detail |
|---------|------|---------|
| Cache-preserving strategy | `agent-engine-orchestrator/src/engine/context-window.ts:1-21` | Append-only growth (stable prefix = cache hit); compact only when REAL context nears model's TRUE window |
| `contextWindowFor()` | `agent-engine-orchestrator/src/engine/context-window.ts:49-60` | Longest-prefix match on `/models` table for 12 model families; fallback 128K |
| `decideCompaction()` | `agent-engine-orchestrator/src/engine/context-window.ts:122-134` | Trigger at 75% of true window; uses provider-reported `prompt_tokens` when available, else local estimator |
| `compactMessages()` | `agent-engine-orchestrator/src/engine/context-window.ts:155-196` | Preserve system head + N recent turns (default 4); summarise middle chunk via injected `summarise()` callback; best-effort (never lose history) |
| `groupIntoAtomicUnits()` | `agent-engine-orchestrator/src/engine/context-window.ts:86-103` | assistant+tool messages are one indivisible unit |
| `estimateMessageTokens()` | `agent-engine-orchestrator/src/engine/context-window.ts:67-76` | ~4 chars/token over full wire form (content + toolCall args + toolResult payloads) |
| legacy `windowMessages()` | `agent-engine-orchestrator/src/engine/orchestrator.ts:901-919` | Estimate-then-drop, contiguous from oldest, preserves system; still used as hard limit cap |
| `estimateTokens()` | `agent-store-runtime/src/store/session-store.ts:215-226` | Same estimator duplicated in session-store |

---

## 8. TOOL ADVERTISEMENT (name-only vs full schema)

| Feature | File | Detail |
|---------|------|---------|
| `toolAdvertisement` config | `agent-base-types/src/domain.ts:278` | `'names'` \| `'full'` — per-agent; defaults to `'full'` |
| `toNameOnlyTools()` | `agent-engine-orchestrator/src/engine/tool-advertisement.ts:85-95` | Strips schema to `{ type: 'object', properties: {}, additionalProperties: true }`, truncates description to 140 chars |
| `renderToolPromptDoc()` | `agent-engine-orchestrator/src/engine/tool-advertisement.ts:41-83` | Full markdown doc listing every tool with its parameter schema, rendered as `## Available Tools` |
| Orchestrator injection | `agent-engine-orchestrator/src/engine/orchestrator.ts:168-192` | `'names'` mode: prepend tool doc as system message before first user message; `'full'` mode: pass full schema objects to provider |
| Cost rationale | `agent-engine-orchestrator/src/engine/orchestrator.ts:164-168` | Full schemas are static → sit in cached prefix → bill at cache-hit rate; name-only's payload saving is marginal vs reliability cost |

---

## 9. MCP TRANSPORT DETAILS

| Feature | File | Detail |
|---------|------|---------|
| **4 transport types** | | |
| stdio | `agent-engine-orchestrator/src/clients/stdio-client.ts` | Uses MCP SDK `StdioClientTransport`; spawns child process, tracks exit, SIGTERM → SIGKILL after 5s |
| HTTP (Streamable HTTP) | `agent-engine-orchestrator/src/clients/http-client.ts:65-93` | Uses MCP SDK `StreamableHTTPClientTransport` |
| SSE | `agent-engine-orchestrator/src/clients/http-client.ts:94-128` | Uses MCP SDK `SSEClientTransport` |
| In-process | `agent-engine-orchestrator/src/clients/in-process.ts` | Calls handler function directly with `ExecutionContext`; zero network |
| Transport config schema | `agent-engine-orchestrator/src/validation/mcp.ts` | `z.discriminatedUnion('transport', [stdio, http, sse])` — each with `allowedTools` and `disallowedTools` filters |
| McpServerConfig | `agent-base-types/src/domain.ts:214-240` | Union of 3 transport configs + `allowedTools`/`disallowedTools` |
| Client registry | `agent-engine-orchestrator/src/clients/registry.ts` | `McpClientRegistry` — lazy connection, dedup, self-referential loop detection, connect-retry eviction, tool hiding |
| Self-referential guard | `agent-engine-orchestrator/src/clients/registry.ts:28-39` | Detects `agent-mcp` server name or URL matching `selfUrl` → routes to `InProcessMcpClient` |
| Claude CLI MCP config mapping | `agent-engine-orchestrator/src/providers/claudecli.ts:203-231` | Converts `agent-engine-orchestrator`'s unified `McpServerConfig` to Claude-desktop-format JSON, written to temp file, passed via `--mcp-config` |
| Tool naming convention | `agent-engine-orchestrator/src/clients/tool-naming.ts` | `TOOL_NAME_SEPARATOR = "__"`; `normalizeToolName()` replaces non-alphanumeric with `_`; `resolveToolCallName()` handles ambiguous short names |
| `server__tool` resolution | `agent-engine-orchestrator/src/clients/registry.ts:167-179` | `resolveToolName()` — reverse look up `toolTargets` Map indexed by both raw and normalized name |
| MCP server store | `agent-store-tools/src/store/mcp-server-store.ts` | Registry of known MCP servers: `{ id, transport, name, providedToolIds[], configSchema }` |

---

## 10. TOOL NAMING (server__tool)

| Feature | File | Detail |
|---------|------|---------|
| Separator | `agent-engine-orchestrator/src/clients/tool-naming.ts:1` | `__` (double underscore) |
| Normalization | `agent-engine-orchestrator/src/clients/tool-naming.ts:3-5` | `/[^A-Za-z0-9_]/g` → `_` |
| Resolution (provider→internal) | `agent-engine-orchestrator/src/clients/tool-naming.ts:19-35` | `resolveToolCallName(rawName, advertised)` — if contains `__` → split; else normalize and match against advertised list; `Ambiguous tool name` error if 2+ servers expose same short name |
| Resolution (advertised→server+tool) | `agent-engine-orchestrator/src/clients/registry.ts:167-179` | `resolveToolName(advertised)` — Map lookup by raw + normalized; fallback to split on `__` |

---

## 11. ALLOW / DENY LISTS

| Feature | File | Detail |
|---------|------|---------|
| MCP server tool filters | `agent-base-types/src/domain.ts:237-239` | `allowedTools?: string[]` + `disallowedTools?: string[]` per server |
| `isToolHidden()` | `agent-engine-orchestrator/src/clients/registry.ts:123-129` | Checks both lists; `allowedTools` acts as exclusive allowlist when set |
| `assertToolAllowed()` | `agent-engine-orchestrator/src/clients/registry.ts:131-136` | Called at tool call time — throws if tool is hidden |
| Agent delegation allowlist | `agent-base-types/src/domain.ts:242-244` | `AgentPermissions.allowedAgents?: string[]` |
| Policy engine delegation check | `agent-engine-orchestrator/src/engine/policy.ts:90-111` | 3-layer resolution: agent-specific → template allowlist → server-wide `serverAllowedAgents` |
| Tool grant permission levels | `agent-store-tools/src/store/agent-tool-store.ts:17` | `PermissionLevel = 'full' \| 'read_only' \| 'restricted'` |
| Tool platform binding availability | `agent-store-tools/src/store/binding-store.ts:37` | `availability: string` — `available`, `restricted`, `unavailable`, `requires_permission` |
| Claude CLI builtin tool filter | `agent-engine-orchestrator/src/providers/claudecli.ts:96-136` | 12 built-in tools (`Bash`, `Edit`, `Read`, `Write`, `Grep`, `Glob`, etc.); `--disallowedTools` per-tool flag; `--strict-mcp-config` |
| Claude CLI agent-spec mode | `agent-engine-orchestrator/src/providers/claudecli.ts:199-212` | When `systemPromptIsAgentSpec`, the spec's frontmatter `tools:` governs access instead of `--disallowedTools` |
| HITL tool opt-in | `agent-base-types/src/domain.ts:272` | `allowHumanInput?: boolean` — per-agent opt-in; only for session-backed tasks |
| HITL built-in definition | `agent-engine-orchestrator/src/engine/orchestrator.ts:32-48` | Advertised as `builtin__request_human_input` |
| Env-var name guard | `agent-engine-orchestrator/src/validation/agent.ts:133-155` | `buildEnvNameGuard(config)` — only `ADHD_AGENT_*`-prefixed names allowed; extended via `ADHD_AGENT_ENV_ALLOWLIST` |

---

## 12. AGENT DELEGATION TRACKING

| Feature | File | Detail |
|---------|------|---------|
| Agent delegation tool | `agent-engine-orchestrator/src/tools/session.ts:36-92` | `agentTool()` — creates sub-session for target agent; checks policy delegation rules; resolves composed prompt for sub-agent |
| `agentToolInputSchema` | `agent-engine-orchestrator/src/validation/session.ts:18-20` | `{ name: string }` |
| `agentToolOutputSchema` | `agent-engine-orchestrator/src/validation/session.ts:22-24` | `{ session_id: uuid }` |
| Delegation detection | `agent-engine-orchestrator/src/engine/orchestrator.ts:631-641` | When `agent-mcp__agent` tool returns a session_id, tracks in `delegationSessions` Set |
| Cleanup on failure | `agent-engine-orchestrator/src/engine/orchestrator.ts:862-870` | If task fails, all tracked delegation sessions are closed |
| `callingAgentName` field | `agent-base-types/src/domain.ts:308` | `ExecutionContext.callingAgentName` — tracks delegating parent |
| `rootTaskId` field | `agent-base-types/src/domain.ts:311` | `ExecutionContext.rootTaskId` — root task in the delegation chain |
| `parentTaskId` field | `agent-base-types/src/domain.ts:63` | `Task.parentTaskId` — DAG parent link |
| `recursionDepth` | `agent-base-types/src/domain.ts:64` | Bumps by 1 per delegation; checked by PolicyEngine against `maxToolLoops` |

---

## 13. POLICY ENGINE

| Feature | File | Detail |
|---------|------|---------|
| PolicyEngine | `agent-engine-orchestrator/src/engine/policy.ts:48-113` | Server-level depth/loop caps + template-based delegation allowlist |
| `PolicyConfig` | `agent-engine-orchestrator/src/engine/policy.ts:9-14` | `serverMaxDepth`, `serverMaxToolLoops`, `serverAllowedAgents`, `policyTemplateRules` |
| Policy template store | `agent-core-policy/src/store/policy-template-store.ts` | CRUD for `policy_policy_templates` with `{ slug, type, description, rules, enforcement, version, isSystem }` |
| Agent policy store | `agent-core-policy/src/store/agent-policy-store.ts` | `attach`, `listForAgent`, `attachToCategory`, `addAgentToCategory`, `resolveForAgent` (3-query merge) |
| **Category inheritance** | `agent-core-policy/src/store/agent-policy-store.ts:310-357` | `resolveForAgent()` = direct rows + union of policies inherited from all categories the agent belongs to; lazy — no fanout |
| Shallow-merge override | `agent-core-policy/src/store/agent-policy-store.ts:384-392` | `resolveEffectiveRules(templateRules, overrideConfig)` |
| **7 policy types** (seeded) | `agent-core-policy/src/seed/policy-types.ts:20-49` | `permission`, `safety`, `audit`, `rate`, `scope`, `compliance`, `quality` |
| **9 seeded templates** | `agent-core-policy/src/seed/policy-templates.ts:46-219` | `reviewer-posture`, `no-credentials`, `sox-audit-trail`, `max-rework-3`, `evidence-required`, `originality-check`, `read-only`, `allowed-delegation`, `phase-gate-required` |
| Rate policy plugin | `agent-core-policy/src/plugin/rate-policy.ts` | Pure evaluator: `evaluateRatePolicy(rules, modelCalls, toolCalls)` → `IEnforcementError \| null` |
| Rate policy plugin (hook wiring) | `agent-core-policy/src/plugin/index.ts` | Registers observational hooks + enforcement hooks on `pre:model_request` and `pre:tool_call` |
| **5 enforcement mechanisms** (from seed) | `agent-core-policy/src/seed/policy-templates.ts` | `agent`, `ci`, `hook`, `runtime`, `settings` — stored as JSON arrays, never scalars `[inv:enforcement-is-array]` |

---

## 14. PROVIDER ADAPTER INTERFACE

| Feature | File | Detail |
|---------|------|---------|
| `LLMProvider` interface | `agent-engine-orchestrator/src/providers/types.ts:23-25` | `chat(request: ProviderChatRequest): Promise<ProviderChatResponse>` |
| `ProviderChatRequest` | `agent-engine-orchestrator/src/providers/types.ts:5-14` | `{ messages, tools?, signal?, executeTool? }` |
| `ProviderChatResponse` | `agent-engine-orchestrator/src/providers/types.ts:16-21` | `{ message, stopReason, usage?, rawUsage? }` |
| Provider factory | `agent-engine-orchestrator/src/providers/factory.ts:8-26` | Discriminated union on `type`: `anthropic`, `openai`, `claudecli` |
| Anthropic provider | `agent-engine-orchestrator/src/providers/anthropic.ts:180-329` | Supports API key + OAuth (`sk-ant-oat`); streams via `client.messages.stream()`; normalises usage (Anthropic headline EXCLUDES cache → `normaliseAnthropicUsage`) |
| OpenAI provider | `agent-engine-orchestrator/src/providers/openai.ts:124-228` | Also serves DeepSeek/LM Studio; `normaliseOpenAIUsage` handles `prompt_tokens_details.cached_tokens` + `prompt_cache_hit_tokens` |
| Claude CLI provider | `agent-engine-orchestrator/src/providers/claudecli.ts:171-440` | Subprocess-based; writes temp MCP config + agent-spec dirs; stream-json protocol |
| Retry config | `agent-base-types/src/domain.ts:126-131` | `{ retries, minTimeout, maxTimeout, factor }` |
| p-retry on providers | `agent-engine-orchestrator/src/providers/anthropic.ts:305-325`, `openai.ts:212-226` | Both wrap `chat()` with `pRetry` using config; Anthropic aborts retry on 401 |
| **`ProviderAdapter`** (streaming interface) | `agent-base-types/src/domain.ts:353-358` | `stream(messages, tools, model): AsyncIterable<StreamChunk>` — defined in `agent-base-types` but impl is in `@adhd/agent-provider` (not listed in scope) |
| Provider env block | `agent-base-types/src/domain.ts:145-152` | `{ secret?, base_url?, model? }` — env-var NAME pointers, never values |
| Legacy field normalisation | `agent-engine-orchestrator/src/validation/agent.ts:55-85` | Shim for `apiKeyEnv`, `authTokenEnv`, `useClaudeOauth`, `lmstudio` type → unified shape |
| Model max-output table | `agent-engine-orchestrator/src/providers/anthropic.ts:22-39` | Per-model maxTokens lookup (14 model prefixes) |
| Model context windows table | `agent-engine-orchestrator/src/engine/context-window.ts:31-45` | 12 model family prefixes with true input context windows |
| Provider error classification | `agent-engine-orchestrator/src/engine/orchestrator.ts:354-413` | `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR` (401), `PROVIDER_RATE_LIMITED` (429), `CONTEXT_WINDOW_EXCEEDED` (`context_length_exceeded`), fallback `PROVIDER_ERROR` |

---

## 15. RETRY / CONFIG HANDLING

| Feature | File | Detail |
|---------|------|---------|
| `RetryConfig` | `agent-base-types/src/domain.ts:126-131` | `{ retries, minTimeout, maxTimeout, factor }` |
| `retryConfigSchema` | `agent-engine-orchestrator/src/validation/agent.ts:7-12` | Zod schema: defaults retries=3, minTimeout=1s, maxTimeout=30s, factor=2 |
| Per-provider retry | `agent-engine-orchestrator/src/providers/anthropic.ts:305-325`, `openai.ts:212-226` | `pRetry` with config; abort on `signal.aborted`; Anthropic aborts on 401 |
| `EngineConfig` | `agent-engine-orchestrator/src/interfaces.ts:9-58` | `server.contextLimit`, `server.defaultMaxTokens`, `queue.concurrency`, `sse.baseUrl`, `plugins.configPath/entries`, `getProviderConfig()`, `subprocessEnv()`, `isEnvNameAllowed()` |
| `EngineLogger` | `agent-engine-orchestrator/src/interfaces.ts:66-71` | `info/warn/error/debug` — injectable, never imports pino |
| Provider timeout | `agent-base-types/src/domain.ts:163,178,187` | `timeoutMs` on each provider config |
| Combined abort signal | `agent-engine-orchestrator/src/engine/orchestrator.ts:272-277` | `AbortSignal.any([taskSignal, AbortSignal.timeout(timeoutMs)])` |
| MCP server timeout | `agent-engine-orchestrator/src/clients/stdio-client.ts:85-91` | Combined `callerSignal` + server-specific `timeoutMs` via `AbortSignal.any()` |

---

## 16. SESSION MESSAGE FORMAT

| Feature | File | Detail |
|---------|------|---------|
| `MessageRole` | `agent-base-types/src/domain.ts:101` | `'system' \| 'user' \| 'assistant' \| 'tool'` |
| `Message` | `agent-base-types/src/domain.ts:116-124` | `{ id, sessionId, role, content?, toolCalls?, toolResults?, createdAt }` |
| `ToolCall` | `agent-base-types/src/domain.ts:103-108` | `{ id, server, tool, arguments }` — note: `server` separated from `tool` |
| `ToolResult` | `agent-base-types/src/domain.ts:110-114` | `{ toolCallId, result, isError }` |
| `Session` | `agent-base-types/src/domain.ts:91-99` | `{ id, agentName, agentVersion, status, createdAt, updatedAt, closedAt }` |
| `SessionStatus` | `agent-base-types/src/domain.ts:89` | `'active' \| 'closed'` |
| `composedPromptId` | `agent-store-runtime/src/db/schema.ts:24` | `sessions.composed_prompt_id` — link to the compiled prompt version |
| `agentData` field | `agent-store-runtime/src/db/schema.ts:17` | `sessions.agent_data` — JSON snapshot of the agent definition at session creation |
| SessionStore | `agent-store-runtime/src/store/session-store.ts` | `create`, `read`, `getAgentDefinition`, `list`, `close`, `clearMessages`, `appendMessage`, `getMessages` |
| Session list filter | `agent-store-runtime/src/validation/schemas.ts:18-21` | `{ agentName?, status? }` |
| Session clear | `agent-store-runtime/src/store/session-store.ts:157-177` | Deletes all messages for a session; throws `SESSION_CLOSED` if session is closed |
| Session close | `agent-store-runtime/src/store/session-store.ts:132-155` | Sets `status='closed'` + `closedAt` |

---

## 17. USAGE TRACKING

| Feature | File | Detail |
|---------|------|---------|
| `TokenUsage` shape | `agent-base-types/src/domain.ts:15-38` | `inputTokens`, `outputTokens`, `stopReason`, `maxTokens`, `uncachedInputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `reasoningTokens` |
| Per-provider normalisation | | |
| Anthropic | `agent-engine-orchestrator/src/providers/anthropic.ts:54-78` | `inputTokens = uncached + cacheRead + cacheCreation` (reconstructs true total) |
| OpenAI/DeepSeek | `agent-engine-orchestrator/src/providers/openai.ts:31-63` | Handles both `prompt_tokens_details.cached_tokens` and `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` |
| `task_usage` DB table | `agent-store-runtime/src/db/schema.ts:133-169` | Full schema: `inputTokens`, `outputTokens`, `toolCallCount`, `modelCalls`, `latencyMs`, `isComplete`, `stopReason`, `maxTokens`, `cacheReadTokens`, `cacheCreationTokens`, `uncachedInputTokens`, `reasoningTokens`, `peakContextTokens`, `peakContextAt` |
| UsageClient (in-memory) | `agent-store-runtime/src/runtime/usage-client.ts` | Per-task accumulator: `recordModelCall`, `recordToolCall`, `getTotals(scope)` — supports `task/session/agent` scopes with DB fallback |
| Usage query grouped | `agent-engine-orchestrator/src/tools/usage.ts:89-183` | Group by `agent`, `model`, or `provider`; returns `GroupedUsageRow[]` with cache fields + `peakContextTokens` (MAX not SUM) |
| Task usage report | `agent-engine-orchestrator/src/tools/usage.ts:211-232` | `{ direct: UsageSummary, subtree: UsageSummary, taskCount }` |
| `peakContextTokens` invariant | `agent-engine-orchestrator/src/tools/usage.ts:57-87` | `inputTokens` = CUMULATIVE billed input (across calls); `peakContextTokens` = MAX single-call input (only number comparable to context window) |

---

## 18. BUDGET PLUGIN

| Feature | File | Detail |
|---------|------|---------|
| Plugin class | `agent-plugin-budget/src/index.ts` | Full `install(hooks)` with 10 hook registrations |
| **9 cap dimensions** | `agent-plugin-budget/src/index.ts:38-48` | `tokens`, `inputTokens`, `outputTokens`, `calls`, `wallClock`, `modelMs`, `cost`, `toolCalls`, `responseSize` |
| **4 scopes** | `agent-plugin-budget/src/index.ts:54` | `task`, `session`, `agent`, `global` — for cumulative budget tracking |
| **2 modes** | `agent-plugin-budget/src/index.ts:56` | `warning` (throws `IToolWarning` → agent sees error) or `block` (throws `IEnforcementError` → task fails `BUDGET_EXCEEDED`) |
| Time windows | `agent-plugin-budget/src/index.ts:53` | ISO8601 durations: `PT24H`, `P1DT6H`, etc.; uses `parseIsoDuration()` |
| Config hierarchy | `agent-plugin-budget/src/index.ts:75-104` | `defaults` → `agent.default` → `agent.overrides[name]` → `provider.default` → `provider.overrides[type]` → `tool.default` → `tool.overrides[name]` |
| Flat config backward compat | `agent-plugin-budget/src/index.ts:112-147` | Maps `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxModelCalls`, `maxWallClockMs`, `maxModelMs`, `maxCostUSD`, `maxTokensPer24h`, `maxCalls` to new cap format |
| Response size enforcement | `agent-plugin-budget/src/index.ts:759-831` | `transform:tool_result` hook — truncates or replaces tool result content; supports `block` (replace with error) or `warning` (truncate with note) |
| Cost-based caps | `agent-plugin-budget/src/index.ts:568-570` | `cost = inputTokens * costPerInputToken + outputTokens * costPerOutputToken` |

---

## 19. SANITIZE PLUGIN

| Feature | File | Detail |
|---------|------|---------|
| Plugin class | `agent-plugin-sanitize/src/index.ts` | Single `transform:tool_result` hook |
| **3 strategies** | `agent-plugin-sanitize/src/index.ts:19` | `none`, `prefix` (prepend label), `wrap` (surround with delimiters) |
| Delegation-only mode | `agent-plugin-sanitize/src/index.ts:31` | `delegationOnly: boolean` (default `true`) — only sanitizes `agent-mcp__task` / `agent-mcp__agent` results |
| Per-agent overrides | `agent-plugin-sanitize/src/index.ts:25` | `agents: Record<agentName, strategy>` |
| Labels include agent name | `agent-plugin-sanitize/src/index.ts:38-49` | `[Sub-agent output from "agentName"]` or `── Agent "agentName" output ──` |

---

## 20. AGENT DEFINITION & CRUD

| Feature | File | Detail |
|---------|------|---------|
| `AgentDefinition` | `agent-base-types/src/domain.ts:246-281` | `name`, `description`, `version`, `provider`, `systemPrompt`, `mcpServers`, `permissions`, `maxToolLoops`, `allowHumanInput`, `toolAdvertisement`, timestamps |
| Agent CRUD | `agent-engine-orchestrator/src/tools/agent-crud.ts` | `agentCreate`, `agentRead`, `agentUpdate`, `agentDelete`, `agentList` |
| Agent delete force | `agent-engine-orchestrator/src/tools/agent-crud.ts:39-52` | `force: true` closes active sessions before deleting |
| Agent patch schema | `agent-engine-orchestrator/src/validation/agent.ts:190-199` | Partial update: `description`, `provider`, `systemPrompt`, `mcpServers`, `permissions`, `maxToolLoops`, `allowHumanInput`, `sanitization` |
| Registry Agent (compiler-side) | `agent-store-prompts/src/store/agent-store.ts:49-66` | `slug`, `displayName`, `description`, `status` (draft/active/deprecated), `modelHint`, `taxonomyCategory`, `defaultPosture` (approve/needs_work) |
| Taxonomy categories | `agent-store-prompts/src/store/agent-store.ts:31-39` | Hierarchical categories with `parentSlug` self-FK, `position` ordering |
| Agent status lifecycle | `agent-store-prompts/src/store/agent-store.ts:26` | `draft` → `active` → `deprecated` |

---

## 21. TOOL STORES (REGISTRY-SIDE)

| Feature | File | Detail |
|---------|------|---------|
| Canonical `Tool` | `agent-store-tools/src/store/tool-store.ts:18-27` | `name`, `type`, `description`, `version`, `requiresApproval`, `isDestructive`, `dependencyToolIds[]`, `capabilities[]` |
| `ToolType` | `agent-store-tools/src/store/tool-store.ts:12-15` | Lookup table: `slug`, `description` |
| `AgentToolGrant` | `agent-store-tools/src/store/agent-tool-store.ts:28-34` | `{ agentSlug, toolName, permission, contextCondition }` |
| Permission levels | `agent-store-tools/src/store/agent-tool-store.ts:17` | `full \| read_only \| restricted` |
| `ToolPlatformBinding` | `agent-store-tools/src/store/binding-store.ts:33-40` | `{ toolName, platformId, platformToolName, availability, requiresMcp, invocationNote }` |
| `Platform` | `agent-store-tools/src/store/binding-store.ts:12-18` | `{ id, name, headerFormat, supportsToolSelection }` |
| Forward resolve | `agent-store-tools/src/store/binding-store.ts:194-214` | `resolve(canonicalToolName, platformId) → platformToolName` |
| Reverse resolve | `agent-store-tools/src/store/binding-store.ts:245-265` | `resolveCanonical(platformToolName, platformId) → toolName` |
| List for platform | `agent-store-tools/src/store/binding-store.ts:271-285` | `listForPlatform(platformId) → ToolPlatformBinding[]` |
| `McpServer` (registry) | `agent-store-tools/src/store/mcp-server-store.ts:19-25` | `{ id, transport, name, providedToolIds[], configSchema }` |

---

## 22. PROMPT COMPONENT SYSTEM

| Feature | File | Detail |
|---------|------|---------|
| `PromptComponent` | `agent-store-prompts/src/store/component-store.ts:38-53` | `slug`, `type`, `version`, `versionId`, `content`, `isShared`, timestamps |
| `PromptType` | `agent-store-prompts/src/store/component-store.ts:32-36` | `slug`, `description`, `isSystem` |
| ComponentStore | `agent-store-prompts/src/store/component-store.ts:84-454` | `create` (atomic head+v1), `read` (latest), `readVersion` (specific), `resolveVersionId`, `version` (bump), `list` (with type/shared filters) |
| `CompositionStore` | `agent-store-prompts/src/store/composition-store.ts:110-404` | `attach` (with version pinning + context condition), `resolveComposition` (ordered, filtered, versioned), `resolvePinVersionId` |
| `ResolvedComponent` | `agent-store-prompts/src/store/composition-store.ts:41-49` | `{ componentSlug, position, resolvedVersion, component }` |
| `CompositionContext` | `agent-store-prompts/src/store/composition-store.ts:38` | `Record<string, string>` — arbitrary key/value |
| `UseCaseStore` | `agent-store-prompts/src/store/usecase-store.ts:88-238` | Use-case CRUD, component→usecase linking (annotation), context rules management |
| Context rules (additive) | `agent-store-prompts/src/store/usecase-store.ts:61-77` | `{ agentSlug, condition, componentSlug, position }` — evaluated by same `evaluateCondition()` |

---

## 23. ADDITIONAL CONCEPTS

| Concept | File | Detail |
|---------|------|---------|
| `ToolDefinition` | `agent-base-types/src/domain.ts:326-330` | `{ name, description, inputSchema }` — server__tool encoded name |
| `ExecutionContext` | `agent-base-types/src/domain.ts:303-320` | `{ taskId, sessionId, agentName, agentDefinition, callingAgentName, parentTaskId, rootTaskId, recursionDepth, toolCallCount, inputs? }` |
| `HookEventMap` | `agent-base-types/src/hooks.ts:63-84` | Complete type-safe payload map for all 13 events |
| `IEnforcementError` | `agent-base-types/src/hooks.ts:98-102` | `isEnforcementError: true` duck-type |
| `IToolWarning` | `agent-base-types/src/hooks.ts:113-118` | `isToolWarning: true` duck-type |
| `PluginFactory` | `agent-base-types/src/hooks.ts:183` | Default + named export from plugin packages |
| `configSchema` pattern | Documented in `agent-base-types/src/hooks.ts` docblock & all 3 plugins | Zod schema validated at plugin load time |
| Composed prompt cache | `agent-base-types/src/domain.ts:286-301` | `ComposedPrompt` — core data type for cache + audit |
| `StreamChunk` | `agent-base-types/src/domain.ts:341-343` | Discriminated union for streaming |
| `ProviderAdapter` | `agent-base-types/src/domain.ts:353-358` | Streaming provider interface |
| `ProviderEnvBlock` | `agent-base-types/src/domain.ts:145-152` | Env-var pointer pattern |
| Normalised stop reasons | Comments in `agent-base-types/src/domain.ts:27` | Normalised across providers (referenced as `[ref:normalised-stop-reason]`) |
| postModelResponseUsageShape | `agent-base-types/src/index.ts:19` | Barrel-visible type confirmation |
| TokenUsageExtShape | `agent-base-types/src/index.ts:22-27` | Guarantees `stopReason`, `maxTokens`, `cache*` on public API |
| `__tests__` — test assertions | Various | Tests verify env-name guards, registry retry, context window compaction, DAG cycle detection, policy depth limits, tool naming resolution, usage query, usage normalisation, orchestrator loop, budget plugin, sanitise plugin, composed prompt caching, component store round-trip, tool store round-trip, session store, task store |

---

## SUMMARY: Features my simplified model likely lacks

1. **DAG task lifecycle** — `waiting`/`awaiting_input` statuses, `depends_on`/`onUpstreamFailure`, `DagEngine.dispatchReady()` with optimistic locking, `inputs` from completed upstreams
2. **Three-phase tool execution** — serial pre-dispatch (HITL + enforcement) → Promise.all concurrent execution → serial result append with transform hooks
3. **13-event plugin hook system** with observational vs enforcement split, `IEnforcementError` / `IToolWarning` markers
4. **Composed prompt cache** — SHA-256 context hash (3-part key: context + componentVersions + platform), cache bypass of assembly, runtime resolve at session creation
5. **Tool advertisement modes** — `'names'` with doc block vs `'full'` with JSON schema
6. **Tool naming** — `server__tool` convention, ambiguous name resolution, normalisation
7. **MCP transport** — 4 transport types (stdio/HTTP/SSE/in-process) with per-server `allowedTools`/`disallowedTools`, self-referential guard
8. **Provider usage normalisation** — per-provider caching conventions (Anthropic exclusive vs OpenAI/DeepSeek inclusive), `uncachedInputTokens` + `cache*Tokens` breakdown, `peakContextTokens` (MAX not SUM)
9. **Context window management** — cache-preserving append-only strategy, compact-middle-summarise, `contextWindowFor()` model-specific windows, `groupIntoAtomicUnits()`
10. **Policy engine** — 3-layer depth/loop limit resolution, delegation allowlist (agent → template → server), category inheritance (lazy, no fanout), `overrideConfig` shallow-merge semantics
11. **29 store-level error codes** beyond the canonical 21 — per-store typed errors for tool store, binding store, MCP server store, agent-tool store, component store, composition store, policy stores, etc.
12. **Plugin config hierarchy** — `defaults → agent → provider → tool` with overrides per dimension; ISO8601 time windows; 9 cap dimensions; 4 scopes (task/session/agent/global)
13. **Experiment assignments** — `experiment_assignments` table linking sessions to experiment variants
14. **Agent compilation pipeline** — 4 resolve layers (body/tools/model/policy) dispatched by `header_format` (yaml_frontmatter/json_object/none)
15. **Agent delegation tracking** — `callingAgentName`, `rootTaskId`, `parentTaskId`, delegation session cleanup on failure
