import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import type { AgentDefinition } from '@adhd/agent-base-types';

import { resultToolWait, taskTool, tasksBatch } from '../tools/task.js';
import type { TaskDeps } from '../tools/task.js';
import type { AgentStore } from '../tools/agent-crud.js';
import { PolicyEngine } from '../engine/policy.js';
import { HookRegistry } from '../engine/hooks.js';
import { BackgroundQueue } from '../engine/queue.js';
import { DagEngine } from '../engine/dag-engine.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { RESULT_MAX_WAIT_MS, tasksBatchInputSchema } from '../validation/task.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { LLMProvider, ProviderChatResponse } from '../providers/types.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import { createMigratedSqlite } from './fixtures/real-schema-db.js';

/**
 * P2 (adbf1c0b, 099524a8): background ephemeral `task` / `tasks_batch` and the bounded `result`
 * wait. Drives the REAL taskTool/tasksBatch/resultToolWait -> REAL orchestrator -> REAL
 * TaskStore/SessionStore/DagEngine (in-memory migrated sqlite). The only mock is the LLM boundary
 * (a scripted provider gated by a latch so "returned before the run finished" is provable without
 * wall-clock sleeps).
 */

let scriptedProvider: LLMProvider;
let permission: 'allow' | 'ask' = 'allow';

vi.mock('../providers/factory.js', () => ({
  createProvider: () => scriptedProvider,
}));

/** A latch: `release()` lets every provider call proceed; `entered` resolves on the first call. */
function latch(): { gate: Promise<void>; release: () => void; entered: Promise<void>; markEntered: () => void } {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (markEntered = r));
  return { gate, release, entered, markEntered };
}

function gatedProvider(l: ReturnType<typeof latch>, seen?: { suspensionFlags?: unknown[] }): LLMProvider {
  void seen;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      l.markEntered();
      await l.gate;
      return {
        message: { id: generateId(), sessionId: generateId(), role: 'assistant', content: 'done', createdAt: nowIso() },
        stopReason: 'completed',
      };
    },
  };
}

function makeAgentDefinition(): AgentDefinition {
  return {
    name: 'bg-agent',
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

function makeDeps(dispatchFn: (id: string) => Promise<void> = async () => {}): { deps: TaskDeps; taskStore: TaskStore; queue: BackgroundQueue } {
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
    dispatchFn,
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
    permissionGate: () => permission,
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

  return { deps, taskStore, queue };
}


const WAIT_BOUND_MS = 8_000;

/** Reject if `p` does not settle within the bound: a hang becomes a red test, not a stuck run. */
async function bounded<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out: ${label}`)), WAIT_BOUND_MS);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('P2 background ephemeral task', () => {
  afterEach(() => {
    permission = 'allow';
    vi.restoreAllMocks();
  });

  it('P2 AC-bg-task: background:true returns {task_id, status:pending} while the run is still blocked, then completes', async () => {
    const { deps, taskStore, queue } = makeDeps();
    const l = latch();
    scriptedProvider = gatedProvider(l);

    const out = await bounded(taskTool({ agent_name: 'bg-agent', prompt: 'go', background: true }, deps), 'task returns');
    expect(out).toEqual({ task_id: out.task_id, status: 'pending' });
    // The provider has not been released, so the task cannot be terminal yet.
    await bounded(l.entered, 'provider entered');
    expect(['pending', 'running']).toContain(taskStore.read(out.task_id).status);

    l.release();
    await bounded(queue.onIdle(), 'queue idle');
    const done = taskStore.read(out.task_id);
    expect(done.status).toBe('completed');
    expect(done.isEphemeral).toBe(true);
  });

  it('P2 AC-bg-task: the default (no background) stays synchronous and returns the terminal result', async () => {
    const { deps } = makeDeps();
    const l = latch();
    l.release();
    scriptedProvider = gatedProvider(l);
    const out = await bounded(taskTool({ agent_name: 'bg-agent', prompt: 'go' }, deps), 'sync task');
    expect(out.status).toBe('completed');
    expect(out.result).toBe('done');
  });

  it('P2 AC-bg-session-kept: the one-shot session survives until the task is terminal, then is reclaimed', async () => {
    const { deps, taskStore, queue } = makeDeps();
    const l = latch();
    scriptedProvider = gatedProvider(l);
    const out = await taskTool({ agent_name: 'bg-agent', prompt: 'go', background: true }, deps);
    await bounded(l.entered, 'provider entered');
    const sessionId = taskStore.read(out.task_id).sessionId as string;
    expect(deps.sessionStore.read(sessionId).status).toBe('active');
    l.release();
    await bounded(queue.onIdle(), 'queue idle');
    // Reclaimed (closed or removed) once terminal: either read throws or status is not active.
    let active = true;
    try {
      active = deps.sessionStore.read(sessionId).status === 'active';
    } catch {
      active = false;
    }
    expect(active).toBe(false);
  });

  it('P2 AC-bg-dependents: dispatchReady fires for a waiting dependent when a background ephemeral task finishes', async () => {
    const dispatched: string[] = [];
    const { deps, taskStore, queue } = makeDeps(async (id) => {
      dispatched.push(id);
    });
    const l = latch();
    scriptedProvider = gatedProvider(l);
    const up = await taskTool({ agent_name: 'bg-agent', prompt: 'upstream', background: true }, deps);
    await bounded(l.entered, 'provider entered');

    const dependent = taskStore.create({ sessionId: null, prompt: 'downstream', dependsOn: [up.task_id] });
    expect(dependent.status).toBe('waiting');
    expect(dispatched, 'nothing dispatched while the upstream is still running').toEqual([]);

    l.release();
    await bounded(queue.onIdle(), 'queue idle');
    expect(dispatched).toEqual([dependent.id]);
    expect(taskStore.read(dependent.id).status).toBe('pending');
  });

  it('P2 AC-bg-dependents: a failed background upstream propagates failure to its waiting dependent (policy fail)', async () => {
    const { deps, taskStore, queue } = makeDeps();
    const l = latch();
    scriptedProvider = {
      chat: async () => {
        l.markEntered();
        await l.gate;
        throw new Error('provider exploded');
      },
    };
    const up = await taskTool({ agent_name: 'bg-agent', prompt: 'upstream', background: true }, deps);
    await bounded(l.entered, 'provider entered');
    const dependent = taskStore.create({ sessionId: null, prompt: 'downstream', dependsOn: [up.task_id] });
    l.release();
    await bounded(queue.onIdle(), 'queue idle');
    expect(taskStore.read(up.task_id).status).toBe('failed');
    expect(taskStore.read(dependent.id).status).toBe('failed');
  });

  it('P2 AC-bg-ask: a background one-shot task keeps suspensionAnswerable=false, so an ask fails closed instead of parking', async () => {
    const { deps, taskStore, queue } = makeDeps();
    permission = 'ask';
    let call = 0;
    scriptedProvider = {
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
              toolCalls: [{ id: generateId(), server: 'agent-mcp', tool: 'task', arguments: {} }],
              createdAt: nowIso(),
            },
            stopReason: 'tool_calls',
          };
        }
        return {
          message: { id: generateId(), sessionId, role: 'assistant', content: 'recovered', createdAt: nowIso() },
          stopReason: 'completed',
        };
      },
    };
    const out = await taskTool({ agent_name: 'bg-agent', prompt: 'gated', background: true }, deps);
    await bounded(queue.onIdle(), 'queue idle (an unanswered ask must not hang)');
    const task = taskStore.read(out.task_id);
    expect(task.status).toBe('completed');
    expect(task.resumeToken).toBeFalsy();
    const toolText = (deps.sessionStore.getMessages(task.sessionId as string) as Array<{ role?: string; toolResults?: unknown }>)
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.toolResults ?? []))
      .join('\n');
    expect(toolText).toContain('PERMISSION_ASK_DENIED');
  });
});

describe('P2 background tasks_batch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('P2 AC-bg-batch: background:true returns one pending task per prompt at once; concurrency is ignored', async () => {
    const { deps, taskStore, queue } = makeDeps();
    const l = latch();
    scriptedProvider = gatedProvider(l);
    // concurrency 1 would serialise a synchronous batch behind the blocked provider (deadlock);
    // in background mode every item is accepted immediately.
    const out = await bounded(
      tasksBatch(
        tasksBatchInputSchema.parse({ agent_name: 'bg-agent', prompts: ['a', 'b', 'c'], concurrency: 1, background: true }),
        deps
      ),
      'tasks_batch returns'
    );
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.results.every((r) => r.status === 'pending' && r.result === undefined)).toBe(true);
    expect(new Set(out.results.map((r) => r.task_id)).size).toBe(3);

    l.release();
    await bounded(queue.onIdle(), 'queue idle');
    for (const r of out.results) expect(taskStore.read(r.task_id).status).toBe('completed');
  });

  it('P2 AC-bg-batch: background:true combined with depends_on or depends_on_indexes is rejected by the schema', () => {
    const base = { agent_name: 'bg-agent', prompts: ['a', 'b'], background: true };
    const idx = tasksBatchInputSchema.safeParse({ ...base, depends_on_indexes: [[], [0]] });
    expect(idx.success).toBe(false);
    const ids = tasksBatchInputSchema.safeParse({ ...base, depends_on: [[], []] });
    expect(ids.success).toBe(false);
    if (!ids.success) expect(ids.error.issues.map((i) => i.message).join('\n')).toContain('background:true cannot be combined');
    // Without background the same dependency shapes are legal.
    expect(tasksBatchInputSchema.safeParse({ agent_name: 'bg-agent', prompts: ['a', 'b'], depends_on_indexes: [[], [0]] }).success).toBe(true);
  });

  it('P2 AC-bg-batch: background:false (default) keeps synchronous results', async () => {
    const { deps } = makeDeps();
    const l = latch();
    l.release();
    scriptedProvider = gatedProvider(l);
    const out = await bounded(
      tasksBatch(tasksBatchInputSchema.parse({ agent_name: 'bg-agent', prompts: ['a', 'b'] }), deps),
      'sync batch'
    );
    expect(out.results.map((r) => r.status)).toEqual(['completed', 'completed']);
  });
});

describe('P2 resultToolWait on a real task store', () => {
  /** Task whose status we advance by hand; the injected sleep is the only thing that moves time. */
  function setup(): { deps: Pick<TaskDeps, 'taskStore' | 'db'>; id: string; taskStore: TaskStore } {
    const { deps, taskStore } = makeDeps();
    const t = taskStore.create({ sessionId: null, prompt: 'p' });
    return { deps, id: t.id, taskStore };
  }

  /** Virtual clock + sleep: advancing the clock is the sleep; records every requested delay. */
  function virtual(onTick?: (tick: number) => void): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    let t = 1_000_000;
    const sleeps: number[] = [];
    let n = 0;
    return {
      now: () => t,
      sleeps,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        onTick?.(++n);
      },
    };
  }

  it('P2 AC-wait: wait_ms unset or 0 is an immediate read (never sleeps)', async () => {
    const { deps, id } = setup();
    const v = virtual();
    expect((await resultToolWait({ task_id: id }, deps, v.sleep, v.now)).status).toBe('pending');
    expect((await resultToolWait({ task_id: id, wait_ms: 0 }, deps, v.sleep, v.now)).status).toBe('pending');
    expect(v.sleeps).toEqual([]);
  });

  it('P2 AC-wait: a non-terminal task is polled in 100ms steps until the budget elapses, then returned as-is (not an error)', async () => {
    const { deps, id } = setup();
    const v = virtual();
    const out = await resultToolWait({ task_id: id, wait_ms: 250 }, deps, v.sleep, v.now);
    expect(out.status).toBe('pending');
    expect(v.sleeps).toEqual([100, 100, 50]);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('P2 AC-wait: stops as soon as the task is %s', async (terminal) => {
    const { deps, id, taskStore } = setup();
    taskStore.updateStatus(id, 'running');
    const v = virtual((tick) => {
      if (tick === 2) taskStore.updateStatus(id, terminal, terminal === 'failed' ? { error: 'x' } : undefined);
    });
    const out = await resultToolWait({ task_id: id, wait_ms: 10_000 }, deps, v.sleep, v.now);
    expect(out.status).toBe(terminal);
    expect(v.sleeps).toEqual([100, 100]);
  });

  it('P2 AC-wait: stops on awaiting_input (only a human can advance it)', async () => {
    const { deps, id, taskStore } = setup();
    taskStore.updateStatus(id, 'running');
    const v = virtual((tick) => {
      if (tick === 1) taskStore.updateStatus(id, 'awaiting_input');
    });
    const out = await resultToolWait({ task_id: id, wait_ms: 10_000 }, deps, v.sleep, v.now);
    expect(out.status).toBe('awaiting_input');
    expect(v.sleeps).toEqual([100]);
  });

  it('P2 AC-wait: an already-terminal task returns without sleeping', async () => {
    const { deps, id, taskStore } = setup();
    taskStore.updateStatus(id, 'running');
    taskStore.updateStatus(id, 'completed', { result: 'r' });
    const v = virtual();
    const out = await resultToolWait({ task_id: id, wait_ms: 5_000 }, deps, v.sleep, v.now);
    expect(out.status).toBe('completed');
    expect(v.sleeps).toEqual([]);
  });

  it('P2 AC-wait-cap: wait_ms is clamped to 55000 (never rejected): total virtual sleep is exactly the cap', async () => {
    expect(RESULT_MAX_WAIT_MS).toBe(55_000);
    const { deps, id } = setup();
    const v = virtual();
    const out = await resultToolWait({ task_id: id, wait_ms: 10 * 60_000 }, deps, v.sleep, v.now);
    expect(out.status).toBe('pending');
    expect(v.sleeps.reduce((a, b) => a + b, 0)).toBe(55_000);
    expect(v.sleeps.length).toBe(550);
  });

  it('P2 AC-wait: projection via fields still applies after a wait', async () => {
    const { deps, id } = setup();
    const v = virtual();
    const out = await resultToolWait({ task_id: id, wait_ms: 100, fields: ['status'] }, deps, v.sleep, v.now);
    expect(Object.keys(out).sort()).toEqual(['id', 'status']);
  });
});
