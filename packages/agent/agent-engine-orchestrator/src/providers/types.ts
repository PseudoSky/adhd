import type { Message } from '../validation/index.js';
import type { ToolDefinition, TokenUsage } from '@adhd/agent-base-types';
export type { ToolDefinition, TokenUsage };

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
}

export interface LLMProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
