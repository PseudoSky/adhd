import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_MODEL_ALIASES,
  PRICING_SNAPSHOT_META,
  RATE_CARD,
  estimateCost,
  estimateCostUsd,
} from '../pricing/rate-card.js';
import type { IPriceRecord, IPriceSource } from '../pricing/price-source.js';

const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 2_000, cacheCreationTokens: 500, outputTokens: 300 };
const NONE = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };

const rec = (over: Partial<IPriceRecord> & { id: string; modelId: string }): IPriceRecord => ({
  observedAt: '2026-10-09T00:00:00.000Z',
  kind: 'model',
  inputPerM: 1,
  cacheReadPerM: 0.1,
  cacheWritePerM: 0,
  outputPerM: 2,
  source: 'openrouter-live',
  ...over,
});

/** In-memory as-of source: greatest observedAt <= instant (the contract the runtime store implements). */
function memorySource(rows: IPriceRecord[], calls: Array<[string, string]> = []): IPriceSource {
  return {
    priceAt(modelId, instant) {
      calls.push([modelId, instant]);
      const own = rows.filter((r) => r.modelId === modelId).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      if (own.length === 0) return undefined;
      const hit = [...own].reverse().find((r) => r.observedAt <= instant);
      return hit ?? { ...(own[0] as IPriceRecord), beforeFirstObservation: true };
    },
  };
}

describe('1f1c8598 FS4-AC1: alias resolves with owner-assumption basis', () => {
  it('deepseek-flash => owner-assumption, resolvedId deepseek/deepseek-v4.1-flash, bundled ref', () => {
    const e = estimateCost('deepseek-flash', usage);
    expect(e.basis).toBe('owner-assumption');
    expect(e.status).toBe('priced');
    expect(e.resolvedId).toBe('deepseek/deepseek-v4.1-flash');
    expect(e.pricingRef).toBe(`bundled:${PRICING_SNAPSHOT_META.fetchedAt}:deepseek/deepseek-v4.1-flash`);
    expect(e.costUsd).toBeCloseTo(0.000672, 12);
  });

  it('the alias entry carries who/when/why', () => {
    expect(PROVIDER_MODEL_ALIASES['deepseek-flash']).toEqual({
      target: 'deepseek/deepseek-v4.1-flash',
      basis: 'owner-assumption',
      setAt: '2026-10-08',
      setBy: 'owner',
      ticket: '37f6c511',
    });
  });
});

describe('1f1c8598 FS4-AC4: basis labels by resolution path', () => {
  it('deepseek-v4-flash => vendor-direct (rate-card ref)', () => {
    const e = estimateCost('deepseek-v4-flash', usage);
    expect(e).toMatchObject({ basis: 'vendor-direct', status: 'priced', pricingRef: 'rate-card:deepseek-v4-flash', resolvedId: 'deepseek-v4-flash' });
  });
  it('plain OpenRouter id => openrouter-estimate', () => {
    const e = estimateCost('deepseek/deepseek-v4.1-flash', usage);
    expect(e.basis).toBe('openrouter-estimate');
    expect(e.pricingRef).toMatch(/^bundled:.+:deepseek\/deepseek-v4\.1-flash$/);
  });
  it('normalised / family fallbacks are vendor-direct with the matched key in the ref', () => {
    expect(estimateCost('claude-haiku-4-5-20251001', usage)).toMatchObject({ basis: 'vendor-direct', pricingRef: 'rate-card:claude_haiku_4_5' });
    expect(estimateCost('sonnet', usage)).toMatchObject({ basis: 'vendor-direct', pricingRef: 'rate-card:claude_sonnet_4_6' });
  });
  it('unknown => null cost, unpriced_model, no basis/ref/id (never 0)', () => {
    expect(estimateCost('totally-made-up-model', usage)).toEqual({
      costUsd: null, status: 'unpriced_model', basis: null, pricingRef: null, resolvedId: null,
    });
  });
});

describe('37f6c511 FS3-AC3: four-token-class cost', () => {
  it('equals the hand-computed (uncached*in + cacheRead*cr + cacheWrite*cw + out*out)/1e6', () => {
    // claude_sonnet_4_6: 3.00 / 0.30 / 3.75 / 15.00
    const expected = (1_000 * 3 + 2_000 * 0.3 + 500 * 3.75 + 300 * 15) / 1_000_000;
    expect(estimateCost('claude_sonnet_4_6', usage).costUsd).toBeCloseTo(expected, 12);
  });
  it('source record: cache-read null falls back to input, cache-write null yields 0', () => {
    const src = memorySource([rec({ id: 'h1', modelId: 'x/m', inputPerM: 2, cacheReadPerM: null, cacheWritePerM: null, outputPerM: 4 })]);
    const e = estimateCost('x/m', usage, { source: src, asOf: '2026-10-10T00:00:00.000Z' });
    expect(e.costUsd).toBeCloseTo((1_000 * 2 + 2_000 * 2 + 500 * 0 + 300 * 4) / 1_000_000, 12);
    expect(e.pricingRef).toBe('h1');
  });
});

describe('37f6c511 FS3-AC6/AC7: no-source behaviour is unchanged', () => {
  it('estimateCostUsd("deepseek-flash") equals the pinned pre-change value, with and without opts', () => {
    expect(estimateCostUsd('deepseek-flash', usage)).toBeCloseTo(0.000672, 12);
    expect(estimateCostUsd('deepseek-flash', usage, {})).toBe(estimateCostUsd('deepseek-flash', usage));
  });
  it('a RATE_CARD vendor-direct key wins over the OpenRouter data, even with a source that knows it', () => {
    const src = memorySource([rec({ id: 'h', modelId: 'deepseek-v4-flash', inputPerM: 99, outputPerM: 99 })]);
    const e = estimateCost('deepseek-v4-flash', usage, { source: src });
    expect(e.basis).toBe('vendor-direct');
    expect(e.costUsd).toBeCloseTo((1_000 * 0.14 + 2_000 * 0.0028 + 0 + 300 * 0.28) / 1_000_000, 12);
    expect(RATE_CARD['deepseek-v4-flash']?.inputPerM).toBe(0.14);
  });
  it('every bundled model prices identically to an independent per-token computation (parser == old path)', () => {
    const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
  ) as { models: Array<{ id: string; pricing: Record<string, string> }> };
    const u = { uncachedInputTokens: 1000, cacheReadTokens: 2000, cacheCreationTokens: 500, outputTokens: 300 };
    let checked = 0;
    for (const x of raw.models) {
      const p = x.pricing;
      const pm = (s: string | undefined) => (s === undefined ? Number.NaN : Number((Number(s) * 1_000_000).toPrecision(12)));
      const inp = pm(p['prompt']); const out = pm(p['completion']);
      if (!(inp >= 0) || !(out >= 0)) continue;
      const cr = pm(p['input_cache_read']); const cw = pm(p['input_cache_write']);
      const expected = (1000 * inp + 2000 * (cr >= 0 ? cr : inp) + 500 * (cw >= 0 ? cw : 0) + 300 * out) / 1_000_000;
      // Skip ids that a RATE_CARD exact key would shadow; none exist today but stay robust.
      if (Object.hasOwn(RATE_CARD, x.id)) continue;
      expect(estimateCost(x.id, u).costUsd, x.id).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(400);
  });
});

describe('37f6c511 FS3-AC1: as-of resolution through an IPriceSource', () => {
  const rows = [
    rec({ id: 'h1', modelId: 'x/m', observedAt: '2026-10-01T00:00:00.000Z', inputPerM: 1, outputPerM: 1 }),
    rec({ id: 'h3', modelId: 'x/m', observedAt: '2026-10-03T00:00:00.000Z', inputPerM: 5, outputPerM: 5 }),
  ];
  const onlyIn = { ...NONE, uncachedInputTokens: 1_000_000 };
  it('prices at the record in force at asOf and cites its id', () => {
    const src = memorySource(rows);
    expect(estimateCost('x/m', onlyIn, { source: src, asOf: '2026-10-02T00:00:00.000Z' })).toMatchObject({ costUsd: 1, pricingRef: 'h1', basis: 'openrouter-estimate' });
    expect(estimateCost('x/m', onlyIn, { source: src, asOf: '2026-10-03T00:00:00.000Z' })).toMatchObject({ costUsd: 5, pricingRef: 'h3' });
  });
  it('omitted asOf means latest', () => {
    expect(estimateCost('x/m', onlyIn, { source: memorySource(rows) }).pricingRef).toBe('h3');
  });
  it('alias hit through a source is labelled owner-assumption and queries the alias TARGET id, lowercased', () => {
    const calls: Array<[string, string]> = [];
    const src = memorySource([rec({ id: 'live1', modelId: 'deepseek/deepseek-v4.1-flash' })], calls);
    const e = estimateCost(' DeepSeek-Flash ', usage, { source: src, asOf: '2026-10-10T00:00:00.000Z' });
    expect(calls).toEqual([['deepseek/deepseek-v4.1-flash', '2026-10-10T00:00:00.000Z']]);
    expect(e).toMatchObject({ basis: 'owner-assumption', pricingRef: 'live1', resolvedId: 'deepseek/deepseek-v4.1-flash' });
  });
});

describe('37f6c511 source fall-through rules', () => {
  it('source returns undefined (empty store) => bundled value, identical to no-source (FS2-AC16)', () => {
    const empty: IPriceSource = { priceAt: () => undefined };
    expect(estimateCost('deepseek-flash', usage, { source: empty, asOf: '2026-10-10T00:00:00.000Z' }))
      .toEqual(estimateCost('deepseek-flash', usage));
  });
  it('a newer source row overrides the bundled price', () => {
    const src = memorySource([rec({ id: 'live', modelId: 'deepseek/deepseek-v4.1-flash', inputPerM: 10, cacheReadPerM: 0, cacheWritePerM: 0, outputPerM: 10 })]);
    const e = estimateCost('deepseek/deepseek-v4.1-flash', { ...NONE, uncachedInputTokens: 1_000_000 }, { source: src });
    expect(e.costUsd).toBe(10);
    expect(e.pricingRef).toBe('live');
  });
  it('a router record is final: unpriced, never falls through to bundled or later steps', () => {
    const src = memorySource([rec({ id: 'r1', modelId: 'deepseek/deepseek-v4.1-flash', kind: 'router', inputPerM: null, cacheReadPerM: null, cacheWritePerM: null, outputPerM: null })]);
    expect(estimateCost('deepseek/deepseek-v4.1-flash', usage, { source: src })).toEqual({
      costUsd: null, status: 'unpriced_model', basis: null, pricingRef: null, resolvedId: null,
    });
  });
  it('kind=router is final even if a (corrupt) row carries numeric rates', () => {
    const src = memorySource([rec({ id: 'r2', modelId: 'deepseek/deepseek-v4.1-flash', kind: 'router', inputPerM: 1, outputPerM: 1 })]);
    expect(estimateCost('deepseek/deepseek-v4.1-flash', usage, { source: src }).costUsd).toBeNull();
  });
  it('a model record with null input/output is unpriced, not $0', () => {
    const src = memorySource([rec({ id: 'n', modelId: 'x/m', inputPerM: null })]);
    expect(estimateCost('x/m', usage, { source: src }).costUsd).toBeNull();
  });
  it('a free (0) record prices to 0, which is not the same as unpriced', () => {
    const src = memorySource([rec({ id: 'f', modelId: 'x/free', inputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, outputPerM: 0 })]);
    const e = estimateCost('x/free', usage, { source: src });
    expect(e.costUsd).toBe(0);
    expect(e.status).toBe('priced');
  });
  it('estimateCostUsd forwards opts', () => {
    const src = memorySource([rec({ id: 'f', modelId: 'x/free', inputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, outputPerM: 0 })]);
    expect(estimateCostUsd('x/free', usage, { source: src })).toBe(0);
    expect(estimateCostUsd('x/free', usage)).toBeNull();
  });
});
