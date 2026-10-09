/**
 * c536ce29 (wire/ops tracing, segment W2) — core-ops events in the `agent-mcp.ops` channel file.
 *
 *   c536ce29 TRC-AC10  a REAL orchestrator run (real HookRegistry, real migrated DB + SessionStore,
 *                      real ops log channel writing a real file; only the LLM provider and the MCP
 *                      client boundary are scripted) yields session/task/turn/tool events with the
 *                      right ids and non-negative durations
 *   c536ce29 TRC-AC11  an allowlist-denied tool call yields a `tool.denied` ops event naming the
 *                      tool and the reason (and a permission-gate denial does too); a plain fault
 *                      yields NO denial event
 *
 * Negative control: the same run WITHOUT `registerOpsLog` leaves no lifecycle events, so the
 * assertions fail if the hook subscription is removed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HookRegistry } from '@adhd/agent-base-types';
import type { ExecutionContext, Message } from '@adhd/agent-base-types';
import { SessionStore } from '@adhd/agent-store-runtime';
import {
  Orchestrator,
  PolicyEngine,
  ToolError,
  agentCreateInputSchema,
} from '@adhd/agent-engine-orchestrator';
import type {
  LLMProvider,
  McpClientRegistry,
  OrchestratorSessionStore,
  OrchestratorTaskStore,
  ProviderChatResponse,
} from '@adhd/agent-engine-orchestrator';

import { agentMcpEnvironmentSpec, resolveLogRoots, type AgentMcpConfig } from '../config.js';
import { argsSha256, componentOf, registerOpsLog, splitToolName } from '../ops-log.js';
import { AgentStore } from '../store/agent-store.js';
import { createLogChannels, type IAgentMcpChannels } from '../wire/channels.js';
import { Environment } from '@adhd/environment';
import { openDb, type ITestDb } from './pricing-fixtures.js';

type Rec = Record<string, unknown>;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => void | Promise<void>)();
});

/** A real ops channel over an isolated environment root; returns a reader of its events. */
function opsFixture(): { channels: IAgentMcpChannels; events(): Promise<Rec[]> } {
  const adhdRoot = realpathSync(mkdtempSync(join(tmpdir(), 'trc-w2-ops-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'trc-w2-opscwd-')));
  cleanups.push(() => rmSync(adhdRoot, { recursive: true, force: true }), () => rmSync(cwd, { recursive: true, force: true }));
  const env = new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, { namespace: 'production', adhdRoot, cwd });
  const roots = resolveLogRoots(env);
  const channels = createLogChannels({ roots, logging: env.config.logging, stderr: { write: () => undefined } });
  cleanups.push(() => channels.close());
  return {
    channels,
    async events() {
      await channels.flush();
      const files = readdirSync(roots.ops).filter((f) => f.endsWith('.jsonl'));
      return files.flatMap((f) =>
        readFileSync(join(roots.ops, f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Rec)
      );
    },
  };
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const policy = { check: () => undefined } as unknown as PolicyEngine;
const taskStore: OrchestratorTaskStore = { updateStatus: () => undefined, appendEvent: () => undefined, unregisterCancellation: () => undefined };
const sessionStub: OrchestratorSessionStore = { appendMessage: async () => undefined, close: () => undefined };

/** Registry whose shell client resolves/rejects with the next scripted outcome. */
function registryOf(outcomes: Array<Error | string>): McpClientRegistry {
  let n = 0;
  return {
    listAllTools: async () => [
      { name: 'shell__shell_execute', description: 'run', inputSchema: { type: 'object', properties: {} } },
    ],
    closeAll: async () => undefined,
    getClient: async () => ({
      callTool: async () => {
        const o = outcomes[Math.min(n++, outcomes.length - 1)] as Error | string;
        if (o instanceof Error) throw o;
        return [{ type: 'text', text: o }];
      },
    }),
  } as unknown as McpClientRegistry;
}

/** `toolTurns` shell tool-call turns, then one completed turn. */
function providerOf(toolTurns: number): LLMProvider {
  let call = 0;
  const now = () => new Date().toISOString();
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      const sessionId = randomUUID();
      if (call++ >= toolTurns) {
        return {
          message: { id: randomUUID(), sessionId, role: 'assistant', content: 'done', createdAt: now() },
          stopReason: 'completed',
          usage: { inputTokens: 11, outputTokens: 5 },
        } as ProviderChatResponse;
      }
      return {
        message: {
          id: randomUUID(),
          sessionId,
          role: 'assistant',
          content: '',
          toolCalls: [{ id: randomUUID(), server: 'shell', tool: 'shell_execute', arguments: { argv: ['echo', 'hi'] } }],
          createdAt: now(),
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 7, outputTokens: 3 },
      } as ProviderChatResponse;
    },
  };
}

interface IRun {
  readonly ctx: ExecutionContext;
  readonly db: ITestDb;
  readonly sessionId: string;
  readonly hooks: HookRegistry;
}

/** Real DB + real AgentStore/SessionStore on `hooks`; runs the real Orchestrator to completion. */
async function drive(
  hooks: HookRegistry,
  opts: { toolTurns: number; outcomes: Array<Error | string> }
): Promise<IRun> {
  const db = openDb();
  cleanups.push(() => db.sqlite.close());
  const agentStore = new AgentStore(db.db, hooks);
  const sessionStore = new SessionStore(db.db, hooks);
  agentStore.create(
    agentCreateInputSchema.parse({ name: 'ops-agent', provider: { type: 'claudecli' }, systemPrompt: 'be brief' })
  );
  const def = agentStore.read('ops-agent');
  const session = sessionStore.create({ agentName: 'ops-agent', agentDefinition: def });
  const ctx: ExecutionContext = {
    taskId: randomUUID(),
    sessionId: session.id,
    agentName: 'ops-agent',
    agentDefinition: def,
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const user: Message = {
    id: randomUUID(),
    sessionId: session.id,
    role: 'user',
    content: 'go',
    createdAt: new Date().toISOString(),
  };
  const { result } = await new Orchestrator().run({
    executionContext: ctx,
    messages: [user],
    registry: registryOf(opts.outcomes),
    provider: providerOf(opts.toolTurns),
    policy,
    taskStore,
    sessionStore: sessionStub,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    hooks,
    logger: silentLogger,
  });
  expect(result).toBe('done');
  sessionStore.close(session.id);
  return { ctx, db, sessionId: session.id, hooks };
}

const named = (events: Rec[], name: string): Rec[] => events.filter((e) => e['event'] === name);

describe('c536ce29 TRC-AC10 a real orchestrator run yields session/task/turn/tool ops events', () => {
  it('c536ce29 TRC-AC10 session.created, task.start, 3 turns, 2 tool calls, task.completed, session.closed with correct ids and non-negative durations', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, channels.ops);
    const run = await drive(hooks, { toolTurns: 2, outcomes: ['ran'] });

    const all = await events();
    const { taskId } = run.ctx;
    const sid = run.sessionId;

    expect(named(all, 'session.created')).toMatchObject([{ session_id: sid, agent: 'ops-agent' }]);
    expect(named(all, 'session.closed')).toMatchObject([{ session_id: sid }]);

    expect(named(all, 'task.start')).toMatchObject([{ task_id: taskId, session_id: sid, agent: 'ops-agent', root_task_id: taskId }]);

    const turnStarts = named(all, 'turn.start');
    const turnEnds = named(all, 'turn.end');
    expect(turnStarts.map((e) => e['turn'])).toEqual([1, 2, 3]);
    expect(turnEnds.map((e) => e['turn'])).toEqual([1, 2, 3]);
    for (const e of [...turnStarts, ...turnEnds]) {
      expect(e).toMatchObject({ task_id: taskId, session_id: sid });
    }
    for (const e of turnEnds) {
      expect(e['duration_ms'] as number).toBeGreaterThanOrEqual(0);
      expect(e['compute_ms'] as number).toBeGreaterThanOrEqual(0);
    }
    expect(turnEnds.map((e) => e['stop_reason'])).toEqual(['tool_calls', 'tool_calls', 'completed']);

    const tools = named(all, 'tool.call');
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t).toMatchObject({ task_id: taskId, session_id: sid, server: 'shell', tool: 'shell_execute', is_error: false, is_denial: false });
      expect(t['args_sha256']).toBe(argsSha256({ argv: ['echo', 'hi'] }));
      expect(t['duration_ms'] as number).toBeGreaterThanOrEqual(0);
      expect(typeof t['call_id']).toBe('string');
    }
    expect(new Set(tools.map((t) => t['call_id'])).size).toBe(2);

    const done = named(all, 'task.completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ task_id: taskId, session_id: sid, turns: 3, input_tokens: 7 + 7 + 11, output_tokens: 3 + 3 + 5 });
    expect(done[0]?.['duration_ms'] as number).toBeGreaterThanOrEqual(0);
    expect(named(all, 'tool.denied')).toEqual([]);

    // Order: start precedes completion; every event carries the process envelope.
    const order = all.map((e) => e['event']);
    expect(order.indexOf('task.start')).toBeLessThan(order.indexOf('task.completed'));
    for (const e of all) expect(e).toMatchObject({ pid: process.pid, stream: 'agent-mcp.ops', schema: 1 });
  });

  it('c536ce29 TRC-AC10 negative control: without registerOpsLog the same run leaves no lifecycle events', async () => {
    const { events } = opsFixture();
    await drive(new HookRegistry(), { toolTurns: 2, outcomes: ['ran'] });
    const all = await events();
    for (const name of ['session.created', 'task.start', 'turn.start', 'tool.call', 'task.completed']) {
      expect(named(all, name)).toEqual([]);
    }
  });

  it('c536ce29 TRC-AC10 a failing task logs task.failed with the error and a lazily-resolved channel is honoured', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, () => channels.ops); // thunk form
    const ctx = { taskId: 't-fail', sessionId: 's1', agentName: 'a', recursionDepth: 1, parentTaskId: 'p1', rootTaskId: 'r1' } as unknown as ExecutionContext;
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('task:failed', { executionContext: ctx, error: 'kaboom' });
    const all = await events();
    expect(named(all, 'task.failed')).toMatchObject([{ task_id: 't-fail', error: 'kaboom', level: 'warn', parent_task_id: 'p1', root_task_id: 'r1' }]);
    expect(named(all, 'dispatch.delegate')).toMatchObject([{ parent_task_id: 'p1', child_task_id: 't-fail', depth: 1 }]);
  });
});

describe('c536ce29 TRC-AC11 denials are logged with the tool and the reason', () => {
  it('c536ce29 TRC-AC11 an allowlist-denied shell call yields tool.denied naming the tool and the reason', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, channels.ops);
    const denial = new ToolError(
      'MCP_CLIENT_ERROR',
      `Tool 'shell_execute' on server 'shell' returned an error: ${JSON.stringify([{ type: 'text', text: 'Command not allowed: frobnicate' }])}`
    );
    const run = await drive(hooks, { toolTurns: 1, outcomes: [denial] });

    const all = await events();
    const denied = named(all, 'tool.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      server: 'shell',
      tool: 'shell_execute',
      rule: 'allowlist',
      task_id: run.ctx.taskId,
      level: 'warn',
    });
    expect(String(denied[0]?.['reason'])).toContain('Command not allowed: frobnicate');
    // The same call is also recorded as a (denial) tool.call.
    expect(named(all, 'tool.call')).toMatchObject([{ is_error: true, is_denial: true, tool: 'shell_execute' }]);
  });

  it('c536ce29 TRC-AC11 negative control: an ordinary tool fault is a tool.call error and NOT a tool.denied', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, channels.ops);
    await drive(hooks, { toolTurns: 1, outcomes: [new Error('disk on fire')] });
    const all = await events();
    expect(named(all, 'tool.denied')).toEqual([]);
    expect(named(all, 'tool.call')).toMatchObject([{ is_error: true, is_denial: false }]);
  });

  it('c536ce29 TRC-AC11 a permission-gate denial yields tool.denied with the rule, a default reason, and nothing for an allow', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, channels.ops);
    const ctx = { taskId: 't-perm', sessionId: 's', agentName: 'a', recursionDepth: 0 } as unknown as ExecutionContext;
    const base = { executionContext: ctx, server: 'fs', tool: 'write_file', callId: 'c-1', qualifiedToolName: 'fs__write_file' };
    await hooks.emit('permission:decision', { ...base, action: 'allow', resolution: 'allow' });
    await hooks.emit('permission:decision', { ...base, action: 'deny', resolution: 'deny' });
    await hooks.emit('permission:decision', { ...base, callId: 'c-2', action: 'ask', resolution: 'suspend', reason: 'needs a human' });
    const denied = named(await events(), 'tool.denied');
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ server: 'fs', tool: 'write_file', rule: 'permission', call_id: 'c-1', task_id: 't-perm' });
    expect(String(denied[0]?.['reason'])).toContain('deny');
    expect(denied[1]).toMatchObject({ call_id: 'c-2', resolution: 'suspend', reason: 'needs a human' });
  });
});

describe('c536ce29 TRC-AC18 every ops record carries component, level, event, pid and stream', () => {
  it('c536ce29 TRC-AC18: each hook-derived event name is emitted with component+level+event+pid+stream', async () => {
    const { channels, events } = opsFixture();
    const hooks = new HookRegistry();
    registerOpsLog(hooks, () => channels.ops);
    const ctx = { taskId: 't1', sessionId: 's1', agentName: 'a', parentTaskId: 'p1', rootTaskId: 'p1', recursionDepth: 1 } as unknown as ExecutionContext;
    const emit = (e: Parameters<typeof hooks.emit>[0], p: Record<string, unknown>) => hooks.emit(e, p as never);
    const session = { id: 's1', agentName: 'a', agentVersion: 1 };

    await emit('session:created', { session });
    await emit('task:start', { executionContext: ctx, messages: [] });
    await emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await emit('post:model_response', { executionContext: ctx, stopReason: 'completed', toolCallCount: 0, computeMs: 1 });
    await emit('pre:tool_call', { executionContext: ctx, callId: 'c1', toolName: 'shell__x', toolInput: {} });
    await emit('post:tool_call', { executionContext: ctx, callId: 'c1', toolName: 'shell__x', toolInput: {}, isError: true, isDenial: true, result: 'Command not allowed: x', estResultTokens: 1 });
    await emit('permission:decision', { executionContext: ctx, callId: 'c2', server: 'fs', tool: 'w', action: 'deny', resolution: 'deny' });
    await emit('budget:warning', { executionContext: ctx, field: 'tokens', maximum: 1, current: 2, message: 'm' });
    await emit('hitl:suspend', { executionContext: ctx, kind: 'ask', parkedTaskId: 'k1' });
    await emit('hitl:resume', { executionContext: ctx, parkedTaskId: 'k1', outcome: 'approved' });
    await emit('provider:failed', { executionContext: ctx, correlationId: 'x', failure: { providerType: 'p', wireModel: 'm', class: 'c', retryable: false }, disposition: 'give_up' });
    await emit('task:completed', { executionContext: ctx, result: 'r' });
    await emit('task:failed', { executionContext: { ...ctx, taskId: 't2' }, error: 'boom' });
    await emit('task:cancelled', { executionContext: { ...ctx, taskId: 't3' } });
    await emit('session:closed', { session });

    const all = (await events()).filter((e) => !String(e['event']).startsWith('log.'));
    const expected = [
      'session.created', 'task.start', 'dispatch.delegate', 'turn.start', 'turn.end', 'tool.call', 'tool.denied',
      'cap.trip', 'hitl.suspend', 'hitl.resume', 'provider.error', 'task.completed', 'task.failed', 'task.cancelled', 'session.closed',
    ];
    expect([...new Set(all.map((e) => e['event']))].sort()).toEqual([...expected].sort());
    for (const e of all) {
      expect(e).toMatchObject({
        component: componentOf(String(e['event'])),
        level: expect.stringMatching(/^(info|warn|error)$/),
        event: expect.any(String),
        pid: process.pid,
        stream: 'agent-mcp.ops',
      });
    }
    expect(componentOf('tool.denied')).toBe('tool');
    expect(componentOf('bare')).toBe('bare');
  });
});

describe('c536ce29 ops-log helpers', () => {
  it('c536ce29 TRC-AC10 splitToolName splits on the first double underscore; argsSha256 is stable and total', () => {
    expect(splitToolName('shell__shell_execute')).toEqual({ server: 'shell', tool: 'shell_execute' });
    expect(splitToolName('bare')).toEqual({ server: '', tool: 'bare' });
    expect(argsSha256({ a: 1 })).toBe(argsSha256({ a: 1 }));
    expect(argsSha256({ a: 1 })).not.toBe(argsSha256({ a: 2 }));
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(argsSha256(circular)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('c536ce29 TRC-AC10 handlers never throw into the engine when the channel is broken', async () => {
    const hooks = new HookRegistry();
    registerOpsLog(hooks, () => {
      throw new Error('channel gone');
    });
    const ctx = { taskId: 't', sessionId: 's', agentName: 'a', recursionDepth: 0 } as unknown as ExecutionContext;
    await expect(hooks.emit('task:start', { executionContext: ctx, messages: [] })).resolves.toBeUndefined();
    await expect(hooks.emit('task:completed', { executionContext: ctx, result: 'r' })).resolves.toBeUndefined();
  });
});
