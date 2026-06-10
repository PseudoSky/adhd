import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { execFile } from "child_process";
import { promisify } from "util";
import pRetry from "p-retry";

const execFileAsync = promisify(execFile);

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

import type { ProviderConfig, Message, ToolCall } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { logger } from "../logger.js";

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
// AGENT_MCP_DEFAULT_MAX_TOKENS env var overrides for unlisted / future models.
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
    const envOverride = process.env["AGENT_MCP_DEFAULT_MAX_TOKENS"];
    if (envOverride) return parseInt(envOverride, 10);
    for (const [prefix, maxTokens] of MODEL_MAX_TOKENS) {
        if (model.startsWith(prefix)) return maxTokens;
    }
    return 32_000; // unknown/future model — conservative but not restrictive
}

// ─── OAuth keychain helpers ───────────────────────────────────────────────────

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_TOKEN_URL   = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID   = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Refresh when fewer than this many ms remain on the access token. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min

interface ClaudeOauthCreds {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
}

async function readKeychainCreds(): Promise<ClaudeOauthCreds> {
    const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8" }
    );
    const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth: ClaudeOauthCreds };
    return parsed.claudeAiOauth;
}

async function writeKeychainCreds(creds: ClaudeOauthCreds): Promise<void> {
    // Read the full existing keychain entry so we preserve any other fields
    const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8" }
    );
    const existing = JSON.parse(stdout.trim()) as Record<string, unknown>;
    existing["claudeAiOauth"] = creds;

    // -U updates the existing entry in place
    await execFileAsync(
        "security",
        [
            "add-generic-password",
            "-U",
            "-s", KEYCHAIN_SERVICE,
            "-a", KEYCHAIN_SERVICE,
            "-w", JSON.stringify(existing),
        ],
        { encoding: "utf8" }
    );
}

async function refreshOauthToken(refreshToken: string): Promise<ClaudeOauthCreds> {
    // ⚠️  UNVERIFIED PATH — refresh confirmed blocked (HTTP 429) while the access token
    //     is still valid; the endpoint appears to enforce "no early refresh" as an OAuth
    //     policy.  This function will only be called when the token is within
    //     REFRESH_BUFFER_MS of expiry (see getAccessToken below), which is the correct
    //     window.  To confirm it actually works end-to-end:
    //
    //       1. Check the current expiry:
    //            security find-generic-password -s "Claude Code-credentials" -w \
    //              | python3 -c "import sys,json,time; d=json.load(sys.stdin);
    //                  exp=d['claudeAiOauth']['expiresAt']/1000;
    //                  print(time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(exp)),
    //                        f'({round((exp-time.time())/60,1)} min remaining)')"
    //
    //       2. Wait until ≤5 min remain (or temporarily lower REFRESH_BUFFER_MS to
    //          something large like 7*60*60*1000 to force the code path immediately).
    //
    //       3. Call getAccessToken() and confirm a new token is returned.
    //
    //     If this ever returns a 429 in production it means the token expired and the
    //     refresh endpoint itself is down — the fallback in getAccessToken() will use
    //     the stored (expired) token and let the SDK surface a 401.

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
    });

    const res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const rawBody = await res.text();

    let json: { access_token?: string; refresh_token?: string; expires_in?: number; error?: unknown } = {};
    try {
        json = JSON.parse(rawBody) as typeof json;
    } catch {
        throw new Error(
            `OAuth refresh failed: response was not JSON\n` +
            `  status: ${res.status} ${res.statusText}\n` +
            `  body: ${rawBody}`
        );
    }

    if (!res.ok || !json.access_token) {
        throw new Error(
            `OAuth refresh failed\n` +
            `  status: ${res.status} ${res.statusText}\n` +
            `  body: ${rawBody}`
        );
    }

    const fresh: ClaudeOauthCreds = {
        accessToken:  json.access_token,
        refreshToken: json.refresh_token ?? refreshToken, // some providers rotate it
        expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
    };

    // Persist rotated credentials back to the keychain so Claude Code stays in sync
    await writeKeychainCreds(fresh);

    return fresh;
}

/**
 * Returns a fresh access token, refreshing via OAuth if the stored one is
 * within REFRESH_BUFFER_MS of expiry. Falls back to the stored token on
 * refresh failure (it may still be valid).
 */
async function getAccessToken(): Promise<string> {
    const creds = await readKeychainCreds();

    if (Date.now() < creds.expiresAt - REFRESH_BUFFER_MS) {
        return creds.accessToken; // still good
    }

    // Token is expired or nearly so — refresh
    try {
        const fresh = await refreshOauthToken(creds.refreshToken);
        return fresh.accessToken;
    } catch {
        // Refresh failed — fall back to stored token and let the SDK surface the 401
        return creds.accessToken;
    }
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

export class AnthropicProvider implements LLMProvider {
    private client: Anthropic;
    private readonly config: Extract<ProviderConfig, { type: "anthropic" }>;

    constructor(config: Extract<ProviderConfig, { type: "anthropic" }>) {
        this.config = config;

        if (config.useClaudeOauth) {
            // Deferred: client is built per-request in chat() after fetching a fresh token.
            // Set a placeholder that will be replaced before any real call.
            this.client = null as unknown as Anthropic;
            return;
        }

        // Resolve credentials in priority order:
        //   1. Explicit API key env var (e.g. ANTHROPIC_API_KEY)
        //   2. Explicit auth token env var (e.g. ANTHROPIC_AUTH_TOKEN, for subscription users)
        //   3. Neither — let SDK auto-detect from its own ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
        //      env fallbacks (throws AuthenticationError if neither is set)
        const apiKey = process.env[config.apiKeyEnv ?? "ANTHROPIC_API_KEY"] || undefined;
        const authToken = process.env[config.authTokenEnv ?? "ANTHROPIC_AUTH_TOKEN"] || undefined;

        if (apiKey) {
            this.client = new Anthropic({ apiKey });
        } else if (authToken) {
            // OAuth tokens (sk-ant-oat…) require the oauth-2025-04-20 beta header;
            // without it the Messages API returns 429. API keys (sk-ant-api…) do not.
            const isOauth = authToken.startsWith("sk-ant-oat");
            this.client = new Anthropic({
                authToken,
                ...(isOauth ? { defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } } : {}),
            });
        } else {
            // No credentials found via env — SDK will throw a clear AuthenticationError
            this.client = new Anthropic();
        }
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        // For useClaudeOauth mode, fetch a fresh token on every chat() call so
        // long-running servers never hold a stale client across token expiry.
        if (this.config.useClaudeOauth) {
            try {
                const authToken = await getAccessToken();
                // Subscription OAuth tokens always require the beta header
                this.client = new Anthropic({
                    authToken,
                    defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
                });
            } catch (keychainErr) {
                const keychainMsg = keychainErr instanceof Error ? keychainErr.message : String(keychainErr);
                logger.warn({ keychainMsg }, "AnthropicProvider: keychain read failed, trying env var fallbacks");

                const apiKey = process.env["ANTHROPIC_API_KEY"] || undefined;
                const authToken = process.env["ANTHROPIC_AUTH_TOKEN"] || undefined;

                if (apiKey) {
                    this.client = new Anthropic({ apiKey });
                } else if (authToken) {
                    this.client = new Anthropic({ authToken });
                } else {
                    throw new ToolError(
                        "PROVIDER_AUTH_ERROR",
                        `Anthropic keychain read failed: ${keychainMsg}. ` +
                        `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
                    );
                }
            }
        }

        const retryConfig = this.config.retryConfig;

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content || "").join("\n") || undefined;

        const run = async (): Promise<ProviderChatResponse> => {
            const response = await this.client.messages.create(
                {
                    model: this.config.model,
                    system: systemPrompt,
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens ?? defaultMaxTokens(this.config.model),
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
                    maxTokens: this.config.maxTokens ?? defaultMaxTokens(this.config.model),
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
                            `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
                        );
                    }
                },
            });
        }

        return run();
    }
}
