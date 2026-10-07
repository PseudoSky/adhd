/**
 * Trip cooldown and retry-backoff math (docs/plan/provider-failure/SPEC.md §2, §9.3). Pure.
 *
 * cooldown = classBase x 2^(consecutiveTrips-1), capped, with full jitter on the
 * GROWTH part only: the result is always in `[floor, ceiling]` where
 * `floor = classBase` (never undercut by jitter) and
 * `ceiling = min(cap, classBase x 2^(n-1))`.
 */
import type { ProviderFailureClass } from '@adhd/agent-base-types';

/** Default cooldown cap: 15 minutes. */
export const COOLDOWN_MAX_MS = 15 * 60_000;

/** Random source in `[0,1)`; injectable for determinism. */
export type Rng = () => number;

/** Seeded PRNG (mulberry32) for deterministic tests and replay. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-class cooldown base; `undefined` for classes that never open a trip
 * (`invalid_request`, `context_length`, `content_policy`, `cancelled`).
 */
export function cooldownBaseMs(
  cls: ProviderFailureClass,
  retryAfterMs?: number,
  overrideBaseMs?: number
): number | undefined {
  let base: number | undefined;
  switch (cls) {
    case 'rate_limited':
      base = Math.max(retryAfterMs ?? 0, 5_000);
      break;
    case 'overloaded':
    case 'unavailable':
    case 'timeout':
      base = 15_000;
      break;
    case 'billing':
    case 'auth':
    case 'permission':
    case 'unknown':
      base = 60_000;
      break;
    default:
      return undefined;
  }
  if (overrideBaseMs !== undefined && overrideBaseMs > 0) {
    // A provider hint (rate_limited) is a floor an operator override may not undercut.
    return cls === 'rate_limited' ? Math.max(overrideBaseMs, retryAfterMs ?? 0) : overrideBaseMs;
  }
  return base;
}

export interface CooldownInput {
  class: ProviderFailureClass;
  /** 1 on the first trip; grows on closed->open and half_open->open edges. */
  consecutiveTrips: number;
  retryAfterMs?: number;
  /** `tripwire.baseMs` override. */
  baseMs?: number;
  /** `tripwire.maxMs` override. Default {@link COOLDOWN_MAX_MS}. */
  maxMs?: number;
  rng?: Rng;
}

/** Undefined for classes that never trip. Deterministic for a given `rng`. */
export function computeCooldownMs(input: CooldownInput): number | undefined {
  const base = cooldownBaseMs(input.class, input.retryAfterMs, input.baseMs);
  if (base === undefined) return undefined;
  const cap = input.maxMs ?? COOLDOWN_MAX_MS;
  const floor = Math.min(base, cap);
  const ceiling = cooldownCeilingMs(base, input.consecutiveTrips, cap);
  const r = (input.rng ?? Math.random)();
  return Math.round(floor + Math.min(Math.max(r, 0), 1) * (ceiling - floor));
}

/** `min(cap, base x 2^(n-1))`; the jitter-free upper bound of the cooldown. */
export function cooldownCeilingMs(base: number, consecutiveTrips: number, cap: number = COOLDOWN_MAX_MS): number {
  const n = Number.isFinite(consecutiveTrips) ? Math.max(1, Math.floor(consecutiveTrips)) : 1;
  return Math.min(cap, base * 2 ** Math.min(n - 1, 40));
}

/** Full Jitter retry backoff: `random(0, min(maxTimeout, minTimeout x factor^n))`, `n` zero-based. */
export function fullJitterBackoffMs(
  attempt: number,
  opts: { minTimeout: number; maxTimeout: number; factor: number },
  rng: Rng = Math.random
): number {
  const n = Math.max(0, Math.floor(attempt));
  const cap = Math.min(opts.maxTimeout, opts.minTimeout * opts.factor ** Math.min(n, 40));
  return Math.round(rng() * cap);
}
