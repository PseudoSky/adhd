import { describe, expect, it } from 'vitest';

import { Orchestrator, resolveHitl } from '../engine/orchestrator.js';
import type {
  OrchestratorTaskStore,
  OrchestratorSessionStore,
} from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderChatResponse,
  ToolDefinition,
} from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';

/**
 * HITL / permission-gate regression teeth — the three HIGH/LOW review findings
 * in the native-tooling epic (dispatch-2026-10-04-9c4e):
 *
 *  - `0ea6f9e0` (FIX 1): `nativeTooling.hitl` must drive `request_human_input`
 *    ADVERTISEMENT and the per-call handler, not the legacy `allowHumanInput`
 *    opt-in alone. `hitl:false` hides the tool AND fails a would-be ask closed.
 *  - `f5abca83` (FIX 2, engine half): a run whose suspension is NOT answerable
 *    (`suspensionAnswerable:false` — the synchronous transport) must resolve an
 *    `ask` to the fail-closed floor, never suspend.
 *
 * The engine is driven through its real `run()`; the ONLY stubs are the external
 * LLM provider and the MCP registry/transport boundary, per repo policy.
 */

const policy = {
  check: () => {
    /* no-op: policy always permits */
  },
} as unknown as PolicyEngine;

const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** EngineConfig carrying only what run() reads here (server + permissionGate). */
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

function makeCtx(
  defOverrides: Partial<ExecutionContext['agentDefinition']> = {}
): ExecutionContext {
  const agentDefinition = {
    name: 'test-agent',
    version: 1,
    provider: { type: 'openai', model: 'gpt-4o-mini' },
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...defOverrides,
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

const RICH_TOOL: ToolDefinition = {
  name: 'agent-mcp__task',
  description: 'dispatch a sub-agent',
  inputSchema: { type: 'object', properties: {} },
};

/** Registry that returns `tools` and executes every call, recording the names. */
function makeRegistry(tools: ToolDefinition[], executed: string[] = []): McpClientRegistry {
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

/** Provider that captures every request and replays scripted turns in order. */
function capturingProvider(
  turns: Array<{ kind: 'completed'; content: string } | { kind: 'tool'; server: string; tool: string; prompt?: string }>
): { provider: LLMProvider; requests: ProviderChatRequest[] } {
  const requests: ProviderChatRequest[] = [];
  let call = 0;
  const provider: LLMProvider = {
    chat: async (request: ProviderChatRequest): Promise<ProviderChatResponse> => {
      requests.push(request);
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      const sessionId = generateId();
      if (turn.kind === 'completed') {
        return {
          message: {
            id: generateId(),
            sessionId,
            role: 'assistant',
            content: turn.content,
            createdAt: nowIso(),
          },
          stopReason: 'completed',
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: generateId(),
              server: turn.server,
              tool: turn.tool,
              arguments: turn.prompt ? { prompt: turn.prompt } : {},
            },
          ],
          createdAt: nowIso(),
        },
        stopReason: 'tool_calls',
      };
    },
  };
  return { provider, requests };
}

/**
 * Session store that records appended tool-result messages (role `tool`) so a
 * test can inspect the error payload the model would see.
 */
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

/**
 * Task store that records every status written and, when the orchestrator tries
 * to SUSPEND, immediately answers the ask so the run finishes deterministically
 * (no hang, no timing). `awaitingInputs` is the teeth: a run that must NOT
 * suspend leaves it empty; a run that should suspend records an entry.
 */
function makeTaskStore(taskId: string) {
  const statuses: string[] = [];
  let awaitingInputs = 0;
  const store: OrchestratorTaskStore = {
    updateStatus: (tid, status) => {
      statuses.push(status);
      if (status === 'awaiting_input') {
        awaitingInputs++;
        if (tid === taskId) resolveHitl(tid, 'allow');
      }
    },
    appendEvent: () => {},
    unregisterCancellation: () => {},
  };
  return {
    store,
    statuses,
    get awaitingInputs() {
      return awaitingInputs;
    },
  };
}

async function run(
  ctx: ExecutionContext,
  provider: LLMProvider,
  opts: {
    registry?: McpClientRegistry;
    taskStore?: OrchestratorTaskStore;
    sessionStore?: OrchestratorSessionStore;
    config?: EngineConfig;
    suspensionAnswerable?: boolean;
  } = {}
) {
  return new Orchestrator().run({
    executionContext: ctx,
    messages: [userMessage(ctx.sessionId)],
    registry: opts.registry ?? makeRegistry([RICH_TOOL]),
    provider,
    policy,
    taskStore: opts.taskStore ?? makeTaskStore(ctx.taskId).store,
    sessionStore: opts.sessionStore ?? makeSessionStore().store,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    config: opts.config,
    logger: silentLogger,
    ...(opts.suspensionAnswerable === undefined
      ? {}
      : { suspensionAnswerable: opts.suspensionAnswerable }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — 0ea6f9e0: `nativeTooling.hitl` drives advertisement + the handler
// ─────────────────────────────────────────────────────────────────────────────

describe('0ea6f9e0 FIX 1 — HITL advertisement keys on effectiveHitl, not legacy allowHumanInput', () => {
  it('AC1a: default (hitl true by default) advertises builtin__request_human_input', async () => {
    const ctx = makeCtx(); // no allowHumanInput, no nativeTooling → hitl defaults true
    const { provider, requests } = capturingProvider([{ kind: 'completed', content: 'done' }]);
    await run(ctx, provider);
    expect(requests).toHaveLength(1);
    const names = (requests[0].tools ?? []).map((t) => t.name);
    expect(names).toContain('builtin__request_human_input');
  });

  it('AC1b: nativeTooling.hitl:false HIDES the tool even when legacy allowHumanInput:true', async () => {
    const ctx = makeCtx({ allowHumanInput: true, nativeTooling: { hitl: false } });
    const { provider, requests } = capturingProvider([{ kind: 'completed', content: 'done' }]);
    await run(ctx, provider);
    const names = (requests[0].tools ?? []).map((t) => t.name);
    expect(names).not.toContain('builtin__request_human_input');

    // NEGATIVE CONTROL (revert-failing): the LEGACY predicate the pre-fix code
    // used (`allowHumanInput === true`) IS true for this definition — so it would
    // have advertised the tool. The fix is what suppresses it.
    expect(ctx.agentDefinition.allowHumanInput).toBe(true);
  });

  it('AC1c: explicit hitl:true advertises the tool (hitl wins over allowHumanInput:false)', async () => {
    const ctx = makeCtx({ allowHumanInput: false, nativeTooling: { hitl: true } });
    const { provider, requests } = capturingProvider([{ kind: 'completed', content: 'done' }]);
    await run(ctx, provider);
    const names = (requests[0].tools ?? []).map((t) => t.name);
    expect(names).toContain('builtin__request_human_input');
  });

  it('AC1d: a would-be ask FAILS CLOSED when hitl:false (no suspend, typed refusal)', async () => {
    const ctx = makeCtx({ allowHumanInput: true, nativeTooling: { hitl: false } });
    const tasks = makeTaskStore(ctx.taskId);
    const { store: sessionStore, toolResults } = makeSessionStore();
    const { provider } = capturingProvider([
      { kind: 'tool', server: 'builtin', tool: 'request_human_input', prompt: 'confirm?' },
      { kind: 'completed', content: 'done' },
    ]);

    const result = await run(ctx, provider, {
      taskStore: tasks.store,
      sessionStore,
    });

    expect(result.result).toBe('done');
    expect(tasks.awaitingInputs, 'hitl:false must never suspend on request_human_input').toBe(0);
    expect(tasks.statuses).not.toContain('awaiting_input');
    expect(toolResults.join('\n')).toContain('PERMISSION_ASK_DENIED');

    // NEGATIVE CONTROL (revert-failing): the pre-fix handler ignored hitl and
    // would have suspended (recording awaiting_input) — the assertion above is
    // what goes RED if the gate is reverted.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 — f5abca83 (engine half): a non-answerable run fails an `ask` closed
// ─────────────────────────────────────────────────────────────────────────────

describe('f5abca83 FIX 2 — synchronous (non-answerable) ask fails closed, never suspends', () => {
  it('AC2a: suspensionAnswerable:false + ask → deny, no awaiting_input, PERMISSION_ASK_DENIED', async () => {
    const ctx = makeCtx();
    const tasks = makeTaskStore(ctx.taskId);
    const { store: sessionStore, toolResults } = makeSessionStore();
    const executed: string[] = [];
    const { provider } = capturingProvider([
      { kind: 'tool', server: 'agent-mcp', tool: 'task' },
      { kind: 'completed', content: 'finished' },
    ]);

    const result = await run(ctx, provider, {
      registry: makeRegistry([RICH_TOOL], executed),
      taskStore: tasks.store,
      sessionStore,
      config: engineConfig(() => 'ask'),
      suspensionAnswerable: false,
    });

    expect(result.result).toBe('finished');
    expect(tasks.awaitingInputs, 'a synchronous run must NOT suspend — it would hang').toBe(0);
    expect(executed, 'a denied ask never executes the tool').toEqual([]);
    expect(toolResults.join('\n')).toContain('PERMISSION_ASK_DENIED');

    // NEGATIVE CONTROL (revert-failing): with the fix reverted the flag is
    // ignored, the run suspends (awaitingInputs > 0) and blocks the synchronous
    // caller forever — this assertion goes RED.
  });

  it('AC2b: POSITIVE CONTROL — the same ask with an answerable run DOES suspend (flag is the discriminator)', async () => {
    const ctx = makeCtx();
    const tasks = makeTaskStore(ctx.taskId);
    const executed: string[] = [];
    const { provider } = capturingProvider([
      { kind: 'tool', server: 'agent-mcp', tool: 'task' },
      { kind: 'completed', content: 'finished' },
    ]);

    const result = await run(ctx, provider, {
      registry: makeRegistry([RICH_TOOL], executed),
      taskStore: tasks.store,
      config: engineConfig(() => 'ask'),
      suspensionAnswerable: true,
    });

    expect(tasks.awaitingInputs, 'an answerable run suspends and is resumed').toBe(1);
    expect(result.result).toBe('finished');
    expect(executed, 'an approved ask executes the tool').toEqual(['agent-mcp__task']);
  });
});
