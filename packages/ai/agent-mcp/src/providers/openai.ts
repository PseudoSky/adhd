import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import pRetry from "p-retry";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

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
        this.client = new OpenAI({
            apiKey: process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"],
            baseURL: config.baseURL,
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

                    const separatorIndex = tc.function.name.indexOf("__");
                    if (separatorIndex === -1) {
                        throw new Error(`Invalid tool name (missing server prefix): ${tc.function.name}`);
                    }

                    toolCalls.push({
                        id: tc.id,
                        server: tc.function.name.slice(0, separatorIndex),
                        tool: tc.function.name.slice(separatorIndex + 2),
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

            return {
                message,
                stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
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
