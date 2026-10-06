import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import type { AgentDefinition } from '@adhd/agent-base-types';

import { taskTool } from '../tools/task.js';
import type { TaskDeps } from '../tools/task.js';
import type { AgentStore } from '../tools/agent-crud.js';
import { PolicyEngine } from '../engine/policy.js';
import { HookRegistry } from '../engine/hooks.js';
import { BackgroundQueue } from '../engine/queue.js';
import { DagEngine } from '../engine/dag-engine.js';
import { Orchestrator } from '../engine/orchestrator.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { LLMProvider, ProviderChatResponse } from '../providers/types.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';

/**
 * f5abca83 (FIX 2) — path-level teeth: a ONE-SHOT `agent_name` task that hits a
 * permission `ask` must NOT hang. The one-shot transport is synchronous
 * (`runEphemeralTask` awaits `orchestrator.run`), so its caller can never receive
 * the resumeToken; per ADR-0008 D6 the ask fails closed to `PERMISSION_ASK_DENIED`
 * and the call returns within its own duration. Reverting FIX 2 makes the ask
 * suspend → `taskTool` never resolves → the bounded-deadline race below is RED.
 *
 * This drives the REAL `taskTool` → REAL `runEphemeralTask` → REAL orchestrator →
 * REAL TaskStore/SessionStore (in-memory sqlite). The ONLY mock is the external
 * LLM boundary (`../providers/factory.js` → a scripted provider), per repo policy.
 */

/** The scripted provider the mocked factory returns; set per test. */
let scriptedProvider: LLMProvider;

vi.mock('../providers/factory.js', () => ({
  createProvider: () => scriptedProvider,
}));

/** A provider that emits one tool call, then completes. */
function toolThenComplete(server: string, tool: string): LLMProvider {
  let call = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      call++;
      const sessionId = generateId();
      if (call === 1) {
        return {
          message: {
            id: generateId(),
            sessionId,
            role: 'assistant',
            content: '',
            toolCalls: [{ id: generateId(), server, tool, arguments: {} }],
            createdAt: nowIso(),
          },
          stopReason: 'tool_calls',
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: 'recovered',
          createdAt: nowIso(),
        },
        stopReason: 'completed',
      };
    },
  };
}

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
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
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_results TEXT,
    created_at TEXT NOT NULL
);
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

function makeAgentDefinition(): AgentDefinition {
  return {
    name: 'one-shot-ask-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are a test agent.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function makeStubAgentStore(def: AgentDefinition): AgentStore {
  return {
    create: () => def,
    read: (name: string) => {
      if (name !== def.name) throw new Error(`unexpected agent name: ${name}`);
      return def;
    },
    update: () => def,
    delete: () => {},
    list: () => [def],
  };
}

const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeDeps(): { deps: TaskDeps; taskStore: TaskStore } {
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLES_SQL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;

  const taskStore = new TaskStore(db);
  const agentDefinition = makeAgentDefinition();
  const agentStore = makeStubAgentStore(agentDefinition);
  const sessionStore = new SessionStore(db);
  const policy = new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 });
  const hooks = new HookRegistry();
  const queue = new BackgroundQueue(1, silentLogger);
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async () => {},
    silentLogger
  );

  const config: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 1 },
    sse: { baseUrl: 'http://localhost:0' },
    plugins: { entries: [] },
    getProviderConfig: () => ({ secret: 'test', baseURL: 'http://localhost:0/v1', model: 'gpt-4o-mini' }),
    subprocessEnv: () => ({}),
    resolveEnvName: () => undefined,
    isEnvNameAllowed: () => true,
    // Every native/permission-gated call resolves to `ask` — the exact trigger
    // for the one-shot hang regression.
    permissionGate: () => 'ask',
  };

  const deps: TaskDeps = {
    agentStore,
    sessionStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: taskStore as any,
    orchestrator: new Orchestrator(),
    queue,
    policy,
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error('no in-process tool may execute on the fail-closed path');
    },
    db,
    dagEngine,
    config,
    logger: silentLogger,
  };

  return { deps, taskStore };
}

describe('f5abca83 FIX 2 — one-shot agent_name ask does not hang (fails closed)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC1: a one-shot agent_name task hitting an `ask` returns a terminal denial within the call', async () => {
    const { deps, taskStore } = makeDeps();
    scriptedProvider = toolThenComplete('agent-mcp', 'task');

    // Bounded deadline: if FIX 2 is reverted the one-shot run suspends and
    // `taskTool` never resolves, so this race resolves to 'timeout' → RED.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([
      taskTool({ agent_name: 'one-shot-ask-agent', prompt: 'do a gated thing' }, deps),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 8_000);
      }),
    ]);
    if (timer) clearTimeout(timer);

    expect(output, 'a one-shot ask must return within the call, not hang').not.toBe('timeout');
    if (output === 'timeout') return; // narrow type; unreachable given the assert

    // Terminal outcome: the task completed (never parked at awaiting_input) and
    // the model was handed a typed PERMISSION_ASK_DENIED refusal.
    expect(output.status).toBe('completed');
    const task = taskStore.read(output.task_id);
    expect(task.status).toBe('completed');
    expect(task.resumeToken, 'a fail-closed ask must not leave a resume token').toBeFalsy();

    const messages = deps.sessionStore.getMessages(task.sessionId as string) as Array<{
      role?: string;
      toolResults?: unknown;
    }>;
    const toolText = messages
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.toolResults ?? []))
      .join('\n');
    expect(toolText).toContain('PERMISSION_ASK_DENIED');

    // NEGATIVE CONTROL (revert-failing): reverting FIX 2 (dropping
    // `suspensionAnswerable:false` from `runEphemeralTask`) makes the ask
    // suspend — `taskTool` never returns and the race above yields 'timeout'.
  }, 30_000);
});
