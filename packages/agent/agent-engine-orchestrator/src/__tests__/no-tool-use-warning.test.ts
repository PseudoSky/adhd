/**
 * cbd559eb -- a zero-tool-call stop must not be indistinguishable from a finished task.
 *
 * Spec: docs/discovery/specs/cbd559eb-zero-tool-call-completion.md (Product revision governs: the
 * `requiresToolUse` flag and AC4 are CUT; AC6 is added).
 *
 * Contract under test (D1/D2/D3): a task whose final stop is `completed`, whose agent was granted
 * at least one tool, and whose task-wide tool-use count is zero completes with
 * `warnings: ['no_tool_use']`. The status and `result` are unchanged. The `TASK_COMPLETED` payload
 * is `{ result, toolUseCount, warnings? }`; the key `warnings` is OMITTED when there is none.
 *
 * Tier S (default): the REAL `Orchestrator`, REAL `HookRegistry`, REAL `TaskStore` on an in-memory
 * better-sqlite3 database built through the shipped migrations (so the DB CHECK enums on task
 * status / event type are the production ones), and, for the synchronous-result leg, the REAL
 * `taskTool` -> `runEphemeralTask` path. The ONLY stubs are the external boundaries: the LLM
 * provider (a scripted `LLMProvider`), the MCP registry/transport (a fake `listAllTools`/`callTool`),
 * and the session store. No process is spawned and no network is touched. No sleeps: runs are
 * driven to completion by awaiting `Orchestrator.run`; a HITL suspension is answered inside the task
 * store's `updateStatus`, never by waiting.
 *
 * Red run (cbd559eb, base 21ba12b3): pending -- the owner's standing hold forbids running tests.
 * Expected failure at base: the persisted payload is `{ result }` only, the hook payload has no
 * `toolUseCount`/`warnings`, the `done` event has no `warnings`, no `warn` line is logged, and the
 * synchronous result has no `warnings`. Each control (no warning) therefore also asserts the exact
 * `toolUseCount`, so it fails at base on "expected undefined to be N" instead of passing vacuously.
 *
 * Not covered here (outside this package; see the hand-back): the agent-mcp
 * `notifications/task/completed` leg, which lives in entrypoint/agent-mcp/src/server.ts.
 */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import type { AgentDefinition } from '@adhd/agent-base-types';

import { Orchestrator, resolveHitl } from '../engine/orchestrator.js';
import type { OrchestratorSessionStore, OrchestratorTaskStore } from '../engine/orchestrator.js';
import { HookRegistry } from '../engine/hooks.js';
import { PolicyEngine } from '../engine/policy.js';
import { BackgroundQueue } from '../engine/queue.js';
import { DagEngine } from '../engine/dag-engine.js';
import { taskTool } from '../tools/task.js';
import type { TaskDeps } from '../tools/task.js';
import type { AgentStore } from '../tools/agent-crud.js';
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import { createMigratedSqlite } from './fixtures/real-schema-db.js';

/** The scripted provider the mocked factory returns for the `taskTool` leg; set per test. */
let scriptedProvider: LLMProvider;
vi.mock('../providers/factory.js', () => ({
  createProvider: () => scriptedProvider,
}));

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

type Turn =
  | { kind: 'completed'; content: string; reportedToolUses?: number }
  | { kind: 'tools'; calls: Array<{ server: string; tool: string }>; reportedToolUses?: number };

/** Scripted provider: replays `turns` in order (the last repeats) and records every request. */
function scriptedProviderOf(turns: Turn[]): { provider: LLMProvider; requests: ProviderChatRequest[] } {
  const requests: ProviderChatRequest[] = [];
  let call = 0;
  const provider: LLMProvider = {
    chat: async (request: ProviderChatRequest): Promise<ProviderChatResponse> => {
      requests.push(request);
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      const sessionId = generateId();
      const reported = turn.reportedToolUses !== undefined ? { reportedToolUses: turn.reportedToolUses } : {};
      if (turn.kind === 'completed') {
        return {
          message: { id: generateId(), sessionId, role: 'assistant', content: turn.content, createdAt: nowIso() },
          stopReason: 'completed',
          ...reported,
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: '',
          toolCalls: turn.calls.map((c) => ({ id: generateId(), server: c.server, tool: c.tool, arguments: {} })),
          createdAt: nowIso(),
        },
        stopReason: 'tool_calls',
        ...reported,
      };
    },
  };
  return { provider, requests };
}

const TOOL_A: ToolDefinition = { name: 'srv__a', description: 'tool a', inputSchema: { type: 'object', properties: {} } };
const TOOL_B: ToolDefinition = { name: 'srv__b', description: 'tool b', inputSchema: { type: 'object', properties: {} } };
const GATED_TOOL: ToolDefinition = {
  name: 'agent-mcp__task',
  description: 'dispatch a sub-agent',
  inputSchema: { type: 'object', properties: {} },
};

/** Fake MCP registry: lists `tools`, executes every call and records the qualified names. */
function fakeRegistry(tools: ToolDefinition[], executed: string[]): McpClientRegistry {
  return {
    listAllTools: async () => tools.map((t) => ({ ...t })),
    closeAll: async () => {},
    getClient: async (server: string) => ({
      callTool: async (tool: string) => {
        executed.push(`${server}__${tool}`);
        return { ok: true };
      },
    }),
  } as unknown as McpClientRegistry;
}

const policy = { check: () => {} } as unknown as PolicyEngine;
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

function engineConfig(permissionGate?: EngineConfig['permissionGate']): EngineConfig {
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
  if (permissionGate) cfg.permissionGate = permissionGate;
  return cfg;
}

function makeCtx(): ExecutionContext {
  const agentDefinition = {
    name: 'warn-test-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are a test agent.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as ExecutionContext['agentDefinition'];
  return {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: 'warn-test-agent',
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

function userMessage(sessionId: string): Message {
  return { id: generateId(), sessionId, role: 'user', content: 'do the work', createdAt: nowIso() };
}

interface IScenarioOptions {
  turns: Turn[];
  /** The tools the (fake) registry grants. Default: none. */
  tools?: ToolDefinition[];
  /** Resolve a HITL suspension with `allow` the moment the task enters `awaiting_input`. */
  permissionGate?: EngineConfig['permissionGate'];
}

interface IScenario {
  taskId: string;
  result: string;
  executed: string[];
  requests: ProviderChatRequest[];
  awaitingInputs: number;
  /** All persisted events of the task, payload parsed. */
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  /** Payload of the single persisted TASK_COMPLETED event. */
  completed: Record<string, unknown>;
  hookPayloads: Array<Record<string, unknown>>;
  doneEvents: Array<Record<string, unknown>>;
  warnLogs: Array<{ meta: Record<string, unknown>; msg: unknown }>;
  task: { status: string; result: string | null };
}

/** Drives the REAL orchestrator against a REAL TaskStore (migrated in-memory sqlite) to a terminal state. */
async function runScenario(opts: IScenarioOptions): Promise<IScenario> {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  const realStore = new TaskStore(db);
  const ctx = makeCtx();
  realStore.create({ sessionId: ctx.sessionId, prompt: 'do the work', id: ctx.taskId });

  let awaitingInputs = 0;
  // Delegating wrapper: identical to the real store, except a suspension is answered in-line so the
  // run resumes deterministically (no timers, no waiting).
  const taskStore = new Proxy(realStore, {
    get(target, prop, receiver) {
      if (prop === 'updateStatus') {
        return (...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const out = (target.updateStatus as any)(...args);
          if (args[1] === 'awaiting_input') {
            awaitingInputs++;
            resolveHitl(args[0] as string, 'allow');
          }
          return out;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as OrchestratorTaskStore;

  const hooks = new HookRegistry();
  const hookPayloads: Array<Record<string, unknown>> = [];
  hooks.register('task:completed', (payload) => {
    hookPayloads.push(payload as unknown as Record<string, unknown>);
  });

  const doneEvents: Array<Record<string, unknown>> = [];
  const warnLogs: Array<{ meta: Record<string, unknown>; msg: unknown }> = [];
  const logger: EngineLogger = {
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: ((meta: unknown, msg?: unknown) => {
      warnLogs.push({ meta: (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>, msg });
    }) as EngineLogger['warn'],
  };

  const executed: string[] = [];
  const { provider, requests } = scriptedProviderOf(opts.turns);
  const run = await new Orchestrator().run({
    executionContext: ctx,
    messages: [userMessage(ctx.sessionId)],
    registry: fakeRegistry(opts.tools ?? [], executed),
    provider,
    policy,
    taskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    hooks,
    config: engineConfig(opts.permissionGate),
    logger,
    emitTaskEvent: (event) => {
      if (event.type === 'done') doneEvents.push(event as unknown as Record<string, unknown>);
    },
  });

  const events = (
    sqlite.prepare('SELECT type, payload FROM task_events WHERE task_id = ?').all(ctx.taskId) as Array<{
      type: string;
      payload: string;
    }>
  ).map((e) => ({ type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> }));
  const completedEvents = events.filter((e) => e.type === 'TASK_COMPLETED');
  expect(completedEvents, 'exactly one TASK_COMPLETED is persisted').toHaveLength(1);
  const read = realStore.read(ctx.taskId);

  return {
    taskId: ctx.taskId,
    result: run.result,
    executed,
    requests,
    awaitingInputs,
    events,
    completed: completedEvents[0].payload,
    hookPayloads,
    doneEvents,
    warnLogs,
    task: { status: read.status as string, result: read.result as string | null },
  };
}

/** The `no_tool_use` log lines of a scenario: `warn` calls carrying the task/agent/provider identity. */
function noToolUseLogs(s: IScenario): IScenario['warnLogs'] {
  return s.warnLogs.filter(
    (l) => l.meta['taskId'] === s.taskId && 'agentName' in l.meta && 'provider' in l.meta
  );
}

// ---------------------------------------------------------------------------------------------
// AC1 -- the warning is present on every leg when the stop is a zero-tool-use `completed`
// ---------------------------------------------------------------------------------------------

describe('cbd559eb AC1 -- tools granted + zero tool use => warnings:[no_tool_use] on every leg', () => {
  // Failure mode: the persisted TASK_COMPLETED event stays `{ result }`, so a reader of the task
  // history cannot tell "answered without tools" from "stopped without doing the work". Tier S.
  // Technique: equivalence class "granted > 0, used == 0, stop == completed".
  it('cbd559eb AC1: the persisted TASK_COMPLETED payload carries warnings and toolUseCount 0, and the result is unchanged', async () => {
    const s = await runScenario({
      tools: [TOOL_A, TOOL_B],
      turns: [{ kind: 'completed', content: 'I did it from memory' }],
    });
    expect(s.completed['warnings']).toEqual(['no_tool_use']);
    expect(s.completed['toolUseCount']).toBe(0);
    expect(s.completed['result']).toBe('I did it from memory');
  });

  // Failure mode: the `task:completed` hook payload (consumed by tracing/ops-log/budget plugins) lacks
  // the warning, so downstream observers see a clean success. Tier S.
  it('cbd559eb AC1: the task:completed hook payload carries warnings and toolUseCount 0', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [{ kind: 'completed', content: 'no tools used' }],
    });
    expect(s.hookPayloads).toHaveLength(1);
    expect(s.hookPayloads[0]['warnings']).toEqual(['no_tool_use']);
    expect(s.hookPayloads[0]['toolUseCount']).toBe(0);
    expect(s.hookPayloads[0]['result']).toBe('no tools used');
  });

  // Failure mode: the SSE `done` stream event (what `follow` clients and the agent-mcp notification
  // are built from) lacks the warning. Tier S.
  it('cbd559eb AC1: the done stream event carries warnings', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [{ kind: 'completed', content: 'no tools used' }],
    });
    expect(s.doneEvents).toHaveLength(1);
    expect(s.doneEvents[0]['warnings']).toEqual(['no_tool_use']);
    expect(s.doneEvents[0]['result']).toBe('no tools used');
    expect(s.doneEvents[0]['error']).toBeNull();
  });

  // Failure mode: a provider that reports `reportedToolUses: 0` (a claudecli run that used nothing)
  // is mistaken for "unknown" and exempted. Zero is zero. Tier S. Technique: boundary 0 vs absent.
  it('cbd559eb AC1: a provider-reported reportedToolUses of 0 still warns', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [{ kind: 'completed', content: 'cli answered alone', reportedToolUses: 0 }],
    });
    expect(s.completed['warnings']).toEqual(['no_tool_use']);
    expect(s.completed['toolUseCount']).toBe(0);
  });

  // Failure mode: the synchronous `task` result (the caller's only view of a one-shot task) drops the
  // warning even though the event log has it. Tier S: the REAL taskTool -> runEphemeralTask -> Orchestrator
  // path with a scripted provider and one granted in-process tool; nativeWebTools is off so the granted
  // set is exactly that tool (the real registry adds a client-side web_fetch for openai otherwise).
  it('cbd559eb AC1: the synchronous task result carries warnings when the run used no tools, and omits the key when it did', async () => {
    const warned = await runTaskTool([{ kind: 'completed', content: 'answered cold' }]);
    expect(warned.output.status).toBe('completed');
    expect(warned.output.result).toBe('answered cold');
    expect(warned.output.warnings).toEqual(['no_tool_use']);

    const used = await runTaskTool([
      { kind: 'tools', calls: [{ server: 'agent-mcp', tool: 'probe' }] },
      { kind: 'completed', content: 'answered with a tool' },
    ]);
    expect(used.output.status).toBe('completed');
    expect(used.output.result).toBe('answered with a tool');
    expect('warnings' in used.output, 'the key is omitted, not empty').toBe(false);
    expect(used.probeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// AC2 -- any tool use (API tool call, or provider-reported) gives no warning
// ---------------------------------------------------------------------------------------------

describe('cbd559eb AC2 -- tool use anywhere in the task gives no warning', () => {
  // Failure mode: the check looks only at the FINAL response (zero tool calls in the last turn) instead
  // of the task-wide count, so every "call a tool, then answer" run is falsely flagged. Tier S.
  // Technique: state transition (tool turn then completed turn); negative control for AC1.
  it('cbd559eb AC2: an API tool call in an earlier turn means no warning on any leg, key omitted, toolUseCount 1', async () => {
    const s = await runScenario({
      tools: [TOOL_A, TOOL_B],
      turns: [
        { kind: 'tools', calls: [{ server: 'srv', tool: 'a' }] },
        { kind: 'completed', content: 'answered after using a tool' },
      ],
    });
    expect(s.executed).toEqual(['srv__a']);
    expect(s.completed['toolUseCount']).toBe(1);
    expect('warnings' in s.completed, 'persisted payload omits the key').toBe(false);
    expect(s.hookPayloads).toHaveLength(1);
    expect(s.hookPayloads[0]['toolUseCount']).toBe(1);
    expect('warnings' in s.hookPayloads[0], 'hook payload omits the key').toBe(false);
    expect(s.doneEvents).toHaveLength(1);
    expect('warnings' in s.doneEvents[0], 'done event omits the key').toBe(false);
  });

  // Failure mode: several calls in one turn, or calls across turns, are counted as one (or the count is
  // overwritten per turn instead of accumulated). Tier S. Technique: accumulation across turns.
  it('cbd559eb AC2: toolUseCount accumulates across turns (2 calls in one turn + 1 in the next = 3)', async () => {
    const s = await runScenario({
      tools: [TOOL_A, TOOL_B],
      turns: [
        {
          kind: 'tools',
          calls: [
            { server: 'srv', tool: 'a' },
            { server: 'srv', tool: 'b' },
          ],
        },
        { kind: 'tools', calls: [{ server: 'srv', tool: 'a' }] },
        { kind: 'completed', content: 'done' },
      ],
    });
    expect(s.completed['toolUseCount']).toBe(3);
    expect('warnings' in s.completed).toBe(false);
  });

  // Failure mode: tools the PROVIDER ran internally (claudecli: reportedToolUses > 0, empty
  // message.toolCalls) are not counted, so every claudecli task that used the CLI's tools is falsely
  // flagged. Tier S: scripted provider response carrying reportedToolUses; no process is spawned.
  it('cbd559eb AC2: a provider-reported reportedToolUses > 0 (claudecli-style) gives no warning and is counted', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [{ kind: 'completed', content: 'the CLI used its own tools', reportedToolUses: 3 }],
    });
    expect(s.executed, 'the engine itself executed nothing').toEqual([]);
    expect(s.completed['toolUseCount']).toBe(3);
    expect('warnings' in s.completed).toBe(false);
    expect('warnings' in s.hookPayloads[0]).toBe(false);
    expect('warnings' in s.doneEvents[0]).toBe(false);
  });

  // Failure mode: provider-reported uses from an EARLIER turn are lost when a later turn reports none
  // (last-write-wins instead of a sum). Tier S.
  it('cbd559eb AC2: provider-reported uses sum with API tool calls across turns', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [
        { kind: 'tools', calls: [{ server: 'srv', tool: 'a' }], reportedToolUses: 2 },
        { kind: 'completed', content: 'done', reportedToolUses: 0 },
      ],
    });
    expect(s.completed['toolUseCount']).toBe(2);
    expect('warnings' in s.completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AC3 -- no granted tools, or a HITL suspend/resume, gives no warning
// ---------------------------------------------------------------------------------------------

describe('cbd559eb AC3 -- no granted tools and HITL runs are not flagged', () => {
  // Failure mode: the granted-tools test counts the engine-injected HITL builtin
  // (builtin__request_human_input, pushed unconditionally when HITL is on) as a granted tool, so a
  // tool-less agent -- whose answer needs no tools -- is flagged on every run. Tier S. The registry
  // grants nothing; the assertion that the builtin WAS advertised proves the test discriminates.
  it('cbd559eb AC3: an agent granted no tools (only the HITL builtin advertised) completes without a warning', async () => {
    const s = await runScenario({
      tools: [],
      turns: [{ kind: 'completed', content: 'a pure-text answer' }],
    });
    const advertised = (s.requests[0].tools ?? []).map((t) => t.name);
    expect(advertised, 'the HITL builtin is advertised, and must not count as granted').toContain(
      'builtin__request_human_input'
    );
    expect(s.completed['toolUseCount']).toBe(0);
    expect('warnings' in s.completed).toBe(false);
    expect(s.hookPayloads).toHaveLength(1);
    expect('warnings' in s.hookPayloads[0]).toBe(false);
    expect('warnings' in s.doneEvents[0]).toBe(false);
    expect(noToolUseLogs(s), 'no log line for an unflagged task').toHaveLength(0);
  });

  // Failure mode: a task that suspended for a human answer and resumed is flagged, although the
  // resumed tool call is tool use. Tier S. Technique: state transition running -> awaiting_input ->
  // running -> completed; awaitingInputs === 1 proves a suspension really happened.
  it('cbd559eb AC3: a HITL suspend/resume run (ask gate, approved) completes without a warning', async () => {
    const s = await runScenario({
      tools: [GATED_TOOL],
      permissionGate: () => 'ask',
      turns: [
        { kind: 'tools', calls: [{ server: 'agent-mcp', tool: 'task' }] },
        { kind: 'completed', content: 'finished after approval' },
      ],
    });
    expect(s.awaitingInputs, 'the task really suspended once').toBe(1);
    expect(s.executed).toEqual(['agent-mcp__task']);
    expect(s.completed['toolUseCount']).toBe(1);
    expect('warnings' in s.completed).toBe(false);
    expect('warnings' in s.hookPayloads[0]).toBe(false);
    expect('warnings' in s.doneEvents[0]).toBe(false);
    expect(s.result).toBe('finished after approval');
  });
});

// ---------------------------------------------------------------------------------------------
// AC5 -- existing consumers are unaffected; no new status, event type or migration
// ---------------------------------------------------------------------------------------------

describe('cbd559eb AC5 -- additive only', () => {
  // Failure mode: the warning is delivered by changing the result text, the task status or the event
  // vocabulary (a new TaskStatus / TaskEventType needs a DB CHECK migration), breaking consumers that
  // read `payload.result` / `status`. Tier S: the real migrated schema accepts every event the run
  // writes, so a new event type would fail at insert; the payload shape is pinned exactly.
  it('cbd559eb AC5: a warned task keeps status completed, task.result and payload.result unchanged; the payload is exactly {result, toolUseCount, warnings}', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [{ kind: 'completed', content: 'plain final answer' }],
    });
    expect(s.task.status).toBe('completed');
    expect(s.task.result).toBe('plain final answer');
    expect(s.result).toBe('plain final answer');
    expect(s.completed['result']).toBe('plain final answer');
    expect(Object.keys(s.completed).sort()).toEqual(['result', 'toolUseCount', 'warnings']);
    expect(s.completed['warnings']).toEqual(['no_tool_use']);
    const types = s.events.map((e) => e.type);
    expect(types, 'no warning-specific or incomplete event type is invented').not.toContainEqual(
      expect.stringMatching(/warn|incomplete|no_tool/i)
    );
  });

  // Failure mode: an unwarned task's payload gains an empty `warnings: []` (or `undefined`), which a
  // strict consumer treats as a change. Tier S. Technique: exact-shape equality.
  it('cbd559eb AC5: an unwarned task payload is exactly {result, toolUseCount}', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [
        { kind: 'tools', calls: [{ server: 'srv', tool: 'a' }] },
        { kind: 'completed', content: 'answer' },
      ],
    });
    expect(s.completed).toEqual({ result: 'answer', toolUseCount: 1 });
    expect(s.task.status).toBe('completed');
    expect(s.task.result).toBe('answer');
  });
});

// ---------------------------------------------------------------------------------------------
// AC6 -- exactly one warn log line when the warning is attached
// ---------------------------------------------------------------------------------------------

describe('cbd559eb AC6 -- one warn log line per flagged task', () => {
  // Failure mode: the warning is attached silently (operators see nothing), or logged once per model
  // turn / per leg instead of once per task. Tier S. The structured fields are asserted, not the
  // message text; the granted count is located by value (2 tools granted) so the field name is free.
  it('cbd559eb AC6: a flagged task logs exactly one warn carrying taskId, agentName, provider and the granted count', async () => {
    const s = await runScenario({
      tools: [TOOL_A, TOOL_B],
      turns: [{ kind: 'completed', content: 'no tools' }],
    });
    const lines = noToolUseLogs(s);
    expect(lines).toHaveLength(1);
    expect(lines[0].meta['taskId']).toBe(s.taskId);
    expect(lines[0].meta['agentName']).toBe('warn-test-agent');
    expect(lines[0].meta['provider']).toBe('openai');
    expect(Object.values(lines[0].meta), 'the number of granted tools (2) is logged').toContain(2);
  });

  // Failure mode: the log line is emitted for tasks that used tools (noise that trains operators to
  // ignore it). Tier S. The toolUseCount assertion keeps this control red at base (no field there).
  it('cbd559eb AC6: a task that used a tool logs no no_tool_use line', async () => {
    const s = await runScenario({
      tools: [TOOL_A],
      turns: [
        { kind: 'tools', calls: [{ server: 'srv', tool: 'a' }] },
        { kind: 'completed', content: 'done' },
      ],
    });
    expect(s.completed['toolUseCount']).toBe(1);
    expect(noToolUseLogs(s)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// taskTool leg harness (REAL taskTool -> runEphemeralTask -> Orchestrator; provider mocked via factory)
// ---------------------------------------------------------------------------------------------

async function runTaskTool(
  turns: Turn[]
): Promise<{ output: Record<string, unknown>; probeCalls: number }> {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  const taskStore = new TaskStore(db);
  const def = {
    name: 'warn-sync-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are a test agent.',
    // The self-referential `agent-mcp` server is served in-process (isSelfReferential), so it needs no connection.
    mcpServers: { 'agent-mcp': { transport: 'http', url: 'http://localhost:0/mcp' } },
    nativeWebTools: false,
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as unknown as AgentDefinition;
  const agentStore: AgentStore = {
    create: () => def,
    read: (name: string) => {
      if (name !== def.name) throw new Error(`unexpected agent name: ${name}`);
      return def;
    },
    update: () => def,
    delete: () => {},
    list: () => [def],
  };
  const silent: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const queue = new BackgroundQueue(1, silent);
  let probeCalls = 0;
  const deps: TaskDeps = {
    agentStore,
    sessionStore: new SessionStore(db),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: taskStore as any,
    orchestrator: new Orchestrator(),
    queue,
    policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
    hooks: new HookRegistry(),
    selfUrl: undefined,
    inProcessDescriptors: [
      { name: 'probe', description: 'a granted in-process tool', inputSchema: { type: 'object', properties: {} } },
    ],
    inProcessHandler: async () => {
      probeCalls++;
      return { ok: true };
    },
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dagEngine: new DagEngine(db, queue, taskStore as any, async () => {}, silent),
    config: {
      ...engineConfig(),
      getProviderConfig: () => ({ secret: 'test', baseURL: 'http://localhost:0/v1', model: 'gpt-4o-mini' }),
    },
    logger: silent,
  };
  scriptedProvider = scriptedProviderOf(turns).provider;
  // Widened on purpose: the result field under test (`warnings`) does not exist on the base type.
  const output = (await taskTool({ agent_name: def.name, prompt: 'do the work' }, deps)) as unknown as Record<string, unknown>;
  return { output, probeCalls };
}
