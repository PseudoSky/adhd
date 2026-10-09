import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenRouterFeed, perMillion, type IParsedModel } from '../pricing/feed.js';
import { parseBundledSnapshot } from '../pricing/rate-card.js';

/**
 * 37f6c511 (G2/G3) — OpenRouter feed parser/validator. Fixtures are tiny and derived from the
 * real pricing.json structure ({id,name,pricing:{prompt,completion,input_cache_*,overrides}}).
 */
const feed = (...models: unknown[]) => ({ data: models });
const first = (r: { models: IParsedModel[] }): IParsedModel => {
  const x = r.models[0];
  if (!x) throw new Error('expected at least one parsed model');
  return x;
};
const m = (id: string, pricing: Record<string, unknown>) => ({ id, name: id, pricing });

describe('37f6c511 FS2-AC1: per-token strings normalise to $/million', () => {
  it('"0.0000003" per token is stored as exactly 0.3 per million (12-sig-digit rule)', () => {
    const r = parseOpenRouterFeed(
      feed(m('Deepseek/DeepSeek-V4.1-Flash', { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000006' }))
    );
    expect(r.invalid).toEqual([]);
    expect(r.models).toHaveLength(1);
    const row = first(r);
    expect(row.modelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(row.kind).toBe('model');
    expect(row.inputPerM).toBe(0.3);
    expect(row.outputPerM).toBe(1.2);
    expect(row.cacheReadPerM).toBe(0.006);
    expect(row.cacheWritePerM).toBeNull();
    expect(perMillion('0.0000003')).toBe(0.3);
  });

  it('free (0) is a real price, distinct from absent (null)', () => {
    const row = first(parseOpenRouterFeed(feed(m('a/free', { prompt: '0', completion: '0' }))));
    expect(row.inputPerM).toBe(0);
    expect(row.outputPerM).toBe(0);
    expect(row.cacheReadPerM).toBeNull();
  });

  it('accepts the committed snapshot shape ({models:[...]}) as well as the live shape ({data:[...]})', () => {
    const one = m('a/b', { prompt: '0.000001', completion: '0.000002' });
    expect(parseOpenRouterFeed({ models: [one] }).models).toHaveLength(1);
    expect(parseOpenRouterFeed({ data: [one] }).models).toHaveLength(1);
  });
});

describe('37f6c511 FS2-AC6: router -1 is kind=router with NULL rates', () => {
  it('prompt "-1" => router, every rate null, never a number', () => {
    const r = parseOpenRouterFeed(feed(m('openrouter/auto', { prompt: '-1', completion: '-1' })));
    expect(r.invalid).toEqual([]);
    expect(r.models[0]).toMatchObject({
      modelId: 'openrouter/auto', kind: 'router',
      inputPerM: null, cacheReadPerM: null, cacheWritePerM: null, outputPerM: null,
    });
  });
});

describe('37f6c511 FS2-AC14: invalid values are reported so the whole pull can be rejected', () => {
  it.each([
    ['negative non-router price', { prompt: '-0.5', completion: '0.000001' }],
    ['negative completion', { prompt: '0.000001', completion: '-3' }],
    ['non-numeric price', { prompt: 'abc', completion: '0.000001' }],
    ['empty-string price', { prompt: '', completion: '0.000001' }],
    ['missing completion', { prompt: '0.000001' }],
    ['negative cache price', { prompt: '0.000001', completion: '0.000001', input_cache_read: '-1' }],
  ])('%s => reported in invalid, model not emitted', (_name, pricing) => {
    const r = parseOpenRouterFeed(feed(m('bad/one', pricing)));
    expect(r.models).toEqual([]);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0]).toContain('bad/one');
  });

  it('100 good + 1 negative: the bad one is surfaced so a caller applies zero rows', () => {
    const good = Array.from({ length: 100 }, (_, i) => m(`g/m${i}`, { prompt: '0.000001', completion: '0.000002' }));
    const r = parseOpenRouterFeed(feed(...good, m('x/neg', { prompt: '-2', completion: '1' })));
    expect(r.models).toHaveLength(100);
    expect(r.invalid).toHaveLength(1);
  });

  it.each([[null], [undefined], ['html'], [{}], [{ data: 'nope' }], [{ data: [null, { id: 'x' }, { pricing: {} }] }]])(
    'malformed shape %j never throws and is reported invalid',
    (input) => {
      const r = parseOpenRouterFeed(input);
      expect(r.models).toEqual([]);
      expect(r.invalid.length).toBeGreaterThan(0);
    }
  );
});

describe('37f6c511 FS2-AC15: overrides stored verbatim, base unaffected', () => {
  it('overridesJson carries the raw overrides; rates and rawJson exclude them', () => {
    const overrides = [{ min_prompt_tokens: 100000, prompt: '0.000005', completion: '0.000025' }];
    const row = first(parseOpenRouterFeed(
      feed(m('a/tiered', { prompt: '0.000001', completion: '0.000002', overrides }))
    ));
    expect(row.inputPerM).toBe(1);
    expect(row.outputPerM).toBe(2);
    expect(JSON.parse(row.overridesJson ?? 'null')).toEqual(overrides);
    expect(JSON.parse(row.rawJson)).toEqual({ prompt: '0.000001', completion: '0.000002' });
    expect(first(parseOpenRouterFeed(feed(m('a/plain', { prompt: '0.000001', completion: '0.000002' })))).overridesJson).toBeNull();
  });
});

describe('37f6c511 real-feed parse: committed pricing.json through parseOpenRouterFeed', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
  ) as { models: Array<{ id: string; pricing: Record<string, unknown> }> };

  it('467 models, zero invalid, the 7 routers recognised, overrides preserved', () => {
    const r = parseOpenRouterFeed(raw);
    expect(r.invalid).toEqual([]);
    expect(r.models).toHaveLength(467);
    const routers = r.models.filter((x) => x.kind === 'router');
    expect(routers).toHaveLength(raw.models.filter((x) => x.pricing['prompt'] === '-1').length);
    expect(routers.length).toBeGreaterThan(0);
    for (const x of routers) expect(x.inputPerM).toBeNull();
    const withOverrides = raw.models.filter((x) => x.pricing['overrides'] !== undefined).length;
    expect(r.models.filter((x) => x.overridesJson !== null)).toHaveLength(withOverrides);
    expect(withOverrides).toBeGreaterThan(0);
  });

  it('parseBundledSnapshot exposes the same parse plus provenance for store seeding', () => {
    const b = parseBundledSnapshot();
    expect(b.models).toHaveLength(467);
    expect(b.invalid).toEqual([]);
    expect(b.fetchedAt).toBe('2026-10-08T18:57:29.314Z');
    expect(b.source).toBe('https://openrouter.ai/api/v1/models');
  });
});
