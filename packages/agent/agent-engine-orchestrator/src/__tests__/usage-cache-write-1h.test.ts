import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { PriceHistoryStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { normaliseAnthropicUsage } from "../providers/anthropic.js";
import { usageQueryByGrain, type Database as OrchestratorDb } from "../tools/usage.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/**
 * b726a987 AC5 — the cache-write 1h tier reaches the STORED cost through the real accounting
 * path: raw provider usage (the exact `result.usage` shape the claude CLI emitted in production)
 * -> `normaliseAnthropicUsage` -> real Orchestrator -> real UsagePlugin -> real migrated SQLite
 * `task_usage` + `task_events`, then re-priced by the real usage read path. Only the LLM
 * boundary (`LLMProvider.chat`) is faked; no process or network.
 */

/** Verbatim shape of the production cold-cache claudecli `result.usage` (task 8b711016). */
const PROD_RAW_USAGE = {
  input_tokens: 10,
  output_tokens: 49,
  cache_creation_input_tokens: 4670,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4670 },
};
const T0 = "2026-10-01T00:00:00.000Z";

interface IUsageRow {
  est_cost_usd: number | null;
  priced_cost_usd: number | null;
  pricing_ref: string | null;
  cost_basis: string | null;
  cost_status: string | null;
  cache_creation_input_tokens: number | null;
}

function makeDb() {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { sqlite, db };
}

async function runTask(
  db: ReturnType<typeof makeDb>["db"],
  rawUsage: Record<string, unknown>,
  model: string
): Promise<string> {
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "cache-1h-agent", version: 1, provider: { type: "claudecli", model },
    systemPrompt: "x", mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = { taskId, sessionId, agentName: "cache-1h-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db, undefined, { now: () => T0 }).install(hooks);

  const provider: LLMProvider = {
    chat: async (): Promise<ProviderChatResponse> => ({
      message: { id: generateId(), sessionId, role: "assistant", content: "ok", createdAt: nowIso() },
      stopReason: "completed",
      rawUsage,
      usage: normaliseAnthropicUsage(rawUsage as Parameters<typeof normaliseAnthropicUsage>[0], "stop", 8192),
    }),
  };
  const registry = {
    listAllTools: async () => [],
    getClient: async () => ({ callTool: async () => "ok" }),
    closeAll: async () => {},
  } as unknown as McpClientRegistry;
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const userMessage: Message = { id: generateId(), sessionId, role: "user", content: "hi", createdAt: nowIso() };
  await new Orchestrator().run({
    executionContext: ctx, messages: [userMessage], registry, provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore, signal: new AbortController().signal, taskId, hooks,
  });
  return taskId;
}

const rowOf = (sqlite: Database.Database, taskId: string): IUsageRow =>
  sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as IUsageRow;

describe("b726a987 cache-write 1h tier through the real accounting path", () => {
  it("b726a987 AC5: a cold-cache 1h write is stored at the 1h rate (0.009595), with provenance, and the event keeps the raw split", async () => {
    const { sqlite, db } = makeDb();
    const taskId = await runTask(db, PROD_RAW_USAGE, "claude-haiku-4-5");

    const row = rowOf(sqlite, taskId);
    expect(row.est_cost_usd).toBeCloseTo(0.009595, 12);
    expect(row.priced_cost_usd).toBeCloseTo(0.009595, 12);
    expect(row.cache_creation_input_tokens).toBe(4670);
    expect(row.cost_status).toBe("priced");
    expect(row.cost_basis).toBe("vendor-direct");
    expect(row.pricing_ref).toBe("rate-card:claude_haiku_4_5");

    const ev = sqlite
      .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'MODEL_RESPONSE'")
      .get(taskId) as { payload: string };
    const payload = JSON.parse(ev.payload) as { cacheCreation1hTokens?: number; rawUsage?: typeof PROD_RAW_USAGE };
    expect(payload.cacheCreation1hTokens).toBe(4670);
    expect(payload.rawUsage?.cache_creation.ephemeral_1h_input_tokens).toBe(4670);
  });

  it("b726a987 AC5: the usage read path re-prices the turn from its event at the same 1h-tier cost as the stored row", async () => {
    const { sqlite, db } = makeDb();
    const taskId = await runTask(db, PROD_RAW_USAGE, "claude-haiku-4-5");
    const stored = rowOf(sqlite, taskId).est_cost_usd;
    const res = usageQueryByGrain(db as unknown as OrchestratorDb, { include_incomplete: true, limit: 50, grain: "turn" });
    const turn = res.rows.find((r) => r.task_id === taskId);
    expect(turn?.est_cost_usd).toBeCloseTo(0.009595, 12);
    expect(turn?.est_cost_usd).toBeCloseTo(stored as number, 12);
  });

  it("b726a987 AC2: usage without a tier split (5m writes) is stored at the 5-minute rate, unchanged", async () => {
    const { sqlite, db } = makeDb();
    const { cache_creation: _split, ...unsplit } = PROD_RAW_USAGE;
    const taskId = await runTask(db, unsplit, "claude-haiku-4-5");
    expect(rowOf(sqlite, taskId).est_cost_usd).toBeCloseTo(0.0060925, 12);
  });

  it("b726a987 AC1: a price-history row carrying input_cache_write_1h in raw_json prices 1h writes at that tier", async () => {
    const { sqlite, db } = makeDb();
    new PriceHistoryStore(db).seedBundled(
      [{
        modelId: "anthropic/claude-haiku-4.5", kind: "model", inputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5,
        rawJson: JSON.stringify({ prompt: "0.000001", completion: "0.000005", input_cache_write: "0.00000125", input_cache_write_1h: "0.000002" }),
        overridesJson: null,
      }],
      "2026-09-01T00:00:00.000Z"
    );
    const taskId = await runTask(db, PROD_RAW_USAGE, "anthropic/claude-haiku-4.5");
    const row = rowOf(sqlite, taskId);
    expect(row.est_cost_usd).toBeCloseTo(0.009595, 12);
    expect(row.cost_basis).toBe("openrouter-estimate");
  });
});

describe("b726a987 normaliseAnthropicUsage 1h split", () => {
  it("b726a987 AC1: carries ephemeral_1h_input_tokens as cacheCreation1hTokens, a subset of cacheCreationTokens", () => {
    const u = normaliseAnthropicUsage(PROD_RAW_USAGE, "stop", 0);
    expect(u.cacheCreationTokens).toBe(4670);
    expect(u.cacheCreation1hTokens).toBe(4670);
    expect(u.inputTokens).toBe(4680); // total unchanged: the split is never additive
  });

  it("b726a987 AC2: omits the split when the provider reports none, and clamps a split above the write total", () => {
    const { cache_creation: _s, ...unsplit } = PROD_RAW_USAGE;
    expect("cacheCreation1hTokens" in normaliseAnthropicUsage(unsplit, "stop", 0)).toBe(false);
    const over = normaliseAnthropicUsage(
      { ...PROD_RAW_USAGE, cache_creation: { ephemeral_1h_input_tokens: 9999 } }, "stop", 0
    );
    expect(over.cacheCreation1hTokens).toBe(4670);
  });
});
