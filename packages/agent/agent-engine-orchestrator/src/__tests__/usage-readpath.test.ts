import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import { estimateCost } from "@adhd/agent-core-provider";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { PolicyEngine } from "../engine/policy.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { usageQuery, usageQueryByGrain, type Database as OrchestratorDb } from "../tools/usage.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/**
 * 1f1c8598 / 37f6c511 segment S4b - the usage READ path.
 *
 * Real (migrated) SQLite + the real `usageQuery` / `usageQueryByGrain` functions a host
 * calls for `usage_query`. Price history rows and provenance columns are seeded exactly as
 * the write path / G3 pull persist them; nothing under test is mocked. The write-path parity
 * test drives the real Orchestrator + UsagePlugin and only fakes the provider SDK boundary
 * and the clock.
 */

// A model id that exists in neither RATE_CARD nor the bundled OpenRouter snapshot, so its
// price comes ONLY from the seeded history rows.
const HIST_MODEL = "acme/readpath-test-model";

interface ISqliteDb {
  db: OrchestratorDb;
  sqlite: InstanceType<typeof Database>;
}

function makeDb(): ISqliteDb {
  const sqlite = createMigratedSqlite();
  const db = drizzle(sqlite, { schema }) as unknown as OrchestratorDb;
  return { db, sqlite };
}

function insertTask(
  s: ISqliteDb,
  id: string,
  opts: { sessionId?: string; status?: string; createdAt?: string } = {}
): void {
  const at = opts.createdAt ?? "2026-01-01T00:00:00.000Z";
  s.sqlite
    .prepare(
      `INSERT INTO tasks (id, session_id, status, prompt, created_at, updated_at) VALUES (?, ?, ?, 'p', ?, ?)`
    )
    .run(id, opts.sessionId ?? `sess-${id}`, opts.status ?? "completed", at, at);
}

interface IUsageSeed {
  taskId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  isComplete?: number;
  createdAt?: string;
  estCostUsd?: number | null;
  responseModel?: string | null;
  costBasis?: string | null;
  pricingRef?: string | null;
  costStatus?: string | null;
  pricedCostUsd?: number | null;
  unpricedTokens?: number | null;
}

function insertUsage(s: ISqliteDb, u: IUsageSeed): void {
  s.sqlite
    .prepare(
      `INSERT INTO task_usage
        (task_id, agent_name, provider_type, model, input_tokens, output_tokens, model_calls, is_complete,
         uncached_input_tokens, cache_read_input_tokens, cache_creation_input_tokens, peak_context_tokens,
         created_at, est_cost_usd, response_model, cost_basis, pricing_ref, cost_status, priced_cost_usd,
         unpriced_tokens)
       VALUES (?, 'agent-a', 'openai', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.taskId,
      u.model,
      u.inputTokens ?? 100,
      u.outputTokens ?? 10,
      u.modelCalls ?? 1,
      u.isComplete ?? 1,
      u.inputTokens ?? 100,
      u.inputTokens ?? 100,
      u.createdAt ?? "2026-01-01T00:00:00.000Z",
      u.estCostUsd ?? null,
      u.responseModel ?? null,
      u.costBasis ?? null,
      u.pricingRef ?? null,
      u.costStatus ?? null,
      u.pricedCostUsd ?? null,
      u.unpricedTokens ?? null
    );
}

let eventSeq = 0;
function insertTurn(
  s: ISqliteDb,
  taskId: string,
  at: string,
  payload: Record<string, unknown>
): void {
  eventSeq += 1;
  s.sqlite
    .prepare(`INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, 'MODEL_RESPONSE', ?, ?)`)
    .run(`evt-${eventSeq}`, taskId, JSON.stringify(payload), at);
}

function insertPrice(
  s: ISqliteDb,
  modelId: string,
  observedAt: string,
  rates: { inputPerM: number | null; outputPerM: number | null },
  kind: "model" | "router" = "model"
): void {
  eventSeq += 1;
  s.sqlite
    .prepare(
      `INSERT INTO model_price_history
        (id, model_id, observed_at, source, kind, input_per_m, cache_read_per_m, cache_write_per_m, output_per_m, raw_json)
       VALUES (?, ?, ?, 'openrouter-live', ?, ?, NULL, NULL, ?, '{}')`
    )
    .run(`ph-${eventSeq}`, modelId, observedAt, kind, rates.inputPerM, rates.outputPerM);
}

/** 1M uncached input + 1M output tokens: cost in USD equals inputPerM + outputPerM. */
const MILLION_EACH = { inputTokens: 1_000_000, outputTokens: 1_000_000, uncachedInputTokens: 1_000_000 };

const JAN = "2026-01-15T00:00:00.000Z";
const FEB = "2026-02-15T00:00:00.000Z";

describe("usage read path (S4b): as-of pricing", () => {
  it("37f6c511 FS3-AC4: turn grain prices each turn as of its own event time through the shared price source", () => {
    const s = makeDb();
    insertPrice(s, HIST_MODEL, "2026-01-01T00:00:00.000Z", { inputPerM: 1, outputPerM: 2 });
    insertPrice(s, HIST_MODEL, "2026-02-01T00:00:00.000Z", { inputPerM: 10, outputPerM: 20 });
    insertTask(s, "t1");
    insertUsage(s, { taskId: "t1", model: HIST_MODEL, modelCalls: 2 });
    insertTurn(s, "t1", JAN, MILLION_EACH);
    insertTurn(s, "t1", FEB, MILLION_EACH);

    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    const byTime = new Map(res.rows.map((r) => [r.created_at, r]));
    expect(byTime.get(JAN)?.est_cost_usd).toBeCloseTo(3, 9); // 1 + 2 at the January price
    expect(byTime.get(FEB)?.est_cost_usd).toBeCloseTo(30, 9); // 10 + 20 at the February price
    expect(byTime.get(JAN)?.pricing_ref).not.toBe(byTime.get(FEB)?.pricing_ref);
    // Negative control for the assertion itself: the "latest price" answer is NOT the January one.
    const latest = estimateCost(
      HIST_MODEL,
      { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1_000_000 },
      { source: { priceAt: () => undefined } }
    );
    expect(latest.costUsd).toBeNull();
    expect(res.summary.est_cost_usd).toBeCloseTo(33, 9);
    expect(res.summary.priced_cost_usd).toBeCloseTo(33, 9);
  });

  it("37f6c511 FS3-AC4: an instant before the first observation uses the earliest record (beforeFirstObservation)", () => {
    const s = makeDb();
    insertPrice(s, HIST_MODEL, "2026-03-01T00:00:00.000Z", { inputPerM: 4, outputPerM: 6 });
    insertTask(s, "t1");
    insertUsage(s, { taskId: "t1", model: HIST_MODEL });
    insertTurn(s, "t1", JAN, MILLION_EACH);
    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(res.rows[0].est_cost_usd).toBeCloseTo(10, 9);
    expect(res.rows[0].cost_status).toBe("priced");
  });
});

describe("usage read path (S4b): unpriced accounting", () => {
  it("1f1c8598 FS1-AC4: summary and groups report unpriced_tasks/tokens/models/turns, with 0 (not absent) when none", () => {
    const s = makeDb();
    insertTask(s, "ok-task");
    insertUsage(s, {
      taskId: "ok-task", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 10,
      estCostUsd: 0.5, costStatus: "priced", costBasis: "vendor-direct", pricedCostUsd: 0.5, unpricedTokens: 0,
      responseModel: "deepseek-v4-flash",
    });

    // Nothing unpriced yet: zeros are present, not absent.
    const clean = usageQueryByGrain(s.db, { include_incomplete: false, limit: 50, grain: "task" });
    expect(clean.summary.unpriced_tasks).toBe(0);
    expect(clean.summary.unpriced_tokens).toBe(0);
    expect(clean.summary.unpriced_turns).toBe(0);
    expect(clean.summary.unpriced_models).toEqual([]);
    expect(clean.summary.price_age_hours).toBeNull();

    insertTask(s, "unpriced-task");
    insertUsage(s, {
      taskId: "unpriced-task", model: "mystery-model", inputTokens: 700, outputTokens: 70, modelCalls: 3,
      estCostUsd: null, costStatus: "unpriced_model", pricedCostUsd: 0, unpricedTokens: 770,
    });

    const task = usageQueryByGrain(s.db, { include_incomplete: false, limit: 50, grain: "task" });
    expect(task.summary.est_cost_usd).toBeNull(); // the null total...
    expect(task.summary.priced_cost_usd).toBeCloseTo(0.5, 12); // ...is explained by the priced portion
    expect(task.summary.unpriced_tasks).toBe(1);
    expect(task.summary.unpriced_tokens).toBe(770);
    expect(task.summary.unpriced_turns).toBe(3); // every call of an unpriced_model task
    expect(task.summary.unpriced_models).toEqual(["mystery-model"]);

    const grouped = usageQuery(s.db, { include_incomplete: false, limit: 50, grain: "task", group_by: "model" });
    const mystery = grouped.groups?.find((g) => g.key === "mystery-model");
    expect(mystery?.unpriced_tasks).toBe(1);
    expect(mystery?.unpriced_tokens).toBe(770);
    expect(mystery?.unpriced_models).toEqual(["mystery-model"]);
    const ok = grouped.groups?.find((g) => g.key === "deepseek-v4-flash");
    expect(ok?.unpriced_tasks).toBe(0);
    expect(ok?.unpriced_models).toEqual([]);
    expect(grouped.summary.unpriced_tasks).toBe(1);
    expect(grouped.summary.priced_cost_usd).toBeCloseTo(0.5, 12);
  });

  it("1f1c8598 FS1-AC5: a partial task counts its exact unpriced turns by re-pricing its events", () => {
    const s = makeDb();
    insertPrice(s, HIST_MODEL, "2026-01-01T00:00:00.000Z", { inputPerM: 1, outputPerM: 2 });
    // The model becomes a router (no usable rate) from February on.
    insertPrice(s, HIST_MODEL, "2026-02-01T00:00:00.000Z", { inputPerM: null, outputPerM: null }, "router");
    insertTask(s, "p1");
    insertUsage(s, {
      taskId: "p1", model: HIST_MODEL, modelCalls: 3, estCostUsd: null,
      costStatus: "partial", pricedCostUsd: 3, unpricedTokens: 4_000_000,
    });
    insertTurn(s, "p1", JAN, MILLION_EACH);
    insertTurn(s, "p1", FEB, MILLION_EACH);
    insertTurn(s, "p1", "2026-02-20T00:00:00.000Z", MILLION_EACH);

    const task = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" });
    expect(task.rows[0].cost_status).toBe("partial");
    expect(task.rows[0].est_cost_usd).toBeNull();
    expect(task.summary.unpriced_tasks).toBe(1);
    expect(task.summary.unpriced_turns).toBe(2);
    expect(task.summary.priced_cost_usd).toBeCloseTo(3, 9);

    const turn = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(turn.rows.filter((r) => r.cost_status === "unpriced_model")).toHaveLength(2);
    expect(turn.rows.filter((r) => r.cost_status === "priced")).toHaveLength(1);
    expect(turn.summary.unpriced_turns).toBe(2);
    expect(turn.summary.unpriced_tasks).toBe(1); // distinct tasks, not turns
    expect(turn.summary.unpriced_tokens).toBe(4_000_000);
    expect(turn.summary.unpriced_models).toEqual([HIST_MODEL]);
    expect(turn.summary.est_cost_usd).toBeNull();
    expect(turn.summary.priced_cost_usd).toBeCloseTo(3, 9);
    expect(turn.summary.unpriced_turns).toBe(task.summary.unpriced_turns); // grains agree
  });

  it("1f1c8598 FS1-AC6: legacy rows (cost_status NULL) report null provenance and are never counted unpriced", () => {
    const s = makeDb();
    insertTask(s, "legacy");
    insertUsage(s, { taskId: "legacy", model: "claude-haiku-4-5", estCostUsd: 0.02 });
    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" });
    const row = res.rows[0];
    expect(row.cost_status).toBeNull();
    expect(row.cost_basis).toBeNull();
    expect(row.pricing_ref).toBeNull();
    expect(row.response_model).toBeNull();
    expect(row.est_cost_usd).toBe(0.02);
    expect(res.summary.unpriced_tasks).toBe(0);
    expect(res.summary.unpriced_turns).toBe(0);
    expect(res.summary.priced_cost_usd).toBeCloseTo(0.02, 12);
  });

  it("1f1c8598 FS1-AC3: an unknown model at turn grain is null-cost with status unpriced_model (never $0)", () => {
    const s = makeDb();
    insertTask(s, "u");
    insertUsage(s, { taskId: "u", model: "totally-unknown-model" });
    insertTurn(s, "u", JAN, { inputTokens: 500, outputTokens: 50 });
    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(res.rows[0].est_cost_usd).toBeNull();
    expect(res.rows[0].cost_status).toBe("unpriced_model");
    expect(res.rows[0].cost_basis).toBeNull();
    expect(res.rows[0].pricing_ref).toBeNull();
    expect(res.summary.unpriced_tokens).toBe(550);
    expect(res.summary.priced_cost_usd).toBe(0);
  });
});

describe("usage read path (S4b): response_model and basis labels", () => {
  it("1f1c8598 FS1-AC1: group_by=response_model buckets by the provider-reported model; legacy rows bucket as (unknown)", () => {
    const s = makeDb();
    const seed: Array<[string, string | null, number]> = [
      ["a", "deepseek-v4-flash-0731", 0.1],
      ["b", "deepseek-v4-flash-0731", 0.2],
      ["c", "deepseek-v4.1-flash", 0.4],
      ["d", null, 0.8],
    ];
    for (const [id, responseModel, cost] of seed) {
      insertTask(s, id);
      insertUsage(s, {
        taskId: id, model: "deepseek-flash", responseModel, estCostUsd: cost,
        costStatus: responseModel ? "priced" : null, costBasis: responseModel ? "owner-assumption" : null,
        pricedCostUsd: responseModel ? cost : null, unpricedTokens: responseModel ? 0 : null,
      });
    }
    const res = usageQuery(s.db, { include_incomplete: false, limit: 50, grain: "task", group_by: "response_model" });
    const byKey = new Map((res.groups ?? []).map((g) => [g.key, g]));
    expect([...byKey.keys()].sort()).toEqual(["(unknown)", "deepseek-v4-flash-0731", "deepseek-v4.1-flash"]);
    expect(byKey.get("deepseek-v4-flash-0731")?.taskCount).toBe(2);
    expect(byKey.get("deepseek-v4-flash-0731")?.priced_cost_usd).toBeCloseTo(0.3, 12);
    expect(byKey.get("(unknown)")?.taskCount).toBe(1);
    expect(byKey.get("(unknown)")?.priced_cost_usd).toBeCloseTo(0.8, 12); // legacy: est_cost_usd is the priced portion
  });

  it("1f1c8598 FS1-AC1: response_model, cost_status, cost_basis and pricing_ref are visible at task and turn grain", () => {
    const s = makeDb();
    insertTask(s, "t");
    insertUsage(s, {
      taskId: "t", model: "deepseek-flash", responseModel: "deepseek-v4-flash-0731", estCostUsd: 1,
      costStatus: "priced", costBasis: "owner-assumption", pricingRef: "bundled:2026-10-08:deepseek/deepseek-v4.1-flash",
      pricedCostUsd: 1, unpricedTokens: 0,
    });
    insertTurn(s, "t", JAN, { inputTokens: 100, outputTokens: 10, responseModel: "deepseek-v4-flash-0731" });

    const task = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" }).rows[0];
    expect(task.model).toBe("deepseek-flash"); // configured name untouched
    expect(task.response_model).toBe("deepseek-v4-flash-0731");
    expect(task.cost_status).toBe("priced");
    expect(task.cost_basis).toBe("owner-assumption");
    expect(task.pricing_ref).toBe("bundled:2026-10-08:deepseek/deepseek-v4.1-flash");

    const turn = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" }).rows[0];
    expect(turn.response_model).toBe("deepseek-v4-flash-0731");
    expect(turn.cost_basis).toBe("owner-assumption");
  });

  it("1f1c8598 FS4-AC4: vendor-direct, openrouter-estimate and owner-assumption bases are each visible in usage_query", () => {
    const s = makeDb();
    const models = ["deepseek-v4-flash", "deepseek/deepseek-v4.1-flash", "deepseek-flash"];
    models.forEach((m, i) => {
      insertTask(s, `t${i}`);
      insertUsage(s, { taskId: `t${i}`, model: m });
      insertTurn(s, `t${i}`, JAN, { inputTokens: 1000, outputTokens: 100 });
    });
    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    const basisOf = (m: string) => res.rows.find((r) => r.model === m)?.cost_basis;
    expect(basisOf("deepseek-v4-flash")).toBe("vendor-direct");
    expect(basisOf("deepseek/deepseek-v4.1-flash")).toBe("openrouter-estimate");
    expect(basisOf("deepseek-flash")).toBe("owner-assumption");
    expect(res.summary.cost_bases).toEqual(["openrouter-estimate", "owner-assumption", "vendor-direct"]);
    expect(res.summary.unpriced_turns).toBe(0);
  });

  it("1f1c8598 FS1-AC5: session grain merges task provenance (mixed status => partial, mixed bases => null) and counts unpriced tasks", () => {
    const s = makeDb();
    insertTask(s, "a", { sessionId: "S1" });
    insertTask(s, "b", { sessionId: "S1" });
    insertUsage(s, {
      taskId: "a", model: "deepseek-v4-flash", estCostUsd: 2, costStatus: "priced", costBasis: "vendor-direct",
      pricedCostUsd: 2, unpricedTokens: 0, responseModel: "deepseek-v4-flash",
    });
    insertUsage(s, {
      taskId: "b", model: "mystery", estCostUsd: null, costStatus: "unpriced_model", pricedCostUsd: 0,
      unpricedTokens: 99, modelCalls: 2,
    });
    const res = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "session" });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.cost_status).toBe("partial");
    expect(row.est_cost_usd).toBeNull();
    expect(row.cost_basis).toBe("vendor-direct"); // the only basis present
    expect(row.response_model).toBe("deepseek-v4-flash");
    expect(row.pricing_ref).toBeNull();
    expect(res.summary.priced_cost_usd).toBeCloseTo(2, 12);
    expect(res.summary.unpriced_tasks).toBe(1);
    expect(res.summary.unpriced_turns).toBe(2);
    expect(res.summary.unpriced_models).toEqual(["mystery"]);
  });
});

describe("usage read path (S4b): backward compatibility", () => {
  it("1f1c8598 FS1-AC4: existing keys and values are unchanged apart from additive fields, and the default is_complete filter holds", () => {
    const s = makeDb();
    insertTask(s, "done");
    insertTask(s, "running", { status: "running" });
    insertUsage(s, { taskId: "done", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 100, estCostUsd: 0.5, isComplete: 1 });
    insertUsage(s, { taskId: "running", model: "claude-haiku-4-5", inputTokens: 5000, outputTokens: 500, isComplete: 0 });

    for (const grain of ["task", "session"] as const) {
      const def = usageQueryByGrain(s.db, { include_incomplete: false, limit: 50, grain });
      expect(def.grain).toBe(grain);
      expect(def.rows).toHaveLength(1);
      expect(def.rows[0].input_tokens).toBe(1000);
      for (const key of [
        "session_id", "task_id", "root_task_id", "call_index", "agent_name", "provider_type", "model",
        "created_at", "is_complete", "stop_reason", "input_tokens", "output_tokens", "uncached_input_tokens",
        "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens", "tool_call_count", "model_calls",
        "compute_ms", "total_ms", "tool_call_est_result_tokens", "est_cost_usd", "context_size", "context_size_at",
      ]) {
        expect(def.rows[0], `${grain} row key ${key}`).toHaveProperty(key);
      }
      const all = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain });
      expect(all.rows.length).toBeGreaterThanOrEqual(1);
      expect(all.summary.input_tokens).toBe(6000);
    }

    const grouped = usageQuery(s.db, { include_incomplete: false, limit: 50, grain: "task", group_by: "agent" });
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups?.[0].taskCount).toBe(1);
    expect(grouped.summary.totalInputTokens).toBe(1000);
    expect(grouped.summary).toHaveProperty("peakContextTokens");
    const groupedAll = usageQuery(s.db, { include_incomplete: true, limit: 50, grain: "task", group_by: "provider" });
    expect(groupedAll.summary.totalInputTokens).toBe(6000);
  });

  it("37f6c511 FS5-AC2: price_age_hours is null with no pull ledger and tracks the last successful pull once one exists", () => {
    const s = makeDb();
    insertTask(s, "t");
    insertUsage(s, { taskId: "t", model: "claude-haiku-4-5", estCostUsd: 0.1 });
    expect(usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" }).summary.price_age_hours).toBeNull();

    const finished = new Date(Date.now() - 3 * 3_600_000).toISOString();
    s.sqlite
      .prepare(`INSERT INTO price_pull_ledger (id, started_at, finished_at, status, source_url) VALUES ('l1', ?, ?, 'ok', 'https://x')`)
      .run(finished, finished);
    const age = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" }).summary.price_age_hours;
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThan(2.99);
    expect(age as number).toBeLessThan(3.5);
    const grouped = usageQuery(s.db, { include_incomplete: true, limit: 50, grain: "task", group_by: "model" });
    expect(grouped.summary.price_age_hours).toBeGreaterThan(2.99);
  });
});

// ── Write-path parity (FS3-AC4) ───────────────────────────────────────────────

function makeAgentDefinition(model: string): AgentDefinition {
  return {
    name: "readpath-agent",
    version: 1,
    provider: { type: "openai", model },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

const policy = { check: () => { /* test stub */ } } as unknown as PolicyEngine;
const sessionStore: OrchestratorSessionStore = {
  appendMessage: async () => { /* test stub */ },
  close: () => { /* test stub */ },
};
const emptyRegistry = {
  listAllTools: async () => [],
  closeAll: async () => { /* test stub */ },
  getClient: async () => {
    throw new Error("test stub: no tool calls expected");
  },
} as unknown as McpClientRegistry;

async function runOneTurnTask(db: OrchestratorDb, model: string, tokens: { inputTokens: number; outputTokens: number }): Promise<string> {
  const taskId = generateId();
  const sessionId = generateId();
  const ctx: ExecutionContext = {
    taskId, sessionId, agentName: "readpath-agent", agentDefinition: makeAgentDefinition(model),
    recursionDepth: 0, toolCallCount: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskStore = new TaskStore(db as any);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new UsagePlugin(db as any).install(hooks);
  const provider: LLMProvider = {
    chat: async (): Promise<ProviderChatResponse> => ({
      message: { id: generateId(), sessionId, role: "assistant", content: "done", createdAt: nowIso() } as Message,
      stopReason: "completed",
      usage: { ...tokens, uncachedInputTokens: tokens.inputTokens },
    }),
  };
  await new Orchestrator().run({
    executionContext: ctx,
    messages: [{ id: generateId(), sessionId, role: "user", content: "hi", createdAt: nowIso() }],
    registry: emptyRegistry,
    provider,
    policy,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId,
    hooks,
  });
  taskStore.updateStatus(taskId, "completed", { result: "done", completedAt: nowIso() });
  return taskId;
}

describe("usage read path (S4b): write-path parity", () => {
  const T0 = Date.parse("2026-05-01T12:00:00.000Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("37f6c511 FS3-AC4: the stored (write path) cost equals the turn-grain (read path) cost for the same instant, across a price change", async () => {
    const s = makeDb();
    insertPrice(s, HIST_MODEL, "2026-04-01T00:00:00.000Z", { inputPerM: 1, outputPerM: 2 });

    const early = await runOneTurnTask(s.db, HIST_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 });

    // A newer observation lands; time advances past it. The earlier task must not move.
    insertPrice(s, HIST_MODEL, "2026-05-02T00:00:00.000Z", { inputPerM: 10, outputPerM: 20 });
    vi.setSystemTime(Date.parse("2026-05-03T12:00:00.000Z"));
    const late = await runOneTurnTask(s.db, HIST_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 });

    const task = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "task" });
    const turn = usageQueryByGrain(s.db, { include_incomplete: true, limit: 50, grain: "turn" });
    for (const id of [early, late]) {
      const t = task.rows.find((r) => r.task_id === id);
      const u = turn.rows.find((r) => r.task_id === id);
      expect(t?.est_cost_usd, `${id} stored cost`).not.toBeNull();
      expect(u?.est_cost_usd, `${id} as-of cost`).toBeCloseTo(t?.est_cost_usd as number, 12);
    }
    expect(turn.rows.find((r) => r.task_id === early)?.est_cost_usd).toBeCloseTo(3, 9);
    expect(turn.rows.find((r) => r.task_id === late)?.est_cost_usd).toBeCloseTo(30, 9);
    expect(turn.summary.unpriced_turns).toBe(0);
    expect(task.summary.unpriced_tasks).toBe(0);
  });
});
