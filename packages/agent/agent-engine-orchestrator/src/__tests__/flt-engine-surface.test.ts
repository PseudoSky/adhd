/**
 * de6bee5d FLT-AC1 — what the REAL engine (`Orchestrator.run`) does with a typed provider fault.
 *
 * The provider adapters throw `ProviderCallError` (code + `data: ProviderFailure`, `resetAt`). The
 * engine's provider catch propagates a `ToolError` UNCHANGED, so the class-specific code and `data`
 * reach the thrown task error AND the TASK_FAILED event. Untyped throws still fall back to the legacy
 * status/message classification.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../engine/orchestrator.js';
import type { OrchestratorTaskStore, OrchestratorSessionStore } from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { HookRegistry } from '@adhd/agent-base-types';
import { classifyProviderError } from '@adhd/agent-core-provider';
import { classifyCliFault, ProviderCallError, describeFailure } from '../providers/provider-failure.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineLogger } from '../interfaces.js';
import type { LLMProvider } from '../providers/types.js';

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ctx = (): ExecutionContext => ({
  taskId: generateId(),
  sessionId: generateId(),
  agentName: 'a',
  agentDefinition: { name: 'a', version: 1, provider: { type: 'openai', model: 'm' }, systemPrompt: 's', mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso() } as ExecutionContext['agentDefinition'],
  recursionDepth: 0,
  toolCallCount: 0,
});

type Ev = { taskId: string; type: string; payload?: unknown };

async function runWith(
  err: Error,
  events: Ev[] = [],
): Promise<Error> {
  const c = ctx();
  const provider: LLMProvider = { chat: async () => { throw err; } };
  const user: Message = { id: generateId(), sessionId: c.sessionId, role: 'user', content: 'hi', createdAt: nowIso() };
  const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: (e) => { events.push(e); }, unregisterCancellation: () => {} };
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  try {
    await new Orchestrator().run({
      executionContext: c, messages: [user],
      registry: { listAllTools: async () => [], closeAll: async () => {} } as unknown as McpClientRegistry,
      provider, policy: { check: () => {} } as unknown as PolicyEngine, taskStore, sessionStore,
      signal: new AbortController().signal, taskId: c.taskId, hooks: new HookRegistry(), logger,
    });
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the run to fail');
}

const codeOf = (e: Error) => (e as { code?: string }).code;
const dataOf = (e: Error) => (e as { data?: Record<string, unknown> }).data;

describe('de6bee5d FLT-AC1 engine seam (engine/orchestrator.ts provider catch)', () => {
  const ctxCli = { providerType: 'claudecli' as const, modelRef: 'm', wireModel: 'm', credentialKey: 'k', credentialScope: 'k' };
  const resetAt = 1_800_003_600_000;
  const hit = classifyCliFault({ toolUseEmitted: false, rejected: { status: 'rejected', resetsAt: resetAt / 1000 } }, ctxCli, resetAt - 3_600_000)!;
  const usageWindow = () => new ProviderCallError(hit.failure, describeFailure(hit.failure, hit.resetAtMs), hit.resetAtMs);
  const anthropicCtx = { ...ctxCli, providerType: 'anthropic' as const };

  it('FLT-AC1: a usage-window fault is PROVIDER_RATE_LIMITED with data.class/retryable and resetAt preserved', async () => {
    const e = await runWith(usageWindow());
    expect(codeOf(e)).toBe('PROVIDER_RATE_LIMITED');
    expect(e.message).toContain(new Date(resetAt).toISOString());
    expect(dataOf(e)).toMatchObject({ class: hit.failure.class, retryable: hit.failure.retryable });
    expect((e as { resetAt?: string }).resetAt).toBe(new Date(resetAt).toISOString());
  });

  it('FLT-AC1: the SAME ToolError instance reaches the caller (no rebuild), and TASK_FAILED carries code, data and resetAt', async () => {
    const original = usageWindow();
    const events: Ev[] = [];
    const e = await runWith(original, events);
    expect(e).toBe(original);
    const failed = events.find((x) => x.type === 'TASK_FAILED');
    expect(failed?.payload).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      data: { class: hit.failure.class, retryable: hit.failure.retryable },
      resetAt: new Date(resetAt).toISOString(),
    });
  });

  it('FLT-AC1: billing is PROVIDER_BILLING with its typed data (not flattened to PROVIDER_ERROR)', async () => {
    const billing = classifyProviderError({
      ...anthropicCtx, source: 'http', status: 402,
      body: { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } },
    });
    const e = await runWith(new ProviderCallError(billing, describeFailure(billing)));
    expect(codeOf(e)).toBe('PROVIDER_BILLING');
    expect(dataOf(e)).toMatchObject({ class: 'billing' });
  });

  it('FLT-AC1: overloaded (529) is PROVIDER_OVERLOADED, retryable data preserved', async () => {
    const overloaded = classifyProviderError({
      ...anthropicCtx, source: 'http', status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    const e = await runWith(new ProviderCallError(overloaded, describeFailure(overloaded)));
    expect(codeOf(e)).toBe('PROVIDER_OVERLOADED');
    expect(dataOf(e)).toMatchObject({ class: 'overloaded', retryable: true });
  });

  it('FLT-AC1: auth stays PROVIDER_AUTH_ERROR', async () => {
    const auth = classifyProviderError({
      ...anthropicCtx, source: 'http', status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    });
    const e = await runWith(new ProviderCallError(auth, describeFailure(auth)));
    expect(codeOf(e)).toBe('PROVIDER_AUTH_ERROR');
    expect(dataOf(e)).toMatchObject({ class: 'auth' });
  });

  it('FLT-AC1 fallback: an UNTYPED 429 / rate-limit throw is still classified by the legacy rules', async () => {
    const e429 = Object.assign(new Error('boom'), { status: 429 });
    expect(codeOf(await runWith(e429))).toBe('PROVIDER_RATE_LIMITED');
    expect(codeOf(await runWith(new Error('hit the rate limit')))).toBe('PROVIDER_RATE_LIMITED');
    expect(codeOf(await runWith(new Error('prompt is too long')))).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(codeOf(await runWith(new Error('kaboom')))).toBe('PROVIDER_ERROR');
  });

  it('FLT-4 / FLT-AC1: window warnings from a SUCCEEDED call are persisted on the MODEL_RESPONSE event', async () => {
    const c = ctx();
    const warning = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 };
    const provider = {
      chat: async () => ({
        message: { id: generateId(), sessionId: c.sessionId, role: 'assistant', content: 'ok', createdAt: nowIso() },
        stopReason: 'completed',
        limitWarnings: [warning],
      }),
    } as unknown as LLMProvider;
    const events: Ev[] = [];
    const user: Message = { id: generateId(), sessionId: c.sessionId, role: 'user', content: 'hi', createdAt: nowIso() };
    const out = await new Orchestrator().run({
      executionContext: c, messages: [user],
      registry: { listAllTools: async () => [], closeAll: async () => {} } as unknown as McpClientRegistry,
      provider, policy: { check: () => {} } as unknown as PolicyEngine,
      taskStore: { updateStatus: () => {}, appendEvent: (e) => { events.push(e); }, unregisterCancellation: () => {} },
      sessionStore: { appendMessage: async () => {}, close: () => {} },
      signal: new AbortController().signal, taskId: c.taskId, hooks: new HookRegistry(), logger,
    });
    expect(out.result).toBe('ok');
    const resp = events.find((x) => x.type === 'MODEL_RESPONSE');
    expect((resp?.payload as { limitWarnings?: unknown }).limitWarnings).toEqual([warning]);
  });
});
