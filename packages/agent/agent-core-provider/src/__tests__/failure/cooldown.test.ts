/** Ticket 5e72d493 (PF-1) — covers 5e72d493 AC8. */
import { describe, it, expect } from 'vitest';
import {
  computeCooldownMs,
  cooldownBaseMs,
  cooldownCeilingMs,
  fullJitterBackoffMs,
  seededRng,
  COOLDOWN_MAX_MS,
} from '../../failure/index.js';

describe('5e72d493 AC8 - cooldown math (seeded RNG)', () => {
  it('class bases: rate_limited max(RA,5s), transient 15s, credential classes 60s, unknown 60s, non-trip classes none', () => {
    expect(cooldownBaseMs('rate_limited')).toBe(5_000);
    expect(cooldownBaseMs('rate_limited', 2_000)).toBe(5_000);
    expect(cooldownBaseMs('rate_limited', 90_000)).toBe(90_000);
    for (const c of ['overloaded', 'unavailable', 'timeout'] as const) expect(cooldownBaseMs(c)).toBe(15_000);
    for (const c of ['billing', 'auth', 'permission', 'unknown'] as const) expect(cooldownBaseMs(c)).toBe(60_000);
    for (const c of ['invalid_request', 'context_length', 'content_policy', 'cancelled'] as const) expect(cooldownBaseMs(c)).toBeUndefined();
  });

  it('ceiling is base x 2^(n-1) capped at 15 minutes', () => {
    expect(COOLDOWN_MAX_MS).toBe(900_000);
    expect([1, 2, 3, 4, 5].map((n) => cooldownCeilingMs(15_000, n))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(cooldownCeilingMs(15_000, 7)).toBe(900_000);
    expect(cooldownCeilingMs(60_000, 5)).toBe(900_000);
    expect(cooldownCeilingMs(60_000, 10_000)).toBe(900_000);
    expect(cooldownCeilingMs(60_000, 0)).toBe(60_000);
    expect(cooldownCeilingMs(60_000, NaN)).toBe(60_000);
  });

  it('with the RNG at its maximum the cooldown reaches the ceiling; at its minimum it is exactly the floor', () => {
    const hi = () => 0.999999999;
    const lo = () => 0;
    for (const n of [1, 2, 3, 6, 9]) {
      const ceiling = cooldownCeilingMs(15_000, n);
      expect(computeCooldownMs({ class: 'overloaded', consecutiveTrips: n, rng: hi })).toBe(ceiling);
      expect(computeCooldownMs({ class: 'overloaded', consecutiveTrips: n, rng: lo })).toBe(15_000);
    }
  });

  it('the floor is never undercut by jitter and the cap is never exceeded (seeded sweep)', () => {
    const rng = seededRng(42);
    for (const cls of ['rate_limited', 'overloaded', 'billing', 'unknown'] as const) {
      for (let n = 1; n <= 12; n++) {
        for (let i = 0; i < 50; i++) {
          const base = cooldownBaseMs(cls, 8_000) ?? NaN;
          const ms = computeCooldownMs({ class: cls, consecutiveTrips: n, retryAfterMs: 8_000, rng }) ?? NaN;
          expect(ms).toBeGreaterThanOrEqual(Math.min(base, COOLDOWN_MAX_MS));
          expect(ms).toBeLessThanOrEqual(cooldownCeilingMs(base, n));
          expect(ms).toBeLessThanOrEqual(COOLDOWN_MAX_MS);
        }
      }
    }
  });

  it('the first trip has no growth part: exactly the base regardless of RNG', () => {
    expect(computeCooldownMs({ class: 'billing', consecutiveTrips: 1, rng: seededRng(1) })).toBe(60_000);
    expect(computeCooldownMs({ class: 'billing', consecutiveTrips: 1, rng: () => 0.9 })).toBe(60_000);
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const run = (s: number) => computeCooldownMs({ class: 'timeout', consecutiveTrips: 4, rng: seededRng(s) });
    expect(run(7)).toBe(run(7));
    expect(new Set([1, 2, 3, 4, 5, 6].map(run)).size).toBeGreaterThan(1);
  });

  it('tripwire overrides: baseMs replaces the class base (not a rate_limited hint), maxMs lowers the cap', () => {
    expect(computeCooldownMs({ class: 'billing', consecutiveTrips: 1, baseMs: 1_000, rng: () => 0.5 })).toBe(1_000);
    expect(computeCooldownMs({ class: 'rate_limited', consecutiveTrips: 1, baseMs: 1_000, retryAfterMs: 20_000, rng: () => 0.5 })).toBe(20_000);
    expect(computeCooldownMs({ class: 'billing', consecutiveTrips: 9, maxMs: 120_000, rng: () => 0.99999999 })).toBe(120_000);
    expect(computeCooldownMs({ class: 'invalid_request', consecutiveTrips: 3 })).toBeUndefined();
  });

  it('full-jitter retry backoff stays within [0, min(maxTimeout, minTimeout*factor^n)]', () => {
    const o = { minTimeout: 500, maxTimeout: 8_000, factor: 2 };
    const rng = seededRng(9);
    for (let n = 0; n < 8; n++) {
      for (let i = 0; i < 25; i++) {
        const ms = fullJitterBackoffMs(n, o, rng);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(Math.min(8_000, 500 * 2 ** n));
      }
    }
    expect(fullJitterBackoffMs(10, o, () => 0.9999999)).toBe(8_000);
  });
});
