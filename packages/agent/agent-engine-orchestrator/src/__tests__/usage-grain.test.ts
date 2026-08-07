import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { usageQueryByGrain, type Database as OrchestratorDb } from "../tools/usage.js";

/**
 * DEBT-AGENTMCP-ACCOUNTING-001 (DESIGN.md §2-§4) — proves `usageQueryByGrain` against
 * REAL Orchestrator + REAL HookRegistry + REAL UsagePlugin + REAL (in-memory)
 * better-sqlite3, driving the same code path `usage_query` uses via the MCP server —
 * only the LLM provider SDK boundary is mocked (same seam every other orchestrator test
 * in this package treats as the boundary). Timing is deterministic via a mocked,
 * explicitly-advanced `Date.now()` — never a real sleep/wall-clock race (AGENTS.md §7).
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

CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
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

function makeTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_TABLES_SQL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { sqlite, db: db as OrchestratorDb };
}

function makeAgentDefinition(model: string): AgentDefinition {
  return {
    name: "grain-test-agent",
    version: 1,
    provider: { type: "anthropic", model },
    systemPrompt: "You are a test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function makeCtx(taskId: string, sessionId: string, model: string): ExecutionContext {
  return {
    taskId,
    sessionId,
    agentName: "grain-test-agent",
    agentDefinition: makeAgentDefinition(model),
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

function makeUserMessage(sessionId: string): Message {
  return {
    id: generateId(),
    sessionId,
    role: "user",
    content: "hello",
    createdAt: nowIso(),
  };
}

const policy = { check: () => { /* no-op: test stub — policy always permits */ } } as unknown as PolicyEngine;
const sessionStore: OrchestratorSessionStore = {
  appendMessage: async () => { /* no-op: test stub */ },
  close: () => { /* no-op: test stub */ },
};

const emptyRegistry = {
  listAllTools: async () => [],
  closeAll: async () => { /* no-op: test stub */ },
  getClient: async () => {
    throw new Error("test stub: getClient must not be reached (no tool calls expected)");
  },
} as unknown as McpClientRegistry;

function makeToolRegistry(toolResult: unknown): McpClientRegistry {
  return {
    listAllTools: async () => [
      { name: "test-server__echo", description: "", inputSchema: { type: "object", properties: {} } },
    ],
    getClient: async () => ({
      callTool: async () => toolResult,
    }),
    closeAll: async () => { /* no-op: test stub */ },
  } as unknown as McpClientRegistry;
}

/** Runs the real Orchestrator with a real TaskStore + real UsagePlugin wired via a real HookRegistry. */
async function runTask(opts: {
  db: OrchestratorDb;
  ctx: ExecutionContext;
  provider: LLMProvider;
  registry: McpClientRegistry;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskStore = new TaskStore(opts.db as any);
  taskStore.create({ sessionId: opts.ctx.sessionId, prompt: "test prompt", id: opts.ctx.taskId });

  const hooks = new HookRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usagePlugin = new UsagePlugin(opts.db as any);
  usagePlugin.install(hooks);

  await new Orchestrator().run({
    executionContext: opts.ctx,
    messages: [makeUserMessage(opts.ctx.sessionId)],
    registry: opts.registry,
    provider: opts.provider,
    policy,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: opts.ctx.taskId,
    hooks,
  });

  taskStore.updateStatus(opts.ctx.taskId, "completed", {
    result: "done",
    completedAt: nowIso(),
  });
}

function oneShotProvider(usage: {
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): LLMProvider {
  return {
    chat: async (): Promise<ProviderChatResponse> => ({
      message: {
        id: generateId(),
        sessionId: generateId(),
        role: "assistant",
        content: "done",
        createdAt: nowIso(),
      },
      stopReason: "completed",
      usage,
    }),
  };
}

describe("usageQueryByGrain — task/session/turn (DEBT-AGENTMCP-ACCOUNTING-001, DESIGN.md §2-§4)", () => {
  const START = 1_700_000_000_000;
  let clock = START;

  // `nowIso()` (used by TaskStore for tasks.created_at/completed_at) calls `new
  // Date()`, which `vi.spyOn(Date, "now")` does NOT intercept — only literal
  // `Date.now()` calls are. Fake timers intercept both, so task/session-level
  // timestamps and turn-level `Date.now()`-based `compute_ms` are equally
  // deterministic under the same clock.
  beforeEach(() => {
    clock = START;
    vi.useFakeTimers();
    vi.setSystemTime(clock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advanceClock(ms: number): void {
    clock += ms;
    vi.setSystemTime(clock);
  }

  describe("grain: 'task' (default)", () => {
    it("flattens task_usage onto the snake_case row shape and echoes grain='task'", async () => {
      const { db } = makeTestDb();
      const sessionId = generateId();
      const taskId = generateId();
      const ctx = makeCtx(taskId, sessionId, "claude_sonnet_4_6");

      advanceClock(75);
      await runTask({
        db,
        ctx,
        provider: oneShotProvider({
          inputTokens: 3500,
          outputTokens: 300,
          uncachedInputTokens: 1000,
          cacheReadTokens: 2000,
          cacheCreationTokens: 500,
        }),
        registry: emptyRegistry,
      });

      const res = usageQueryByGrain(db, { include_incomplete: true, grain: "task" });
      expect(res.grain).toBe("task");
      expect(res.rows).toHaveLength(1);
      const row = res.rows[0];
      expect(row.session_id).toBe(sessionId);
      expect(row.task_id).toBe(taskId);
      expect(row.call_index).toBeNull();
      expect(row.input_tokens).toBe(3500);
      expect(row.output_tokens).toBe(300);
      expect(row.uncached_input_tokens).toBe(1000);
      expect(row.cache_read_tokens).toBe(2000);
      expect(row.cache_creation_tokens).toBe(500);
      expect(row.model_calls).toBe(1);
      expect(row.context_size).toBe(3500);
      expect(row.context_size_at).toEqual({ task_id: taskId, call_index: 1 });
      // claude_sonnet_4_6: (1000*3.00 + 2000*0.30 + 500*3.75 + 300*15.00) / 1e6 = 0.009975
      expect(row.est_cost_usd).toBeCloseTo(0.009975, 9);

      expect(res.summary.row_count).toBe(1);
      expect(res.summary.input_tokens).toBe(3500);
      expect(res.summary.context_size).toBe(3500);
      expect(res.summary.context_size_at).toEqual({ task_id: taskId, call_index: 1 });
    });
  });

  describe("grain: 'session'", () => {
    it("sums two tasks in the same session, MAXes context_size pointing at the right task, and spans total_ms across both", async () => {
      const { db } = makeTestDb();
      const sessionId = generateId();

      const task1 = generateId();
      await runTask({
        db,
        ctx: makeCtx(task1, sessionId, "claude_sonnet_4_6"),
        provider: oneShotProvider({ inputTokens: 1000, outputTokens: 100 }),
        registry: emptyRegistry,
      });
      // task1 spans [START, START] (instantaneous in this harness) — advance the
      // clock before task2 so the tasks have distinct, orderable timestamps.
      advanceClock(10_000); // +10s
      const task2 = generateId();
      await runTask({
        db,
        ctx: makeCtx(task2, sessionId, "claude_sonnet_4_6"),
        // Higher input_tokens than task1 — must win the session's context_size MAX.
        provider: oneShotProvider({ inputTokens: 9000, outputTokens: 50 }),
        registry: emptyRegistry,
      });

      const res = usageQueryByGrain(db, { include_incomplete: true, grain: "session" });
      expect(res.grain).toBe("session");
      expect(res.rows).toHaveLength(1);
      const row = res.rows[0];
      expect(row.session_id).toBe(sessionId);
      // Session grain has no single task/agent/model identity.
      expect(row.task_id).toBeNull();
      expect(row.call_index).toBeNull();
      // Σ over both tasks.
      expect(row.input_tokens).toBe(1000 + 9000);
      expect(row.output_tokens).toBe(100 + 50);
      expect(row.model_calls).toBe(2);
      // MAX across tasks, pointing at task2 (the one that produced it) — not a sum.
      expect(row.context_size).toBe(9000);
      expect(row.context_size_at).toEqual({ task_id: task2, call_index: 1 });
      expect(row.is_complete).toBe(true);
      // Real elapsed span across both tasks' created_at/completed_at — must be >= the
      // 10s gap this test explicitly introduced, not the (undercounting) sum of each
      // task's own trivial (0ms in this harness) wall-clock span.
      expect(row.total_ms).toBeGreaterThanOrEqual(10_000);

      expect(res.summary.row_count).toBe(1);
      expect(res.summary.input_tokens).toBe(10_000);
      expect(res.summary.context_size).toBe(9000);
    });

    it("a task with no session_id (defensive — should not occur post session-id fix) is excluded from session grain", async () => {
      const { db, sqlite } = makeTestDb();
      const taskId = generateId();
      const ctx = makeCtx(taskId, generateId(), "claude_sonnet_4_6");
      await runTask({ db, ctx, provider: oneShotProvider({ inputTokens: 100, outputTokens: 10 }), registry: emptyRegistry });

      // Force session_id to NULL directly, simulating data that predates the
      // ephemeral-session-id fix (commit 76de942d, DESIGN.md §0).
      sqlite.prepare("UPDATE tasks SET session_id = NULL WHERE id = ?").run(taskId);

      const res = usageQueryByGrain(db, { include_incomplete: true, grain: "session" });
      expect(res.rows).toHaveLength(0);
      expect(res.summary.row_count).toBe(0);
    });
  });

  describe("grain: 'turn' — base unit, reconciles against task_usage cumulative rollups", () => {
    it("one row per MODEL_RESPONSE with 1-based call_index, and Σ turn fields equal task_usage's cumulative rollups", async () => {
      const { db } = makeTestDb();
      const sessionId = generateId();
      const taskId = generateId();
      const ctx = makeCtx(taskId, sessionId, "claude_sonnet_4_6");

      const toolCallId = generateId();
      let callCount = 0;
      const provider: LLMProvider = {
        chat: async (): Promise<ProviderChatResponse> => {
          callCount++;
          if (callCount === 1) {
            advanceClock(120);
            return {
              message: {
                id: generateId(),
                sessionId,
                role: "assistant",
                content: null,
                toolCalls: [{ id: toolCallId, server: "test-server", tool: "echo", arguments: {} }],
                createdAt: nowIso(),
              },
              stopReason: "tool_calls",
              usage: { inputTokens: 500, outputTokens: 50, uncachedInputTokens: 500 },
            };
          }
          advanceClock(340);
          return {
            message: {
              id: generateId(),
              sessionId,
              role: "assistant",
              content: "done",
              createdAt: nowIso(),
            },
            stopReason: "completed",
            usage: { inputTokens: 1100, outputTokens: 20, uncachedInputTokens: 1100 },
          };
        },
      };

      await runTask({ db, ctx, provider, registry: makeToolRegistry("a modest tool result") });

      const res = usageQueryByGrain(db, { include_incomplete: true, grain: "turn" });
      expect(res.grain).toBe("turn");
      // Rows are created_at DESC — the 2nd call first.
      expect(res.rows).toHaveLength(2);
      expect(res.rows.map((r) => r.call_index)).toEqual([2, 1]);
      const [turn2, turn1] = res.rows;

      expect(turn1.task_id).toBe(taskId);
      expect(turn1.session_id).toBe(sessionId);
      expect(turn1.input_tokens).toBe(500);
      expect(turn1.compute_ms).toBe(120);
      expect(turn1.context_size).toBe(500); // trivial at turn grain — one call IS its own peak
      expect(turn1.context_size_at).toEqual({ task_id: taskId, call_index: 1 });
      // Tool-result tokens produced between this turn and the next MODEL_REQUEST are
      // attributed to THIS turn, not the next one.
      expect(turn1.tool_call_est_result_tokens).toBeGreaterThan(0);

      expect(turn2.input_tokens).toBe(1100);
      expect(turn2.compute_ms).toBe(340);
      expect(turn2.tool_call_est_result_tokens).toBe(0);

      // Reconciliation (DESIGN.md §8): task_usage's cumulative rollups must equal Σ
      // over this task's turn-grain rows — the base-unit truth.
      const taskRes = usageQueryByGrain(db, { include_incomplete: true, grain: "task", task_id: taskId });
      const taskRow = taskRes.rows[0];
      const turnSum = res.rows.reduce(
        (acc, r) => ({
          input_tokens: acc.input_tokens + r.input_tokens,
          output_tokens: acc.output_tokens + r.output_tokens,
          compute_ms: acc.compute_ms + r.compute_ms,
          tool_call_est_result_tokens: acc.tool_call_est_result_tokens + r.tool_call_est_result_tokens,
        }),
        { input_tokens: 0, output_tokens: 0, compute_ms: 0, tool_call_est_result_tokens: 0 }
      );
      expect(taskRow.input_tokens).toBe(turnSum.input_tokens);
      expect(taskRow.output_tokens).toBe(turnSum.output_tokens);
      expect(taskRow.compute_ms).toBe(turnSum.compute_ms);
      expect(taskRow.tool_call_est_result_tokens).toBe(turnSum.tool_call_est_result_tokens);
    });

    it("an unrecognized model produces turn-grain est_cost_usd IS NULL, never 0", async () => {
      const { db } = makeTestDb();
      const sessionId = generateId();
      const taskId = generateId();
      const ctx = makeCtx(taskId, sessionId, "totally-unrecognized-model-xyz");

      await runTask({
        db,
        ctx,
        provider: oneShotProvider({ inputTokens: 1000, outputTokens: 100, uncachedInputTokens: 1000 }),
        registry: emptyRegistry,
      });

      const res = usageQueryByGrain(db, { include_incomplete: true, grain: "turn" });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].est_cost_usd).toBeNull();
      // Summary must also be NULL, never a partial/misleading 0.
      expect(res.summary.est_cost_usd).toBeNull();
    });
  });
});
