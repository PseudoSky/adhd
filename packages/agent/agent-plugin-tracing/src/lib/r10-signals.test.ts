/**
 * guards: a replayed hook sequence stops producing an attribute of the product-spec section 5 table through the real
 *   tracing plugin and file sink, an unsupplied optional field is recorded as 0 / "undefined" instead of absent, or
 *   agent.task model_ms / tool_ms / idle_ms miscount overlapping tool calls.
 * tier: S (real plugin, HookRegistry and file sink on a temporary log directory; no provider, no socket, no subprocess)
 * cites: R10 S5 AC1, R10 S5 AC4
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, PreToolCallPayload } from '@adhd/agent-base-types';
import { createPlugin } from '../index.js';
import type { TracingPlugin } from '../index.js';
import { unionMs } from './runtime.js';
import { HookRegistry, makeLogDir, readRecords } from '../test/harness.js';
import type { Recorded } from '../test/harness.js';

/**
 * R10 S5 (trace signals): every attribute the product spec section 5 table names is produced from a
 * replayed hook sequence through the REAL plugin, `HookRegistry` and `@adhd/sox-telemetry` file sink.
 * Tests cite acceptance criteria as `R10 S5 AC<n>`:
 *
 *   AC1 a replayed hook sequence produces each attribute of the spec table (table-driven)
 *   (AC0 and AC3-AC5 live in r10-dispatch-trace.e2e.test.ts, AC2 in exporter-failure.test.ts: they need a real dispatch)
 */

let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
});
afterEach(() => {
  vi.restoreAllMocks();
  log.dispose();
});

function ctxOf(taskId: string, extra: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    taskId,
    sessionId: 's1',
    agentName: 'replay-agent',
    agentDefinition: {} as ExecutionContext['agentDefinition'],
    recursionDepth: 0,
    toolCallCount: 0,
    ...extra,
  } as ExecutionContext;
}

async function installed() {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'r10-signals', logDir: log.dir } });
  await plugin.install(hooks);
  return { hooks, plugin };
}

/** The span records the sink wrote (not the metrics snapshots) under the throwaway log dir. */
function readSpanRecords(dir: string): Recorded[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !n.includes('metrics-snapshot'))
    .sort()
    .flatMap((n) => readRecords(join(dir, n)));
}

/** Close the plugin (every terminal record reaches the sink) and read every span record. */
async function settled(plugin: TracingPlugin): Promise<Recorded[]> {
  await plugin.dispose();
  return readSpanRecords(log.dir);
}

const find = (recs: Recorded[], event: string): Recorded | undefined => recs.find((r) => r.event === event);

describe('R10 S5 AC1 — a replayed hook sequence produces every spec-table attribute', () => {
  /** [record, attribute, expected value] — transcribed from spec section 5, names exactly as written. */
  const TABLE: ReadonlyArray<readonly [string, string, unknown]> = [
    ['agent.tool_call.start', 'agent.tool.concurrency_class', 'barrier'],
    ['agent.tool_call.start', 'agent.tool.turn_index', 0],
    // group_index and queued_ms are engine-final only once the call has run, so they live on the finish record
    ['agent.tool_call.finish', 'agent.tool.group_index', 1],
    ['agent.tool_call.finish', 'agent.tool.queued_ms', 17],
    ['agent.tool_call.finish', 'agent.tool.error_class', 'policy_rejected'],
    ['agent.tool_call.finish', 'agent.tool.result_bytes', 77],
    ['agent.tool_call.finish', 'agent.tool.note_appended', true],
    ['agent.model_call.finish', 'agent.model_call.ttfb_ms', 123],
    ['agent.model_call.finish', 'agent.model_call.thinking_config', 'adaptive'],
    ['agent.model_call.finish', 'agent.model_call.thinking_blocks', 2],
    ['agent.model_call.finish', 'agent.model_call.tool_result_bytes_in', 4096],
    ['agent.model_call.finish', 'agent.model_call.turn_index', 0],
    ['agent.task.startup.finish', 'agent.startup.mcp_connect_ms.fs', 12],
    ['agent.task.startup.finish', 'agent.startup.mcp_connect_ms.agent-mcp', 30],
    ['agent.task.startup.finish', 'agent.startup.tools_ready_ms', 45],
    ['agent.task.startup.finish', 'agent.startup.queue_wait_ms', 5],
    ['agent.task.startup.finish', 'agent.startup.session_ms', 3],
    ['agent.task.startup.finish', 'agent.startup.tools', 9],
    ['agent.dispatch.finish', 'agent.dispatch.mode', 'sync'],
    ['agent.dispatch.finish', 'agent.dispatch.kind', 'task'],
    ['agent.dispatch.finish', 'agent.dispatch.children', 2],
    ['agent.dispatch.finish', 'agent.dispatch.child_task_ids', 'c1,c2'],
    ['agent.dispatch.finish', 'agent.dispatch.parent_blocked_ms', 251],
    ['agent.dispatch.finish', 'agent.dispatch.wait_ms', 80],
    ['agent.dispatch.finish', 'agent.dispatch.call_id', 'call-1'],
    ['agent.background.delivered.finish', 'agent.background.child_task_id', 'c1'],
    ['agent.background.delivered.finish', 'agent.background.latency_ms', 9],
    ['agent.background.delivered.finish', 'agent.background.consumed_via', 'delivery'],
  ];

  async function replay(): Promise<Recorded[]> {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t1');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    await hooks.emit('task:startup', {
      executionContext: ctx,
      mcpConnectMs: { fs: 12, 'agent-mcp': 30 },
      toolsReadyMs: 45,
      queueWaitMs: 5,
      sessionMs: 3,
      toolCount: 9,
    });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] } as never);
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'tool_calls',
      toolCallCount: 1,
      computeMs: 10,
      ttfbMs: 123,
      thinkingConfig: 'adaptive',
      thinkingBlocks: 2,
      toolResultBytesIn: 4096,
      turnIndex: 0,
    } as never);
    await hooks.emit('pre:tool_call', {
      executionContext: ctx,
      toolName: 'agent-mcp__task',
      callId: 'call-1',
      toolInput: { prompt: 'x' },
      concurrencyClass: 'barrier',
      turnIndex: 0,
      groupIndex: 1,
      queuedMs: 17.4,
    });
    await hooks.emit('dispatch:completed', {
      executionContext: ctx,
      kind: 'task',
      mode: 'sync',
      childTaskIds: ['c1', 'c2'],
      parentBlockedMs: 250.6,
      waitMs: 80,
    });
    await hooks.emit('post:tool_call', {
      executionContext: ctx,
      toolName: 'agent-mcp__task',
      callId: 'call-1',
      toolInput: {},
      result: {},
      isError: false,
      estResultTokens: 3,
      errorClass: 'policy_rejected',
      resultBytes: 77,
      noteAppended: true,
    });
    await hooks.emit('background:delivered', { executionContext: ctx, childTaskId: 'c1', latencyMs: 9.2, consumedVia: 'delivery' });
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    return settled(plugin);
  }

  it('R10 S5 AC1: each (record, attribute, value) row of the spec table is present', async () => {
    const recs = await replay();
    const missing = TABLE.filter(([event, attr, expected]) => find(recs, event)?.[attr] !== expected).map(
      ([event, attr, expected]) => ({ event, attr, expected, actual: find(recs, event)?.[attr] })
    );
    expect(missing).toEqual([]);
  });

  it('R10 S5 AC1: the new spans carry the parent-chain identity attributes readers group on', async () => {
    const recs = await replay();
    for (const name of ['agent.dispatch.finish', 'agent.task.startup.finish', 'agent.background.delivered.finish']) {
      const r = find(recs, name);
      expect({ name, task: r?.['agent.task_id'], root: r?.['agent.root_task_id'], depth: r?.['agent.recursion_depth'] }).toEqual({
        name,
        task: 't1',
        root: 't1',
        depth: 0,
      });
    }
  });

  it('R10 S5 AC1: an optional field the emitter did not supply leaves the attribute absent (never 0 or "undefined")', async () => {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t2');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] } as never);
    await hooks.emit('post:model_response', { executionContext: ctx, stopReason: 'completed', toolCallCount: 1, computeMs: 1 } as never);
    await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'fs__read', callId: 'c', toolInput: {} });
    await hooks.emit('post:tool_call', { executionContext: ctx, toolName: 'fs__read', callId: 'c', toolInput: {}, result: {}, isError: false, estResultTokens: 1 });
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    const recs = await settled(plugin);
    const optional = [
      'agent.tool.concurrency_class', 'agent.tool.turn_index', 'agent.tool.group_index', 'agent.tool.queued_ms',
      'agent.tool.error_class', 'agent.tool.result_bytes', 'agent.tool.note_appended',
      'agent.model_call.ttfb_ms', 'agent.model_call.thinking_config', 'agent.model_call.thinking_blocks',
      'agent.model_call.tool_result_bytes_in', 'agent.model_call.turn_index',
    ];
    const present = recs.flatMap((r) => optional.filter((k) => k in r).map((k) => `${r.event}:${k}`));
    expect(present).toEqual([]);
  });

  it('R10 S5 AC1: a startup figure the engine did not measure is absent from agent.task.startup (never a guessed 0)', async () => {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t7');
    await hooks.emit('task:startup', { executionContext: ctx, mcpConnectMs: { 'we ird/name': 4.6 }, toolsReadyMs: 20.4, toolCount: 3 } as never);
    const r = find(await settled(plugin), 'agent.task.startup.finish');
    expect(r?.['agent.startup.tools_ready_ms']).toBe(20);
    expect(r?.['agent.startup.tools']).toBe(3);
    expect(r?.['agent.startup.mcp_connect_ms.we_ird_name']).toBe(5);
    expect(['agent.startup.queue_wait_ms', 'agent.startup.session_ms'].filter((k) => k in (r ?? {}))).toEqual([]);
  });

  it('R10 S5 AC1: an OpenAI-shaped model call (no thinking, no ttfb, no cache fields) records only what exists: absent, never null / NaN / a guess', async () => {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t8');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [{ role: 'user', content: 'hi' }], tools: [] } as never);
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      computeMs: 12,
      tokenUsage: { inputTokens: 5, outputTokens: 2 },
      responseModel: 'gpt-4o-mini',
      // a sloppy provider adapter: explicit nulls / NaN / Infinity instead of omitting the field
      ttfbMs: null,
      thinkingConfig: undefined,
      thinkingBlocks: Number.NaN,
      toolResultBytesIn: Number.POSITIVE_INFINITY,
      turnIndex: 0,
    } as never);
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    const call = find(await settled(plugin), 'agent.model_call.finish');
    expect(call?.['agent.model_call.stop_reason']).toBe('stop');
    expect(call?.['agent.model_call.input_tokens']).toBe(5);
    expect(call?.['agent.model_call.turn_index']).toBe(0);
    const absent = ['ttfb_ms', 'thinking_config', 'thinking_blocks', 'tool_result_bytes_in'].filter((k) => `agent.model_call.${k}` in (call ?? {}));
    expect(absent).toEqual([]);
  });

  it('R10 S5 AC4: OpenAI-shaped payloads (tool_calls arguments, message content, tool result) never reach a record by replay', async () => {
    const SECRET = { content: 'SENTINEL-MSG-CONTENT-1f2e', args: 'SENTINEL-TOOLCALLS-ARGS-3c4d', result: 'SENTINEL-TOOL-RESULT-5a6b' };
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t9');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [
        { role: 'user', content: SECRET.content },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'fs__read', arguments: JSON.stringify({ path: SECRET.args }) } }] },
        { role: 'tool', content: SECRET.result, toolCallId: 'c1' },
      ],
      tools: [],
    } as never);
    await hooks.emit('post:model_response', { executionContext: ctx, stopReason: 'tool_calls', toolCallCount: 1, computeMs: 3, responseModel: 'gpt-4o-mini' } as never);
    await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'fs__read', callId: 'c1', toolInput: { path: SECRET.args } });
    await hooks.emit('post:tool_call', {
      executionContext: ctx,
      toolName: 'fs__read',
      callId: 'c1',
      toolInput: { path: SECRET.args },
      result: { content: [{ type: 'text', text: SECRET.result }] },
      isError: false,
      estResultTokens: 4,
      resultBytes: SECRET.result.length,
    });
    await hooks.emit('dispatch:completed', { executionContext: ctx, kind: 'task', mode: 'sync', childTaskIds: ['k'], parentBlockedMs: 1 });
    await hooks.emit('task:completed', { executionContext: ctx, result: SECRET.result });
    const text = (await settled(plugin)).map((r) => JSON.stringify(r)).join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(Object.entries(SECRET).filter(([, v]) => text.includes(v)).map(([k]) => k)).toEqual([]);
    expect(text).toContain('agent.tool.args_sha256');
  });

  it('R10 S5 AC1: the new counters count barrier waits (queued_ms > 0) and sync / background dispatches', async () => {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t3');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    for (const [callId, queuedMs] of [['a', 12], ['b', 0], ['c', undefined], ['d', 0.5]] as const) {
      const pre = { executionContext: ctx, toolName: 'x__y', callId, toolInput: {} } as PreToolCallPayload;
      await hooks.emit('pre:tool_call', pre);
      // the engine completes queuedMs on the emitted payload object when the call starts, after the event fired
      if (queuedMs !== undefined) pre.queuedMs = queuedMs;
      await hooks.emit('post:tool_call', { executionContext: ctx, toolName: 'x__y', callId, toolInput: {}, result: {}, isError: false, estResultTokens: 1 });
    }
    const base = { executionContext: ctx, kind: 'task' as const, childTaskIds: ['k'], parentBlockedMs: 1 };
    await hooks.emit('dispatch:completed', { ...base, mode: 'sync' });
    await hooks.emit('dispatch:completed', { ...base, mode: 'sync' });
    await hooks.emit('dispatch:completed', { ...base, mode: 'background', parentBlockedMs: 0 });
    const c = plugin.counters();
    expect({ barrier: c.tool_barrier_waits_total, sync: c.dispatch_sync_total, background: c.dispatch_background_total }).toEqual({
      barrier: 2,
      sync: 2,
      background: 1,
    });
    await plugin.dispose();
  });

  it('R10 S5 AC1: agent.dispatch.call_id is stamped only when exactly one dispatch tool call is open on the parent', async () => {
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t4');
    await hooks.emit('task:start', { executionContext: ctx } as never);
    const pre = (callId: string, toolName: string) =>
      hooks.emit('pre:tool_call', { executionContext: ctx, toolName, callId, toolInput: {} });
    const done = { executionContext: ctx, kind: 'task' as const, mode: 'sync' as const, childTaskIds: ['k'], parentBlockedMs: 1 };
    await pre('only', 'agent-mcp__task');
    await pre('plain', 'fs__read'); // not a dispatch tool: must not make the correlation ambiguous
    await hooks.emit('dispatch:completed', done);
    await pre('second', 'agent-mcp__tasks_batch'); // now two dispatch calls are open: ambiguous
    await hooks.emit('dispatch:completed', done);
    const recs = (await settled(plugin)).filter((r) => r.event === 'agent.dispatch.finish');
    expect(recs.map((r) => r['agent.dispatch.call_id'])).toEqual(['only', undefined]);
  });
});

describe('R10 S5 AC1 — agent.task wall-time attribution (model_ms / tool_ms / idle_ms)', () => {
  it('R10 S5 AC1: overlapping tool calls are counted once and idle_ms is the wall time neither model nor tool covered', async () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const { hooks, plugin } = await installed();
    const ctx = ctxOf('t5');
    const at = async (ms: number, fn: () => Promise<void>): Promise<void> => {
      t = ms;
      await fn();
    };
    await at(0, () => hooks.emit('task:start', { executionContext: ctx } as never));
    await at(10, () => hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] } as never));
    await at(30, () => hooks.emit('post:model_response', { executionContext: ctx, stopReason: 'tool_calls', toolCallCount: 2, computeMs: 20 } as never));
    const tool = (callId: string) => ({ executionContext: ctx, toolName: 'fs__read', callId, toolInput: {} });
    const post = (callId: string) => ({ ...tool(callId), result: {}, isError: false, estResultTokens: 1 });
    await at(30, () => hooks.emit('pre:tool_call', tool('A')));
    await at(35, () => hooks.emit('pre:tool_call', tool('B')));
    await at(50, () => hooks.emit('post:tool_call', post('A')));
    await at(60, () => hooks.emit('post:tool_call', post('B')));
    await at(100, () => hooks.emit('task:completed', { executionContext: ctx, result: 'ok' }));
    const end = find(await settled(plugin), 'agent.task.finish');
    // model 10..30 = 20; tools 30..60 (A and B overlap) = 30, not 35; busy 50 of 100 wall => idle 50.
    expect({ model: end?.['agent.task.model_ms'], tool: end?.['agent.task.tool_ms'], idle: end?.['agent.task.idle_ms'] }).toEqual({
      model: 20,
      tool: 30,
      idle: 50,
    });
  });

  it('R10 S5 AC1: unionMs counts overlap once, ignores inverted intervals, and handles the empty set', () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([[0, 10], [5, 20], [30, 40]])).toBe(30);
    expect(unionMs([[0, 10], [2, 4]])).toBe(10);
    expect(unionMs([[9, 3]])).toBe(0);
  });

  it('R10 S5 AC1: a task first seen mid-flight (no task:start) reports no model_ms / tool_ms / idle_ms', async () => {
    const { hooks, plugin } = await installed();
    await hooks.emit('task:completed', { executionContext: ctxOf('t6'), result: 'ok' });
    const end = find(await settled(plugin), 'agent.task.finish');
    expect(end).toBeDefined();
    expect(['agent.task.model_ms', 'agent.task.tool_ms', 'agent.task.idle_ms'].filter((k) => k in (end ?? {}))).toEqual([]);
  });
});
