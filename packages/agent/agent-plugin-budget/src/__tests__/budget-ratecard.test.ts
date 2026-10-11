/**
 * cf7e0e5c-1b2b-4ee1-a3e2-dcc4a65043dd (plan ce473fa3, bucket B1) -- the budget
 * `cost` cap prices a turn on the shared model-keyed rate card
 * (`estimateCost`, the table `usage_query` reports from) instead of one flat
 * Sonnet rate, and honours per-agent / per-provider rate overrides.
 *
 * Drives the REAL `BudgetPlugin` (via `createPlugin`) on a REAL `HookRegistry`;
 * only the persisted-rows DB for the scoped test is an in-memory sqlite, and no
 * LLM exists -- each turn is the `post:model_response` payload a provider emits.
 *
 * Reads the plugin's accumulated cost the way a consumer observes it: a block
 * mode `cost` cap with `maximum: 0` reports the real running cost as `current`
 * in the `budget:block` event on the next `pre:model_request`.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookRegistry } from '@adhd/agent-base-types';
import type {
  ExecutionContext,
  ModelUsageEntry,
  ProviderType,
  TokenUsage,
} from '@adhd/agent-base-types';
import { estimateCost } from '@adhd/agent-core-provider';
import { createPlugin, pluginConfigSchema } from '../index.js';

const TICKET = 'cf7e0e5c-1b2b-4ee1-a3e2-dcc4a65043dd';

// ── Harness ──────────────────────────────────────────────────────────────────

function makeCtx(
  over: {
    taskId?: string;
    agentName?: string;
    inlineProvider?: { type: ProviderType; model: string };
    selection?: { providerType: ProviderType; modelRef: string };
    wireModel?: string;
  } = {}
): ExecutionContext {
  const agentName = over.agentName ?? 'agent-a';
  return {
    taskId: over.taskId ?? 'task-1',
    sessionId: 'sess-1',
    agentName,
    agentDefinition: {
      name: agentName,
      version: 1,
      ...(over.inlineProvider ? { provider: over.inlineProvider } : {}),
      systemPrompt: '',
      mcpServers: {},
      permissions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...(over.selection ? { selection: over.selection } : {}),
    ...(over.wireModel ? { wireModel: over.wireModel } : {}),
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

interface Turn {
  uncached: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
  responseModel?: string;
  breakdown?: ModelUsageEntry[];
}

function usageOf(t: Turn): TokenUsage {
  const read = t.cacheRead ?? 0;
  const write = t.cacheWrite ?? 0;
  return {
    inputTokens: t.uncached + read + write,
    outputTokens: t.output,
    uncachedInputTokens: t.uncached,
    cacheReadTokens: read,
    cacheCreationTokens: write,
    ...(t.breakdown ? { modelBreakdown: t.breakdown } : {}),
  } as TokenUsage;
}

/** A started task whose accumulated cost can be read back through enforcement. */
async function startTask(config: unknown, ctx: ExecutionContext, db: unknown = null) {
  const hooks = new HookRegistry();
  const plugin = await createPlugin({
    db: db as never,
    config: pluginConfigSchema.parse(config) as never,
  });
  await plugin.install(hooks);
  let blocked: number | undefined;
  const unpriced: Array<Record<string, unknown>> = [];
  hooks.register('budget:block', (p) => {
    blocked = p.current;
  });
  hooks.register('budget:unpriced_model' as never, ((p: Record<string, unknown>) => {
    unpriced.push(p);
  }) as never);
  await hooks.emit('task:start', { executionContext: ctx, messages: [] });
  return {
    hooks,
    unpriced,
    async turn(t: Turn): Promise<void> {
      await hooks.emit('post:model_response', {
        executionContext: ctx,
        stopReason: 'stop',
        toolCallCount: 0,
        tokenUsage: usageOf(t),
        ...(t.responseModel ? { responseModel: t.responseModel } : {}),
        computeMs: 1,
      });
    },
    /** The running USD cost, via the `budget:block` event `current`. */
    async cost(): Promise<number> {
      blocked = undefined;
      const payload = { executionContext: ctx, messages: [], tools: [] };
      await hooks.emit('pre:model_request', payload);
      try {
        await hooks.enforce('pre:model_request', payload);
      } catch {
        /* the block is how the running cost is observed */
      }
      return blocked ?? 0;
    },
    /** Did a `cost` cap of `maximum` reject the next model request? */
    async tripped(): Promise<boolean> {
      const payload = { executionContext: ctx, messages: [], tools: [] };
      await hooks.emit('pre:model_request', payload);
      try {
        await hooks.enforce('pre:model_request', payload);
        return false;
      } catch {
        return true;
      }
    },
  };
}

const COST_PROBE = { field: 'cost', maximum: 0 } as const;
const blockWith = (extra: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({
  ...root,
  defaults: { mode: 'block', caps: [COST_PROBE], ...extra },
});

const DEEPSEEK = 'deepseek-v4-flash';
const SONNET = 'claude-sonnet-4-6';
const HAIKU_55 = 'claude-haiku-5-5';

function cardCost(model: string, t: Turn, strict = false): number {
  const est = estimateCost(
    model,
    {
      uncachedInputTokens: t.uncached,
      cacheReadTokens: t.cacheRead ?? 0,
      cacheCreationTokens: t.cacheWrite ?? 0,
      outputTokens: t.output,
    },
    { strict }
  );
  expect(est.costUsd).not.toBeNull();
  return est.costUsd as number;
}

// ── AC1 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC1 -- the budget plugin prices through the shared rate card`, () => {
  it('declares @adhd/agent-core-provider as a direct dependency and imports estimateCost from it', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['@adhd/agent-core-provider']).toBeDefined();
    const src = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8'
    );
    expect(src).toMatch(/import \{ estimateCost \} from '@adhd\/agent-core-provider'/);
  });
});

// ── AC2 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC2 -- accumulated cost equals estimateCost per turn (== usage_query est_cost)`, () => {
  const deepseekTurns: Turn[] = [
    { uncached: 1_000, cacheRead: 99_000, output: 500 },
    { uncached: 700, cacheRead: 120_000, output: 900 },
    { uncached: 50, cacheRead: 150_000, output: 120 },
  ];

  it('deepseek-v4-flash (cache-read heavy, openai adapter): budget cost == sum of estimateCost to 1e-9', async () => {
    const ctx = makeCtx({
      selection: { providerType: 'openai', modelRef: DEEPSEEK },
      wireModel: DEEPSEEK,
    });
    const task = await startTask(blockWith(), ctx);
    let expected = 0;
    for (const t of deepseekTurns) {
      await task.turn(t);
      expected += cardCost(DEEPSEEK, t);
      expect(Math.abs((await task.cost()) - expected)).toBeLessThan(1e-9);
    }
    expect(expected).toBeGreaterThan(0);
  });

  it('anthropic Sonnet (cache write + read): budget cost == sum of estimateCost to 1e-9', async () => {
    const ctx = makeCtx({
      selection: { providerType: 'anthropic', modelRef: SONNET },
      wireModel: SONNET,
    });
    const turns: Turn[] = [
      { uncached: 2_000, cacheWrite: 30_000, output: 800 },
      { uncached: 300, cacheRead: 32_000, output: 1_200 },
    ];
    const task = await startTask(blockWith(), ctx);
    let expected = 0;
    for (const t of turns) {
      await task.turn(t);
      expected += cardCost(SONNET, t);
    }
    expect(Math.abs((await task.cost()) - expected)).toBeLessThan(1e-9);
  });

  it('claudecli haiku-5-5 (per-model breakdown, strict concrete id): budget cost == estimateCost to 1e-9', async () => {
    const ctx = makeCtx({
      selection: { providerType: 'claudecli', modelRef: 'haiku' },
    });
    const t: Turn = {
      uncached: 400,
      cacheRead: 90_000,
      cacheWrite: 6_000,
      output: 700,
      responseModel: HAIKU_55,
      breakdown: [
        {
          model: HAIKU_55,
          uncachedInputTokens: 400,
          cacheReadTokens: 90_000,
          cacheCreationTokens: 6_000,
          cacheCreation1hTokens: 0,
          outputTokens: 700,
        },
      ],
    };
    const task = await startTask(blockWith(), ctx);
    await task.turn(t);
    const expected = cardCost(HAIKU_55, t, true);
    expect(Math.abs((await task.cost()) - expected)).toBeLessThan(1e-9);
    // Priced at the 5.5 rate card, not haiku-4.5's ~10x rate.
    expect(expected).toBeLessThan(0.02);
  });
});

// ── AC3 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC3 -- a $-cap on a cache-warm non-Sonnet run trips at the rate-card point`, () => {
  const warmTurn: Turn = { uncached: 1_000, cacheRead: 99_000, output: 500 };
  const perTurn = cardCost(DEEPSEEK, warmTurn);

  async function turnsUntilTripped(config: unknown, max = 60): Promise<number> {
    const ctx = makeCtx({
      selection: { providerType: 'openai', modelRef: DEEPSEEK },
      wireModel: DEEPSEEK,
    });
    const task = await startTask(config, ctx);
    for (let n = 0; n < max; n += 1) {
      if (await task.tripped()) return n;
      await task.turn(warmTurn);
    }
    return max;
  }

  it('rate-card: $0.01 cap lets ~17 DeepSeek turns through; the old flat Sonnet rates tripped after 1', async () => {
    const cap = { field: 'cost', maximum: 0.01 };
    const rateCardTurns = await turnsUntilTripped({
      pricing: 'rate-card',
      defaults: { mode: 'block', caps: [cap] },
    });
    const flatSonnetTurns = await turnsUntilTripped({
      defaults: {
        mode: 'block',
        caps: [cap],
        costPerInputToken: 0.000003,
        costPerOutputToken: 0.000015,
      },
    });
    // 100k input tokens/turn at the flat $3/M = $0.30 > $0.01 on turn 1.
    expect(flatSonnetTurns).toBe(1);
    // Rate-card point: first n with n * perTurn > 0.01.
    expect(rateCardTurns).toBe(Math.floor(0.01 / perTurn) + 1);
    expect(rateCardTurns).toBeGreaterThan(10);
  });

  it('a Sonnet run with no cache trips at the same point as the flat $3/$15 rates', async () => {
    const turn: Turn = { uncached: 10_000, output: 1_000 };
    const cap = { field: 'cost', maximum: 0.1 };
    async function until(config: unknown): Promise<number> {
      const ctx = makeCtx({
        selection: { providerType: 'anthropic', modelRef: SONNET },
        wireModel: SONNET,
      });
      const task = await startTask(config, ctx);
      for (let n = 0; n < 20; n += 1) {
        if (await task.tripped()) return n;
        await task.turn(turn);
      }
      return 20;
    }
    const card = await until({ pricing: 'rate-card', defaults: { mode: 'block', caps: [cap] } });
    const flat = await until({
      defaults: {
        mode: 'block',
        caps: [cap],
        costPerInputToken: 0.000003,
        costPerOutputToken: 0.000015,
      },
    });
    expect(card).toBe(flat);
    expect(card).toBe(3);
  });
});

// ── AC4 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC4 -- back-compat and the pricing modes`, () => {
  const turn: Turn = { uncached: 5_000, cacheRead: 20_000, cacheWrite: 1_000, output: 2_000 };
  const flatRates = {
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000015,
    costPerCacheReadToken: 0.0000003,
    costPerCacheWriteToken: 0.00000375,
  };
  const ctx = () =>
    makeCtx({ selection: { providerType: 'openai', modelRef: DEEPSEEK }, wireModel: DEEPSEEK });

  it('explicit defaults.costPer* with no `pricing` bill byte-identically to the pre-change per-class formula', async () => {
    const task = await startTask(blockWith(flatRates), ctx());
    await task.turn(turn);
    await task.turn(turn);
    const expected =
      2 * 5_000 * flatRates.costPerInputToken +
      2 * 20_000 * flatRates.costPerCacheReadToken +
      2 * 1_000 * flatRates.costPerCacheWriteToken +
      2 * 2_000 * flatRates.costPerOutputToken;
    // Same multiplication order as the pre-change formula: exact, not approx.
    const legacy =
      10_000 * flatRates.costPerInputToken +
      40_000 * flatRates.costPerCacheReadToken +
      2_000 * flatRates.costPerCacheWriteToken +
      4_000 * flatRates.costPerOutputToken;
    expect(await task.cost()).toBe(legacy);
    expect(Math.abs(legacy - expected)).toBeLessThan(1e-12);
  });

  it('flat cache rates default to the flat input rate when unset (BUG-AGENTMCP-008 behaviour)', async () => {
    const task = await startTask(
      blockWith({ costPerInputToken: 0.000002, costPerOutputToken: 0.00001 }),
      ctx()
    );
    await task.turn(turn);
    const input = 5_000 + 20_000 + 1_000;
    expect(await task.cost()).toBeCloseTo(input * 0.000002 + 2_000 * 0.00001, 12);
  });

  it("pricing:'rate-card' ignores flat rates for a priced model", async () => {
    const task = await startTask(blockWith(flatRates, { pricing: 'rate-card' }), ctx());
    await task.turn(turn);
    expect(Math.abs((await task.cost()) - cardCost(DEEPSEEK, turn))).toBeLessThan(1e-12);
  });

  it("pricing:'flat' ignores the card, and with no flat rates accrues $0 like the pre-change default", async () => {
    const withRates = await startTask(blockWith(flatRates, { pricing: 'flat' }), ctx());
    await withRates.turn(turn);
    expect(await withRates.cost()).toBeGreaterThan(cardCost(DEEPSEEK, turn) * 5);
    const noRates = await startTask(blockWith({}, { pricing: 'flat' }), ctx());
    await noRates.turn(turn);
    expect(await noRates.cost()).toBe(0);
    // cf7e0e5c review-L4: the $0 is announced (once), never silent.
    await new Promise((r) => setImmediate(r));
    expect(noRates.unpriced).toHaveLength(1);
    expect(noRates.unpriced[0]).toMatchObject({ field: 'cost', usedFlatRates: false });
  });

  it("pricing defaults to 'auto': flat rates present => flat; absent => rate card", async () => {
    const flat = await startTask(blockWith(flatRates), ctx());
    await flat.turn(turn);
    const card = await startTask(blockWith(), ctx());
    await card.turn(turn);
    expect(await flat.cost()).not.toBe(await card.cost());
    expect(Math.abs((await card.cost()) - cardCost(DEEPSEEK, turn))).toBeLessThan(1e-12);
  });

  it('a pricing-only config (no caps/defaults) is accepted by the plugin factory', () => {
    expect(() =>
      createPlugin({ db: null as never, config: { pricing: 'rate-card' } as never })
    ).not.toThrow();
    expect(() =>
      createPlugin({ db: null as never, config: { pricing: 'bogus' } as never })
    ).toThrow();
  });
});

// ── AC5 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC5 -- the provider dimension keys on the resolved selection`, () => {
  const config = {
    defaults: { mode: 'block' as const, caps: [] },
    provider: {
      overrides: {
        openai: { caps: [{ field: 'calls', maximum: 1 }] },
      },
    },
  };

  it('an agent with NO inline provider but a resolved openai selection hits provider.overrides.openai caps', async () => {
    const ctx = makeCtx({ selection: { providerType: 'openai', modelRef: DEEPSEEK } });
    expect(ctx.agentDefinition.provider).toBeUndefined();
    const task = await startTask(config, ctx);
    await task.turn({ uncached: 10, output: 5 });
    expect(await task.tripped()).toBe(true);
  });

  it("'unknown' is only the final fallback: no selection and no inline provider is not an openai override", async () => {
    const ctx = makeCtx();
    const task = await startTask(config, ctx);
    await task.turn({ uncached: 10, output: 5 });
    expect(await task.tripped()).toBe(false);
  });

  it('the selection wins over a stale inline provider type', async () => {
    const ctx = makeCtx({
      inlineProvider: { type: 'anthropic', model: SONNET },
      selection: { providerType: 'openai', modelRef: DEEPSEEK },
    });
    const task = await startTask(config, ctx);
    await task.turn({ uncached: 10, output: 5 });
    expect(await task.tripped()).toBe(true);
  });
});

// ── AC6 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC6 -- per-agent and per-provider rate overrides are honoured`, () => {
  const turn: Turn = { uncached: 10_000, output: 1_000 };
  const base = { mode: 'block' as const, caps: [COST_PROBE], costPerInputToken: 0.000003, costPerOutputToken: 0.000015 };

  it('a per-agent costPerInputToken override changes the priced cost', async () => {
    const plain = await startTask({ defaults: base }, makeCtx({ agentName: 'plain' }));
    await plain.turn(turn);
    const overridden = await startTask(
      { defaults: base, agent: { overrides: { special: { costPerInputToken: 0.00003 } } } },
      makeCtx({ agentName: 'special' })
    );
    await overridden.turn(turn);
    expect(await plain.cost()).toBe(10_000 * 0.000003 + 1_000 * 0.000015);
    expect(await overridden.cost()).toBe(10_000 * 0.00003 + 1_000 * 0.000015);
  });

  it('a per-provider costPerInputToken override (selection-keyed) changes the priced cost', async () => {
    const config = {
      defaults: base,
      provider: { overrides: { openai: { costPerInputToken: 0.0000001, costPerOutputToken: 0.0000002 } } },
    };
    const ctx = makeCtx({ selection: { providerType: 'openai', modelRef: DEEPSEEK } });
    const task = await startTask(config, ctx);
    await task.turn(turn);
    expect(await task.cost()).toBe(10_000 * 0.0000001 + 1_000 * 0.0000002);
    const other = await startTask(
      config,
      makeCtx({ selection: { providerType: 'anthropic', modelRef: SONNET } })
    );
    await other.turn(turn);
    expect(await other.cost()).toBe(10_000 * 0.000003 + 1_000 * 0.000015);
  });

  it("an override rate with the default pricing turns a rate-card agent into a flat-priced one (D2 precedence)", async () => {
    const config = {
      defaults: { mode: 'block' as const, caps: [COST_PROBE] },
      agent: { overrides: { special: { costPerInputToken: 0.000001, costPerOutputToken: 0.000002 } } },
    };
    const card = await startTask(config, makeCtx({ agentName: 'other', wireModel: DEEPSEEK }));
    await card.turn(turn);
    const flat = await startTask(config, makeCtx({ agentName: 'special', wireModel: DEEPSEEK }));
    await flat.turn(turn);
    expect(Math.abs((await card.cost()) - cardCost(DEEPSEEK, turn))).toBeLessThan(1e-12);
    expect(await flat.cost()).toBe(10_000 * 0.000001 + 1_000 * 0.000002);
  });
});

// ── AC7 ──────────────────────────────────────────────────────────────────────

describe(`${TICKET} AC7 -- an unpriceable model is reported, never a silent $0`, () => {
  const UNKNOWN = 'acme-frontier-zz-9000';
  const turn: Turn = { uncached: 1_000, output: 100 };

  it('with no flat rates: accrues nothing, emits exactly ONE budget:unpriced_model per task+model, and enforcement does not crash', async () => {
    const ctx = makeCtx({ wireModel: UNKNOWN, selection: { providerType: 'openai', modelRef: UNKNOWN } });
    const task = await startTask(blockWith(), ctx);
    await task.turn(turn);
    await task.turn(turn);
    await task.turn(turn);
    await new Promise((r) => setImmediate(r));
    expect(await task.cost()).toBe(0);
    expect(task.unpriced).toHaveLength(1);
    expect(task.unpriced[0]).toMatchObject({ model: UNKNOWN, field: 'cost', usedFlatRates: false });
  });

  it('a second model in the same task is reported separately', async () => {
    const ctx = makeCtx({ wireModel: UNKNOWN });
    const task = await startTask(blockWith(), ctx);
    await task.turn(turn);
    await task.turn({
      uncached: 1_000,
      output: 100,
      breakdown: [
        {
          model: 'acme-other-model',
          uncachedInputTokens: 1_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          outputTokens: 100,
        },
      ],
    });
    await new Promise((r) => setImmediate(r));
    expect(task.unpriced.map((e) => e['model'])).toEqual([UNKNOWN, 'acme-other-model']);
  });

  it("with flat rates configured: bills at them (not $0) and still reports once", async () => {
    const ctx = makeCtx({ wireModel: UNKNOWN });
    const task = await startTask(
      blockWith({ costPerInputToken: 0.000003, costPerOutputToken: 0.000015 }, { pricing: 'rate-card' }),
      ctx
    );
    await task.turn(turn);
    await task.turn(turn);
    await new Promise((r) => setImmediate(r));
    expect(await task.cost()).toBe(2 * (1_000 * 0.000003 + 100 * 0.000015));
    expect(task.unpriced).toHaveLength(1);
    expect(task.unpriced[0]).toMatchObject({ usedFlatRates: true });
  });

  it('a multi-model breakdown with one unpriced concrete id prices the rest and reports the unknown', async () => {
    const ctx = makeCtx({ selection: { providerType: 'claudecli', modelRef: 'haiku' } });
    const entry = (model: string): ModelUsageEntry => ({
      model,
      uncachedInputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      outputTokens: 100,
    });
    const task = await startTask(blockWith(), ctx);
    await task.turn({
      uncached: 2_000,
      output: 200,
      breakdown: [entry(HAIKU_55), entry('claude-ghost-9-9')],
    });
    await new Promise((r) => setImmediate(r));
    const priced = cardCost(HAIKU_55, { uncached: 1_000, output: 100 }, true);
    expect(Math.abs((await task.cost()) - priced)).toBeLessThan(1e-12);
    expect(task.unpriced.map((e) => e['model'])).toEqual(['claude-ghost-9-9']);
  });
});

// ── Scoped (global) cost across tasks ────────────────────────────────────────

describe(`${TICKET} -- scoped cost accumulates the persisted per-turn rate-card spend`, () => {
  function realDb() {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT)`);
    sqlite.exec(`CREATE TABLE task_usage (
      task_id TEXT PRIMARY KEY, agent_name TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      model_calls INTEGER DEFAULT 0, peak_context_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      uncached_input_tokens INTEGER, est_cost_usd REAL, created_at TEXT)`);
    return {
      db: drizzle(sqlite),
      add(taskId: string, estCost: number | null) {
        sqlite.prepare(`INSERT INTO tasks (id, session_id) VALUES (?, 's')`).run(taskId);
        sqlite
          .prepare(
            `INSERT INTO task_usage (task_id, agent_name, input_tokens, output_tokens, model_calls, est_cost_usd, created_at)
             VALUES (?, 'agent-a', 100, 10, 1, ?, ?)`
          )
          .run(taskId, estCost, new Date().toISOString());
      },
    };
  }

  it('a GLOBAL rate-card cost cap halts task B from task A\'s persisted est_cost_usd (NULL = unpriced = nothing)', async () => {
    const { db, add } = realDb();
    add('task-a', 0.02);
    add('task-null', null);
    const cfg = {
      pricing: 'rate-card',
      defaults: { mode: 'block', scope: 'global', caps: [{ field: 'cost', maximum: 0.015 }] },
    };
    const task = await startTask(cfg, makeCtx({ taskId: 'task-b', wireModel: SONNET }), db);
    expect(await task.tripped()).toBe(true);

    const { db: db2, add: add2 } = realDb();
    add2('task-a', 0.01);
    add2('task-null', null);
    const ok = await startTask(cfg, makeCtx({ taskId: 'task-b', wireModel: SONNET }), db2);
    expect(await ok.tripped()).toBe(false);
    // task B's own in-memory spend folds in on top of the persisted total.
    await ok.turn({ uncached: 10_000_000, output: 0 });
    expect(await ok.tripped()).toBe(true);
  });
});

// ── cf7e0e5c static review corrections (bucket C1) ───────────────────────────

describe(`cf7e0e5c review-M1 -- the cap prices against the SAME price-history source as usage_query`, () => {
  function historyDb(rows: Array<{ model: string; inputPerM: number; cacheReadPerM: number; cacheWritePerM: number; outputPerM: number }>) {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE model_price_history (
      id TEXT PRIMARY KEY, model_id TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'model', input_per_m REAL, cache_read_per_m REAL, cache_write_per_m REAL,
      output_per_m REAL, raw_json TEXT NOT NULL, overrides_json TEXT, ledger_id TEXT)`);
    rows.forEach((r, i) =>
      sqlite
        .prepare(
          `INSERT INTO model_price_history (id, model_id, observed_at, source, kind, input_per_m, cache_read_per_m, cache_write_per_m, output_per_m, raw_json)
           VALUES (?, ?, '2000-01-01T00:00:00.000Z', 'openrouter-live', 'model', ?, ?, ?, ?, '{}')`
        )
        .run(`h${i}`, r.model, r.inputPerM, r.cacheReadPerM, r.cacheWritePerM, r.outputPerM)
    );
    return drizzle(sqlite);
  }

  it('a history record that differs from the bundled card prices the cap, matching estimateCost with the usage plugin\'s source', async () => {
    // 10x the bundled Sonnet rates: only a plugin that reads the history source can reach this number.
    const db = historyDb([{ model: SONNET, inputPerM: 30, cacheReadPerM: 3, cacheWritePerM: 37.5, outputPerM: 150 }]);
    const task = await startTask(
      blockWith(),
      makeCtx({ wireModel: SONNET, selection: { providerType: 'anthropic', modelRef: SONNET } }),
      db
    );
    await task.turn({ uncached: 10_000, output: 1_000 });
    const expected = (10_000 * 30 + 1_000 * 150) / 1e6;
    expect(Math.abs((await task.cost()) - expected)).toBeLessThan(1e-9);
    expect(expected).toBeGreaterThan(cardCost(SONNET, { uncached: 10_000, output: 1_000 }) * 5);
  });

  it('a DB without the price-history table degrades to the bundled snapshot instead of failing', async () => {
    const db = drizzle(new Database(':memory:'));
    const task = await startTask(blockWith(), makeCtx({ wireModel: SONNET }), db);
    const t: Turn = { uncached: 10_000, output: 1_000 };
    await task.turn(t);
    expect(Math.abs((await task.cost()) - cardCost(SONNET, t))).toBeLessThan(1e-9);
  });
});

describe(`cf7e0e5c review-M2 -- the single-model path prices the REQUESTED model, as usage_query does`, () => {
  it('a differing responseModel does not change which model the cap prices', async () => {
    const t: Turn = { uncached: 10_000, cacheRead: 50_000, output: 1_000 };
    const task = await startTask(blockWith(), makeCtx({ wireModel: DEEPSEEK }));
    await task.turn({ ...t, responseModel: SONNET });
    expect(Math.abs((await task.cost()) - cardCost(DEEPSEEK, t))).toBeLessThan(1e-9);
    expect(Math.abs(cardCost(SONNET, t) - cardCost(DEEPSEEK, t))).toBeGreaterThan(1e-6);
  });

  it('an alias in the selection with no wireModel resolves via selection.modelRef (wireModelOf order)', async () => {
    const t: Turn = { uncached: 5_000, output: 500 };
    const task = await startTask(
      blockWith(),
      makeCtx({ selection: { providerType: 'openai', modelRef: DEEPSEEK } })
    );
    await task.turn({ ...t, responseModel: SONNET });
    expect(Math.abs((await task.cost()) - cardCost(DEEPSEEK, t))).toBeLessThan(1e-9);
  });
});

describe(`cf7e0e5c review-M3 -- a scoped cost never mixes pricing bases`, () => {
  it('flat rates set only on an agent override make persisted rows of other tasks bill flat too', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT)`);
    sqlite.exec(`CREATE TABLE task_usage (
      task_id TEXT PRIMARY KEY, agent_name TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      model_calls INTEGER DEFAULT 0, peak_context_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      uncached_input_tokens INTEGER, est_cost_usd REAL, created_at TEXT)`);
    sqlite.prepare(`INSERT INTO tasks (id, session_id) VALUES ('task-a', 's')`).run();
    // Card-priced at $0.02, but 100 uncached input + 10 output at the override's flat rates = $0.5.
    sqlite
      .prepare(
        `INSERT INTO task_usage (task_id, agent_name, input_tokens, output_tokens, model_calls, est_cost_usd, created_at)
         VALUES ('task-a', 'special', 100, 10, 1, 0.02, ?)`
      )
      .run(new Date().toISOString());
    const cfg = {
      defaults: { mode: 'block', scope: 'global', caps: [{ field: 'cost', maximum: 0.3 }] },
      agent: { overrides: { special: { costPerInputToken: 0.004, costPerOutputToken: 0.01 } } },
    };
    const special = await startTask(cfg, makeCtx({ taskId: 'task-b', agentName: 'special', wireModel: SONNET }), drizzle(sqlite));
    expect(await special.tripped()).toBe(true);
    // An agent with no override stays on the card basis for the same persisted rows.
    const plain = await startTask(cfg, makeCtx({ taskId: 'task-c', agentName: 'plain', wireModel: SONNET }), drizzle(sqlite));
    expect(await plain.tripped()).toBe(false);
  });
});

describe(`cf7e0e5c review-L5/L6 -- one provider source for rates and caps; strict pricing in both config shapes`, () => {
  it('a mid-task provider change re-keys the rate override together with the caps', async () => {
    const ctx = makeCtx({ wireModel: DEEPSEEK, selection: { providerType: 'anthropic', modelRef: DEEPSEEK } });
    const cfg = {
      defaults: { mode: 'block' as const, caps: [COST_PROBE] },
      provider: { overrides: { openai: { costPerInputToken: 0.000001, costPerOutputToken: 0.000002 } } },
    };
    const task = await startTask(cfg, ctx);
    (ctx as unknown as { selection: unknown }).selection = { providerType: 'openai', modelRef: DEEPSEEK };
    await task.turn({ uncached: 10_000, output: 1_000 });
    expect(await task.cost()).toBe(10_000 * 0.000001 + 1_000 * 0.000002);
  });

  it('an invalid `pricing` in a flat-format config throws, like the structured format', () => {
    expect(() =>
      createPlugin({ db: null as never, config: { pricing: 'bogus', maxModelCalls: 5 } as never })
    ).toThrow();
    expect(() =>
      createPlugin({ db: null as never, config: { pricing: 'rate-card', maxModelCalls: 5 } as never })
    ).not.toThrow();
  });
});
