import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { HookRegistry, type ExecutionContext } from "@adhd/agent-base-types";
import {
  DEFAULT_BUDGET_PLUGIN_MODULE,
  defaultPluginEntries,
} from "../config.js";

// ── Enforcement harness (for the cumulative-across-tasks test) ────────────────
//
// Mirrors agent-plugin-budget's own test adapter: renders each drizzle `sql`
// template back to `{sql, params}` so a fake `task_usage` table can be stubbed.

function makeEnforceCtx(taskId: string): ExecutionContext {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    agentName: "test-agent",
    agentDefinition: {
      name: "test-agent",
      version: 1,
      provider: { type: "openai", model: "gpt-4o-mini" },
      systemPrompt: "",
      mcpServers: {},
      permissions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    recursionDepth: 0,
    toolCallCount: 0,
  } as ExecutionContext;
}

const dialect = new SQLiteSyncDialect();

/**
 * A fake drizzle handle whose `get` reports `priorCalls` model calls from a
 * PRIOR task in the global scope (the scope-total query carries no
 * `created_at`). Returns true from `enforceFirstModelRequest` when the first
 * `pre:model_request` enforce REJECTS (the cap fired).
 */
async function enforceFirstModelRequest(
  config: unknown,
  priorCalls: number
): Promise<{ rejected: boolean; globalQueryRan: boolean }> {
  const { createPlugin, pluginConfigSchema } = await import(
    "@adhd/agent-plugin-budget"
  );
  let globalQueryRan = false;
  const db = {
    get(query: unknown) {
      const { sql } = dialect.sqlToQuery(query as never) as { sql: string };
      if (!sql.includes("created_at")) {
        globalQueryRan = true;
        return {
          input: 0,
          output: 0,
          calls: priorCalls,
          peak: 0,
          uncached: 0,
          cache_read: 0,
          cache_write: 0,
        };
      }
      return undefined;
    },
    all() {
      return [];
    },
  };
  const plugin = createPlugin({
    db,
    config: pluginConfigSchema.parse(config),
  });
  const hooks = new HookRegistry();
  await plugin.install(hooks);

  // A BRAND-NEW task with ZERO in-memory usage — only the prior task's calls
  // are visible to a global-scope cap.
  const ctx = makeEnforceCtx("new-task");
  await hooks.emit("task:start", { executionContext: ctx, messages: [] });
  const payload = { executionContext: ctx, messages: [], tools: [] };
  try {
    await hooks.emit("pre:model_request", payload);
    await hooks.enforce("pre:model_request", payload);
    return { rejected: false, globalQueryRan };
  } catch {
    return { rejected: true, globalQueryRan };
  }
}

/**
 * Backlog 5339c2e5 — agent-mcp loads agent-plugin-budget BY DEFAULT with a
 * conservative, always-enforceable cap, so an unattended dispatch run stops at
 * a spend limit without any operator-authored config file.
 *
 * These assertions FAIL if the default entry is removed (test 1) or the opt-out
 * / env caps stop being honoured.
 */
describe("defaultPluginEntries — default-on budget plugin (5339c2e5)", () => {
  it("returns the budget plugin by default, with a conservative call cap", () => {
    const entries = defaultPluginEntries({} as NodeJS.ProcessEnv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.module).toBe(DEFAULT_BUDGET_PLUGIN_MODULE);
    const defaults = entries[0]?.config["defaults"] as {
      mode?: string;
      caps?: Array<{ field: string; maximum: number }>;
    };
    expect(defaults.mode).toBe("block");
    expect(defaults.caps).toContainEqual({ field: "calls", maximum: 500 });
  });

  it("honours ADHD_AGENT_BUDGET_MAX_CALLS", () => {
    const entries = defaultPluginEntries({
      ADHD_AGENT_BUDGET_MAX_CALLS: "7",
    } as unknown as NodeJS.ProcessEnv);
    const defaults = entries[0]?.config["defaults"] as {
      caps?: Array<{ field: string; maximum: number }>;
    };
    expect(defaults.caps).toContainEqual({ field: "calls", maximum: 7 });
  });

  it("adds an enforceable cost cap when ADHD_AGENT_BUDGET_COST_USD is set", () => {
    const entries = defaultPluginEntries({
      ADHD_AGENT_BUDGET_COST_USD: "0.01",
    } as unknown as NodeJS.ProcessEnv);
    const defaults = entries[0]?.config["defaults"] as {
      caps?: Array<{ field: string; maximum: number }>;
      costPerInputToken?: number;
      costPerOutputToken?: number;
    };
    expect(defaults.caps).toContainEqual({ field: "cost", maximum: 0.01 });
    // Rates must be present, otherwise the plugin computes cost 0 and the cap
    // could never fire — this is the "enforceable" half of the DoD.
    expect(defaults.costPerInputToken).toBeGreaterThan(0);
    expect(defaults.costPerOutputToken).toBeGreaterThan(0);
  });

  it("the default caps resolve to GLOBAL scope (post-merge review: top-level scope was dropped)", async () => {
    // agent-plugin-budget is a lazy-loaded library from agent-mcp's perspective
    // (loader.ts imports it dynamically) — mirror that with a dynamic import.
    const { createPlugin, pluginConfigSchema } = await import(
      "@adhd/agent-plugin-budget"
    );
    const config = defaultPluginEntries({} as NodeJS.ProcessEnv)[0]?.config;
    expect(config).toBeDefined();

    // `scope` must live inside `defaults` — `pluginConfigSchema` has no
    // top-level `scope` key, so a root-level one is silently discarded and the
    // caps fall back to per-task scope.
    expect((config as Record<string, unknown>)["scope"]).toBeUndefined();

    const parsed = pluginConfigSchema.parse(config);
    expect(parsed.defaults?.scope).toBe("global");

    // The plugin's real create/normalize path accepts the config unchanged.
    expect(() =>
      createPlugin({ db: null, config: config as Record<string, unknown> })
    ).not.toThrow();
  });

  it("enforces the default cap cumulatively ACROSS tasks — a new task halts on a prior task's spend (5339c2e5 AC1)", async () => {
    // The ACTUAL default config agent-mcp loads (max calls = 2 for this test).
    const config = defaultPluginEntries({
      ADHD_AGENT_BUDGET_MAX_CALLS: "2",
    } as unknown as NodeJS.ProcessEnv)[0]?.config;
    // A prior task already spent the whole cap; the new task has zero usage.
    const { rejected, globalQueryRan } = await enforceFirstModelRequest(
      config,
      2
    );
    // The scope-total (global) query RAN and the cap fired — per-task scope
    // would see 0 calls and pass.
    expect(globalQueryRan).toBe(true);
    expect(rejected).toBe(true);
  });

  it("NEGATIVE CONTROL: the pre-fix top-level `scope` is dropped, so the same setup is per-task and does NOT halt (5339c2e5 AC2)", async () => {
    // The PRE-FIX default shape: `scope` at the config ROOT (not in `defaults`).
    // `pluginConfigSchema` has no top-level `scope`, so zod strips it and the
    // caps resolve per-task — the cumulative-halt test above would go red.
    const preFixConfig = {
      scope: "global",
      defaults: { mode: "block", caps: [{ field: "calls", maximum: 2 }] },
    };
    const { rejected, globalQueryRan } = await enforceFirstModelRequest(
      preFixConfig,
      2
    );
    // Per-task scope never queries the global total and never fires (0 < 2).
    expect(globalQueryRan).toBe(false);
    expect(rejected).toBe(false);
  });

  it("is opt-OUT via ADHD_AGENT_DISABLE_BUDGET_PLUGIN=1", () => {
    expect(
      defaultPluginEntries({
        ADHD_AGENT_DISABLE_BUDGET_PLUGIN: "1",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual([]);
    expect(
      defaultPluginEntries({
        ADHD_AGENT_DISABLE_BUDGET_PLUGIN: "true",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual([]);
  });
});
