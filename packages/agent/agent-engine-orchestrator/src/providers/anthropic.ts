import { createTtfbProbe } from "./call-timing.js";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";
import type { IProviderEcho, TokenUsage } from "@adhd/agent-base-types";
import { ToolError } from "../validation/errors.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "../interfaces.js";
import { sdkFetchOption } from "./wire.js";
import { applyCacheBreakpoints } from "./anthropic-cache.js";
import { toToolResultContent } from "./anthropic-tool-result.js";
import { normalizeToolForWire } from "./tool-schema.js";
import { assistantBlocks, captureEcho, isEchoRejection, replayedEchoFamilies, sanitizeServerToolPairs, type EchoBlockFamily } from "./anthropic-echo.js";
import { runWithPauseTurn, type IPauseCall } from "./anthropic-pause.js";
import { type ProviderTokenUsage } from "./partial-usage.js";
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
    // Sonnet 5 family: catalog `max_output_tokens.upper` 128000 (default 128000 on 5-5, 64000 on 5), claude 2.1.296 model catalog.
    ["claude-sonnet-5",         128_000],
    ["claude-sonnet-4",          64_000],
    // Haiku 5 family: catalog `max_output_tokens: {default: 128000, upper: 128000}` for claude-haiku-5-5 (claude 2.1.296 baked model catalog).
    ["claude-haiku-5",          128_000],
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

/**
 * The `tools` array entries for the client-executed tools. A top-level `oneOf` / `anyOf` / `allOf` in a tool's
 * `inputSchema` is flattened by {@link normalizeToolForWire} (the API rejects the whole request with HTTP 400 for one
 * such tool, 020307a5); a schema that cannot be flattened throws a `PROVIDER_INVALID_REQUEST` naming `tools.<n>`.
 * The registered definitions are never mutated.
 */
function toAnthropicTools(tools?: ToolDefinition[]): Tool[] | undefined {
    if (!tools) return undefined;

    return tools.map((tool, index) => {
        const wire = normalizeToolForWire(tool, index);
        return {
            name: tool.name,
            description: wire.description,
            input_schema: wire.inputSchema as Tool["input_schema"],
        };
    });
}

/**
 * The name an echoed assistant `tool_use` block carries: the SAME `server__tool` string `toAnthropicTools` advertised
 * (P1-toolname; OpenAI's `toOpenAIMessages` does the identical join). A stored ToolCall holds the resolved
 * `{server, tool}` pair, so history must re-join it, not drop the prefix, or the model sees names it was never offered.
 *
 * A tool advertised WITHOUT a server prefix resolves (`resolveToolCallName`) to `{server: name, tool: name}`; it is
 * echoed as the bare name, not `name__name`. The advertised set disambiguates that from a real `echo__echo` tool.
 */
function echoedToolName(tc: ToolCall, advertised: ReadonlySet<string>): string {
    const qualified = `${tc.server}__${tc.tool}`;
    if (advertised.has(qualified)) return qualified;
    if (advertised.has(tc.tool)) return tc.tool;
    return tc.server === tc.tool ? tc.tool : qualified;
}

/** What {@link toAnthropicMessages} replayed from echoes (R9-hist): assistant messages sent with echoed blocks and their JSON bytes. */
interface IEchoReplayStats {
    messages: number;
    bytes: number;
}

interface IEchoReplayOptions {
    /** Provider-native assistant content keyed by `Message.id`; absent/empty => legacy rebuild for every message. */
    echoes?: ReadonlyMap<string, IProviderEcho>;
    /** The configured model of THIS request; an echo captured under another model is not replayed. */
    model: string;
    /** Accumulates what was replayed. Bytes are counted as assembled (after `tool_use` re-qualification, before pair sanitising). */
    replay: IEchoReplayStats;
}

/**
 * The API rejects an empty `text` block in a request. A response can (rarely) carry one, and the legacy rebuild never
 * emits one (`if (message.content)`), so an echo replay drops it; every other block, thinking included, is untouched.
 */
function withoutEmptyText(blocks: ContentBlockParam[]): ContentBlockParam[] {
    return blocks.filter(b => !(b.type === "text" && b.text === ""));
}

function toAnthropicMessages(
    messages: Message[],
    advertisedToolNames: readonly string[] = [],
    opts?: IEchoReplayOptions
): MessageParam[] {
    const advertised: ReadonlySet<string> = new Set(advertisedToolNames);
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
                        // R10 S1 P5: the text the model should read, never a JSON string of the MCP content array.
                        content: toToolResultContent(toolResult.result),
                        is_error: toolResult.isError,
                    },
                ],
            };
        }

        if (message.role === "assistant" && opts?.echoes) {
            // R9-hist: replay the turn exactly as the API produced it (thinking, server blocks, order). `undefined` =>
            // no usable echo (absent, other provider/model, disagrees with `toolCalls`) => the legacy rebuild below.
            const echoed = assistantBlocks(
                message,
                opts.echoes.get(message.id),
                opts.model,
                tc => echoedToolName(tc, advertised)
            );
            const blocks = echoed ? withoutEmptyText(echoed) : [];
            if (blocks.length > 0) {
                opts.replay.messages += 1;
                opts.replay.bytes += Buffer.byteLength(JSON.stringify(blocks));
                return { role: "assistant", content: blocks };
            }
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
                    name: echoedToolName(tc, advertised),
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

/**
 * The API's rejection text, made safe to log and to put on an event: long opaque runs (a signature, an
 * `encrypted_content` blob, base64 page data) are cut, and the whole is bounded. Anthropic's own 400 text names the
 * offending block (`messages.3.content.0: Invalid `signature` in `thinking` block`) and does not quote its payload;
 * this is the belt to that braces.
 */
export function redactApiMessage(text: string): string {
    return text.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 500);
}

/** The `ToolError` for a paused turn that holds a client `tool_use` (nothing can answer it mid-turn). Ids only, never inputs. */
function danglingClientToolUse(pausedBlocks: readonly unknown[]): ToolError | undefined {
    const ids = pausedBlocks.flatMap(b => {
        const block = b as { type?: unknown; id?: unknown };
        return block.type === "tool_use" ? [String(block.id)] : [];
    });
    if (ids.length === 0) return undefined;
    return new ToolError(
        "PROVIDER_ERROR",
        `provider paused the turn while ${ids.length} client tool call(s) were pending (${ids.join(", ")}); ` +
            `a paused turn cannot be continued past an unanswered tool_use`,
        { kind: "pause_turn_pending_tool_use", toolUseIds: ids }
    );
}

/** Anthropic `stop_reason` -> the normalised reason `normaliseAnthropicUsage` records (anything else, `pause_turn` included: "unknown"). */
const STOP_REASON: Record<string, string> = {
    end_turn: "stop", max_tokens: "length", tool_use: "tool_calls",
};

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

        const effectiveModel = this.providerConfig.model ?? "";
        if (!effectiveModel) {
            this.logger.warn("AnthropicProvider: no model configured; API will likely reject");
        }
        const maxTokens = this.providerConfig.maxTokens ?? defaultMaxTokens(effectiveModel, this.config);
        const advertisedToolNames = (request.tools ?? []).map(t => t.name);

        const timeoutMs = this.providerConfig.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
        const wireModel = effectiveModel;
        const ctx = {
            providerType: "anthropic" as const,
            modelRef: wireModel,
            wireModel,
            credentialKey: this.credentialKey,
            credentialScope: this.credentialKey,
        };
        /** ONE API call under the shared fault policy. The pause loop calls this per request, never around the loop. */
        const callOnce = <T>(run: () => Promise<T>): Promise<T> =>
            callWithRetry(run, {
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

        // What the current attempt replayed and which request of its pause loop was last sent: the degrade decision
        // below needs both (a rejection of a CONTINUATION is not a history fault: the history already passed call 0).
        let replayedMessages = 0;
        let replayedFamilies: ReadonlySet<EchoBlockFamily> = new Set();
        let lastSentN = 0;

        /**
         * One logical model turn: build the history (echoed or legacy), then run it through the pause loop. Throws
         * whatever the API / loop throws; the degrade decision is the caller's.
         */
        const attempt = async (useEchoes: boolean): Promise<ProviderChatResponse> => {
            const effectiveSystem = this.useOauthIdentity
                ? [
                      { type: "text" as const, text: CLAUDE_CODE_IDENTITY },
                      ...(systemPrompt
                          ? [{ type: "text" as const, text: systemPrompt }]
                          : []),
                  ]
                : systemPrompt;

            // Custom (client-executed) tools plus any provider-native
            // (server-executed) tools from the default web toolset
            // (backlog 1abd2d84). Server-side entries are type-tagged and
            // carry no input_schema.
            const mergedTools: Tool[] = [
                ...(toAnthropicTools(request.tools) ?? []),
                ...((request.serverSideTools ?? []) as unknown as Tool[]),
            ];

            const replay: IEchoReplayStats = { messages: 0, bytes: 0 };
            // R9-hist: replay echoed assistant turns, then make the server-tool blocks pair up (a history windowed or
            // compacted mid-pair must never 400). With no echo the rebuild is the legacy one and the sanitiser is a no-op.
            const messages = sanitizeServerToolPairs(
                toAnthropicMessages(
                    request.messages,
                    advertisedToolNames,
                    useEchoes && request.echoes && request.echoes.size > 0
                        ? { echoes: request.echoes, model: effectiveModel, replay }
                        : undefined
                )
            );
            replayedMessages = replay.messages;
            replayedFamilies = replayedEchoFamilies(messages);

            // BK3 (ae62e6b0): <=3 five-minute cache breakpoints, each guarded by the model's
            // minimum cacheable prefix. The OAuth identity block (first system block) is protected.
            const prepared = {
                tools: mergedTools.length > 0 ? mergedTools : undefined,
                system: effectiveSystem,
                messages,
            };
            const wire = this.promptCaching
                ? applyCacheBreakpoints({
                      model: effectiveModel,
                      ...prepared,
                      protectedLeadingSystemBlocks: this.useOauthIdentity ? 1 : 0,
                  })
                : prepared;

            let firstTtfbMs: number | undefined;
            const streamOnce = async (wireMessages: MessageParam[], isFirstCall: boolean) => {
                const ttfbProbe = createTtfbProbe();
                ttfbProbe.start();
                const stream = this.client.messages.stream(
                    {
                        model: effectiveModel,
                        system: wire.system,
                        temperature: this.providerConfig.temperature,
                        max_tokens: maxTokens,
                        messages: wireMessages,
                        tools: wire.tools,
                        // R8-AC: an explicit reasoning-effort level rides as `output_config.effort`; unset sends no
                        // `output_config` key at all, so the request is byte-identical to the pre-change body.
                        ...(this.providerConfig.effort !== undefined && { output_config: { effort: this.providerConfig.effort } }),
                        // R10 S1 P7: an explicit `thinking` option rides verbatim; unset sends no `thinking` key at all,
                        // so the request is byte-identical to the pre-change body (the API default applies).
                        ...(this.providerConfig.thinking !== undefined && { thinking: this.providerConfig.thinking }),
                    },
                    { signal: request.signal }
                );
                // P6: first streamed SSE event marks the time to first byte.
                if (typeof stream.on === "function") stream.on("streamEvent", () => ttfbProbe.firstByte());
                const response = await stream.finalMessage();
                if (isFirstCall) firstTtfbMs = ttfbProbe.ttfbMs();
                return response;
            };

            // R9-pause: `send` is ONE API call. Call 0 is the original request; a continuation appends the paused
            // content as the final assistant message (untouched, unsanitised, unmarked: the cache breakpoint stays on
            // the last user entry of the base history) with the same tools and system.
            let pausedSoFar: unknown[] = [];
            const send = async ({ n, pausedBlocks }: IPauseCall) => {
                lastSentN = n;
                const response =
                    n === 0
                        ? await callOnce(() => streamOnce(wire.messages, true))
                        : await callOnce(() =>
                              streamOnce(
                                  [...wire.messages, { role: "assistant", content: pausedBlocks as ContentBlockParam[] }],
                                  false
                              )
                          );
                if (response.stop_reason === "pause_turn") pausedSoFar = pausedSoFar.concat(response.content);
                return response;
            };

            const result = await runWithPauseTurn({
                send,
                signal: request.signal,
                // A paused turn that holds a client tool_use cannot be continued (nothing can answer it mid-turn): fail
                // loudly BEFORE the engine's per-continuation hook (budget enforcement, progress event) and before a request.
                beforeContinuation: async n => {
                    const dangling = danglingClientToolUse(pausedSoFar);
                    if (dangling) throw dangling;
                    await request.beforeContinuation?.(n);
                },
                usageOf: (r): ProviderTokenUsage =>
                    normaliseAnthropicUsage(r.usage, STOP_REASON[r.stop_reason ?? ""] ?? "unknown", maxTokens),
                onContinuation: ({ n, pauses }) =>
                    this.logger.info({ n, pauses }, "anthropic: pause_turn, continuing the turn"),
            });
            const response = result.last;

            const toolCalls: ToolCall[] = [];
            const contentParts: string[] = [];

            for (const block of result.blocks as ContentBlock[]) {
                if (block.type === "text") {
                    contentParts.push(block.text);
                }

                if (block.type === "tool_use") {
                    const { server, tool } = resolveToolCallName(block.name, advertisedToolNames);

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

            const echo = captureEcho(result.blocks, effectiveModel);
            return {
                message,
                stopReason: toolCalls.length > 0 ? "tool_calls" : "completed",
                rawUsage: response.usage,
                responseModel: response.model || undefined,
                ...(firstTtfbMs !== undefined ? { ttfbMs: firstTtfbMs } : {}),
                // Every continuation is a real model call (the usage above is already their sum).
                ...(result.modelCalls > 1 ? { reportedModelCalls: result.modelCalls } : {}),
                usage: result.usage,
                ...(echo ? { echo } : {}),
                ...(replay.messages > 0 ? { echoReplay: { messages: replay.messages, bytes: replay.bytes } } : {}),
            };
        };

        try {
            try {
                return await attempt(true);
            } catch (err) {
                // H3 degrade-once: the API rejected the REPLAYED history (an `invalid_request` naming an echoed block
                // type that was actually replayed; a context-length rejection or a fault naming only client tool blocks is not one).
                // Echoes are deleted by the engine only on `echoDegraded`, which is set solely after THIS retry succeeded. Retry exactly once with the legacy rebuild. Only a
                // rejection of call 0 qualifies: a continuation carries the same history that call 0 already passed.
                if (replayedMessages === 0 || lastSentN !== 0 || !isEchoRejection(err, replayedFamilies)) throw err;
                const detail = err as { message?: string; data?: { message?: string } };
                const apiMessage = redactApiMessage(detail.data?.message ?? detail.message ?? "");
                const echoedMessages = replayedMessages;
                this.logger.warn(
                    { echoedMessages, apiMessage },
                    "anthropic: API rejected the replayed assistant history, retrying once without echoed blocks"
                );
                const degraded = await attempt(false);
                return { ...degraded, echoDegraded: { apiMessage, echoedMessages } };
            }
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
