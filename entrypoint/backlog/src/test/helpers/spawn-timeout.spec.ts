/**
 * spawn-timeout.spec.ts — proves the shared child-spawn timeout policy in
 * `spawn-timeout.ts` (BACKLOG 345973b3): a generous 120_000ms default so a
 * load-starved host cannot turn a successful child into an `ETIMEDOUT`, and
 * an `ADHD_SPAWN_TIMEOUT_MS` override that is read at CALL time. It also pins
 * the guarded-parse contract: an empty / non-numeric / non-positive override
 * falls back to the default rather than reaching `spawnSync` as `0` ("no
 * timeout") or `NaN` (a synchronous `ERR_OUT_OF_RANGE` throw).
 *
 * Pure and subprocess-free (no `dist/index.js` spawn, no embedding model), so
 * it belongs in the default `test` lane, not the resource `e2e` lane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SPAWN_TIMEOUT_MS, spawnTimeoutMs } from './spawn-timeout.js';

describe('spawnTimeoutMs', () => {
  const prev = process.env.ADHD_SPAWN_TIMEOUT_MS;

  afterEach(() => {
    if (prev === undefined) delete process.env.ADHD_SPAWN_TIMEOUT_MS;
    else process.env.ADHD_SPAWN_TIMEOUT_MS = prev;
  });

  it('defaults to 120_000ms — at least 4x the old hardcoded 30_000ms — when ADHD_SPAWN_TIMEOUT_MS is unset', () => {
    delete process.env.ADHD_SPAWN_TIMEOUT_MS;
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(120_000);
    expect(spawnTimeoutMs()).toBe(120_000);
    expect(spawnTimeoutMs()).toBeGreaterThanOrEqual(4 * 30_000);
  });

  it('honours an explicit ADHD_SPAWN_TIMEOUT_MS override, read per call', () => {
    process.env.ADHD_SPAWN_TIMEOUT_MS = '45000';
    expect(spawnTimeoutMs()).toBe(45_000);
    // A second read reflects a changed value — proving it is not snapshotted
    // at module load (a spec must be able to set it after import).
    process.env.ADHD_SPAWN_TIMEOUT_MS = '90000';
    expect(spawnTimeoutMs()).toBe(90_000);
  });

  it('falls back to the default for an EMPTY override — an empty string is not caught by `??` and would otherwise yield 0, silently disabling the bound', () => {
    process.env.ADHD_SPAWN_TIMEOUT_MS = '';
    expect(spawnTimeoutMs()).toBe(DEFAULT_SPAWN_TIMEOUT_MS);
  });

  it('falls back to the default for a NON-NUMERIC override — NaN would throw ERR_OUT_OF_RANGE out of spawnSync({ timeout })', () => {
    process.env.ADHD_SPAWN_TIMEOUT_MS = 'not-a-number';
    expect(spawnTimeoutMs()).toBe(DEFAULT_SPAWN_TIMEOUT_MS);
  });

  it('falls back to the default for non-positive / whitespace-only overrides (0 would mean "no timeout")', () => {
    for (const bad of ['0', '0.0', '-5', '   ']) {
      process.env.ADHD_SPAWN_TIMEOUT_MS = bad;
      expect(spawnTimeoutMs(), `ADHD_SPAWN_TIMEOUT_MS=${JSON.stringify(bad)}`).toBe(DEFAULT_SPAWN_TIMEOUT_MS);
    }
  });
});
