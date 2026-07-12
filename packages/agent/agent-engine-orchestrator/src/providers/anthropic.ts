import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import pRetry from "p-retry";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";
import type { TokenUsage } from "@adhd/agent-base-types";
import { ToolError } from "../validation/errors.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";

import type {
    LLMProvider,
    ProviderChatRequest,
    ProviderChatResponse,
    ToolDefinition,
} from "./types.js";

// ─── Model max-output token table ────────────────────────────────────────────
const MODEL_MAX_TOKENS: [prefix: string, maxTokens: number][] = [
    ["claude-fable-5",          128_000],
    ["claude-mythos-5",         128_000],
    ["claude-opus-4-8",         128_000],
    ["claude-opus-4-7",         128_000],
    ["claude-opus-4-6",         128_000],
    ["claude-opus-4-5",          64_000],
    ["claude-opus-4-1",          32_000],
    ["claude-opus-4-0",          32_000],
    ["claude-opus-4",           128_000],
    ["claude-sonnet-4",          64_000],
    ["claude-haiku-4",           64_000],
    ["claude-3-5-sonnet",         8_192],
    ["claude-3-5-haiku",          8_192],
    ["claude-3-opus",             4_096],
    ["claude-3-sonnet",           4_096],
    ["claude-3-haiku",            4_096],
];

/**
 * Anthropic is the ONE provider whose headline `input_tokens` EXCLUDES cached tokens —
 * it reports only the uncached tail after the last cache breakpoint. OpenAI, DeepSeek and
 * Gemini all report an INCLUSIVE headline.
 *
 * So the true total input Anthropic processed is:
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Storing the raw `input_tokens` in the same column as the other providers' inclusive
 * headline systematically UNDER-COUNTS Anthropic spend (on a cache-warm run most input
 * lives in cache_read) and makes budget caps bite openai-provider agents far sooner than
 * anthropic ones for identical real usage. See BUG-ORCH-010.
 */
export function normaliseAnthropicUsage(
    sdkUsage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
    },
    stopReason: string,
    maxTokens: number
): TokenUsage {
    const cacheRead = sdkUsage.cache_read_input_tokens ?? 0;
    const cacheWrite = sdkUsage.cache_creation_input_tokens ?? 0;
    const uncached = sdkUsage.input_tokens;

    return {
        // Reconstruct the true total — do NOT pass Anthropic's headline through directly.
        inputTokens: uncached + cacheRead + cacheWrite,
        outputTokens: sdkUsage.output_tokens,
        uncachedInputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        stopReason,
        maxTokens,
    };
}

function defaultMaxTokens(model: string, config: EngineConfig): number {
    for (const [prefix, maxTokens] of MODEL_MAX_TOKENS) {
        if (model.startsWith(prefix)) return maxTokens;
    }
    return config.server.defaultMaxTokens;
}

// ─── Wire-form inference ─────────────────────────────────────────────────────

interface AnthropicClientParts {
    client: Anthropic;
    useOauthIdentity: boolean;
}

function buildAnthropicClient(
    secret: string,
    timeoutMs: number | undefined
): AnthropicClientParts {
    if (secret.startsWith("sk-ant-api")) {
        return {
            client: new Anthropic({ apiKey: secret, timeout: timeoutMs }),
            useOauthIdentity: false,
        };
    }
    const isOauth = secret.startsWith("sk-ant-oat");
    return {
        client: new Anthropic({
            authToken: secret,
            timeout: timeoutMs,
            ...(isOauth ? { defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } } : {}),
        }),
        useOauthIdentity: isOauth,
    };
}

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

        throw new Error(`Unsupported message role for Anthropic: ${message.role}`);
    });
}

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export class AnthropicProvider implements LLMProvider {
    private readonly client: Anthropic;
    private readonly providerConfig: Extract<ProviderConfig, { type: "anthropic" }>;
    private readonly useOauthIdentity: boolean;
    private readonly logger: EngineLogger;
    private readonly config: EngineConfig;

    constructor(
        providerConfig: Extract<ProviderConfig, { type: "anthropic" }>,
        config: EngineConfig,
        logger: EngineLogger
    ) {
        this.providerConfig = providerConfig;
        this.config = config;
        this.logger = logger;

        const resolved = config.getProviderConfig({
            provider: "anthropic",
            secret:      providerConfig.env?.secret,
            model:       providerConfig.env?.model,
            inlineModel: providerConfig.model,
        });

        if (!resolved.secret) {
            throw new ToolError(
                "PROVIDER_AUTH_ERROR",
                `Anthropic requires a credential. ` +
                `Set ADHD_AGENT_ANTHROPIC_SECRET in your ~/.adhd/.env ` +
                `(run \`claude setup-token\` to obtain an OAuth access token, ` +
                `or use your console.anthropic.com API key).`
            );
        }

        const { client, useOauthIdentity } = buildAnthropicClient(
            resolved.secret,
            providerConfig.timeoutMs
        );

        this.client = client;
        this.useOauthIdentity = useOauthIdentity;
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const retryConfig = this.providerConfig.retryConfig;

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content || "").join("\n") || undefined;

        const run = async (): Promise<ProviderChatResponse> => {
            const effectiveSystem = this.useOauthIdentity
                ? [
                      { type: "text" as const, text: CLAUDE_CODE_IDENTITY },
                      ...(systemPrompt
                          ? [{ type: "text" as const, text: systemPrompt }]
                          : []),
                  ]
                : systemPrompt;

            const effectiveModel = this.providerConfig.model ?? "";
            if (!effectiveModel) {
                this.logger.warn("AnthropicProvider: no model configured; API will likely reject");
            }

            const stream = this.client.messages.stream(
                {
                    model: effectiveModel,
                    system: effectiveSystem,
                    temperature: this.providerConfig.temperature,
                    max_tokens: this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel, this.config),
                    messages: toAnthropicMessages(request.messages),
                    tools: toAnthropicTools(request.tools),
                },
                { signal: request.signal }
            );
            const response = await stream.finalMessage();

            const toolCalls: ToolCall[] = [];
            const contentParts: string[] = [];

            for (const block of response.content) {
                if (block.type === "text") {
                    contentParts.push(block.text);
                }

                if (block.type === "tool_use") {
                    const { server, tool } = resolveToolCallName(
                        block.name,
                        (request.tools ?? []).map((t) => t.name)
                    );

                    toolCalls.push({
                        id: block.id,
                        server,
                        tool,
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

            const sdkUsage = response.usage;
            const STOP_REASON: Record<string, string> = {
                end_turn: "stop", max_tokens: "length", tool_use: "tool_calls",
            };
            const normalisedStopReason: string = STOP_REASON[response.stop_reason ?? ""] ?? "unknown";
            return {
                message,
                stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
                rawUsage: sdkUsage,
                usage: normaliseAnthropicUsage(
                    sdkUsage,
                    normalisedStopReason,
                    this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel, this.config)
                ),
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
                    if ("status" in error && (error as { status?: number }).status === 401) {
                        throw new ToolError(
                            "PROVIDER_AUTH_ERROR",
                            `Anthropic authentication failed. ` +
                            `Check ADHD_AGENT_ANTHROPIC_SECRET in your ~/.adhd/.env ` +
                            `(run \`claude setup-token\` to obtain a fresh OAuth access token).`
                        );
                    }
                },
            });
        }

        return run();
    }
}
