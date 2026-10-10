/**
 * de6bee5d FLT — what the REAL engine does with a typed provider fault (characterization).
 *
 * The provider adapters throw `ProviderCallError` (code + `data: ProviderFailure`). The engine's
 * provider-error catch (`engine/orchestrator.ts`, "Provider call failed") re-derives the code from
 * `status` / message text and rethrows a NEW `ToolError` with no `data`. These tests pin today's
 * observable behaviour so the follow-up (rethrow a `ToolError` unchanged) is a visible change:
 *   - the reset time survives, because it is in the message text;
 *   - the class-specific code does NOT survive (PROVIDER_BILLING / PROVIDER_OVERLOADED -> PROVIDER_ERROR).
 * FLT-AC1 at the engine seam is therefore only PARTIALLY met until that catch is fixed (reported).
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

async function runWith(err: Error): Promise<Error> {
  const c = ctx();
  const provider: LLMProvider = { chat: async () => { throw err; } };
  const user: Message = { id: generateId(), sessionId: c.sessionId, role: 'user', content: 'hi', createdAt: nowIso() };
  const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
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

describe('de6bee5d FLT engine seam (characterization of engine/orchestrator.ts provider catch)', () => {
  const ctxCli = { providerType: 'claudecli' as const, modelRef: 'm', wireModel: 'm', credentialKey: 'k', credentialScope: 'k' };
  const resetAt = 1_800_003_600_000;
  const hit = classifyCliFault({ toolUseEmitted: false, rejected: { status: 'rejected', resetsAt: resetAt / 1000 } }, ctxCli, resetAt - 3_600_000)!;

  it('FLT-AC1 (engine seam): the reset time reaches the task error text', async () => {
    const e = await runWith(new ProviderCallError(hit.failure, describeFailure(hit.failure, hit.resetAtMs), hit.resetAtMs));
    expect(e.message).toContain(new Date(resetAt).toISOString());
    expect((e as { code?: string }).code).not.toBe('PROVIDER_AUTH_ERROR');
  });

  it('FLT-AC1 (engine seam): GAP - the engine drops `data`; a window is RATE_LIMITED only by its "429" text, billing/overloaded flatten to PROVIDER_ERROR', async () => {
    const window = await runWith(new ProviderCallError(hit.failure, describeFailure(hit.failure, hit.resetAtMs), hit.resetAtMs));
    // Coincidental: the engine's `message.includes('429')` rule matches the "(HTTP 429)" in the message.
    expect((window as { code?: string }).code).toBe('PROVIDER_RATE_LIMITED');
    expect((window as { data?: unknown }).data).toBeUndefined();

    const billing = classifyProviderError({
      ...ctxCli, providerType: 'anthropic', source: 'http', status: 402,
      body: { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } },
    });
    const e = await runWith(new ProviderCallError(billing, describeFailure(billing)));
    // Today. When the engine rethrows a ToolError unchanged this becomes PROVIDER_BILLING with data.
    expect((e as { code?: string }).code).toBe('PROVIDER_ERROR');
    expect((e as { data?: unknown }).data).toBeUndefined();
  });
});
