/**
 * tracing-e2e.e2e.test.ts — TRACE-4 (backlog 0f760dcd) + TRACE-5 (backlog 5dff26e6).
 *
 * ONE scaffold, every surface:
 *   - ONE real child process: the BUILT agent-mcp (`dist/src/index.js`) over stdio, fake HOME, an
 *     isolated cwd, ZERO tracing config. A real MCP client drives the real `agent_create` / `agent` /
 *     `session_close` tools; the assertion is on the child's REAL durable sink.
 *   - ONE in-process harness (real stores / queue / orchestrator / `defaultPermissionGate`, only the
 *     LLM scripted) with the plugin loaded through the REAL `loadDefaultPlugins` from the real
 *     default entries; tasks, permission decisions, HITL suspend/resume, both fail-closed escalate
 *     denies and `session:closed` are driven through production paths.
 *
 * Acceptance criteria covered (each test cites `<uid> AC<n>`):
 *   0f760dcd AC1 fresh built boot registers + runs tracing   0f760dcd AC2 absent block loads (here, with ZERO config)
 *   5dff26e6 AC1 real sink received start/finish for real LOADED-tool operations
 *   5dff26e6 AC2 deterministic (no sleep) negative control: plugin not loaded -> zero records, and the
 *                assertion is proven to go RED on that run
 *   5dff26e6 TRACE-2 carry-ins: permission:decision via the real gate + task_resume; both escalate
 *                deny emits; session:closed via the MCP `session_close` tool
 *   5dff26e6 AC3 `scripts/audit_tracing.py` run over this very sink: exit 0 healthy, exit != 0 on a fixture with an empty path
 *   (5dff26e6 AC4 docs: docs-contract test `tracing-docs-contract.test.ts`; AC5 deferred to B-TRACE-REUSE)
 *
 * No env gate: nothing here calls a paid third-party service.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineLogger, ExecutionContext, Orchestrator, TaskDeps, AgentCreateInput } from '@adhd/agent-engine-orchestrator';

import { defaultPluginEntries } from '../../config.js';
import { loadDefaultPlugins } from '../../plugins/load-defaults.js';
import { createServer } from '../../server.js';
import { ScriptedProvider } from './scripted-provider.js';
import { buildHarness, drainQueue, taskResume, taskTool, type Harness } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
const TMP_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', 'tmp', 'agent-mcp');

interface Rec {
  event: string;
  [k: string]: unknown;
}

/** Every `agent.*` record in every JSONL file under `dir` (the durable sink, read straight off disk). */
function sinkRecords(dir: string): Rec[] {
  if (!fs.existsSync(dir)) return [];
  const out: Rec[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (line.trim().length === 0) continue;
          const rec = JSON.parse(line) as Rec;
          // ops/pino lines share the sink tree but carry no `event`; only agent.* spans are asserted on.
          if (typeof rec.event === 'string' && rec.event.startsWith('agent.')) out.push(rec);
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Await `pred(records)` with a bounded deadline — event-driven yields, never a wall-clock sleep. */
async function until(dir: string, pred: (r: Rec[]) => boolean, label: string, ms = 10_000): Promise<Rec[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = sinkRecords(dir);
    if (pred(r)) return r;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label} (have ${r.map((x) => x.event).join(', ')})`);
    await new Promise<void>((res) => setImmediate(res));
  }
}

const has = (r: Rec[], event: string, where: Record<string, unknown> = {}): boolean =>
  r.some((x) => x.event === event && Object.entries(where).every(([k, v]) => x[k] === v));

/** The contract the on-run must satisfy and the off-run (negative control) must violate. */
function assertTaskSpanned(r: Rec[], taskId: string): void {
  for (const span of ['agent.task', 'agent.model_call', 'agent.tool_call']) {
    expect(has(r, `${span}.start`, { 'agent.task_id': taskId }), `${span}.start for ${taskId}`).toBe(true);
    expect(has(r, `${span}.finish`, { 'agent.task_id': taskId }), `${span}.finish for ${taskId}`).toBe(true);
  }
}

const silentLogger: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const SELF_SERVER = { 'agent-mcp': { transport: 'stdio' as const, command: 'agent-mcp' } };

let root: string;
let logDir: string; // in-process sink
let harness: Harness; // plugin LOADED
let bare: Harness; // plugin NOT loaded (negative control)
let mcp: Client; // in-memory MCP client over the loaded harness

function createAgent(h: Harness, overrides: Partial<AgentCreateInput> = {}): string {
  const name = `trace-agent-${crypto.randomUUID()}`;
  h.agentStore.create({
    name,
    provider: { type: 'openai', model: 'test-model', baseURL: 'http://localhost:1234/v1' },
    systemPrompt: 'You are a test assistant.',
    mcpServers: SELF_SERVER,
    permissions: {},
    ...overrides,
  } as AgentCreateInput);
  return name;
}
const openSession = (h: Harness, agentName: string): string =>
  h.sessionStore.create({ agentName, agentDefinition: h.agentStore.read(agentName) }).id;
const echoThenComplete = (): ScriptedProvider =>
  new ScriptedProvider([
    { type: 'tool_calls', toolCalls: [{ server: 'agent-mcp', tool: 'echo', arguments: {} }] },
    { type: 'completed', content: 'done' },
  ]);
function deps(h: Harness, provider: ScriptedProvider, executed: string[]): TaskDeps {
  const originalRun = h.orchestrator.run.bind(h.orchestrator);
  return {
    ...h.taskDeps,
    orchestrator: { run: (input: Parameters<Orchestrator['run']>[0]) => originalRun({ ...input, provider }) } as Orchestrator,
    inProcessDescriptors: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }],
    inProcessHandler: async (tool: string) => {
      executed.push(tool);
      return { echoed: tool };
    },
  };
}
async function waitStatus(h: Harness, taskId: string, statuses: string[]): Promise<{ status: string; resumeToken?: string | null }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = h.taskStore.read(taskId);
    if (statuses.includes(row.status) || Date.now() > deadline) return row;
    await new Promise<void>((res) => setImmediate(res));
  }
}
function parentTask(h: Harness): { parentTaskId: string; parentCtx: ExecutionContext } {
  const agent = createAgent(h);
  const sessionId = openSession(h, agent);
  const parentTaskId = crypto.randomUUID();
  h.taskStore.create({ id: parentTaskId, sessionId, prompt: 'parent task' });
  h.taskStore.updateStatus(parentTaskId, 'running');
  return {
    parentTaskId,
    parentCtx: { taskId: parentTaskId, sessionId, agentName: agent, agentDefinition: h.agentStore.read(agent), recursionDepth: 0, toolCallCount: 0 },
  };
}
const escalatingChild = (h: Harness): string =>
  openSession(h, createAgent(h, { nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } }, hitl: false } }));

beforeAll(async () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  root = fs.mkdtempSync(path.join(TMP_ROOT, 'tracing-e2e-'));
  logDir = path.join(root, 'sink');
  harness = await buildHarness();
  bare = await buildHarness();
  // The REAL default entries (tracing included), differing only in where the sink lives.
  await loadDefaultPlugins(harness.hooks, harness.db, silentLogger, {
    configPath: path.join(root, 'no-such-config.json'),
    defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, { service: 'agent-mcp-e2e', logSink: 'file', logDir, captureArgs: false }),
  });
  const server = createServer({
    agentStore: harness.agentStore,
    sessionStore: harness.sessionStore,
    taskStore: harness.taskStore,
    queue: harness.queue,
    policy: harness.policy,
    orchestrator: harness.orchestrator,
    hooks: harness.hooks,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: harness.db as any,
    dagEngine: harness.dagEngine,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  mcp = new Client({ name: 'tracing-e2e', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(ct);
}, 60_000);

afterAll(async () => {
  await mcp?.close().catch(() => undefined);
  await harness?.teardown();
  await bare?.teardown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tracing default-load, end to end (0f760dcd, 5dff26e6)', () => {
  it('0f760dcd AC1 + AC2 (absent block): the BUILT server with zero tracing config boots with the plugin and its real sink records session start/close', async () => {
    expect(fs.existsSync(DIST_ENTRY), `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp"`).toBe(true);
    const home = path.join(root, 'child-home');
    const cwd = path.join(root, 'child-cwd');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ADHD_AGENT_') && v !== undefined) env[k] = v;
    Object.assign(env, {
      HOME: home,
      ADHD_AGENT_DATABASE_PATH: path.join(root, 'child.db'),
      ADHD_AGENT_TRANSPORT: 'stdio',
      ADHD_AGENT_SSE_ENABLED: 'false',
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_ENTRY], env, cwd, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    const child = new Client({ name: 'tracing-e2e-child', version: '0.0.1' }, { capabilities: {} });
    await child.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const res = (await child.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
        const text = res.content?.[0]?.text ?? '';
        if (res.isError) throw new Error(`${name}: ${text}`);
        return JSON.parse(text) as Record<string, unknown>;
      };
      const agentName = `child-agent-${crypto.randomUUID()}`;
      await call('agent_create', { name: agentName, provider: { type: 'claudecli' }, systemPrompt: 'x' });
      const { session_id } = (await call('agent', { name: agentName })) as { session_id: string };
      await call('session_close', { session_id });

      // The child's DEFAULT sink (no tracing config, fake HOME) received the session's start/finish.
      const recs = await until(home, (r) => has(r, 'agent.session.finish', { 'agent.session_id': session_id }), 'child session finish');
      expect(has(recs, 'agent.session.start', { 'agent.session_id': session_id })).toBe(true);
      expect(stderr).toContain('agent-plugin-tracing');
      expect(stderr).not.toMatch(/Plugin (resolution|import) failed/);
    } finally {
      await child.close().catch(() => undefined);
    }
  }, 60_000);

  it('5dff26e6 AC1 + carry-in (1): a real loaded-tool task emits task/model/tool spans and permission:decision(allow) to the real sink', async () => {
    const executed: string[] = [];
    const agent = createAgent(harness, { nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'allow' } } } });
    const out = await taskTool({ session_id: openSession(harness, agent), prompt: 'call echo', background: false } as never, deps(harness, echoThenComplete(), executed));
    expect(executed).toEqual(['echo']);
    const recs = await until(logDir, (r) => has(r, 'agent.task.finish', { 'agent.task_id': out.task_id }) && has(r, 'agent.tool_call.finish', { 'agent.task_id': out.task_id }), 'allow task spans');
    assertTaskSpanned(recs, out.task_id);
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': out.task_id, 'agent.permission.action': 'allow', 'agent.permission.resolution': 'allow' })).toBe(true);
  }, 60_000);

  it('carry-in (1): deny, then ask -> suspend -> task_resume, are recorded as permission:decision + hitl spans', async () => {
    // deny
    const denyAgent = createAgent(harness, { nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'deny' } } } });
    const deniedExec: string[] = [];
    const denied = await taskTool({ session_id: openSession(harness, denyAgent), prompt: 'call echo', background: false } as never, deps(harness, echoThenComplete(), deniedExec));
    expect(deniedExec).toEqual([]);
    // ask -> suspend -> resume through the real task_resume path
    const askAgent = createAgent(harness, { nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } } } });
    const exec: string[] = [];
    const out = await taskTool({ session_id: openSession(harness, askAgent), prompt: 'call echo', background: true } as never, deps(harness, echoThenComplete(), exec));
    const parked = await waitStatus(harness, out.task_id, ['awaiting_input']);
    expect(parked.resumeToken).toBeTruthy();
    await taskResume({ taskId: out.task_id, resumeToken: parked.resumeToken as string, userInput: 'allow' }, { taskStore: harness.taskStore });
    await drainQueue(harness.queue, 15_000);

    const recs = await until(
      logDir,
      (r) => has(r, 'agent.hitl.resume.finish', { 'agent.hitl.parked_task_id': out.task_id }) && has(r, 'agent.task.finish', { 'agent.task_id': out.task_id }),
      'hitl resume'
    );
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': denied.task_id, 'agent.permission.action': 'deny', 'agent.permission.resolution': 'deny' })).toBe(true);
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': out.task_id, 'agent.permission.action': 'ask', 'agent.permission.resolution': 'suspend' })).toBe(true);
    expect(has(recs, 'agent.hitl.suspend.finish', { 'agent.hitl.parked_task_id': out.task_id })).toBe(true);
  }, 60_000);

  it('carry-in (2): both fail-closed escalate denies (parent unreachable; parent approval already pending) emit permission:decision(deny)', async () => {
    // (a) parent unreachable: the parent task id has no row to park.
    const ghost = parentTask(harness);
    const ghostCtx: ExecutionContext = { ...ghost.parentCtx, taskId: crypto.randomUUID() };
    const unreachableExec: string[] = [];
    const unreachable = await taskTool(
      { session_id: escalatingChild(harness), prompt: 'call echo', background: true } as never,
      deps(harness, echoThenComplete(), unreachableExec),
      ghostCtx
    );
    expect((await waitStatus(harness, unreachable.task_id, ['completed', 'failed'])).status).toBe('completed');
    expect(unreachableExec).toEqual([]);

    // (b) a first child parks the (real) parent; a second child's ask finds the approval pending.
    const { parentTaskId, parentCtx } = parentTask(harness);
    const firstExec: string[] = [];
    const first = await taskTool({ session_id: escalatingChild(harness), prompt: 'call echo', background: true } as never, deps(harness, echoThenComplete(), firstExec), parentCtx);
    const parentParked = await waitStatus(harness, parentTaskId, ['awaiting_input']);
    const secondExec: string[] = [];
    const second = await taskTool({ session_id: escalatingChild(harness), prompt: 'call echo', background: true } as never, deps(harness, echoThenComplete(), secondExec), parentCtx);
    expect((await waitStatus(harness, second.task_id, ['completed', 'failed'])).status).toBe('completed');
    expect(secondExec).toEqual([]);
    await taskResume({ taskId: parentTaskId, resumeToken: parentParked.resumeToken as string, userInput: 'allow' }, { taskStore: harness.taskStore });
    await drainQueue(harness.queue, 15_000);
    expect(firstExec).toEqual(['echo']);

    const recs = await until(
      logDir,
      (r) => has(r, 'agent.permission.decision.finish', { 'agent.task_id': second.task_id }) && has(r, 'agent.permission.decision.finish', { 'agent.task_id': unreachable.task_id }),
      'escalate deny decisions'
    );
    const reasonOf = (taskId: string): unknown =>
      recs.find((x) => x.event === 'agent.permission.decision.finish' && x['agent.task_id'] === taskId)?.['agent.permission.reason'];
    const base = { 'agent.permission.action': 'ask', 'agent.permission.resolution': 'deny' };
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': unreachable.task_id, ...base })).toBe(true);
    expect(String(reasonOf(unreachable.task_id))).toContain('could not be reached');
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': second.task_id, ...base })).toBe(true);
    expect(String(reasonOf(second.task_id))).toContain('already has a pending approval request');
    // the first, successful escalation is the contrast: resolution "escalate", not "deny".
    expect(has(recs, 'agent.permission.decision.finish', { 'agent.task_id': first.task_id, 'agent.permission.resolution': 'escalate' })).toBe(true);
  }, 60_000);

  it('carry-in (3): session:closed driven by the real `session_close` MCP tool closes the session span', async () => {
    const agent = createAgent(harness);
    const sessionId = openSession(harness, agent);
    await until(logDir, (r) => has(r, 'agent.session.start', { 'agent.session_id': sessionId }), 'session start');
    const res = (await mcp.callTool({ name: 'session_close', arguments: { session_id: sessionId } })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
    const recs = await until(logDir, (r) => has(r, 'agent.session.finish', { 'agent.session_id': sessionId }), 'session finish');
    expect(has(recs, 'agent.session.finish', { 'agent.session_id': sessionId, 'agent.outcome': 'closed' })).toBe(true);
  }, 60_000);

  it('5dff26e6 AC2: NEGATIVE CONTROL — with the plugin NOT loaded the same task emits ZERO records, and the on-run assertion goes RED on it', async () => {
    const run = async (h: Harness): Promise<string> => {
      const agent = createAgent(h, { nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'allow' } } } });
      const out = await taskTool({ session_id: openSession(h, agent), prompt: 'call echo', background: false } as never, deps(h, echoThenComplete(), []));
      expect(h.taskStore.read(out.task_id).status).toBe('completed');
      return out.task_id;
    };
    // Control (teeth): the loaded harness satisfies the contract…
    const onId = await run(harness);
    assertTaskSpanned(await until(logDir, (r) => has(r, 'agent.task.finish', { 'agent.task_id': onId }), 'on-run finish'), onId);
    // …the unloaded harness (same process, same sink) leaves no trace of its task, deterministically:
    // every emitting path of the on-run is synchronous-to-completion before `taskTool` returns, so
    // one drain of the event loop is enough to prove nothing arrives late.
    const offId = await run(bare);
    await drainQueue(bare.queue, 15_000);
    const after = sinkRecords(logDir);
    expect(after.filter((x) => x['agent.task_id'] === offId)).toEqual([]);
    // The assertion that guards emission is RED on the off-run — i.e. it would catch a plugin that
    // silently stopped emitting (revert-failing).
    expect(() => assertTaskSpanned(after, offId)).toThrow();
  }, 60_000);

  it('5dff26e6 AC3: audit_tracing.py recomputes counts/durations from the real sink (exit 0) and exits non-zero on a declared path with zero samples', () => {
    const script = path.resolve(PACKAGE_ROOT, '..', '..', 'scripts', 'audit_tracing.py');
    const run = (...args: string[]) => spawnSync('python3', [script, ...args], { encoding: 'utf8' });

    // Healthy: the sink this very run produced carries every declared path.
    const healthy = run(logDir, '--json');
    expect(healthy.status, healthy.stderr).toBe(0);
    const report = JSON.parse(healthy.stdout) as { zero_sample_declared: string[]; operations: Record<string, { count: number }> };
    expect(report.zero_sample_declared).toEqual([]);
    const onDisk = sinkRecords(logDir);
    for (const [op, o] of Object.entries(report.operations)) {
      const terminals = onDisk.filter((r) => r.event === `${op}.finish` || r.event === `${op}.error`).length;
      expect(o.count, `recomputed count for ${op}`).toBe(terminals);
    }

    // Unhealthy fixture: one declared path has no samples -> exit != 0 naming it.
    const fixture = path.join(root, 'fixture-sink');
    fs.mkdirSync(fixture, { recursive: true });
    const lines = onDisk.filter((r) => !r.event.startsWith('agent.hitl.resume')).map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(fixture, 'fixture.jsonl'), lines.join('\n') + '\n');
    const broken = run(fixture);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('agent.hitl.resume');

    // An unreadable sink is a usage error, distinct from "unhealthy".
    expect(run(path.join(root, 'nope')).status).toBe(2);
  });
});
