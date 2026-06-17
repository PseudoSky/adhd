import { describe, it, expect, vi, beforeEach } from 'vitest';
// Import HookRegistry from @adhd/agent-mcp-types (not @adhd/agent-mcp) to avoid
// a circular Nx build-graph dependency: agent-mcp-budget → agent-mcp → agent-mcp-budget.
import { HookRegistry } from '@adhd/agent-mcp-types';
import { createPlugin, configSchema } from '../index.js';
import type { ExecutionContext } from '@adhd/agent-mcp-types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    agentDefinition: {
      name: 'test-agent',
      version: 1,
      provider: { type: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: '',
      mcpServers: {},
      permissions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    recursionDepth: 0,
    toolCallCount: 0,
    ...overrides,
  };
}

function makeTokenUsage(inputTokens = 0, outputTokens = 0) {
  return { inputTokens, outputTokens, stopReason: 'stop' as const };
}

async function runTaskTurns(
  hooks: HookRegistry,
  ctx: ExecutionContext,
  turns: Array<{ inputTokens: number; outputTokens: number }>
): Promise<void> {
  await hooks.emit('task:start', { executionContext: ctx, messages: [] });
  for (const turn of turns) {
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(turn.inputTokens, turn.outputTokens),
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BudgetPlugin — task scope', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('passes when tokens are under the limit', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxTotalTokens: 1000 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 200, outputTokens: 100 }]);

    // Second model request — 300 total tokens, limit 1000 → should pass
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).resolves.toBeUndefined();
  });

  it('throws when maxTotalTokens is reached', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxTotalTokens: 100 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(60, 60), // 120 total — exceeds 100
    });

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('throws when maxInputTokens is reached', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxInputTokens: 50 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(60, 5), // 60 input > 50 limit
    });

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      isEnforcementError: true,
      message: expect.stringContaining('maxInputTokens'),
    });
  });

  it('throws when maxOutputTokens is reached', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxOutputTokens: 50 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(5, 80),
    });

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('maxOutputTokens'),
    });
  });

  it('throws when maxModelCalls is reached', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 2 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [
      { inputTokens: 10, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 10 },
    ]);

    // Third call — 2 model calls completed, limit is 2 → block next
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('maxModelCalls'),
    });
  });

  it('throws when maxWallClockMs is exceeded', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxWallClockMs: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    // Wait 5ms so wall clock definitely exceeds 1ms
    await new Promise((r) => setTimeout(r, 5));

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('maxWallClockMs'),
    });
  });

  it('throws when maxModelMs is exceeded', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelMs: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // First model call: set modelCallStartMs, wait, then post response to accumulate time
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await new Promise((r) => setTimeout(r, 5)); // accumulate 5ms of model time
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(10, 10),
    });

    // Second call: totalModelMs should be ~5ms > 1ms limit
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('maxModelMs') });
  });

  it('throws when maxCostUSD is exceeded', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({
        maxCostUSD: 0.001,
        costPerInputToken: 0.000003, // $3/M
        costPerOutputToken: 0.000015, // $15/M
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await hooks.enforce('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    // 100 output * 0.000015 = $0.0015 > $0.001 limit
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: makeTokenUsage(0, 100),
    });

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('maxCostUSD') });
  });

  it('cleans up accumulator after task:completed', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    // Run a task that would hit the limit
    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    await hooks.emit('task:completed', {
      executionContext: ctx,
      result: 'done',
    });

    // New task with the same taskId — accumulator should be reset; limit not hit
    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).resolves.toBeUndefined();
  });

  it('handles missing task:start gracefully (no accumulator)', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    // No task:start — enforcement should be a no-op, not throw
    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).resolves.toBeUndefined();
  });

  it('enforcement error has correct IEnforcementError shape', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    await hooks.emit('pre:model_request', {
      executionContext: ctx,
      messages: [],
      tools: [],
    });
    let caught: unknown;
    try {
      await hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.any(String),
    });
  });
});

describe('BudgetPlugin — teeth tests', () => {
  it('observational emit() never throws even when budget is exceeded', async () => {
    const hooks = new HookRegistry();
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    // emit() must not throw — only enforce() should
    await expect(
      hooks.emit('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).resolves.toBeUndefined();
  });
});

describe('configSchema', () => {
  it('applies defaults', () => {
    const result = configSchema.parse({});
    expect(result.scope).toBe('task');
    expect(result.costPerInputToken).toBe(0);
    expect(result.costPerOutputToken).toBe(0);
  });

  it('rejects negative maxModelCalls', () => {
    expect(() => configSchema.parse({ maxModelCalls: -1 })).toThrow();
  });
});
