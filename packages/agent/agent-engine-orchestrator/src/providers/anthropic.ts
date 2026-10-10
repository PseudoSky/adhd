import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";
import type { TokenUsage } from "@adhd/agent-base-types";
import { ToolError } from "../validation/errors.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "../interfaces.js";
import { sdkFetchOption } from "./wire.js";
import { applyCacheBreakpoints } from "./anthropic-cache.js";
import {
    DEFAULT_RETRY_POLICY,
    ProviderCallError,
    callWithRetry,
    classifySdkError,
    credentialKeyOf,
    defaultRetryRuntime,
    type RetryRuntime,
} from "./provider-failure.js";

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
        /** Per-TTL split of the cache writes; its `ephemeral_1h_input_tokens` is a subset of `cache_creation_input_tokens`. */
        cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
    },
    stopReason: string,
    maxTokens: number
): TokenUsage {
    const cacheRead = sdkUsage.cache_read_input_tokens ?? 0;
    const cacheWrite = sdkUsage.cache_creation_input_tokens ?? 0;
    const uncached = sdkUsage.input_tokens;
    // b726a987: the 1h-TTL subset of the cache writes is billed at the 1h rate. Clamp to the
    // reported total so a malformed split can never price more write tokens than exist.
    const write1h = Math.min(
        Math.max(sdkUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0, 0),
        cacheWrite
    );

    return {
        // Reconstruct the true total — do NOT pass Anthropic's headline through directly.
        inputTokens: uncached + cacheRead + cacheWrite,
        outputTokens: sdkUsage.output_tokens,
        uncachedInputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        ...(write1h > 0 ? { cacheCreation1hTokens: write1h } : {}),
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
    timeoutMs: number | undefined,
    config?: EngineConfig
): AnthropicClientParts {
    // Fall back to the raised per-call budget so the SDK client timeout never
    // undercuts the orchestrator's AbortSignal (which uses the same constant).
    // Previously `undefined` deferred to the SDK's own default; making it
    // explicit keeps openai and anthropic behavior identical (backlog 36a73117
    // / post-merge bucket-B review).
    //
    // `maxRetries: 0` (PF-2.AC1): the SDK's own default (2 retries of 408/409/429/5xx on its own real
    // timers) would stack under `callWithRetry`, retry a quota 429 by status alone, and make the attempt
    // count non-deterministic. `callWithRetry` (./provider-failure.ts) is the single retry owner.
    const effectiveTimeout = timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    if (secret.startsWith("sk-ant-api")) {
        return {
            client: new Anthropic({ apiKey: secret, timeout: effectiveTimeout, maxRetries: 0, ...sdkFetchOption(config) }),
            useOauthIdentity: false,
        };
    }
    const isOauth = secret.startsWith("sk-ant-oat");
    return {
        client: new Anthropic({
            authToken: secret,
            timeout: effectiveTimeout,
            maxRetries: 0,
            ...sdkFetchOption(config),
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
    private readonly promptCaching: boolean;
    private readonly retryRuntime: RetryRuntime;
    private readonly credentialKey: string;

    /**
     * @param options.retryRuntime Clock / jitter RNG / trip registry for the fault policy (default: real
     *   clock, `Math.random`, the process-wide registry). Tests inject fakes so no retry ever sleeps.
     * @param options.promptCaching Place prompt-cache breakpoints on requests (default `true`,
     *   backlog ae62e6b0 BK3; placement rules in `./anthropic-cache.ts`). `false` reproduces the
     *   pre-BK3 uncached request body; it exists as the negative control for the BK3 tests.
     */
    constructor(
        providerConfig: Extract<ProviderConfig, { type: "anthropic" }>,
        config: EngineConfig,
        logger: EngineLogger,
        options: { promptCaching?: boolean; retryRuntime?: RetryRuntime } = {}
    ) {
        this.promptCaching = options.promptCaching ?? true;
        this.retryRuntime = options.retryRuntime ?? defaultRetryRuntime();
        this.credentialKey = credentialKeyOf({
            providerType: "anthropic",
            baseURL: (providerConfig as { baseURL?: string }).baseURL,
            secretEnvName: providerConfig.env?.secret,
        });
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
            providerConfig.timeoutMs,
            config
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

            // Custom (client-executed) tools plus any provider-native
            // (server-executed) tools from the default web toolset
            // (backlog 1abd2d84). Server-side entries are type-tagged and
            // carry no input_schema.
            const mergedTools: Tool[] = [
                ...(toAnthropicTools(request.tools) ?? []),
                ...((request.serverSideTools ?? []) as unknown as Tool[]),
            ];

            // BK3 (ae62e6b0): <=3 five-minute cache breakpoints, each guarded by the model's
            // minimum cacheable prefix. The OAuth identity block (first system block) is protected.
            const prepared = {
                tools: mergedTools.length > 0 ? mergedTools : undefined,
                system: effectiveSystem,
                messages: toAnthropicMessages(request.messages),
            };
            const wire = this.promptCaching
                ? applyCacheBreakpoints({
                      model: effectiveModel,
                      ...prepared,
                      protectedLeadingSystemBlocks: this.useOauthIdentity ? 1 : 0,
                  })
                : prepared;

            const stream = this.client.messages.stream(
                {
                    model: effectiveModel,
                    system: wire.system,
                    temperature: this.providerConfig.temperature,
                    max_tokens: this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel, this.config),
                    messages: wire.messages,
                    tools: wire.tools,
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
                responseModel: response.model || undefined,
                usage: normaliseAnthropicUsage(
                    sdkUsage,
                    normalisedStopReason,
                    this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel, this.config)
                ),
            };
        };

        const timeoutMs = this.providerConfig.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
        const wireModel = this.providerConfig.model ?? "";
        const ctx = {
            providerType: "anthropic" as const,
            modelRef: wireModel,
            wireModel,
            credentialKey: this.credentialKey,
            credentialScope: this.credentialKey,
        };
        try {
            return await callWithRetry(() => run(), {
                runtime: this.retryRuntime,
                policy: {
                    retries: retryConfig?.retries ?? DEFAULT_RETRY_POLICY.retries,
                    minTimeout: retryConfig?.minTimeout ?? DEFAULT_RETRY_POLICY.minTimeout,
                    maxTimeout: retryConfig?.maxTimeout ?? DEFAULT_RETRY_POLICY.maxTimeout,
                    factor: retryConfig?.factor ?? DEFAULT_RETRY_POLICY.factor,
                    // Waiting is bounded by the provider timeout (or a tighter operator window).
                    windowMs: Math.min(timeoutMs, (retryConfig as { retryWindowMs?: number } | undefined)?.retryWindowMs ?? timeoutMs),
                },
                target: { providerType: "anthropic", credentialScope: ctx.credentialScope, wireModel },
                signal: request.signal,
                classify: (err) => classifySdkError(err, ctx, request.signal?.aborted === true),
                onRetry: ({ attempt, failure, waitMs }) =>
                    this.logger.warn({ attempt, class: failure.class, status: failure.status, waitMs }, "anthropic: transient failure, retrying"),
            });
        } catch (err) {
            if (err instanceof ProviderCallError && err.data.class === "auth") {
                throw new ProviderCallError(
                    err.data,
                    `Anthropic authentication failed. ` +
                    `Check ADHD_AGENT_ANTHROPIC_SECRET in your ~/.adhd/.env ` +
                    `(run \`claude setup-token\` to obtain a fresh OAuth access token). ${err.message}`,
                    undefined,
                    { cause: err }
                );
            }
            throw err;
        }
    }
}
