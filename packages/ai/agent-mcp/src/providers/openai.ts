import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import pRetry from "p-retry";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";

import type {
    LLMProvider,
    ProviderChatRequest,
    ProviderChatResponse,
    ToolDefinition,
} from "./types.js";

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map(message => {
        switch (message.role) {
            case "system":
                return { role: "system", content: message.content || "" };
            case "user":
                return { role: "user", content: message.content || "" };
            case "assistant": {
                if (message.toolCalls && message.toolCalls.length > 0) {
                    return {
                        role: "assistant",
                        content: message.content ?? null,
                        tool_calls: message.toolCalls.map(tc => ({
                            id: tc.id,
                            type: "function" as const,
                            function: {
                                name: `${tc.server}__${tc.tool}`,
                                arguments: JSON.stringify(tc.arguments),
                            },
                        })),
                    };
                }
                return { role: "assistant", content: message.content || "" };
            }
            case "tool": {
                const toolResult = message.toolResults?.[0];
                if (!toolResult) {
                    throw new Error("Tool message missing tool result");
                }
                return {
                    role: "tool",
                    tool_call_id: toolResult.toolCallId,
                    content: JSON.stringify(toolResult.result),
                };
            }
            default: {
                const exhaustive: never = message.role;
                throw new Error(`Unsupported message role: ${exhaustive}`);
            }
        }
    });
}

function toOpenAITools(tools?: ToolDefinition[]): ChatCompletionTool[] | undefined {
    if (!tools) return undefined;

    return tools.map(tool => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description || "",
            parameters: (tool.inputSchema || {
                type: "object",
                properties: {},
            }) as Record<string, unknown>,
        },
    }));
}

export class OpenAIProvider implements LLMProvider {
    protected readonly client: OpenAI;
    private readonly config: Extract<ProviderConfig, { type: "openai" }>;

    constructor(config: Extract<ProviderConfig, { type: "openai" }>) {
        this.config = config;
        // DEBT-005: pass timeoutMs to the SDK client so the SDK's built-in HTTP
        // timeout (default ~10 min) never fires before our AbortSignal.timeout().
        // Without this, slow local models exceed the SDK default and throw a
        // generic "Request timed out" (APIConnectionTimeoutError) that hits the
        // catch-all PROVIDER_ERROR branch instead of the actionable PROVIDER_TIMEOUT,
        // and raising timeoutMs has no effect. Aligning the two means our
        // composedSignal always fires first, giving the right error + message.
        // Fall back to "lmstudio" when the env var is absent so the OpenAI SDK
        // never receives `undefined`. This is the canonical no-auth placeholder
        // for LM Studio (which ignores the Authorization header value entirely);
        // for real OpenAI usage the env var will always be set so this path
        // is never reached in practice.
        this.client = new OpenAI({
            apiKey: process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"] ?? "lmstudio",
            baseURL: config.baseURL,
            timeout: config.timeoutMs ?? 60_000,
        });
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const retryConfig = this.config.retryConfig;

        const run = async (): Promise<ProviderChatResponse> => {
            const response = await this.client.chat.completions.create(
                {
                    model: this.config.model,
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens,
                    messages: toOpenAIMessages(request.messages),
                    tools: toOpenAITools(request.tools),
                },
                { signal: request.signal }
            );

            const choice = response.choices[0];
            const toolCalls: ToolCall[] = [];

            if (choice?.message.tool_calls) {
                for (const tc of choice.message.tool_calls) {
                    if (tc.type !== "function") continue;

                    // Resolve qualified or bare tool names against the advertised set
                    // (a bare `task` → `agent-mcp__task` when unambiguous; DEBT-004).
                    const { server, tool } = resolveToolCallName(
                        tc.function.name,
                        (request.tools ?? []).map((t) => t.name)
                    );

                    toolCalls.push({
                        id: tc.id,
                        server,
                        tool,
                        arguments: JSON.parse(tc.function.arguments),
                    });
                }
            }

            const message: Message = {
                id: generateId(),
                sessionId: "",
                role: "assistant",
                content: choice?.message.content ?? undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                createdAt: nowIso(),
            };

            const sdkUsage = response.usage;
            const STOP_REASON: Record<string, string> = {
                stop: "stop", length: "length", tool_calls: "tool_calls",
            };
            const rawFinishReason = choice?.finish_reason ?? null;
            const normalisedStopReason: string = STOP_REASON[rawFinishReason ?? ""] ?? "unknown";
            return {
                message,
                stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
                usage: sdkUsage
                    ? {
                        inputTokens: sdkUsage.prompt_tokens,
                        outputTokens: sdkUsage.completion_tokens,
                        stopReason: normalisedStopReason,
                        maxTokens: this.config.maxTokens,
                    }
                    : undefined,
            };
        };

        if (retryConfig) {
            return pRetry(run, {
                retries: retryConfig.retries,
                minTimeout: retryConfig.minTimeout,
                maxTimeout: retryConfig.maxTimeout,
                factor: retryConfig.factor,
                onFailedAttempt: error => {
                    if (request.signal?.aborted) {
                        throw error;
                    }
                },
            });
        }

        return run();
    }
}
