import { describe, expect, it } from 'vitest';

import {
  Orchestrator,
  resolveHitl,
} from '../engine/orchestrator.js';
import type {
  OrchestratorTaskStore,
  OrchestratorSessionStore,
  OrchestratorRunInput,
} from '../engine/orchestrator.js';
import type { PolicyEngine } from '../engine/policy.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import type {
  LLMProvider,
  ProviderChatResponse,
  ToolDefinition,
} from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { IHookRegistry } from '@adhd/agent-base-types';

/**
 * Permission-gate escalation + approved-suspend regression teeth
 * (dispatch-2026-10-04-9c4e, orchestrator/escalate review findings #1, #2, #5).
 *
 * These drive the REAL `Orchestrator.run()` through the fixed ask chain; the ONLY
 * stubs are the external LLM provider and the MCP registry boundary (repo policy:
 * mock the external boundary, never the thing under test).
 *
 *  - FIX #1 (`orchestrator.ts` suspend branch): an APPROVED `suspend` must fall
 *    through to `pre:tool_call` + `policy.check` + `toolCallCount++` and run the
 *    tool — exactly like an approved `escalate`. The stray `continue` was the
 *    regression; deleting it alone would drop an approved suspend into the
 *    escalation branch, so the escalate block is now guarded by `else`.
 *  - FIX #2 (`orchestrator.ts` escalate branch): the parent restore lives in a
 *    `try/finally`, so a REJECTED approval promise (child signal aborted) still
 *    restores the parent to its pre-ask status instead of stranding it in
 *    `awaiting_input` forever.
 *  - FIX #5: each scenario is revert-failing (see the NEGATIVE CONTROL notes).
 */

const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** EngineConfig carrying only what run() reads here. */
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

const noopHooks: IHookRegistry = {
  register: () => {},
  emit: async () => {},
  registerEnforcement: () => {},
  enforce: async () => {},
} as unknown as IHookRegistry;

function permitPolicy(): PolicyEngine {
  return { check: () => {} } as unknown as PolicyEngine;
}

/**
 * A child execution context. `nativeTooling.hitl:false` is what prunes the
 * `suspend` leg so the ask resolves to `escalate` (a parent must exist);
 * `recursionDepth:1 < default escalationMaxDepth (3)` keeps it within bound.
 */
function makeChildCtx(
  parentTaskId: string | undefined,
  overrides: Partial<ExecutionContext['agentDefinition']> = {}
): ExecutionContext {
  const agentDefinition = {
    name: 'test-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    permissions: {},
    nativeTooling: { hitl: false },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  } as ExecutionContext['agentDefinition'];
  const ctx: ExecutionContext = {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: 'test-agent',
    agentDefinition,
    recursionDepth: 1,
    toolCallCount: 0,
  };
  if (parentTaskId) ctx.parentTaskId = parentTaskId;
  return ctx;
}

/** A default-HITL context (suspend is applicable) with no parent. */
function makeSuspendCtx(): ExecutionContext {
  const agentDefinition = {
    name: 'test-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as ExecutionContext['agentDefinition'];
  return {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: 'test-agent',
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

function userMessage(sessionId: string): Message {
  return {
    id: generateId(),
    sessionId,
    role: 'user',
    content: 'hello',
    createdAt: nowIso(),
  };
}

const GATED_TOOL: ToolDefinition = {
  name: 'agent-mcp__task',
  description: 'dispatch a sub-agent',
  inputSchema: { type: 'object', properties: {} },
};

/** Registry that returns `GATED_TOOL` and records every executed call. */
function makeRegistry(executed: string[]): McpClientRegistry {
  return {
    listAllTools: async () => [{ ...GATED_TOOL }],
    resolveToolName: (name: string) => {
      const [server, tool] = name.split('__');
      return { server, tool };
    },
    closeAll: async () => {},
    getClient: async (server: string) => ({
      callTool: async (tool: string) => {
        executed.push(`${server}__${tool}`);
        return { ok: true };
      },
    }),
  } as unknown as McpClientRegistry;
}

/** Provider: turn 1 → call the gated tool; turn 2 → complete. */
function scriptedProvider(): LLMProvider {
  let turn = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      turn++;
      if (turn === 1) {
        return {
          message: {
            id: generateId(),
            sessionId: generateId(),
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: generateId(), server: 'agent-mcp', tool: 'task', arguments: {} },
            ],
            createdAt: nowIso(),
          },
          stopReason: 'tool_calls',
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId: generateId(),
          role: 'assistant',
          content: 'finished',
          createdAt: nowIso(),
        },
        stopReason: 'completed',
      };
    },
  };
}

interface RecWrite {
  taskId: string;
  status: string;
  fields?: Record<string, unknown>;
}

/**
 * Task store that records every status write (with its fields) and lets a test
 * wait — deterministically, no sleep — for a task to reach `awaiting_input` and
 * then resolve it out-of-band via `resolveHitl` (the way `task_resume` does).
 * `read` echoes the last-written status so `parentPriorStatus` is faithful.
 */
function makeRecordingTaskStore(initial: Record<string, string> = {}) {
  const writes: RecWrite[] = [];
  const events: Array<{ taskId: string; type: string; payload?: unknown }> = [];
  const current = new Map<string, string>(Object.entries(initial));
  const waiters = new Map<string, Array<() => void>>();

  const store: OrchestratorTaskStore = {
    updateStatus(taskId, status, fields) {
      writes.push({ taskId, status, fields });
      current.set(taskId, status);
      if (status === 'awaiting_input') {
        const ws = waiters.get(taskId);
        if (ws) {
          waiters.delete(taskId);
          for (const w of ws) w();
        }
      }
    },
    appendEvent(evt) {
      events.push(evt);
    },
    unregisterCancellation: () => {},
    read(taskId) {
      return { status: current.get(taskId) };
    },
  };

  const whenParked = (taskId: string): Promise<void> =>
    new Promise((resolve) => {
      if (current.get(taskId) === 'awaiting_input') {
        resolve();
        return;
      }
      const ws = waiters.get(taskId) ?? [];
      ws.push(resolve);
      waiters.set(taskId, ws);
    });

  const statusesOf = (taskId: string): string[] =>
    writes.filter((w) => w.taskId === taskId).map((w) => w.status);

  const lastStatusOf = (taskId: string): string | undefined =>
    statusesOf(taskId).at(-1);

  return { store, writes, events, whenParked, statusesOf, lastStatusOf };
}

/** Task store that answers its own `awaiting_input` (a `suspend` resume). */
function makeAutoAnswerStore(answer: string) {
  const writes: RecWrite[] = [];
  const store: OrchestratorTaskStore = {
    updateStatus(taskId, status, fields) {
      writes.push({ taskId, status, fields });
      if (status === 'awaiting_input') resolveHitl(taskId, answer);
    },
    appendEvent: () => {},
    unregisterCancellation: () => {},
  };
  return { store, writes };
}

/** Session store that records tool-result payloads (the model-visible refusal). */
function makeSessionStore(): {
  store: OrchestratorSessionStore;
  toolResults: string[];
} {
  const toolResults: string[] = [];
  const store: OrchestratorSessionStore = {
    appendMessage: async (_sessionId, message: Message) => {
      if (message.role === 'tool' && message.toolResults) {
        for (const tr of message.toolResults) {
          toolResults.push(JSON.stringify(tr.result));
        }
      }
    },
    close: () => {},
  };
  return { store, toolResults };
}

/** Bounded deterministic await — fails loudly instead of hanging the suite. */
function withDeadline<T>(p: Promise<T>, label: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout: ${label} not observed within ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function makeRunInput(
  ctx: ExecutionContext,
  opts: {
    ts: ReturnType<typeof makeRecordingTaskStore>;
    executed: string[];
    sessionStore: OrchestratorSessionStore;
    signal?: AbortSignal;
    hooks?: IHookRegistry;
    policy?: PolicyEngine;
  }
): OrchestratorRunInput {
  return {
    executionContext: ctx,
    messages: [userMessage(ctx.sessionId)],
    registry: makeRegistry(opts.executed),
    provider: scriptedProvider(),
    policy: opts.policy ?? permitPolicy(),
    taskStore: opts.ts.store,
    sessionStore: opts.sessionStore,
    signal: opts.signal ?? new AbortController().signal,
    taskId: ctx.taskId,
    hooks: opts.hooks ?? noopHooks,
    config: engineConfig(() => 'ask'),
    logger: silentLogger,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #1 — an APPROVED suspend must execute (fall through), not be skipped
// ─────────────────────────────────────────────────────────────────────────────

describe('#1 — an APPROVED suspend falls through to execution', () => {
  it('fires pre:tool_call, calls policy.check, increments toolCallCount, and runs the tool', async () => {
    const ctx = makeSuspendCtx(); // default HITL → resolution 'suspend'
    const { store: taskStore, writes } = makeAutoAnswerStore('approve');
    const { store: sessionStore } = makeSessionStore();
    const executed: string[] = [];

    const preToolCalls: string[] = [];
    const checkedTools: string[] = [];
    const hooks = {
      register: () => {},
      emit: async (event: string, payload: { toolName?: string }) => {
        if (event === 'pre:tool_call' && payload?.toolName) {
          preToolCalls.push(payload.toolName);
        }
      },
      registerEnforcement: () => {},
      enforce: async () => {},
    } as unknown as IHookRegistry;
    const policy = {
      check: (input: { targetTool: string }) => {
        checkedTools.push(input.targetTool);
      },
    } as unknown as PolicyEngine;

    const result = await new Orchestrator().run({
      executionContext: ctx,
      messages: [userMessage(ctx.sessionId)],
      registry: makeRegistry(executed),
      provider: scriptedProvider(),
      policy,
      taskStore,
      sessionStore,
      signal: new AbortController().signal,
      taskId: ctx.taskId,
      hooks,
      config: engineConfig(() => 'ask'),
      logger: silentLogger,
    });

    expect(result.result).toBe('finished');
    expect(executed, 'an approved suspend must run the tool').toEqual([
      'agent-mcp__task',
    ]);
    expect(preToolCalls, 'pre:tool_call must fire for an approved suspend').toEqual([
      'agent-mcp__task',
    ]);
    expect(checkedTools, 'policy.check must run for an approved suspend').toEqual([
      'agent-mcp__task',
    ]);
    expect(ctx.toolCallCount, 'toolCallCount must increment').toBe(1);
    // The suspend was entered and answered, not skipped.
    expect(writes.map((w) => w.status)).toContain('awaiting_input');

    // NEGATIVE CONTROL (revert-failing): with the stray `continue` restored,
    // control leaves the suspend branch before pre:tool_call — `executed` stays
    // [], `preToolCalls` stays [], `checkedTools` stays [], `toolCallCount` is 0,
    // and this test goes RED.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX #5 — escalate branch (parent-approves-HITL)
// ─────────────────────────────────────────────────────────────────────────────

describe('#5 — escalate routes the ask to the immediate parent', () => {
  it('(a) parks the parent `awaiting_input` with a token and the child tokenless', async () => {
    const parentId = generateId();
    const ctx = makeChildCtx(parentId);
    const ts = makeRecordingTaskStore({ [parentId]: 'running' });
    const { store: sessionStore } = makeSessionStore();
    const executed: string[] = [];

    const parked = ts.whenParked(parentId);
    const runPromise = new Orchestrator().run(
      makeRunInput(ctx, { ts, executed, sessionStore })
    );
    try {
      await withDeadline(parked, 'parent parked awaiting_input');

      const parentWrite = ts.writes.find(
        (w) => w.taskId === parentId && w.status === 'awaiting_input'
      );
      expect(parentWrite, 'parent must be parked awaiting_input').toBeDefined();
      expect(
        typeof parentWrite?.fields?.['resumeToken'],
        'parent holds the resumeToken'
      ).toBe('string');
      expect(
        (parentWrite?.fields?.['resumeToken'] as string).length
      ).toBeGreaterThan(0);

      const childWrite = ts.writes.find(
        (w) => w.taskId === ctx.taskId && w.status === 'awaiting_input'
      );
      expect(childWrite, 'child must be parked awaiting_input').toBeDefined();
      expect(
        childWrite?.fields?.['resumeToken'],
        'child is parked TOKENLESS — it can never self-approve'
      ).toBeNull();
    } finally {
      resolveHitl(parentId, 'allow');
      await runPromise.catch(() => {});
    }

    // NEGATIVE CONTROL: if the child were parked WITH the token (or the parent
    // without it) the `resumeToken` assertions above go RED.
  });

  it('(b) approve → the tool executes AND both statuses are restored', async () => {
    const parentId = generateId();
    const ctx = makeChildCtx(parentId);
    const ts = makeRecordingTaskStore({ [parentId]: 'running' });
    const { store: sessionStore } = makeSessionStore();
    const executed: string[] = [];

    const parked = ts.whenParked(parentId);
    const runPromise = new Orchestrator().run(
      makeRunInput(ctx, { ts, executed, sessionStore })
    );
    const result = await (async () => {
      await withDeadline(parked, 'parent parked');
      resolveHitl(parentId, 'allow');
      return runPromise;
    })();

    expect(result.result).toBe('finished');
    expect(executed, 'an approved escalate runs the tool').toEqual([
      'agent-mcp__task',
    ]);
    expect(
      ts.statusesOf(parentId),
      'parent parked then restored to its pre-ask status'
    ).toEqual(['awaiting_input', 'running']);
    expect(
      ts.statusesOf(ctx.taskId),
      'child resumes running and completes'
    ).toEqual(['running', 'awaiting_input', 'running', 'completed']);

    // NEGATIVE CONTROL: if the parent restore were removed the parent would end
    // `awaiting_input`, and the `toEqual([... , 'running'])` above goes RED.
  });

  it('(c) decline → the tool is denied and both statuses are restored', async () => {
    const parentId = generateId();
    const ctx = makeChildCtx(parentId);
    const ts = makeRecordingTaskStore({ [parentId]: 'running' });
    const { store: sessionStore, toolResults } = makeSessionStore();
    const executed: string[] = [];

    const parked = ts.whenParked(parentId);
    const runPromise = new Orchestrator().run(
      makeRunInput(ctx, { ts, executed, sessionStore })
    );
    const result = await (async () => {
      await withDeadline(parked, 'parent parked');
      resolveHitl(parentId, 'no'); // not an explicit approval → decline
      return runPromise;
    })();

    expect(result.result).toBe('finished');
    expect(executed, 'a declined escalate never executes the tool').toEqual([]);
    expect(toolResults.join('\n')).toContain('PERMISSION_ASK_DENIED');
    expect(ts.statusesOf(parentId)).toEqual(['awaiting_input', 'running']);
    expect(ts.lastStatusOf(ctx.taskId)).toBe('completed');

    // NEGATIVE CONTROL: approving on a 'no' (i.e. breaking isPermissionApproval)
    // would execute the tool and flip the `toBe([])` assertion RED.
  });

  it('(d) a 2nd child asking while the parent resolver is live is denied', async () => {
    const parentId = generateId();
    const ctx1 = makeChildCtx(parentId);
    const ctx2 = makeChildCtx(parentId);
    const ts = makeRecordingTaskStore({ [parentId]: 'running' });
    const s1 = makeSessionStore();
    const s2 = makeSessionStore();
    const executed1: string[] = [];
    const executed2: string[] = [];

    const parked = ts.whenParked(parentId);
    const run1 = new Orchestrator().run(
      makeRunInput(ctx1, { ts, executed: executed1, sessionStore: s1.store })
    );
    try {
      await withDeadline(parked, 'parent parked by child 1');

      // Child 1 now holds the parent's resolver. Child 2 must fail closed.
      const result2 = await withDeadline(
        new Orchestrator().run(
          makeRunInput(ctx2, { ts, executed: executed2, sessionStore: s2.store })
        ),
        'child 2 completes (a clobbered resolver would HANG here)',
        2000
      );
      expect(result2.result).toBe('finished');
      expect(executed2, 'the 2nd child never executes its tool').toEqual([]);
      expect(s2.toolResults.join('\n')).toContain('PERMISSION_ASK_DENIED');
      expect(
        ts.statusesOf(ctx2.taskId),
        'the 2nd child is denied without parking'
      ).not.toContain('awaiting_input');
      expect(
        JSON.stringify(ts.events),
        'the deny names the live pending request'
      ).toContain('already has a pending approval request');
    } finally {
      resolveHitl(parentId, 'allow');
      await withDeadline(run1, 'child 1 completes', 2000).catch(() => {});
    }

    expect(executed1, 'child 1 still executes once the parent approves').toEqual([
      'agent-mcp__task',
    ]);

    // NEGATIVE CONTROL: removing the `hitlResolvers.has(parentId)` guard lets
    // child 2 clobber child 1's resolver (hang) and reach `awaiting_input` — the
    // `.not.toContain('awaiting_input')` and `toBe([])` assertions go RED.
  });

  it('(e) aborting the child signal RESTORES the parent (fix #2)', async () => {
    const parentId = generateId();
    const ctx = makeChildCtx(parentId);
    const ts = makeRecordingTaskStore({ [parentId]: 'running' });
    const { store: sessionStore } = makeSessionStore();
    const executed: string[] = [];
    const controller = new AbortController();

    const parked = ts.whenParked(parentId);
    const runPromise = new Orchestrator().run(
      makeRunInput(ctx, {
        ts,
        executed,
        sessionStore,
        signal: controller.signal,
      })
    );

    await withDeadline(parked, 'parent parked');
    controller.abort();

    await expect(runPromise).rejects.toThrow(
      'Task cancelled while awaiting parent approval'
    );
    expect(
      ts.lastStatusOf(parentId),
      'the parent MUST be restored even though the approval promise rejected'
    ).toBe('running');
    expect(executed, 'an aborted escalate never executes the tool').toEqual([]);

    // NEGATIVE CONTROL (proves #2): with the restore outside a `finally`, the
    // rejected promise skips it and the parent's last status stays
    // `awaiting_input` — this assertion goes RED.
  });
});
