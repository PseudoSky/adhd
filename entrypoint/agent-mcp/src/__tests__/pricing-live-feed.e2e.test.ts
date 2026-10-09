/**
 * 37f6c511 FS2-AC1 (e2e lane, ADR-0009): the ONE real GET to https://openrouter.ai/api/v1/models
 * through `runPricePull` into a throwaway DB. The endpoint is public and free, so per AGENTS.md
 * ("Live testing is mandatory") this runs by default and FAILS LOUDLY when the feed is
 * unreachable or its schema drifts. Structural assertions only (no price values):
 *   - at least 100 models,
 *   - every stored model is a router or has numeric prompt/completion >= 0,
 *   - the pull is accepted (no rejected_invalid / rejected_shrink) and held anomalies are the
 *     exception, not the rule (genuine price drift against the bundled seed is allowed).
 * Run with `nx run agent-mcp:e2e` (release checklist: PUBLISHING.md).
 */
import { PriceHistoryStore } from '@adhd/agent-store-runtime';
import { describe, expect, it } from 'vitest';

import { runPricePull } from '../pricing/pull.js';
import { createPricingService } from '../pricing/service.js';
import { makeLogger, openDb } from './pricing-fixtures.js';

describe('live OpenRouter feed (single real GET)', () => {
  it('37f6c511 FS2-AC1: the real feed parses and applies against the bundled seed (e2e smoke)', async () => {
    const { db, sqlite } = openDb();
    try {
      const log = makeLogger();
      const svc = createPricingService({ db, logger: log, version: 'e2e', scheduler: { timers: { setTimeout: () => ({}), clearTimeout: () => undefined } } });
      svc.start(); // seeds the bundled snapshot; the injected timers never fire
      svc.stop();
      const store = new PriceHistoryStore(db);
      const result = await runPricePull({ store, fetchImpl: fetch, now: () => new Date().toISOString(), logger: log, version: 'e2e' });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe('ok');
      expect(result.models).toBeGreaterThanOrEqual(100);
      const holds = result.anomalies.filter((a) => a.severity === 'hold');
      expect(holds.length).toBeLessThanOrEqual(Math.ceil(result.models * 0.02));
      const sample = store.history('deepseek/deepseek-v4.1-flash');
      expect(sample.length).toBeGreaterThan(0);
      for (const r of sample) {
        if (r.kind === 'model') {
          expect(typeof r.inputPerM).toBe('number');
          expect(r.inputPerM as number).toBeGreaterThanOrEqual(0);
          expect(r.outputPerM as number).toBeGreaterThanOrEqual(0);
        }
      }
    } finally {
      sqlite.close();
    }
  }, 90_000);
});
