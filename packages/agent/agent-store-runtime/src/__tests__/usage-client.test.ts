import Database from "better-sqlite3";
import { describe, expect, it, beforeEach } from "vitest";
import { UsageClient } from "../runtime/usage-client.js";
import type { ExecutionContext, TokenUsage } from "@adhd/agent-base-types";

const TASK_USAGE_TABLE_SQL = `
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
    created_at TEXT NOT NULL
);
`;

function makeExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
    return {
        taskId: "task-1",
        sessionId: "session-1",
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini" },
            mcpServers: {},
            permissions: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
        recursionDepth: 0,
        toolCallCount: 0,
        ...overrides,
    };
}

describe("UsageClient", () => {
    let client: UsageClient;

    beforeEach(() => {
        client = new UsageClient(null);
    });

    it("creates an accumulator for a task", () => {
        const ctx = makeExecutionContext();
        expect(() => client.create(ctx.taskId, ctx)).not.toThrow();
    });

    it("removes an accumulator", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);
        client.remove(ctx.taskId);
        // No error should throw; accumulator just doesn't exist anymore
        expect(client.getWallClockMs(ctx.taskId)).toBe(0);
    });

    it("records model call tokens", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
        client.recordModelCall(ctx.taskId, usage);

        const totals = client.getTotals(ctx.taskId, "task");
        expect(totals.inputTokens).toBe(100);
        expect(totals.outputTokens).toBe(50);
        expect(totals.modelCalls).toBe(1);
    });

    it("records model call without usage (no-op for tokens, increments call count)", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        client.recordModelCall(ctx.taskId, undefined);

        const totals = client.getTotals(ctx.taskId, "task");
        expect(totals.inputTokens).toBe(0);
        expect(totals.outputTokens).toBe(0);
        expect(totals.modelCalls).toBe(1);
    });

    it("accumulates cache tokens", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        const usage: TokenUsage = {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 30,
            cacheCreationTokens: 20,
        };
        client.recordModelCall(ctx.taskId, usage);

        const totals = client.getTotals(ctx.taskId, "task");
        expect(totals.cacheTokens).toBe(50);
    });

    it("records tool calls and retrieves counts", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        client.recordToolCall(ctx.taskId, "read_file");
        client.recordToolCall(ctx.taskId, "read_file");
        client.recordToolCall(ctx.taskId, "write_file");

        expect(client.getToolCallCount(ctx.taskId, "read_file")).toBe(2);
        expect(client.getToolCallCount(ctx.taskId, "write_file")).toBe(1);
        expect(client.getToolCallCount(ctx.taskId, "unknown_tool")).toBe(0);
    });

    it("returns 0 for getToolCallCount on unknown task", () => {
        expect(client.getToolCallCount("nonexistent", "read_file")).toBe(0);
    });

    it("tracks wall clock time", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        const elapsed = client.getWallClockMs(ctx.taskId);
        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect(elapsed).toBeLessThan(5000); // should be very small
    });

    it("returns 0 wall clock for unknown task", () => {
        expect(client.getWallClockMs("nonexistent")).toBe(0);
    });

    it("tracks model time with markModelCallStart/End", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        client.markModelCallStart(ctx.taskId);
        // Simulate some time passing (can't really wait in unit tests)
        client.markModelCallEnd(ctx.taskId);

        expect(client.getModelMs(ctx.taskId)).toBeGreaterThanOrEqual(0);
    });

    it("markModelCallEnd is no-op without start", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        expect(() => client.markModelCallEnd(ctx.taskId)).not.toThrow();
        expect(client.getModelMs(ctx.taskId)).toBe(0);
    });

    it("returns 0 model ms for unknown task", () => {
        expect(client.getModelMs("nonexistent")).toBe(0);
    });

    it("getTotals task-scope returns only in-memory", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
        client.recordModelCall(ctx.taskId, usage);

        const totals = client.getTotals(ctx.taskId, "task");
        expect(totals.inputTokens).toBe(100);
        expect(totals.outputTokens).toBe(50);
    });

    it("getTotals returns zero for unknown task", () => {
        const totals = client.getTotals("nonexistent", "task");
        expect(totals.inputTokens).toBe(0);
        expect(totals.outputTokens).toBe(0);
        expect(totals.modelCalls).toBe(0);
    });

    it("getTotals without db returns in-memory for any scope", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);
        client.recordModelCall(ctx.taskId, { inputTokens: 100, outputTokens: 50 });

        // Without a DB connection, session scope falls back to in-memory
        const totals = client.getTotals(ctx.taskId, "session", "session-1");
        expect(totals.inputTokens).toBe(100);
    });

    it("getUsageInWindow returns 0 without db", () => {
        expect(client.getUsageInWindow("session", "session-1")).toBe(0);
    });

    it("multiple accumulate calls add up", () => {
        const ctx = makeExecutionContext();
        client.create(ctx.taskId, ctx);

        client.recordModelCall(ctx.taskId, { inputTokens: 100, outputTokens: 50 });
        client.recordModelCall(ctx.taskId, { inputTokens: 200, outputTokens: 75 });
        client.recordModelCall(ctx.taskId, { inputTokens: 50, outputTokens: 25 });

        const totals = client.getTotals(ctx.taskId, "task");
        expect(totals.inputTokens).toBe(350);
        expect(totals.outputTokens).toBe(150);
        expect(totals.modelCalls).toBe(3);
    });
});

// ── Cache-token double-count in getUsageInWindow (BUG-ORCH-010) ────────────
//
// `input_tokens` in task_usage is already the provider-neutral TOTAL a call
// processed (uncachedInputTokens + cacheReadTokens + cacheCreationTokens summed at
// the provider boundary — see agent-engine-orchestrator's normaliseAnthropicUsage /
// normaliseOpenAIUsage, BUG-ORCH-010). Summing cache_read_input_tokens /
// cache_creation_input_tokens on top of input_tokens again double-counts the cached
// portion of a windowed usage total. This drives the REAL better-sqlite3 engine
// (not a mock) against the real production schema, so the fixed SQL text is proven,
// not just asserted by inspection.
describe("UsageClient.getUsageInWindow — cache-token double-count (BUG-ORCH-010)", () => {
    function makeRealDb() {
        const sqlite = new Database(":memory:");
        sqlite.exec(TASK_USAGE_TABLE_SQL);
        return sqlite;
    }

    function insertTaskUsage(
        sqlite: InstanceType<typeof Database>,
        row: {
            taskId: string;
            agentName: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
            createdAt: string;
        }
    ): void {
        sqlite
            .prepare(
                `INSERT INTO task_usage
                    (task_id, agent_name, provider_type, model, input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens, created_at)
                 VALUES (?, ?, 'openai', 'gpt-4o-mini', ?, ?, ?, ?, ?)`
            )
            .run(
                row.taskId,
                row.agentName,
                row.inputTokens,
                row.outputTokens,
                row.cacheReadTokens,
                row.cacheCreationTokens,
                row.createdAt
            );
    }

    it("sums to the real (non-double-counted) total for an agent-scoped window", () => {
        const sqlite = makeRealDb();
        const now = new Date().toISOString();

        // Row 1: input_tokens(100) already includes cache_read(80) + cache_creation(10)
        // — the shape real providers actually emit post-BUG-ORCH-010 normalisation.
        insertTaskUsage(sqlite, {
            taskId: "t1",
            agentName: "test-agent",
            inputTokens: 100,
            outputTokens: 40,
            cacheReadTokens: 80,
            cacheCreationTokens: 10,
            createdAt: now,
        });
        // Row 2: a cold call, no cache.
        insertTaskUsage(sqlite, {
            taskId: "t2",
            agentName: "test-agent",
            inputTokens: 60,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            createdAt: now,
        });

        const client = new UsageClient(sqlite);
        const total = client.getUsageInWindow("agent", "test-agent");

        // Real total = (100+40) + (60+20) = 220. A double-count would additionally
        // add cache_read+cache_creation (90) on top, producing 310.
        expect(total).toBe(220);
    });

    it("excludes the current task and respects the time window", () => {
        const sqlite = makeRealDb();
        const now = new Date();
        const old = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

        insertTaskUsage(sqlite, {
            taskId: "current",
            agentName: "test-agent",
            inputTokens: 999,
            outputTokens: 999,
            cacheReadTokens: 999,
            cacheCreationTokens: 999,
            createdAt: now.toISOString(),
        });
        insertTaskUsage(sqlite, {
            taskId: "too-old",
            agentName: "test-agent",
            inputTokens: 500,
            outputTokens: 500,
            cacheReadTokens: 100,
            cacheCreationTokens: 0,
            createdAt: old,
        });
        insertTaskUsage(sqlite, {
            taskId: "in-window",
            agentName: "test-agent",
            inputTokens: 30,
            outputTokens: 10,
            cacheReadTokens: 20,
            cacheCreationTokens: 0,
            createdAt: now.toISOString(),
        });

        const client = new UsageClient(sqlite);
        const total = client.getUsageInWindow(
            "agent",
            "test-agent",
            24 * 60 * 60 * 1000,
            "current"
        );

        // Only "in-window" counts: 30 + 10 = 40. "current" excluded by taskId,
        // "too-old" excluded by the 24h window.
        expect(total).toBe(40);
    });
});
