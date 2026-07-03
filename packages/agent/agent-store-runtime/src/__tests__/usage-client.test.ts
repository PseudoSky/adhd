import { describe, expect, it, beforeEach } from "vitest";
import { UsageClient } from "../runtime/usage-client.js";
import type { ExecutionContext, TokenUsage } from "@adhd/agent-base-types";

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
