/**
 * tier-timeout-setup — a vitest setup file that enforces the per-test timeout of a test file's tier (T37.AC1, G7).
 *
 * Runs once per test file, before its tests. It resolves the file's tier (the header `tier:` line; a legacy file with
 * no header is `inferred` and keeps the project's configured timeout, because G9 baselines those files and a cap
 * applied to them would fail tests nobody has classified) and lowers the timeout to the tier's cap when the project's
 * configured `testTimeout` is higher. A cap never raises a timeout: a test cannot buy time by being declared tier P.
 * A test that sets its own explicit timeout (`it(name, fn, ms)`) is outside this file's reach.
 *
 * Attached to every vitest project by `tools/vite-plugins/test-metrics.mjs` (`tierTimeoutConfig`). `ADHD_TIER_TIMEOUT=0`
 * turns it off.
 */
import { expect, vi } from 'vitest';
import { resolveTier, timeoutForTier } from './tiers.mjs';

/** ADHD_TIER_TIMEOUT_CAPS (a JSON object such as {"S":200}) replaces the caps; it exists so a spec can run a real vitest in milliseconds. */
function capFor(tier) {
  try {
    const o = process.env.ADHD_TIER_TIMEOUT_CAPS ? JSON.parse(process.env.ADHD_TIER_TIMEOUT_CAPS) : null;
    if (o && typeof o[tier] === 'number') return o[tier];
  } catch {
    // an unparseable override is ignored; the repository's caps apply
  }
  return timeoutForTier(tier);
}

const testPath = expect.getState().testPath;
if (testPath && process.env.ADHD_TIER_TIMEOUT !== '0') {
  const { tier, tierSource } = resolveTier(testPath);
  const cap = tierSource === 'header' ? capFor(tier) : null;
  // vitest keeps the resolved project config on the worker state; there is no public getter for testTimeout.
  const configured = globalThis.__vitest_worker__?.config?.testTimeout;
  if (cap !== null && typeof configured === 'number' && configured > cap) vi.setConfig({ testTimeout: cap });
}
