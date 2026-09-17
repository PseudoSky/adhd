/**
 * embed-write-path.spec.ts — proves the write layer's on-write embedding
 * hook (`write/embedding-observer.ts`'s `scheduleIssueEmbedding`, wired into
 * `write/create-issue.ts`, `write/update.ts`, and `write/delete.ts`): the
 * `awaitEmbed` synchronous-vs-fire-and-forget knob, re-embed-on-body-change
 * (never on an unrelated field), and never-throws failure handling — driven
 * through the REAL write verbs against a REAL store
 * (`openTestIssueStore`/`seedProject`), never a mock of the store itself
 * (AGENTS.md §7.1).
 *
 * **Architecture note — no store-level embed queue exists anymore.** Each
 * write verb schedules AT MOST one (two, for a body-changing update) direct
 * `scheduleIssueEmbedding` call per invocation; there is no queue and no
 * store-close/flush hook that drains outstanding fire-and-forget embeds
 * (`TestIssueStore.close()` is a bare `adapter.close()`, nothing more — see
 * `test/helpers/open-test-issue-store.ts`). Consequently a fire-and-forget
 * embed (`awaitEmbed` omitted/`false`) is NOT guaranteed to survive the
 * process/store closing before it settles — the durability boundary here is
 * `awaitEmbed:true` itself, not any store-level drain. Two tests below prove
 * both edges of that boundary by reopening a fresh store handle on the SAME
 * file (never a sleep, never wall-clock): `awaitEmbed:true` followed by a
 * close/reopen shows the `embedding_upserted` audit row survived, because by
 * the time `createIssue` resolves that row is ordinary committed graph
 * state, independent of the handle that wrote it; a fire-and-forget embed
 * whose store is closed out from under it — deterministically, via a gate
 * that is never released — shows nothing survived, because its own
 * follow-up `executeWriteTransaction` never had the chance to run. The
 * absent drain is a real, documented gap, not a bug this suite papers over.
 *
 * The `IEmbeddingBackend` here is a FAKE (deterministic, in-memory, no model
 * download, no network) constructed per-test and passed directly as
 * `handle.embedding` — that keeps this suite fast and immune to flakiness;
 * a real-vector-store proof already exists in `write/embedding-observer.spec.ts`
 * (which layers a real `TursoVectorBackend` underneath). Determinism for the
 * "fire-and-forget must not block" assertion comes from an explicit
 * `deferred()` gate, never `sleep`/wall-clock (AGENTS.md §7.3): a promise can
 * never settle before every promise it `await`s has settled, so blocking
 * `embedDocument` behind an unresolved gate lets a test prove "this call is
 * DEFINITELY still pending" with zero timing risk. Proving the gated embed
 * later COMPLETES (once nothing blocks it and there is no drain hook to
 * await directly) uses `vi.waitFor` — a bounded poll, not a blind sleep.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssue } from '../write/create-issue.js';
import { update } from '../write/update.js';
import { deleteIssue } from '../write/delete.js';
import type { IEmbeddingBackend, IWriteStoreHandle } from '../write/tx.js';
import { openTestIssueStore, removeTestIssueStoreDir, seedProject, type TestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

/** A controllable deferred promise — the deterministic gate used by the fire-and-forget test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeBackendHandle {
  backend: IEmbeddingBackend;
  /** In-memory vector store, keyed by node rowid — a stand-in for the real vector backend `embedding-observer.spec.ts` exercises against a genuine `TursoVectorBackend`. */
  vectors: Map<number, Float32Array>;
  embedDocumentCalls: () => number;
  upsertCalls: () => number;
  deleteCalls: () => number;
}

/**
 * @param opts.gate  When present, `embedDocument` awaits this before
 *   resolving/rejecting — the deterministic "hold this embed open" knob for
 *   the fire-and-forget test.
 * @param opts.rejectEmbedWith  When present, `embedDocument` throws this
 *   instead of returning a vector — proves a model-side failure degrades to
 *   `embedding_failed` and never fails the write.
 * @param opts.rejectUpsertWith  When present, `upsertVector` throws this
 *   AFTER a successful embed — proves a vector-STORE failure (distinct from
 *   a model failure) also degrades to `embedding_failed` and never fails the
 *   write, and never leaves a false `embedding_upserted` audit row.
 */
function makeFakeBackend(
  opts: { modelId?: string; dim?: number; gate?: Promise<void>; rejectEmbedWith?: Error; rejectUpsertWith?: Error } = {},
): FakeBackendHandle {
  const dim = opts.dim ?? 4;
  const modelId = opts.modelId ?? 'fake-embed-write-path-model';
  const vectors = new Map<number, Float32Array>();
  let embedCalls = 0;
  let upserts = 0;
  let deletes = 0;

  const backend: IEmbeddingBackend = {
    modelId,
    async embedDocument(text: string): Promise<Float32Array> {
      embedCalls++;
      if (opts.gate) await opts.gate;
      if (opts.rejectEmbedWith) throw opts.rejectEmbedWith;
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = (text.length + i) / 97;
      return v;
    },
    async upsertVector(nodeRowid: number, vector: Float32Array): Promise<void> {
      upserts++;
      if (opts.rejectUpsertWith) throw opts.rejectUpsertWith;
      vectors.set(nodeRowid, vector);
    },
    async deleteVector(nodeRowid: number): Promise<void> {
      deletes++;
      vectors.delete(nodeRowid);
    },
  };

  return {
    backend,
    vectors,
    embedDocumentCalls: () => embedCalls,
    upsertCalls: () => upserts,
    deleteCalls: () => deletes,
  };
}

/** Builds the handle a write verb is called with — `embedding` is `readonly` on `IWriteStoreHandle` by design, so every test bakes it in at construction time rather than mutating a live handle. */
function withEmbedding(store: TestIssueStore, embedding?: IEmbeddingBackend): TestIssueStore & IWriteStoreHandle {
  return { ...store, close: store.close.bind(store), embedding };
}

/** Reads back the ordered list of `audit.name` values (the action) recorded via a live `audits` edge FROM `subjectRowid` — the real graph read this file's assertions use instead of any spy. */
async function auditActionsFor(store: TestIssueStore, subjectRowid: number): Promise<string[]> {
  const { rows } = await store.adapter.executeAll<{ name: string | null }>(
    `SELECT n.name AS name FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL ORDER BY n.rowid ASC`,
    [subjectRowid],
  );
  return rows.map((r) => r.name ?? '');
}

async function rowidForUid(store: TestIssueStore, uid: string): Promise<number> {
  const node = await store.graph.getNodeByUid(uid);
  if (!node) throw new Error(`rowidForUid: no live node for uid ${uid}`);
  return node.id;
}

describe('embed write path (write/embedding-observer.ts, via create/update/delete)', () => {
  let dir: string;
  let store: TestIssueStore;

  afterEach(async () => {
    if (store) await store.close();
    if (dir) removeTestIssueStoreDir(dir);
  });

  async function openStore(label: string): Promise<{ store: TestIssueStore; projectUid: string }> {
    dir = freshTmpDir(label);
    store = await openTestIssueStore(`${dir}/backlog.db`);
    const { projectUid } = await seedProject(store, 'proj');
    return { store, projectUid };
  }

  it('awaitEmbed:true on create makes the vector present immediately after createIssue returns, with exactly one embedding_upserted audit row', async () => {
    const { store, projectUid } = await openStore('embed-await-create');
    const { backend, vectors } = makeFakeBackend();
    const handle = withEmbedding(store, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'await embed on create', body: 'the vector must be present the instant createIssue resolves', by: 'filer',
      awaitEmbed: true,
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, outcome.uid);
    expect(vectors.has(rowid)).toBe(true);

    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(1);
  });

  it('an embed scheduled WITHOUT awaitEmbed never blocks createIssue, and still lands correctly once it settles', async () => {
    const { store, projectUid } = await openStore('embed-fire-and-forget');
    const gate = deferred();
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    const handle = withEmbedding(store, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'fire and forget', body: 'createIssue must not wait on this', by: 'filer',
      // awaitEmbed deliberately OMITTED.
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, outcome.uid);

    // Deterministic, not a timing race: createIssue already returned above,
    // and `gate` has never been resolved — the scheduled embed cannot
    // possibly have completed yet.
    expect(vectors.has(rowid)).toBe(false);
    expect((await auditActionsFor(store, rowid)).filter((a) => a.startsWith('embedding_'))).toHaveLength(0);

    // Release the gate and let the fire-and-forget round-trip settle. There
    // is no store-level drain to await directly (see file header), so this
    // is a bounded poll rather than a hard synchronization point.
    gate.resolve();
    await vi.waitFor(() => {
      expect(vectors.has(rowid)).toBe(true);
    });
    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);
  });

  it('an embed completed via awaitEmbed:true survives a store close/reopen — the embedding_upserted audit row is durable, proven by reopening the store', async () => {
    const { store: store1, projectUid } = await openStore('embed-durability-positive');
    const { backend, vectors } = makeFakeBackend();
    const handle = withEmbedding(store1, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'durability check', body: 'the embedding outcome must persist across a close/reopen', by: 'filer',
      awaitEmbed: true,
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store1, outcome.uid);
    expect(vectors.has(rowid)).toBe(true);

    await store1.close();

    // Reopen a FRESH store handle on the SAME file. The `embedding_upserted`
    // audit row is real graph state committed by `scheduleIssueEmbedding`'s
    // own follow-up transaction — independent of the closed handle — so
    // seeing it here is a genuine "did it survive the store closing" proof,
    // not an artifact of the same process/handle still being alive.
    store = await openTestIssueStore(`${dir}/backlog.db`); // reassigned so afterEach closes THIS handle
    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);
  });

  it('negative control: a fire-and-forget embed whose store closes before it settles is genuinely lost — reopening shows no audit row and no vector (there is no drain to have waited for it)', async () => {
    const { store: store1, projectUid } = await openStore('embed-durability-negative');
    const gate = deferred(); // deliberately NEVER released before the store closes
    const { backend, vectors } = makeFakeBackend({ gate: gate.promise });
    const handle = withEmbedding(store1, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'negative control', body: 'closing before the embed settles must lose it — there is no drain', by: 'filer',
      // awaitEmbed deliberately OMITTED — fire-and-forget.
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store1, outcome.uid);

    // Close immediately. Deterministic, not a race: `gate` is never
    // resolved, so the scheduled embed is still stuck inside
    // `embedDocument`'s own `await opts.gate` — it cannot possibly have
    // reached `upsertVector` or its own follow-up audit transaction yet.
    await store1.close();

    store = await openTestIssueStore(`${dir}/backlog.db`); // reassigned so afterEach closes THIS handle
    expect(vectors.has(rowid)).toBe(false); // the round trip never got far enough to upsert
    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(0); // lost — no drain exists to have waited for it
  });

  it('a backend rejecting upsertVector with a dimension-mismatch-shaped error also degrades honestly and never corrupts state', async () => {
    const { store, projectUid } = await openStore('embed-wrong-dim');
    const { backend, vectors } = makeFakeBackend({
      rejectUpsertWith: new Error('embedding dimension mismatch: model produced a 5-dimensional vector but the configured space is 4-dimensional'),
    });
    const handle = withEmbedding(store, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'wrong dimension', body: 'a structural dimension mismatch must never corrupt state', by: 'filer',
      awaitEmbed: true,
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, outcome.uid);
    const reread = await store.graph.getNode(rowid);
    expect(reread).not.toBeNull();
    expect(vectors.has(rowid)).toBe(false);

    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(0);
  });

  it('updating the body re-embeds (deletes the old vector, upserts the new one); updating an unrelated field does not', async () => {
    const { store, projectUid } = await openStore('embed-reembed-on-body-change');
    const { backend, vectors, embedDocumentCalls } = makeFakeBackend();
    const handle = withEmbedding(store, backend);

    const created = await createIssue(handle, {
      project: projectUid, title: 'original title', body: 'original body', by: 'filer', awaitEmbed: true,
    });
    expect(created.created).toBe(true);
    if (!created.created || !created.uid) throw new Error('expected created');
    const oldUid = created.uid;
    const oldRowid = await rowidForUid(store, oldUid);
    const callsAfterCreate = embedDocumentCalls();
    expect(vectors.has(oldRowid)).toBe(true);

    // Updating an UNRELATED field (`assignee` — a plain metadata scalar with
    // no edge, per `IUpdateIssueInput`'s own doc comment) is a pure `touch`:
    // no new node, no content change, so no re-embed.
    await update(handle, { uid: oldUid, by: 'filer', assignee: 'someone-else' });
    expect(embedDocumentCalls()).toBe(callsAfterCreate); // no re-embed
    expect(vectors.has(oldRowid)).toBe(true); // untouched

    // Updating `body` mints a fresh node (`supersede`) — the OLD node's
    // vector is deleted and the NEW node's is upserted from the new content.
    const upsertsBefore = (await auditActionsFor(store, oldRowid)).filter((a) => a === 'embedding_upserted').length;
    const updated = await update(handle, { uid: oldUid, by: 'filer', body: 'a brand new body', awaitEmbed: true });
    expect(updated.changed).toContain('body');
    const newUid = updated.uid;
    expect(newUid).not.toBe(oldUid);
    const newRowid = await rowidForUid(store, newUid);

    expect(embedDocumentCalls()).toBe(callsAfterCreate + 1); // exactly one re-embed
    expect(vectors.has(oldRowid)).toBe(false); // old vector dropped
    expect(vectors.has(newRowid)).toBe(true); // new vector present

    const oldActions = await auditActionsFor(store, oldRowid);
    expect(oldActions.filter((a) => a === 'embedding_deleted')).toHaveLength(1);
    // Exactly ONE new `embedding_upserted` for this write. The count is a
    // DELTA, not an absolute: a supersede carries the pre-edit audit trail
    // forward onto the successor (otherwise the issue's history stays bound to
    // a node no listing returns and vanishes), so the inherited rows are
    // present too. Asserting `upsertsBefore + 1` keeps both teeth — it goes red
    // if the carry-forward stops, and red if one write emits two audits.
    const newActions = await auditActionsFor(store, newRowid);
    expect(newActions.filter((a) => a === 'embedding_upserted')).toHaveLength(upsertsBefore + 1);
  });

  it('a backend whose embedDocument REJECTS does not fail the create — the item is still created and readable, and the failure is audited honestly', async () => {
    const { store, projectUid } = await openStore('embed-reject');
    const { backend, vectors } = makeFakeBackend({ rejectEmbedWith: new Error('fake embedding backend is down') });
    const handle = withEmbedding(store, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'embed backend down', body: 'the create must still succeed', by: 'filer',
      awaitEmbed: true, // deterministic: wait for the (swallowed) failure to settle
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, outcome.uid);
    const reread = await store.graph.getNode(rowid);
    expect(reread).not.toBeNull();
    expect(vectors.has(rowid)).toBe(false); // embed never landed

    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(0); // never a false success row
  });

  it('a backend whose upsertVector throws (embed succeeded, persist did not) also degrades honestly and never corrupts state', async () => {
    const { store, projectUid } = await openStore('embed-upsert-fails');
    const { backend, vectors } = makeFakeBackend({ rejectUpsertWith: new Error('fake vector store is unwritable') });
    const handle = withEmbedding(store, backend);

    const outcome = await createIssue(handle, {
      project: projectUid, title: 'vector store down', body: 'a persist failure must never corrupt state', by: 'filer',
      awaitEmbed: true,
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created || !outcome.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, outcome.uid);
    const reread = await store.graph.getNode(rowid);
    expect(reread).not.toBeNull();
    expect(vectors.has(rowid)).toBe(false);

    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(0);
  });

  it('soft-delete drops the vector and records exactly one embedding_deleted audit row', async () => {
    const { store, projectUid } = await openStore('embed-soft-delete');
    const { backend, vectors } = makeFakeBackend();
    const handle = withEmbedding(store, backend);

    const created = await createIssue(handle, {
      project: projectUid, title: 'to be deleted', body: 'the vector must be dropped on soft-delete', by: 'filer',
      awaitEmbed: true,
    });
    expect(created.created).toBe(true);
    if (!created.created || !created.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, created.uid);
    expect(vectors.has(rowid)).toBe(true);

    const outcome = await deleteIssue(handle, { uid: created.uid, by: 'filer', reason: 'no longer needed', awaitEmbed: true });
    expect(outcome.invalidated).toBe(true);
    expect(vectors.has(rowid)).toBe(false);

    const actions = await auditActionsFor(store, rowid);
    expect(actions.filter((a) => a === 'embedding_deleted')).toHaveLength(1);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(2); // embedding_upserted (create) + embedding_deleted (this delete)
  });

  it('with NO embedding backend configured, create/update/delete work exactly as before and schedule nothing', async () => {
    const { store, projectUid } = await openStore('embed-unconfigured');
    const handle = withEmbedding(store, undefined);

    const created = await createIssue(handle, {
      project: projectUid, title: 'no rag here', body: 'must work exactly as before RAG existed', by: 'filer',
      awaitEmbed: true, // even the "await" knob must be a harmless no-op
    });
    expect(created.created).toBe(true);
    if (!created.created || !created.uid) throw new Error('expected created');
    const rowid = await rowidForUid(store, created.uid);
    expect((await auditActionsFor(store, rowid)).filter((a) => a.startsWith('embedding_'))).toHaveLength(0);

    const updated = await update(handle, { uid: created.uid, by: 'filer', body: 'still no rag', awaitEmbed: true });
    expect(updated.changed).toContain('body');
    const newRowid = await rowidForUid(store, updated.uid);
    expect((await auditActionsFor(store, newRowid)).filter((a) => a.startsWith('embedding_'))).toHaveLength(0);

    const deleted = await deleteIssue(handle, { uid: updated.uid, by: 'filer', reason: 'cleanup', awaitEmbed: true });
    expect(deleted.invalidated).toBe(true);
    expect((await auditActionsFor(store, newRowid)).filter((a) => a.startsWith('embedding_'))).toHaveLength(0);
  });
});
