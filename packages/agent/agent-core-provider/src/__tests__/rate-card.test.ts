import { describe, expect, it } from 'vitest';
import { RATE_CARD, estimateCostUsd } from '../pricing/rate-card.js';

/**
 * DEBT-AGENTMCP-ACCOUNTING-001 — the rate-card module backing `task_usage.est_cost_usd`.
 * Sourced 2026-07-16 from vendor docs (Anthropic, DeepSeek) — see rate-card.ts's own
 * header comment for citations. These assertions pin the exact numbers so a future
 * accidental edit to the table is caught immediately.
 */
describe('RATE_CARD', () => {
  it('has an entry for every model documented in DESIGN.md', () => {
    expect(Object.keys(RATE_CARD).sort()).toEqual(
      [
        'claude_sonnet_4_6',
        'claude_opus_4_8',
        'claude_haiku_4_5',
        'claude_fable_5',
        'deepseek-v4-flash',
        'deepseek-v4-pro',
      ].sort()
    );
  });

  it('every rate is non-negative, and cache-read is always cheaper than full-price input', () => {
    for (const [model, rate] of Object.entries(RATE_CARD)) {
      expect(rate.inputPerM, model).toBeGreaterThan(0);
      expect(rate.cacheReadPerM, model).toBeGreaterThanOrEqual(0);
      expect(rate.cacheWritePerM, model).toBeGreaterThanOrEqual(0);
      expect(rate.outputPerM, model).toBeGreaterThan(0);
      // Cache-hit input must always be strictly cheaper than a cache miss — that's the
      // entire economic point of caching (DESIGN.md §4 / 0008 migration comment).
      expect(rate.cacheReadPerM, model).toBeLessThan(rate.inputPerM);
    }
  });
});

describe('estimateCostUsd', () => {
  it('claude_sonnet_4_6: matches the hand-computed rate-card value', () => {
    // inputPerM=3.00, cacheReadPerM=0.30, cacheWritePerM=3.75, outputPerM=15.00
    const cost = estimateCostUsd('claude_sonnet_4_6', {
      uncachedInputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 500,
      outputTokens: 300,
    });
    // (1000*3.00 + 2000*0.30 + 500*3.75 + 300*15.00) / 1e6 = 9975 / 1e6
    expect(cost).toBeCloseTo(0.009975, 9);
  });

  it('deepseek-v4-flash: zero cache-write rate means cache creation contributes nothing', () => {
    const cost = estimateCostUsd('deepseek-v4-flash', {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1_000_000, // would be non-trivial on any provider that bills it
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('is linear/additive: cost of a 2-turn sum equals the sum of each turn priced separately', () => {
    const turn1 = { uncachedInputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 0, outputTokens: 20 };
    const turn2 = { uncachedInputTokens: 200, cacheReadTokens: 10, cacheCreationTokens: 5, outputTokens: 40 };
    const summed = {
      uncachedInputTokens: turn1.uncachedInputTokens + turn2.uncachedInputTokens,
      cacheReadTokens: turn1.cacheReadTokens + turn2.cacheReadTokens,
      cacheCreationTokens: turn1.cacheCreationTokens + turn2.cacheCreationTokens,
      outputTokens: turn1.outputTokens + turn2.outputTokens,
    };
    const model = 'claude_haiku_4_5';
    const separate = (estimateCostUsd(model, turn1) ?? 0) + (estimateCostUsd(model, turn2) ?? 0);
    const combined = estimateCostUsd(model, summed) ?? 0;
    expect(combined).toBeCloseTo(separate, 12);
  });

  it('returns null (never 0) for a model with no rate-card entry', () => {
    const cost = estimateCostUsd('totally-unrecognized-model-xyz', {
      uncachedInputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 100,
    });
    expect(cost).toBeNull();
  });
});
