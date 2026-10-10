import type { Message } from '../validation/index.js';
import type { PermissionAction, ToolDefinition, TokenUsage } from '@adhd/agent-base-types';
export type { ToolDefinition, TokenUsage };

/**
 * The server name the permission gate sees for the `claude` CLI's own built-in tools
 * (`claude-builtin.Bash`, `claude-builtin.Read`, ...). Rules scope them like any server-qualified
 * tool name (`'claude-builtin.*': 'deny'`); a `'*'` rule also matches them.
 */
export const CLAUDE_BUILTIN_SERVER = 'claude-builtin';

/**
 * A provider-native (server-side) tool entry: emitted to the provider API as
 * a type-tagged object (`{ type: 'web_search_20250305', name: 'web_search' }`)
 * and executed by the PROVIDER, never by the client. Mirrors the
 * `EmittedServerSideTool` shape from `@adhd/agent-core-provider`'s emitter
 * (backlog 1abd2d84 — wiring that emitter into the live provider path).
 */
export interface ServerSideTool {
  type: string;
  name: string;
}

export interface ProviderChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  /** Provider-native type-tagged tools the provider executes server-side. */
  serverSideTools?: ServerSideTool[];
  signal?: AbortSignal;
  /**
   * GOV (f9dadeaa): the permission verdict for one provider-INTERNAL built-in tool (the `claude`
   * CLI's Bash/Read/Edit/Write/...). The engine answers it from its `permissionGate` with
   * `server = {@link CLAUDE_BUILTIN_SERVER}`. A provider that runs its own tool loop MUST NOT expose
   * a built-in whose verdict is not `'allow'` (`'ask'` cannot be answered inside the provider's loop).
   * Absent => no governance info (providers treat every built-in as allowed).
   */
  builtinToolPolicy?: (tool: string) => PermissionAction;
  executeTool?: (
    server: string,
    tool: string,
    args: unknown
  ) => Promise<{ result: unknown; isError: boolean }>;
}

export interface ProviderChatResponse {
  message: Message;
  stopReason: 'completed' | 'tool_calls';
  usage?: TokenUsage;
  rawUsage?: unknown;
  /**
   * Usage-accounting only. Tool invocations the provider executed ITSELF inside this
   * single response (e.g. the claude CLI running built-in tools). Never executed or
   * re-driven by the orchestrator — do not confuse with `message.toolCalls`, which
   * the orchestrator loop executes. Absent for providers that don't run tools internally.
   */
  reportedToolUses?: number;
  /**
   * Usage-accounting only. Real model-call count behind this response when the provider
   * ran several internal turns in one invocation (claudecli `num_turns`). Absent means 1.
   */
  reportedModelCalls?: number;
  /**
   * Model id the provider says actually served this call (`response.model`). Absent when
   * the provider does not report one (claudecli: its `result` event has no verified
   * single-model field, so it is deliberately left unset).
   */
  responseModel?: string;
}

export interface LLMProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
