/**
 * guards: dispatch:completed is emitted twice or zero times per completed dispatch, with the wrong mode, kind, childTaskIds or parent-blocked time, once per batch item instead of once per batch, for a plain tool, a call with no parent context or a refused dispatch, or a throwing observer fails or alters the dispatch.
 * tier: S (real task tools, orchestrator, stores and hooks; only the openai SDK is mocked)
 * cites: R10 S5 AC5, R10 S5 AC2 (cited in the test titles and the docblock).
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import type { AgentDefinition, DispatchCompletedPayload, ExecutionContext } from '@adhd/agent-base-types';

import { resultToolWait, taskList, taskTool, tasksBatch } from '../../src/tools/task.js';
import type { TaskDeps } from '../../src/tools/task.js';
import type { AgentStore } from '../../src/tools/agent-crud.js';
import { PolicyEngine } from '../../src/engine/policy.js';
import { HookRegistry } from '../../src/engine/hooks.js';
import { BackgroundQueue } from '../../src/engine/queue.js';
import { DagEngine } from '../../src/engine/dag-engine.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import type { EngineConfig, EngineLogger } from '../../src/interfaces.js';
import { nowIso } from '../../src/utils/timestamps.js';
import { createMigratedSqlite } from '../fixtures/real-schema-db.js';

/**
 * R10 S5 (trace signals), emission side. Tests cite acceptance criteria as `R10 S5 AC<n>`:
 *
 *   AC5 `dispatch:completed` is emitted exactly once per completed dispatch tool call, with the right
 *       mode / kind / childTaskIds, from the PARENT's execution context, and never for a plain tool.
 *   AC2 an observer that throws on it never fails or alters the dispatch.
 *
 * Real: `taskTool` / `tasksBatch`, the `Orchestrator`, `TaskStore` / `SessionStore` over a database
 * built through the shipped migrations, the `HookRegistry`. Mocked: only the external `openai` SDK.
 */

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: 'worker done', tool_calls: undefined }, finish_reason: 'stop' }],
          usage: undefined,
        })),
      },
    };
    constructor(_opts: unknown) {
      /* no network client is ever constructed */
    }
  }
  return { default: MockOpenAI };
});

const silentLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function agent(): AgentDefinition {
  return {
    name: 'dispatch-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are a test agent.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function build(hooks = new HookRegistry()) {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  const taskStore = new TaskStore(db);
  const sessionStore = new SessionStore(db);
  const definition = agent();
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => {},
    list: () => [definition],
  };
  const config: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 1 },
    sse: { baseUrl: 'http://localhost:0' },
    plugins: { entries: [] },
    getProviderConfig: () => ({ secret: 'test-secret', baseURL: 'http://localhost:0/v1', model: 'gpt-4o-mini' }),
    subprocessEnv: () => ({}),
    resolveEnvName: () => undefined,
    isEnvNameAllowed: () => true,
  };
  const queue = new BackgroundQueue(1, silentLogger);
  const deps: TaskDeps = {
    agentStore,
    sessionStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: taskStore as any,
    orchestrator: new Orchestrator(),
    queue,
    policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error('no in-process tools in this test');
    },
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dagEngine: new DagEngine(db, queue, taskStore as any, async () => {}, silentLogger),
    config,
    logger: silentLogger,
  };
  const events: DispatchCompletedPayload[] = [];
  hooks.register('dispatch:completed', (p) => {
    events.push(p);
  });
  /** A parent execution context, as the in-process handler passes it to the dispatch tools. */
  const parent: ExecutionContext = {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    agentName: 'parent-agent',
    agentDefinition: definition,
    recursionDepth: 0,
    toolCallCount: 0,
  } as ExecutionContext;
  return { deps, events, parent, taskStore, sessionStore, definition };
}

/** Wait (bounded, event-loop turns only) until the task reached a terminal status. */
async function untilTerminal(taskStore: TaskStore, id: string): Promise<void> {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  for (let i = 0; i < 200_000; i++) {
    if (terminal.has(taskStore.read(id).status)) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`task ${id} never reached a terminal status`);
}

describe('R10 S5 AC5 — dispatch:completed is emitted once per completed dispatch', () => {
  it('R10 S5 AC5: a sync one-shot agent task emits one agent_task / sync dispatch carrying the child id and a real blocked time', async () => {
    const { deps, events, parent } = build();
    const out = await taskTool({ agent_name: 'dispatch-agent', prompt: 'go' }, deps, parent);
    expect(out.status).toBe('completed');
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ kind: 'agent_task', mode: 'sync', childTaskIds: [out.task_id] });
    expect(e?.executionContext).toBe(parent);
    expect(e?.parentBlockedMs).toBeGreaterThan(0);
    expect(e?.waitMs).toBeUndefined();
  });

  it('R10 S5 AC5: a sync session task emits one task / sync dispatch', async () => {
    const { deps, events, parent, sessionStore, definition } = build();
    const session = sessionStore.create({ agentName: definition.name, agentDefinition: definition });
    const out = await taskTool({ session_id: session.id, prompt: 'go', background: false }, deps, parent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'task', mode: 'sync', childTaskIds: [out.task_id] });
  });

  it('R10 S5 AC5: a background task emits one background dispatch with parentBlockedMs 0 and the child id', async () => {
    const { deps, events, parent, taskStore } = build();
    const out = await taskTool({ agent_name: 'dispatch-agent', prompt: 'go', background: true }, deps, parent);
    expect(out.status).toBe('pending');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent_task', mode: 'background', childTaskIds: [out.task_id], parentBlockedMs: 0 });
    await untilTerminal(taskStore, out.task_id);
    expect(events).toHaveLength(1); // the child finishing later is not another dispatch
  });

  it('R10 S5 AC5: tasks_batch is ONE dispatch for the whole batch (not one per item), carrying every child id in order', async () => {
    const { deps, events, parent } = build();
    const out = await tasksBatch({ agent_name: 'dispatch-agent', prompts: ['a', 'b', 'c'], concurrency: 2 }, deps, parent);
    expect(out.results).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tasks_batch',
      mode: 'sync',
      childTaskIds: out.results.map((r) => r.task_id),
    });
    expect(events[0]?.parentBlockedMs).toBeGreaterThan(0);
  });

  it('R10 S5 AC5: a background tasks_batch is one background dispatch with parentBlockedMs 0', async () => {
    const { deps, events, parent, taskStore } = build();
    const out = await tasksBatch({ agent_name: 'dispatch-agent', prompts: ['a', 'b'], background: true }, deps, parent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tasks_batch', mode: 'background', parentBlockedMs: 0 });
    expect(events[0]?.childTaskIds).toEqual(out.results.map((r) => r.task_id));
    for (const r of out.results) await untilTerminal(taskStore, r.task_id);
  });

  it('R10 S5 AC5: a dispatch with no parent context (a direct call) emits nothing', async () => {
    const { deps, events } = build();
    await taskTool({ agent_name: 'dispatch-agent', prompt: 'go' }, deps);
    expect(events).toEqual([]);
  });

  it('R10 S5 AC5: a dispatch that is refused (throws) emits nothing', async () => {
    const { deps, events, parent, sessionStore, definition } = build();
    const session = sessionStore.create({ agentName: definition.name, agentDefinition: definition });
    sessionStore.close(session.id);
    await expect(taskTool({ session_id: session.id, prompt: 'go', background: false }, deps, parent)).rejects.toThrow(/closed/i);
    expect(events).toEqual([]);
  });

  it('R10 S5 AC5: plain tools (task_list, result with a wait) emit no dispatch', async () => {
    const { deps, events, parent } = build();
    const out = await taskTool({ agent_name: 'dispatch-agent', prompt: 'go' }, deps, parent);
    events.length = 0;
    taskList({}, { taskStore: deps.taskStore });
    await resultToolWait({ task_id: out.task_id, wait_ms: 50 }, { taskStore: deps.taskStore, db: deps.db });
    expect(events).toEqual([]);
  });
});

describe('R10 S5 AC2 — an observer failure never fails or alters a dispatch', () => {
  it('R10 S5 AC2: a dispatch:completed handler that throws leaves the sync result intact', async () => {
    const hooks = new HookRegistry();
    hooks.register('dispatch:completed', () => {
      throw new Error('observer exploded');
    });
    const { deps, parent } = build(hooks);
    const out = await taskTool({ agent_name: 'dispatch-agent', prompt: 'go' }, deps, parent);
    expect(out).toMatchObject({ status: 'completed', result: 'worker done' });
  });

  it('R10 S5 AC2: a registry whose emit REJECTS for dispatch:completed (not just a throwing handler) leaves the result intact', async () => {
    const real = new HookRegistry();
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'emit') {
          return async (event: string, payload: unknown) => {
            if (event === 'dispatch:completed') throw new Error('registry exploded');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target.emit as any)(event, payload);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { deps, parent } = build(failing);
    const out = await taskTool({ agent_name: 'dispatch-agent', prompt: 'go' }, deps, parent);
    expect(out).toMatchObject({ status: 'completed', result: 'worker done' });
    const batch = await tasksBatch({ agent_name: 'dispatch-agent', prompts: ['a'] }, deps, parent);
    expect(batch.results[0]).toMatchObject({ status: 'completed' });
  });
});
