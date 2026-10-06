/**
 * nat-tool-6-permission-gate.e2e.test.ts
 *
 * NAT-TOOL-6 — the RESOLVED permission map (ADR-0008 D5; Q1 ratified) is
 * evaluated host-side, **before `pre:tool_call`**, for every native tool call:
 * last-match-wins with `deny` terminal. `deny` → a typed refusal, the tool is
 * NOT executed. `ask` → the fixed resolution chain `suspend → escalate → deny`
 * (ADR-0008 D6). Every task is sessioned — a one-shot `agent_name` task creates
 * a REAL session row (`retention: ephemeral`, reclaimed on terminal).
 *
 * Each test cites its `NAT-TOOL-6 AC<n>` and is **revert-failing**: the negative
 * control that proves the assertion has teeth is exercised in-file (a wrong
 * variant is driven through the SAME real path). The ONLY stub is the external
 * LLM (`ScriptedProvider`); the stores, queue, orchestrator, permission gate and
 * the real `task`/`task_resume` paths are the production code.
 *
 * The tool under test is the host's own in-process `agent-mcp` surface (the ADR's
 * own example, `agent-mcp.*`), so no third-party server is spawned and the suite
 * runs default/unflagged.
 */
import crypto from 'node:crypto';

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import { sessionsTable, taskEventsTable } from '@adhd/agent-store-runtime';
import type {
  Orchestrator,
  TaskDeps,
  ExecutionContext,
} from '@adhd/agent-engine-orchestrator';
import type { AgentCreateInput } from '@adhd/agent-engine-orchestrator';

import { ScriptedProvider } from './scripted-provider.js';
import {
  buildHarness,
  taskTool,
  taskResume,
  drainQueue,
  type Harness,
} from './harness.js';

const SELF_SERVER = { 'agent-mcp': { transport: 'stdio' as const, command: 'agent-mcp' } };

/** A single tool call to the in-process echo tool, then a completing turn. */
function echoThenComplete(): ScriptedProvider {
  return new ScriptedProvider([
    {
      type: 'tool_calls',
      toolCalls: [{ server: 'agent-mcp', tool: 'echo', arguments: {} }],
    },
    { type: 'completed', content: 'done' },
  ]);
}

function createAgent(harness: Harness, overrides: Partial<AgentCreateInput> = {}): string {
  const agentName = `perm-agent-${crypto.randomUUID()}`;
  harness.agentStore.create({
    name: agentName,
    provider: { type: 'openai', model: 'test-model', baseURL: 'http://localhost:1234/v1' },
    systemPrompt: 'You are a test assistant.',
    mcpServers: SELF_SERVER,
    permissions: {},
    ...overrides,
  } as AgentCreateInput);
  return agentName;
}

function openSession(harness: Harness, agentName: string): string {
  const def = harness.agentStore.read(agentName);
  return harness.sessionStore.create({ agentName, agentDefinition: def }).id;
}

/** Real deps with a REAL in-process `agent-mcp` tool that records execution. */
function gatedDeps(harness: Harness, executed: string[]): TaskDeps {
  return {
    ...harness.taskDeps,
    inProcessDescriptors: [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
    ],
    inProcessHandler: async (toolName: string) => {
      executed.push(toolName);
      return { echoed: toolName };
    },
  };
}

/** Swap only the LLM boundary (the one allowed stub) on a deps object. */
function withProvider(harness: Harness, deps: TaskDeps, provider: ScriptedProvider): TaskDeps {
  const real = harness.orchestrator;
  const originalRun = real.run.bind(real);
  return {
    ...deps,
    orchestrator: {
      run: (input: Parameters<Orchestrator['run']>[0]) => originalRun({ ...input, provider }),
    } as Orchestrator,
  };
}

async function waitFor(
  harness: Harness,
  taskId: string,
  statuses: string[],
  timeoutMs = 15_000
): Promise<{ status: string; resumeToken?: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let row = harness.taskStore.read(taskId);
  while (Date.now() < deadline) {
    row = harness.taskStore.read(taskId);
    if (statuses.includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return row;
}

function toolCallEvents(harness: Harness, taskId: string): Array<Record<string, unknown>> {
  return harness.db
    .select()
    .from(taskEventsTable)
    .where(eq(taskEventsTable.taskId, taskId))
    .all()
    .filter((e) => e.type === 'TOOL_CALL')
    .map((e) => JSON.parse(e.payload ?? '{}') as Record<string, unknown>);
}

function toolMessageText(harness: Harness, sessionId: string): string {
  return harness.sessionStore
    .getMessages(sessionId)
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.stringify(m.toolResults ?? []))
    .join('\n');
}

describe('NAT-TOOL-6 — permission gate (ADR-0008 D5/D6)', () => {
  it('AC1: a `deny` rule refuses with a typed error and the tool is NOT executed', async () => {
    const harness = await buildHarness();
    try {
      const agentName = createAgent(harness, {
        nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'deny' } } },
      });
      const sessionId = openSession(harness, agentName);
      const provider = echoThenComplete();
      const executed: string[] = [];
      const deps = gatedDeps(harness, executed);

      const out = await taskTool(
        { session_id: sessionId, prompt: 'call echo', background: false } as never,
        withProvider(harness, deps, provider)
      );

      // The tool was NOT executed — this is the AC1 bite.
      expect(executed, 'a denied tool must never execute').toEqual([]);
      expect(out.status).toBe('completed');

      // A typed refusal (PERMISSION_DENIED) was returned to the model.
      expect(toolMessageText(harness, sessionId)).toContain('PERMISSION_DENIED');
      const gateEvents = toolCallEvents(harness, out.task_id);
      expect(gateEvents.some((e) => e.permission === 'deny' && e.code === 'PERMISSION_DENIED')).toBe(
        true
      );

      // NEGATIVE CONTROL (revert-failing): with the gate removed the SAME call
      // executes — proving the gate (not some other path) is what refused it.
      const executedNoGate: string[] = [];
      const noGateDeps = withProvider(
        harness,
        { ...gatedDeps(harness, executedNoGate), config: { ...harness.taskDeps.config, permissionGate: undefined } },
        echoThenComplete()
      );
      const session2 = openSession(harness, agentName);
      const out2 = await taskTool(
        { session_id: session2, prompt: 'call echo', background: false } as never,
        noGateDeps
      );
      expect(executedNoGate, 'with NO gate injected the tool executes (control)').toEqual(['echo']);
      expect(out2.status).toBe('completed');
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC2: a sessioned `ask` suspends the task and later resumes it', async () => {
    const harness = await buildHarness();
    try {
      const agentName = createAgent(harness, {
        nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } } },
      });
      const sessionId = openSession(harness, agentName);
      const executed: string[] = [];
      const deps = gatedDeps(harness, executed);

      const out = await taskTool(
        { session_id: sessionId, prompt: 'call echo', background: true } as never,
        withProvider(harness, deps, echoThenComplete())
      );

      const suspended = await waitFor(harness, out.task_id, ['awaiting_input']);
      expect(suspended.status).toBe('awaiting_input');
      expect(suspended.resumeToken).toBeTruthy();
      expect(executed, 'the tool must not run while suspended').toEqual([]);
      const askEvent = toolCallEvents(harness, out.task_id).find((e) => e.permission === 'ask');
      expect(askEvent?.resolution).toBe('suspend');

      const resumed = await taskResume(
        { taskId: out.task_id, resumeToken: suspended.resumeToken as string, userInput: 'allow' },
        { taskStore: harness.taskStore }
      );
      expect(resumed.success).toBe(true);
      await drainQueue(harness.queue, 15_000);

      const final = harness.taskStore.read(out.task_id);
      expect(final.status).toBe('completed');
      expect(executed, 'an approved ask executes the tool').toEqual(['echo']);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC3: root + hitl:false + no parent → ask denied as permission_ask_denied; flip hitl:true → suspends + resumes', async () => {
    const harness = await buildHarness();
    try {
      // hitl:false, no parent → the fail-closed floor.
      const deniedAgent = createAgent(harness, {
        nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } }, hitl: false },
      });
      const deniedSession = openSession(harness, deniedAgent);
      const deniedExecuted: string[] = [];
      const deniedOut = await taskTool(
        { session_id: deniedSession, prompt: 'call echo', background: false } as never,
        withProvider(harness, gatedDeps(harness, deniedExecuted), echoThenComplete())
      );
      expect(deniedExecuted, 'a fail-closed ask never executes the tool').toEqual([]);
      expect(deniedOut.status).toBe('completed');
      expect(toolMessageText(harness, deniedSession)).toContain('PERMISSION_ASK_DENIED');
      const deniedAsk = toolCallEvents(harness, deniedOut.task_id).find((e) => e.permission === 'ask');
      expect(deniedAsk?.resolution).toBe('deny');

      // Flip: hitl:true → the ask suspends and later resumes.
      const hitlAgent = createAgent(harness, {
        nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } }, hitl: true },
      });
      const hitlSession = openSession(harness, hitlAgent);
      const hitlExecuted: string[] = [];
      const hitlOut = await taskTool(
        { session_id: hitlSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, gatedDeps(harness, hitlExecuted), echoThenComplete())
      );
      const suspended = await waitFor(harness, hitlOut.task_id, ['awaiting_input']);
      expect(suspended.status).toBe('awaiting_input');
      await taskResume(
        { taskId: hitlOut.task_id, resumeToken: suspended.resumeToken as string, userInput: 'yes' },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);
      expect(harness.taskStore.read(hitlOut.task_id).status).toBe('completed');
      expect(hitlExecuted).toEqual(['echo']);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC4: overlapping rules resolve LAST-MATCH-WINS with `deny` terminal (Q1)', async () => {
    const harness = await buildHarness();
    try {
      // (a) last-match-wins: the later, more specific `allow` beats the earlier
      //     `*` ask — a most-restrictive implementation would ASK (suspend).
      const agent = createAgent(harness, {
        nativeTooling: {
          dispatch: { permissions: { '*': 'ask', 'agent-mcp.*': 'allow' } },
        },
      });
      const sessionId = openSession(harness, agent);
      const executed: string[] = [];
      const out = await taskTool(
        { session_id: sessionId, prompt: 'call echo', background: false } as never,
        withProvider(harness, gatedDeps(harness, executed), echoThenComplete())
      );
      expect(out.status, 'last-match allow must NOT suspend').toBe('completed');
      expect(executed, 'the later `agent-mcp.*` allow wins over the earlier `*` ask').toEqual([
        'echo',
      ]);

      // (b) `deny` is TERMINAL: a broad deny cannot be un-denied by a later,
      //     more specific allow (last-match alone would return allow).
      const terminalAgent = createAgent(harness, {
        nativeTooling: {
          dispatch: { permissions: { '*': 'deny', 'agent-mcp.*': 'allow' } },
        },
      });
      const terminalSession = openSession(harness, terminalAgent);
      const terminalExecuted: string[] = [];
      const terminalOut = await taskTool(
        { session_id: terminalSession, prompt: 'call echo', background: false } as never,
        withProvider(harness, gatedDeps(harness, terminalExecuted), echoThenComplete())
      );
      expect(terminalExecuted, 'terminal deny must refuse despite the later allow').toEqual([]);
      expect(toolMessageText(harness, terminalSession)).toContain('PERMISSION_DENIED');
      expect(terminalOut.status).toBe('completed');
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC5: a sub-agent `ask` escalates to the parent, the parent approves, and the tool executes', async () => {
    const harness = await buildHarness();
    try {
      const childAgent = createAgent(harness, {
        // hitl:false forces the escalate branch (suspend needs HITL).
        nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } }, hitl: false },
      });
      const childSession = openSession(harness, childAgent);
      const executed: string[] = [];
      const deps = gatedDeps(harness, executed);

      const parentCtx: ExecutionContext = {
        taskId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        agentName: 'parent-agent',
        agentDefinition: harness.agentStore.read(childAgent),
        recursionDepth: 0,
        toolCallCount: 0,
      };

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, deps, echoThenComplete()),
        parentCtx
      );

      const suspended = await waitFor(harness, out.task_id, ['awaiting_input']);
      expect(suspended.status).toBe('awaiting_input');
      const escalateEvent = toolCallEvents(harness, out.task_id).find(
        (e) => e.permission === 'ask'
      );
      expect(escalateEvent?.resolution, 'the ask escalated (not plain suspend)').toBe('escalate');
      expect(escalateEvent?.escalatedTo, 'escalation is attributed to the parent task').toBe(
        parentCtx.taskId
      );
      expect(executed, 'not executed before the parent approves').toEqual([]);

      // The parent approves → the tool executes.
      await taskResume(
        { taskId: out.task_id, resumeToken: suspended.resumeToken as string, userInput: 'approve' },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);
      expect(harness.taskStore.read(out.task_id).status).toBe('completed');
      expect(executed, 'after parent approval the tool executes').toEqual(['echo']);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC6: a one-shot `agent_name` task creates a REAL session row (retention ephemeral, reclaimed on terminal)', async () => {
    const harness = await buildHarness();
    try {
      const agentName = createAgent(harness);
      const executed: string[] = [];
      const out = await taskTool(
        { agent_name: agentName, prompt: 'one shot' } as never,
        withProvider(harness, gatedDeps(harness, executed), new ScriptedProvider([
          { type: 'completed', content: 'one-shot done' },
        ]))
      );

      expect(out.status).toBe('completed');
      const task = harness.taskStore.read(out.task_id);
      expect(task.isEphemeral).toBe(true);
      expect(task.sessionId, 'a one-shot task must carry a real session id').toBeTruthy();

      // The session is a REAL persisted row (the AC6 predicate). `ephemeral` is
      // reclaimed on terminal, so it is closed — not absent.
      const session = harness.sessionStore.read(task.sessionId as string);
      expect(session.agentName).toBe(agentName);
      expect(session.status).toBe('closed');

      // And it is genuinely in the sessions table (not a phantom id).
      const rows = harness.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, task.sessionId as string))
        .all();
      expect(rows).toHaveLength(1);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('AC7 (negative control): restoring a noop session store turns AC6 RED — no real row exists', async () => {
    const harness = await buildHarness();
    try {
      const agentName = createAgent(harness);
      const executed: string[] = [];

      // The retired noop-session path (ADR-0008 D11 control #13): `create`
      // returns an id but persists NOTHING. (The id is a real UUID because the
      // persisted task's sessionId is UUID-validated.)
      const NOOP_ID = crypto.randomUUID();
      const noopSessionStore = {
        create: () => ({ id: NOOP_ID }),
        read: () => {
          throw new Error('SESSION_NOT_FOUND');
        },
        getAgentDefinition: () => {
          throw new Error('SESSION_NOT_FOUND');
        },
        getMessages: () => [],
        list: () => [],
        close: () => ({ id: NOOP_ID, status: 'closed' }),
        clearMessages: () => 0,
        appendMessage: async () => undefined,
      };

      const deps: TaskDeps = {
        ...withProvider(
          harness,
          gatedDeps(harness, executed),
          new ScriptedProvider([{ type: 'completed', content: 'noop done' }])
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionStore: noopSessionStore as any,
      };

      const out = await taskTool({ agent_name: agentName, prompt: 'noop one shot' } as never, deps);
      const task = harness.taskStore.read(out.task_id);
      expect(task.sessionId).toBe(NOOP_ID);

      // AC6's predicate — "a REAL session row exists" — is now FALSE: the row
      // is absent, so the AC6 assertion would go RED.
      const rows = harness.db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.id, NOOP_ID))
        .all();
      expect(rows, 'the noop store persists no session row (AC6 predicate is false)').toHaveLength(
        0
      );
      expect(() => harness.sessionStore.read(NOOP_ID)).toThrow();
    } finally {
      await harness.teardown();
    }
  }, 60_000);
});
