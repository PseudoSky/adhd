import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginFactory } from '@adhd/agent-base-types';
import { resolveHitl } from '@adhd/agent-engine-orchestrator';
import defaultExport, {
  CORE_MAPPINGS,
  TracingPlugin,
  configSchema,
  createPlugin,
  pointSpanMapping,
} from '../index.js';
import {
  HookRegistry,
  Orchestrator,
  agentRecords,
  eventSeen,
  makeCtx,
  makeEnv,
  makeLogDir,
  readRecords,
  readSnapshots,
  runInput,
  scriptedProvider,
  spanCounts,
  withDeadline,
} from '../test/harness.js';
import type { Recorded, RunOpts } from '../test/harness.js';

/**
 * TRACE-3 (backlog 6ae794fe). Tests cite acceptance criteria as `6ae794fe AC<n>`:
 *
 *   AC1 package scaffolded at the plugin tier with correct tags; registry-loadable
 *   AC2 `default` / `createPlugin` export satisfies `PluginFactory`
 *   AC3 each core operation emits exactly one start/finish span to the durable sink
 *
 * Post-merge blind-review fixes (see review-fixes.test.ts): AC7 F1 by_tool prototype keys,
 * AC8 F2 no state resurrection after task end, AC9 F3 dispose closes open spans, AC10 F6 snapshot
 * rate limit, AC11 F7 no latency for partial tasks.
 *
 * Real components: the plugin through a real `HookRegistry`, the real `Orchestrator.run()` with
 * TRACE-2's emit sites, real better-sqlite3 stores, and a real `@adhd/sox-telemetry` JSONL sink.
 * Only the LLM provider and the MCP tool registry are scripted.
 */

let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
});
afterEach(() => log.dispose());

async function installed(options?: ConstructorParameters<typeof TracingPlugin>[1]) {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'tracing-test', logDir: log.dir } }, options);
  await plugin.install(hooks);
  return { hooks, plugin };
}

/** The consumer-visible trace: every record the durable sink holds. */
const records = (plugin: TracingPlugin): Recorded[] => readRecords(plugin.telemetry?.currentLogFilePath());

/** Drive one real task (tool call + completion) and close the session. */
async function driveTask(hooks: HookRegistry, o: { gate?: RunOpts['gate'] } = {}) {
  const env = makeEnv(hooks);
  const ctx = makeCtx(env);
  const executed: string[] = [];
  const result = await new Orchestrator().run(runInput(env, ctx, { gate: o.gate ?? (() => 'allow'), executed }));
  // `session:closed` is emitted fire-and-forget by the store; await the event itself.
  const closed = eventSeen(hooks, 'session:closed');
  env.sessionStore.close(env.sessionId);
  await withDeadline(closed, 'session:closed');
  return { env, ctx, result, executed };
}

/** The AC3 contract, shared with its negative control so the assertion's teeth are provable. */
export function assertEveryCoreOperationSpanned(recs: Recorded[]): void {
  for (const span of ['agent.session', 'agent.task', 'agent.model_call', 'agent.tool_call', 'agent.permission.decision']) {
    const c = spanCounts(recs, span);
    const expectedStarts = span === 'agent.model_call' ? 2 : 1;
    expect({ span, ...c }).toEqual({ span, start: expectedStarts, finish: expectedStarts, error: 0 });
  }
}

describe('6ae794fe AC1 — scaffold at the plugin tier, registry-loadable', () => {
  it('6ae794fe AC1: project.json carries domain:agent, pkg-kind:plugin, platform:node', () => {
    const project = JSON.parse(readFileSync(join(__dirname, '../../project.json'), 'utf8')) as { tags: string[] };
    expect(project.tags).toEqual(expect.arrayContaining(['domain:agent', 'pkg-kind:plugin', 'platform:node']));
  });

  it('6ae794fe AC1: loads the way the host loader does — configSchema.safeParse → factory(ctx) → install(hooks)', async () => {
    // Mirrors loadOnePlugin (agent-engine-orchestrator/src/plugins/loader.ts): validate rawConfig,
    // call `createPlugin ?? default` with { db, config }, then `await plugin.install(hooks)`.
    const parsed = configSchema.safeParse({ service: 'loader-test', logDir: log.dir });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const factory: PluginFactory = createPlugin;
    const plugin = await factory({ db: {}, config: parsed.data });
    const hooks = new HookRegistry();
    await plugin.install(hooks);
    expect(plugin.name).toBe('agent-plugin-tracing');
    await (plugin as TracingPlugin).dispose();
  });

  it('6ae794fe AC1: default-on — an empty config is valid and there is no enable/disable switch', () => {
    expect(configSchema.safeParse({}).success).toBe(true);
    expect(configSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(Object.keys(configSchema.shape).some((k) => /enabled/i.test(k))).toBe(false);
  });
});

describe('6ae794fe AC2 — default / createPlugin satisfy PluginFactory', () => {
  it('6ae794fe AC2: default and named createPlugin are the same PluginFactory and return a Plugin', async () => {
    const asFactory: PluginFactory = defaultExport;
    expect(defaultExport).toBe(createPlugin);
    const plugin = await asFactory({ db: null, config: {} });
    expect(plugin.name).toBe('agent-plugin-tracing');
    expect(typeof plugin.install).toBe('function');
  });

  it('6ae794fe AC2: the factory rejects config the schema rejects', () => {
    expect(() => createPlugin({ db: null, config: { logSink: 'stdout' } })).toThrow();
  });
});

describe('6ae794fe AC3 — each core operation emits exactly one start/finish span', () => {
  it('6ae794fe AC3: a real task emits one span per session, task, model call, tool call and permission decision', async () => {
    const { hooks, plugin } = await installed();
    const { result, executed } = await driveTask(hooks);
    expect(result.result).toBe('finished');
    expect(executed).toEqual(['agent-mcp__task']);

    const recs = records(plugin);
    assertEveryCoreOperationSpanned(recs);
    // Every agent.* record is accounted for by the five core spans — nothing stray.
    const names = new Set(agentRecords(recs).map((r) => r.event.replace(/\.(start|finish|error)$/, '')));
    expect([...names].sort()).toEqual(
      ['agent.model_call', 'agent.permission.decision', 'agent.session', 'agent.task', 'agent.tool_call'].sort()
    );
    await plugin.dispose();
  });

  it('6ae794fe AC3: spans carry correlation — one trace_id across the task tree, distinct from the session span', async () => {
    const { hooks, plugin } = await installed();
    const { ctx } = await driveTask(hooks);
    const recs = records(plugin);
    const taskStart = recs.find((r) => r.event === 'agent.task.start');
    const toolFinish = recs.find((r) => r.event === 'agent.tool_call.finish');
    expect(taskStart?.['agent.task_id']).toBe(ctx.taskId);
    expect(taskStart?.trace_id).toBeTruthy();
    expect(toolFinish?.trace_id).toBe(taskStart?.trace_id);
    expect(toolFinish?.['agent.tool.name']).toBe('agent-mcp__task');
    await plugin.dispose();
  });

  it('6ae794fe AC3: .start is durable BEFORE the operation ends (hang-visible), .finish carries duration_ms', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks);
    const ctx = makeCtx(env);
    // Park the task in a HITL ask so the task / tool-call spans are demonstrably still open.
    const parked = eventSeen(hooks, 'hitl:suspend');
    const run = new Orchestrator().run(runInput(env, ctx, { gate: () => 'ask' }));
    await withDeadline(parked, 'hitl:suspend');
    const mid = records(plugin);
    expect(spanCounts(mid, 'agent.task')).toEqual({ start: 1, finish: 0, error: 0 });
    expect(resolveHitl(ctx.taskId, 'approve')).toBe(true);
    await withDeadline(run, 'run settles');
    const end = records(plugin);
    expect(spanCounts(end, 'agent.task')).toEqual({ start: 1, finish: 1, error: 0 });
    expect(typeof end.find((r) => r.event === 'agent.task.finish')?.duration_ms).toBe('number');
    await plugin.dispose();
  });

  it('6ae794fe AC3: deny and ask→suspend→approve record permission + HITL spans, with wait_ms on resume', async () => {
    const { hooks, plugin } = await installed();
    const env = makeEnv(hooks);
    const ctx = makeCtx(env);
    const parked = eventSeen(hooks, 'hitl:suspend');
    const run = new Orchestrator().run(runInput(env, ctx, { gate: () => 'ask' }));
    await withDeadline(parked, 'hitl:suspend');
    resolveHitl(ctx.taskId, 'approve');
    await withDeadline(run, 'run settles');

    const recs = records(plugin);
    expect(spanCounts(recs, 'agent.hitl.suspend')).toEqual({ start: 1, finish: 1, error: 0 });
    expect(spanCounts(recs, 'agent.hitl.resume')).toEqual({ start: 1, finish: 1, error: 0 });
    const decision = recs.find((r) => r.event === 'agent.permission.decision.finish');
    expect(decision).toMatchObject({ 'agent.permission.action': 'ask', 'agent.permission.resolution': 'suspend' });
    const resume = recs.find((r) => r.event === 'agent.hitl.resume.finish');
    expect(resume).toMatchObject({ 'agent.hitl.outcome': 'approved', 'agent.hitl.parked_task_id': ctx.taskId });
    expect(typeof resume?.['agent.hitl.wait_ms']).toBe('number');
    await plugin.dispose();
  });

  it('6ae794fe AC3: a denied tool call records the deny decision and no tool_call span', async () => {
    const { hooks, plugin } = await installed();
    await driveTask(hooks, { gate: () => 'deny' });
    const recs = records(plugin);
    expect(recs.find((r) => r.event === 'agent.permission.decision.finish')).toMatchObject({
      'agent.permission.action': 'deny',
      'agent.permission.resolution': 'deny',
    });
    // A denied call never reaches pre:tool_call: no tool_call span of any kind exists.
    expect(spanCounts(recs, 'agent.tool_call')).toEqual({ start: 0, finish: 0, error: 0 });
    await plugin.dispose();
  });

  it('6ae794fe AC3: tool arguments are sha256-digested, never recorded, unless captureArgs', async () => {
    const hooks = new HookRegistry();
    const quiet = createPlugin({ db: null, config: { logDir: log.dir } });
    await quiet.install(hooks);
    const env = makeEnv(hooks);
    await new Orchestrator().run(
      runInput(env, makeCtx(env), {
        provider: scriptedProvider('agent-mcp', 'task', { secret: 'hunter2' }),
        gate: () => 'allow',
      })
    );
    const start = records(quiet).find((r) => r.event === 'agent.tool_call.start');
    expect(String(start?.['agent.tool.args_sha256'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(records(quiet))).not.toContain('hunter2');
    expect(start?.['agent.tool.args']).toBeUndefined();
    await quiet.dispose();
  });
});

describe('metrics — agent_tracing snapshot section (rates derived by the reader)', () => {
  it('6ae794fe AC3: counters reach metrics.snapshot.sections.agent_tracing', async () => {
    const { hooks, plugin } = await installed();
    await driveTask(hooks);
    type Section = ReturnType<TracingPlugin['counters']>;
    // Explicit flush: writes one snapshot now and resolves when it is on disk — no polling.
    await plugin.flushSnapshot();
    const snaps = readSnapshots(log.dir);
    const last = snaps[snaps.length - 1] as (Recorded & { sections?: { agent_tracing?: Section } }) | undefined;
    const section: Section | undefined = last?.sections?.agent_tracing;
    expect(section).toBeDefined();
    expect(section).toMatchObject({
      sessions: { created: 1, closed: 1 },
      tasks: { started: 1, completed: 1, failed: 0, cancelled: 0 },
      model_calls: 2,
      tool_calls: { total: 1, errors: 0 },
      tokens: { input: 31, output: 8 },
      permission: { allow: 1, ask: 0, deny: 0 },
    });
    expect(section?.by_tool['agent-mcp__task']).toEqual({ calls: 1, errors: 0 });
    await plugin.dispose();
  });
});

describe('negative controls — the assertions have teeth', () => {
  it('plugin absent → zero agent.* records (spec AC)', async () => {
    // Same real task, same real telemetry directory, but the plugin is never installed.
    const hooks = new HookRegistry();
    await driveTask(hooks);
    expect(readdirSync(log.dir)).toEqual([]);
    // Positive control: with the plugin installed the same directory is populated.
    const { hooks: hooks2, plugin } = await installed();
    await driveTask(hooks2);
    expect(agentRecords(records(plugin)).length).toBeGreaterThan(0);
    expect(readdirSync(log.dir).length).toBeGreaterThan(0);
    await plugin.dispose();
  });

  it('removing the tool_call mapping turns the AC3 contract red', async () => {
    const mappings = CORE_MAPPINGS.filter((m) => m.event !== 'pre:tool_call' && m.event !== 'post:tool_call');
    const { hooks, plugin } = await installed({ mappings });
    await driveTask(hooks);
    expect(() => assertEveryCoreOperationSpanned(records(plugin))).toThrow();
    await plugin.dispose();
  });

  it('removing the permission mapping turns the AC3 contract red', async () => {
    const mappings = CORE_MAPPINGS.filter((m) => m.event !== 'permission:decision');
    const { hooks, plugin } = await installed({ mappings });
    await driveTask(hooks);
    expect(() => assertEveryCoreOperationSpanned(records(plugin))).toThrow();
    await plugin.dispose();
  });
});

describe('forward compatibility — new event families are rows, not restructuring', () => {
  it('an extra pointSpanMapping on an existing event is traced with no change to the core table', async () => {
    // Stand-in for a future family member: any event key becomes a span by appending one mapping.
    // `message:appended` is a real, already-typed hook event with no core mapping.
    const extra = pointSpanMapping(
      'message:appended',
      'agent.message.appended',
      (p) => ({ 'agent.message.role': p.message.role }),
      (p) => p.executionContext
    );
    const { hooks, plugin } = await installed({ extraMappings: [extra] });
    const env = makeEnv(hooks);
    await hooks.emit('message:appended', {
      executionContext: makeCtx(env),
      message: { id: 'm1', sessionId: env.sessionId, role: 'assistant', content: 'hi', createdAt: new Date().toISOString() },
    });
    const recs = records(plugin);
    expect(spanCounts(recs, 'agent.message.appended')).toEqual({ start: 1, finish: 1, error: 0 });
    expect(recs.find((r) => r.event === 'agent.message.appended.finish')).toMatchObject({
      'agent.message.role': 'assistant',
    });
    await plugin.dispose();
  });
});
