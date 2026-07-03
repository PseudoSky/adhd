import type { Message } from '../validation/index.js';
import type { ToolDefinition, TokenUsage } from '@adhd/agent-base-types';
export type { ToolDefinition, TokenUsage };

export interface ProviderChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
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
}

export interface LLMProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
