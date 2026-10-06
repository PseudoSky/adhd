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
  AgentCreateInput,
  EngineConfig,
} from '@adhd/agent-engine-orchestrator';

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

// ── a0c0a826 — real parent-routing fixtures ──────────────────────────────────
//
// Pre-fix, `escalate` was behaviorally identical to `suspend`: the CHILD parked
// itself in `awaiting_input` holding its own resumeToken, and NAT-TOOL-6 AC5
// "proved parent approval" by resuming the CHILD directly — the "parent" was a
// bare random UUID with no task row. These fixtures build a REAL parent task so
// the ask can actually be routed to it and answered there.

/** A real parent task + its execution context (the surface an ask routes to). */
function makeParentTask(
  harness: Harness,
  recursionDepth = 0
): { parentTaskId: string; parentSessionId: string; parentCtx: ExecutionContext } {
  const parentAgent = createAgent(harness);
  const parentSessionId = openSession(harness, parentAgent);
  const parentDefinition = harness.agentStore.read(parentAgent);
  const parentTaskId = crypto.randomUUID();
  harness.taskStore.create({
    id: parentTaskId,
    sessionId: parentSessionId,
    prompt: 'parent task',
  });
  harness.taskStore.updateStatus(parentTaskId, 'running');
  const parentCtx: ExecutionContext = {
    taskId: parentTaskId,
    sessionId: parentSessionId,
    agentName: parentAgent,
    agentDefinition: parentDefinition,
    recursionDepth,
    toolCallCount: 0,
  };
  return { parentTaskId, parentSessionId, parentCtx };
}

/** A child agent whose `ask` must escalate (hitl:false prunes suspend). */
function makeEscalatingChild(harness: Harness): { agentName: string; sessionId: string } {
  const agentName = createAgent(harness, {
    nativeTooling: { dispatch: { permissions: { 'agent-mcp.*': 'ask' } }, hitl: false },
  });
  return { agentName, sessionId: openSession(harness, agentName) };
}

/** `gatedDeps` with an EngineConfig override (e.g. the escalation depth bound). */
function gatedDepsWithConfig(
  harness: Harness,
  executed: string[],
  patch: Partial<EngineConfig>
): TaskDeps {
  return {
    ...gatedDeps(harness, executed),
    config: { ...harness.taskDeps.config, ...patch },
  };
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
        // FIX 5: a permission ask requires an EXPLICIT approval — a bare 'yes'
        // is now declined (it can arrive incidentally from the chat gateway).
        { taskId: hitlOut.task_id, resumeToken: suspended.resumeToken as string, userInput: 'approve' },
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

  it('AC5 (corrected): a sub-agent `ask` is ROUTED to the parent task; the parent approves and the child executes', async () => {
    // CHANGED (a0c0a826): this test previously "proved parent approval" by
    // calling `taskResume` on the CHILD directly, with a synthetic parent UUID
    // that had no task row — i.e. it cosmetically self-approved. It now builds a
    // REAL parent task, routes the ask to it, and answers on the PARENT.
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      const { parentTaskId, parentCtx } = makeParentTask(harness);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, gatedDeps(harness, executed), echoThenComplete()),
        parentCtx
      );

      // AC1: the decision surfaces on the PARENT, not the child.
      const parentSuspended = await waitFor(harness, parentTaskId, ['awaiting_input']);
      expect(parentSuspended.status).toBe('awaiting_input');
      expect(parentSuspended.resumeToken, 'the PARENT holds the resume token').toBeTruthy();

      const childRow = harness.taskStore.read(out.task_id);
      expect(childRow.status).toBe('awaiting_input');
      expect(childRow.resumeToken, 'the child must NOT expose its own resume token').toBeFalsy();

      const escalateEvent = toolCallEvents(harness, out.task_id).find(
        (e) => e.permission === 'ask'
      );
      expect(escalateEvent?.resolution, 'the ask escalated (not plain suspend)').toBe('escalate');
      expect(escalateEvent?.escalatedTo, 'escalation is attributed to the parent task').toBe(
        parentTaskId
      );
      const parentEvent = toolCallEvents(harness, parentTaskId).find((e) => e.permission === 'ask');
      expect(parentEvent?.escalatedFrom, 'the parent surface records the asking child').toBe(
        out.task_id
      );
      expect(executed, 'not executed before the parent approves').toEqual([]);

      // AC2: the PARENT approves → the child resumes and the tool executes.
      const resumed = await taskResume(
        {
          taskId: parentTaskId,
          resumeToken: parentSuspended.resumeToken as string,
          userInput: 'approve',
        },
        { taskStore: harness.taskStore }
      );
      expect(resumed.success).toBe(true);
      await drainQueue(harness.queue, 15_000);
      expect(harness.taskStore.read(out.task_id).status).toBe('completed');
      expect(executed, 'after parent approval the child executes').toEqual(['echo']);
      // The parent is restored, not left parked forever.
      expect(harness.taskStore.read(parentTaskId).status).toBe('running');
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('a0c0a826 AC1: a sub-agent `ask` surfaces the decision on the PARENT task; the child does NOT self-approve', async () => {
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      const { parentTaskId, parentCtx } = makeParentTask(harness);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, gatedDeps(harness, executed), echoThenComplete()),
        parentCtx
      );
      const parentSuspended = await waitFor(harness, parentTaskId, ['awaiting_input']);

      const parentRow = harness.taskStore.read(parentTaskId);
      const childRow = harness.taskStore.read(out.task_id);
      // The decision is on the PARENT (status + token)…
      expect(parentRow.status).toBe('awaiting_input');
      expect(parentRow.resumeToken).toBeTruthy();
      // …the child is parked but carries NO resume token (not self-approvable).
      expect(childRow.status).toBe('awaiting_input');
      expect(childRow.resumeToken).toBeFalsy();
      expect(executed).toEqual([]);

      // NEGATIVE CONTROL (revert-failing): pre-fix, `escalate` was `suspend` —
      // the CHILD held its own resumeToken here, so `childRow.resumeToken` was a
      // truthy token and the assertion above goes RED.

      // Drain the pending ask so teardown is immediate (parent rejection path).
      await taskResume(
        {
          taskId: parentTaskId,
          resumeToken: parentSuspended.resumeToken as string,
          userInput: 'deny',
        },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('a0c0a826 AC2: the parent DENIES → the child denies and the tool never executes', async () => {
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      const { parentTaskId, parentCtx } = makeParentTask(harness);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, gatedDeps(harness, executed), echoThenComplete()),
        parentCtx
      );
      const parentSuspended = await waitFor(harness, parentTaskId, ['awaiting_input']);

      // The parent's decision is a REJECTION.
      await taskResume(
        {
          taskId: parentTaskId,
          resumeToken: parentSuspended.resumeToken as string,
          userInput: 'deny',
        },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);

      expect(harness.taskStore.read(out.task_id).status).toBe('completed');
      expect(executed, 'a parent rejection must not execute the tool').toEqual([]);
      expect(toolMessageText(harness, childSession)).toContain('PERMISSION_ASK_DENIED');
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('a0c0a826 AC3: escalation is BOUNDED by parent-chain depth; at the bound it fails closed', async () => {
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      // Parent at depth 1 → the child is at depth 2 (recursionDepth + 1). With
      // the bound at 1, `2 < 1` is false: escalation must fail closed.
      const { parentTaskId, parentCtx } = makeParentTask(harness, 1);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(
          harness,
          gatedDepsWithConfig(harness, executed, { escalationMaxDepth: 1 }),
          echoThenComplete()
        ),
        parentCtx
      );

      // The ask is refused at the bound — never parked (would hang).
      const settled = await waitFor(harness, out.task_id, ['completed', 'failed'], 8_000);
      expect(settled.status, 'at the bound the ask fails closed, never suspends').toBe('completed');
      expect(harness.taskStore.read(parentTaskId).status, 'the parent is never parked').toBe(
        'running'
      );
      expect(executed, 'a bound-refused ask never executes the tool').toEqual([]);
      expect(toolMessageText(harness, childSession)).toContain('PERMISSION_ASK_DENIED');
      const askEvent = toolCallEvents(harness, out.task_id).find((e) => e.permission === 'ask');
      expect(askEvent?.resolution).toBe('deny');
      expect(String(askEvent?.reason)).toContain('depth bound');

      // NEGATIVE CONTROL (revert-failing): with the bound removed (or raised
      // above the child's depth) the SAME run escalates instead — the child
      // would park in `awaiting_input` and `settled.status` would not be
      // 'completed', so this assertion goes RED.
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('a0c0a826 AC3 (positive control): the SAME depth escalates when the bound permits it', async () => {
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      const { parentTaskId, parentCtx } = makeParentTask(harness, 1);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(
          harness,
          gatedDepsWithConfig(harness, executed, { escalationMaxDepth: 5 }),
          echoThenComplete()
        ),
        parentCtx
      );
      const parentSuspended = await waitFor(harness, parentTaskId, ['awaiting_input']);
      expect(parentSuspended.status, 'within the bound the ask escalates to the parent').toBe(
        'awaiting_input'
      );
      // Drain the pending ask so teardown is clean (parent rejection path).
      await taskResume(
        {
          taskId: parentTaskId,
          resumeToken: parentSuspended.resumeToken as string,
          userInput: 'deny',
        },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);
      expect(harness.taskStore.read(out.task_id).status).toBe('completed');
    } finally {
      await harness.teardown();
    }
  }, 60_000);

  it('a0c0a826 AC4: NEGATIVE CONTROL — a direct child self-resume cannot satisfy an escalated ask', async () => {
    const harness = await buildHarness();
    try {
      const { sessionId: childSession } = makeEscalatingChild(harness);
      const { parentTaskId, parentCtx } = makeParentTask(harness);
      const executed: string[] = [];

      const out = await taskTool(
        { session_id: childSession, prompt: 'call echo', background: true } as never,
        withProvider(harness, gatedDeps(harness, executed), echoThenComplete()),
        parentCtx
      );
      const parentSuspended = await waitFor(harness, parentTaskId, ['awaiting_input']);
      const childRow = harness.taskStore.read(out.task_id);

      // The child carries NO resume token under parent routing. PRE-FIX the child
      // parked itself with its OWN token — so this assertion is the primary RED
      // bite if parent routing is reverted (a child could then self-approve).
      expect(childRow.resumeToken, 'the child is not the decision surface').toBeFalsy();

      // Resuming the CHILD with its own (absent) token must be refused: a direct
      // child self-resume can never satisfy an escalated ask. PRE-FIX this call
      // RESOLVED (the child approved itself), so `rejects` would be RED.
      await expect(
        taskResume(
          {
            taskId: out.task_id,
            resumeToken: childRow.resumeToken ?? 'no-child-token',
            userInput: 'approve',
          },
          { taskStore: harness.taskStore }
        )
      ).rejects.toThrow();
      expect(executed, 'a refused child self-approve must not execute').toEqual([]);
      expect(harness.taskStore.read(out.task_id).status, 'child stays parked').toBe(
        'awaiting_input'
      );

      // NEGATIVE CONTROL (revert-failing): pre-fix the child parked with its OWN
      // resumeToken, so `childRow.resumeToken` was truthy and this direct child
      // resume SUCCEEDED, `executed` became `['echo']` — every assertion above
      // goes RED. (The old NAT-TOOL-6 AC5 body did exactly this.)

      // Drain the still-parked child so teardown is immediate.
      await taskResume(
        {
          taskId: parentTaskId,
          resumeToken: parentSuspended.resumeToken as string,
          userInput: 'deny',
        },
        { taskStore: harness.taskStore }
      );
      await drainQueue(harness.queue, 15_000);
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
