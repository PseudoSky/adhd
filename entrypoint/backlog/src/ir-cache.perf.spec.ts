/**
 * ir-cache.perf.spec.ts — FEAT-002's real, measured performance proof: BUG-019
 * was "backlog CLI startup is slow because it live-re-extracts on every
 * invocation" — this measures the REAL wall-clock cost with the cache
 * disabled (the BUG-019 baseline: always live-extract) vs. a warm cache HIT
 * (`APIGEN_IR_CACHE_ENABLED=1`, entry already populated), driving the REAL
 * BUILT `dist/index.js` exactly like `ir-cache.integration.spec.ts` and
 * `cli.spec.ts` do (AGENTS.md §7 — never an in-process bypass).
 *
 * Threshold is deliberately generous (HIT must be at least 3x faster than a
 * disabled/MISS run) rather than an absolute ms ceiling, so this doesn't
 * flake under CI/shared-machine load — the whole point of BUG-019 was a
 * multi-second live-extraction cost (~3.4s cold), so a real HIT (a handful of
 * `stat()` calls) should be at least an order of magnitude faster in
 * practice; 3x is a safety margin, not the expected real ratio.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

function timedRun(env: Record<string, string>, cwd: string): number {
  const start = performance.now();
  const r = spawnSync(process.execPath, [DIST_INDEX, '--help'], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const elapsed = performance.now() - start;
  expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
  return elapsed;
}

describe('FEAT-002 — real measured runtime, cache disabled vs. warm HIT', () => {
  let cwd: string;
  let cacheFile: string;

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('a warm cache HIT is measurably (>=3x) faster than a live/disabled-cache run, real numbers', () => {
    cwd = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-perf-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-perf-file-'));
    cacheFile = join(cacheDir, 'backlog-client.ir.json');

    // Baseline: caching disabled entirely — every run live-extracts. This is
    // the literal BUG-019 cost. Run it 3x, take the median to smooth out
    // process-spawn/JIT-warmup noise unrelated to the thing being measured.
    const disabledTimes = [1, 2, 3].map(() =>
      timedRun({ APIGEN_IR_CACHE_ENABLED: '0' }, cwd)
    );
    disabledTimes.sort((a, b) => a - b);
    const disabledMedian = disabledTimes[1];

    // Populate the cache (1 MISS, real extraction, real write).
    const missTime = timedRun(
      { APIGEN_IR_CACHE_ENABLED: '1', APIGEN_IR_CACHE_FILE: cacheFile },
      cwd
    );

    // Warm HIT: 3 runs against the now-populated cache, median.
    const hitTimes = [1, 2, 3].map(() =>
      timedRun(
        { APIGEN_IR_CACHE_ENABLED: '1', APIGEN_IR_CACHE_FILE: cacheFile },
        cwd
      )
    );
    hitTimes.sort((a, b) => a - b);
    const hitMedian = hitTimes[1];

    // eslint-disable-next-line no-console -- deliberate: real measured
    // numbers must be visible in test output, not just a pass/fail.
    console.log(
      `[ir-cache perf] disabled/live median: ${disabledMedian.toFixed(1)}ms ` +
        `(runs: ${disabledTimes.map((t) => t.toFixed(1)).join(', ')}ms) | ` +
        `cold MISS (cache population): ${missTime.toFixed(1)}ms | ` +
        `warm HIT median: ${hitMedian.toFixed(1)}ms ` +
        `(runs: ${hitTimes.map((t) => t.toFixed(1)).join(', ')}ms) | ` +
        `speedup: ${(disabledMedian / hitMedian).toFixed(2)}x`
    );

    expect(hitMedian).toBeLessThan(disabledMedian / 3);
  }, 120_000);
});
