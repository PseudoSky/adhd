// claim-race-worker.js — real `worker_threads` participant for the CAS
// claim-race proof (src/store/claim.spec.ts, SPEC.md §7 DoD clause 1).
//
// Deliberately PLAIN CommonJS (no TypeScript) so `new Worker(path)` can load
// it directly with zero transform step — the worker requires the BUILT
// `dist/index.js` (a real consumer path, not a bypass) and drives the real
// public `claimItem` export through a real second `better-sqlite3`
// connection to the SAME on-disk file the main thread's connection uses.
//
// Barrier protocol (never a `sleep`): the main thread passes a
// `SharedArrayBuffer`-backed `Int32Array` via `workerData.gate`. Each worker
// posts a `{ type: 'ready' }` message, then blocks on `Atomics.wait(gate, 0, 0)`
// — a real, deterministic, zero-CPU wait. Once the main thread has heard
// `ready` from BOTH workers, it flips `gate[0]` to `1` and calls
// `Atomics.notify(gate, 0)`, releasing both workers at (as close to) the same
// instant the OS scheduler allows — this is what makes the two `claimItem`
// calls genuinely overlap instead of running sequentially by construction.
const { parentPort, workerData } = require('node:worker_threads');

async function main() {
  const backlog = require(workerData.distIndexPath);
  const store = backlog.openGraphBacklogStore(workerData.dbPath);
  const env = backlog.buildBacklogEnv({ scope: 'project', adhdRoot: workerData.adhdRoot });
  const ctx = { store, env };

  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage({ type: 'ready' });
  Atomics.wait(gate, 0, 0);

  try {
    const result = await backlog.claimItem(ctx, workerData.repo, workerData.humanId, workerData.by, workerData.opts ?? {});
    parentPort.postMessage({ type: 'result', result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    backlog.closeGraphBacklogStore(store);
  }
}

main();
