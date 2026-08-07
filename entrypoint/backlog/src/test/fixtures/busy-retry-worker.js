// busy-retry-worker.js — real `worker_threads` participant that calls the
// REAL public `claimItem` export (through the BUILT `dist/index.js`, a real
// consumer path — same convention as claim-race-worker.js) against a store
// opened with a SHORT `busyTimeoutMs`, while `busy-hold-worker.js` holds the
// write lock on a second real connection to the SAME on-disk file
// (src/store/busy-retry.spec.ts, DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001).
//
// No sleep-based synchronization here: this worker posts `{type:'ready'}`
// and blocks on `Atomics.wait(gate,...)` exactly like claim-race-worker.js,
// so the main thread starts it at a moment IT controls (after confirming the
// hold-worker is genuinely holding the lock).
const { parentPort, workerData } = require('node:worker_threads');

async function main() {
  const backlog = require(workerData.distIndexPath);
  const store = backlog.openGraphBacklogStore(workerData.dbPath, workerData.busyTimeoutMs);
  const env = backlog.buildBacklogEnv({ scope: 'project', adhdRoot: workerData.adhdRoot });
  const ctx = { store, env };

  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage({ type: 'ready' });
  Atomics.wait(gate, 0, 0);

  try {
    const result = await backlog.claimItem(ctx, workerData.repo, workerData.humanId, workerData.by);
    parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err), code: err && err.code });
  } finally {
    backlog.closeGraphBacklogStore(store);
  }
}

main();
