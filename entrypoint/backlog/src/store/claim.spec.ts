/**
 * claim.spec.ts — SPEC.md §7 DoD clause 1: a real-DB CAS claim race.
 *
 * Two genuinely concurrent `claimItem` calls (via real `worker_threads`, each
 * with its OWN `better-sqlite3` connection to the SAME on-disk file) race for
 * the same item. Exactly one must win (`status: 'claimed'`); the other must
 * see `status: 'held'`. The barrier (a `SharedArrayBuffer` + `Atomics.wait`/
 * `notify`) guarantees both calls are in-flight before either is released —
 * never a `sleep` (AGENTS.md §7 rule 3).
 *
 * NEGATIVE CONTROL (performed manually during implementation, per SPEC.md §7
 * clause 1 — not part of the automated suite, since permanently breaking our
 * own CAS guard would be nonsensical to ship): reverting
 * `store/mutate-metadata.ts`'s `.immediate()` to a plain (deferred)
 * `store.db.transaction(fn)()` call and re-running this test reproduces
 * either two `'claimed'` results or a `SQLITE_BUSY` crash — confirming the
 * assertion actually has teeth. Restored immediately after confirming red;
 * see the session report for the exact before/after observation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');
const WORKER_SCRIPT = join(HERE, '..', 'test', 'fixtures', 'claim-race-worker.js');
const REPO = 'PseudoSky/claim-race-test';

interface WorkerOutcome {
  type: 'ready' | 'result' | 'error';
  result?: { status: string; claimedBy: string; heldBy?: string; previousClaimant?: string };
  message?: string;
}

function runClaimWorker(opts: { dbPath: string; adhdRoot: string; humanId: string; by: string; gate: SharedArrayBuffer }): {
  worker: Worker;
  ready: Promise<void>;
  outcome: Promise<WorkerOutcome>;
} {
  const worker = new Worker(WORKER_SCRIPT, {
    workerData: {
      distIndexPath: DIST_INDEX,
      dbPath: opts.dbPath,
      adhdRoot: opts.adhdRoot,
      repo: REPO,
      humanId: opts.humanId,
      by: opts.by,
      gate: opts.gate,
    },
  });

  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const outcome = new Promise<WorkerOutcome>((resolve, reject) => {
    worker.on('message', (msg: WorkerOutcome) => {
      if (msg.type === 'ready') {
        resolveReady();
      } else {
        resolve(msg);
      }
    });
    worker.on('error', reject);
  });

  return { worker, ready, outcome };
}

describe('claimItem — CAS claim race (real worker_threads, real second SQLite connection)', () => {
  let tmp: TmpStore;

  beforeEach(() => {
    tmp = openTmpStore('claim-race');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('exactly one of two truly concurrent claimants wins; the other sees held', async () => {
    const created = createItemNode(tmp.store, { family: 'BUG-RACE', title: 'raced item', body: 'x', repo: REPO });
    // The main thread's own connection is never used to claim anything below
    // — WAL mode allows it to stay open alongside the two workers' own
    // connections without affecting the race, which is strictly between
    // those two (DESIGN.md §4's "two separate processes/threads, two
    // separate better-sqlite3 handles" scenario).

    const gate = new SharedArrayBuffer(4);
    const gateArr = new Int32Array(gate);
    Atomics.store(gateArr, 0, 0);

    const a = runClaimWorker({ dbPath: tmp.dbPath, adhdRoot: tmp.dir, humanId: created.item.humanId, by: 'agent:a', gate });
    const b = runClaimWorker({ dbPath: tmp.dbPath, adhdRoot: tmp.dir, humanId: created.item.humanId, by: 'agent:b', gate });

    // Deterministic barrier: release BOTH workers only once BOTH have signaled
    // ready (i.e. are parked on Atomics.wait), never a sleep.
    await Promise.all([a.ready, b.ready]);
    Atomics.store(gateArr, 0, 1);
    Atomics.notify(gateArr, 0);

    const [resultA, resultB] = await Promise.all([a.outcome, b.outcome]);
    await Promise.all([a.worker.terminate(), b.worker.terminate()]);

    expect(resultA.type).toBe('result');
    expect(resultB.type).toBe('result');
    const statuses = [resultA.result?.status, resultB.result?.status].sort();
    // Exactly one claimed, one held — never both claimed, never a crash.
    expect(statuses).toEqual(['claimed', 'held']);

    const winner = resultA.result?.status === 'claimed' ? resultA.result : resultB.result;
    const loser = resultA.result?.status === 'held' ? resultA.result : resultB.result;
    expect(loser?.heldBy).toBe(winner?.claimedBy);
  }, 20000);
});
