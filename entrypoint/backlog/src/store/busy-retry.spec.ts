/**
 * busy-retry.spec.ts — DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001: a real
 * `SQLITE_BUSY` contention proof, not a mock.
 *
 * Two real `worker_threads`, each with its OWN `better-sqlite3` connection to
 * the SAME on-disk file:
 *  - `busy-hold-worker.js` opens a raw `BEGIN IMMEDIATE`, then PARKS (no
 *    timeout) until told the other worker is also ready.
 *  - `busy-retry-worker.js` calls the REAL public `claimItem` (through the
 *    BUILT `dist/index.js`) against a store opened with a SHORT
 *    `RETRY_TIMEOUT_MS` `busy_timeout`, and ALSO parks until released.
 *
 * The main thread releases BOTH parked workers together, only once BOTH have
 * confirmed readiness via real messages — ONLY THEN does the hold-worker's
 * FIXED `HOLD_MS` countdown start. This ordering is load-bearing: an earlier
 * draft started the hold countdown at lock-ACQUISITION time instead, and the
 * retry-worker's own startup latency (`require(distIndexPath)` — loading the
 * whole built bundle, plus opening a second real connection) routinely
 * exceeded `HOLD_MS` on its own, so the lock was already free before the
 * retry-worker ever attempted its write — a false-positive test that passed
 * even with the retry wrapper removed. Synchronizing both workers' start
 * closes that gap: the retry-worker's FIRST `.immediate()` attempt is now
 * guaranteed to observe the lock still held.
 *
 * The proof is entirely ARITHMETIC from that point on, not timing-hope:
 * `withImmediateRetry`'s default budget (5 attempts × up to
 * `RETRY_TIMEOUT_MS` own-wait each, plus 20+40+80+160ms backoff between
 * attempts) is sized to comfortably exceed `HOLD_MS` by construction — see
 * the constants below — so a correct retry wrapper MUST eventually succeed,
 * deterministically, on any machine fast or slow enough to run this file at
 * all.
 *
 * NEGATIVE CONTROL (performed manually during implementation, per AGENTS.md
 * §7): reverting `store/mutate-metadata.ts`'s `withImmediateRetry(...)` wrap
 * back to a bare `.immediate()` call and re-running this test reproduces a
 * `SQLITE_BUSY` crash (the retry-worker's outcome becomes `{type:'error',
 * code:'SQLITE_BUSY'}` instead of `{type:'result', status:'claimed'}`) —
 * confirming the assertion has teeth. Restored immediately after confirming
 * red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');
const HOLD_WORKER = join(HERE, '..', 'test', 'fixtures', 'busy-hold-worker.js');
const RETRY_WORKER = join(HERE, '..', 'test', 'fixtures', 'busy-retry-worker.js');
const REPO = 'PseudoSky/busy-retry-test';

// Sized so the retry-worker's guaranteed MINIMUM retry budget (attempts *
// own busy_timeout + fixed inter-attempt backoff) comfortably exceeds the
// hold-worker's FIXED hold duration — an arithmetic guarantee, not a hope.
const HOLD_MS = 150;
const RETRY_TIMEOUT_MS = 25;
const RETRY_MAX_ATTEMPTS = 5; // withImmediateRetry's own default
const BACKOFF_MS = [20, 40, 80, 160]; // withImmediateRetry's own default schedule
const MIN_GUARANTEED_RETRY_BUDGET_MS = RETRY_MAX_ATTEMPTS * RETRY_TIMEOUT_MS + BACKOFF_MS.reduce((a, b) => a + b, 0);

interface WorkerOutcome {
  type: 'ready' | 'holding' | 'released' | 'result' | 'error';
  result?: { status: string; claimedBy: string };
  message?: string;
  code?: string;
}

function waitForMessage(worker: Worker, type: WorkerOutcome['type']): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    worker.on('message', (msg: WorkerOutcome) => {
      if (msg.type === type) resolve(msg);
    });
    worker.on('error', reject);
  });
}

/** Waits for the retry-worker's TERMINAL message — `result` (success) or `error` (thrown) — never its earlier `ready` message. */
function waitForOutcome(worker: Worker): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    worker.on('message', (msg: WorkerOutcome) => {
      if (msg.type === 'result' || msg.type === 'error') resolve(msg);
    });
    worker.on('error', reject);
  });
}

describe('withImmediateRetry — real SQLITE_BUSY contention, real worker_threads (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001)', () => {
  let tmp: TmpStore;

  beforeEach(() => {
    tmp = openTmpStore('busy-retry');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('sanity: the retry budget is arithmetically larger than the fixed hold duration', () => {
    // If this ever fails, the constants above no longer prove anything —
    // fix the constants, not the assertion.
    expect(MIN_GUARANTEED_RETRY_BUDGET_MS).toBeGreaterThan(HOLD_MS * 2);
  });

  it('a write blocked by a real held lock survives past one busy_timeout window instead of throwing SQLITE_BUSY', async () => {
    const created = createItemNode(tmp.store, { family: 'BUG-BUSY', title: 'busy-retry fixture', body: 'x', repo: REPO });

    // One shared start-gate: both workers park on their OWN Int32Array view
    // of it (Atomics.wait/notify require the array, not just the buffer) and
    // are released together, only once BOTH have confirmed real readiness.
    const startGate = new SharedArrayBuffer(4);
    const startGateArr = new Int32Array(startGate);
    Atomics.store(startGateArr, 0, 0);

    // Spawn (and fully initialize) the retry-worker FIRST, on an
    // uncontended DB, and wait for it to park. `openGraphBacklogStore`
    // re-applies the (idempotent, `CREATE TABLE IF NOT EXISTS`) schema on
    // every open — if the hold-worker's lock already existed while THAT ran,
    // it would throw its own unguarded `SQLITE_BUSY` outside this test's
    // barrier entirely, unrelated to the retry wrapper under test. Opening
    // the retry-worker's store before the hold-worker even exists rules
    // that out by construction.
    const retryWorker = new Worker(RETRY_WORKER, {
      workerData: {
        distIndexPath: DIST_INDEX,
        dbPath: tmp.dbPath,
        adhdRoot: tmp.dir,
        repo: REPO,
        humanId: created.item.humanId,
        by: 'agent:retry-test',
        busyTimeoutMs: RETRY_TIMEOUT_MS,
        gate: startGate,
      },
    });
    const ready = waitForMessage(retryWorker, 'ready');
    const outcome = waitForOutcome(retryWorker);
    await ready;

    const holdWorker = new Worker(HOLD_WORKER, { workerData: { dbPath: tmp.dbPath, holdMs: HOLD_MS, startGate } });
    const holding = waitForMessage(holdWorker, 'holding');
    const released = waitForMessage(holdWorker, 'released');
    await holding;

    // Both workers are now genuinely parked — release them together. The
    // hold-worker's fixed `HOLD_MS` countdown starts at THIS instant, the
    // same instant the retry-worker's first `.immediate()` attempt begins.
    Atomics.store(startGateArr, 0, 1);
    Atomics.notify(startGateArr, 0);

    const [retryOutcome] = await Promise.all([outcome, released]);
    await Promise.all([holdWorker.terminate(), retryWorker.terminate()]);

    expect(retryOutcome.type, `expected a successful claim, got: ${JSON.stringify(retryOutcome)}`).toBe('result');
    expect(retryOutcome.result?.status).toBe('claimed');
    expect(retryOutcome.result?.claimedBy).toBe('agent:retry-test');
  }, 20000);
});
