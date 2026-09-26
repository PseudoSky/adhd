/**
 * ir-cache.perf.e2e.ts — the real, measured performance proof for the
 * BAKE-AT-BUILD design (Revision 3).
 *
 * The baseline is a FORCED FALLBACK run — `api.ir.json` renamed away so the
 * live extractor runs (the literal BUG-019 cost) — NOT `APIGEN_IR_CACHE_ENABLED=0`
 * (which, after Revision 3, no longer bypasses the baked artifact at all and
 * would therefore be a meaningless "slow" baseline whenever the artifact is
 * present). The fast arm is a normal run against the baked artifact.
 *
 * Threshold is deliberately generous (>=3x) rather than an absolute ms ceiling,
 * so this does not flake under CI/shared-machine load. In practice the baked
 * run is ~20x faster (a fresh cold start in well under a second vs. the 11-16s
 * live extraction); 3x is a safety margin.
 *
 * The renamed artifact is restored in a `finally`. Real numbers are printed,
 * not just a pass/fail.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const API_IR = join(HERE, '..', 'dist', 'api.ir.json');

function timedRun(env: Record<string, string>, cwd: string): number {
  const start = performance.now();
  const r = runIsolatedBin(DIST_INDEX, ['--help'], cwd, {
    extraEnv: env,
    timeoutMs: 120_000,
  });
  const elapsed = performance.now() - start;
  expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
  return elapsed;
}

function assertBuilt(): void {
  for (const p of [DIST_INDEX, API_IR]) {
    expect(
      (() => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      })(),
      `built artifact missing — run "nx build backlog" first: ${p}`
    ).toBe(true);
  }
}

describe('BAKE-AT-BUILD — baked `--help` vs. forced live fallback, real measured numbers', () => {
  let cwd: string;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('a baked run is measurably (>=3x) faster than a forced live/fallback run', () => {
    assertBuilt();
    cwd = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-perf-'));

    // Baseline: force the fallback (artifact renamed) with the runtime cache
    // disabled, so every run live-extracts — the literal BUG-019 cost.
    const backup = `${API_IR}.perf-backup`;
    renameSync(API_IR, backup);
    let fallbackTimes: number[];
    try {
      fallbackTimes = [1, 2, 3].map(() =>
        timedRun({ APIGEN_IR_CACHE_ENABLED: '0' }, cwd)
      );
    } finally {
      renameSync(backup, API_IR);
    }
    fallbackTimes.sort((a, b) => a - b);
    const fallbackMedian = fallbackTimes[1] as number;

    // Fast arm: the baked artifact, default settings.
    const bakedTimes = [1, 2, 3].map(() => timedRun({}, cwd));
    bakedTimes.sort((a, b) => a - b);
    const bakedMedian = bakedTimes[1] as number;

    // eslint-disable-next-line no-console -- deliberate: real measured numbers
    // must be visible in test output, not just a pass/fail.
    console.log(
      `[ir-cache perf] forced fallback/live median: ${fallbackMedian.toFixed(1)}ms ` +
        `(runs: ${fallbackTimes.map((t) => t.toFixed(1)).join(', ')}ms) | ` +
        `baked median: ${bakedMedian.toFixed(1)}ms ` +
        `(runs: ${bakedTimes.map((t) => t.toFixed(1)).join(', ')}ms) | ` +
        `speedup: ${(fallbackMedian / bakedMedian).toFixed(2)}x`
    );

    expect(bakedMedian).toBeLessThan(fallbackMedian / 3);
  }, 300_000);
});
