import type { Message } from "../validation/index.js";

/**
 * A tool definition passed to the LLM — describes a single MCP tool.
 * The name is encoded as `<server>__<tool>` for disambiguation.
 */
export interface ToolDefinition {
    /** Fully-qualified name: "<server>__<toolName>" */
    name: string;
    description: string;
    /** JSON Schema object for the tool's input parameters */
    inputSchema: Record<string, unknown>;
}

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
}

export interface ProviderChatResponse {
    message: Message;
    stopReason: "completed" | "tool_calls";
}

export interface LLMProvider {
    chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
