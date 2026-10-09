/**
 * 7ead5eaa (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) BK4 -- claudecli reports the TRUE per-turn peak
 * context, and `usage_query`'s turn grain re-prices a multi-model response per model (BK8 follow-up).
 * AC4.1 - AC4.3.
 *
 * Real ClaudeCliProvider + real Orchestrator + real HookRegistry + real UsagePlugin + a real SQLite
 * database built from the shipped drizzle migrations (`createMigratedSqlite`). The ONLY replaced boundary
 * is the `claude` process: `child_process.spawn` returns recorded `claude -p --output-format stream-json`
 * transcripts. No live model call is made.
 *
 *  - fixtures/claudecli-b1-multiturn.stream.jsonl / claudecli-b2-multiturn.stream.jsonl: the recorded
 *    agent-mcp runs B1 (task 62bf63b1) and B2 (task d688b927) of the CLI-parity experiment, trimmed of
 *    thinking-signature blobs, tool output and hook noise (assistant `usage` and the `result` event are
 *    verbatim). `result.usage` is the SUM over 5 / 4 turns (36,589 / 47,592 input tokens) while the
 *    largest single turn is 9,149 / 14,757.
 *  - fixtures/claudecli-pinned-haiku-4-5.stream.jsonl: a 70,270-token-context run (A1).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(HERE, "fixtures", name), "utf8");
const B1 = fixture("claudecli-b1-multiturn.stream.jsonl");
const B2 = fixture("claudecli-b2-multiturn.stream.jsonl");
const A1 = fixture("claudecli-pinned-haiku-4-5.stream.jsonl");

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engineConfig = {
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "http://localhost:0" },
  plugins: { entries: [] },
  getProviderConfig: () => ({ secret: "sk-test", model: "m" }),
  subprocessEnv: () => ({}),
  resolveEnvName: () => undefined,
  isEnvNameAllowed: () => true,
} as unknown as EngineConfig;

type StreamEvent = Record<string, unknown> & { type: string };
const parse = (stream: string): StreamEvent[] =>
  stream.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as StreamEvent);
const serialize = (events: StreamEvent[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** The stream-derived truth the DB must agree with: max over assistant events of input + cache_read + cache_creation. */
function streamPeak(stream: string): number {
  let peak = 0;
  for (const e of parse(stream)) {
    if (e.type !== "assistant") continue;
    const u = (e["message"] as { usage: Record<string, number> }).usage;
    peak = Math.max(peak, (u["input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0));
  }
  return peak;
}

interface ITaskUsageRow {
  input_tokens: number;
  peak_context_tokens: number;
  model_calls: number;
  est_cost_usd: number | null;
  cost_status: string | null;
}

/** Replay `stream` through the real provider, orchestrator and UsagePlugin; return the persisted row and the open db. */
async function replay(stream: string, configuredModel = "claude-haiku-4-5") {
  const { spawn } = await import("child_process");
  const stdout = new Readable({ read() {} });
  const proc = {
    stdout,
    stdin: { write: () => true, end: () => {} },
    stderr: new Readable({ read() {} }),
    on: () => {},
    kill: () => {},
    exitCode: 0 as number | null,
    killed: false,
  };
  queueMicrotask(() => {
    stdout.push(stream);
    stdout.push(null);
  });
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  spawnMock.mockReset();
  spawnMock.mockReturnValue(proc);

  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "bk4-agent",
    version: 1,
    provider: { type: "claudecli", model: configuredModel },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = {
    taskId,
    sessionId,
    agentName: "bk4-agent",
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db, logger).install(hooks);

  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const provider = new ClaudeCliProvider({ type: "claudecli", model: configuredModel }, {}, undefined, engineConfig, logger);
  const userMessage: Message = { id: generateId(), sessionId, role: "user", content: "hello", createdAt: nowIso() };
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const registry = {
    listAllTools: async () => [],
    closeAll: async () => {},
    getClient: async () => {
      throw new Error("no tool calls expected");
    },
  } as unknown as McpClientRegistry;
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
  const row = sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as ITaskUsageRow;
  return { row, db, sqlite, taskId, close: () => sqlite.close() };
}

describe("7ead5eaa BK4 AC4.1: task_usage.peak_context_tokens is the per-turn peak, not the cross-turn sum", () => {
  it("7ead5eaa AC4.1: B1 (5 turns, summed input 36,589) stores peak 9,149", async () => {
    expect(streamPeak(B1)).toBe(9_149);
    const r = await replay(B1);
    expect(r.row.peak_context_tokens).toBe(9_149);
    r.close();
  });

  it("7ead5eaa AC4.1: B2 (4 turns, summed input 47,592) stores peak 14,757", async () => {
    expect(streamPeak(B2)).toBe(14_757);
    const r = await replay(B2);
    expect(r.row.peak_context_tokens).toBe(14_757);
    r.close();
  });

  it("7ead5eaa AC4.1: the recorded A1 run (single large context) stores its 70,270 peak", async () => {
    const r = await replay(A1);
    expect(r.row.peak_context_tokens).toBe(streamPeak(A1));
    expect(r.row.peak_context_tokens).toBe(70_270);
    r.close();
  });

  it("7ead5eaa AC4.2: input_tokens keeps its documented meaning -- the cache-inclusive SUM across turns -- and cost is untouched", async () => {
    const r = await replay(B1);
    // result.usage: input 42 + cache_read 27,406 + cache_creation 9,141
    expect(r.row.input_tokens).toBe(36_589);
    expect(r.row.peak_context_tokens).toBeLessThan(r.row.input_tokens);
    expect(r.row.cost_status).toBe("priced");
    expect(r.row.est_cost_usd).toBeCloseTo(0.0260546, 6); // == the CLI's total_cost_usd for the recorded run
    r.close();
  });

  it("7ead5eaa AC4.1: the turn grain's context_size is the same per-turn peak, and the task grain agrees", async () => {
    const r = await replay(B2);
    const turn = usageQueryByGrain(r.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(turn.rows).toHaveLength(1);
    expect(turn.rows[0]?.context_size).toBe(14_757);
    expect(turn.rows[0]?.input_tokens).toBe(47_592);
    const task = usageQueryByGrain(r.db, { include_incomplete: true, limit: 50, grain: "task" });
    expect(task.rows[0]?.context_size).toBe(14_757);
    r.close();
  });

  it("7ead5eaa AC4.1: a stream whose assistant events carry no usage falls back to the summed input (unchanged behaviour)", async () => {
    const stripped = serialize(
      parse(B1).map((e) => {
        if (e.type === "assistant") {
          const m = e["message"] as Record<string, unknown>;
          delete m["usage"];
        }
        return e;
      })
    );
    const r = await replay(stripped);
    expect(r.row.peak_context_tokens).toBe(36_589);
    r.close();
  });
});

describe("7ead5eaa BK4 AC4.3: providers that report one call per response keep their peak semantics", () => {
  it("7ead5eaa AC4.3: three single-call responses (C-run contexts 3,079 / 32,894 / 33,232) peak at the max and sum input", async () => {
    const sqlite = createMigratedSqlite();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any;
    const taskId = generateId();
    const sessionId = generateId();
    const ctx: ExecutionContext = {
      taskId,
      sessionId,
      agentName: "bk4-oauth",
      agentDefinition: {
        name: "bk4-oauth",
        version: 1,
        provider: { type: "anthropic", model: "claude-haiku-4-5" },
        systemPrompt: "x",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      recursionDepth: 0,
      toolCallCount: 0,
    };
    new TaskStore(db).create({ sessionId, prompt: "p", id: taskId });
    const hooks = new HookRegistry();
    new UsagePlugin(db, logger).install(hooks);
    for (const inputTokens of [3_079, 32_894, 33_232]) {
      await hooks.emit("post:model_response", {
        executionContext: ctx,
        stopReason: "completed",
        toolCallCount: 0,
        tokenUsage: { inputTokens, outputTokens: 10, uncachedInputTokens: inputTokens },
        computeMs: 1,
      });
    }
    const row = sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as ITaskUsageRow;
    expect(row.peak_context_tokens).toBe(33_232);
    expect(row.input_tokens).toBe(3_079 + 32_894 + 33_232);
    sqlite.close();
  });
});

describe("7ead5eaa BK4 (BK8 follow-up): usage_query's turn grain re-prices a multi-model response per model", () => {
  // Two models served the one response; the SMALLER-by-tokens model is the expensive-per-token one.
  const multiModelEvents = (): StreamEvent[] => {
    const events = parse(B1);
    const result = events.find((e) => e.type === "result");
    if (!result) throw new Error("fixture has no result event");
    result["modelUsage"] = {
      "claude-haiku-5-5": { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 0 },
      "claude-haiku-4-5": { inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
    result["usage"] = { ...(result["usage"] as object), cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } };
    return events;
  };
  // haiku-5-5: (1000*0.10 + 2000*0.50 + 10000*0.01)/1e6 = 0.0012 ; haiku-4-5: (100000*1 + 10000*5)/1e6 = 0.15
  const EXPECTED = 0.0012 + 0.15;

  it("7ead5eaa BK8-follow-up: the turn row's est_cost_usd is the per-model sum and equals the task row's", async () => {
    const r = await replay(serialize(multiModelEvents()), "haiku");
    expect(r.row.est_cost_usd).toBeCloseTo(EXPECTED, 9);
    const turn = usageQueryByGrain(r.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(turn.rows).toHaveLength(1);
    expect(turn.rows[0]?.est_cost_usd).toBeCloseTo(EXPECTED, 9);
    expect(turn.rows[0]?.cost_status).toBe("priced");
    r.close();
  });

  it("7ead5eaa BK8-follow-up: one unpriced model in the breakdown leaves the turn cost NULL, status partial, and counts the unpriced tokens", async () => {
    const events = multiModelEvents();
    const result = events.find((e) => e.type === "result");
    if (!result) throw new Error("fixture has no result event");
    (result["modelUsage"] as Record<string, unknown>)["claude-mystery-1"] = {
      inputTokens: 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    };
    const r = await replay(serialize(events), "haiku");
    const turn = usageQueryByGrain(r.db, { include_incomplete: true, limit: 50, grain: "turn" });
    expect(turn.rows[0]?.est_cost_usd).toBeNull();
    expect(turn.rows[0]?.cost_status).toBe("partial");
    expect(turn.summary.unpriced_tokens).toBe(1000);
    expect(turn.summary.unpriced_models).toContain("claude-mystery-1");
    r.close();
  });
});
