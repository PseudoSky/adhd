/**
 * cf7e0e5c-1b2b-4ee1-a3e2-dcc4a65043dd AC2 / AC3 / AC8 (plan ce473fa3, bucket B1) --
 * real-component proof that the host's `ADHD_AGENT_BUDGET_COST_USD` cap prices a
 * run from the same rate card `usage_query` reports from.
 *
 * Wires, with NO mocks of the things under test:
 *   - the real host config (`defaultPluginEntries` with ADHD_AGENT_BUDGET_COST_USD),
 *   - the real `BudgetPlugin` loaded through its public `createPlugin` factory,
 *   - the real engine `UsagePlugin` (the write path behind `usage_query`),
 *   - a real in-memory sqlite built through the shipped drizzle migrations,
 *   - a real `HookRegistry`.
 * The only scripted boundary is the LLM: each turn is the `post:model_response`
 * payload a provider emits (cache-warm DeepSeek: ~99% of input is cache-read).
 *
 * Deterministic: no timers, no sleeps, no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HookRegistry, type ExecutionContext } from "@adhd/agent-base-types";
import { estimateCost } from "@adhd/agent-core-provider";
import { UsagePlugin } from "@adhd/agent-engine-orchestrator";
import * as schema from "@adhd/agent-store-runtime";
import { defaultPluginEntries } from "../config.js";

const TICKET = "cf7e0e5c-1b2b-4ee1-a3e2-dcc4a65043dd";
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const DEEPSEEK = "deepseek-v4-flash";
const SONNET = "claude-sonnet-4-6";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  open.push(sqlite);
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { sqlite, db };
}

function ctxFor(
  taskId: string,
  providerType: "openai" | "anthropic",
  model: string
): ExecutionContext {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    agentName: "ratecard-agent",
    agentDefinition: {
      name: "ratecard-agent",
      version: 1,
      systemPrompt: "",
      mcpServers: {},
      permissions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    selection: { providerType, modelRef: model },
    wireModel: model,
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

interface Turn {
  uncached: number;
  cacheRead: number;
  output: number;
}

async function boot(budgetConfig: unknown) {
  const { sqlite, db } = makeDb();
  const { createPlugin, pluginConfigSchema } = await import("@adhd/agent-plugin-budget");
  const hooks = new HookRegistry();
  // Same install order the host uses: usage (write path) then budget.
  new UsagePlugin(db).install(hooks);
  await createPlugin({
    db,
    config: pluginConfigSchema.parse(budgetConfig),
  }).install(hooks);
  let blockedAt: number | undefined;
  hooks.register("budget:block", (p) => {
    blockedAt = p.current;
  });
  return {
    sqlite,
    hooks,
    blocked: () => blockedAt,
    /** Run turns until the cost cap rejects a model request; returns completed turns. */
    async runUntilTripped(ctx: ExecutionContext, turn: Turn, max = 80) {
      await hooks.emit("task:start", { executionContext: ctx, messages: [] });
      let done = 0;
      for (; done < max; done += 1) {
        const req = { executionContext: ctx, messages: [], tools: [] };
        await hooks.emit("pre:model_request", req);
        try {
          await hooks.enforce("pre:model_request", req);
        } catch {
          break;
        }
        await hooks.emit("post:model_response", {
          executionContext: ctx,
          stopReason: "stop",
          toolCallCount: 0,
          tokenUsage: {
            inputTokens: turn.uncached + turn.cacheRead,
            outputTokens: turn.output,
            uncachedInputTokens: turn.uncached,
            cacheReadTokens: turn.cacheRead,
            cacheCreationTokens: 0,
          },
          computeMs: 1,
        });
      }
      await hooks.emit("task:completed", { executionContext: ctx } as never);
      return done;
    },
  };
}

function persistedCost(sqlite: Database.Database, taskId: string): number | null {
  const row = sqlite
    .prepare("SELECT est_cost_usd AS c FROM task_usage WHERE task_id = ?")
    .get(taskId) as { c: number | null } | undefined;
  return row?.c ?? null;
}

const warm: Turn = { uncached: 1_000, cacheRead: 99_000, output: 500 };
const perTurn = estimateCost(
  DEEPSEEK,
  {
    uncachedInputTokens: warm.uncached,
    cacheReadTokens: warm.cacheRead,
    cacheCreationTokens: 0,
    outputTokens: warm.output,
  },
  {}
).costUsd as number;

describe(`${TICKET} AC2/AC3/AC8 -- host cost cap == usage_query est_cost on a cache-warm DeepSeek run`, () => {
  const hostConfig = () =>
    defaultPluginEntries({
      ADHD_AGENT_BUDGET_COST_USD: "0.01",
    } as unknown as NodeJS.ProcessEnv)[0]?.config;

  it("AC3: the cap does NOT trip at the Sonnet-flat-rate point and DOES trip at the rate-card point", async () => {
    const stack = await boot(hostConfig());
    const turns = await stack.runUntilTripped(ctxFor("ds-1", "openai", DEEPSEEK), warm);
    // Rate-card point: the first request after cumulative spend exceeds $0.01.
    expect(turns).toBe(Math.floor(0.01 / perTurn) + 1);
    // The Sonnet-flat point (100k input @ $3/M = $0.30/turn) is turn 1: passed.
    expect(turns).toBeGreaterThan(1);
  });

  it("AC2: the spend the cap tripped on equals the est_cost_usd the usage plugin persisted (what usage_query reports), to 1e-9", async () => {
    const stack = await boot(hostConfig());
    const turns = await stack.runUntilTripped(ctxFor("ds-2", "openai", DEEPSEEK), warm);
    const persisted = persistedCost(stack.sqlite, "ds-2");
    expect(persisted).not.toBeNull();
    expect(Math.abs((persisted as number) - turns * perTurn)).toBeLessThan(1e-9);
    // `budget:block` reports the SCOPED (global) cost: persisted other tasks (none)
    // plus this task's in-memory share == the persisted total.
    expect(stack.blocked()).toBeDefined();
    expect(Math.abs((stack.blocked() as number) - (persisted as number))).toBeLessThan(1e-9);
  });

  it("AC3 control: the pre-change host config (flat $3/$15) trips on turn 2, ~17 turns early", async () => {
    const legacy = {
      defaults: {
        mode: "block",
        scope: "global",
        caps: [{ field: "cost", maximum: 0.01 }],
        costPerInputToken: 0.000003,
        costPerOutputToken: 0.000015,
      },
    };
    const stack = await boot(legacy);
    const turns = await stack.runUntilTripped(ctxFor("ds-3", "openai", DEEPSEEK), warm);
    expect(turns).toBe(1);
  });

  it("a Sonnet run trips at the same point as the flat rates did (no cache => rate card == $3/$15)", async () => {
    const turn: Turn = { uncached: 10_000, cacheRead: 0, output: 1_000 };
    const cfg = (extra: Record<string, unknown>) => ({
      ...extra,
      defaults: {
        mode: "block",
        scope: "global",
        caps: [{ field: "cost", maximum: 0.1 }],
        ...(extra["flat"] ? { costPerInputToken: 0.000003, costPerOutputToken: 0.000015 } : {}),
      },
    });
    const card = await boot(cfg({ pricing: "rate-card" }));
    const flat = await boot(cfg({ flat: true }));
    const cardTurns = await card.runUntilTripped(ctxFor("s-1", "anthropic", SONNET), turn);
    const flatTurns = await flat.runUntilTripped(ctxFor("s-1", "anthropic", SONNET), turn);
    expect(cardTurns).toBe(flatTurns);
    expect(cardTurns).toBe(3);
  });

  it("cross-task: task B is halted by task A's persisted rate-card spend (scope:'global')", async () => {
    const stack = await boot(hostConfig());
    const aTurns = await stack.runUntilTripped(ctxFor("ds-a", "openai", DEEPSEEK), warm);
    expect(aTurns).toBeGreaterThan(1);
    const ctxB = ctxFor("ds-b", "openai", DEEPSEEK);
    await stack.hooks.emit("task:start", { executionContext: ctxB, messages: [] });
    const req = { executionContext: ctxB, messages: [], tools: [] };
    await stack.hooks.emit("pre:model_request", req);
    await expect(stack.hooks.enforce("pre:model_request", req)).rejects.toMatchObject({
      isEnforcementError: true,
      code: "BUDGET_EXCEEDED",
    });
  });
});
