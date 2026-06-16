/**
 * usage_query group_by — aggregated metrics via the group_by parameter.
 *
 * Tests cover:
 *   1. group_by="agent" aggregates token totals and status counts per agent.
 *   2. group_by="model" aggregates per model string.
 *   3. group_by="provider" aggregates per provider type.
 *   4. Filters (agent_name, since) compose with group_by before aggregation.
 *   5. Results are ordered by total token spend descending.
 *   6. Without group_by, original raw-row behaviour is unchanged (non-regression).
 *   7. Empty DB returns empty groups array.
 *   8. avgLatencyMs excludes 0-latency (incomplete / pending) rows.
 *   9. cacheReadTokens and cacheCreationTokens are summed per group.
 *
 * Teeth checks (reverting the grouped query path makes these fail):
 *   - Verify completedCount/failedCount by inserting tasks with known statuses
 *     and asserting counts after join.
 *   - Verify ordering by inserting a cheap agent before an expensive one and
 *     asserting expensive agent appears first.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "../db/schema.js";
import { taskUsageTable, tasksTable } from "../db/schema.js";
import { usageQuery, type Database as DbType } from "../tools/usage.js";
import { nowIso } from "../utils/timestamps.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeTestDb() {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db as any as DbType;
}

type Status = "completed" | "failed" | "cancelled" | "running" | "pending";

interface TaskRow {
    taskId:       string;
    agentName:    string;
    model:        string;
    providerType: string;
    inputTokens:  number;
    outputTokens: number;
    toolCallCount?: number;
    modelCalls?:  number;
    latencyMs?:   number;
    isComplete?:  number;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    /** If set, a corresponding tasks row is inserted with this status. */
    status?:      Status;
}

function insertUsage(db: DbType, rows: TaskRow[]): void {
    for (const r of rows) {
        const now = nowIso();
        // Insert tasks row first if a status is given (satisfies FK for joins).
        // agent-mcp schema has no FK from task_usage → tasks, but the join in
        // the grouped query uses LEFT JOIN, so both paths are tested here.
        if (r.status) {
            // Minimal tasks row — only required columns.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (db as any).insert(tasksTable).values({
                id:         r.taskId,
                agentName:  r.agentName,
                status:     r.status,
                prompt:     "test prompt",
                createdAt:  now,
                updatedAt:  now,
            }).run();
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).insert(taskUsageTable).values({
            taskId:              r.taskId,
            agentName:           r.agentName,
            model:               r.model,
            providerType:        r.providerType,
            inputTokens:         r.inputTokens,
            outputTokens:        r.outputTokens,
            toolCallCount:       r.toolCallCount ?? 0,
            modelCalls:          r.modelCalls ?? 1,
            latencyMs:           r.latencyMs ?? 0,
            isComplete:          r.isComplete ?? 1,
            cacheReadTokens:     r.cacheReadTokens ?? null,
            cacheCreationTokens: r.cacheCreationTokens ?? null,
            createdAt:           now,
        }).run();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("usage_query — group_by", () => {
    let db: DbType;

    beforeEach(() => {
        db = makeTestDb();
    });

    it("group_by='agent' aggregates token totals per agent", () => {
        insertUsage(db, [
            { taskId: "t1", agentName: "alpha", model: "gpt-4o", providerType: "openai",
              inputTokens: 100, outputTokens: 50, status: "completed" },
            { taskId: "t2", agentName: "alpha", model: "gpt-4o", providerType: "openai",
              inputTokens: 200, outputTokens: 100, status: "failed" },
            { taskId: "t3", agentName: "beta", model: "gpt-4o", providerType: "openai",
              inputTokens: 500, outputTokens: 250, status: "completed" },
        ]);

        const result = usageQuery(db, { group_by: "agent" });

        expect(result.rows).toHaveLength(0);
        expect(result.groups).toBeDefined();
        expect(result.groups).toHaveLength(2);

        // Ordered by total token spend desc: beta (750) > alpha (450)
        expect(result.groups![0].key).toBe("beta");
        expect(result.groups![0].inputTokens).toBe(500);
        expect(result.groups![0].outputTokens).toBe(250);
        expect(result.groups![0].taskCount).toBe(1);
        expect(result.groups![0].completedCount).toBe(1);
        expect(result.groups![0].failedCount).toBe(0);

        expect(result.groups![1].key).toBe("alpha");
        expect(result.groups![1].inputTokens).toBe(300);
        expect(result.groups![1].outputTokens).toBe(150);
        expect(result.groups![1].taskCount).toBe(2);
        expect(result.groups![1].completedCount).toBe(1);
        expect(result.groups![1].failedCount).toBe(1);
    });

    it("completedCount/failedCount/cancelledCount are independent status counts", () => {
        insertUsage(db, [
            { taskId: "a1", agentName: "agent-x", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, status: "completed" },
            { taskId: "a2", agentName: "agent-x", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, status: "completed" },
            { taskId: "a3", agentName: "agent-x", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, status: "failed" },
            { taskId: "a4", agentName: "agent-x", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, status: "cancelled" },
        ]);

        const result = usageQuery(db, { group_by: "agent" });
        const group = result.groups![0];

        expect(group.key).toBe("agent-x");
        expect(group.taskCount).toBe(4);
        expect(group.completedCount).toBe(2);
        expect(group.failedCount).toBe(1);
        expect(group.cancelledCount).toBe(1);
    });

    it("group_by='model' aggregates per model string", () => {
        insertUsage(db, [
            { taskId: "m1", agentName: "a", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 1000, outputTokens: 500, status: "completed" },
            { taskId: "m2", agentName: "b", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 500, outputTokens: 200, status: "completed" },
            { taskId: "m3", agentName: "a", model: "gpt-4o", providerType: "openai",
              inputTokens: 100, outputTokens: 50, status: "failed" },
        ]);

        const result = usageQuery(db, { group_by: "model" });

        expect(result.groups).toHaveLength(2);
        // claude-opus-4-5 has 2200 total tokens → first
        expect(result.groups![0].key).toBe("claude-opus-4-5");
        expect(result.groups![0].taskCount).toBe(2);
        expect(result.groups![0].inputTokens).toBe(1500);

        expect(result.groups![1].key).toBe("gpt-4o");
        expect(result.groups![1].taskCount).toBe(1);
        expect(result.groups![1].failedCount).toBe(1);
    });

    it("group_by='provider' aggregates per provider type", () => {
        insertUsage(db, [
            { taskId: "p1", agentName: "a", model: "gpt-4o", providerType: "openai",
              inputTokens: 300, outputTokens: 100, status: "completed" },
            { taskId: "p2", agentName: "b", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 1000, outputTokens: 600, status: "completed" },
            { taskId: "p3", agentName: "c", model: "claude-haiku-4-5", providerType: "anthropic",
              inputTokens: 200, outputTokens: 100, status: "failed" },
        ]);

        const result = usageQuery(db, { group_by: "provider" });

        expect(result.groups).toHaveLength(2);
        expect(result.groups![0].key).toBe("anthropic"); // 1900 vs 400
        expect(result.groups![0].taskCount).toBe(2);
        expect(result.groups![0].completedCount).toBe(1);
        expect(result.groups![0].failedCount).toBe(1);
    });

    it("agent_name filter composes with group_by before aggregation", () => {
        insertUsage(db, [
            { taskId: "f1", agentName: "target", model: "gpt-4o", providerType: "openai",
              inputTokens: 100, outputTokens: 50, status: "completed" },
            { taskId: "f2", agentName: "target", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 200, outputTokens: 100, status: "failed" },
            { taskId: "f3", agentName: "other", model: "gpt-4o", providerType: "openai",
              inputTokens: 9999, outputTokens: 9999, status: "completed" },
        ]);

        // group_by model, but only for "target" agent
        const result = usageQuery(db, { agent_name: "target", group_by: "model" });

        expect(result.groups).toHaveLength(2);
        // Should only see target's tasks, not "other"
        const keys = result.groups!.map(g => g.key);
        expect(keys).toContain("gpt-4o");
        expect(keys).toContain("claude-opus-4-5");
        // "other"'s 9999+9999 tokens should NOT appear
        const total = result.groups!.reduce((n, g) => n + g.inputTokens + g.outputTokens, 0);
        expect(total).toBe(100 + 50 + 200 + 100);
    });

    it("summary totals aggregate across all groups", () => {
        insertUsage(db, [
            { taskId: "s1", agentName: "a", model: "m", providerType: "openai",
              inputTokens: 100, outputTokens: 50, toolCallCount: 3, modelCalls: 2, status: "completed" },
            { taskId: "s2", agentName: "b", model: "m", providerType: "openai",
              inputTokens: 200, outputTokens: 100, toolCallCount: 5, modelCalls: 4, status: "failed" },
        ]);

        const result = usageQuery(db, { group_by: "agent" });

        expect(result.summary.totalInputTokens).toBe(300);
        expect(result.summary.totalOutputTokens).toBe(150);
        expect(result.summary.totalToolCalls).toBe(8);
        expect(result.summary.totalModelCalls).toBe(6);
        expect(result.summary.taskCount).toBe(2);
    });

    it("avgLatencyMs excludes zero-latency rows", () => {
        insertUsage(db, [
            { taskId: "l1", agentName: "a", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, latencyMs: 1000, status: "completed" },
            { taskId: "l2", agentName: "a", model: "m", providerType: "openai",
              inputTokens: 10, outputTokens: 5, latencyMs: 3000, status: "completed" },
            { taskId: "l3", agentName: "a", model: "m", providerType: "openai",
              // latencyMs=0: still-running or crashed before terminal
              inputTokens: 10, outputTokens: 5, latencyMs: 0, isComplete: 1, status: "running" },
        ]);

        const result = usageQuery(db, { group_by: "agent" });
        const group = result.groups![0];

        // avg of 1000 and 3000 (0 is excluded) = 2000
        expect(group.avgLatencyMs).toBe(2000);
        expect(group.taskCount).toBe(3);
    });

    it("cacheReadTokens and cacheCreationTokens are summed per group", () => {
        insertUsage(db, [
            { taskId: "c1", agentName: "ant", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 100, outputTokens: 50,
              cacheReadTokens: 800, cacheCreationTokens: 200, status: "completed" },
            { taskId: "c2", agentName: "ant", model: "claude-opus-4-5", providerType: "anthropic",
              inputTokens: 100, outputTokens: 50,
              cacheReadTokens: 400, cacheCreationTokens: 100, status: "completed" },
        ]);

        const result = usageQuery(db, { group_by: "agent" });
        const group = result.groups![0];

        expect(group.cacheReadTokens).toBe(1200);
        expect(group.cacheCreationTokens).toBe(300);
    });

    it("empty DB returns empty groups", () => {
        const result = usageQuery(db, { group_by: "agent" });
        expect(result.groups).toEqual([]);
        expect(result.rows).toEqual([]);
        expect(result.summary.taskCount).toBe(0);
    });

    it("limit caps the number of groups returned", () => {
        insertUsage(db, [
            { taskId: "lim1", agentName: "a1", model: "m", providerType: "openai",
              inputTokens: 1000, outputTokens: 500, status: "completed" },
            { taskId: "lim2", agentName: "a2", model: "m", providerType: "openai",
              inputTokens: 800, outputTokens: 400, status: "completed" },
            { taskId: "lim3", agentName: "a3", model: "m", providerType: "openai",
              inputTokens: 600, outputTokens: 300, status: "completed" },
        ]);

        const result = usageQuery(db, { group_by: "agent", limit: 2 });
        expect(result.groups).toHaveLength(2);
        // Top 2 by token spend: a1 (1500) and a2 (1200)
        expect(result.groups![0].key).toBe("a1");
        expect(result.groups![1].key).toBe("a2");
    });

    it("rows with no corresponding tasks row still appear in groups (LEFT JOIN safety)", () => {
        // Insert task_usage WITHOUT a tasks row (no status param)
        insertUsage(db, [
            { taskId: "nofk1", agentName: "orphan-agent", model: "m", providerType: "openai",
              inputTokens: 100, outputTokens: 50 },
        ]);

        const result = usageQuery(db, { group_by: "agent" });

        expect(result.groups).toHaveLength(1);
        expect(result.groups![0].key).toBe("orphan-agent");
        // No tasks row → status counts are all 0
        expect(result.groups![0].completedCount).toBe(0);
        expect(result.groups![0].failedCount).toBe(0);
        expect(result.groups![0].cancelledCount).toBe(0);
    });

    it("non-regression: without group_by, raw rows are returned unchanged", () => {
        insertUsage(db, [
            { taskId: "nr1", agentName: "a", model: "m", providerType: "openai",
              inputTokens: 100, outputTokens: 50, status: "completed" },
            { taskId: "nr2", agentName: "b", model: "m", providerType: "openai",
              inputTokens: 200, outputTokens: 100, status: "failed" },
        ]);

        const result = usageQuery(db, {});

        expect(result.groups).toBeUndefined();
        expect(result.rows).toHaveLength(2);
        expect(result.summary.taskCount).toBe(2);
        expect(result.summary.totalInputTokens).toBe(300);
    });
});
