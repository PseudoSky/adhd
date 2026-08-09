// scale-worker.js — generic real `worker_threads` participant for the
// MIGRATION.md §3.3 20-writer concurrency scale DoD
// (src/store/concurrency-scale.spec.ts). Same conventions as
// claim-race-worker.js/busy-retry-worker.js: plain CommonJS (loaded directly
// by `new Worker(path)`, no transform step), drives the REAL public
// `claimItem`/`createItem` exports through the BUILT `dist/index.js` against
// its OWN genuine `better-sqlite3` connection to the SAME on-disk file, and
// synchronizes via a shared `Atomics` start-gate — never a `sleep`.
//
// `workerData.mode` selects which op this worker performs:
//   'claim'  — all N workers race `claimItem` on the SAME `humanId` (the
//              contention case).
//   'create' — each worker calls `createItem` for its OWN distinct family/
//              title (the no-contention case) — `workerData.index` makes
//              each worker's item unique.
//
// Reports `elapsedMs` (wall-clock time of the op call itself, measured AFTER
// the shared gate releases) alongside the result/error, for the bounded-
// latency assertion in the spec — never used for correctness, only the
// p99 latency-envelope check.
const { parentPort, workerData } = require('node:worker_threads');

async function main() {
  const backlog = require(workerData.distIndexPath);
  const store =
    workerData.busyTimeoutMs === undefined
      ? backlog.openGraphBacklogStore(workerData.dbPath)
      : backlog.openGraphBacklogStore(workerData.dbPath, workerData.busyTimeoutMs);
  const env = backlog.buildBacklogEnv({ scope: 'project', adhdRoot: workerData.adhdRoot });
  const ctx = { store, env };

  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage({ type: 'ready' });
  Atomics.wait(gate, 0, 0);

  const startedAt = Date.now();
  try {
    let result;
    if (workerData.mode === 'claim') {
      result = await backlog.claimItem(ctx, workerData.repo, workerData.humanId, workerData.by);
    } else {
      result = await backlog.createItem(ctx, {
        family: workerData.family,
        title: `${workerData.title} number ${workerData.index}`,
        body: 'scale-test item',
        repo: workerData.repo,
      });
    }
    parentPort.postMessage({ type: 'result', result, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      code: err && err.code,
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    backlog.closeGraphBacklogStore(store);
  }
}

main();
