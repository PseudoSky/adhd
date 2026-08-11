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

  it('passes when input tokens are under the limit', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxInputTokens: 1000 }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await runTaskTurns(hooks, ctx, [{ inputTokens: 200, outputTokens: 100 }]);

    // Second model request — 200 input tokens, limit 1000 → should pass
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

  it('throws when a flat volume cap (maxInputTokens) is reached', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxInputTokens: 100, mode: 'block' }),
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
      tokenUsage: makeTokenUsage(120, 60), // 120 input — exceeds 100
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
              field: 'inputTokens',
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
    // Flat maxModelCalls: 2 normalizes to a mode-less `calls` cap (maximum 2).
    // Under warning-by-default (Packet A ruling 5) an exceeded mode-less cap
    // WARNS — it never blocks. Two turns never exceed the cap at all, so
    // nothing throws here; the "3rd blocked" reading was stale on both counts.
    // Note: runTaskTurns is async and deliberately not awaited — the
    // not.toThrow() wrapper only guards synchronous throws; vitest's
    // unhandled-rejection detection is the real guard for async failures.
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

describe('maxTokensPer24h — mock DB (re-expressed as windowed inputTokens, Packet B ruling 3)', () => {
  let hooks: HookRegistry;
  const mockDb = {
    prepare(sql: string) {
      return {
        get(..._params: unknown[]) {
          if (sql.includes('created_at')) {
            return { total: 180_000 };
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

  it('blocks when 24h total + current exceeds the windowed inputTokens cap', async () => {
    const plugin = createPlugin({
      db: mockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            { field: 'inputTokens', maximum: 1_000_000 },
            {
              field: 'inputTokens',
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
      message: expect.stringContaining('inputTokens'),
    });
  });

  it('passes when 24h total + current is under the windowed inputTokens cap', async () => {
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
            { field: 'inputTokens', maximum: 1_000_000 },
            {
              field: 'inputTokens',
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

describe('tool inputTokens override', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('blocks tool call when tool inputTokens cap is exceeded', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'inputTokens', maximum: 1_000_000 }] },
        tool: {
          default: {},
          overrides: {
            big_output: {
              caps: [{ field: 'inputTokens', maximum: 50 }],
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
      tokenUsage: { inputTokens: 60, outputTokens: 0 },
    });

    // Calling big_output → 60 input >= 50 limit
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

/**
 * Packet C helper: emit post:tool_call for an EXECUTED tool call, the seam the
 * engine fires ONLY for tools that actually ran (orchestrator.ts Phase 2 map).
 * `isError: true` simulates client.callTool throwing — the only signal the
 * error budget counts (thrown-errors-only per owner lean, plan §3).
 */
async function emitPostToolCall(
  hooks: HookRegistry,
  ctx: ExecutionContext,
  toolName: string,
  callId: string,
  isError: boolean
): Promise<void> {
  await hooks.emit('post:tool_call', {
    executionContext: ctx,
    toolName,
    callId,
    toolInput: {},
    result: isError ? { error: 'tool boom' } : { ok: true },
    isError,
    estResultTokens: 0,
  });
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

  it('does not double-count cache tokens in the inputTokens cap field (task scope, in-memory)', async () => {
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxInputTokens: 150, mode: 'block' }),
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

    // Real input = 100, under the 150 cap -> must PASS.
    // A double-count would add cacheReadTokens+cacheCreationTokens (90) again, producing
    // 190 >= 150 -> a premature BUDGET_EXCEEDED that never should have fired.
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
  });

  it('control: the same cap DOES block once genuine (non-cache-inflated) usage reaches it', async () => {
    // Proves the fix isn't "never block" — a cap still fires on real usage growth.
    const plugin = createPlugin({
      db: null,
      config: configSchema.parse({ maxInputTokens: 150, mode: 'block' }),
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
        inputTokens: 160,
        outputTokens: 40,
        cacheReadTokens: 80,
        cacheCreationTokens: 0,
      },
    });

    // Real input = 160 >= 150 -> must block.
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('inputTokens'),
    });
  });

  it('does not double-count cache tokens in the windowed inputTokens total (agent scope)', async () => {
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
              field: 'inputTokens',
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

    // This call's own real input: 4.8k. 120k (window) + 4.8k (this call) = 124.8k < 130k -> PASS.
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

  it('tool path: block-mode tool cap exceeded → budget:block emitted BEFORE the BUDGET_EXCEEDED throw', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {},
        tool: {
          default: {},
          overrides: {
            blocked_tool: {
              caps: [{ field: 'toolCalls', maximum: 1 }],
              mode: 'block',
            },
          },
        },
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

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });
    await enforcePreTool(hooks, ctx, 'blocked_tool', 'call-1'); // under cap → passes

    await expect(
      enforcePreTool(hooks, ctx, 'blocked_tool', 'call-2') // 1 >= 1 → block
    ).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
    });
    // Emitted before the throw propagated — not after, not never.
    expect(order).toEqual(['block-event']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      field: 'toolCalls',
      maximum: 1,
      current: 1,
      message: expect.stringContaining('blocked_tool'),
    });
  });
});

// ── Packet B — tokens → context (BUG-AGENTMCP-009) ───────────────────────────
//
// PLAN-run-control-v2 §3 Packet B + owner rulings 1/2/4/6 (2026-08-11): the
// 'tokens' cap field (CUMULATIVE input+output, misread as context size) is
// REMOVED with no alias; 'context' is the PEAK single-request input, enforced
// on the model path only, with the enforcement value = max(provider-reported
// peak, tools-aware estimate of the pending request) (ruling 4 — catch early,
// reject one-request-lag). 'inputTokens'/'outputTokens' are CUMULATIVE volume
// fields carrying the windowed resource-burn caps (ruling 3); flat
// 'maxTokensPer24h' is retained and re-expressed as a windowed inputTokens cap.
// 'contextWindowFraction` resolves against the base-types context-window
// registry (contextWindowFor; 128K fallback).
//
// Regression discipline (BL-225): the cache-warm test below is the BUG-AGENTMCP-009
// regression — on the pre-Packet-B code the `context` field fails capSchema
// validation (createPlugin throws), so the test fails red before the fix and
// goes green after.
describe('Packet B — tokens → context (BUG-AGENTMCP-009)', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('REGRESSION BUG-AGENTMCP-009: cache-warm run — 100 turns of 8K input (850K cumulative volume) with context: 50_000 → every enforce resolves', async () => {
    // The 2026-08-11 production failure: a deepseek implementer killed at ~turn 6
    // by `tokens: 500000` — cumulative input+output hit 604_800 at $0.03 real spend
    // because a cache-warm run re-reads the whole conversation every turn. Under the
    // new 'context' semantics (PEAK, not cumulative) the cumulative volume is
    // irrelevant: peak stays ~8.5K while 850K cumulative volume passes through.
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'context', maximum: 50_000, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    let enforced = 0;
    for (let turn = 0; turn < 100; turn++) {
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
      enforced += 1;
      // 8K input + 500 output per turn → 850K cumulative across 100 turns.
      await hooks.emit('post:model_response', {
        executionContext: ctx,
        stopReason: 'stop',
        toolCallCount: 0,
        tokenUsage: { inputTokens: 8_000, outputTokens: 500 },
      });
    }

    // Every one of the 100 enforcements resolved — cumulative volume never feeds
    // the peak-based cap. (The OLD 'tokens' cap at 500K would have killed at
    // ~turn 62; at 50K it would have killed at ~turn 6 — matching the incident.)
    expect(enforced).toBe(100);
  });

  it('a single 60K-peak turn with context: 50_000 → the NEXT enforce rejects (peak, one-request-lag rejected)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'context', maximum: 50_000, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Turn 1: 60K input — peak exceeds the 50K cap, but the cap is checked on the
    // NEXT model request (enforcement runs pre-flight; the exceeded peak becomes
    // visible after the response lands).
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
      tokenUsage: { inputTokens: 60_000, outputTokens: 0 },
    });

    // Turn 2 pre-flight: max(peak 60K, estimate 0) = 60K >= 50K → BUDGET_EXCEEDED.
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('context'),
    });
  });

  it('contextWindowFraction: 0.5 on a 128K-window model (gpt-4o-mini) trips at 70K, not 60K (limit 64K)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {
          caps: [
            { field: 'context', contextWindowFraction: 0.5, mode: 'block' },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    // makeCtx defaults to provider openai/gpt-4o-mini → contextWindowFor = 128K;
    // fraction 0.5 → limit 64K.
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // 60K turn → peak 60K < 64K → passes (this is the "not 60K" half).
    await enforcePreModel(hooks, ctx);
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 60_000, outputTokens: 0 },
    });
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    // 70K turn → peak 70K >= 64K → blocks ("trips at 70K").
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 70_000, outputTokens: 0 },
    });
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('pre-flight: an oversized PENDING request trips the context cap before any response (owner ruling 4)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'context', maximum: 10_000, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Provider-reported peak is still 0 — but the pending request is ~25K tokens
    // (100K chars / 4). The estimate must catch it pre-flight.
    const payload = {
      executionContext: ctx,
      messages: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          sessionId: 'session-1',
          role: 'user' as const,
          content: 'x'.repeat(100_000),
          createdAt: '2026-08-11T00:00:00.000Z',
        },
      ],
      tools: [],
    };
    await hooks.emit('pre:model_request', payload);
    await expect(hooks.enforce('pre:model_request', payload)).rejects.toMatchObject(
      {
        isEnforcementError: true,
        code: 'BUDGET_EXCEEDED',
      }
    );
  });

  it('pre-flight: the tools array counts toward the pending-request estimate (BUG-ORCH-006 undercount fix)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'context', maximum: 10_000, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Tiny messages, but one tool whose schema is ~80K chars (~20K tokens). The
    // engine's OLD local estimator ignored the tools array entirely (BUG-ORCH-006)
    // and would have let this request through; the tools-aware estimator must not.
    const payload = {
      executionContext: ctx,
      messages: [],
      tools: [
        {
          name: 'huge_tool',
          description: 'x'.repeat(40_000),
          inputSchema: {
            type: 'object',
            properties: { data: { type: 'string', description: 'x'.repeat(40_000) } },
          },
        },
      ],
    };
    await hooks.emit('pre:model_request', payload);
    await expect(hooks.enforce('pre:model_request', payload)).rejects.toMatchObject(
      {
        isEnforcementError: true,
        code: 'BUDGET_EXCEEDED',
      }
    );
  });

  it('structured caps[].field === "tokens" → factory throws with a context-mentioning migration message', async () => {
    expect(() =>
      createPlugin({
        db: null,
        config: {
          defaults: { caps: [{ field: 'tokens', maximum: 500_000, mode: 'block' }] },
        },
      })
    ).toThrow(/context/);
  });

  it('flat maxTotalTokens → factory throws with a context-mentioning migration message', async () => {
    expect(() =>
      createPlugin({
        db: null,
        config: { maxTotalTokens: 500_000, mode: 'block' },
      })
    ).toThrow(/context/);
  });

  it('context + window → schema validation error (windowed peak is meaningless)', async () => {
    const result = pluginConfigSchema.safeParse({
      defaults: {
        caps: [{ field: 'context', maximum: 100_000, window: 'PT24H' }],
      },
    });
    expect(result.success).toBe(false);
    // And the factory path (what the loader hits) throws too.
    expect(() =>
      createPlugin({
        db: null,
        config: {
          defaults: { caps: [{ field: 'context', maximum: 100_000, window: 'PT24H' }] },
        },
      })
    ).toThrow();
  });

  it('context with NEITHER maximum nor contextWindowFraction → schema validation error', async () => {
    const result = pluginConfigSchema.safeParse({
      defaults: { caps: [{ field: 'context' }] },
    });
    expect(result.success).toBe(false);
  });

  it('contextWindowFraction on a NON-context field → schema validation error', async () => {
    const result = pluginConfigSchema.safeParse({
      defaults: { caps: [{ field: 'calls', contextWindowFraction: 0.5 }] },
    });
    expect(result.success).toBe(false);
  });

  it('flat maxTokensPer24h is still accepted, re-expressed as a windowed inputTokens cap, and ENFORCES across turns', async () => {
    // Ruling 3: maxTokensPer24h is NOT dropped — the flat alias re-maps to
    // {field:'inputTokens', window:'PT24H'} + the flat `scope:'agent'`. Historical
    // 24h window: 150K from the mock DB; this call's in-memory input adds on top.
    const mockDb = {
      prepare(sql: string) {
        return {
          get(..._params: unknown[]) {
            if (sql.includes('created_at')) return { total: 150_000 };
            return undefined;
          },
        };
      },
    };
    const plugin = createPlugin({
      db: mockDb,
      config: { maxTokensPer24h: 180_000, scope: 'agent', mode: 'block' },
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Turn 1 pre-flight: 0 in-memory + 150K window = 150K < 180K → passes.
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 0 },
    });

    // Turn 2 pre-flight: 30K in-memory + 150K window = 180K >= 180K → blocks.
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('inputTokens'),
    });
  });

  it('windowed inputTokens/outputTokens caps enforce across turns (resource-burn axis)', async () => {
    const mockDb = {
      prepare(sql: string) {
        return {
          get(..._params: unknown[]) {
            if (sql.includes('created_at')) return { total: 0 };
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
              field: 'inputTokens',
              maximum: 50_000,
              window: 'PT24H',
              scope: 'agent',
              mode: 'block',
            },
            {
              field: 'outputTokens',
              maximum: 30_000,
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

    // Turn 1: 30K in + 10K out → under both caps.
    await enforcePreModel(hooks, ctx);
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 10_000 },
    });
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    // Turn 2: cumulative input 60K >= 50K → blocks on inputTokens.
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 20_000 },
    });
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      message: expect.stringContaining('inputTokens'),
    });

    // Fresh task: only output grows — outputTokens windowed cap blocks.
    const hooks2 = new HookRegistry();
    const outOnly = createPlugin({
      db: mockDb,
      config: pluginConfigSchema.parse({
        defaults: {
          scope: 'agent',
          caps: [
            {
              field: 'outputTokens',
              maximum: 30_000,
              window: 'PT24H',
              scope: 'agent',
              mode: 'block',
            },
          ],
        },
      }),
    });
    await outOnly.install(hooks2);
    const ctx2 = makeCtx({ taskId: 'task-2' });
    await hooks2.emit('task:start', { executionContext: ctx2, messages: [] });
    await enforcePreModel(hooks2, ctx2);
    await hooks2.emit('post:model_response', {
      executionContext: ctx2,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 25_000 },
    });
    await hooks2.emit('post:model_response', {
      executionContext: ctx2,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 10_000 },
    });
    await expect(enforcePreModel(hooks2, ctx2)).rejects.toMatchObject({
      isEnforcementError: true,
      message: expect.stringContaining('outputTokens'),
    });
  });

  it('scoped context reads MAX(peak_context_tokens) from task_usage (session/agent/global)', async () => {
    // Mock DB stands in for seeded task_usage rows: the agent-scope query reports
    // the historical peak across prior tasks. The mock is stateful so the test can
    // watch the scoped value cross the cap.
    let dbPeak = 45_000;
    const mockDb = {
      prepare(sql: string) {
        return {
          get(..._params: unknown[]) {
            if (
              sql.includes('MAX(tu.peak_context_tokens)') ||
              sql.includes('MAX(peak_context_tokens)')
            ) {
              return { input: 0, output: 0, calls: 0, peak: dbPeak };
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
              field: 'context',
              maximum: 50_000,
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

    // DB peak 45K + current in-memory peak 0 → 45K < 50K → passes.
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    // Current task peaks at 30K → scoped = max(45K, 30K) = 45K < 50K → still passes.
    await hooks.emit('post:model_response', {
      executionContext: ctx,
      stopReason: 'stop',
      toolCallCount: 0,
      tokenUsage: { inputTokens: 30_000, outputTokens: 0 },
    });
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    // A prior task in the scope peaked at 55K → scoped = 55K >= 50K → blocks.
    dbPeak = 55_000;
    await expect(enforcePreModel(hooks, ctx)).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('context'),
    });
  });
});

// ── Packet C — errors + consecutiveErrors caps (plan §3) ─────────────────────
//
// Task-level ERROR BUDGET: counted at post:tool_call from the engine's isError
// flag (thrown-errors-only — the only signal distinguishable at that seam),
// enforced on the TOOL path only. `errors` is cumulative; `consecutiveErrors`
// resets to 0 on any successful tool call. Windowed/non-task-scoped error caps
// are schema errors (not expressible this wave). Warning-by-default is free on
// the tool path (`cap.mode ?? dimMode ?? 'warning'`, owner ruling 5).
//
// Regression discipline (BL-225): on the pre-Packet-C code the 'errors' /
// 'consecutiveErrors' fields fail capSchema validation (createPlugin throws),
// so every enforcement test below fails red before the fix and goes green after.
describe('Packet C — errors + consecutiveErrors caps', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  it('3 failures with errors: 2 mode block → the 3rd enforce rejects (BUDGET_EXCEEDED)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'errors', maximum: 2, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Fail 1: pre sees 0 < 2 → passes, executes, errors=1.
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-1');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-1', true);
    // Fail 2: pre sees 1 < 2 → passes, executes, errors=2.
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-2');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-2', true);
    // Fail 3: pre sees 2 >= 2 → BUDGET_EXCEEDED, never executes.
    await expect(
      enforcePreTool(hooks, ctx, 'shell__run', 'call-3')
    ).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('errors'),
    });
  });

  it('consecutive reset: fail, fail, success, fail with consecutiveErrors: 3 mode block → never blocks', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {
          caps: [{ field: 'consecutiveErrors', maximum: 3, mode: 'block' }],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Fail 1: streak 0→1. Fail 2: streak 1→2. Success: pre sees 2 < 3 passes,
    // then the success RESETS the streak to 0. Fail 3: pre sees 0 < 3 passes.
    // The reset is what keeps every enforce below the cap.
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-1');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-1', true);
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-2');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-2', true);
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-3');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-3', false); // success resets
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-4');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-4', true);

    // A 5th call is still under the cap — the streak never survived the success.
    await expect(
      enforcePreTool(hooks, ctx, 'shell__run', 'call-5')
    ).resolves.toBeUndefined();
  });

  it('fail, fail, fail with consecutiveErrors: 3 → streak reaches 3, the NEXT enforce rejects', async () => {
    // Semantics note: enforcement uses `current >= maximum` at pre:tool_call
    // with the streak counted AFTER each executed error — the exact threshold
    // the `errors` cap relies on (3rd of 3 rejects at maximum 2). So at
    // maximum 3 the third fail itself executes (streak 2 < 3) and the call
    // after it rejects (3 >= 3).
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {
          caps: [{ field: 'consecutiveErrors', maximum: 3, mode: 'block' }],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await enforcePreTool(hooks, ctx, 'shell__run', 'call-1');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-1', true); // streak 1
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-2');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-2', true); // streak 2
    // Third fail: 2 < 3 → executes, streak reaches 3.
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-3');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-3', true); // streak 3

    // The next enforce sees 3 >= 3 → BUDGET_EXCEEDED.
    await expect(
      enforcePreTool(hooks, ctx, 'shell__run', 'call-4')
    ).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('consecutiveErrors'),
    });
  });

  it('errors: 2 mode-less → warns (IToolWarning soft-block), does not block (ruling 5 default)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'errors', maximum: 2 }] }, // no mode
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    await enforcePreTool(hooks, ctx, 'shell__run', 'call-1');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-1', true);
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-2');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-2', true);

    // 3rd call: 2 >= 2, mode-less → warning (IToolWarning), NOT an
    // IEnforcementError — the run continues with a soft-blocked call.
    let caught: unknown;
    try {
      await enforcePreTool(hooks, ctx, 'shell__run', 'call-3');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ isToolWarning: true, callId: 'call-3' });
    expect(caught).not.toMatchObject({ isEnforcementError: true });
  });

  it('all-success run never trips either cap', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: {
          caps: [
            { field: 'errors', maximum: 2, mode: 'block' },
            { field: 'consecutiveErrors', maximum: 3, mode: 'block' },
          ],
        },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    for (let i = 1; i <= 5; i++) {
      await enforcePreTool(hooks, ctx, 'shell__run', `call-${i}`);
      await emitPostToolCall(hooks, ctx, 'shell__run', `call-${i}`, false);
    }
    // Still alive after 5 successful calls.
    await expect(
      enforcePreTool(hooks, ctx, 'shell__run', 'call-6')
    ).resolves.toBeUndefined();
  });

  it('both caps reject window (schema error) — and the rejection is about window, not the field', async () => {
    for (const field of ['errors', 'consecutiveErrors'] as const) {
      const result = pluginConfigSchema.safeParse({
        defaults: { caps: [{ field, maximum: 5, window: 'PT24H' }] },
      });
      expect(result.success).toBe(false);
      // The failure must be the window rejection (post-fix), not the enum
      // rejection (pre-fix the field doesn't exist at all) — asserting the
      // issue path makes this test discriminate red vs green.
      expect(
        result.success === false &&
          result.error.issues.some(
            (i) => i.path.join('.') === 'defaults.caps.0.window'
          )
      ).toBe(true);
      // The factory path (what the loader hits) throws too.
      expect(() =>
        createPlugin({
          db: null,
          config: { defaults: { caps: [{ field, maximum: 5, window: 'PT24H' }] } },
        })
      ).toThrow();
    }
  });

  it('errors caps are enforced on the tool path only — a model-path-only task never increments errors', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'errors', maximum: 0, mode: 'block' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Model path: an errors cap with maximum 0 would reject at the very first
    // enforce IF errors were enforced there. It resolves — the cap is excluded
    // from the model path (TOOL_PATH_ONLY_FIELDS), and a model-only task has
    // executed zero tools, so the counter is 0.
    await expect(enforcePreModel(hooks, ctx)).resolves.toBeUndefined();

    // Control: the same cap IS live on the tool path — the first tool call
    // (current 0 >= maximum 0) is blocked. Proves the cap wasn't just inert.
    await expect(
      enforcePreTool(hooks, ctx, 'shell__run', 'call-1')
    ).rejects.toMatchObject({
      isEnforcementError: true,
      code: 'BUDGET_EXCEEDED',
      message: expect.stringContaining('errors'),
    });
  });

  it('NON-SELF-AMPLIFYING: a warning-mode errors cap never feeds its own counter (plan §3 verified paragraph)', async () => {
    const plugin = createPlugin({
      db: null,
      config: pluginConfigSchema.parse({
        defaults: { caps: [{ field: 'errors', maximum: 2, mode: 'warning' }] },
      }),
    });
    await plugin.install(hooks);
    const ctx = makeCtx();
    const warnings: BudgetWarningPayload[] = [];
    hooks.register('budget:warning', (p) => {
      warnings.push(p);
    });

    await hooks.emit('task:start', { executionContext: ctx, messages: [] });

    // Two REAL errors execute and are counted: errors = 2.
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-1');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-1', true);
    await enforcePreTool(hooks, ctx, 'shell__run', 'call-2');
    await emitPostToolCall(hooks, ctx, 'shell__run', 'call-2', true);

    // The cap now trips (2 >= 2). Each tripped call fires IToolWarning at
    // pre:tool_call; the orchestrator injects a warningResult and SKIPS the
    // call (orchestrator.ts:619-626, Phase-2 filter 645-647) — it never
    // reaches post:tool_call, so the counter cannot grow from its own
    // warnings. The test models that skip: no emitPostToolCall in this loop.
    for (let cycle = 1; cycle <= 5; cycle++) {
      let caught: unknown;
      try {
        await enforcePreTool(hooks, ctx, 'shell__run', `call-w${cycle}`);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ isToolWarning: true });
    }

    // Every warning reports current === 2. Had the counter fed itself, cycle 2
    // onwards would report 3, 4, ... — the proof of non-amplification.
    expect(warnings).toHaveLength(5);
    for (const w of warnings) {
      expect(w).toMatchObject({ field: 'errors', maximum: 2, current: 2 });
    }
  });

  it('tool-scoped context cap → schema error (Packet B review finding, plan §8.9)', async () => {
    // A `{field:'context'}` cap in the tool block is a silent no-op: the tool
    // path filters 'context' out and the model path can't see tool overrides.
    // Rejected at the schema level — in tool.default AND tool.overrides.
    const inDefault = pluginConfigSchema.safeParse({
      defaults: {},
      tool: { default: { caps: [{ field: 'context', maximum: 1000 }] } },
    });
    expect(inDefault.success).toBe(false);

    const inOverride = pluginConfigSchema.safeParse({
      defaults: {},
      tool: { overrides: { some_tool: { caps: [{ field: 'context', maximum: 1000 }] } } },
    });
    expect(inOverride.success).toBe(false);

    // The factory path (what the loader hits) throws too.
    expect(() =>
      createPlugin({
        db: null,
        config: {
          tool: { default: { caps: [{ field: 'context', maximum: 1000 }] } },
        },
      })
    ).toThrow();
  });

  it('context with BOTH maximum and contextWindowFraction set → schema error (Packet B finding 3 negative test)', async () => {
    // The Packet B superRefine handles the both-set (illegal) case via
    // `hasMaximum === hasFraction`; this negative test pins that branch.
    const result = pluginConfigSchema.safeParse({
      defaults: {
        caps: [{ field: 'context', maximum: 1000, contextWindowFraction: 0.5 }],
      },
    });
    expect(result.success).toBe(false);
    expect(
      result.success === false &&
        result.error.issues.some(
          (i) => i.path.join('.') === 'defaults.caps.0.contextWindowFraction'
        )
    ).toBe(true);
  });
});
