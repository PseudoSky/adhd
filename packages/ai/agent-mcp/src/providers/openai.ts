import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import pRetry from "p-retry";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";
import { config } from "../config.js";

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
    private readonly providerConfig: Extract<ProviderConfig, { type: "openai" }>;
    /** Resolved model id (from env or inline field). */
    protected readonly resolvedModel: string;

    constructor(providerConfig: Extract<ProviderConfig, { type: "openai" }>) {
        this.providerConfig = providerConfig;

        // Resolve credentials, URL, and model via the sole env-reader (config).
        // Fails loud for non-localhost base URLs without a secret (§3).
        // Localhost servers (LM Studio, etc.) are exempt — no secret required.
        // DEBT-005: timeout is forwarded to the SDK client so our AbortSignal.timeout()
        // always fires first, producing PROVIDER_TIMEOUT instead of a generic SDK error.
        const resolved = config.getProviderConfig({
            provider:     "openai",
            secret:       providerConfig.env?.secret,
            url:          providerConfig.env?.base_url,
            model:        providerConfig.env?.model,
            inlineBaseURL: providerConfig.baseURL,
            inlineModel:  providerConfig.model,
        });

        this.resolvedModel = resolved.model ?? providerConfig.model ?? "";

        this.client = new OpenAI({
            // Localhost-exempt servers have no secret; "no-auth" is ignored by the server.
            apiKey:  resolved.secret ?? "no-auth",
            baseURL: resolved.baseURL,
            timeout: providerConfig.timeoutMs ?? 60_000,
        });
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const retryConfig = this.providerConfig.retryConfig;

        const run = async (): Promise<ProviderChatResponse> => {
            const response = await this.client.chat.completions.create(
                {
                    model: this.resolvedModel,
                    temperature: this.providerConfig.temperature,
                    max_tokens: this.providerConfig.maxTokens,
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
                        maxTokens: this.providerConfig.maxTokens,
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
