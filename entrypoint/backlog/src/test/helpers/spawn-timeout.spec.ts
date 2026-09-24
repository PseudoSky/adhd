/**
 * spawn-timeout.spec.ts — proves the shared child-spawn timeout policy in
 * `spawn-timeout.ts` (BACKLOG 345973b3): a generous 120_000ms default so a
 * load-starved host cannot turn a successful child into an `ETIMEDOUT`, and
 * an `ADHD_SPAWN_TIMEOUT_MS` override that is read at CALL time.
 *
 * Pure and subprocess-free (no `dist/index.js` spawn, no embedding model), so
 * it belongs in the default `test` lane, not the resource `e2e` lane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTimeoutMs } from './spawn-timeout.js';

describe('spawnTimeoutMs', () => {
  const prev = process.env.ADHD_SPAWN_TIMEOUT_MS;

  afterEach(() => {
    if (prev === undefined) delete process.env.ADHD_SPAWN_TIMEOUT_MS;
    else process.env.ADHD_SPAWN_TIMEOUT_MS = prev;
  });

  it('defaults to 120_000ms — at least 4x the old hardcoded 30_000ms — when ADHD_SPAWN_TIMEOUT_MS is unset', () => {
    delete process.env.ADHD_SPAWN_TIMEOUT_MS;
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
});
