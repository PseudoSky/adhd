// scale-worker.js — generic real `worker_threads` participant for the
// MIGRATION.md §3.3 20-writer concurrency scale DoD
// (src/store/concurrency-scale.spec.ts). Same conventions as
// claim-race-worker.js/busy-retry-worker.js: plain CommonJS (loaded directly
// by `new Worker(path)`, no transform step), drives the REAL public
// `claimItem`/`createItem` exports through the BUILT `dist/index.js` against
// its OWN genuine turso store-adapter connection to the SAME on-disk file, and
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
  // The store OPEN is deliberately NOT run under `busyTimeoutMs`. That knob
  // exists to squeeze the operation under test (the contended claim, AFTER
  // the gate); applying it to the open too would also squeeze
  // `applySchema()`'s DDL, which no test here is trying to stress and which
  // happens BEFORE the barrier, outside the measured race entirely. With 20
  // workers opening at once on a loaded box, a tiny value made `applySchema`
  // bounce with "database is locked" during startup — a pure artifact of the
  // fixture that presented as a failure of the claim path.
  //
  // So: open at the default busy_timeout, then narrow it to the test's value
  // once the schema is in place and before parking on the gate.
  const store = await backlog.openGraphBacklogStore(workerData.dbPath);
  if (workerData.busyTimeoutMs !== undefined) {
    await store.adapter.pragmaSet('busy_timeout', workerData.busyTimeoutMs);
  }
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
      // The stack is what distinguishes a retry-budget exhaustion inside
      // `withImmediateRetry` from a bounce on an UNRETRIED path (the reads in
      // `requireItem`, or `writeAuditEvent`'s post-commit event write). Without
      // it, a failure here is indistinguishable from this test's own timing
      // margin — which is exactly how the unretried paths stayed invisible.
      stack: err instanceof Error ? err.stack : undefined,
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    await backlog.closeGraphBacklogStore(store);
  }
}

// A failure BEFORE the gate (store open, schema apply, env build) used to
// escape as an unhandled rejection: the worker never posted `ready`, the
// harness's `ready` promise had no reject path, and the whole spec died on a
// 60s timeout with the real cause detached in vitest's "Unhandled Rejection"
// section. Reporting it as a normal `startup-error` message keeps every
// failure attributable to the thing that actually failed.
main().catch((err) => {
  parentPort.postMessage({
    type: 'startup-error',
    message: err instanceof Error ? err.message : String(err),
    code: err && err.code,
    stack: err instanceof Error ? err.stack : undefined,
  });
});
