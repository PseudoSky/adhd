/**
 * tiers — the per-test duration budgets of each test tier, and how a test file's tier is resolved.
 *
 * The numbers are the repository's own, from docs/standards/testing.md section 1 (tier mapping), which adopts
 * docs/testing/STRATEGY.md section 2.1: tier S 100 ms p95 with any test over 1 s a split-or-fix candidate, tier P 10 s,
 * tier H 2 min, tier X metered (no duration budget). `tiers.spec.mjs` fails when the standard stops stating them.
 *
 * Tier resolution: the `tier:` line of the file header (`check-test-headers.mjs`, `tierOf`); a file with no valid header
 * (the legacy files G9 baselines) falls back to the file-name rule of testing.md section 1: `*.e2e.*` is tier P and every
 * other test file is tier S. The record carries `tierSource` so a reader can tell a declared tier from an inferred one.
 */
import { readFileSync } from 'node:fs';
import { tierOf } from '../executors/wiring/check-test-headers.mjs';

/** Per-test duration budgets in milliseconds. `p95Ms` bounds a test's own p95; `splitOrFixMs` bounds any single run. */
export const TIER_BUDGETS = Object.freeze({
  S: Object.freeze({ p95Ms: 100, splitOrFixMs: 1000 }),
  P: Object.freeze({ p95Ms: 10_000, splitOrFixMs: null }),
  H: Object.freeze({ p95Ms: 120_000, splitOrFixMs: null }),
  X: Object.freeze({ p95Ms: null, splitOrFixMs: null }),
});

/** The tiers in report order. */
export const TIER_ORDER = Object.freeze(['S', 'P', 'H', 'X']);

/** The tier a file name implies when its header declares none (testing.md section 1). */
export function inferTierFromName(file) {
  return /\.e2e\.[^/]*$/.test(file) || /\.e2e\.test\./.test(file) ? 'P' : 'S';
}

/**
 * Resolve a test file's tier.
 * @param {string} absFile absolute path of the test file
 * @param {(file: string) => string} [read] source reader, injectable for tests
 * @returns {{ tier: 'S'|'P'|'H'|'X', tierSource: 'header'|'inferred' }}
 */
export function resolveTier(absFile, read = (f) => readFileSync(f, 'utf8')) {
  try {
    const declared = tierOf(read(absFile));
    if (declared) return { tier: declared, tierSource: 'header' };
  } catch {
    // an unreadable file falls through to the name rule
  }
  return { tier: inferTierFromName(absFile), tierSource: 'inferred' };
}
