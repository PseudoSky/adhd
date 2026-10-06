/**
 * Normalised, provider-neutral token accounting for a SINGLE model call.
 *
 * Providers disagree on whether their headline input count includes cached tokens:
 *   - Anthropic  `input_tokens`   EXCLUDES cache (add cache_read + cache_creation for the true total)
 *   - OpenAI     `prompt_tokens`  INCLUDES cache (`cached_tokens` is a subset)
 *   - DeepSeek   `prompt_tokens`  INCLUDES cache (`prompt_tokens = hit + miss`)
 *   - Gemini     `promptTokenCount` INCLUDES cache
 *
 * Storing each provider's raw headline in one field makes cross-provider totals,
 * budget caps and cost math silently wrong (Anthropic under-counts). So providers
 * MUST normalise into the shape below at their boundary.
 * See docs/ideas/provider-caching-research.md.
 */
export interface TokenUsage {
  /**
   * TOTAL input the model actually processed for this call:
   * `uncachedInputTokens + cacheReadTokens + cacheCreationTokens`.
   * Uniform across providers regardless of their own convention. This — not any
   * provider's raw headline — is what budget caps and context arithmetic key off.
   *
   * NOTE: summed across a task's model calls this is CUMULATIVE BILLED input, which
   * is NOT a context size. Peak context is tracked separately (`peakContextTokens`).
   */
  inputTokens: number;
  outputTokens: number;
  stopReason?: string; // normalised stop reason (see [ref:normalised-stop-reason])
  maxTokens?: number; // configured max_tokens from agent provider config

  /** Full-price input: the part that missed cache. */
  uncachedInputTokens?: number;
  /** Discounted cache-hit input (Anthropic cache_read, OpenAI/DeepSeek cached_tokens / hit). */
  cacheReadTokens?: number;
  /** Cache-WRITE input. Billed at a premium on Anthropic (1.25x/2x) and OpenAI GPT-5.6+ (1.25x); free on DeepSeek/Gemini. */
  cacheCreationTokens?: number;
  /** Reasoning tokens burned before visible output (reasoning models). Billed as output. */
  reasoningTokens?: number;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting' // blocked on depends_on; DagEngine dispatches when all deps complete
  | 'awaiting_input'; // suspended in HITL Promise; task_resume resolves it
export type TaskEventType =
  | 'MODEL_REQUEST'
  | 'MODEL_RESPONSE'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_CANCELLED';

export interface Task {
  id: string;
  /** Undefined for ephemeral (agent_name one-shot) tasks; present for session-backed tasks. */
  sessionId?: string;
  /** True for ephemeral one-shot tasks that have no session row and no messages rows. */
  isEphemeral: boolean;
  parentTaskId?: string;
  recursionDepth: number;
  status: TaskStatus;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  // Dependency DAG fields
  dependsOn?: string[] | null;
  onUpstreamFailure?: 'fail' | 'skip' | null;
  inputs?: Record<string, string> | null;
  // HITL suspension field
  resumeToken?: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  payload?: unknown;
  createdAt: string;
}

export type SessionStatus = 'active' | 'closed';

export interface Session {
  id: string;
  agentName: string;
  agentVersion: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  isError: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: string;
}

export interface RetryConfig {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  factor: number;
}

/**
 * Provider configuration stored in an agent definition.
 *
 * Credentials are **env-var pointers** (names, never values) stored in the
 * `env` block so they never leak through `agent_read` / `agent_list`. Inline
 * literal fields (`baseURL`, `model`) are also accepted as fallbacks.
 *
 * Legacy fields `apiKeyEnv`, `authTokenEnv`, `useClaudeOauth`, and the
 * `"lmstudio"` type are coerced to the unified shape on read by the
 * normalize-on-load shim in `validation/agent.ts` — no migration needed.
 * LM Studio is just `type: "openai"` with a localhost `baseURL`.
 */
export type ProviderEnvBlock = {
  /** Env-var NAME whose value is the credential (API key or OAuth token). */
  secret?: string;
  /** Env-var NAME whose value is the provider base URL. */
  base_url?: string;
  /** Env-var NAME whose value is the model id. */
  model?: string;
};

export type ProviderConfig =
  | {
      type: 'anthropic';
      /** Inline model id — may also be supplied via env.model. */
      model?: string;
      /** Env-var pointers (ADHD_AGENT_*-prefixed names only). */
      env?: ProviderEnvBlock;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      retryConfig?: RetryConfig;
    }
  | {
      type: 'openai';
      /** Inline model id — may also be supplied via env.model. */
      model?: string;
      /** Env-var pointers (ADHD_AGENT_*-prefixed names only). */
      env?: ProviderEnvBlock;
      /** Inline literal base URL — normalised to include /v1 if absent.
       *  LM Studio: set to "http://localhost:1234/v1" (no secret required). */
      baseURL?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      retryConfig?: RetryConfig;
    }
  /** Uses the local `claude` CLI (Claude Code) as a subprocess provider. Works with any auth
   *  method already configured in Claude Code (subscription, API key, OAuth).
   *  All Claude Code built-in tools are disallowed by default; only MCP tools from
   *  `mcpServers` are available. Use `allowedBuiltinTools` to selectively re-enable
   *  specific built-ins (e.g. `["WebFetch"]`). */
  | {
      type: 'claudecli';
      model?: string;
      claudePath?: string;
      timeoutMs?: number;
      /**
       * Claude Code built-in tool names to permit in the subprocess.
       * Everything not listed is passed to --disallowedTools.
       * MCP tools (from mcpServers) are always available regardless of this list.
       *
       * Ignored when `systemPromptIsAgentSpec` is `true` — in that mode the agent
       * spec's own frontmatter `tools:` header governs tool access.
       */
      allowedBuiltinTools?: string[];
      /**
       * When `true`, the agent's `systemPrompt` is treated as a complete Claude Code
       * agent markdown file (YAML frontmatter header + body). The provider writes it
       * to a temp project dir and lets Claude **internally parse the header** —
       * including the `tools:` field — which then governs tool access and TAKES
       * PRECEDENCE over the built-in `--disallowedTools` enumeration. In this mode the
       * provider passes `--add-dir/--setting-sources project/--agent` instead of
       * `--system-prompt`/`--disallowedTools`, so the spec header is the single source
       * of truth for available built-ins (omit `tools:` to inherit all; list
       * `mcp__<server>__<tool>` entries to expose specific MCP tools).
       * Defaults to `false`/`undefined` (legacy denylist behavior, backward compatible).
       */
      systemPromptIsAgentSpec?: boolean;
    };

type McpServerTransportConfig =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /**
       * Working directory for the spawned stdio child (ADR-0008 D9). Injected at
       * TASK time from the dispatching host's cwd; a definition never stores a
       * resolved root. When absent the child inherits the parent process cwd.
       */
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      transport: 'http';
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    }
  | {
      transport: 'sse';
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    };

export type McpServerConfig = McpServerTransportConfig & {
  /** Allowlist: if set, only these tool names are exposed. Tools in this list are also checked against disallowedTools. */
  allowedTools?: string[];
  /** Denylist: tools to hide from listing and reject at runtime. Takes precedence over allowedTools. */
  disallowedTools?: string[];
};

export interface AgentPermissions {
  allowedAgents?: string[];
}

// ── Native tooling (ADR-0008) ────────────────────────────────────────────────
// A standardized, PORTABLE native toolset — filesystem, shell, and dispatch self —
// described by AgentDefinition.nativeTooling and resolved at TASK time against the
// dispatching cwd by @adhd/agent-core-native-tooling. The definition carries no
// resolved root; only the declarative config below (ADR-0008 D3/D4/D8).

/**
 * A single permission decision for a native tool call (ADR-0008 D5).
 * `allow` runs the tool; `deny` refuses with a typed error; `ask` is routed through
 * the fixed ask-resolution chain (`suspend` → `escalate` → `deny`, ADR-0008 D6).
 */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/**
 * One entry of a permission rule map. The matched resource is a **tool NAME**
 * (e.g. `fs`, `shell`, `agent-mcp.*`), never command text (ADR-0008 D5).
 */
export interface PermissionRule {
  /** Tool-name glob (`*` matches any run of characters); never a shell command. */
  resource: string;
  action: PermissionAction;
}

/**
 * Ordered tool-name-pattern → action map. Evaluated **last-match-wins with `deny`
 * terminal**: the last matching rule wins, and once any `deny` rule matches the
 * result is `deny` regardless of later rules (ADR-0008 D5; Q1 ratified).
 */
export type PermissionRuleMap = Record<string, PermissionAction>;

/**
 * Overrides for the builtin filesystem tool
 * (`@modelcontextprotocol/server-filesystem`, ADR-0008 D7). Omit `root`/`roots`
 * to use the dispatching caller cwd.
 *
 * PORTABILITY (D4/D8; the fs analogue of the welded-`provider` bug): `root` and
 * `roots` are **portable hints**, NOT host paths. A hint is EITHER a
 * cwd-relative subpath (resolved against the caller cwd at task time) OR a named
 * alias into the GLOBAL allowed-root map (alias → absolute path, machine-owned
 * by the operator's config). An ABSOLUTE path in a definition is REJECTED at
 * resolution with a typed `NativeToolingRootError` — it would weld a host path
 * into a record that must be reusable from any directory. This keeps the stored
 * definition byte-identical across fires from different cwds.
 */
export interface FsBuiltinOverrides {
  /**
   * The filesystem root HINT. Defaults to the dispatching caller cwd. Either a
   * cwd-relative subpath or a named alias in the global allowed-root map —
   * never an absolute path (rejected at resolution).
   */
  root?: string;
  /**
   * MULTIPLE filesystem roots exposed to the adopted reference fs server
   * (`@modelcontextprotocol/server-filesystem`), which accepts one allowed
   * directory per argv entry and treats the whole set as a containment
   * allow-list (ADR-0008 D7).
   *
   * PRECEDENCE: when `roots` is a non-empty array it WINS and `root` is ignored;
   * otherwise the resolver emits `[root]`, or `[callerCwd]` when neither is
   * given. Each entry is a PORTABLE HINT — a cwd-relative subpath or a named
   * alias in the global allowed-root map (never an absolute path). A cwd-relative
   * `..` subpath must not escape the caller cwd. The host unions every resolved
   * root into the per-run `srt` policy's `allowWrite`, so a read from a SECOND
   * root is not sandbox-denied (finding 535c1101 / A3; AC6).
   *
   * Per-root read-only is NOT available: the reference server exposes no stdio
   * read-only flag, so `readOnly` remains a GLOBAL (whole-server) reservation,
   * enforced via `srt`/Docker `ro` (ADR-0008 D7).
   */
  roots?: string[];
  /**
   * Reserved. The reference fs server exposes no stdio read-only flag; read-only
   * roots are enforced via `srt` / Docker `ro` (ADR-0008 D7, NAT-TOOL-8).
   */
  readOnly?: boolean;
  /** Tool-name rules (the thin gate; ADR-0008 D5). */
  permissions?: PermissionRuleMap;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Overrides for the builtin shell tool (`tumf/mcp-shell-server`, ADR-0008 D7).
 * `allowCommands` is a **passthrough** of the adopted server's own argv allowlist
 * (config plumbing only) — the harness runs NO command parser and owns NO
 * dangerous-command catalog (ADR-0008 D5). There is deliberately NO
 * `denyCommands`: the adopted server is allow-list only, and D5 forbids the
 * harness from owning per-command deny semantics (a deny-list would be a silent
 * no-op).
 */
export interface ShellBuiltinOverrides {
  /** Working directory for spawned commands. Defaults to the dispatching cwd. */
  root?: string;
  /** Tool-name rules (the thin gate; ADR-0008 D5). */
  permissions?: PermissionRuleMap;
  /** Command NAMES accepted by the adopted argv-allowlist server. */
  allowCommands?: string[];
  /** Default command timeout, in milliseconds. */
  timeoutMs?: number;
  /** Extra environment for the shell server process. */
  env?: Record<string, string>;
}

/** Overrides for the builtin dispatch self tool (the real agent-mcp server; D1). */
export interface DispatchBuiltinOverrides {
  /** Tool-name rules (the thin gate; ADR-0008 D5). */
  permissions?: PermissionRuleMap;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** `true` = the zero-override builtin; a `McpServerConfig` REPLACES the builtin (D3). */
export type FsToolConfig = boolean | FsBuiltinOverrides | McpServerConfig;
export type ShellToolConfig = boolean | ShellBuiltinOverrides | McpServerConfig;
export type DispatchToolConfig = boolean | DispatchBuiltinOverrides | McpServerConfig;

/** One link of the fixed ask-resolution chain (ADR-0008 D6). */
export type AskResolution = 'suspend' | 'escalate' | 'deny';

/**
 * @deprecated Retired by ADR-0008 D6 — the `ask` chain is **fixed**
 * (`suspend` → `escalate` → `deny`); the only knob is {@link NativeToolingConfig.hitl}.
 * Accepted at the validation boundary for compatibility only; the resolver and the
 * ask-resolution policy do NOT consult it.
 */
export interface AskPolicy {
  order: AskResolution[];
  escalateTo: 'parent';
}

/**
 * The standardized native toolset for a dispatched agent (ADR-0008 D3).
 * Each tool member:
 *   - `false`         → the builtin is not resolved (no server emitted);
 *   - `true`          → the zero-override builtin (canonicalized to the override object);
 *   - `…Overrides`    → the builtin with the given overrides;
 *   - `McpServerConfig` → a full server config that REPLACES the builtin.
 */
export interface NativeToolingConfig {
  fs?: FsToolConfig;
  shell?: ShellToolConfig;
  dispatch?: DispatchToolConfig;
  /**
   * Human-in-the-loop enablement (ADR-0008 D6). Default `true`. When `false`,
   * `request_human_input` is hidden and `suspend` is pruned from the ask chain, so
   * an `ask` degrades to `escalate` (if parented) or `deny`.
   * Legacy alias: {@link AgentDefinition.allowHumanInput}.
   */
  hitl?: boolean;
  /** @deprecated see {@link AskPolicy}. */
  askPolicy?: AskPolicy;
}

/**
 * Resolve the effective HITL setting for a definition, honoring the legacy
 * `allowHumanInput` alias (ADR-0008 D6). `nativeTooling.hitl` WINS when both are
 * present. Returns `undefined` when neither is set — consumers apply the ADR
 * default (`hitl !== false` ⇒ enabled).
 */
export function effectiveHitl(
  def: Pick<AgentDefinition, 'allowHumanInput' | 'nativeTooling'>
): boolean | undefined {
  const explicit = def.nativeTooling?.hitl;
  if (explicit !== undefined) return explicit;
  return def.allowHumanInput;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  version: number;
  provider: ProviderConfig;
  /**
   * COMPUTED COMPAT SHIM — never user-authored after Plan 6 wave 3 (agent-store-retire).
   *
   * Populated at session start from `compileAgent().content`. The `AgentStore`
   * is now a thin compiled-agent cache; this field holds the resolved system
   * prompt produced by the compiler/registry, not a user-supplied blob.
   *
   * Callers in `tools/task.ts` and `store/session-store.ts` read this field
   * unchanged — they receive the compiler-resolved value set by
   * `compiler-integration`, not an authored string.
   */
  systemPrompt?: string;
  mcpServers: Record<string, McpServerConfig>;
  permissions: AgentPermissions;
  /**
   * Standardized, portable native toolset (ADR-0008). Resolved at TASK time against
   * the dispatching cwd; never mutated by resolution and never carries a resolved root.
   */
  nativeTooling?: NativeToolingConfig;
  maxToolLoops?: number;
  /**
   * When `true`, advertise the built-in `builtin__request_human_input` tool to
   * the model so it can pause a task to ask the human operator a question.
   * Defaults to `false` / `undefined` (opt-in, backward compatible).
   * Has no effect on ephemeral tasks (no DB row to persist the resume token).
   */
  allowHumanInput?: boolean;
  /**
   * Controls how MCP tools are advertised to the model:
   * - `"names"` (default): list tool names in a compact doc block
   * - `"full"`: include full JSON Schema for each tool
   */
  toolAdvertisement?: 'names' | 'full';
  /**
   * When NOT `false`, a provider that supports native (server-side) web tools
   * (currently Anthropic) advertises `web_search` and `web_fetch` to the
   * model by default, so a dispatched agent can run a real web search/fetch
   * without any client-side tool wiring (backlog 1abd2d84). Set to `false` to
   * opt out. Has no effect on providers without native web tools.
   */
  nativeWebTools?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Composed-prompt cache (agent-mcp runtime sink, Domain 5) ─────────────────
// Keyed by (agent_slug, context_hash); written by compiler-integration on cache-miss.

export interface ComposedPrompt {
  /** Row id — written to sessions.composed_prompt_id at session start. */
  id: string;
  /** Slug of the agent whose prompt was compiled. */
  agentSlug: string;
  /**
   * Opaque hash of the compilation context (e.g. SHA-256 of registry component
   * versions). The cache lookup key together with agentSlug.
   */
  contextHash: string;
  /** Flat, fully-resolved system-prompt string produced by compileAgent(). */
  content: string;
  /** JSON-serialised record of component-version ids used during compilation. */
  componentVersions: string;
  createdAt: string;
}

export interface ExecutionContext {
  taskId: string;
  sessionId: string;
  agentName: string;
  agentDefinition: AgentDefinition;
  callingAgentName?: string;
  parentTaskId?: string;
  /** Root task ID in the delegation chain. Null/undefined means this task IS the root. */
  rootTaskId?: string;
  recursionDepth: number;
  toolCallCount: number;
  /**
   * The caller-supplied cwd for this task (ADR-0008 D4; caller-cwd contract).
   *
   * Sourced from the `task`/`agent` MCP input by the MCP caller, or INHERITED
   * from the dispatching parent's {@link ExecutionContext} on a sub-dispatch, so
   * a child resolves its fs/shell roots against the parent's cwd. Absent ⇒ the
   * host falls back to its own `process.cwd()` (flagged — it "may not be the
   * agent's cwd"). Threaded to native-tooling resolution and to a further
   * sub-dispatch; never persisted on the stored definition (D4/D8).
   */
  cwd?: string;
  /**
   * Upstream task results keyed by upstream taskId. Populated by DagEngine at
   * dispatch time from completed upstream task rows. Only present for tasks that
   * have `depends_on` entries. Failed/cancelled upstreams are omitted.
   */
  inputs?: Record<string, string>;
}

/**
 * Tool descriptor passed to the LLM. Name is encoded as `<server>__<tool>`.
 * description is required — matches the existing definition in providers/types.ts.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Provider Adapter contract (agent-registry plan: agent-provider) ────────────
// Defined here (not in agent-provider) so that agent-mcp can depend on the
// interface without creating a circular dependency.  Dependency direction:
//   agent-mcp-types ← agent-provider ← agent-mcp

/**
 * A streaming chunk emitted by a ProviderAdapter.stream() call.
 * Discriminated union — add variants as new delta kinds are needed.
 */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string };

/**
 * Adapter interface that wraps a single AI provider.
 * Implemented in @adhd/agent-provider; consumed by @adhd/agent-mcp.
 *
 * `model` is the **canonical** model id (e.g. `claude_opus_4_8`); the
 * implementation resolves it to a per-platform string via ModelStore before
 * calling the upstream API.
 */
export interface ProviderAdapter {
  stream(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    model: string
  ): AsyncIterable<StreamChunk>;
}
