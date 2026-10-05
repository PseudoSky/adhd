import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import type { SessionStoreForTool } from "../tools/session.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import { enqueueExistingTask } from "../tools/task.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";

/**
 * Backlog ac115447 — `task`'s `depends_on` was recorded but never gated:
 * a background task with unmet upstreams was enqueued immediately and a
 * synchronous task ran directly, bypassing `DagEngine.dispatchReady`, so the
 * documented DAG chaining ordered nothing.
 *
 * These tests drive the REAL `taskTool` against a REAL better-sqlite3
 * TaskStore/SessionStore, a REAL BackgroundQueue, and a REAL DagEngine wired
 * exactly like `index.ts` (dispatchFn → enqueueExistingTask). The ONLY mocked
 * boundary is the external LLM provider SDK (`openai`), per repo policy.
 *
 * Teeth:
 *  - "unmet dep → not dispatched" fails if the gate is removed (the task would
 *    be enqueued and the provider called).
 *  - the end-to-end A→B test fails if the gate is removed (B runs before A), and
 *    the ordering guard provider throws if B ever runs first.
 */

const hoisted = vi.hoisted(() => ({
  chatCalls: [] as string[],
  completed: new Set<string>(),
  /** prompt → the prompt that must already be complete (ordering guard). */
  requireBefore: {} as Record<string, string>,
  chat: undefined as
    | undefined
    | ((args: { messages: Array<{ role: string; content?: string | null }> }) => Promise<unknown>),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: (args: any) => hoisted.chat!(args),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {
      // no-op: the real network client is never constructed
    }
  }
  return { default: MockOpenAI };
});

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_name TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL,
  status TEXT DEFAULT 'active' NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  composed_prompt_id TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_results TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
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
CREATE TABLE task_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE task_usage (
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
`;

const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function agentDef(name: string): AgentDefinition {
  return {
    name,
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function makeEngineConfig(): EngineConfig {
  return {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({
      secret: "test-secret",
      baseURL: "http://localhost:0/v1",
      model: "gpt-4o-mini",
    }),
    subprocessEnv: () => ({}),
    isEnvNameAllowed: () => true,
  };
}

interface Env {
  deps: TaskDeps;
  taskStore: TaskStore;
  sessionStore: SessionStore;
  queue: BackgroundQueue;
  sessionId: string;
}

function makeEnv(): Env {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;

  const hooks = new HookRegistry();
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition = agentDef("dep-gating-agent");
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(5, silentLogger);
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 });

  const taskDepsRef: { value?: TaskDeps } = {};
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async (taskId: string) => {
      if (!taskDepsRef.value) throw new Error("dispatchFn before init");
      await enqueueExistingTask(taskId, taskDepsRef.value);
    },
    silentLogger
  );

  const deps: TaskDeps = {
    agentStore,
    sessionStore: sessionStore as unknown as SessionStoreForTool,
    taskStore,
    orchestrator: new Orchestrator(),
    queue,
    policy,
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error("no in-process tools registered in this test");
    },
    db,
    dagEngine,
    config: makeEngineConfig(),
    logger: silentLogger,
  };
  taskDepsRef.value = deps;

  const session = sessionStore.create({
    agentName: definition.name,
    agentDefinition: definition,
  });

  return { deps, taskStore, sessionStore, queue, sessionId: session.id };
}

beforeEach(() => {
  hoisted.chatCalls = [];
  hoisted.completed = new Set();
  hoisted.requireBefore = {};
  hoisted.chat = async (args) => {
    const lastUser = [...args.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    // Ordering guard (armed per-test): the named predecessor must have completed.
    const predecessor = hoisted.requireBefore[prompt];
    if (predecessor && !hoisted.completed.has(predecessor)) {
      throw new Error(`ordering violated: ${prompt} ran before ${predecessor}`);
    }
    hoisted.chatCalls.push(prompt);
    hoisted.completed.add(prompt);
    return {
      choices: [
        {
          message: { content: `done:${prompt}`, tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: undefined,
    };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("task depends_on gating (ac115447)", () => {
  it("background task with an UNMET dependency is NOT dispatched", async () => {
    const { deps, taskStore, sessionId } = makeEnv();
    // Upstream created but never run/completed → not terminal.
    const upstream = taskStore.create({ sessionId, prompt: "A" });

    const res = await taskTool(
      {
        session_id: sessionId,
        prompt: "B",
        background: true,
        depends_on: [upstream.id],
      },
      deps
    );

    expect(res.status).toBe("waiting");
    expect(taskStore.read(res.task_id).status).toBe("waiting");
    // The provider never ran — the task was not dispatched early.
    expect(hoisted.chatCalls).toHaveLength(0);
  });

  it("synchronous task with an UNMET dependency rejects with a typed error", async () => {
    const { deps, taskStore, sessionId } = makeEnv();
    const upstream = taskStore.create({ sessionId, prompt: "A" });

    await expect(
      taskTool(
        {
          session_id: sessionId,
          prompt: "B",
          background: false,
          depends_on: [upstream.id],
        },
        deps
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(hoisted.chatCalls).toHaveLength(0);
  });

  it("background task whose dependency is ALREADY complete runs normally", async () => {
    const { deps, taskStore, sessionId, queue } = makeEnv();
    const upstream = taskStore.create({ sessionId, prompt: "A" });
    taskStore.updateStatus(upstream.id, "completed", { result: "upstream-ok" });

    const res = await taskTool(
      {
        session_id: sessionId,
        prompt: "B",
        background: true,
        depends_on: [upstream.id],
      },
      deps
    );

    expect(res.status).toBe("pending");
    await queue.onIdle();
    expect(taskStore.read(res.task_id).status).toBe("completed");
    expect(hoisted.chatCalls).toContain("B");
  });

  it("DAG: a dependent background task waits for its upstream and then runs", async () => {
    const { deps, taskStore, sessionId, queue } = makeEnv();
    // Arm the ordering guard: B must not run until A has completed.
    hoisted.requireBefore = { B: "A" };

    const a = await taskTool({ session_id: sessionId, prompt: "A", background: true }, deps);
    const b = await taskTool(
      { session_id: sessionId, prompt: "B", background: true, depends_on: [a.task_id] },
      deps
    );

    // B is parked at creation; A is running.
    expect(b.status).toBe("waiting");

    await queue.onIdle();

    // A completes → its runTask finally calls DagEngine.dispatchReady(A) → B is
    // flipped to pending and dispatched; the ordering guard would have thrown if
    // B had run before A.
    expect(taskStore.read(a.task_id).status).toBe("completed");
    expect(taskStore.read(b.task_id).status).toBe("completed");
    expect(hoisted.chatCalls).toEqual(["A", "B"]);
  });

  it("ephemeral task with an UNMET dependency rejects rather than running early", async () => {
    const { deps, taskStore } = makeEnv();
    const upstream = taskStore.create({ sessionId: null, isEphemeral: true, prompt: "A" });

    await expect(
      taskTool(
        { agent_name: "dep-gating-agent", prompt: "B", depends_on: [upstream.id] },
        deps
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(hoisted.chatCalls).toHaveLength(0);
  });
});
