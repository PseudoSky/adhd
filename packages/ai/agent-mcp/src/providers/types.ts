import type { Message } from "../validation/index.js";
import type { ToolDefinition, TokenUsage } from "@adhd/agent-mcp-types";
export type { ToolDefinition, TokenUsage };

export interface ProviderChatRequest {
    messages: Message[];
    tools?: ToolDefinition[];
    /**
     * AbortSignal composed by the orchestrator from:
     *   - the task's cancellation controller signal
     *   - AbortSignal.timeout(provider.timeoutMs ?? 60_000)
     *
     * Providers must NOT reapply their own timeout internally.
     */
    signal?: AbortSignal;
    /**
     * Callback for providers that run their own internal tool loop (e.g. claudecli).
     * The orchestrator builds this from the per-task McpClientRegistry so the
     * provider can execute MCP tools without owning the registry itself.
     *
     * Providers that return stopReason "tool_calls" (anthropic, openai, lmstudio)
     * do NOT use this — the orchestrator handles tool execution for them.
     */
    executeTool?: (
        server: string,
        tool: string,
        args: unknown
    ) => Promise<{ result: unknown; isError: boolean }>;
}

export interface ProviderChatResponse {
    message: Message;
    stopReason: "completed" | "tool_calls";
    usage?: TokenUsage;
}

export interface LLMProvider {
    chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
