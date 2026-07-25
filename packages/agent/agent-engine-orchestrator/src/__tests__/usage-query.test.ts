import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { usageQuery, type Database as OrchestratorDb } from "../tools/usage.js";

/**
 * Real (not mocked) better-sqlite3 + drizzle DB against the production `task_usage` /
 * `tasks` schema. Proves usageQuery's group_by aggregation the way a real MCP host
 * would call it — only the wire-level LLM boundary is out of scope here, not the DB.
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

function makeTestDb(): OrchestratorDb {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    return drizzle(sqlite, { schema }) as unknown as OrchestratorDb;
}

function insertTask(db: OrchestratorDb, id: string, status = "completed"): void {
    (db as unknown as { $client: InstanceType<typeof Database> }).$client
        .prepare(
            `INSERT INTO tasks (id, status, prompt, created_at, updated_at) VALUES (?, ?, 'p', datetime('now'), datetime('now'))`
        )
        .run(id, status);
}

function insertUsage(
    db: OrchestratorDb,
    row: {
        taskId: string;
        agentName: string;
        providerType: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        uncachedInputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        reasoningTokens: number;
        peakContextTokens: number;
    }
): void {
    (db as unknown as { $client: InstanceType<typeof Database> }).$client
        .prepare(
            `INSERT INTO task_usage
                (task_id, agent_name, provider_type, model, input_tokens, output_tokens,
                 model_calls, is_complete, uncached_input_tokens, cache_read_input_tokens,
                 cache_creation_input_tokens, reasoning_tokens, peak_context_tokens, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
            row.taskId,
            row.agentName,
            row.providerType,
            row.model,
            row.inputTokens,
            row.outputTokens,
            row.uncachedInputTokens,
            row.cacheReadTokens,
            row.cacheCreationTokens,
            row.reasoningTokens,
            row.peakContextTokens
        );
}

/**
 * BUG-ORCH-009 follow-up gap: `usage_query`'s `group_by` branch previously dropped
 * uncachedInputTokens/reasoningTokens/peakContextTokens from both the per-group rows
 * and the top-level summary — even though the non-grouped (raw rows) path always
 * carried them. A caller using group_by='agent' saw a large inputTokens with no
 * non-cached total, overstating real cost for a heavily-cached agent.
 */
describe("usageQuery — group_by aggregation (BUG-ORCH-009 follow-up)", () => {
    it("folds uncachedInputTokens/reasoningTokens/peakContextTokens into grouped rows and summary", () => {
        const db = makeTestDb();

        insertTask(db, "t1");
        insertUsage(db, {
            taskId: "t1",
            agentName: "typescript-deepseek",
            providerType: "openai",
            model: "deepseek-v4-flash",
            inputTokens: 100_000,
            outputTokens: 5_000,
            uncachedInputTokens: 8_000,
            cacheReadTokens: 92_000,
            cacheCreationTokens: 0,
            reasoningTokens: 300,
            peakContextTokens: 40_000,
        });

        insertTask(db, "t2");
        insertUsage(db, {
            taskId: "t2",
            agentName: "typescript-deepseek",
            providerType: "openai",
            model: "deepseek-v4-flash",
            inputTokens: 50_000,
            outputTokens: 2_000,
            uncachedInputTokens: 4_000,
            cacheReadTokens: 46_000,
            cacheCreationTokens: 0,
            reasoningTokens: 100,
            peakContextTokens: 60_000, // higher than t1 -> should win the MAX
        });

        const result = usageQuery(db, { group_by: "agent", include_incomplete: true });

        expect(result.groups).toHaveLength(1);
        const group = result.groups![0];
        expect(group.key).toBe("typescript-deepseek");
        // Previously undefined/missing entirely — this is the exact gap.
        expect(group.uncachedInputTokens).toBe(12_000); // 8_000 + 4_000
        expect(group.reasoningTokens).toBe(400); // 300 + 100
        // MAX across the group, NOT a sum (FINDING-ORCH-007) — must be 60_000, not 100_000.
        expect(group.peakContextTokens).toBe(60_000);

        // The aggregate summary block must also carry these — not just the per-group rows —
        // so a caller reading only `summary` still sees the non-cached total.
        expect(result.summary.totalUncachedInputTokens).toBe(12_000);
        expect(result.summary.totalReasoningTokens).toBe(400);
        expect(result.summary.peakContextTokens).toBe(60_000);
    });

    it("control: the non-grouped (raw rows) summary already carried these fields — proves this isn't newly broken elsewhere", () => {
        const db = makeTestDb();
        insertTask(db, "t1");
        insertUsage(db, {
            taskId: "t1",
            agentName: "a",
            providerType: "anthropic",
            model: "claude-opus-4",
            inputTokens: 1_000,
            outputTokens: 100,
            uncachedInputTokens: 300,
            cacheReadTokens: 700,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
            peakContextTokens: 1_000,
        });

        const result = usageQuery(db, { include_incomplete: true });
        expect(result.summary.totalUncachedInputTokens).toBe(300);
        expect(result.summary.peakContextTokens).toBe(1_000);
    });
});
