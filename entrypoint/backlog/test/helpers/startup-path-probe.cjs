'use strict';

/**
 * startup-path-probe.cjs — the worker-thread body for the default-lane teeth
 * in `src/server.startup-path.spec.ts` (the bake-at-build design, Revision 3).
 *
 * WHY a worker (and not in-process): the claim under test is "loading the
 * built entry does NOT request ts-morph". A plain in-process probe cannot be
 * trusted — by the time a vitest worker runs a spec, the spec runner's own
 * module graph may already have resolved ts-morph, and any cache hit would
 * mask a fresh request. A `worker_threads` worker has its OWN module registry,
 * so a patch of `Module._load` installed here observes exactly what the built
 * module graph this worker loads requests — nothing vitest did first.
 *
 * WHY a real file (and not `{ eval: true }`): the built `dist/index.js`
 * carries a CJS bin entry-guard that runs
 * `pathToFileURL(realpathSync(process.argv[1]))` when `process.argv[1]` is
 * truthy. Under `eval: true`, `process.argv[1]` is the literal string
 * `[worker eval]`, which does not exist — `realpathSync` throws ENOENT and the
 * require fails. A real helper file makes `process.argv[1]` an existing path
 * (the helper itself, never `dist/index.js`), so the guard evaluates to false
 * and the module loads as a library.
 *
 * This file is loaded by Node directly (never by vitest's transformer), so the
 * `Module._load` patch below is the real CommonJS loader.
 *
 * Modes (`workerData.mode`):
 *   - `baked` (default): arm the probe, require the built dist entry, then
 *     drive the REAL baked-read startup path
 *     (`buildBacklogApigenPackage` → `readBakedIrArtifact`) and report how many
 *     ts-morph requests each phase made plus the mounted surface size.
 *   - `negative-control`: arm the probe, eagerly `require('ts-morph')`, and
 *     report the recorded requests — proving the detector actually fires.
 */
const { parentPort, workerData } = require('worker_threads');
const Module = require('module');

const originalLoad = Module._load;
const tsMorphRequests = [];
Module._load = function (request, ...rest) {
  if (request === 'ts-morph' || request.startsWith('ts-morph/')) {
    tsMorphRequests.push(request);
  }
  return originalLoad.call(this, request, ...rest);
};

(async () => {
  try {
    if (workerData.mode === 'negative-control') {
      require('ts-morph');
      parentPort.postMessage({
        mode: 'negative-control',
        tsMorphRequests: tsMorphRequests.slice(),
      });
      return;
    }

    const mod = require(workerData.distIndex);
    const afterRequire = tsMorphRequests.slice();
    const built = await mod.buildBacklogApigenPackage(() => {
      throw new Error('startup-path-probe: ctx thunk must never be called');
    }, {});
    parentPort.postMessage({
      mode: 'baked',
      afterRequire,
      afterBuild: tsMorphRequests.slice(),
      operations: built.operations.length,
      surface: built.surface.length,
    });
  } catch (err) {
    parentPort.postMessage({
      mode: workerData.mode,
      error: String(err && err.stack ? err.stack : err),
    });
  }
})();
