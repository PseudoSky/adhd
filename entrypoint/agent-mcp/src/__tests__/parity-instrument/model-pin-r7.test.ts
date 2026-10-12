import { describe, expect, it } from 'vitest';

import { loadParity } from './load';

/**
 * R7-model (EXPERIMENT-LOG SCOPE-R7-model-sonnet, owner: "the experiment with sonnet instead of haiku"): the model under test is ONE
 * pin shared by all three arms and the oracle; the judge model is a separate pin; the common rate card is model-keyed and never
 * borrows another model's price; the thinking-off gap for claude-sonnet-5-5 is recorded rather than assumed.
 * Acceptance ids: R7-model AC1 (pin), AC2 (thinking), AC3 (cost card).
 */
const F = await loadParity('fixtures.mjs');
const L = await loadParity('lib.mjs');
const O = await loadParity('oracle.mjs');
const D = await loadParity('drive.mjs');
const J = await loadParity('judge.mjs');

describe('R7-model', () => {
  it('AC1: PIN_MODEL is claude-sonnet-5-5 and the judge model is a separate pin that stays claude-haiku-4-5', () => {
    expect(F.PIN_MODEL).toBe('claude-sonnet-5-5');
    expect(J.JUDGE_MODEL).toBe('claude-haiku-4-5');
    expect(J.JUDGE_MODEL).not.toBe(F.PIN_MODEL);
    expect(O.selfTestExpected().pin).toBe(F.PIN_MODEL);
  });

  it('AC1: r1_model passes the pin (and a dated snapshot of it) and fails an arm served by the previous or a neighbouring model (negative control)', () => {
    const e = O.selfTestExpected();
    const status = (models: string[]) => {
      const o = O.idealObservation('A', e);
      o.models = models;
      return O.scoreObservation(o, e).fields.r1_model.status;
    };
    expect(status([F.PIN_MODEL])).toBe('pass');
    expect(status([`${F.PIN_MODEL}-20261001`])).toBe('pass');
    for (const wrong of ['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6']) expect(status([wrong]), wrong).toBe('fail');
  });

  it('AC3: the common rate card for the pin is $2/$10 with cache read 0.10, 5m write 2.50, 1h write 4.00 per M, cites its source, and differs from the haiku card (negative control)', () => {
    expect(L.RATES_PER_M).toEqual({ input: 2.0, output: 10.0, cacheRead: 0.1, write5m: 2.5, write1h: 4.0 });
    expect(L.RATE_CARDS[F.PIN_MODEL].source).toContain('pricing.json');
    const n = L.normUsage({ input_tokens: 1e6, output_tokens: 1e6 });
    expect(L.priceNorm(n).usd).toBeCloseTo(12, 9);
    expect(L.priceNorm(n, L.RATE_CARDS['claude-haiku-4-5'].rates).usd).toBeCloseTo(6, 9);
  });

  it('AC3: a model with no rate card is unmeasured (usd null), never priced at another model', () => {
    expect(L.rateCardFor('claude-sonnet-5')).toBeNull();
    const p = L.priceNorm(L.normUsage({ input_tokens: 5 }), null);
    expect(p.usd).toBeNull();
    expect(p.unmeasured).toBe(true);
    expect(L.unmeasuredNote('claude-sonnet-5')).toBe('unmeasured: no rate card for claude-sonnet-5');
  });

  it('AC2: thinking-off is recorded as NOT achievable for claude-sonnet-5-5 (and achievable for haiku-4-5, unknown for others)', () => {
    expect(D.thinkingOffAchievable('claude-sonnet-5-5')).toBe(false);
    expect(D.thinkingOffAchievable('claude-haiku-4-5')).toBe(true);
    expect(D.thinkingOffAchievable('claude-unknown-9')).toBeNull();
    expect(D.THINKING_DISABLE_SUPPORT['claude-sonnet-5-5'].evidence).toContain('rejects_disabled_thinking');
  });
});
