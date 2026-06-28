import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import pRetry from "p-retry";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

import type {
    LLMProvider,
    ProviderChatRequest,
    ProviderChatResponse,
    ToolDefinition,
} from "./types.js";

// ─── Model max-output token table ────────────────────────────────────────────
// Maps model-name prefix → documented max output tokens (standard sync API,
// no beta headers). Checked longest-prefix-first so "claude-opus-4-5" (64k)
// wins over "claude-opus-4" (128k). Source: docs.anthropic.com/models/overview.
// config.server.defaultMaxTokens is used as the fallback for unknown / future models.
const MODEL_MAX_TOKENS: [prefix: string, maxTokens: number][] = [
    // Claude 5 (GA 2026-06)
    ["claude-fable-5",          128_000],
    ["claude-mythos-5",         128_000],
    // Claude 4 — Opus (8/7/6 = 128k; 5 = 64k; 1/0 = 32k)
    ["claude-opus-4-8",         128_000],
    ["claude-opus-4-7",         128_000],
    ["claude-opus-4-6",         128_000],
    ["claude-opus-4-5",          64_000],
    ["claude-opus-4-1",          32_000],
    ["claude-opus-4-0",          32_000],
    ["claude-opus-4",           128_000], // catch future claude-opus-4-N ≥ 4-6 tier
    // Claude 4 — Sonnet (all known variants: 64k)
    ["claude-sonnet-4",          64_000],
    // Claude 4 — Haiku (all known variants: 64k)
    ["claude-haiku-4",           64_000],
    // Claude 3.5 family
    ["claude-3-5-sonnet",         8_192],
    ["claude-3-5-haiku",          8_192],
    // Claude 3 family
    ["claude-3-opus",             4_096],
    ["claude-3-sonnet",           4_096],
    ["claude-3-haiku",            4_096],
];

function defaultMaxTokens(model: string): number {
    for (const [prefix, maxTokens] of MODEL_MAX_TOKENS) {
        if (model.startsWith(prefix)) return maxTokens;
    }
    // Unknown / future model — fall back to the global default
    return config.server.defaultMaxTokens;
}

// ─── Wire-form inference (§3a) ────────────────────────────────────────────────
// One secret; the wire form is inferred from its value prefix.
//   sk-ant-api… → x-api-key client (standard console.anthropic.com key)
//   sk-ant-oat… → Authorization: Bearer + anthropic-beta: oauth-2025-04-20
//   anything else → try as authToken (subscription tokens have varied prefixes)

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
    // OAuth / subscription token — requires the oauth-2025-04-20 beta header and
    // the Claude Code identity block in the system prompt (see below).
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

// Subscription OAuth tokens (sk-ant-oat…) only work against the Messages API when
// BOTH of these hold (verified by direct-API bisect — see chat()):
//   1. the request carries the `anthropic-beta: oauth-2025-04-20` header, and
//   2. THIS identity is sent as the first `system` block in ARRAY form — not
//      concatenated with the agent's system prompt into a single string.
// Bisect: identity-only string → 200; identity+prompt joined into one string → 429;
// [identity block, prompt block] array → 200. Either omission yields a *misleading*
// `429 rate_limit_error` (no rate-limit headers), which is why OAuth was silently
// broken for any agent that had its own system prompt. Plain API keys need neither.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export class AnthropicProvider implements LLMProvider {
    private readonly client: Anthropic;
    private readonly providerConfig: Extract<ProviderConfig, { type: "anthropic" }>;
    /** True when the resolved secret is a sk-ant-oat… OAuth token. */
    private readonly useOauthIdentity: boolean;

    constructor(providerConfig: Extract<ProviderConfig, { type: "anthropic" }>) {
        this.providerConfig = providerConfig;

        // Resolve the single unified secret via config (§3 / §3c)
        const resolved = config.getProviderConfig({
            provider: "anthropic",
            secret:      providerConfig.env?.secret,
            model:       providerConfig.env?.model,
            inlineModel: providerConfig.model,
        });

        if (!resolved.secret) {
            // No secret found and we're not a localhost server (anthropic has no localhost exemption)
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
            // sk-ant-oat OAuth tokens require the Claude Code identity as a DISTINCT
            // first system block (array form) — NOT concatenated into one string.
            // Anthropic's OAuth gate rejects a single system string that isn't exactly
            // the identity with a misleading 429 rate_limit_error, so any agent that
            // has its own system prompt fails unless the identity is its own block.
            // (Proven by bisect: array form → 200; identity+prompt joined string → 429.)
            // API-key mode keeps the plain string.
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
                logger.warn("AnthropicProvider: no model configured; API will likely reject");
            }

            // Use streaming to avoid the SDK's synchronous "Streaming is required
            // for operations that may take longer than 10 minutes" throw that fires
            // when max_tokens is large (e.g. 64k on haiku-4-5) with messages.create().
            const stream = this.client.messages.stream(
                {
                    model: effectiveModel,
                    system: effectiveSystem,
                    temperature: this.providerConfig.temperature,
                    max_tokens: this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel),
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
                    // Resolve qualified or bare tool names against the advertised set
                    // (a bare `agent` → `agent-mcp__agent` when unambiguous; DEBT-004).
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
                usage: {
                    inputTokens: sdkUsage.input_tokens,
                    outputTokens: sdkUsage.output_tokens,
                    stopReason: normalisedStopReason,
                    maxTokens: this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel),
                    cacheReadTokens: sdkUsage.cache_read_input_tokens ?? undefined,
                    cacheCreationTokens: sdkUsage.cache_creation_input_tokens ?? undefined,
                },
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
                    // Don't retry auth failures — credentials won't change between attempts
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
