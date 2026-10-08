import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRICING_SNAPSHOT_META,
  PROVIDER_MODEL_ALIASES,
  estimateCostUsd,
} from '../pricing/rate-card.js';

/**
 * 37f6c511 (OpenRouter cost data, snapshot + wiring slice). pricing.json is the committed
 * snapshot of GET https://openrouter.ai/api/v1/models, wired into `estimateCostUsd` — the
 * single function the usage plugin and usage_query both call.
 */
const usage = {
  uncachedInputTokens: 1_000,
  cacheReadTokens: 2_000,
  cacheCreationTokens: 500,
  outputTokens: 300,
};

describe('37f6c511 AC1 — pricing.json snapshot', () => {
  const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
  ) as {
    source: string;
    fetched_at: string;
    models: Array<{ id: string; name: string; pricing: Record<string, unknown> }>;
  };

  it('parses, records provenance, and carries per-model id/name/pricing', () => {
    expect(raw.source).toBe('https://openrouter.ai/api/v1/models');
    expect(Number.isNaN(Date.parse(raw.fetched_at))).toBe(false);
    expect(raw.models.length).toBeGreaterThan(100);
    for (const m of raw.models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.name).toBe('string');
      expect(m.pricing).toBeTypeOf('object');
    }
    expect(PRICING_SNAPSHOT_META).toEqual({
      source: raw.source,
      fetchedAt: raw.fetched_at,
      modelCount: raw.models.length,
    });
  });

  it('contains the deepseek entries, with per-token USD strings', () => {
    const ds = raw.models.filter((m) => m.id.includes('deepseek'));
    expect(ds.length).toBeGreaterThanOrEqual(5);
    const flash = raw.models.find((m) => m.id === 'deepseek/deepseek-v4.1-flash');
    expect(flash?.pricing).toMatchObject({
      prompt: '0.0000003',
      completion: '0.0000012',
      input_cache_read: '0.000000006',
    });
  });
});

describe('37f6c511 AC2 — snapshot-priced cost is exact', () => {
  it('deepseek/deepseek-v4.1-flash: uncached*prompt + cache_read*input_cache_read + output*completion', () => {
    // $0.30/M, cache-read $0.006/M, output $1.20/M, no cache-write price => 0
    // (1000*0.30 + 2000*0.006 + 500*0 + 300*1.20) / 1e6 = 672e-6
    expect(estimateCostUsd('deepseek/deepseek-v4.1-flash', usage)).toBeCloseTo(0.000672, 12);
  });

  it('cache-write tokens are billed at input_cache_write when the model publishes one', () => {
    // anthropic ids in the snapshot publish input_cache_write; derive expectation from the file
    const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
  ) as { models: Array<{ id: string; pricing: Record<string, string> }> };
    const m = raw.models.find((x) => x.pricing['input_cache_write'] && x.pricing['input_cache_read']);
    expect(m).toBeDefined();
    const p = m!.pricing as Record<string, string>;
    const expected =
      1_000 * Number(p['prompt']) +
      2_000 * Number(p['input_cache_read']) +
      500 * Number(p['input_cache_write']) +
      300 * Number(p['completion']);
    expect(estimateCostUsd(m!.id, usage)).toBeCloseTo(expected, 12);
  });

  it('a model with no published cache-read price bills cache hits as ordinary input', () => {
    // deepseek/deepseek-v3.2-exp publishes only prompt (2.7e-7) and completion (4.1e-7)
    // (1000*0.27 + 2000*0.27 + 0 + 300*0.41) / 1e6 = 933e-6
    expect(estimateCostUsd('deepseek/deepseek-v3.2-exp', usage)).toBeCloseTo(0.000933, 12);
  });

  it('does not reprice anything the vendor RATE_CARD already resolved', () => {
    expect(estimateCostUsd('claude_sonnet_4_6', usage)).toBeCloseTo(0.009975, 9);
    expect(estimateCostUsd('deepseek-v4-flash', usage)).toBeCloseTo(
      (1000 * 0.14 + 2000 * 0.0028 + 300 * 0.28) / 1e6,
      12
    );
    expect(estimateCostUsd('sonnet', usage)).toBeCloseTo(0.009975, 9);
  });
});

describe('37f6c511 AC3 — unknown models stay null, never 0', () => {
  it('returns null for ids absent from both RATE_CARD and the snapshot', () => {
    expect(estimateCostUsd('acme/not-a-real-model', usage)).toBeNull();
    expect(estimateCostUsd('totally-made-up-model', usage)).toBeNull();
  });

  it('returns null for OpenRouter routers priced "-1" (no fixed price)', () => {
    const raw = JSON.parse(
    readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
  ) as { models: Array<{ id: string; pricing: Record<string, string> }> };
    const router = raw.models.find((x) => x.pricing['prompt'] === '-1');
    expect(router).toBeDefined();
    expect(estimateCostUsd(router!.id, usage)).toBeNull();
  });

  it('an unknown provider model name stays null even with aliases present', () => {
    expect(PROVIDER_MODEL_ALIASES['deepseek-unknown']).toBeUndefined();
    expect(estimateCostUsd('deepseek-unknown', usage)).toBeNull();
  });
});

describe('37f6c511 AC2 — owner-directed provider alias deepseek-flash', () => {
  it('deepseek-flash resolves to deepseek/deepseek-v4.1-flash and prices exactly', () => {
    expect(PROVIDER_MODEL_ALIASES['deepseek-flash']?.target).toBe('deepseek/deepseek-v4.1-flash');
    // Hard-coded from snapshot rates: prompt 3e-7, input_cache_read 6e-9, completion 1.2e-6, no cache-write.
    // 1000*3e-7 + 2000*6e-9 + 500*0 + 300*1.2e-6 = 3e-4 + 1.2e-5 + 3.6e-4 = 6.72e-4
    expect(estimateCostUsd('deepseek-flash', usage)).toBeCloseTo(0.000672, 12);
    // Case/whitespace-insensitive, same as the OpenRouter id lookup.
    expect(estimateCostUsd(' DeepSeek-Flash ', usage)).toBeCloseTo(0.000672, 12);
  });
});
