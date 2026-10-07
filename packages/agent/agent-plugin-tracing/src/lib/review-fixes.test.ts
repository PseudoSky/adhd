import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@adhd/agent-base-types';
import { MAX_ENDED_TASKS } from './runtime.js';
import { SnapshotThrottle } from './snapshot-throttle.js';
import { TracingCounters } from './counters.js';
import { createPlugin } from '../index.js';
import type { TracingPlugin, TracingPluginOptions } from '../index.js';
import { HookRegistry, agentRecords, makeCtx, makeEnv, makeLogDir, readRecords, spanCounts } from '../test/harness.js';
import type { Recorded } from '../test/harness.js';

/**
 * Post-merge blind-review fixes for TRACE-3 (backlog 6ae794fe). Acceptance criteria continue the
 * ticket's numbering (AC1-AC6 are in its AC note):
 *
 *   AC7  F1 by_tool / hitl.by_outcome survive keys that collide with Object.prototype members
 *   AC8  F2 late events for an ended task never resurrect per-task state (no leak)
 *   AC9  F3 dispose() closes every open session/task/model/tool span as agent.outcome "unclosed"
 *   AC10 F6 activity snapshots written on task terminals are rate-limited (deterministically)
 *   AC11 F7 a task first seen mid-flight (no task:start) records no latency observation
 *
 * Real components: the plugin through a real HookRegistry (+ real session store for sessions) and a
 * real @adhd/sox-telemetry JSONL sink. The clock/timer/writer of the snapshot throttle are injected
 * fakes: no sleeps, no wall-clock.
 */

let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
});
afterEach(() => log.dispose());

async function installed(options?: TracingPluginOptions) {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'review-fixes', logDir: log.dir } }, options);
  await plugin.install(hooks);
  return { hooks, plugin };
}

const records = (plugin: TracingPlugin): Recorded[] => readRecords(plugin.telemetry?.currentLogFilePath());

/** A distinct task id sharing the real context's session/agent. */
const withId = (ctx: ExecutionContext, taskId: string, extra: Partial<ExecutionContext> = {}): ExecutionContext => ({
  ...ctx,
  taskId,
  ...extra,
});

const toolDone = (ctx: ExecutionContext, toolName: string, callId = 'c1', isError = false) => ({
  executionContext: ctx,
  toolName,
  callId,
  toolInput: {},
  result: 'ok',
  isError,
  estResultTokens: 1,
});

describe('6ae794fe AC7 — by_tool tolerates Object.prototype-colliding names (F1)', () => {
  const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
  const own = (o: object, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value;

  it('6ae794fe AC7: counters count every colliding tool name exactly once per call', () => {
    const c = new TracingCounters();
    for (const n of NAMES) c.toolCall(n, false, 1);
    c.toolCall('constructor', true, 1);
    const snap = c.snapshot();
    expect(snap.tool_calls).toEqual({ total: NAMES.length + 1, errors: 1 });
    expect(Object.keys(snap.by_tool).sort()).toEqual([...NAMES].sort());
    expect(own(snap.by_tool, 'constructor')).toEqual({ calls: 2, errors: 1 });
    for (const n of NAMES.filter((x) => x !== 'constructor')) {
      expect(own(snap.by_tool, n)).toEqual({ calls: 1, errors: 0 });
    }
  });

  it('6ae794fe AC7: an HITL outcome named like a prototype member is counted too', () => {
    const c = new TracingCounters();
    c.hitlResume('toString');
    c.hitlResume('toString');
    expect(own(c.snapshot().hitl.by_outcome, 'toString')).toBe(2);
  });

  it('6ae794fe AC7: through the real plugin + registry, post:tool_call named "constructor" reaches the counters', async () => {
    const { hooks, plugin } = await installed();
    const ctx = makeCtx(makeEnv(hooks));
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    for (const n of NAMES) await hooks.emit('post:tool_call', toolDone(ctx, n));
    const snap = plugin.counters();
    expect(snap.tool_calls.total).toBe(NAMES.length);
    expect(Object.keys(snap.by_tool).sort()).toEqual([...NAMES].sort());
    await plugin.dispose();
  });
});

describe('6ae794fe AC8 — late events do not resurrect per-task state (F2)', () => {
  it('6ae794fe AC8: post:tool_call / permission / hitl:resume / model+tool requests after task end leave every table empty', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks);
    const ctx = makeCtx(env);
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('hitl:suspend', {
      executionContext: ctx,
      kind: 'permission_ask',
      parkedTaskId: ctx.taskId,
      resumeToken: 't',
    });
    await hooks.emit('task:cancelled', { executionContext: ctx });
    // Whatever is still parked for a cancelled task is released with it.
    expect(plugin.stateSizes()).toMatchObject({ tasks: 0, traces: 0, suspended: 0 });

    // The racing late events.
    await hooks.emit('post:tool_call', toolDone(ctx, 'agent-mcp__task'));
    await hooks.emit('permission:decision', {
      executionContext: ctx,
      server: 'agent-mcp',
      tool: 'task',
      callId: 'c1',
      qualifiedToolName: 'agent-mcp__task',
      action: 'ask',
      resolution: 'suspend',
    });
    await hooks.emit('hitl:resume', { executionContext: ctx, parkedTaskId: ctx.taskId, outcome: 'cancelled' });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'end_turn',
      toolCallCount: 0,
      computeMs: 1,
    });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'agent-mcp__task', callId: 'c2', toolInput: {} });

    expect(plugin.stateSizes()).toMatchObject({ tasks: 0, traces: 0, suspended: 0 });
    const recs = records(plugin);
    // No span was opened for the dead task after its terminal (it could never close)...
    expect(spanCounts(recs, 'agent.model_call')).toEqual({ start: 0, finish: 0, error: 0 });
    expect(spanCounts(recs, 'agent.tool_call')).toEqual({ start: 0, finish: 0, error: 0 });
    // ...but the late observations that need no state are still counted and recorded.
    expect(plugin.counters().tool_calls.total).toBe(1);
    expect(spanCounts(recs, 'agent.permission.decision')).toEqual({ start: 1, finish: 1, error: 0 });
    expect(spanCounts(recs, 'agent.hitl.resume')).toEqual({ start: 1, finish: 1, error: 0 });
    await plugin.dispose();
  });

  it('6ae794fe AC8: a child that ends after its root does not re-cache the root trace id', async () => {
    const { hooks, plugin } = await installed();
    const root = makeCtx(makeEnv(hooks));
    const child = withId(root, 'child-1', { parentTaskId: root.taskId, rootTaskId: root.taskId, recursionDepth: 1 });
    await hooks.emit('task:start', { executionContext: root, messages: [] });
    await hooks.emit('task:start', { executionContext: child, messages: [] });
    await hooks.emit('task:completed', { executionContext: root, result: 'r' });
    await hooks.emit('task:completed', { executionContext: child, result: 'c' });
    expect(plugin.stateSizes()).toMatchObject({ tasks: 0, traces: 0 });
    await plugin.dispose();
  });

  it('6ae794fe AC8: a duplicate terminal is dropped (first outcome wins, counted once)', async () => {
    const { hooks, plugin } = await installed();
    const ctx = makeCtx(makeEnv(hooks));
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('task:cancelled', { executionContext: ctx });
    await hooks.emit('task:completed', { executionContext: ctx, result: 'late' });
    expect(plugin.counters().tasks).toEqual({ started: 1, completed: 0, failed: 0, cancelled: 1 });
    expect(spanCounts(records(plugin), 'agent.task')).toEqual({ start: 1, finish: 1, error: 0 });
    await plugin.dispose();
  });

  it('6ae794fe AC8: the ended-id memory is bounded', async () => {
    const { hooks, plugin } = await installed({ snapshot: { write: () => undefined } });
    const ctx = makeCtx(makeEnv(hooks));
    for (let i = 0; i < MAX_ENDED_TASKS + 50; i++) {
      await hooks.emit('task:completed', { executionContext: withId(ctx, `t-${i}`), result: '' });
    }
    expect(plugin.stateSizes().ended).toBe(MAX_ENDED_TASKS);
    expect(plugin.stateSizes()).toMatchObject({ tasks: 0, traces: 0 });
    await plugin.dispose();
  });
});

describe('6ae794fe AC9 — dispose closes open spans as "unclosed" (F3)', () => {
  const SPANS = ['agent.session', 'agent.task', 'agent.model_call', 'agent.tool_call'];

  it('6ae794fe AC9: session, task, model_call and tool_call never ended each get exactly one terminal record at dispose', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks); // session:created -> agent.session.start
    const ctx = makeCtx(env);
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'agent-mcp__task', callId: 'c1', toolInput: {} });
    const path = plugin.telemetry?.currentLogFilePath();
    expect(plugin.stateSizes()).toMatchObject({ sessions: 1, tasks: 1 });
    const before = readRecords(path);
    for (const span of SPANS) expect(spanCounts(before, span)).toEqual({ start: 1, finish: 0, error: 0 });

    await plugin.dispose();

    const after = readRecords(path);
    for (const span of SPANS) {
      expect(spanCounts(after, span)).toEqual({ start: 1, finish: 1, error: 0 });
      expect(after.find((r) => r.event === `${span}.finish`)).toMatchObject({ 'agent.outcome': 'unclosed' });
    }
    expect(plugin.stateSizes()).toEqual({ sessions: 0, tasks: 0, traces: 0, suspended: 0, ended: 0 });
    // The README claim, stated as an invariant over the whole sink: every .start has a terminal record.
    const names = new Set(agentRecords(after).map((r) => r.event.replace(/\.(start|finish|error)$/, '')));
    for (const n of names) {
      const c = spanCounts(after, n);
      expect(c.start).toBe(c.finish + c.error);
    }
  });

  it('6ae794fe AC9: dispose is idempotent and a span that closed normally is not re-closed', async () => {
    const { hooks, plugin } = await installed();
    const ctx = makeCtx(makeEnv(hooks));
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    const path = plugin.telemetry?.currentLogFilePath();
    await plugin.dispose();
    await plugin.dispose();
    const recs = readRecords(path);
    expect(spanCounts(recs, 'agent.task')).toEqual({ start: 1, finish: 1, error: 0 });
    expect(recs.find((r) => r.event === 'agent.task.finish')).toMatchObject({ 'agent.outcome': 'completed' });
  });
});

describe('6ae794fe AC10 — activity snapshots are rate-limited (F6)', () => {
  /** A fake clock + manual timer; `write` records the clock at each snapshot. */
  function fakes(minIntervalMs = 1000) {
    let now = 0;
    let timer: { fn: () => void; at: number } | undefined;
    const writes: number[] = [];
    return {
      deps: {
        minIntervalMs,
        now: () => now,
        schedule: (fn: () => void, ms: number) => {
          timer = { fn, at: now + ms };
          return () => {
            timer = undefined;
          };
        },
        write: () => void writes.push(now),
      },
      writes,
      advance(ms: number) {
        now += ms;
        if (timer !== undefined && timer.at <= now) {
          const { fn } = timer;
          timer = undefined;
          fn();
        }
      },
      timerArmed: () => timer !== undefined,
    };
  }

  it('6ae794fe AC10: N terminals inside the window write one leading snapshot, then ONE trailing one', () => {
    const f = fakes();
    const t = new SnapshotThrottle(f.deps);
    for (let i = 0; i < 50; i++) t.request();
    expect(f.writes).toEqual([0]); // leading edge only
    expect(f.timerArmed()).toBe(true);
    f.advance(999);
    expect(f.writes).toEqual([0]); // still inside the window
    f.advance(1);
    expect(f.writes).toEqual([0, 1000]); // trailing write, exactly one
    expect(f.timerArmed()).toBe(false);
    f.advance(5000);
    expect(f.writes).toEqual([0, 1000]); // nothing pending -> nothing more
  });

  it('6ae794fe AC10: a request after the window writes immediately; flush() and dispose() drain pending', async () => {
    const f = fakes();
    const t = new SnapshotThrottle(f.deps);
    t.request();
    f.advance(1000);
    t.request();
    expect(f.writes).toEqual([0, 1000]);
    t.request(); // coalesced
    expect(t.hasPending).toBe(true);
    await t.flush();
    expect(f.writes).toEqual([0, 1000, 1000]);
    expect(t.hasPending).toBe(false);
    t.request(); // coalesced again
    await t.dispose();
    expect(f.writes).toHaveLength(4);
    await t.dispose();
    expect(f.writes).toHaveLength(4);
  });

  it('6ae794fe AC10: through the real plugin, 20 real task terminals write 1 snapshot (+1 trailing at dispose), not 20', async () => {
    const f = fakes(10_000);
    const { hooks, plugin } = await installed({ snapshot: f.deps });
    const ctx = makeCtx(makeEnv(hooks));
    for (let i = 0; i < 20; i++) {
      const c = withId(ctx, `task-${i}`);
      await hooks.emit('task:start', { executionContext: c, messages: [] });
      await hooks.emit('task:completed', { executionContext: c, result: '' });
    }
    expect(plugin.counters().tasks.completed).toBe(20);
    expect(f.writes).toEqual([0]);
    await plugin.dispose(); // the coalesced trailing snapshot is not lost
    expect(f.writes).toHaveLength(2);
  });
});

describe('6ae794fe AC11 — no latency for a task first seen mid-flight (F7)', () => {
  it('6ae794fe AC11: a terminal with no task:start counts the task but records no latency observation', async () => {
    const { hooks, plugin } = await installed();
    const ctx = makeCtx(makeEnv(hooks));
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    const snap = plugin.counters();
    expect(snap.tasks.completed).toBe(1);
    expect(snap.latency_ms.task).toEqual({ count: 0, sum_ms: 0, max_ms: 0 });
    await plugin.dispose();
  });

  it('6ae794fe AC11: positive control - with task:start the latency is observed', async () => {
    const { hooks, plugin } = await installed();
    const ctx = makeCtx(makeEnv(hooks));
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('task:completed', { executionContext: ctx, result: 'ok' });
    expect(plugin.counters().latency_ms.task.count).toBe(1);
    await plugin.dispose();
  });
});
