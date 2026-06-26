export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;        // normalised stop reason (see [ref:normalised-stop-reason])
  maxTokens?: number;         // configured max_tokens from agent provider config
  cacheReadTokens?: number;   // Anthropic cache_read_input_tokens (undefined for other providers)
  cacheCreationTokens?: number; // Anthropic cache_creation_input_tokens (undefined for other providers)
}

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting"         // blocked on depends_on; DagEngine dispatches when all deps complete
  | "awaiting_input"; // suspended in HITL Promise; task_resume resolves it
export type TaskEventType =
  | "MODEL_REQUEST" | "MODEL_RESPONSE"
  | "TOOL_CALL" | "TOOL_RESULT"
  | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED";

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
  onUpstreamFailure?: "fail" | "skip" | null;
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

export type SessionStatus = "active" | "closed";

export interface Session {
  id: string;
  agentName: string;
  agentVersion: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

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

export type ProviderConfig =
  | { type: "anthropic"; model: string; apiKeyEnv?: string; authTokenEnv?: string; useClaudeOauth?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "openai";    model: string; apiKeyEnv?: string; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  | { type: "lmstudio";  model: string; apiKeyEnv?: string; baseURL?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; retryConfig?: RetryConfig }
  /** Uses the local `claude` CLI (Claude Code) as a subprocess provider. Works with any auth
   *  method already configured in Claude Code (subscription, API key, OAuth).
   *  All Claude Code built-in tools are disallowed by default; only MCP tools from
   *  `mcpServers` are available. Use `allowedBuiltinTools` to selectively re-enable
   *  specific built-ins (e.g. `["WebFetch"]`). */
  | {
      type: "claudecli";
      model?: string;
      claudePath?: string;
      timeoutMs?: number;
      /**
       * Claude Code built-in tool names to permit in the subprocess.
       * Everything not listed is passed to --disallowedTools.
       * MCP tools (from mcpServers) are always available regardless of this list.
       */
      allowedBuiltinTools?: string[];
    };

export type McpServerConfig =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }
  | { transport: "http";  url: string; headers?: Record<string, string>; timeoutMs?: number }
  | { transport: "sse";   url: string; headers?: Record<string, string>; timeoutMs?: number };

export interface AgentPermissions {
  allowedAgents?: string[];
}

export interface AgentDefinition {
  name: string;
  description?: string;
  version: number;
  provider: ProviderConfig;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  permissions: AgentPermissions;
  maxToolLoops?: number;
  /**
   * When `true`, advertise the built-in `builtin__request_human_input` tool to
   * the model so it can pause a task to ask the human operator a question.
   * Defaults to `false` / `undefined` (opt-in, backward compatible).
   * Has no effect on ephemeral tasks (no DB row to persist the resume token).
   */
  allowHumanInput?: boolean;
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
  | { type: "text";      text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string };

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
