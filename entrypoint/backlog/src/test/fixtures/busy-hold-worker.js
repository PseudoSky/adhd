// busy-hold-worker.js — real `worker_threads` participant simulating "another
// concurrent CLI writer" for the bounded-retry proof against a held write lock
// (src/store/busy-retry.spec.ts, DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001).
//
// Deliberately PLAIN CommonJS, same convention as claim-race-worker.js.
// Opens its OWN real turso store-adapter connection
// (`createTursoAdapter` from `@adhd/sox-store-adapter` — the SAME substrate
// the store itself uses) to the SAME on-disk file, acquires the write lock
// via `adapter.transaction(fn, { mode: 'immediate' })` (BEGIN IMMEDIATE),
// then PARKS INSIDE the transaction callback on a real barrier
// (`Atomics.wait(startGate, 0, 0)`, no timeout) until the main thread
// confirms the OTHER worker (the retrying side) is ALSO parked and ready —
// only THEN does the fixed `holdMs` hold-timer start. This is load-bearing:
// this worker's own startup (`createTursoAdapter` — the adapter's open-time
// integrity/FTS ceremony) is fast, but the retry-worker's startup
// (`require(distIndexPath)` — the whole built bundle — plus opening its own
// connection) is NOT, so starting the hold countdown at lock-acquisition
// time (before confirming the other side is ready) let the lock free itself
// before the retry-worker ever got a chance to observe contention at all —
// a real bug in this test's first draft, caught by writing the arithmetic
// sanity check into the spec file and then noticing the "released" message
// arriving before the retry-worker's "ready".
//
// LOCK-HOLD MECHANISM: parking goes INSIDE the transaction callback, not
// around it, because the adapter's internal BEGIN retry loop
// (`_runTransaction`, turso-adapter.js:614-650) only wraps the BEGIN
// statement itself — once the callback runs, `BEGIN IMMEDIATE` has genuinely
// landed on the connection and the callback is invoked exactly once with NO
// retry interference, so `Atomics.wait` inside it holds the write lock for
// as long as the park lasts. Returning from the callback triggers the
// adapter's COMMIT; `adapter.close()` then releases the file handle. The
// barrier protocol is unchanged from the raw-SQLite original: post
// 'holding' only after the lock is genuinely acquired (the callback only
// runs after BEGIN succeeded), hold timer starts from gate release, post
// 'released' after COMMIT + close.
const { parentPort, workerData } = require('node:worker_threads');

async function main() {
  // Dynamic import of the adapter's ESM dist from plain CommonJS — the
  // fixture stays transform-free (loaded directly by `new Worker(path)`).
  const { createTursoAdapter } = await import('@adhd/sox-store-adapter');
  const adapter = await createTursoAdapter({ dbPath: workerData.dbPath });
  // Long busy_timeout for THIS connection's own lock acquisition — it must
  // never itself fail to acquire the (uncontended, at start) write lock.
  await adapter.pragmaSet('busy_timeout', 30000);

  // BEGIN IMMEDIATE via the store-adapter's canonical transaction surface.
  // The callback runs only after BEGIN has genuinely succeeded, so posting
  // 'holding' here means the write lock IS held from this instant.
  const commit = adapter.transaction(
    async () => {
      parentPort.postMessage({ type: 'holding' });

      const startGate = new Int32Array(workerData.startGate);
      Atomics.wait(startGate, 0, 0); // released by main only once BOTH workers are ready

      // Fixed hold duration, timed from the SAME instant the retry-worker is
      // released — deterministic regardless of either worker's startup
      // latency. `withImmediateRetry`'s default budget (5 attempts, 20/40/80/160ms
      // backoff + up to 5x the caller's own busy_timeout) is arithmetically
      // sized (see busy-retry.spec.ts) to comfortably exceed this.
      const holdTimer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(holdTimer, 0, 0, workerData.holdMs);
    },
    { mode: 'immediate' },
  );

  await commit; // COMMIT ran on return from the callback
  await adapter.close();
  parentPort.postMessage({ type: 'released' });
}

// Rethrow so an open/BEGIN failure surfaces as a real worker 'error' event
// (the spec's waitForMessage attaches `worker.on('error', reject)`), never a
// silent hang; the message is posted first for debuggability.
main().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  throw err;
});
