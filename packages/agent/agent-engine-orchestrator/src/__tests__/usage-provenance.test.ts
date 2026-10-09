import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { PriceHistoryStore, TaskStore, modelPriceHistoryTable } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineLogger } from "../interfaces.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/**
 * 1f1c8598 / 37f6c511 segment S4a — the UsagePlugin WRITE path for cost provenance.
 *
 * Real Orchestrator + real HookRegistry + real UsagePlugin + real SQLite built from the shipped
 * migrations (so `task_usage` and `model_price_history` are the production schema). The only
 * faked boundary is the LLM provider (`LLMProvider.chat`). Pricing instants come from the plugin's
 * injected `now()` so as-of behavior is deterministic without sleeping.
 */

const OR_ID = "deepseek/deepseek-v4.1-flash";
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";

interface ITurn {
  inputTokens: number;
  outputTokens: number;
  responseModel?: string;
  /** Instant the plugin prices this turn at. */
  at: string;
}

function makeDb() {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { sqlite, db, history: new PriceHistoryStore(db) };
}

function ctxFor(taskId: string, model: string, providerType: "anthropic" | "openai"): ExecutionContext {
  const agentDefinition: AgentDefinition = {
    name: "provenance-agent",
    version: 1,
    provider: { type: providerType, model },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return { taskId, sessionId: generateId(), agentName: "provenance-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
}

function recordingLogger() {
  const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
  const logger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (ctx: Record<string, unknown>, msg: string) => warns.push({ ctx, msg }),
  } as unknown as EngineLogger;
  return { logger, warns };
}

/** Index into a fixture array, failing loudly (instead of a non-null assertion) when the index is out of range. */
function required<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, array has ${items.length}`);
  }
  return item;
}

/** Drives `turns.length` model calls (all but the last request a tool) through the real engine. */
async function runTask(opts: {
  db: ReturnType<typeof makeDb>["db"];
  plugin: UsagePlugin;
  model: string;
  providerType?: "anthropic" | "openai";
  turns: ITurn[];
  setNow: (at: string) => void;
  taskId?: string;
}): Promise<string> {
  const taskId = opts.taskId ?? generateId();
  const ctx = ctxFor(taskId, opts.model, opts.providerType ?? "openai");
  const taskStore = new TaskStore(opts.db);
  taskStore.create({ sessionId: ctx.sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  opts.plugin.install(hooks);

  let i = 0;
  const provider: LLMProvider = {
    chat: async (): Promise<ProviderChatResponse> => {
      const turn = required(opts.turns, i++);
      opts.setNow(turn.at);
      const last = i === opts.turns.length;
      return {
        message: {
          id: generateId(),
          sessionId: ctx.sessionId,
          role: "assistant",
          ...(last ? { content: "done" } : { toolCalls: [{ id: generateId(), server: "s", tool: "echo", arguments: {} }] }),
          createdAt: nowIso(),
        },
        stopReason: last ? "completed" : "tool_calls",
        // Real providers normalise usage into the uncached/cache split; cost is priced from it.
        usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, uncachedInputTokens: turn.inputTokens },
        ...(turn.responseModel !== undefined ? { responseModel: turn.responseModel } : {}),
      };
    },
  };
  const registry = {
    listAllTools: async () => [{ name: "s__echo", description: "", inputSchema: { type: "object", properties: {} } }],
    getClient: async () => ({ callTool: async () => "ok" }),
    closeAll: async () => {},
  } as unknown as McpClientRegistry;
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const userMessage: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "hi", createdAt: nowIso() };
  await new Orchestrator().run({
    executionContext: ctx,
    messages: [userMessage],
    registry,
    provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId,
    hooks,
  });
  return taskId;
}

interface IUsageRow {
  model: string;
  response_model: string | null;
  cost_basis: string | null;
  pricing_ref: string | null;
  cost_status: string | null;
  priced_cost_usd: number | null;
  unpriced_tokens: number | null;
  est_cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  uncached_input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

function rowOf(sqlite: Database.Database, taskId: string): IUsageRow {
  return sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as IUsageRow;
}

function seedPrice(
  history: PriceHistoryStore,
  at: string,
  rates: { inputPerM: number; outputPerM: number },
  modelId = OR_ID
): void {
  history.seedBundled(
    [{ modelId, kind: "model", inputPerM: rates.inputPerM, cacheReadPerM: null, cacheWritePerM: null, outputPerM: rates.outputPerM, rawJson: "{}", overridesJson: null }],
    at
  );
}

/** A plugin whose pricing instant is whatever `setNow` last set, over the real price history. */
function makePlugin(db: ReturnType<typeof makeDb>["db"], logger?: EngineLogger) {
  let current = T0;
  const plugin = new UsagePlugin(db, logger, { now: () => current });
  return { plugin, setNow: (at: string) => { current = at; } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsagePlugin cost provenance write path", () => {
  it("1f1c8598 FS1-AC1: task_usage.response_model records the provider-reported model while model stays the configured alias", async () => {
    const { sqlite, db } = makeDb();
    const { plugin, setNow } = makePlugin(db);
    const taskId = await runTask({
      db, plugin, setNow, model: "deepseek-flash",
      turns: [
        { inputTokens: 100, outputTokens: 10, responseModel: "deepseek-v4-flash-0731", at: T0 },
        // A later turn that reports no model must not erase the captured one.
        { inputTokens: 100, outputTokens: 10, at: T0 },
      ],
    });
    const row = rowOf(sqlite, taskId);
    expect(row.response_model).toBe("deepseek-v4-flash-0731");
    expect(row.model).toBe("deepseek-flash");
  });

  it("1f1c8598 FS1-AC1: response_model is NULL when the provider never reports one", async () => {
    const { sqlite, db } = makeDb();
    const { plugin, setNow } = makePlugin(db);
    const taskId = await runTask({ db, plugin, setNow, model: "deepseek-flash", turns: [{ inputTokens: 5, outputTokens: 1, at: T0 }] });
    expect(rowOf(sqlite, taskId).response_model).toBeNull();
  });

  it("1f1c8598 FS1-AC2: pricing_ref names the history record and recomputing from its rates reproduces est_cost_usd", async () => {
    const { sqlite, db, history } = makeDb();
    seedPrice(history, T0, { inputPerM: 0.2, outputPerM: 1.0 });
    const { plugin, setNow } = makePlugin(db);
    const taskId = await runTask({
      db, plugin, setNow, model: "deepseek-flash",
      turns: [
        { inputTokens: 1000, outputTokens: 500, at: T1 },
        { inputTokens: 3000, outputTokens: 200, at: T1 },
      ],
    });
    const row = rowOf(sqlite, taskId);
    const rec = sqlite
      .prepare("SELECT id, input_per_m, cache_read_per_m, cache_write_per_m, output_per_m FROM model_price_history WHERE id = ?")
      .get(row.pricing_ref) as { id: string; input_per_m: number; cache_read_per_m: number | null; cache_write_per_m: number | null; output_per_m: number };
    expect(rec).toBeDefined();
    expect(row.cost_basis).toBe("owner-assumption");
    expect(row.cost_status).toBe("priced");
    const uncached = row.uncached_input_tokens ?? row.input_tokens;
    const recomputed =
      (uncached * rec.input_per_m +
        (row.cache_read_tokens ?? 0) * (rec.cache_read_per_m ?? rec.input_per_m) +
        (row.cache_creation_tokens ?? 0) * (rec.cache_write_per_m ?? 0) +
        row.output_tokens * rec.output_per_m) / 1e6;
    expect(row.est_cost_usd).not.toBeNull();
    expect(Math.abs((row.est_cost_usd as number) - recomputed)).toBeLessThan(1e-12);
    expect(row.priced_cost_usd).toBeCloseTo(row.est_cost_usd as number, 12);
    expect(row.unpriced_tokens).toBe(0);
  });

  it("1f1c8598 FS1-AC2: a model resolved from the bundled snapshot (empty history) points at a bundled: ref; vendor-direct models point at rate-card:", async () => {
    const { sqlite, db } = makeDb();
    const { plugin, setNow } = makePlugin(db);
    const aliasTask = await runTask({ db, plugin, setNow, model: "deepseek-flash", turns: [{ inputTokens: 10, outputTokens: 1, at: T0 }] });
    const vendorTask = await runTask({ db, plugin, setNow, model: "deepseek-v4-flash", turns: [{ inputTokens: 10, outputTokens: 1, at: T0 }] });
    const alias = rowOf(sqlite, aliasTask);
    expect(alias.pricing_ref).toMatch(new RegExp(`^bundled:.*:${OR_ID.replace(".", "\\.")}$`));
    expect(alias.cost_basis).toBe("owner-assumption");
    expect(alias.cost_status).toBe("priced");
    const vendor = rowOf(sqlite, vendorTask);
    expect(vendor.pricing_ref).toBe("rate-card:deepseek-v4-flash");
    expect(vendor.cost_basis).toBe("vendor-direct");
    expect(vendor.est_cost_usd).not.toBeNull();
  });

  it("1f1c8598 FS1-AC3: an unpriced model writes est_cost_usd NULL + cost_status unpriced_model and warns exactly once per model across turns and tasks", async () => {
    const { sqlite, db } = makeDb();
    const { logger, warns } = recordingLogger();
    const { plugin, setNow } = makePlugin(db, logger);
    const taskA = await runTask({
      db, plugin, setNow, model: "mystery-model-9000", providerType: "anthropic",
      turns: [
        { inputTokens: 100, outputTokens: 10, responseModel: "mystery-9000-x", at: T0 },
        { inputTokens: 200, outputTokens: 20, at: T0 },
      ],
    });
    const a = rowOf(sqlite, taskA);
    expect(a.est_cost_usd).toBeNull();
    expect(a.cost_status).toBe("unpriced_model");
    expect(a.cost_basis).toBeNull();
    expect(a.pricing_ref).toBeNull();
    expect(a.priced_cost_usd).toBe(0);
    expect(a.unpriced_tokens).toBe(330);
    expect(warns).toHaveLength(1);
    expect(required(warns, 0).ctx).toMatchObject({ model: "mystery-model-9000", responseModel: "mystery-9000-x" });

    // A second task on the same model stays quiet; a different unpriced model warns again.
    await runTask({ db, plugin, setNow, model: "mystery-model-9000", providerType: "anthropic", turns: [{ inputTokens: 1, outputTokens: 1, at: T0 }] });
    expect(warns).toHaveLength(1);
    await runTask({ db, plugin, setNow, model: "other-mystery", providerType: "anthropic", turns: [{ inputTokens: 1, outputTokens: 1, at: T0 }] });
    expect(warns).toHaveLength(2);
    expect(required(warns, 1).ctx).toMatchObject({ model: "other-mystery" });
  });

  it("1f1c8598 FS1-AC3: with no logger supplied the unpriced warning is still emitted (never swallowed by a silent default)", async () => {
    const { db } = makeDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setNowHolder = { at: T0 };
    const plugin = new UsagePlugin(db, undefined, { now: () => setNowHolder.at });
    await runTask({ db, plugin, setNow: (at) => { setNowHolder.at = at; }, model: "mystery-model-9000", providerType: "anthropic", turns: [{ inputTokens: 1, outputTokens: 1, at: T0 }] });
    await runTask({ db, plugin, setNow: () => {}, model: "mystery-model-9000", providerType: "anthropic", turns: [{ inputTokens: 1, outputTokens: 1, at: T0 }] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("1f1c8598 FS1-AC5: a priced turn followed by an unpriced turn yields cost_status partial, est_cost_usd NULL, priced_cost_usd = the priced portion", async () => {
    const { sqlite, db, history } = makeDb();
    seedPrice(history, T0, { inputPerM: 0.2, outputPerM: 1.0 });
    // The price source later reports the model as a router (unpriceable) — a real unpriced turn
    // after a priced one within the same task.
    db.insert(modelPriceHistoryTable)
      .values({ id: generateId(), modelId: OR_ID, observedAt: T2, source: "openrouter-live", kind: "router", inputPerM: null, cacheReadPerM: null, cacheWritePerM: null, outputPerM: null, rawJson: "{}", overridesJson: null, ledgerId: null })
      .run();
    const { logger, warns } = recordingLogger();
    const { plugin, setNow } = makePlugin(db, logger);
    const taskId = await runTask({
      db, plugin, setNow, model: "deepseek-flash",
      turns: [
        { inputTokens: 1000, outputTokens: 500, at: T1 },
        { inputTokens: 700, outputTokens: 30, at: new Date(Date.parse(T2) + 1000).toISOString() },
      ],
    });
    const row = rowOf(sqlite, taskId);
    expect(row.cost_status).toBe("partial");
    expect(row.est_cost_usd).toBeNull();
    expect(row.priced_cost_usd).toBeCloseTo((1000 * 0.2 + 500 * 1.0) / 1e6, 12);
    expect(row.unpriced_tokens).toBe(730);
    // basis + ref keep describing the last PRICED turn.
    expect(row.cost_basis).toBe("owner-assumption");
    expect(row.pricing_ref).not.toBeNull();
    expect(warns).toHaveLength(1);
  });

  it("1f1c8598 FS1-AC5: a task whose turns are all priced stays cost_status priced with additive est_cost_usd", async () => {
    const { sqlite, db } = makeDb();
    const { plugin, setNow } = makePlugin(db);
    const taskId = await runTask({
      db, plugin, setNow, model: "deepseek-v4-flash",
      turns: [
        { inputTokens: 1_000_000, outputTokens: 0, at: T0 },
        { inputTokens: 1_000_000, outputTokens: 0, at: T0 },
        { inputTokens: 0, outputTokens: 1_000_000, at: T0 },
      ],
    });
    const row = rowOf(sqlite, taskId);
    expect(row.cost_status).toBe("priced");
    expect(row.unpriced_tokens).toBe(0);
    expect(row.est_cost_usd).toBeCloseTo(0.14 + 0.14 + 0.28, 9);
    expect(row.priced_cost_usd).toBeCloseTo(row.est_cost_usd as number, 12);
  });

  it("37f6c511 FS3-AC5: a newer price row prices later turns at the new rate while an already-stored task's est_cost_usd is byte-identical", async () => {
    const { sqlite, db, history } = makeDb();
    seedPrice(history, T0, { inputPerM: 0.2, outputPerM: 1.0 });
    const { plugin, setNow } = makePlugin(db);
    const turns = (at: string): ITurn[] => [{ inputTokens: 1_000_000, outputTokens: 1_000_000, at }];

    const before = await runTask({ db, plugin, setNow, model: "deepseek-flash", turns: turns(T1) });
    const beforeCost = rowOf(sqlite, before).est_cost_usd;
    expect(beforeCost).toBeCloseTo(0.2 + 1.0, 9);
    const beforeRef = rowOf(sqlite, before).pricing_ref;

    // The price changes (append-only: a NEW observation, never an update).
    seedPrice(history, T2, { inputPerM: 0.5, outputPerM: 4.0 });

    const after = await runTask({ db, plugin, setNow, model: "deepseek-flash", turns: turns(new Date(Date.parse(T2) + 1000).toISOString()) });
    const afterRow = rowOf(sqlite, after);
    expect(afterRow.est_cost_usd).toBeCloseTo(0.5 + 4.0, 9);
    expect(afterRow.pricing_ref).not.toBe(beforeRef);

    // Same call again for the stored task: nothing was re-priced.
    const stored = rowOf(sqlite, before);
    expect(stored.est_cost_usd).toBe(beforeCost);
    expect(stored.pricing_ref).toBe(beforeRef);
  });

  it("1f1c8598 FS1-AC3: legacy-compatible shape — priced rows leave unpriced_tokens 0 and never warn", async () => {
    const { db } = makeDb();
    const { logger, warns } = recordingLogger();
    const { plugin, setNow } = makePlugin(db, logger);
    await runTask({ db, plugin, setNow, model: "deepseek-v4-flash", turns: [{ inputTokens: 10, outputTokens: 1, at: T0 }] });
    expect(warns).toHaveLength(0);
  });
});
