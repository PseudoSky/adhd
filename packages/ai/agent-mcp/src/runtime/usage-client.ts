import type { ExecutionContext, TokenUsage } from "@adhd/agent-mcp-types";

export type Scope = "task" | "session" | "agent";

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    modelCalls: number;
}

interface Accumulator {
    taskId: string;
    startedAtMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    modelCalls: number;
    totalModelMs: number;
    modelCallStartMs?: number;
    toolCalls: Map<string, number>;
}

/**
 * Shared usage accumulator and query client.
 *
 * Manages per-task in-memory counters and provides scope-aware total
 * resolution (in-memory + DB merge for session/agent scopes) and
 * 24h rolling-window queries.
 *
 * Used by both:
 *   - the built-in UsagePlugin (writes task_usage, reads via this client)
 *   - the budget plugin (reads accumulated totals for enforcement)
 */
export class UsageClient {
    private readonly accumulators = new Map<string, Accumulator>();

    constructor(
        private readonly db: unknown,
    ) {}

    // ── Accumulator lifecycle ───────────────────────────────────────────

    create(taskId: string, ctx: ExecutionContext): void {
        this.accumulators.set(taskId, {
            taskId,
            startedAtMs: Date.now(),
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            modelCalls: 0,
            totalModelMs: 0,
            toolCalls: new Map(),
        });
    }

    remove(taskId: string): void {
        this.accumulators.delete(taskId);
    }

    // ── Recording ───────────────────────────────────────────────────────

    recordModelCall(taskId: string, usage: TokenUsage | undefined): void {
        const acc = this.accumulators.get(taskId);
        if (!acc) return;

        if (usage) {
            acc.inputTokens += usage.inputTokens ?? 0;
            acc.outputTokens += usage.outputTokens ?? 0;
            acc.cacheTokens +=
                (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
        }
        acc.modelCalls += 1;
    }

    markModelCallStart(taskId: string): void {
        const acc = this.accumulators.get(taskId);
        if (acc) acc.modelCallStartMs = Date.now();
    }

    markModelCallEnd(taskId: string): void {
        const acc = this.accumulators.get(taskId);
        if (!acc || acc.modelCallStartMs === undefined) return;
        acc.totalModelMs += Date.now() - acc.modelCallStartMs;
        acc.modelCallStartMs = undefined;
    }

    recordToolCall(taskId: string, toolName: string): void {
        const acc = this.accumulators.get(taskId);
        if (!acc) return;
        const count = acc.toolCalls.get(toolName) ?? 0;
        acc.toolCalls.set(toolName, count + 1);
    }

    getToolCallCount(taskId: string, toolName: string): number {
        return this.accumulators.get(taskId)?.toolCalls.get(toolName) ?? 0;
    }

    getWallClockMs(taskId: string): number {
        const acc = this.accumulators.get(taskId);
        return acc ? Date.now() - acc.startedAtMs : 0;
    }

    getModelMs(taskId: string): number {
        return this.accumulators.get(taskId)?.totalModelMs ?? 0;
    }

    // ── Scope-aware totals ──────────────────────────────────────────────

    getTotals(
        taskId: string,
        scope: Scope,
        sessionId?: string,
        agentName?: string,
    ): UsageTotals {
        const acc = this.accumulators.get(taskId);
        const inMem = acc
            ? {
                  inputTokens: acc.inputTokens,
                  outputTokens: acc.outputTokens,
                  cacheTokens: acc.cacheTokens,
                  modelCalls: acc.modelCalls,
              }
            : { inputTokens: 0, outputTokens: 0, cacheTokens: 0, modelCalls: 0 };

        if (scope === "task" || !this.db) return inMem;

        try {
            const db = this.db as {
                prepare: (sql: string) => {
                    get: (...args: unknown[]) =>
                        | { input: number; output: number; cache: number; calls: number }
                        | undefined;
                };
            };

            let row: { input: number; output: number; cache: number; calls: number } | undefined;

            if (scope === "session" && sessionId) {
                row = db
                    .prepare(
                        `SELECT
                            COALESCE(SUM(tu.input_tokens), 0) AS input,
                            COALESCE(SUM(tu.output_tokens), 0) AS output,
                            COALESCE(SUM(COALESCE(tu.cache_read_input_tokens,0) + COALESCE(tu.cache_creation_input_tokens,0)), 0) AS cache,
                            COALESCE(SUM(tu.model_calls), 0) AS calls
                        FROM task_usage tu
                        JOIN tasks t ON tu.task_id = t.id
                        WHERE t.session_id = ? AND tu.task_id != ?`,
                    )
                    .get(sessionId, taskId) as typeof row;
            } else if (scope === "agent") {
                row = db
                    .prepare(
                        `SELECT
                            COALESCE(SUM(input_tokens), 0) AS input,
                            COALESCE(SUM(output_tokens), 0) AS output,
                            COALESCE(SUM(COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)), 0) AS cache,
                            COALESCE(SUM(model_calls), 0) AS calls
                        FROM task_usage
                        WHERE agent_name = ? AND task_id != ?`,
                    )
                    .get(agentName, taskId) as typeof row;
            }

            if (row) {
                return {
                    inputTokens: (row.input ?? 0) + inMem.inputTokens,
                    outputTokens: (row.output ?? 0) + inMem.outputTokens,
                    cacheTokens: (row.cache ?? 0) + inMem.cacheTokens,
                    modelCalls: (row.calls ?? 0) + inMem.modelCalls,
                };
            }
        } catch {
            // DB query failed — fall back to in-memory
        }

        return inMem;
    }

    // ── 24h rolling window ────────────────────────────────────────────

    getUsageInWindow(scope: Scope, id: string): number {
        if (!this.db) return 0;
        try {
            const db = this.db as {
                prepare: (sql: string) => { get: (...args: unknown[]) => { total: number } | undefined };
            };
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            let row: { total: number } | undefined;

            if (scope === "session") {
                row = db
                    .prepare(
                        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
                         FROM task_usage tu
                         JOIN tasks t ON tu.task_id = t.id
                         WHERE t.session_id = ? AND tu.created_at >= ?`,
                    )
                    .get(id, since) as typeof row;
            } else if (scope === "agent") {
                row = db
                    .prepare(
                        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
                         FROM task_usage
                         WHERE agent_name = ? AND created_at >= ?`,
                    )
                    .get(id, since) as typeof row;
            }

            return row?.total ?? 0;
        } catch {
            return 0;
        }
    }
}
