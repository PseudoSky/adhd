import { describe, expect, it } from 'vitest';
import { estimateCost, estimateCostUsd, RATE_CARD } from '../pricing/rate-card.js';
import { parseOpenRouterFeed } from '../pricing/feed.js';
import type { IPriceRecord, IPriceSource } from '../pricing/price-source.js';

/**
 * b726a987 — cache-write cost honors the 1-hour TTL tier. Production repro: a cold-cache claudecli
 * haiku-4-5 call (uncached 10, cache write 4670 ALL at the 1h TTL, output 49) cost 0.0060925 stored
 * vs the vendor's 0.009595, because every cache-write token was priced at the 5-minute rate.
 */
const COLD_CACHE = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 4670, outputTokens: 49 };

function source(rec: Partial<IPriceRecord>): IPriceSource {
  return {
    priceAt: (id): IPriceRecord => ({
      id: 'hist-1', modelId: id, observedAt: '2026-01-01T00:00:00.000Z', kind: 'model',
      inputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5, source: 'openrouter-live',
      ...rec,
    }),
  };
}

describe('b726a987 cache-write 1h tier', () => {
  it('b726a987 AC1: 1h-tier cache writes price at the 1h rate (the 4670-token production example is exactly 0.009595)', () => {
    const est = estimateCost('claude-haiku-4-5-20251001', { ...COLD_CACHE, cacheCreation1hTokens: 4670 });
    expect(est.costUsd).toBeCloseTo(0.009595, 12);
    expect(est.status).toBe('priced');
    expect(est.pricingRef).toBe('rate-card:claude_haiku_4_5');
  });

  it('b726a987 AC2: 5m-only and unsplit usage are unchanged (all cache writes at the 5-minute rate)', () => {
    const unsplit = estimateCost('claude_haiku_4_5', COLD_CACHE).costUsd;
    expect(unsplit).toBeCloseTo(0.0060925, 12); // the pre-fix number, pinned
    expect(estimateCost('claude_haiku_4_5', { ...COLD_CACHE, cacheCreation1hTokens: 0 }).costUsd).toBe(unsplit);
    expect(estimateCost('claude_haiku_4_5', { ...COLD_CACHE, cacheCreation1hTokens: undefined }).costUsd).toBe(unsplit);
  });

  it('b726a987 AC3: mixed 5m + 1h usage prices each part at its own tier', () => {
    const usage = { uncachedInputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 3000, cacheCreation1hTokens: 1200, outputTokens: 50 };
    // haiku per-M units: 100*1 + 1000*0.1 + (3000-1200)*1.25 + 1200*2.0 + 50*5
    expect(estimateCostUsd('claude_haiku_4_5', usage)).toBeCloseTo((100 + 100 + 2250 + 2400 + 250) / 1e6, 12);
  });

  it('b726a987 AC3: a 1h count outside [0, cacheCreationTokens] is clamped, never pricing more writes than exist', () => {
    expect(estimateCostUsd('claude_haiku_4_5', { ...COLD_CACHE, cacheCreation1hTokens: 999_999 })).toBeCloseTo(0.009595, 12);
    expect(estimateCostUsd('claude_haiku_4_5', { ...COLD_CACHE, cacheCreation1hTokens: -5 })).toBeCloseTo(0.0060925, 12);
  });

  it('b726a987 AC4: a model with no 1h rate falls back to its 5-minute rate (documented fallback, no fabricated number)', () => {
    expect(RATE_CARD['deepseek-v4-flash']?.cacheWrite1hPerM).toBeUndefined();
    const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, outputTokens: 0 };
    // History record without a 1h tier (null) and a rate-card model without one both bill 1h tokens at cacheWritePerM.
    const viaHistory = estimateCost('vendor/some-model', { ...usage, cacheCreation1hTokens: 400_000 }, { source: source({ cacheWrite1hPerM: null }) });
    expect(viaHistory.costUsd).toBeCloseTo(1.25, 12);
    const viaAbsent = estimateCost('vendor/some-model', { ...usage, cacheCreation1hTokens: 400_000 }, { source: source({}) });
    expect(viaAbsent.costUsd).toBeCloseTo(1.25, 12);
    const rateCard = estimateCost('deepseek-v4-flash', { ...usage, cacheCreation1hTokens: 400_000 });
    expect(rateCard.costUsd).toBe(estimateCost('deepseek-v4-flash', usage).costUsd);
  });

  it('b726a987 AC1: the price-history path honors the record 1h tier', () => {
    const est = estimateCost('anthropic/claude-haiku-4.5', { ...COLD_CACHE, cacheCreation1hTokens: 4670 }, { source: source({ cacheWrite1hPerM: 2 }) });
    expect(est.costUsd).toBeCloseTo(0.009595, 12);
    expect(est.pricingRef).toBe('hist-1');
  });

  it('b726a987 AC1: the bundled OpenRouter snapshot path honors input_cache_write_1h', () => {
    // anthropic/claude-haiku-4.5 is in the committed snapshot with a published 1h tier.
    const split = estimateCost('anthropic/claude-haiku-4.5', { ...COLD_CACHE, cacheCreation1hTokens: 4670 });
    const unsplit = estimateCost('anthropic/claude-haiku-4.5', COLD_CACHE);
    expect(split.pricingRef).toMatch(/^bundled:/);
    expect(split.costUsd as number).toBeGreaterThan(unsplit.costUsd as number);
  });

  it('b726a987 AC1: parseOpenRouterFeed surfaces input_cache_write_1h as $/M (null when unpublished, negative rejected)', () => {
    const parsed = parseOpenRouterFeed({
      data: [
        { id: 'a/with', pricing: { prompt: '0.000001', completion: '0.000005', input_cache_write: '0.00000125', input_cache_write_1h: '0.000002' } },
        { id: 'a/without', pricing: { prompt: '0.000001', completion: '0.000005' } },
        { id: 'a/bad', pricing: { prompt: '0.000001', completion: '0.000005', input_cache_write_1h: '-1' } },
      ],
    });
    expect(parsed.models.find((m) => m.modelId === 'a/with')?.cacheWrite1hPerM).toBe(2);
    expect(parsed.models.find((m) => m.modelId === 'a/without')?.cacheWrite1hPerM).toBeNull();
    expect(parsed.invalid.join('\n')).toContain('input_cache_write_1h');
  });

  it('b726a987 AC1: every priced Claude rate-card entry publishes a 1h tier above its 5m tier', () => {
    for (const [model, rate] of Object.entries(RATE_CARD)) {
      if (!model.startsWith('claude_')) continue;
      expect(rate.cacheWrite1hPerM, model).toBeDefined();
      expect(rate.cacheWrite1hPerM as number, model).toBeGreaterThan(rate.cacheWritePerM);
    }
  });
});
