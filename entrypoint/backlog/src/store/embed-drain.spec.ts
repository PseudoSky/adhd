/**
 * embed-drain.spec.ts — the close-time embed durability backstop
 * (`write/embed-drain.ts`'s per-adapter registry + `store/graph-backlog-store.ts`'s
 * `closeGraphBacklogStore`/`closeGraphBacklogStoreSafe`), driven through the
 * REAL production close path against a REAL store (`openTestIssueStore`).
 *
 * **What defect this pins.** A write verb schedules its embed fire-and-forget
 * by default; a one-shot CLI then closes the adapter in its `finally`. Without
 * a drain, the still-pending embed's `upsertVector`/audit write hit a closed
 * connection and die as a log line — the vector is lost and nothing records
 * why. These tests prove the close-time drain waits for the embed, and that
 * anything it cannot settle is recorded durably BEFORE the connection closes.
 *
 * **Never `store.close()`.** `TestIssueStore.close()` is a bare
 * `adapter.close()` that deliberately bypasses the drain — the exact defect
 * under test. Every test here closes via `closeGraphBacklogStore` /
 * `closeGraphBacklogStoreSafe`.
 *
 * The `IEmbeddingBackend` is a deterministic FAKE (in-memory, no model
 * download, no network), injected as `handle.embedding` — the external
 * boundary only. The store, adapter, drain registry, and close path are all
 * real. Determinism comes from an explicit `deferred()` gate, never
 * `sleep`/wall-clock (AGENTS.md §7.3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createIssue } from '../write/create-issue.js';
import type { IEmbeddingBackend, IWriteStoreHandle } from '../write/tx.js';
import { scheduleIssueEmbedding } from '../write/embedding-observer.js';
import { embedDrainFor } from '../write/embed-drain.js';
import {
  closeGraphBacklogStore,
  closeGraphBacklogStoreSafe,
  type GraphBacklogStore,
} from './graph-backlog-store.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

/** A controllable deferred promise — the deterministic gate for the drain tests. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeBackendHandle {
  backend: IEmbeddingBackend;
  vectors: Map<number, Float32Array>;
}

/**
 * @param opts.gate When present, `embedDocument` awaits this before resolving
 *   — the deterministic "hold this embed open" knob.
 */
function makeFakeBackend(
  opts: { modelId?: string; dim?: number; gate?: Promise<void> } = {}
): FakeBackendHandle {
  const dim = opts.dim ?? 4;
  const modelId = opts.modelId ?? 'fake-embed-drain-model';
  const vectors = new Map<number, Float32Array>();

  const backend: IEmbeddingBackend = {
    modelId,
    async embedDocument(text: string): Promise<Float32Array> {
      if (opts.gate) await opts.gate;
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = (text.length + i) / 97;
      return v;
    },
    async upsertVector(nodeRowid: number, vector: Float32Array): Promise<void> {
      vectors.set(nodeRowid, vector);
    },
    async deleteVector(nodeRowid: number): Promise<void> {
      vectors.delete(nodeRowid);
    },
  };

  return { backend, vectors };
}

/** Builds the handle a write verb is called with, baking in the fake backend. */
function withEmbedding(
  store: TestIssueStore,
  embedding?: IEmbeddingBackend
): TestIssueStore & IWriteStoreHandle {
  return { ...store, close: store.close.bind(store), embedding };
}

/** Reads back the ordered `audit.name` values (the action) recorded via a live `audits` edge FROM `subjectRowid`. */
async function auditActionsFor(
  store: TestIssueStore,
  subjectRowid: number
): Promise<string[]> {
  const { rows } = await store.adapter.executeAll<{ name: string | null }>(
    `SELECT n.name AS name FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL ORDER BY n.rowid ASC`,
    [subjectRowid]
  );
  return rows.map((r) => r.name ?? '');
}

async function rowidForUid(
  store: TestIssueStore,
  uid: string
): Promise<number> {
  const node = await store.graph.getNodeByUid(uid);
  if (!node) throw new Error(`rowidForUid: no live node for uid ${uid}`);
  return node.id;
}

describe('close-time embed drain (write/embed-drain.ts + graph-backlog-store.ts)', () => {
  let dir: string;
  let store: TestIssueStore;

  afterEach(async () => {
    if (store) await store.close();
    if (dir) removeTestIssueStoreDir(dir);
  });

  async function openStore(
    label: string
  ): Promise<{ store: TestIssueStore; projectUid: string }> {
    dir = freshTmpDir(label);
    store = await openTestIssueStore(`${dir}/backlog.db`);
    const { projectUid } = await seedProject(store, 'proj');
    return { store, projectUid };
  }

  it('a fire-and-forget embed survives the store closing — the close-time drain waits for it', async () => {
    const { store: store1, projectUid } = await openStore('embed-drain-headline');
    const gate = deferred();
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    const handle = withEmbedding(store1, backend);

    const outcome = await createIssue(handle, {
      project: projectUid,
      title: 'drain headline',
      body: 'the vector must land even though the store closes right after create',
      by: 'filer',
      // awaitEmbed deliberately OMITTED — fire-and-forget.
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store1, outcome.uid);

    // Deterministic: createIssue returned, the gate is unresolved, so the
    // scheduled embed cannot possibly have upserted yet.
    expect(vectors.has(rowid)).toBe(false);

    // Drive the REAL production close path. It must snapshot the pending
    // entry and await it before closing the adapter.
    const closing = closeGraphBacklogStore(store1);
    await Promise.resolve(); // let the drain snapshot + start awaiting
    gate.resolve();
    const result = await closing;

    expect(result.unrecorded).toHaveLength(0);
    expect(result.stillPending).toHaveLength(0);
    expect(result.drained).toBeGreaterThanOrEqual(1);
    expect(vectors.has(rowid)).toBe(true);

    // Reopen a FRESH store on the SAME file: the `embedding_upserted` audit
    // row is durable graph state committed by the round-trip's own follow-up
    // transaction, independent of the closed handle.
    store = await openTestIssueStore(`${dir}/backlog.db`);
    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);
  });

  it('an embed still unsettled at the drain bound is recorded as embedding_failed before close, not lost', async () => {
    const { store: store1, projectUid } = await openStore('embed-drain-unsettled');
    const gate = deferred(); // deliberately NEVER resolved
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    const handle = withEmbedding(store1, backend);

    const outcome = await createIssue(handle, {
      project: projectUid,
      title: 'unsettled embed',
      body: 'the embed never settles, so the drain must record it before closing',
      by: 'filer',
      // awaitEmbed deliberately OMITTED.
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store1, outcome.uid);

    // Bounded, deterministic: 50ms is enough for a pending entry to be
    // observed and timed out; nothing sleeps on wall-clock beyond the bound.
    const result = await closeGraphBacklogStore(store1, { timeoutMs: 50 });
    expect(result.stillPending).toHaveLength(1);
    expect(result.recordedAsFailed).toBe(1);
    expect(result.unrecorded).toHaveLength(0);
    expect(vectors.has(rowid)).toBe(false); // never landed

    store = await openTestIssueStore(`${dir}/backlog.db`);
    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(0);
  });

  /**
   * A store whose adapter REFUSES `transaction` (so an `embedding_failed`
   * audit write against it cannot run) but whose `close` is a no-op (the real
   * store is closed by the suite's teardown). Two ways to populate it:
   *
   * - a gated embed held open forever, so the drain times out and then fails
   *   to RECORD it (`closeGraphBacklogStore` with a small bound); or
   * - an embed whose round-trip itself fails its audit write, so the producer
   *   settles it `'unrecorded'` with no pending entry (`Safe`'s fast path).
   */
  function refusingAdapter(): StoreAdapter {
    return {
      transaction: async () => {
        throw new Error('injected: adapter transaction refused');
      },
      close: async () => undefined,
    } as unknown as StoreAdapter;
  }

  function drainStoreFor(
    real: TestIssueStore,
    adapter: StoreAdapter
  ): GraphBacklogStore {
    return {
      adapter,
      graph: real.graph,
      typePolicy: real.typePolicy,
      flushEmbeds: (opts) => embedDrainFor(adapter).drain(opts),
    };
  }

  it('a drain that cannot record an unsettled embed reports it unrecorded (never silently drops it)', async () => {
    const { store: real } = await openStore('embed-drain-unrecorded');
    const adapter = refusingAdapter();
    const never = deferred();
    const { backend } = makeFakeBackend({ gate: never.promise });
    scheduleIssueEmbedding(
      { adapter, typePolicy: real.typePolicy, embedding: backend },
      {
        action: 'upsert',
        subjectRowid: 424242,
        subjectUid: 'injected-unrecorded',
        actor: 'filer',
        content: 'never settles',
      }
    );

    const result = await closeGraphBacklogStore(drainStoreFor(real, adapter), {
      timeoutMs: 50,
    });
    expect(result.stillPending).toHaveLength(1);
    expect(result.recordedAsFailed).toBe(0); // the recording's audit write threw
    expect(result.unrecorded).toHaveLength(1);
  });

  it('closeGraphBacklogStoreSafe is loud and exits non-zero when an embed died unrecorded', async () => {
    const { store: real } = await openStore('embed-drain-safe-loud');
    const adapter = refusingAdapter();
    const { backend } = makeFakeBackend(); // succeeds; the audit write is what fails
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      // The round-trip's own audit write throws (adapter refuses `transaction`),
      // so the producer settles this entry `'unrecorded'` — retained in the
      // registry, with no pending entry, so Safe's drain returns immediately.
      await scheduleIssueEmbedding(
        { adapter, typePolicy: real.typePolicy, embedding: backend },
        {
          action: 'upsert',
          subjectRowid: 5150,
          subjectUid: 'injected-settled-unrecorded',
          actor: 'filer',
          content: 'audit write will fail',
        }
      );
      const drainStore = drainStoreFor(real, adapter);

      await closeGraphBacklogStoreSafe(drainStore);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('UNRECORDED'))
      ).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      errSpy.mockRestore();
    }
  });
});
