import { describe, it, expect, beforeEach } from 'vitest';
// Import HookRegistry from @adhd/agent-base-types (not @adhd/agent-mcp) to avoid
// a circular Nx build-graph dependency: agent-mcp-budget → agent-mcp → agent-mcp-budget.
import { HookRegistry } from '@adhd/agent-base-types';
import { createPlugin, configSchema, pluginConfigSchema } from '../index.js';
import type {
  ExecutionContext,
  PostToolCallPayload,
  PreToolCallPayload,
  BudgetWarningPayload,
  BudgetBlockPayload,
} from '@adhd/agent-base-types';

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
      config: configSchema.parse({ maxTotalTokens: 100, mode: 'block' }),
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
      config: configSchema.parse({ maxInputTokens: 50, mode: 'block' }),
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
      config: configSchema.parse({ maxOutputTokens: 50, mode: 'block' }),
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
      config: configSchema.parse({ maxModelCalls: 2, mode: 'block' }),
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
      config: configSchema.parse({ maxWallClockMs: 1, mode: 'block' }),
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
      config: configSchema.parse({ maxModelMs: 1, mode: 'block' }),
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
        mode: 'block',
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
          get(..._params: unknown[]) {
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
            {
              field: 'tokens',
              maximum: 100_000,
              window: 'PT24H',
              scope: 'agent',
            },
          ],
        },
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

    // 10K in-memory + 80K window = 90K < 100K → passes
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 5_000, outputTokens: 5_000 },
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
      config: configSchema.parse({ maxModelCalls: 1, mode: 'block' }),
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
      config: configSchema.parse({ maxModelCalls: 1, mode: 'block' }),
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

  const capsCalls = (n: number) => ({
    caps: [{ field: 'calls' as const, maximum: n, mode: 'block' }],
  });

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

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('calls'),
    });
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

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('calls'),
    });
  });

  it('flat config still works (backward compat)', async () => {
    const plugin = createPlugin({
      db: null,
      config: { maxModelCalls: 2, mode: 'block' },
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [
      { inputTokens: 10, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 10 },
    ]);

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('calls'),
    });
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
        defaults: { caps: [{ field: 'calls', maximum: 10, mode: 'block' }] },
        provider: {
          default: {},
          overrides: {
            openai: { caps: [{ field: 'calls', maximum: 1, mode: 'block' }] },
          },
        },
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

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('calls'),
    });
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
        tool: {
          default: {},
          overrides: {
            expensive_search: {
              caps: [{ field: 'toolCalls', maximum: 1 }],
              mode: 'warning',
            },
          },
        },
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
        tool: {
          default: {},
          overrides: {
            blocked_tool: {
              caps: [{ field: 'toolCalls', maximum: 0 }],
              mode: 'block',
            },
          },
        },
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

  it('custom cap message overrides default in block mode', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: {
          default: {},
          overrides: {
            expensive_search: {
              caps: [
                {
                  field: 'toolCalls',
                  maximum: 0,
                  mode: 'block',
                  message:
                    'Use the index-based search tool instead: search__query',
                },
              ],
            },
          },
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await expect(
      enforcePreTool(hooks, ctx, 'expensive_search', 'call-1')
    ).rejects.toMatchObject({
      isEnforcementError: true,
      message: 'Use the index-based search tool instead: search__query',
    });
  });

  it('custom cap message overrides default in warning mode', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: {
          default: {},
          overrides: {
            expensive_search: {
              caps: [
                {
                  field: 'toolCalls',
                  maximum: 1,
                  mode: 'warning',
                  message: 'Consider using a cheaper alternative',
                },
              ],
            },
          },
        },
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
      message: 'Consider using a cheaper alternative',
    });
  });

  it('custom cap message on pre:model_request enforcement', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {
          caps: [
            {
              field: 'calls',
              maximum: 0,
              mode: 'block',
              message: 'Task-level model call limit reached',
            },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await expect(
      hooks.enforce('pre:model_request', {
        executionContext: ctx,
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({
      isEnforcementError: true,
      message: 'Task-level model call limit reached',
    });
  });

  it('responseSize block mode replaces result with error', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        tool: {
          overrides: {
            read_file: {
              caps: [
                {
                  field: 'responseSize',
                  maximum: 50,
                  mode: 'block',
                  message: 'File too large, use head -n 100 via shell',
                },
              ],
            },
          },
        },
      }),
    });
    await plugin.install(hooks);
    const result = { content: [{ type: 'text', text: 'x'.repeat(200) }] };
    const payload: PostToolCallPayload = {
      executionContext: makeCtx(),
      toolName: 'read_file',
      callId: 'call-1',
      toolInput: {},
      result,
      isError: false,
      estResultTokens: 0,
    };

    await hooks.emit('transform:tool_result', payload);

    expect(payload.isError).toBe(true);
    expect(payload.result).toMatchObject({
      content: [
        { type: 'text', text: expect.stringContaining('File too large') },
      ],
    });
  });

  it('responseSize warning mode truncates result', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        tool: {
          overrides: {
            read_file: {
              caps: [{ field: 'responseSize', maximum: 30, mode: 'warning' }],
            },
          },
        },
      }),
    });
    await plugin.install(hooks);
    const result = {
      content: [
        { type: 'text', text: 'hello world, this is a long file content' },
      ],
    };
    const payload: PostToolCallPayload = {
      executionContext: makeCtx(),
      toolName: 'read_file',
      callId: 'call-1',
      toolInput: {},
      result,
      isError: false,
      estResultTokens: 0,
    };

    await hooks.emit('transform:tool_result', payload);

    expect(payload.isError).toBe(false);
    const text = (payload.result as unknown as { content: { text: string }[] }).content
      .map((c) => c.text)
      .join('');
    expect(text).toContain('[truncated');
    expect(text).toContain('limited to 30');
  });

  it('responseSize does not truncate when within limit', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        tool: {
          overrides: {
            read_file: {
              caps: [{ field: 'responseSize', maximum: 500 }],
            },
          },
        },
      }),
    });
    await plugin.install(hooks);
    const result = { content: [{ type: 'text', text: 'small file' }] };
    const payload: PostToolCallPayload = {
      executionContext: makeCtx(),
      toolName: 'read_file',
      callId: 'call-1',
      toolInput: {},
      result,
      isError: false,
      estResultTokens: 0,
    };

    await hooks.emit('transform:tool_result', payload);

    expect(payload.isError).toBe(false);
    expect((payload.result as unknown as { content: { text: string }[] }).content[0].text).toBe('small file');
  });
});

describe('maxTokensPer24h — mock DB', () => {
  let hooks: HookRegistry;
  const mockDb = {
    prepare(sql: string) {
      return {
        get(..._params: unknown[]) {
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
    // A `lastQuery = undefined;` reset lived here, left by a refactor that removed the
    // query-recording mock. `lastQuery` was never declared, so this threw
    // `ReferenceError: lastQuery is not defined` in every beforeEach — BOTH tests in
    // this describe aborted before asserting anything.
  });

  it('blocks when 24h total + current exceeds maxTokensPer24h', async () => {
    const plugin = createPlugin({
      db: mockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            { field: 'tokens', maximum: 1_000_000 },
            {
              field: 'tokens',
              maximum: 200_000,
              window: 'PT24H',
              scope: 'agent',
              mode: 'block',
            },
          ],
        },
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

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 30_000 },
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
      message: expect.stringContaining('tokens'),
    });
  });

  it('passes when 24h total + current is under maxTokensPer24h', async () => {
    const lowMockDb = {
      prepare(sql: string) {
        return {
          get(..._params: unknown[]) {
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
            {
              field: 'tokens',
              maximum: 200_000,
              window: 'PT24H',
              scope: 'agent',
              mode: 'block',
            },
          ],
        },
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

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 30_000 },
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
        tool: {
          default: {},
          overrides: {
            big_output: {
              caps: [{ field: 'tokens', maximum: 50 }],
              mode: 'block',
            },
          },
        },
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

async function enforcePreModel(
  hooks: HookRegistry,
  ctx: ExecutionContext
): Promise<void> {
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
}

async function enforcePreTool(
  hooks: HookRegistry,
  ctx: ExecutionContext,
  toolName: string,
  callId: string
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

// ── Cache-token double-count (BUG-ORCH-010) ─────────────────────────────────
//
// Since the shipped BUG-ORCH-010 provider-neutral fix, `TokenUsage.inputTokens` is
// ALREADY the true total the model processed — `uncachedInputTokens + cacheReadTokens
// + cacheCreationTokens` are summed into it at the provider boundary
// (normaliseAnthropicUsage / normaliseOpenAIUsage; see
// packages/agent/agent-engine-orchestrator/src/providers/{anthropic,openai}.ts). A
// consumer that adds cacheReadTokens/cacheCreationTokens on top of inputTokens again
// double-counts the cached portion. These tests drive the REAL plugin/hook seam
// (createPlugin + HookRegistry, exactly how the orchestrator wires it) with a
// tokenUsage payload shaped the way the real providers actually emit it.
describe('cache-token double-count (BUG-ORCH-010)', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('does not double-count cache tokens in the tokens cap field (task scope, in-memory)', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxTotalTokens: 150, mode: 'block' }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    // Real (post-normalisation) shape: inputTokens ALREADY includes the cache-read
    // and cache-creation portions: 10 uncached + 80 cache-read + 10 cache-creation = 100.
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 80,
        cacheCreationTokens: 10,
      },
    });

    // Real total = inputTokens(100) + outputTokens(40) = 140, under the 150 cap -> must PASS.
    // A double-count would add cacheReadTokens+cacheCreationTokens (90) again, producing
    // 230 >= 150 -> a premature BUDGET_EXCEEDED that never should have fired.
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
  });

  it('control: the same cap DOES block once genuine (non-cache-inflated) usage reaches it', async () => {
    // Proves the fix isn't "never block" — a cap still fires on real usage growth.
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxTotalTokens: 150, mode: 'block' }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 80,
        cacheCreationTokens: 10,
      },
    });

    // Real total = 120 + 40 = 160 >= 150 -> must block.
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('tokens'),
    });
  });

  it('does not double-count cache tokens in the windowed tokens total (agent scope + maxTokensPer24h)', async () => {
    // A real (fake) DB standing in for better-sqlite3: returns a row already reflecting
    // correct provider-neutral totals for prior tasks, and records the exact SQL text so
    // the assertion can catch a regression that re-adds cache columns into the SUM.
    let windowSql = '';
    const mockDb = {
      prepare(sql: string) {
        return {
          get(..._params: unknown[]) {
            if (sql.includes('created_at')) {
              windowSql = sql;
              // Prior 24h usage: 100k input(already-total) + 20k output = 120k real tokens.
              return { total: 120_000 };
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
            {
              field: 'tokens',
              maximum: 130_000,
              window: 'PT24H',
              scope: 'agent',
            },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    // This call's own real usage: 5k total. 120k (window) + 5k (this call) = 125k < 130k -> PASS.
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 4_800,
        outputTokens: 200,
        cacheReadTokens: 4_000,
        cacheCreationTokens: 200,
      },
    });

    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
    // The regression this guards against: the SQL summing cache columns on top of
    // input_tokens/output_tokens again.
    expect(windowSql).not.toMatch(/cache_read_input_tokens|cache_creation_input_tokens/);
    expect(windowSql).toMatch(/input_tokens \+ output_tokens/);
  });
});

// ── Cache-weighted cost (BUG-AGENTMCP-008) ───────────────────────────────────
//
// BudgetAccumulator used to track only the aggregate `inputTokens` and bill cost at a
// single flat rate: cost = inputTokens × costPerInputToken. On cache-warm runs most
// input is cache-READ, which deepseek-v4-flash bills at $0.0028/M vs $0.14/M uncached —
// a 50x gap. The flat formula counted every cache-read token at full weight, tripping
// maxCostUSD at ~$0.126 for a run whose REAL cost was ~$0.0025. The fix: accumulate the
// per-class split the providers already emit (uncachedInputTokens / cacheReadTokens /
// cacheCreationTokens — normaliseAnthropicUsage / normaliseOpenAIUsage) and weight each
// class at its own rate (costPerCacheReadToken / costPerCacheWriteToken, defaulting to
// costPerInputToken so a config that never heard of cache rates behaves byte-for-byte as
// the old flat formula).
describe('cache-weighted cost (BUG-AGENTMCP-008)', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  // DeepSeek cache-warm shape: 1000 uncached + 900_000 cache-read + 0 cache-write.
  // inputTokens (901_000) is the provider-neutral class sum — real providers always
  // emit it alongside the split. Real cost = 1000×$0.14/M + 900_000×$0.0028/M = $0.00266,
  // under the $0.01 cap. The FLAT formula (the bug) bills 901_000×$0.14/M = $0.12614 >=
  // $0.01 and throws BUDGET_EXCEEDED — this test fails red on that code.
  it('does NOT trip the cost cap on 900K cache-read tokens weighted at the cache-read rate', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({
        maxCostUSD: 0.01,
        costPerInputToken: 0.00000014, // $0.14/M (deepseek-v4-flash uncached input)
        costPerCacheReadToken: 0.0000000028, // $0.0028/M (deepseek-v4-flash cache-read)
        costPerCacheWriteToken: 0.0000000028, // deepseek charges no cache write; use read rate
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 901_000,
        outputTokens: 0,
        uncachedInputTokens: 1_000,
        cacheReadTokens: 900_000,
        cacheCreationTokens: 0,
      },
    });

    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
  });

  it('control: the cost cap STILL trips once genuine (cache-weighted) spend reaches it', async () => {
    // Proves the fix is not "cost cap disabled" — it still trips, but at the cache rate.
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({
        maxCostUSD: 0.01,
        mode: 'block',
        costPerInputToken: 0.00000014,
        costPerCacheReadToken: 0.0000000028,
        costPerCacheWriteToken: 0.0000000028,
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    // 4_000_000 cache-read × $0.0028/M = $0.0112 (+ $0.00014 uncached) >= $0.01 → block.
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 4_001_000,
        outputTokens: 0,
        uncachedInputTokens: 1_000,
        cacheReadTokens: 4_000_000,
        cacheCreationTokens: 0,
      },
    });

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('cost'),
    });
  });

  it('backward compat: without costPerCacheReadToken the same usage behaves exactly as before (flat, trips)', async () => {
    // A config that never heard of cache rates must behave byte-for-byte as the old flat
    // formula: 901_000 × $0.14/M = $0.12614 >= $0.01 → BUDGET_EXCEEDED.
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({
        maxCostUSD: 0.01,
        mode: 'block',
        costPerInputToken: 0.00000014,
        costPerOutputToken: 0.00000028, // $0.28/M — mirrors deepseek-v4-flash output
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreModel(hooks, ctx);

    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 901_000,
        outputTokens: 0,
        uncachedInputTokens: 1_000,
        cacheReadTokens: 900_000,
        cacheCreationTokens: 0,
      },
    });

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('cost'),
    });
  });
});

// ── Packet A — cap.mode on the model path (budget:warning / budget:block) ────
//
// PLAN-run-control-v2 §3 Packet A + owner ruling 5 (2026-08-11): `enforcePreModel`
// must honor `cap.mode` — warning-mode caps emit `budget:warning` and continue,
// block-mode caps emit `budget:block` then throw `IEnforcementError`, and the
// DEFAULT for mode-less caps is `warning` (was: unconditional block). The events
// are pure notification: no handler registered = no-op; the orchestrator's
// existing `IEnforcementError` → `ToolError('BUDGET_EXCEEDED')` conversion stays
// the block action.
describe('Packet A — cap.mode on the model path (budget:warning / budget:block)', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('warning-mode calls cap exceeded → enforce resolves + handler called with BudgetWarningPayload', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1, mode: 'warning' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const warnings: BudgetWarningPayload[] = [];
    hooks.register('budget:warning', (p) => {
      warnings.push(p);
    });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    // Second model request — current (1) >= maximum (1) → warning, NOT a throw
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      field: 'calls',
      maximum: 1,
      current: 1,
      message: expect.stringContaining('calls'),
    });
    expect(warnings[0].executionContext.taskId).toBe('task-1');
  });

  it('block-mode calls cap exceeded → enforce rejects BUDGET_EXCEEDED + block handler called BEFORE the rejection', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const order: string[] = [];
    const blocks: BudgetBlockPayload[] = [];
    hooks.register('budget:block', (p) => {
      order.push('block-event');
      blocks.push(p);
    });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
    });
    // Emitted before the throw propagated — not after, not never.
    expect(order).toEqual(['block-event']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      field: 'calls',
      maximum: 1,
      current: 1,
    });
    expect(blocks[0].executionContext.taskId).toBe('task-1');
  });

  it('mode-less calls cap exceeded → warns (new default; was: rejection)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1 }] }, // no mode
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const warnings: BudgetWarningPayload[] = [];
    hooks.register('budget:warning', (p) => {
      warnings.push(p);
    });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);

    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ field: 'calls', maximum: 1, current: 1 });
  });

  it('run continues after a warning — later enforcements still resolve (execution proceeds)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1, mode: 'warning' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    let warningCount = 0;
    hooks.register('budget:warning', () => {
      warningCount += 1;
    });

    // Turn 1: under cap (current 0 < 1). Turn 2: warns (current 1 >= 1) and
    // resolves, so the run proceeds. Third request: warns again, still resolves.
    await runTaskTurns(hooks, ctx, [
      { inputTokens: 10, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 10 },
    ]);
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
    expect(warningCount).toBe(2);
  });

  it('no handler registered → warning mode still resolves, block mode still rejects (event emission is a no-op)', async () => {
    // Warning — no budget:warning handler
    const warnPlugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1, mode: 'warning' }] },
      }),
    });
    await warnPlugin.install(hooks);
    const warnCtx = makeCtx();
    await runTaskTurns(hooks, warnCtx, [{ inputTokens: 10, outputTokens: 10 }]);
    await expect(enforcePreModel(hooks, warnCtx)).resolves.toBeUndefined();

    // Block — no budget:block handler
    const blockHooks = new HookRegistry();
    const blockPlugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 1, mode: 'block' }] },
      }),
    });
    await blockPlugin.install(blockHooks);
    const blockCtx = makeCtx();
    await runTaskTurns(blockHooks, blockCtx, [
      { inputTokens: 10, outputTokens: 10 },
    ]);
    await expect(enforcePreModel(blockHooks, blockCtx)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('warning-mode cap NOT exceeded → no event emitted, resolves', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'calls', maximum: 3, mode: 'warning' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const warnings: BudgetWarningPayload[] = [];
    hooks.register('budget:warning', (p) => {
      warnings.push(p);
    });

    await runTaskTurns(hooks, ctx, [{ inputTokens: 10, outputTokens: 10 }]);
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    expect(warnings).toHaveLength(0);
  });

  it('tool path: warning-mode tool cap emits budget:warning (symmetry) and still soft-blocks via IToolWarning', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: {
          default: {},
          overrides: {
            expensive_search: {
              caps: [{ field: 'toolCalls', maximum: 1 }],
              mode: 'warning',
            },
          },
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const warnings: BudgetWarningPayload[] = [];
    hooks.register('budget:warning', (p) => {
      warnings.push(p);
    });

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreTool(hooks, ctx, 'expensive_search', 'call-1');

    let caught: unknown;
    try {
      await enforcePreTool(hooks, ctx, 'expensive_search', 'call-2');
    } catch (e) {
      caught = e;
    }
    // Enforcement semantics unchanged: still an IToolWarning (soft-block).
    expect(caught).toMatchObject({
      isToolWarning: true,
      toolName: 'expensive_search',
      callId: 'call-2',
    });
    // ...with the notification event for symmetry.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      field: 'toolCalls',
      maximum: 1,
      current: 1,
    });
  });
});
