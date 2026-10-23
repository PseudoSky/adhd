/**
 * guards: the trace of a real parent dispatching a real worker stops attributing wall time (worker spans grouped under the
 *   parent's agent.dispatch, parent_blocked_ms between worker duration and the dispatching tool_call), emits null / NaN
 *   for attributes a provider cannot supply, double-counts a batch, or leaks a prompt, reply, argument or thinking
 *   sentinel into a record.
 * tier: P (binds a loopback HTTP port for the provider adapters; the `e2e` lane, ADR 0009;
 *   no subprocess)
 * gap: This cannot be observed at tier S because the OpenAI Chat Completions and Anthropic Messages streaming adapters
 *   only produce their request and response shapes over a real HTTP socket.
 * cites: R10 S5 AC0, AC1, AC3, AC4, AC5
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlugin } from '../../../src/index.js';
import type { TracingPlugin } from '../../../src/index.js';
import { HookRegistry, makeLogDir, readRecords } from '../../helpers/harness.js';
import type { Recorded } from '../../helpers/harness.js';
import { runParentDispatch, startFakeProvider } from '../../helpers/dispatch-harness.js';
import type { DispatchRun, FakeOpenAI, FakeReply, ProviderKind } from '../../helpers/dispatch-harness.js';

/**
 * R10 S5 — a real parent task dispatches a real worker task, and the trace alone attributes the wall
 * time. Real: the plugin, `HookRegistry`, two `Orchestrator.run()` loops, `taskTool` / `tasksBatch`,
 * better-sqlite3 stores, the REAL provider adapter (OpenAI Chat Completions, then Anthropic Messages
 * streaming) over loopback HTTP, the `@adhd/sox-telemetry` file sink. Scripted: the parent's LLM turns and
 * the loopback server standing in for the paid provider API. Every test runs once per provider family.
 *
 *   AC0 the stack writes a record for the span names the engine emits, to the configured logDir
 *   AC1 (provider rule) attributes a provider cannot supply are absent, never null / NaN / mis-populated
 *   AC3 worker model_calls group under the parent's agent.dispatch; parent_blocked_ms matches the tool_call
 *   AC4 content rule: no args, results, prompts or thinking text in any emitted record
 *   AC5 one agent.dispatch per completed dispatch (emission-side proof: agent-engine-orchestrator's
 *       dispatch-completed.test.ts)
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

/** The attributes only some providers can supply; absent (never null / NaN / a guess) when they cannot. */
const PROVIDER_OPTIONAL = [
  'agent.model_call.ttfb_ms',
  'agent.model_call.thinking_config',
  'agent.model_call.thinking_blocks',
  'agent.model_call.tool_result_bytes_in',
  'agent.model_call.turn_index',
];

/** Every span record the sink wrote to `dir` (metrics snapshots excluded). */
function spanRecords(dir: string): Recorded[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !n.includes('metrics-snapshot'))
    .sort()
    .flatMap((n) => readRecords(join(dir, n)));
}

const named = (recs: Recorded[], event: string): Recorded[] => recs.filter((r) => r.event === event);
const attr = (r: Recorded | undefined, key: string): unknown => r?.[key];

/** Wait (bounded, event-loop turns only) until every task in `ids` reached a terminal status. */
async function untilTerminal(run: DispatchRun, ids: string[]): Promise<void> {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  for (let i = 0; i < 200_000; i++) {
    if (ids.every((id) => terminal.has(run.env.taskStore.read(id).status))) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error('background workers never reached a terminal status');
}

for (const kind of KINDS) {
  describe(`R10 S5 [${kind} worker]`, () => {
    let log: ReturnType<typeof makeLogDir>;
    let fake: FakeOpenAI;
    let script: (n: number) => FakeReply;
    beforeEach(async () => {
      log = makeLogDir();
      script = () => ({ content: SENTINEL.reply, reasoning: SENTINEL.thinking, signature: SENTINEL.signature });
      fake = await startFakeProvider(kind, (n) => script(n));
    });
    afterEach(async () => {
      await fake.close();
      log.dispose();
    });

    async function tracedDispatch(tool: 'task' | 'tasks_batch', args: Record<string, unknown>) {
      const hooks = new HookRegistry();
      const plugin: TracingPlugin = createPlugin({ db: null, config: { service: 'r10-dispatch', logDir: log.dir } });
      await plugin.install(hooks);
      const run = await runParentDispatch(hooks, fake.baseURL, tool, args, kind);
      // A background dispatch returns before its workers run: let them finish so the trace is complete.
      const out = (run.toolResults[0] as { results?: Array<{ task_id: string }>; task_id?: string }) ?? {};
      await untilTerminal(run, out.results?.map((r) => r.task_id) ?? (out.task_id === undefined ? [] : [out.task_id]));
      await plugin.dispose();
      return { run, plugin, recs: spanRecords(log.dir) };
    }

    it(`R10 S5 AC0 [${kind}]: every span name the engine emits for a dispatching run has a record in the configured logDir`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      expect(run.toolErrors).toEqual([]);
      // `agent.background.delivered` has no emitter yet (background auto-delivery is a later segment); its
      // mapping is proven by the replay in r10-signals.test.ts.
      const required = ['agent.task', 'agent.task.startup', 'agent.model_call', 'agent.tool_call', 'agent.dispatch'];
      expect(required.filter((name) => named(recs, `${name}.finish`).length === 0)).toEqual([]);
      expect(readdirSync(log.dir).some((n) => n.endsWith('.jsonl'))).toBe(true);
    });

    it(`R10 S5 AC0 [${kind}]: startup and tool-call signals from a real run carry the spec-table attributes`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const workerId = (run.toolResults[0] as { task_id: string }).task_id;
      const startup = named(recs, 'agent.task.startup.finish').find((r) => attr(r, 'agent.task_id') === workerId);
      expect(startup).toBeDefined();
      // The engine reports the timings it measures (tool-list readiness, tool count); queue wait and
      // session resolution happen before `Orchestrator.run` and are not in its payload.
      for (const k of ['agent.startup.tools_ready_ms', 'agent.startup.tools']) {
        expect({ k, type: typeof attr(startup, k) }).toEqual({ k, type: 'number' });
      }
      const toolStart = named(recs, 'agent.tool_call.start')[0];
      expect(['safe', 'barrier', 'unordered']).toContain(attr(toolStart, 'agent.tool.concurrency_class'));
      expect(typeof attr(toolStart, 'agent.tool.turn_index')).toBe('number');
      const toolEnd = named(recs, 'agent.tool_call.finish')[0];
      expect(attr(toolEnd, 'agent.tool.error_class')).toBe('none');
      expect(typeof attr(toolEnd, 'agent.tool.result_bytes')).toBe('number');
    });

    it(`R10 S5 AC1 [${kind}]: model-call attributes this provider cannot supply are absent or well-typed, never null / NaN`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const workerId = (run.toolResults[0] as { task_id: string }).task_id;
      const calls = named(recs, 'agent.model_call.finish').filter((r) => attr(r, 'agent.task_id') === workerId);
      expect(calls).toHaveLength(1);
      const call = calls[0] as Recorded;
      // Documented rule (README): an attribute the provider did not supply is ABSENT. Present values are typed.
      for (const k of PROVIDER_OPTIONAL) {
        if (!(k in call)) continue;
        const v = call[k];
        expect({ k, ok: v !== null && !(typeof v === 'number' && !Number.isFinite(v)) }).toEqual({ k, ok: true });
      }
      if ('agent.model_call.thinking_config' in call) expect(['none', 'adaptive', 'disabled']).toContain(call['agent.model_call.thinking_config']);
      for (const k of ['agent.model_call.ttfb_ms', 'agent.model_call.thinking_blocks', 'agent.model_call.tool_result_bytes_in', 'agent.model_call.turn_index']) {
        if (k in call) expect(typeof call[k]).toBe('number');
      }
      // The always-present attributes are the provider-independent ones.
      for (const k of ['agent.model_call.stop_reason', 'agent.model_call.input_tokens', 'agent.model_call.output_tokens', 'agent.model_call.compute_ms']) {
        expect(k in call).toBe(true);
      }
    });

    it(`R10 S5 AC3 [${kind}]: a sync dispatch is one agent.dispatch on the parent whose child ids own the worker spans`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const dispatches = named(recs, 'agent.dispatch.finish');
      expect(dispatches).toHaveLength(1);
      const d = dispatches[0] as Recorded;
      const workerId = (run.toolResults[0] as { task_id: string }).task_id;

      expect(attr(d, 'agent.dispatch.mode')).toBe('sync');
      expect(attr(d, 'agent.dispatch.kind')).toBe('agent_task');
      expect(attr(d, 'agent.dispatch.children')).toBe(1);
      expect(attr(d, 'agent.dispatch.child_task_ids')).toBe(workerId);
      expect(attr(d, 'agent.task_id')).toBe(run.parent.taskId); // the dispatch record is on the PARENT

      const workerCalls = named(recs, 'agent.model_call.finish').filter((r) => attr(r, 'agent.task_id') === workerId);
      expect(workerCalls).toHaveLength(1);
      expect(attr(workerCalls[0], 'agent.parent_task_id')).toBe(run.parent.taskId);
      expect(attr(workerCalls[0], 'agent.root_task_id')).toBe(run.parent.taskId);
      expect(workerCalls[0]?.trace_id).toBe(d.trace_id);
      const parentCalls = named(recs, 'agent.model_call.finish').filter((r) => attr(r, 'agent.task_id') === run.parent.taskId);
      expect(parentCalls).toHaveLength(2); // the parent's own calls are not grouped under the dispatch
    });

    it(`R10 S5 AC3 [${kind}]: worker task duration <= parent_blocked_ms <= the dispatching tool_call duration`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const d = named(recs, 'agent.dispatch.finish')[0] as Recorded;
      const workerId = (run.toolResults[0] as { task_id: string }).task_id;
      const workerTask = named(recs, 'agent.task.finish').find((r) => attr(r, 'agent.task_id') === workerId);
      const tool = named(recs, 'agent.tool_call.finish').find((r) => attr(r, 'agent.tool.call_id') === attr(d, 'agent.dispatch.call_id'));
      const blocked = attr(d, 'agent.dispatch.parent_blocked_ms') as number;

      expect(typeof attr(d, 'agent.dispatch.call_id')).toBe('string'); // exactly one dispatch tool call was open
      expect(tool).toBeDefined();
      // 1 ms of slack on each side: every figure is rounded to whole milliseconds independently.
      expect(blocked).toBeGreaterThanOrEqual((workerTask?.duration_ms as number) - 1);
      expect(blocked).toBeLessThanOrEqual((tool?.duration_ms as number) + 1);
      expect(blocked).toBeGreaterThan(0);
    });

    it(`R10 S5 AC3 [${kind}]: the parent agent.task attributes its wall time: tool_ms covers the blocked dispatch`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const d = named(recs, 'agent.dispatch.finish')[0] as Recorded;
      const parentEnd = named(recs, 'agent.task.finish').find((r) => attr(r, 'agent.task_id') === run.parent.taskId);
      const blocked = attr(d, 'agent.dispatch.parent_blocked_ms') as number;
      expect(attr(parentEnd, 'agent.task.tool_ms') as number).toBeGreaterThanOrEqual(blocked - 1);
      const parts = ['agent.task.model_ms', 'agent.task.tool_ms', 'agent.task.idle_ms'].map((k) => attr(parentEnd, k) as number);
      expect(parts.every((n) => typeof n === 'number' && n >= 0)).toBe(true);
      // model + tool + idle partitions the wall time (each rounded to whole ms, three terms).
      expect(Math.abs(parts.reduce((a, b) => a + b, 0) - (parentEnd?.duration_ms as number))).toBeLessThanOrEqual(3);
    });

    it(`R10 S5 AC5 [${kind}]: tasks_batch of two background items is ONE dispatch (background, tasks_batch, both child ids), parent_blocked_ms 0`, async () => {
      const { run, recs } = await tracedDispatch('tasks_batch', { agent_name: 'worker-agent', prompts: ['a', 'b'], background: true });
      const dispatches = named(recs, 'agent.dispatch.finish');
      expect(dispatches).toHaveLength(1);
      const ids = (run.toolResults[0] as { results: Array<{ task_id: string }> }).results.map((r) => r.task_id);
      expect(ids).toHaveLength(2);
      expect(attr(dispatches[0], 'agent.dispatch.kind')).toBe('tasks_batch');
      expect(attr(dispatches[0], 'agent.dispatch.mode')).toBe('background');
      expect(attr(dispatches[0], 'agent.dispatch.children')).toBe(2);
      expect(attr(dispatches[0], 'agent.dispatch.child_task_ids')).toBe(ids.join(','));
      expect(attr(dispatches[0], 'agent.dispatch.parent_blocked_ms')).toBe(0);
    });

    it(`R10 S5 AC5 [${kind}]: counters reflect the mode of each completed dispatch`, async () => {
      const { plugin } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      const c = plugin.counters();
      expect({ sync: c.dispatch_sync_total, background: c.dispatch_background_total }).toEqual({ sync: 1, background: 0 });
    });

    it(`R10 S5 AC4 [${kind}]: no sentinel planted in prompt / reply / thinking is in any record (captureArgs off)`, async () => {
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: `${SENTINEL.prompt} ${SENTINEL.arg}` });
      // The sentinels really flowed through the system (so absence below is meaningful):
      expect(JSON.stringify(run.toolResults)).toContain(SENTINEL.reply);
      expect(fake.requests()).toBeGreaterThanOrEqual(1);
      expect(recs.length).toBeGreaterThan(0);
      const text = recs.map((r) => JSON.stringify(r)).join('\n');
      expect(Object.entries(SENTINEL).filter(([, v]) => text.includes(v)).map(([k]) => k)).toEqual([]);
      expect(text).toContain('agent.tool.args_sha256'); // the one argument identity that IS recorded
    });

    it(`R10 S5 AC4 [${kind}]: the provider's own tool-call arguments (${kind === 'openai' ? 'tool_calls[].function.arguments' : 'tool_use.input'}) never reach a record`, async () => {
      // Worker turn 1 asks for a tool (the worker has none, so the engine answers with an error result),
      // turn 2 answers in text: both provider-shaped payloads cross the engine and its hooks.
      script = (n) =>
        n === 1
          ? { content: '', toolCall: { name: 'fs__read', arguments: { path: SENTINEL.toolArg } }, reasoning: SENTINEL.thinking, signature: SENTINEL.signature }
          : { content: SENTINEL.reply };
      const { run, recs } = await tracedDispatch('task', { agent_name: 'worker-agent', prompt: SENTINEL.prompt });
      expect(fake.requests()).toBe(2); // the loop really carried the tool call and went on
      expect(JSON.stringify(run.toolResults)).toContain(SENTINEL.reply);
      const text = recs.map((r) => JSON.stringify(r)).join('\n');
      expect(Object.entries(SENTINEL).filter(([, v]) => text.includes(v)).map(([k]) => k)).toEqual([]);
    });
  });
}
