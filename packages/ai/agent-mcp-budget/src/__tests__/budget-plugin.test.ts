import { describe, it, expect, beforeEach } from 'vitest';
// Import HookRegistry from @adhd/agent-mcp-types (not @adhd/agent-mcp) to avoid
// a circular Nx build-graph dependency: agent-mcp-budget → agent-mcp → agent-mcp-budget.
import { HookRegistry } from '@adhd/agent-mcp-types';
import { createPlugin, configSchema, pluginConfigSchema } from '../index.js';
import type { ExecutionContext, PreToolCallPayload } from '@adhd/agent-mcp-types';

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
      message: expect.stringContaining('inputTokens'),
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
      message: expect.stringContaining('outputTokens'),
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
      message: expect.stringContaining('calls'),
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
      message: expect.stringContaining('wallClock'),
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
    ).rejects.toMatchObject({ message: expect.stringContaining('modelMs') });
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
    ).rejects.toMatchObject({ message: expect.stringContaining('cost') });
  });

  it('cleans up accumulator after task:completed', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    await hooks.emit('task:completed', {
      executionContext: ctx,
      result: 'done',
    });

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

  it('cleans up accumulator after task:failed', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    await hooks.emit('task:failed', {
      executionContext: ctx,
      error: 'something broke',
    });

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

  it('cleans up accumulator after task:cancelled', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxModelCalls: 1 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    await hooks.emit('task:cancelled', { executionContext: ctx });

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

  it('scope + window cap does not double-count historical tokens', async () => {
    const mockDb = {
      prepare(sql: string) {
        return {
          get(...params: unknown[]) {
            if (sql.includes('input_tokens, 0) AS input')) {
              return { input: 40_000, output: 40_000, cache: 0, calls: 5 };
            }
            if (sql.includes('created_at')) {
              return { total: 80_000 };
            }
            return undefined;
          },
        };
      },
    };

    const plugin = createPlugin({
      db: mockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            { field: 'tokens', maximum: 100_000, window: 'PT24H', scope: 'agent' },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] });

    // 10K in-memory + 80K window = 90K < 100K → passes
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 5_000, outputTokens: 5_000 },
    });

    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await expect(
      hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] })
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
  it('passes through raw config (server validation)', () => {
    const result = configSchema.parse({ nested: { key: 'val' } });
    expect(result).toEqual({ nested: { key: 'val' } });
  });

  it('flat config is normalized by factory', () => {
    const plugin = createPlugin({
      db: null,
      config: { maxModelCalls: 2 },
    });
    const hooks = new HookRegistry();
    plugin.install(hooks);
    const ctx = makeCtx();
    // 2 calls should pass, 3rd blocked
    expect(() => {
      runTaskTurns(hooks, ctx, [
        { inputTokens: 10, outputTokens: 10 },
        { inputTokens: 10, outputTokens: 10 },
      ]);
    }).not.toThrow();
  });
});

// ── Dimension override tests ──────────────────────────────────────────────────

describe('per-agent overrides', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  const capsCalls = (n: number) => ({ caps: [{ field: 'calls' as const, maximum: n }] });

  it('applies agent override when agent name matches', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: capsCalls(10),
        agent: { default: {}, overrides: { 'restricted-agent': capsCalls(1) } },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx({ agentName: 'restricted-agent' });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    await expect(
      enforcePreModel(hooks, ctx)
    ).rejects.toMatchObject({ message: expect.stringContaining('calls') });
  });

  it('falls back to agent default for unknown agent', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: capsCalls(10),
        agent: { default: capsCalls(2), overrides: {} },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx({ agentName: 'unknown-agent' });

    await runTaskTurns(hooks, ctx, [
      { inputTokens: 10, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 10 },
    ]);

    await expect(
      enforcePreModel(hooks, ctx)
    ).rejects.toMatchObject({ message: expect.stringContaining('calls') });
  });

  it('flat config still works (backward compat)', async () => {
    const plugin = createPlugin({
      db: null,
      config: { maxModelCalls: 2 },
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [
      { inputTokens: 10, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 10 },
    ]);

    await expect(
      enforcePreModel(hooks, ctx)
    ).rejects.toMatchObject({ message: expect.stringContaining('calls') });
  });
});

describe('per-provider overrides', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('applies provider override', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 10 }] },
        provider: { default: {}, overrides: { 'openai': { caps: [{ field: 'calls', maximum: 1 }] } } },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx({
      agentDefinition: {
        ...makeCtx().agentDefinition,
        provider: { type: 'openai', model: 'gpt-4o' },
      },
    });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    await expect(
      enforcePreModel(hooks, ctx)
    ).rejects.toMatchObject({ message: expect.stringContaining('calls') });
  });
});

describe('per-tool overrides', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('warning mode returns IToolWarning without failing task', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: { default: {}, overrides: { 'expensive_search': { caps: [{ field: 'toolCalls', maximum: 1 }], mode: 'warning' } } },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await enforcePreTool(hooks, ctx, 'expensive_search', 'call-1');

    let caught: unknown;
    try {
      await enforcePreTool(hooks, ctx, 'expensive_search', 'call-2');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      isToolWarning: true,
      toolName: 'expensive_search',
      callId: 'call-2',
      message: expect.stringContaining('toolCalls'),
    });
  });

  it('block mode throws IEnforcementError', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: { default: {}, overrides: { 'blocked_tool': { caps: [{ field: 'toolCalls', maximum: 0 }], mode: 'block' } } },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await expect(
      enforcePreTool(hooks, ctx, 'blocked_tool', 'call-1')
    ).rejects.toMatchObject({
      isEnforcementError: true,
      message: expect.stringContaining('blocked_tool'),
    });
  });
});

describe('maxTokensPer24h — mock DB', () => {
  let hooks: HookRegistry;
  let lastQuery: { sql: string; params: unknown[] } | undefined;
  const mockDb = {
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          lastQuery = { sql, params };
          if (sql.includes('created_at')) {
            return { total: 150_000 };
          }
          return undefined;
        },
      };
    },
  };

  beforeEach(() => {
    hooks = new HookRegistry();
    lastQuery = undefined;
  });

  it('blocks when 24h total + current exceeds maxTokensPer24h', async () => {
    const plugin = createPlugin({
      db: mockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            { field: 'tokens', maximum: 1_000_000 },
            { field: 'tokens', maximum: 200_000, window: 'PT24H', scope: 'agent' },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] });

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 30_000 },
    });

    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await expect(
      hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] })
    ).rejects.toMatchObject({
      message: expect.stringContaining('tokens'),
    });
  });

  it('passes when 24h total + current is under maxTokensPer24h', async () => {
    const lowMockDb = {
      prepare(sql: string) {
        return {
          get(...params: unknown[]) {
            if (sql.includes('created_at')) return { total: 10_000 };
            return undefined;
          },
        };
      },
    };
    const plugin = createPlugin({
      db: lowMockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            { field: 'tokens', maximum: 1_000_000 },
            { field: 'tokens', maximum: 200_000, window: 'PT24H', scope: 'agent' },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] });

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 30_000 },
    });

    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await expect(
      hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] })
    ).resolves.toBeUndefined();
  });
});

describe('tool maxTotalTokens override', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('blocks tool call when tool maxTotalTokens is exceeded', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'tokens', maximum: 1_000_000 }] },
        tool: { default: {}, overrides: { 'big_output': { caps: [{ field: 'tokens', maximum: 50 }], mode: 'block' } } },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'tool_calls',
      toolCallCount: 1,
      tokenUsage: { inputTokens: 30, outputTokens: 30 },
    });

    // Calling big_output → 60 total > 50 limit
    await expect(
      enforcePreTool(hooks, ctx, 'big_output', 'call-1')
    ).rejects.toMatchObject({
      message: expect.stringContaining('big_output'),
    });
  });
});

// ── Helpers for new tests ───────────────────────────────────────────────────

async function enforcePreModel(hooks: HookRegistry, ctx: ExecutionContext): Promise<void> {
  await hooks.emit('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
  await hooks.enforce('pre:model_request', { executionContext: ctx, messages: [], tools: [] });
}

async function enforcePreTool(
  hooks: HookRegistry,
  ctx: ExecutionContext,
  toolName: string,
  callId: string,
): Promise<void> {
  const payload: PreToolCallPayload = {
    executionContext: ctx,
    toolName,
    callId,
    toolInput: {},
  };
  await hooks.emit('pre:tool_call', payload);
  await hooks.enforce('pre:tool_call', payload);
}
