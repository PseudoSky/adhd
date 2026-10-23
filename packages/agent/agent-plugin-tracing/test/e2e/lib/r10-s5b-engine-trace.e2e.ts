/**
 * guards: the signals the engine populates stop reaching the trace from a real run (turn_index, tool_result_bytes_in
 *   against the request body on the wire, thinking_config / thinking_blocks, startup queue_wait_ms / session_ms only
 *   when measured, each concurrent dispatch's own call_id, the result-wait dispatch), or a figure is guessed as 0.
 * tier: P (binds a loopback HTTP port for the provider adapters; the `e2e` lane, ADR 0009;
 *   no subprocess)
 * gap: This cannot be observed at tier S because the expected figures come from the request bodies the real provider
 *   adapters put on a real HTTP socket, which a replayed hook payload does not carry.
 * cites: R10 S5b AC1, AC2, AC3, AC4, AC5
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@adhd/agent-base-types';
import { createPlugin } from '../../../src/index.js';
import type { TracingPlugin } from '../../../src/index.js';
import { HookRegistry, makeLogDir, readRecords } from '../../helpers/harness.js';
import type { Recorded } from '../../helpers/harness.js';
import { runParentScript, startFakeProvider } from '../../helpers/dispatch-harness.js';
import type { DispatchRun, FakeOpenAI, FakeReply, ParentCall, ProviderKind, WorkerOptions } from '../../helpers/dispatch-harness.js';

/**
 * R10 S5b: the signals the ENGINE populates reach the trace from a real run, for BOTH provider families.
 * Real: the plugin, `HookRegistry`, two `Orchestrator.run()` loops, `taskTool` / `tasksBatch` /
 * `resultToolWait`, better-sqlite3 stores, the REAL provider adapter (OpenAI Chat Completions, then
 * Anthropic Messages streaming) over loopback HTTP, the `@adhd/sox-telemetry` file sink. Scripted: the
 * parent's LLM turns and the loopback server standing in for the paid provider API. Every test runs once per
 * provider family; the loopback records the request bodies, so the expected figures come from the wire.
 *
 *   AC1 agent.model_call carries turn_index, tool_result_bytes_in, thinking_config (anthropic),
 *       thinking_blocks (anthropic); an OpenAI response has no thinking_* and (unmeasured) no ttfb_ms
 *   AC2 agent.task.startup carries queue_wait_ms / session_ms exactly when computable, else absent
 *   AC3 two concurrent dispatch tool calls on one parent: each agent.dispatch has ITS call_id
 *   AC4 a `result` wait emits an agent.dispatch (kind result) with wait_ms
 *   AC5 content rule: no prompt / reply / thinking / signature / tool-argument sentinel in any record
 *
 * (The engine-side hook payload proof is agent-engine-orchestrator's r10-s5b-engine-trace.test.ts.)
 */

const SENTINEL = {
  prompt: 'SENTINEL-PROMPT-4de1c0',
  reply: 'SENTINEL-WORKER-REPLY-7aa93f',
  arg: 'SENTINEL-ARG-91c2b8',
  toolArg: 'SENTINEL-TOOLCALL-ARG-c07e12',
  thinking: 'SENTINEL-THINKING-5d0e77',
  signature: 'SENTINEL-SIGNATURE-b3a4c9',
};

const KINDS: readonly ProviderKind[] = ['openai', 'anthropic'];

function spanRecords(dir: string): Recorded[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !n.includes('metrics-snapshot'))
    .sort()
    .flatMap((n) => readRecords(join(dir, n)));
}

const named = (recs: Recorded[], event: string): Recorded[] => recs.filter((r) => r.event === event);
const attr = (r: Recorded | undefined, key: string): unknown => r?.[key];
const forTask = (recs: Recorded[], taskId: string): Recorded[] => recs.filter((r) => attr(r, 'agent.task_id') === taskId);

/** A worker whose turn 1 asks for a tool it does not have (the engine answers with an error result) and turn 2 answers. */
function toolThenText(reasoning?: string): (n: number) => FakeReply {
  return (n) =>
    n === 1
      ? { content: '', toolCall: { name: 'fs__read', arguments: { path: SENTINEL.toolArg } }, ...(reasoning !== undefined ? { reasoning, signature: SENTINEL.signature } : {}) }
      : { content: SENTINEL.reply };
}

/** The bytes of tool-result content a request body carried, read off the WIRE (not recomputed by the engine). */
function wireToolResultBytes(kind: ProviderKind, body: Record<string, unknown> | undefined): number {
  const messages = (body?.['messages'] as Array<Record<string, unknown>> | undefined) ?? [];
  let bytes = 0;
  for (const m of messages) {
    if (kind === 'openai' && m['role'] === 'tool') bytes += Buffer.byteLength(m['content'] as string);
    if (kind === 'anthropic' && Array.isArray(m['content'])) {
      for (const block of m['content'] as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_result') bytes += Buffer.byteLength(block['content'] as string);
      }
    }
  }
  return bytes;
}

for (const kind of KINDS) {
  describe(`R10 S5b [${kind} worker]`, () => {
    let log: ReturnType<typeof makeLogDir>;
    let fake: FakeOpenAI;
    let script: (n: number) => FakeReply;
    beforeEach(async () => {
      log = makeLogDir();
      script = toolThenText(kind === 'anthropic' ? SENTINEL.thinking : undefined);
      fake = await startFakeProvider(kind, (n) => script(n));
    });
    afterEach(async () => {
      await fake.close();
      log.dispose();
    });

    async function traced(turns: ParentCall[][], worker: WorkerOptions = {}) {
      const hooks = new HookRegistry();
      const plugin: TracingPlugin = createPlugin({ db: null, config: { service: 'r10-s5b', logDir: log.dir } });
      await plugin.install(hooks);
      const run: DispatchRun = await runParentScript(hooks, fake.baseURL, turns, kind, worker);
      await untilQuiet(run);
      await plugin.dispose();
      return { run, plugin, recs: spanRecords(log.dir) };
    }
    /** Every task row the run created reached a terminal status (bounded, event-loop turns only). */
    async function untilQuiet(run: DispatchRun): Promise<void> {
      const terminal = new Set(['completed', 'failed', 'cancelled']);
      const ids = (rows: unknown): string[] => (rows as Array<{ id: string }>).map((r) => r.id);
      for (let i = 0; i < 200_000; i++) {
        const all = ids(run.env.taskStore.list({} as never));
        if (all.every((id) => terminal.has(run.env.taskStore.read(id).status))) return;
        await new Promise<void>((r) => setImmediate(r));
      }
      throw new Error('tasks never reached a terminal status');
    }

    const single = (prompt = SENTINEL.prompt): ParentCall[][] => [[{ id: 'call-1', tool: 'task', args: { agent_name: 'worker-agent', prompt } }]];
    const workerIdOf = (run: DispatchRun): string => (run.toolResults[0] as { task_id: string }).task_id;
    const callsOf = (recs: Recorded[], taskId: string): Recorded[] => named(forTask(recs, taskId), 'agent.model_call.finish');

    it(`R10 S5b AC1 [${kind}]: model_call carries turn_index and tool_result_bytes_in equal to what the request put on the wire; turn_index matches the tool calls that response requested`, async () => {
      const { run, recs } = await traced(single());
      expect(run.toolErrors).toEqual([]);
      const calls = callsOf(recs, workerIdOf(run));
      expect(calls.map((c) => attr(c, 'agent.model_call.turn_index'))).toEqual([0, 1]);
      const bodies = fake.bodies();
      expect(bodies).toHaveLength(2);
      const expected = bodies.map((b) => wireToolResultBytes(kind, b));
      expect(expected[0]).toBe(0);
      expect(expected[1]).toBeGreaterThan(0); // the tool-error result really crossed the wire on turn 2
      expect(calls.map((c) => attr(c, 'agent.model_call.tool_result_bytes_in'))).toEqual(expected);
      // The tool call response 0 requested belongs to model turn 0: the two indexes agree.
      const toolStart = named(forTask(recs, workerIdOf(run)), 'agent.tool_call.start')[0];
      expect(attr(toolStart, 'agent.tool.turn_index')).toBe(attr(calls[0], 'agent.model_call.turn_index'));
    });

    if (kind === 'anthropic') {
      it('R10 S5b AC1 [anthropic]: thinking_config is the configured type and thinking_blocks counts the response blocks (1 on the thinking turn, a real 0 after)', async () => {
        const { run, recs } = await traced(single(), { thinking: { type: 'adaptive', display: 'summarized' } });
        const calls = callsOf(recs, workerIdOf(run));
        expect(fake.bodies().map((b) => b['thinking'])).toEqual([
          { type: 'adaptive', display: 'summarized' },
          { type: 'adaptive', display: 'summarized' },
        ]); // the option really was sent
        expect(calls.map((c) => attr(c, 'agent.model_call.thinking_config'))).toEqual(['adaptive', 'adaptive']);
        expect(calls.map((c) => attr(c, 'agent.model_call.thinking_blocks'))).toEqual([1, 0]);
        expect(typeof attr(calls[0], 'agent.model_call.ttfb_ms')).toBe('number'); // the streaming adapter measures it
      });

      it('R10 S5b AC1 [anthropic]: a worker with thinking disabled records thinking_config "disabled" (and the wire says so)', async () => {
        const { run, recs } = await traced(single(), { thinking: { type: 'disabled' } });
        expect(callsOf(recs, workerIdOf(run)).map((c) => attr(c, 'agent.model_call.thinking_config'))).toEqual(['disabled', 'disabled']);
        expect(fake.bodies()[0]?.['thinking']).toEqual({ type: 'disabled' });
      });

      it('R10 S5b AC1 [anthropic]: a worker with no thinking option records thinking_config "none" (the API default; no field on the wire)', async () => {
        const { run, recs } = await traced(single());
        expect(callsOf(recs, workerIdOf(run)).map((c) => attr(c, 'agent.model_call.thinking_config'))).toEqual(['none', 'none']);
        expect(fake.bodies().some((b) => 'thinking' in b)).toBe(false);
      });
    } else {
      it('R10 S5b AC1 [openai]: thinking_config, thinking_blocks and (unmeasured) ttfb_ms are ABSENT, never 0 / null; the figures that exist are present', async () => {
        script = (n) => ({ ...toolThenText()(n), reasoning: SENTINEL.thinking, signature: SENTINEL.signature }); // reasoning on the wire changes nothing
        const { run, recs } = await traced(single());
        const calls = callsOf(recs, workerIdOf(run));
        expect(calls).toHaveLength(2);
        for (const c of calls) {
          expect(['agent.model_call.thinking_config', 'agent.model_call.thinking_blocks', 'agent.model_call.ttfb_ms'].filter((k) => k in c)).toEqual([]);
          expect(typeof attr(c, 'agent.model_call.turn_index')).toBe('number');
          expect(typeof attr(c, 'agent.model_call.tool_result_bytes_in')).toBe('number');
        }
      });
    }

    it(`R10 S5b AC2 / R10 M2 [${kind}]: task:startup carries queue_wait_ms / session_ms exactly when the dispatching tool measured them: the dispatched worker has both (integers >= 0), the top-level parent (no dispatching parent) has neither, never a guessed 0`, async () => {
      const { run, recs } = await traced(single());
      const startups = named(recs, 'agent.task.startup.finish');
      expect(startups.map((s) => attr(s, 'agent.task_id')).sort()).toEqual([run.parent.taskId, workerIdOf(run)].sort());
      const wholeMs = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
      for (const s of startups) {
        expect(typeof attr(s, 'agent.startup.tools_ready_ms')).toBe('number');
        expect(typeof attr(s, 'agent.startup.tools')).toBe('number');
        if (attr(s, 'agent.task_id') === workerIdOf(run)) {
          expect(wholeMs(attr(s, 'agent.startup.queue_wait_ms')), 'worker queue_wait_ms').toBe(true);
          expect(wholeMs(attr(s, 'agent.startup.session_ms')), 'worker session_ms').toBe(true);
        } else {
          expect(['agent.startup.queue_wait_ms', 'agent.startup.session_ms'].filter((k) => k in s)).toEqual([]);
        }
      }
    });

    it(`R10 S5b AC3 [${kind}]: two concurrent dispatch tool calls on one parent: each agent.dispatch carries ITS OWN call_id`, async () => {
      const turns: ParentCall[][] = [
        [
          { id: 'call-A', tool: 'task', args: { agent_name: 'worker-agent', prompt: 'prompt-A' } },
          { id: 'call-B', tool: 'task', args: { agent_name: 'worker-agent', prompt: 'prompt-B' } },
        ],
      ];
      script = () => ({ content: SENTINEL.reply });
      const { run, recs } = await traced(turns);
      expect(run.toolErrors).toEqual([]);
      const dispatches = named(recs, 'agent.dispatch.finish');
      expect(dispatches).toHaveLength(2);
      // Both calls were open on the parent together (pre:tool_call precedes any execution): the old inference had nothing to go on.
      const openCalls = named(recs, 'agent.tool_call.start').filter((r) => attr(r, 'agent.task_id') === run.parent.taskId);
      expect(openCalls.map((r) => attr(r, 'agent.tool.call_id')).sort()).toEqual(['call-A', 'call-B']);
      // Which call dispatched which child, from the persisted task rows (the child's own prompt), not from the trace.
      const callIdByPrompt: Record<string, unknown> = {};
      for (const d of dispatches) {
        const child = String(attr(d, 'agent.dispatch.child_task_ids'));
        callIdByPrompt[run.env.taskStore.read(child).prompt] = attr(d, 'agent.dispatch.call_id');
      }
      expect(callIdByPrompt).toEqual({ 'prompt-A': 'call-A', 'prompt-B': 'call-B' });
      // And each id is a real tool_call record whose duration covers that dispatch.
      for (const d of dispatches) {
        const tool = named(recs, 'agent.tool_call.finish').find((r) => attr(r, 'agent.tool.call_id') === attr(d, 'agent.dispatch.call_id'));
        expect(tool).toBeDefined();
        expect(attr(d, 'agent.dispatch.parent_blocked_ms') as number).toBeLessThanOrEqual((tool?.duration_ms as number) + 1);
      }
    });

    it(`R10 S5b AC3 [${kind}]: a single dispatch still carries its call_id`, async () => {
      script = () => ({ content: SENTINEL.reply });
      const { recs } = await traced(single());
      expect(attr(named(recs, 'agent.dispatch.finish')[0], 'agent.dispatch.call_id')).toBe('call-1');
    });

    it(`R10 S5b AC3 [${kind}]: a tasks_batch names its own call`, async () => {
      script = () => ({ content: SENTINEL.reply });
      const { recs } = await traced([[{ id: 'call-batch', tool: 'tasks_batch', args: { agent_name: 'worker-agent', prompts: ['a', 'b'] } }]]);
      expect(attr(named(recs, 'agent.dispatch.finish')[0], 'agent.dispatch.call_id')).toBe('call-batch');
    });

    it(`R10 S5b AC4 [${kind}]: a result wait emits an agent.dispatch (kind result) with wait_ms on the waiting parent, naming its own call, and is not counted as a sync dispatch`, async () => {
      script = () => ({ content: SENTINEL.reply });
      const turns: ParentCall[][] = [
        [{ id: 'call-bg', tool: 'task', args: { agent_name: 'worker-agent', prompt: 'p', background: true } }],
        [
          {
            id: 'call-res',
            tool: 'result',
            // The child the first turn started: the task row whose parent is the waiting task.
            args: ({ env, parent }) => ({
              task_id: (env.taskStore.list({} as never) as Array<{ id: string; parentTaskId?: string }>).find((r) => r.parentTaskId === parent.taskId)?.id ?? '',
              wait_ms: 5_000,
            }),
          },
        ],
      ];
      const { run, plugin, recs } = await traced(turns);
      expect(run.toolErrors).toEqual([]);
      const child = (run.toolResults[0] as { task_id: string }).task_id;
      const dispatches = named(recs, 'agent.dispatch.finish');
      expect(dispatches.map((d) => attr(d, 'agent.dispatch.kind'))).toEqual(['agent_task', 'result']);
      const wait = dispatches[1] as Recorded;
      expect(attr(wait, 'agent.task_id')).toBe(run.parent.taskId);
      expect(attr(wait, 'agent.dispatch.mode')).toBe('sync');
      expect(attr(wait, 'agent.dispatch.child_task_ids')).toBe(child);
      expect(attr(wait, 'agent.dispatch.call_id')).toBe('call-res');
      expect(typeof attr(wait, 'agent.dispatch.wait_ms')).toBe('number');
      expect(attr(wait, 'agent.dispatch.wait_ms') as number).toBeGreaterThanOrEqual(0);
      // Only the real dispatch is counted: the result wait starts nothing.
      const c = plugin.counters();
      expect({ sync: c.dispatch_sync_total, background: c.dispatch_background_total }).toEqual({ sync: 0, background: 1 });
    });

    it(`R10 S5b AC5 [${kind}]: no sentinel planted in prompt / reply / thinking / signature / tool arguments reaches any record, with every new attribute active`, async () => {
      const { run, recs } = await traced(single(`${SENTINEL.prompt} ${SENTINEL.arg}`), { thinking: { type: 'adaptive', display: 'summarized' } });
      // The sentinels really flowed through the system (so absence below is meaningful):
      expect(JSON.stringify(run.toolResults)).toContain(SENTINEL.reply);
      expect(JSON.stringify(fake.bodies())).toContain(SENTINEL.toolArg); // the worker's own tool-call arguments crossed the wire on turn 2
      const calls = callsOf(recs, workerIdOf(run));
      expect(calls.every((c) => typeof attr(c, 'agent.model_call.turn_index') === 'number')).toBe(true); // the new attributes ARE in these records
      const text = recs.map((r) => JSON.stringify(r)).join('\n');
      expect(Object.entries(SENTINEL).filter(([, v]) => text.includes(v)).map(([k]) => k)).toEqual([]);
    });
  });
}

describe('R10 S5b AC3: agent.dispatch.call_id mapping (hook replay)', () => {
  const ctx = { taskId: 't1', sessionId: 's1', agentName: 'a', agentDefinition: {}, recursionDepth: 0, toolCallCount: 0 } as unknown as ExecutionContext;

  /** Replay one dispatch with `openCalls` dispatching tool calls open on the parent, in its own throwaway log dir. */
  async function replay(toolCallId: string | undefined, openCalls: string[]): Promise<Recorded | undefined> {
    const log = makeLogDir();
    try {
      const hooks = new HookRegistry();
      const plugin = createPlugin({ db: null, config: { service: 'r10-s5b-replay', logDir: log.dir } });
      await plugin.install(hooks);
      await hooks.emit('task:start', { executionContext: ctx } as never);
      for (const id of openCalls) {
        await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'agent-mcp__task', callId: id, toolInput: {} });
      }
      await hooks.emit('dispatch:completed', { executionContext: ctx, kind: 'task', mode: 'sync', childTaskIds: ['c'], parentBlockedMs: 1, ...(toolCallId !== undefined ? { toolCallId } : {}) });
      await plugin.dispose();
      return named(spanRecords(log.dir), 'agent.dispatch.finish')[0];
    } finally {
      log.dispose();
    }
  }

  it('R10 S5b AC3: a supplied toolCallId is used even when several dispatch calls are open (the inference would leave it empty)', async () => {
    expect(attr(await replay('call-2', ['call-1', 'call-2']), 'agent.dispatch.call_id')).toBe('call-2');
  });

  it('R10 S5b AC3: with no toolCallId the old inference stays the fallback: one open call is named, several are left absent', async () => {
    expect(attr(await replay(undefined, ['call-1']), 'agent.dispatch.call_id')).toBe('call-1');
    const ambiguous = await replay(undefined, ['call-1', 'call-2']);
    expect('agent.dispatch.call_id' in (ambiguous ?? {})).toBe(false);
  });

  it('R10 S5b AC4: a kind "result" dispatch records wait_ms and is not counted as a dispatch; its fallback correlates to an open result call only', async () => {
    const log = makeLogDir();
    try {
      const hooks = new HookRegistry();
      const plugin = createPlugin({ db: null, config: { service: 'r10-s5b-result', logDir: log.dir } });
      await plugin.install(hooks);
      await hooks.emit('task:start', { executionContext: ctx } as never);
      await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'agent-mcp__result', callId: 'r1', toolInput: {} });
      await hooks.emit('pre:tool_call', { executionContext: ctx, toolName: 'agent-mcp__task', callId: 'd1', toolInput: {} });
      await hooks.emit('dispatch:completed', { executionContext: ctx, kind: 'result', mode: 'sync', childTaskIds: ['c'], parentBlockedMs: 40.4, waitMs: 40.4 });
      const counters = plugin.counters();
      await plugin.dispose();
      const rec = named(spanRecords(log.dir), 'agent.dispatch.finish')[0];
      expect({ kind: attr(rec, 'agent.dispatch.kind'), wait: attr(rec, 'agent.dispatch.wait_ms'), call: attr(rec, 'agent.dispatch.call_id') }).toEqual({ kind: 'result', wait: 40, call: 'r1' });
      expect({ sync: counters.dispatch_sync_total, background: counters.dispatch_background_total }).toEqual({ sync: 0, background: 0 });
    } finally {
      log.dispose();
    }
  });
});
