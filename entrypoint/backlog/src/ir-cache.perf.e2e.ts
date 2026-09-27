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
 * ISOLATION (2026-09-26): the bin runs from a PRIVATE copy of `dist/`
 * (`createIsolatedDist`, under the gitignored `tmp/`), so the `api.ir.json`
 * renamed away for the baseline is this suite's OWN. It previously renamed the
 * SHARED in-tree `entrypoint/backlog/dist/api.ir.json`, which a concurrent
 * `vite build` (`emptyOutDir: true`) or nx directory-output cache restore
 * deletes wholesale — the backup could vanish and the `finally` restore throw
 * `ENOENT` (the red-gate defect). The private copy is removed in `afterEach`.
 * Real numbers are printed, not just a pass/fail.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';
import {
  createIsolatedDist,
  type IsolatedDist,
} from './test/helpers/isolated-dist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIST = join(HERE, '..', 'dist');
const SHARED_INDEX = join(SHARED_DIST, 'index.js');
const SHARED_API_IR = join(SHARED_DIST, 'api.ir.json');

function timedRun(
  binPath: string,
  env: Record<string, string>,
  cwd: string
): number {
  const start = performance.now();
  const r = runIsolatedBin(binPath, ['--help'], cwd, {
    extraEnv: env,
    timeoutMs: 120_000,
  });
  const elapsed = performance.now() - start;
  expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
  return elapsed;
}

function assertBuilt(): void {
  for (const p of [SHARED_INDEX, SHARED_API_IR]) {
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
  let iso: IsolatedDist | undefined;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    iso?.cleanup();
    iso = undefined;
  });

  it('a baked run is measurably (>=3x) faster than a forced live/fallback run', () => {
    assertBuilt();
    cwd = mkdtempSync(join(tmpdir(), 'apigen-ir-cache-perf-'));
    iso = createIsolatedDist(SHARED_DIST, 'perf');
    const binPath = iso.indexPath;

    // Baseline: force the fallback (artifact renamed) with the runtime cache
    // disabled, so every run live-extracts — the literal BUG-019 cost.
    const backup = `${iso.apiIrPath}.perf-backup`;
    renameSync(iso.apiIrPath, backup);
    let fallbackTimes: number[];
    try {
      fallbackTimes = [1, 2, 3].map(() =>
        timedRun(binPath, { APIGEN_IR_CACHE_ENABLED: '0' }, cwd)
      );
    } finally {
      renameSync(backup, iso.apiIrPath);
    }
    fallbackTimes.sort((a, b) => a - b);
    const fallbackMedian = fallbackTimes[1] as number;

    // Fast arm: the baked artifact, default settings.
    const bakedTimes = [1, 2, 3].map(() => timedRun(binPath, {}, cwd));
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
