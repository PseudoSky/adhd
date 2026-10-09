/**
 * c536ce29 W4 — model-call completeness seams in the engine.
 *
 *  - TRC-AC26: the compaction summariser call runs inside `wire.withContext({purpose:'compaction'})`
 *    (real Orchestrator.run + real compaction; the provider is the only scripted boundary).
 *  - W4-AC-A: with tracing absent/inert the provider decorator changes nothing the caller can
 *    see (same result, SAME error object, handler failures swallowed; bare provider when no hooks).
 *
 * Mocked: only the external `openai` SDK network call. No sockets, no subprocess.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message, ProviderSelection } from "@adhd/agent-base-types";

import type { EngineConfig, EngineLogger, WireSeams } from "../interfaces.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { createProvider } from "../providers/factory.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

const sdk = vi.hoisted(() => ({ create: undefined as undefined | (() => Promise<unknown>) }));
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: () => (sdk.create as () => Promise<unknown>)() } };
  }
  return { default: FakeOpenAI };
});

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const baseConfig = {
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "http://localhost:0" },
  plugins: { entries: [] },
  getProviderConfig: () => ({ secret: "sk-" + "unit".repeat(3), model: "gpt-4o-mini" }),
  subprocessEnv: () => ({}),
  resolveEnvName: () => undefined,
  isEnvNameAllowed: () => true,
} as unknown as EngineConfig;

function makeCtx(taskId: string, sessionId: string): ExecutionContext {
  const agentDefinition: AgentDefinition = {
    name: "w4-agent",
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" },
    systemPrompt: "sys",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return { taskId, sessionId, agentName: "w4-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
}

const msg = (sessionId: string, role: Message["role"], content: string): Message => ({
  id: generateId(),
  sessionId,
  role,
  content,
  createdAt: nowIso(),
});

/** Drive a real Orchestrator.run() over an over-window history so compaction triggers. */
async function runWithCompaction(
  wire: WireSeams | undefined,
  scope: AsyncLocalStorage<Record<string, unknown>>
): Promise<Array<{ purpose: unknown; summarising: boolean }>> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, agent_name TEXT NOT NULL, agent_version INTEGER NOT NULL, agent_data TEXT NOT NULL, status TEXT DEFAULT 'active' NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, composed_prompt_id TEXT, provider_type TEXT, model_ref TEXT, models TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, session_id TEXT, parent_task_id TEXT, is_ephemeral INTEGER DEFAULT 0 NOT NULL, recursion_depth INTEGER DEFAULT 0 NOT NULL, status TEXT DEFAULT 'pending' NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT, depends_on TEXT, on_upstream_failure TEXT, inputs TEXT, resume_token TEXT);
    CREATE TABLE task_events (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const sessionId = generateId();
  const taskId = generateId();
  sqlite
    .prepare(
      "INSERT INTO sessions (id, agent_name, agent_version, agent_data, status, created_at, updated_at) VALUES (?, 'w4-agent', 1, '{}', 'active', ?, ?)"
    )
    .run(sessionId, nowIso(), nowIso());
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });

  const seen: Array<{ purpose: unknown; summarising: boolean }> = [];
  const provider: LLMProvider = {
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
      const summarising = req.messages[0]?.content?.startsWith("Summarise the following conversation") === true;
      seen.push({ purpose: scope.getStore()?.["purpose"], summarising });
      return {
        message: { id: generateId(), sessionId, role: "assistant", content: summarising ? "summary" : "done", createdAt: nowIso() },
        stopReason: "completed",
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    },
  };
  const big = "x".repeat(400_000); // ~100k estimated tokens per message: far past any model window
  const messages: Message[] = [msg(sessionId, "system", "sys")];
  for (let i = 0; i < 6; i++) {
    messages.push(msg(sessionId, "user", big), msg(sessionId, "assistant", big));
  }
  messages.push(msg(sessionId, "user", "go"));

  const config = (wire === undefined ? baseConfig : { ...baseConfig, wire }) as EngineConfig;
  await new Orchestrator().run({
    executionContext: makeCtx(taskId, sessionId),
    messages,
    registry: { listAllTools: async () => [], closeAll: async () => {}, getClient: async () => { throw new Error("no tools"); } } as unknown as McpClientRegistry,
    provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore: { appendMessage: async () => {}, close: () => {} } as OrchestratorSessionStore,
    signal: new AbortController().signal,
    taskId,
    hooks: new HookRegistry(),
    config,
    logger,
  });
  return seen;
}

/** A real (async-context) `withContext`, the same contract the agent-mcp wire seam implements. */
function alsWire(scope: AsyncLocalStorage<Record<string, unknown>>): WireSeams {
  return {
    withContext: <T,>(ctx: Record<string, string | number | boolean | null | undefined>, fn: () => T): T => scope.run(ctx, fn),
  } as unknown as WireSeams;
}

describe("c536ce29 TRC-AC26: compaction model call is tagged purpose:'compaction'", () => {
  it("c536ce29 TRC-AC26: the summariser call runs inside withContext({purpose:'compaction'}); the main call does not", async () => {
    const scope = new AsyncLocalStorage<Record<string, unknown>>();
    const seen = await runWithCompaction(alsWire(scope), scope);
    expect(seen).toEqual([
      { purpose: "compaction", summarising: true },
      { purpose: undefined, summarising: false },
    ]);
  });

  it("c536ce29 TRC-AC26: with no wire seam compaction still runs exactly as before (summariser then main call)", async () => {
    const scope = new AsyncLocalStorage<Record<string, unknown>>();
    const seen = await runWithCompaction(undefined, scope);
    expect(seen.map((s) => s.summarising)).toEqual([true, false]);
    expect(seen.every((s) => s.purpose === undefined)).toBe(true);
  });
});

describe("c536ce29 W4-AC-A: provider decorator is invisible when tracing is absent/inert", () => {
  const selection = { providerType: "openai", modelRef: "gpt-4o-mini" } as ProviderSelection;
  const request = { messages: [msg("s", "user", "hi")] } as ProviderChatRequest;
  const ok = {
    model: "gpt-4o-mini",
    choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  };

  it("c536ce29 W4-AC-A: no hooks => the bare OpenAIProvider instance (nothing wrapped)", () => {
    expect(createProvider(selection, {}, baseConfig, logger)).toBeInstanceOf(OpenAIProvider);
  });

  it("c536ce29 W4-AC-A: hooks without an executionContext => still the bare provider", () => {
    const hooks = new HookRegistry();
    expect(createProvider(selection, {}, baseConfig, logger, { hooks })).toBeInstanceOf(OpenAIProvider);
  });

  it("c536ce29 W4-AC-A: the decorated provider rethrows the very same error object, and a throwing handler cannot change it", async () => {
    const hooks = new HookRegistry();
    hooks.register("provider:failed", (() => {
      throw new Error("handler exploded");
    }) as never);
    const err = Object.assign(new Error("402 Insufficient credits"), { name: "APIError", status: 402 });
    sdk.create = () => Promise.reject(err);
    const provider = createProvider(selection, {}, baseConfig, logger, {
      hooks,
      executionContext: makeCtx("t", "s"),
    });
    await expect(provider.chat(request)).rejects.toBe(err);
  });

  it("c536ce29 W4-AC-A: a successful call returns an identical result bare and decorated, with no failure event", async () => {
    sdk.create = () => Promise.resolve(ok);
    const hooks = new HookRegistry();
    const failures: unknown[] = [];
    hooks.register("provider:failed", ((p: unknown) => void failures.push(p)) as never);
    const bare = await createProvider(selection, {}, baseConfig, logger).chat(request);
    const wrapped = await createProvider(selection, {}, baseConfig, logger, {
      hooks,
      executionContext: makeCtx("t", "s"),
    }).chat(request);
    const strip = (r: ProviderChatResponse) => ({ ...r, message: { ...r.message, id: "x", createdAt: "x" } });
    expect(strip(wrapped)).toEqual(strip(bare));
    expect(failures).toEqual([]);
  });
});
