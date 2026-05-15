import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
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

function toAnthropicTools(tools?: ToolDefinition[]): Tool[] | undefined {
    if (!tools) return undefined;

    return tools.map(tool => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: (tool.inputSchema || {
            type: "object",
            properties: {},
        }) as Tool["input_schema"],
    }));
}

function toAnthropicMessages(messages: Message[]): MessageParam[] {
    // Filter out system messages — they're passed separately in the `system` field
    const nonSystem = messages.filter(m => m.role !== "system");

    return nonSystem.map((message): MessageParam => {
        if (message.role === "tool") {
            const toolResult = message.toolResults?.[0];
            if (!toolResult) {
                throw new Error("Tool message missing tool result");
            }
            return {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: toolResult.toolCallId,
                        content: JSON.stringify(toolResult.result),
                        is_error: toolResult.isError,
                    },
                ],
            };
        }

        if (message.role === "assistant" && message.toolCalls?.length) {
            const contentBlocks: ContentBlockParam[] = [];
            if (message.content) {
                contentBlocks.push({ type: "text", text: message.content });
            }
            for (const tc of message.toolCalls) {
                contentBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.tool,
                    input: tc.arguments as Record<string, unknown>,
                });
            }
            return { role: "assistant", content: contentBlocks };
        }

        if (message.role === "assistant") {
            return { role: "assistant", content: message.content || "" };
        }

        if (message.role === "user") {
            return { role: "user", content: message.content || "" };
        }

        // Should never reach here after filtering system messages
        throw new Error(`Unsupported message role for Anthropic: ${message.role}`);
    });
}

export class AnthropicProvider implements LLMProvider {
    private readonly client: Anthropic;
    private readonly config: Extract<ProviderConfig, { type: "anthropic" }>;

    constructor(config: Extract<ProviderConfig, { type: "anthropic" }>) {
        this.config = config;
        this.client = new Anthropic({
            apiKey: process.env[config.apiKeyEnv ?? "ANTHROPIC_API_KEY"],
        });
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const retryConfig = this.config.retryConfig;

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content || "").join("\n") || undefined;

        const run = async (): Promise<ProviderChatResponse> => {
            const response = await this.client.messages.create(
                {
                    model: this.config.model,
                    system: systemPrompt,
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens ?? 4096,
                    messages: toAnthropicMessages(request.messages),
                    tools: toAnthropicTools(request.tools),
                },
                { signal: request.signal }
            );

            const toolCalls: ToolCall[] = [];
            const contentParts: string[] = [];

            for (const block of response.content) {
                if (block.type === "text") {
                    contentParts.push(block.text);
                }

                if (block.type === "tool_use") {
                    const separatorIndex = block.name.indexOf("__");
                    if (separatorIndex === -1) {
                        throw new Error(`Invalid tool name (missing server prefix): ${block.name}`);
                    }

                    toolCalls.push({
                        id: block.id,
                        server: block.name.slice(0, separatorIndex),
                        tool: block.name.slice(separatorIndex + 2),
                        arguments: block.input,
                    });
                }
            }

            const message: Message = {
                id: generateId(),
                sessionId: "",
                role: "assistant",
                content: contentParts.length > 0 ? contentParts.join("\n") : undefined,
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
                        throw error; // don't retry on cancellation
                    }
                },
            });
        }

        return run();
    }
}
