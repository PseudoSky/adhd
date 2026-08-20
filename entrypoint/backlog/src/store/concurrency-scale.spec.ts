/**
 * concurrency-scale.spec.ts — MIGRATION.md §3.3: extends the 2-writer CAS
 * race (`claim.spec.ts`) and the 2-writer busy-retry proof
 * (`busy-retry.spec.ts`) to a REAL 20-writer scale, per the plan's own six
 * numbered cases. Every writer is a genuine `worker_threads` instance with
 * its OWN turso store-adapter connection to the SAME on-disk file, driving
 * the real public `claimItem`/`createItem` exports through the BUILT
 * `dist/index.js` — never simulated/mocked. Synchronization is a real
 * `SharedArrayBuffer` + `Atomics.wait`/`notify` start-gate, released only
 * once every worker has confirmed it is parked and ready — never a `sleep`
 * (AGENTS.md §7 rule 3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { listItems } from './query.js';

// The store substrate is TURSO — `createStoreAdapter({ dbPath })` defaults to
// it, and every worker fixture below opens REAL turso store-adapter
// connections to the same file (through the BUILT `dist/index.js`), so this
// scale proof exercises TURSO's OWN locking semantics (multiprocess WAL
// coordination, `GenericFailure`/"database is locked" busy errors) end to
// end. No `STORE_ADAPTER` pin is needed — or wanted: the adapter defaults to
// turso and this spec must stay on it.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');
const WORKER_SCRIPT = join(HERE, '..', 'test', 'fixtures', 'scale-worker.js');
const REPO = 'PseudoSky/scale-test';
const N = 20;

interface WorkerMsg {
  /** `startup-error` is a failure BEFORE the gate (store open, schema apply) —
   *  distinct from `error`, which is a failure of the operation under test. */
  type: 'ready' | 'result' | 'error' | 'startup-error';
  result?: { status?: string; claimedBy?: string; heldBy?: string; item?: { humanId: string } };
  message?: string;
  code?: string;
  stack?: string;
  elapsedMs?: number;
}

interface SpawnOpts {
  dbPath: string;
  adhdRoot: string;
  mode: 'claim' | 'create';
  humanId?: string;
  by?: string;
  family?: string;
  title?: string;
  index?: number;
  busyTimeoutMs?: number;
  gate: SharedArrayBuffer;
}

function spawnWorker(opts: SpawnOpts): { worker: Worker; ready: Promise<void>; outcome: Promise<WorkerMsg> } {
  const worker = new Worker(WORKER_SCRIPT, {
    workerData: { distIndexPath: DIST_INDEX, repo: REPO, ...opts },
  });
  let resolveReady!: () => void;
  // `ready` MUST have a reject path. Without one, a worker that dies before
  // posting `ready` — a store-open/schema-apply failure, a thrown require —
  // left `runBarrieredBatch`'s `Promise.all(ready)` pending forever, so the
  // spec died on its own 60s timeout while the real error surfaced only as a
  // detached "Unhandled Rejection" in vitest's summary. Every startup failure
  // now fails the batch fast, carrying the cause.
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const outcome = new Promise<WorkerMsg>((resolve, reject) => {
    worker.on('message', (msg: WorkerMsg) => {
      if (msg.type === 'ready') resolveReady();
      else if (msg.type === 'startup-error') {
        const err = new Error(`worker failed before the gate: ${msg.message}\n${msg.stack ?? ''}`);
        rejectReady(err);
        reject(err);
      } else resolve(msg);
    });
    worker.on('error', (err) => {
      rejectReady(err);
      reject(err);
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`worker exited with code ${code} before reporting an outcome`);
        rejectReady(err);
        reject(err);
      }
    });
  });
  return { worker, ready, outcome };
}

/** Spawns `count` workers, waits for ALL to report ready (genuinely parked
 *  on the shared gate), then releases them together at (as close to) the
 *  same instant the OS scheduler allows, and returns their terminal outcomes. */
async function runBarrieredBatch(count: number, makeOpts: (i: number, gate: SharedArrayBuffer) => SpawnOpts): Promise<WorkerMsg[]> {
  const gate = new SharedArrayBuffer(4);
  const gateArr = new Int32Array(gate);
  Atomics.store(gateArr, 0, 0);

  const spawned = Array.from({ length: count }, (_, i) => spawnWorker(makeOpts(i, gate)));
  await Promise.all(spawned.map((s) => s.ready));
  Atomics.store(gateArr, 0, 1);
  Atomics.notify(gateArr, 0);

  const outcomes = await Promise.all(spawned.map((s) => s.outcome));
  await Promise.all(spawned.map((s) => s.worker.terminate()));
  return outcomes;
}

function p99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
  return sorted[idx];
}

describe(`concurrency-scale — ${N} real worker_threads (MIGRATION.md §3.3)`, () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('concurrency-scale');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('contention case: exactly ONE of N truly concurrent claimItem calls on the SAME item wins; the rest see held', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-SCALE', title: 'raced item', body: 'x', repo: REPO });

    const outcomes = await runBarrieredBatch(N, (i, gate) => ({
      dbPath: tmp.dbPath,
      adhdRoot: tmp.dir,
      mode: 'claim',
      humanId: created.item.humanId,
      by: `agent:${i}`,
      gate,
    }));

    // Reopen the store fresh (not any writer's own handle) to read the
    // final, settled state — proving the winner really persisted, not just
    // that one worker's own in-process view says so.
    const finalItem = (await listItems(tmp.store, { repo: REPO, family: 'BUG-SCALE' }))[0];

    expect(outcomes.every((o) => o.type === 'result')).toBe(true);
    const statuses = outcomes.map((o) => o.result?.status);
    const claimedCount = statuses.filter((s) => s === 'claimed').length;
    const heldCount = statuses.filter((s) => s === 'held').length;
    // The failing condition this proves against: two or more 'claimed'
    // results (a lost-update / double-claim).
    expect(claimedCount).toBe(1);
    expect(heldCount).toBe(N - 1);
    expect(finalItem?.claimedBy).toBeDefined();
  }, 60000);

  it('no-contention case: N concurrent createItem calls for N DISTINCT items produce exactly N nodes — zero dropped writes, zero duplicate ids', async () => {
    const outcomes = await runBarrieredBatch(N, (i, gate) => ({
      dbPath: tmp.dbPath,
      adhdRoot: tmp.dir,
      mode: 'create',
      family: 'BUG-SCALE-CREATE',
      title: 'scale create',
      index: i,
      gate,
    }));

    expect(outcomes.every((o) => o.type === 'result')).toBe(true);
    const ids = outcomes.map((o) => o.result?.item?.humanId);
    expect(ids.every((id): id is string => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(N); // zero duplicate ids

    const stored = await listItems(tmp.store, { repo: REPO, family: 'BUG-SCALE-CREATE' });
    expect(stored).toHaveLength(N); // zero dropped writes
  }, 60000);

  it('bounded latency: p99 of the contention case stays under the configured busy_timeout, proving contention is absorbed, not silently truncated/starved', async () => {
    const BUSY_TIMEOUT_MS = 5000; // openGraphBacklogStore's own default
    const created = await createItemNode(tmp.store, { family: 'BUG-SCALE-LAT', title: 'latency item', body: 'x', repo: REPO });

    const outcomes = await runBarrieredBatch(N, (i, gate) => ({
      dbPath: tmp.dbPath,
      adhdRoot: tmp.dir,
      mode: 'claim',
      humanId: created.item.humanId,
      by: `agent:${i}`,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      gate,
    }));

    expect(outcomes.every((o) => o.type === 'result')).toBe(true);
    const elapsed = outcomes.map((o) => o.elapsedMs ?? 0);
    // A latency-ENVELOPE assertion, not a raw-speed benchmark: p99 must stay
    // comfortably under the busy_timeout window, i.e. contention resolved
    // via the lock queue within the configured budget rather than any
    // writer being starved past it.
    expect(p99(elapsed)).toBeLessThan(BUSY_TIMEOUT_MS);
  }, 60000);

  it('NEGATIVE CONTROL: with busy_timeout forced to ~0ms, a write against a genuinely held lock throws a busy/locked error immediately — proving busy_timeout is load-bearing at the pragma level, not a no-op', async () => {
    // Deliberately does NOT go through `claimItem` here: `claimItem` is
    // ALWAYS wrapped in `withImmediateRetry` (store/immediate-retry.ts),
    // whose own inter-attempt backoff (20/40/80/160ms) gives contention time
    // to clear even when the PER-ATTEMPT busy_timeout is ~0 — so racing N
    // `claimItem` calls at busy_timeout:0 usually still converges cleanly
    // (proving the RETRY layer works, which is exactly what the next test,
    // "RETRY-RECOVERS", already covers). To isolate and prove busy_timeout's
    // OWN effect — independent of the retry wrapper layered on top of it —
    // this reuses `busy-retry.spec.ts`'s own real-held-lock fixture
    // (`busy-hold-worker.js`, which holds BEGIN IMMEDIATE via a turso
    // store-adapter transaction) and attempts a write transaction against it
    // from a SECOND real turso store-adapter connection with `busy_timeout=0`.
    const HOLD_MS = 300;
    const startGate = new SharedArrayBuffer(4);
    const startGateArr = new Int32Array(startGate);
    Atomics.store(startGateArr, 0, 0);

    // A scratch table so the probe callback below is a REAL write — it never
    // gets to run it while the lock is held (BEGIN IMMEDIATE is refused
    // first), but if BEGIN ever succeeded the INSERT would prove it. Created
    // HERE, through the already-open main store adapter and BEFORE the
    // hold-worker exists: DDL is itself a write, so creating it from the
    // probe connection after the lock is held would be refused too (which
    // would only re-prove the same thing, obscurely).
    await tmp.store.adapter.exec('CREATE TABLE IF NOT EXISTS _busy_probe (id INTEGER PRIMARY KEY)');

    const holdWorker = new Worker(join(HERE, '..', 'test', 'fixtures', 'busy-hold-worker.js'), {
      workerData: { dbPath: tmp.dbPath, holdMs: HOLD_MS, startGate },
    });
    const holding = new Promise<void>((resolve, reject) => {
      holdWorker.on('message', (msg: { type: string }) => {
        if (msg.type === 'holding') resolve();
      });
      holdWorker.on('error', reject);
    });
    // The hold-worker's `BEGIN IMMEDIATE` has already run by the time it
    // posts 'holding' — the lock is held from THIS instant, and stays held
    // indefinitely (it parks on `Atomics.wait(startGate, 0, 0)` with NO
    // timeout) until we release the gate below. No race window: our own
    // attempt below is guaranteed to observe the lock still held.
    await holding;

    // The "foreign writer" probe is a REAL turso store-adapter connection —
    // the same substrate the store itself uses — NOT a raw third-party
    // SQLite handle. With `busy_timeout=0` the driver refuses the contended
    // BEGIN IMMEDIATE instantly; the adapter's own internal BEGIN retry loop
    // (turso-adapter.js:614-650, ~10/20/40ms backoff) cannot mask it, since
    // every retry fails immediately while the lock is held and the final
    // throw is the busy/lock error itself.
    const { createTursoAdapter, isConcurrentConflict } = await import('@adhd/sox-store-adapter');
    const probe = await createTursoAdapter({ dbPath: tmp.dbPath });
    await probe.pragmaSet('busy_timeout', 0);
    let threw: unknown;
    try {
      await probe.transaction(
        async (tx) => {
          await tx.executeRun('INSERT INTO _busy_probe (id) VALUES (1)');
        },
        { mode: 'immediate' },
      );
    } catch (err) {
      threw = err;
    } finally {
      await probe.close();
    }

    // Release the hold-worker so it can commit/close and the test can tear
    // down cleanly — its HOLD_MS countdown starts only now, well after our
    // assertion already ran.
    Atomics.store(startGateArr, 0, 1);
    Atomics.notify(startGateArr, 0);
    await new Promise<void>((resolve, reject) => {
      holdWorker.on('message', (msg: { type: string }) => msg.type === 'released' && resolve());
      holdWorker.on('error', reject);
    });
    await holdWorker.terminate();

    expect(threw, 'expected a turso BEGIN IMMEDIATE against a held lock with busy_timeout=0 to throw a busy/lock error').toBeDefined();
    // The portable conflict check covers BOTH adapter error shapes: the
    // legacy SQLite adapter's `SQLITE_BUSY` code AND turso's `GenericFailure`
    // with a "database is locked"/"database is busy" message marker (verified
    // live against the turso driver: code `GenericFailure`, message
    // "database is locked").
    expect(isConcurrentConflict(threw), `expected busy/lock error, got: ${threw instanceof Error ? threw.message : String(threw)}`).toBe(true);
  }, 20000);

  it('RETRY-RECOVERS: with a deliberately tiny busy_timeout, the retry/backoff wrapper still converges on exactly ONE claimed result with ZERO unhandled errors across all N writers', async () => {
    // Small enough that a single `.immediate()` attempt's own busy_timeout
    // window is frequently exhausted under 20-way contention (unlike the
    // bounded-latency case's full 5000ms default), but `withImmediateRetry`'s
    // bounded 5-attempt/jittered-backoff schedule (store/immediate-retry.ts)
    // must still let every one of the 20 losers eventually observe the
    // winner's committed claim and return a clean 'held' — never an
    // unhandled busy/locked error thrown to the caller.
    // HISTORY — READ BEFORE WIDENING THIS TIMEOUT AGAIN.
    // This test failed roughly 1 run in 5, and the failure was written off
    // here as its own timing margin: the theory was that a loser's last retry
    // lands inside another loser's still-open window, exhausting the 5-attempt
    // budget. The "fix" was widening this constant 50ms -> 150ms.
    //
    // That diagnosis was wrong, and the widening only made the real defect
    // rarer. Two measurements refute it:
    //   * busy_timeout IS honored, and the adapter retries ~4x internally, so
    //     ONE `withImmediateRetry` attempt at 150ms costs ~684ms and the full
    //     5-attempt budget is ~3.4s. The failing worker threw at ~194ms — a
    //     quarter of a SINGLE attempt, so it never exhausted anything.
    //   * the captured stack (scale-worker.js now reports `err.stack` for
    //     exactly this reason) landed in `SqliteGraphBackend.writeNode` under
    //     `claimItem` -> `logClaimEvent` -> `writeAuditEvent` — the
    //     POST-COMMIT audit-event write, which at the time had neither
    //     busy-retry nor containment.
    //
    // So the error came off an unretried path, AFTER the claim had already
    // committed: BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001, covered
    // deterministically by `audit-write-containment.spec.ts`. If this test
    // ever goes red again, capture the stack and find the unretried path —
    // do not widen the timeout.
    const TINY_BUSY_TIMEOUT_MS = 150;
    const created = await createItemNode(tmp.store, { family: 'BUG-SCALE-RETRY', title: 'retry-recovers item', body: 'x', repo: REPO });

    const outcomes = await runBarrieredBatch(N, (i, gate) => ({
      dbPath: tmp.dbPath,
      adhdRoot: tmp.dir,
      mode: 'claim',
      humanId: created.item.humanId,
      by: `agent:${i}`,
      busyTimeoutMs: TINY_BUSY_TIMEOUT_MS,
      gate,
    }));

    const errors = outcomes.filter((o) => o.type === 'error');
    expect(errors, `expected zero unhandled errors, got: ${JSON.stringify(errors)}`).toHaveLength(0);
    const claimedCount = outcomes.filter((o) => o.result?.status === 'claimed').length;
    expect(claimedCount).toBe(1);
  }, 60000);
});
