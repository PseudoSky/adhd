import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "gpt-tokenizer";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

/**
 * DEBT-AGENTMCP-ACCOUNTING-001 — data-capture layer for the three new additive
 * `task_usage` rollups (compute_ms, est_tool_result_tokens, est_cost_usd). Drives a REAL
 * Orchestrator + REAL HookRegistry + REAL UsagePlugin + REAL (in-memory) better-sqlite3
 * against the production task_usage/task_events schema — exactly the path a live task
 * takes. The only mocked boundary is the external LLM provider SDK (here: a hand-rolled
 * `LLMProvider` implementing `.chat()`, the same internal seam `orchestrator.test.ts`
 * already treats as the provider boundary — no `openai`/`anthropic` network client is
 * ever constructed).
 *
 * Timing is made deterministic by mocking `Date.now()` with an explicit, monotonic
 * counter that the provider mock itself advances by a known amount per call — never a
 * real `sleep`/wall-clock race (repo AGENTS.md §7).
 */

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_usage (
    task_id TEXT PRIMARY KEY NOT NULL,
    root_task_id TEXT,
    agent_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    tool_call_count INTEGER DEFAULT 0 NOT NULL,
    model_calls INTEGER DEFAULT 0 NOT NULL,
    latency_ms INTEGER DEFAULT 0 NOT NULL,
    is_complete INTEGER DEFAULT 0 NOT NULL,
    stop_reason TEXT,
    max_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    uncached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    peak_context_tokens INTEGER,
    peak_context_at INTEGER,
    compute_ms INTEGER,
    est_tool_result_tokens INTEGER,
    est_cost_usd REAL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_usage_root_task_id ON task_usage (root_task_id);
`;

function makeTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any;
    return { sqlite, db };
}

function makeAgentDefinition(model: string, providerType: "anthropic" | "openai" = "anthropic"): AgentDefinition {
    return {
        name: "accounting-test-agent",
        version: 1,
        provider: { type: providerType, model },
        systemPrompt: "You are a test agent.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
}

function makeCtx(taskId: string, model: string, providerType: "anthropic" | "openai" = "anthropic"): ExecutionContext {
    return {
        taskId,
        sessionId: generateId(),
        agentName: "accounting-test-agent",
        agentDefinition: makeAgentDefinition(model, providerType),
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

function makeUserMessage(sessionId: string): Message {
    return {
        id: generateId(),
        sessionId,
        role: "user",
        content: "hello",
        createdAt: nowIso(),
    };
}

const policy = { check: () => { /* no-op: test stub — policy always permits */ } } as unknown as PolicyEngine;
const sessionStore: OrchestratorSessionStore = {
    appendMessage: async () => { /* no-op: test stub */ },
    close: () => { /* no-op: test stub */ },
};

function makeToolRegistry(toolResult: unknown): McpClientRegistry {
    return {
        listAllTools: async () => [
            { name: "test-server__echo", description: "", inputSchema: { type: "object", properties: {} } },
        ],
        getClient: async () => ({
            callTool: async () => toolResult,
        }),
        closeAll: async () => { /* no-op: test stub */ },
    } as unknown as McpClientRegistry;
}

const emptyRegistry = {
    listAllTools: async () => [],
    closeAll: async () => { /* no-op: test stub */ },
    getClient: async () => {
        throw new Error("test stub: getClient must not be reached (no tool calls expected)");
    },
} as unknown as McpClientRegistry;

/** Runs the real Orchestrator with a real TaskStore + real UsagePlugin wired via a real HookRegistry. */
async function runTask(opts: {
    db: ReturnType<typeof makeTestDb>["db"];
    ctx: ExecutionContext;
    provider: LLMProvider;
    registry: McpClientRegistry;
}): Promise<{ taskStore: TaskStore; hooks: HookRegistry }> {
    const taskStore = new TaskStore(opts.db);
    taskStore.create({ sessionId: opts.ctx.sessionId, prompt: "test prompt", id: opts.ctx.taskId });

    const hooks = new HookRegistry();
    const usagePlugin = new UsagePlugin(opts.db);
    usagePlugin.install(hooks);

    await new Orchestrator().run({
        executionContext: opts.ctx,
        messages: [makeUserMessage(opts.ctx.sessionId)],
        registry: opts.registry,
        provider: opts.provider,
        policy,
        taskStore: taskStore as unknown as OrchestratorTaskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: opts.ctx.taskId,
        hooks,
    });

    return { taskStore, hooks };
}

describe("usage accounting — data capture (DEBT-AGENTMCP-ACCOUNTING-001)", () => {
    let clock = 1_700_000_000_000;

    beforeEach(() => {
        clock = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("compute_ms — turn-level model-call latency reconciliation", () => {
        it("task_usage.compute_ms equals the sum of the individual simulated call durations, and reconciles against task_events", async () => {
            const { sqlite, db } = makeTestDb();
            const taskId = generateId();
            const ctx = makeCtx(taskId, "claude_sonnet_4_6");

            const toolCallId = generateId();
            let callCount = 0;
            const provider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    callCount++;
                    if (callCount === 1) {
                        // Simulate 120ms of "model thinking" for this call — advance the
                        // deterministic clock by exactly that much before resolving.
                        clock += 120;
                        return {
                            message: {
                                id: generateId(),
                                sessionId: ctx.sessionId,
                                role: "assistant",
                                content: null,
                                toolCalls: [{ id: toolCallId, server: "test-server", tool: "echo", arguments: {} }],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls",
                            usage: { inputTokens: 500, outputTokens: 50 },
                        };
                    }
                    clock += 340;
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "done",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                        usage: { inputTokens: 600, outputTokens: 20 },
                    };
                },
            };

            await runTask({ db, ctx, provider, registry: makeToolRegistry("tool result for reconciliation test") });

            const usageRow = sqlite
                .prepare("SELECT compute_ms, model_calls FROM task_usage WHERE task_id = ?")
                .get(taskId) as { compute_ms: number; model_calls: number };

            expect(usageRow.model_calls).toBe(2);
            expect(usageRow.compute_ms).toBe(460); // 120 + 340

            // Reconciliation: task_usage cumulative compute_ms must equal Σ task_events'
            // per-turn MODEL_RESPONSE computeMs — the base-unit truth (DESIGN.md §1/§9).
            const events = sqlite
                .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'MODEL_RESPONSE' ORDER BY created_at")
                .all(taskId) as Array<{ payload: string }>;
            expect(events).toHaveLength(2);
            const perTurnComputeMs = events.map((e) => JSON.parse(e.payload).computeMs as number);
            expect(perTurnComputeMs).toEqual([120, 340]);
            expect(perTurnComputeMs.reduce((a, b) => a + b, 0)).toBe(usageRow.compute_ms);
        });
    });

    describe("est_tool_result_tokens — tokenized on the FULL result, before 500-char truncation", () => {
        it("task_events TOOL_RESULT payload's tool_call_est_result_tokens matches encode(fullResult).length for a >500-char result", async () => {
            const { sqlite, db } = makeTestDb();
            const taskId = generateId();
            const ctx = makeCtx(taskId, "claude_sonnet_4_6");

            const longResult = Array.from(
                { length: 80 },
                (_, i) => `tool output line ${i}: some varied content with numbers ${i * 7} and distinct words to defeat trivial compression`
            ).join("\n");
            expect(longResult.length).toBeGreaterThan(500);

            const toolCallId = generateId();
            let callCount = 0;
            const provider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    callCount++;
                    if (callCount === 1) {
                        clock += 10;
                        return {
                            message: {
                                id: generateId(),
                                sessionId: ctx.sessionId,
                                role: "assistant",
                                content: null,
                                toolCalls: [{ id: toolCallId, server: "test-server", tool: "echo", arguments: {} }],
                                createdAt: nowIso(),
                            },
                            stopReason: "tool_calls",
                        };
                    }
                    clock += 10;
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "done",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                    };
                },
            };

            await runTask({ db, ctx, provider, registry: makeToolRegistry(longResult) });

            const toolResultEvent = sqlite
                .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'TOOL_RESULT'")
                .get(taskId) as { payload: string };
            const payload = JSON.parse(toolResultEvent.payload) as {
                result: string;
                tool_call_est_result_tokens: number;
            };

            const fullTokens = encode(longResult).length;
            const truncatedTokens = encode(longResult.slice(0, 500)).length;

            // Proves tokenization happened on the FULL text, not the truncated summary —
            // a truncated-first bug would report ~truncatedTokens instead.
            expect(payload.tool_call_est_result_tokens).toBe(fullTokens);
            expect(payload.tool_call_est_result_tokens).not.toBe(truncatedTokens);
            // The stored `result` field itself must still be the truncated summary.
            expect(payload.result).toBe(longResult.slice(0, 500));

            const usageRow = sqlite
                .prepare("SELECT est_tool_result_tokens FROM task_usage WHERE task_id = ?")
                .get(taskId) as { est_tool_result_tokens: number };
            expect(usageRow.est_tool_result_tokens).toBe(fullTokens);
        });
    });

    describe("est_cost_usd — rate-card estimation", () => {
        it("a known model (claude_sonnet_4_6) produces a nonzero est_cost_usd matching the hand-computed rate-card value", async () => {
            const { sqlite, db } = makeTestDb();
            const taskId = generateId();
            const ctx = makeCtx(taskId, "claude_sonnet_4_6");

            const provider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    clock += 50;
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "done",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                        usage: {
                            inputTokens: 3500,
                            outputTokens: 300,
                            uncachedInputTokens: 1000,
                            cacheReadTokens: 2000,
                            cacheCreationTokens: 500,
                        },
                    };
                },
            };

            await runTask({ db, ctx, provider, registry: emptyRegistry });

            const row = sqlite
                .prepare("SELECT est_cost_usd FROM task_usage WHERE task_id = ?")
                .get(taskId) as { est_cost_usd: number | null };

            // claude_sonnet_4_6 rate card: inputPerM=3.00, cacheReadPerM=0.30, cacheWritePerM=3.75, outputPerM=15.00
            // (1000*3.00 + 2000*0.30 + 500*3.75 + 300*15.00) / 1e6 = 9975 / 1e6 = 0.009975
            expect(row.est_cost_usd).not.toBeNull();
            expect(row.est_cost_usd).toBeCloseTo(0.009975, 9);
        });

        it("an unrecognized model produces est_cost_usd IS NULL, never 0", async () => {
            const { sqlite, db } = makeTestDb();
            const taskId = generateId();
            const ctx = makeCtx(taskId, "totally-unrecognized-model-xyz");

            const provider: LLMProvider = {
                chat: async (): Promise<ProviderChatResponse> => {
                    clock += 50;
                    return {
                        message: {
                            id: generateId(),
                            sessionId: ctx.sessionId,
                            role: "assistant",
                            content: "done",
                            createdAt: nowIso(),
                        },
                        stopReason: "completed",
                        usage: {
                            inputTokens: 3500,
                            outputTokens: 300,
                            uncachedInputTokens: 1000,
                            cacheReadTokens: 2000,
                            cacheCreationTokens: 500,
                        },
                    };
                },
            };

            await runTask({ db, ctx, provider, registry: emptyRegistry });

            const row = sqlite
                .prepare("SELECT est_cost_usd FROM task_usage WHERE task_id = ?")
                .get(taskId) as { est_cost_usd: number | null };

            // Explicit IS NULL check — not `toBeFalsy()` — since 0 is also falsy and this
            // is exactly the bug this contract must never regress into (Step 8b: "never
            // silently wrong").
            expect(row.est_cost_usd).toBeNull();
        });
    });
});
