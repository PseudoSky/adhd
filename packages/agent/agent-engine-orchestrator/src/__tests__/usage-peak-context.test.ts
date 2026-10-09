/**
 * 7ead5eaa AC4.5 / AC4.6 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — follow-up to BK4.
 *
 *  - AC4.5: compaction decisions use the TRUE per-response context (`peakContextTokens`, else
 *    `inputTokens`). A claudecli-shaped response whose cumulative `inputTokens` dwarfs its peak must
 *    NOT trigger compaction that the peak alone would not; a genuinely large peak still does.
 *  - AC4.6: `task_usage.peak_context_at` is the 1-based model-call index of the peak, correct on the
 *    first insert (not a hard-coded 1) and on the MAX-on-conflict update (moves only on a strictly
 *    higher peak).
 *
 * Real Orchestrator + real HookRegistry + real UsagePlugin + real SQLite built from the shipped
 * migrations. Only the LLM provider is scripted. No sockets, no subprocess, no live calls.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

interface ITurn {
  /** Cumulative (billing) input of the response. */
  inputTokens: number;
  /** Per-turn peak context, when the provider reports one (claudecli). */
  peakContextTokens?: number;
  /** Internal model calls folded into this response (claudecli). */
  modelCalls?: number;
}

interface IRun {
  sqlite: Database.Database;
  taskId: string;
  /** Number of summariser (compaction) model calls the run made. */
  compactions: number;
}

/** gpt-4o-mini: 128k window, compaction trigger 0.75 => 96k. */
const MODEL = "gpt-4o-mini";

function required<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}, array has ${items.length}`);
  return item;
}

/** Drives `turns.length` model calls (all but the last request a tool) through the real engine. */
async function run(turns: ITurn[]): Promise<IRun> {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "peak-agent",
    version: 1,
    provider: { type: "openai", model: MODEL },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = { taskId, sessionId, agentName: "peak-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db).install(hooks);

  let i = 0;
  let compactions = 0;
  const provider: LLMProvider = {
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
      if (req.messages[0]?.content?.startsWith("Summarise the following conversation") === true) {
        compactions++;
        return {
          message: { id: generateId(), sessionId, role: "assistant", content: "summary", createdAt: nowIso() },
          stopReason: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      const turn = required(turns, i++);
      const last = i === turns.length;
      return {
        message: {
          id: generateId(),
          sessionId,
          role: "assistant",
          ...(last ? { content: "done" } : { toolCalls: [{ id: generateId(), server: "s", tool: "echo", arguments: {} }] }),
          createdAt: nowIso(),
        },
        stopReason: last ? "completed" : "tool_calls",
        usage: {
          inputTokens: turn.inputTokens,
          outputTokens: 1,
          uncachedInputTokens: turn.inputTokens,
          ...(turn.peakContextTokens !== undefined ? { peakContextTokens: turn.peakContextTokens } : {}),
        },
        ...(turn.modelCalls !== undefined ? { reportedModelCalls: turn.modelCalls } : {}),
      };
    },
  };
  const registry = {
    listAllTools: async () => [{ name: "s__echo", description: "", inputSchema: { type: "object", properties: {} } }],
    getClient: async () => ({ callTool: async () => "ok" }),
    closeAll: async () => {},
  } as unknown as McpClientRegistry;
  const msg = (role: Message["role"], content: string): Message => ({ id: generateId(), sessionId, role, content, createdAt: nowIso() });
  // Small history with enough atomic units that a compaction, if decided, really runs.
  const messages: Message[] = [msg("system", "sys")];
  for (let n = 0; n < 8; n++) messages.push(msg("user", `q${n}`), msg("assistant", `a${n}`));
  messages.push(msg("user", "go"));

  await new Orchestrator().run({
    executionContext: ctx,
    messages,
    registry,
    provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore: { appendMessage: async () => {}, close: () => {} } as OrchestratorSessionStore,
    signal: new AbortController().signal,
    taskId,
    hooks,
  });
  return { sqlite, taskId, compactions };
}

function peakRow(r: IRun): { peak_context_tokens: number; peak_context_at: number; model_calls: number } {
  return r.sqlite
    .prepare("SELECT peak_context_tokens, peak_context_at, model_calls FROM task_usage WHERE task_id = ?")
    .get(r.taskId) as { peak_context_tokens: number; peak_context_at: number; model_calls: number };
}

describe("7ead5eaa AC4.5: compaction uses the true per-response context", () => {
  it("7ead5eaa AC4.5: a claudecli-shaped response (sum 500k >> peak 5k) does NOT trigger compaction", async () => {
    const r = await run([
      { inputTokens: 500_000, peakContextTokens: 5_000, modelCalls: 5 },
      { inputTokens: 500_000, peakContextTokens: 5_000, modelCalls: 5 },
    ]);
    expect(r.compactions).toBe(0);
  });

  it("7ead5eaa AC4.5: a genuinely large peak (100k > 96k threshold) still triggers compaction", async () => {
    const r = await run([
      { inputTokens: 500_000, peakContextTokens: 100_000, modelCalls: 5 },
      { inputTokens: 10, peakContextTokens: 10, modelCalls: 1 },
    ]);
    expect(r.compactions).toBeGreaterThan(0);
  });

  it("7ead5eaa AC4.5: without a reported peak, inputTokens still drives the decision (other providers unchanged)", async () => {
    expect((await run([{ inputTokens: 100_000 }, { inputTokens: 10 }])).compactions).toBeGreaterThan(0);
    expect((await run([{ inputTokens: 5_000 }, { inputTokens: 10 }])).compactions).toBe(0);
  });
});

describe("7ead5eaa AC4.6: peak_context_at is the 1-based model-call index of the peak", () => {
  it("7ead5eaa AC4.6: first insert records the response's call index, not a hard-coded 1 (response folding 5 calls => 5)", async () => {
    const r = await run([{ inputTokens: 36_589, peakContextTokens: 9_149, modelCalls: 5 }]);
    expect(peakRow(r)).toEqual({ peak_context_tokens: 9_149, peak_context_at: 5, model_calls: 5 });
  });

  it("7ead5eaa AC4.6: a plain single-call provider peaks at call 1 on the first insert", async () => {
    const r = await run([{ inputTokens: 700 }]);
    expect(peakRow(r)).toEqual({ peak_context_tokens: 700, peak_context_at: 1, model_calls: 1 });
  });

  it("7ead5eaa AC4.6: update path moves peak_context_at only when the peak strictly increases", async () => {
    // call 1: 1000 (peak@1); call 2: 3000 (peak@2); call 3: 2000 (lower, stays 2); call 4: 3000 (equal, stays 2).
    const r = await run([{ inputTokens: 1000 }, { inputTokens: 3000 }, { inputTokens: 2000 }, { inputTokens: 3000 }]);
    expect(peakRow(r)).toEqual({ peak_context_tokens: 3000, peak_context_at: 2, model_calls: 4 });
  });

  it("7ead5eaa AC4.6: folded responses index by cumulative calls (2 calls then a 3-call response peaking higher => 5)", async () => {
    const r = await run([
      { inputTokens: 5_000, peakContextTokens: 2_000, modelCalls: 2 },
      { inputTokens: 9_000, peakContextTokens: 4_000, modelCalls: 3 },
      { inputTokens: 9_000, peakContextTokens: 1_000, modelCalls: 2 },
    ]);
    expect(peakRow(r)).toEqual({ peak_context_tokens: 4_000, peak_context_at: 5, model_calls: 7 });
  });
});
