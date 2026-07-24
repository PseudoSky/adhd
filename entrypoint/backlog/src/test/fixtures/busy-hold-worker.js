// busy-hold-worker.js — real `worker_threads` participant simulating "another
// concurrent CLI writer" for the SQLITE_BUSY bounded-retry proof
// (src/store/busy-retry.spec.ts, DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001).
//
// Deliberately PLAIN CommonJS, same convention as claim-race-worker.js.
// Opens its OWN real `better-sqlite3` connection to the SAME on-disk file,
// acquires the write lock via a raw `BEGIN IMMEDIATE`, then PARKS on a real
// barrier (`Atomics.wait(startGate, 0, 0)`, no timeout) until the main thread
// confirms the OTHER worker (the retrying side) is ALSO parked and ready —
// only THEN does the fixed `holdMs` hold-timer start. This is load-bearing:
// this worker's own startup (`new Database`, WAL/pragma setup) is fast, but
// the retry-worker's startup (`require(distIndexPath)` — the whole built
// bundle — plus opening its own connection) is NOT, so starting the hold
// countdown at lock-acquisition time (before confirming the other side is
// ready) let the lock free itself before the retry-worker ever got a chance
// to observe contention at all — a real bug in this test's first draft,
// caught by writing the arithmetic sanity check into the spec file and then
// noticing the "released" message arriving before the retry-worker's "ready".
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');

function main() {
  const db = new Database(workerData.dbPath);
  db.pragma('journal_mode = WAL');
  // Long busy_timeout for THIS connection's own lock acquisition — it must
  // never itself fail to acquire the (uncontended, at start) write lock.
  db.pragma('busy_timeout = 30000');

  db.prepare('BEGIN IMMEDIATE').run();
  parentPort.postMessage({ type: 'holding' });

  const startGate = new Int32Array(workerData.startGate);
  Atomics.wait(startGate, 0, 0); // released by main only once BOTH workers are ready

  // Fixed hold duration, timed from the SAME instant the retry-worker is
  // released — deterministic regardless of either worker's startup latency.
  // `withImmediateRetry`'s default budget (5 attempts, 20/40/80/160ms
  // backoff + up to 5x the caller's own busy_timeout) is arithmetically
  // sized (see busy-retry.spec.ts) to comfortably exceed this.
  const holdTimer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(holdTimer, 0, 0, workerData.holdMs);

  db.prepare('COMMIT').run();
  db.close();
  parentPort.postMessage({ type: 'released' });
}

main();
