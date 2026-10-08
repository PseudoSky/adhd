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
import { createMigratedSqlite } from './fixtures/real-schema-db.js';

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
  const sqlite = createMigratedSqlite();
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
