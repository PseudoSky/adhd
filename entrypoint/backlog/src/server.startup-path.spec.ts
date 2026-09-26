/**
 * server.startup-path.spec.ts — the DEFAULT-LANE teeth for the bake-at-build
 * design (Revision 3), sibling of the resource-consuming
 * `server.startup-path.e2e.ts` (which its own header calls "the PRIMARY
 * TEETH").
 *
 * The e2e is the authoritative end-to-end proof: a real spawn of the built
 * `dist/index.js` with a `--require` ts-morph probe. But `.e2e.ts` files are
 * excluded from the default `test` target (`vite.config.ts`), so on their own
 * the branch's central claim ("startup never loads ts-morph") would be
 * automated only by a lane CI never runs. This file closes that gap WITHOUT a
 * subprocess: it loads the built module graph in a fresh WORKER THREAD (its
 * own module registry — see `test/helpers/startup-path-probe.cjs`), with
 * `Module._load` patched to record ts-morph, then drives the REAL baked-read
 * startup path (`buildBacklogApigenPackage` → `readBakedIrArtifact`) and
 * asserts it requested ts-morph ZERO times while mounting a non-empty surface.
 *
 * Teeth: add a static extractor import to `server.ts`/`cli.ts`, or break
 * `readBakedIrArtifact` so the live fallback always runs, and the baked case
 * goes RED (`afterRequire`/`afterBuild` would contain `ts-morph`). The
 * negative-control case proves the detector fires at all — a probe that could
 * never fire would make the positive assertion meaningless.
 *
 * Still e2e-only (inventoried below): the artifact-renamed fallback control
 * and the mutate-`api.d.ts` stale control both mutate the SHARED built `dist`,
 * which the resource lane does under a real spawn with `finally`-restore.
 *
 * Resource lane: cpu, io — loads the built dist graph in a worker thread; the
 * sibling `.e2e.ts` is what actually spawns a process.
 */
import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');
const API_IR = join(HERE, '..', 'dist', 'api.ir.json');
const PROBE = join(HERE, 'test', 'helpers', 'startup-path-probe.cjs');

/** Bounded deadline so a wedged worker fails loudly instead of hanging. */
const PROBE_TIMEOUT_MS = 25_000;

interface ProbeMessage {
  mode?: string;
  afterRequire?: string[];
  afterBuild?: string[];
  operations?: number;
  surface?: number;
  tsMorphRequests?: string[];
  error?: string;
}

/** Runs the worker probe and resolves with its single report message. */
function runProbe(workerData: Record<string, unknown>): Promise<ProbeMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE, { workerData });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(
        new Error(
          `startup-path-probe timed out after ${PROBE_TIMEOUT_MS}ms (workerData=${JSON.stringify(workerData)})`
        )
      );
    }, PROBE_TIMEOUT_MS);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    worker.on('message', (msg: ProbeMessage) =>
      finish(() => {
        void worker.terminate();
        resolve(msg);
      })
    );
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      finish(() =>
        reject(new Error(`startup-path-probe worker exited with code ${code}`))
      );
    });
  });
}

/** Fail LOUDLY (never silently skip) if the built artifacts are missing. */
function assertBuilt(): void {
  for (const p of [DIST_INDEX, API_IR]) {
    expect(
      existsSync(p) && statSync(p).isFile(),
      `built artifact missing — run "nx build backlog" first: ${p}`
    ).toBe(true);
  }
}

describe('server startup path — baked artifact loads no ts-morph (default-lane teeth)', () => {
  it('BAKED: building the apigen package from the built dist requests ts-morph ZERO times, mounting a non-empty surface', async () => {
    assertBuilt();
    const msg = await runProbe({ mode: 'baked', distIndex: DIST_INDEX });

    expect(msg.error, msg.error).toBeUndefined();
    // Importing the built entry must not request ts-morph.
    expect(msg.afterRequire).toEqual([]);
    // Driving the REAL baked-read path must not either.
    expect(msg.afterBuild).toEqual([]);
    // ...and it must have actually mounted something (a no-op would pass the
    // ts-morph assertions trivially).
    expect(msg.operations ?? 0).toBeGreaterThan(0);
    expect(msg.surface ?? 0).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the probe records an eager ts-morph require (the detector is live)', async () => {
    const msg = await runProbe({ mode: 'negative-control' });
    expect(msg.error, msg.error).toBeUndefined();
    expect(msg.tsMorphRequests).toContain('ts-morph');
  });

  it.todo('e2e: with api.ir.json renamed away, a real spawn of dist/index.js DOES load ts-morph (fallback control)');
  it.todo('e2e: mutating a byte of dist/api.d.ts makes a real spawn load ts-morph (never-serve-stale control)');
});
