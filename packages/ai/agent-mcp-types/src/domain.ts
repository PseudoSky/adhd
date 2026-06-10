export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;        // normalised stop reason (see [ref:normalised-stop-reason])
  maxTokens?: number;         // configured max_tokens from agent provider config
  cacheReadTokens?: number;   // Anthropic cache_read_input_tokens (undefined for other providers)
  cacheCreationTokens?: number; // Anthropic cache_creation_input_tokens (undefined for other providers)
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskEventType =
  | "MODEL_REQUEST" | "MODEL_RESPONSE"
  | "TOOL_CALL" | "TOOL_RESULT"
  | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED";

export interface Task {
  id: string;
  sessionId: string;
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
  createdAt: string;
  updatedAt: string;
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
