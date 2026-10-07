import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '@adhd/agent-store-runtime';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import type {
  AgentDefinition,
  HookEvent,
  HookEventMap,
  IHookRegistry,
  PermissionAction,
} from '@adhd/agent-base-types';

import { HookRegistry } from '../engine/hooks.js';
import { Orchestrator, resolveHitl } from '../engine/orchestrator.js';
import type { PolicyEngine } from '../engine/policy.js';
import type {
  LLMProvider,
  ProviderChatResponse,
  ToolDefinition,
} from '../providers/types.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';

/**
 * TRACE-2 (backlog f376e27a) — the orchestrator emits `permission:decision`,
 * `hitl:suspend` and `hitl:resume` at the real permission-gate / suspension
 * sites. Tests cite acceptance criteria as `f376e27a AC<n>`:
 *
 *   AC1 each of the events is emitted at its real site
 *   AC2 emission is observational (a throwing handler / registry cannot change
 *       a task's outcome)
 *   AC3 existing orchestrator behavioural tests still pass (the whole package
 *       suite; `session:closed` is covered in agent-store-runtime)
 *
 * Real components: `Orchestrator.run()`, the engine `HookRegistry`, a real
 * better-sqlite3 `TaskStore` + `SessionStore`, the real `resolveHitl` resume
 * path. Mocked boundaries only: the LLM provider and the MCP tool registry.
 * The permission gate is the host-supplied `config.permissionGate` callback
 * (a rule-map lookup), evaluated for real by the orchestrator.
 */

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL, agent_name TEXT NOT NULL, agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL, status TEXT DEFAULT 'active' NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT, composed_prompt_id TEXT,
  provider_type TEXT, model_ref TEXT, models TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_results TEXT, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT, parent_task_id TEXT,
  is_ephemeral INTEGER DEFAULT 0 NOT NULL, recursion_depth INTEGER DEFAULT 0 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT,
  depends_on TEXT, on_upstream_failure TEXT, inputs TEXT, resume_token TEXT
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
);
CREATE TABLE task_usage (
  task_id TEXT PRIMARY KEY NOT NULL, root_task_id TEXT, agent_name TEXT NOT NULL,
  provider_type TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER DEFAULT 0 NOT NULL,
  output_tokens INTEGER DEFAULT 0 NOT NULL, tool_call_count INTEGER DEFAULT 0 NOT NULL,
  model_calls INTEGER DEFAULT 0 NOT NULL, latency_ms INTEGER DEFAULT 0 NOT NULL,
  is_complete INTEGER DEFAULT 0 NOT NULL, stop_reason TEXT, max_tokens INTEGER,
  cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
  uncached_input_tokens INTEGER, reasoning_tokens INTEGER, peak_context_tokens INTEGER,
  peak_context_at INTEGER, compute_ms INTEGER, est_tool_result_tokens INTEGER,
  est_cost_usd REAL, created_at TEXT NOT NULL
);
`;

const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const TRACE_EVENTS = [
  'permission:decision',
  'hitl:suspend',
  'hitl:resume',
] as const satisfies readonly HookEvent[];

type TraceEvent = (typeof TRACE_EVENTS)[number];
interface SeenEvent {
  event: TraceEvent;
  payload: HookEventMap[TraceEvent];
}

function agentDefinition(hitl: boolean): AgentDefinition {
  return {
    name: 'trace-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    permissions: {},
    ...(hitl ? {} : { nativeTooling: { hitl: false } }),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as AgentDefinition;
}

const GATED_TOOL: ToolDefinition = {
  name: 'agent-mcp__task',
  description: 'dispatch a sub-agent',
  inputSchema: { type: 'object', properties: {} },
};

function makeRegistry(executed: string[]): McpClientRegistry {
  return {
    listAllTools: async () => [{ ...GATED_TOOL }],
    resolveToolName: (name: string) => {
      const [server, tool] = name.split('__');
      return { server, tool };
    },
    closeAll: async () => {},
    getClient: async (server: string) => ({
      callTool: async (tool: string) => {
        executed.push(`${server}__${tool}`);
        return { ok: true };
      },
    }),
  } as unknown as McpClientRegistry;
}

/** Turn 1 → call `server__tool`; turn 2 → complete. */
function scriptedProvider(server: string, tool: string): LLMProvider {
  let turn = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      turn++;
      const base = { id: generateId(), sessionId: generateId(), createdAt: nowIso() };
      if (turn === 1) {
        return {
          message: {
            ...base,
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', server, tool, arguments: {} }],
          },
          stopReason: 'tool_calls',
        };
      }
      return {
        message: { ...base, role: 'assistant', content: 'finished' },
        stopReason: 'completed',
      };
    },
  };
}

function engineConfig(gate?: (a: { server: string; tool: string }) => PermissionAction): EngineConfig {
  const cfg: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: 'http://localhost:0' },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({}),
    resolveEnvName: () => undefined,
    isEnvNameAllowed: () => true,
  };
  if (gate) cfg.permissionGate = (ctx) => gate(ctx);
  return cfg;
}

function makeEnv(hooks: IHookRegistry = new HookRegistry()) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const seen: SeenEvent[] = [];
  const waiters = new Map<TraceEvent, Array<(p: SeenEvent) => void>>();
  for (const event of TRACE_EVENTS) {
    hooks.register(event, ((payload: HookEventMap[TraceEvent]) => {
      const rec: SeenEvent = { event, payload };
      seen.push(rec);
      const ws = waiters.get(event);
      if (ws) {
        waiters.delete(event);
        for (const w of ws) w(rec);
      }
    }) as never);
  }
  /** Resolves when `event` has fired at least `n` times (no sleeps). */
  const when = (event: TraceEvent, n = 1): Promise<SeenEvent> =>
    new Promise((resolve) => {
      const check = (): void => {
        const hits = seen.filter((s) => s.event === event);
        if (hits.length >= n) resolve(hits[n - 1]);
        else {
          const ws = waiters.get(event) ?? [];
          ws.push(check);
          waiters.set(event, ws);
        }
      };
      check();
    });
  const def = agentDefinition(true);
  const session = sessionStore.create({ agentName: def.name, agentDefinition: def });
  return { hooks, sessionStore, taskStore, session, seen, when };
}

type Env = ReturnType<typeof makeEnv>;

function makeCtx(env: Env, opts: { hitl: boolean; parentTaskId?: string; depth?: number }) {
  const task = env.taskStore.create({
    sessionId: env.session.id,
    prompt: 'go',
    ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
    recursionDepth: opts.depth ?? 0,
  });
  const ctx: ExecutionContext = {
    taskId: task.id,
    sessionId: env.session.id,
    agentName: 'trace-agent',
    agentDefinition: agentDefinition(opts.hitl) as ExecutionContext['agentDefinition'],
    recursionDepth: opts.depth ?? 0,
    toolCallCount: 0,
    ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
  };
  return ctx;
}

function runInput(
  env: Env,
  ctx: ExecutionContext,
  o: {
    gate?: (a: { server: string; tool: string }) => PermissionAction;
    server?: string;
    tool?: string;
    executed: string[];
    signal?: AbortSignal;
    suspensionAnswerable?: boolean;
  }
) {
  const message: Message = {
    id: generateId(),
    sessionId: ctx.sessionId,
    role: 'user',
    content: 'hello',
    createdAt: nowIso(),
  };
  return {
    executionContext: ctx,
    messages: [message],
    registry: makeRegistry(o.executed),
    provider: scriptedProvider(o.server ?? 'agent-mcp', o.tool ?? 'task'),
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: env.taskStore as never,
    sessionStore: env.sessionStore as never,
    signal: o.signal ?? new AbortController().signal,
    taskId: ctx.taskId,
    hooks: env.hooks,
    config: engineConfig(o.gate),
    logger: silentLogger,
    ...(o.suspensionAnswerable === undefined
      ? {}
      : { suspensionAnswerable: o.suspensionAnswerable }),
  };
}

/** Bounded await: fails loudly rather than hanging the suite. */
function withDeadline<T>(p: Promise<T>, label: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

const kinds = (env: Env): string[] => env.seen.map((s) => s.event);

describe('f376e27a AC1 — permission:decision at the real gate', () => {
  it('f376e27a AC1: allow → one decision {action:allow, resolution:allow}; tool runs', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    const result = await new Orchestrator().run(
      runInput(env, ctx, { gate: () => 'allow', executed })
    );
    expect(result.result).toBe('finished');
    expect(executed).toEqual(['agent-mcp__task']);
    expect(env.seen).toHaveLength(1);
    expect(env.seen[0].event).toBe('permission:decision');
    expect(env.seen[0].payload).toMatchObject({
      server: 'agent-mcp',
      tool: 'task',
      callId: 'call-1',
      qualifiedToolName: 'agent-mcp__task',
      action: 'allow',
      resolution: 'allow',
    });
  });

  it('f376e27a AC1: no gate configured → still an allow decision', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    await new Orchestrator().run(runInput(env, ctx, { executed }));
    expect(env.seen.map((s) => s.payload)).toEqual([
      expect.objectContaining({ action: 'allow', resolution: 'allow' }),
    ]);
  });

  it('f376e27a AC1: deny → decision {deny, deny}; tool never runs', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    await new Orchestrator().run(runInput(env, ctx, { gate: () => 'deny', executed }));
    expect(executed).toEqual([]);
    expect(env.seen).toHaveLength(1);
    expect(env.seen[0].payload).toMatchObject({
      action: 'deny',
      resolution: 'deny',
      qualifiedToolName: 'agent-mcp__task',
    });
  });

  it('f376e27a AC1: ask on an unanswerable (synchronous) call → decision {ask, deny, reason}; no HITL events', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    await new Orchestrator().run(
      runInput(env, ctx, { gate: () => 'ask', executed, suspensionAnswerable: false })
    );
    expect(executed).toEqual([]);
    expect(kinds(env)).toEqual(['permission:decision']);
    expect(env.seen[0].payload).toMatchObject({
      action: 'ask',
      resolution: 'deny',
      reason: 'the synchronous call has no reachable approver',
    });
  });
});

describe('f376e27a AC1 — hitl:suspend / hitl:resume at the suspension sites', () => {
  async function driveAsk(answer: string | 'abort') {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    const ac = new AbortController();
    const run = new Orchestrator().run(
      runInput(env, ctx, { gate: () => 'ask', executed, signal: ac.signal })
    );
    const settled = run.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e })
    );
    await withDeadline(env.when('hitl:suspend'), 'hitl:suspend');
    const parked = env.taskStore.read(ctx.taskId);
    if (answer === 'abort') ac.abort();
    else expect(resolveHitl(ctx.taskId, answer)).toBe(true);
    const outcome = await withDeadline(settled, 'run settles');
    return { env, ctx, executed, parked, outcome };
  }

  it('f376e27a AC1: ask→suspend, approved → decision, suspend (token = persisted token), resume approved; tool runs', async () => {
    const { env, ctx, executed, parked } = await driveAsk('approve');
    expect(kinds(env)).toEqual(['permission:decision', 'hitl:suspend', 'hitl:resume']);
    expect(env.seen[0].payload).toMatchObject({ action: 'ask', resolution: 'suspend' });
    const suspend = env.seen[1].payload as HookEventMap['hitl:suspend'];
    expect(suspend).toMatchObject({ kind: 'permission_ask', parkedTaskId: ctx.taskId });
    expect(suspend.escalatedFrom).toBeUndefined();
    expect(parked.status).toBe('awaiting_input');
    expect(suspend.resumeToken).toBe((parked as unknown as { resumeToken: string }).resumeToken);
    expect(env.seen[2].payload).toMatchObject({ parkedTaskId: ctx.taskId, outcome: 'approved' });
    expect(executed).toEqual(['agent-mcp__task']);
  });

  it('f376e27a AC1: ask→suspend, declined → resume outcome declined; tool never runs', async () => {
    const { env, executed } = await driveAsk('no');
    expect(env.seen[2].payload).toMatchObject({ outcome: 'declined' });
    expect(executed).toEqual([]);
  });

  it('f376e27a AC1: ask→suspend, task cancelled while parked → resume outcome cancelled', async () => {
    const { env, ctx, outcome } = await driveAsk('abort');
    expect(outcome.ok).toBe(false);
    expect(env.seen[2].payload).toMatchObject({ parkedTaskId: ctx.taskId, outcome: 'cancelled' });
  });

  it('f376e27a AC1: request_human_input → suspend kind request_human_input, resume resumed', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    const run = new Orchestrator().run(
      runInput(env, ctx, { executed, server: 'builtin', tool: 'request_human_input' })
    );
    await withDeadline(env.when('hitl:suspend'), 'hitl:suspend');
    const parked = env.taskStore.read(ctx.taskId) as unknown as { status: string; resumeToken: string };
    expect(parked.status).toBe('awaiting_input');
    expect(resolveHitl(ctx.taskId, 'my answer')).toBe(true);
    await withDeadline(run, 'run completes');
    expect(kinds(env)).toEqual(['hitl:suspend', 'hitl:resume']);
    expect(env.seen[0].payload).toMatchObject({
      kind: 'request_human_input',
      parkedTaskId: ctx.taskId,
      resumeToken: parked.resumeToken,
    });
    expect(env.seen[1].payload).toMatchObject({ parkedTaskId: ctx.taskId, outcome: 'resumed' });
  });

  it('f376e27a AC1: request_human_input cancelled while parked → resume cancelled', async () => {
    const env = makeEnv();
    const ctx = makeCtx(env, { hitl: true });
    const ac = new AbortController();
    const run = new Orchestrator()
      .run(runInput(env, ctx, { executed: [], server: 'builtin', tool: 'request_human_input', signal: ac.signal }))
      .catch(() => undefined);
    await withDeadline(env.when('hitl:suspend'), 'hitl:suspend');
    ac.abort();
    await withDeadline(run, 'run settles');
    expect(env.seen.at(-1)?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  async function driveEscalation(answer: string) {
    const env = makeEnv();
    const parentCtx = makeCtx(env, { hitl: true });
    env.taskStore.updateStatus(parentCtx.taskId, 'running');
    const child = makeCtx(env, { hitl: false, parentTaskId: parentCtx.taskId, depth: 1 });
    const executed: string[] = [];
    const run = new Orchestrator().run(runInput(env, child, { gate: () => 'ask', executed }));
    await withDeadline(env.when('hitl:suspend'), 'hitl:suspend');
    const parked = env.taskStore.read(parentCtx.taskId) as unknown as { status: string; resumeToken: string };
    expect(resolveHitl(parentCtx.taskId, answer)).toBe(true);
    await withDeadline(run, 'child run completes');
    return { env, parentId: parentCtx.taskId, childId: child.taskId, parked, executed };
  }

  it('f376e27a AC1: ask→escalate, approved → decision escalate, suspend escalation (parent parked, escalatedFrom=child), resume approved', async () => {
    const { env, parentId, childId, parked, executed } = await driveEscalation('approve');
    expect(kinds(env)).toEqual(['permission:decision', 'hitl:suspend', 'hitl:resume']);
    expect(env.seen[0].payload).toMatchObject({ action: 'ask', resolution: 'escalate' });
    const suspend = env.seen[1].payload as HookEventMap['hitl:suspend'];
    expect(suspend).toMatchObject({
      kind: 'escalation',
      parkedTaskId: parentId,
      escalatedFrom: childId,
    });
    expect(parked.status).toBe('awaiting_input');
    expect(suspend.resumeToken).toBe(parked.resumeToken);
    expect(env.seen[2].payload).toMatchObject({ parkedTaskId: parentId, outcome: 'approved' });
    expect(executed).toEqual(['agent-mcp__task']);
  });

  it('f376e27a AC1: ask→escalate, declined → resume declined; tool never runs', async () => {
    const { env, executed } = await driveEscalation('reject');
    expect(env.seen[2].payload).toMatchObject({ outcome: 'declined' });
    expect(executed).toEqual([]);
  });
});

describe('f376e27a AC2 — emission is observational', () => {
  /** Handlers throw synchronously on every trace event. */
  function throwingHandlers(env: Env): void {
    for (const event of TRACE_EVENTS) {
      env.hooks.register(event, (() => {
        throw new Error(`boom:${event}`);
      }) as never);
    }
  }

  it('f376e27a AC2: throwing handlers on all three events do not change a suspend→approve task', async () => {
    const env = makeEnv();
    throwingHandlers(env);
    const ctx = makeCtx(env, { hitl: true });
    const executed: string[] = [];
    const run = new Orchestrator().run(runInput(env, ctx, { gate: () => 'ask', executed }));
    await withDeadline(env.when('hitl:suspend'), 'hitl:suspend');
    expect(resolveHitl(ctx.taskId, 'approve')).toBe(true);
    const result = await withDeadline(run, 'run completes');
    expect(result.result).toBe('finished');
    expect(executed).toEqual(['agent-mcp__task']);
  });

  it('f376e27a AC2: a registry whose emit REJECTS for the trace events cannot break the task (allow, deny, suspend, escalate)', async () => {
    class HostileRegistry extends HookRegistry {
      override async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
        if ((TRACE_EVENTS as readonly string[]).includes(event)) throw new Error(`hostile:${event}`);
        return super.emit(event, payload);
      }
    }
    // allow
    {
      const env = makeEnv(new HostileRegistry());
      const executed: string[] = [];
      const r = await new Orchestrator().run(
        runInput(env, makeCtx(env, { hitl: true }), { gate: () => 'allow', executed })
      );
      expect(r.result).toBe('finished');
      expect(executed).toEqual(['agent-mcp__task']);
    }
    // deny
    {
      const env = makeEnv(new HostileRegistry());
      const executed: string[] = [];
      const r = await new Orchestrator().run(
        runInput(env, makeCtx(env, { hitl: true }), { gate: () => 'deny', executed })
      );
      expect(r.result).toBe('finished');
      expect(executed).toEqual([]);
    }
    // suspend → approve (events never observed; resolve once the task is parked)
    {
      const env = makeEnv(new HostileRegistry());
      const ctx = makeCtx(env, { hitl: true });
      const executed: string[] = [];
      const run = new Orchestrator().run(runInput(env, ctx, { gate: () => 'ask', executed }));
      await withDeadline(
        (async () => {
          while (env.taskStore.read(ctx.taskId).status !== 'awaiting_input') {
            await new Promise<void>((r) => setImmediate(r));
          }
        })(),
        'task parked'
      );
      expect(resolveHitl(ctx.taskId, 'approve')).toBe(true);
      expect((await withDeadline(run, 'run completes')).result).toBe('finished');
      expect(executed).toEqual(['agent-mcp__task']);
    }
    // escalate → approve
    {
      const env = makeEnv(new HostileRegistry());
      const parent = makeCtx(env, { hitl: true });
      env.taskStore.updateStatus(parent.taskId, 'running');
      const child = makeCtx(env, { hitl: false, parentTaskId: parent.taskId, depth: 1 });
      const executed: string[] = [];
      const run = new Orchestrator().run(runInput(env, child, { gate: () => 'ask', executed }));
      await withDeadline(
        (async () => {
          while (env.taskStore.read(parent.taskId).status !== 'awaiting_input') {
            await new Promise<void>((r) => setImmediate(r));
          }
        })(),
        'parent parked'
      );
      expect(resolveHitl(parent.taskId, 'approve')).toBe(true);
      expect((await withDeadline(run, 'run completes')).result).toBe('finished');
      expect(executed).toEqual(['agent-mcp__task']);
    }
  });
});
