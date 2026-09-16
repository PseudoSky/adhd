/**
 * embedding-observer.spec.ts — real-component tests for the write layer's
 * post-commit embedding hook (SPEC.md §4a's embedding-audit exception, §4b
 * FEAT-021, §9 AC-3's embedding clause, §9 AC-4).
 *
 * **Real components, one faked seam.** A real `GraphBackend` + real
 * `StoreAdapter` (`openTestIssueStore`, Turso), a real `TursoVectorBackend`
 * (`@adhd/sox-vector-store`) sharing the SAME adapter (never a second
 * connection), and real `createIssue`/`update`/`deleteIssue` write verbs.
 * The ONLY faked seam is the embedding MODEL itself (`embedDocument`) — a
 * test-pinned, content-derived vector function, matching `semantic.spec.ts`'s
 * own precedent and AGENTS.md §7 ("mock only the external boundary... never
 * the thing under test"). Every assertion below reads back either the real
 * vector row (`vec.get(rowid, modelId)`) or the real `audits` edge/`audit`
 * node the write layer actually persisted — never an implementation-shape
 * check like "was upsert() called" (the call counters below are used only
 * for the negative "nothing extra happened" assertions, always alongside a
 * real state read).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTursoVectorStore, type TursoVectorBackend, type VectorSpace } from '@adhd/sox-vector-store';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import { createIssue, type IDuplicateScanHandle } from './create-issue.js';
import { update } from './update.js';
import { deleteIssue } from './delete.js';
import type { IEmbeddingBackend } from './tx.js';
import { openTestIssueStore, removeTestIssueStoreDir, seedProject, type TestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

const DIM = 3;
const MODEL_ID = 'embedding-observer-spec-test-model';
const SPACE: VectorSpace = { modelId: MODEL_ID, dim: DIM };

function makeVec(seed: number): Float32Array {
  return Float32Array.from([seed, seed + 1, seed + 2]);
}

/** A real `TursoVectorBackend`-backed `IEmbeddingBackend`, with an optional forced embed failure and call counters for the negative "nothing extra happened" assertions below. */
function makeEmbeddingBackend(
  vec: TursoVectorBackend,
  opts?: { failEmbedFor?: (content: string) => boolean; failUpsert?: boolean },
) {
  const backend = {
    modelId: MODEL_ID,
    upsertCount: 0,
    deleteCount: 0,
    async embedDocument(content: string): Promise<Float32Array> {
      if (opts?.failEmbedFor?.(content)) {
        throw new Error(`makeEmbeddingBackend: forced failure for content ${JSON.stringify(content)}`);
      }
      // Deterministic, content-derived vector — no randomness, so re-embedding
      // identical content always yields an identical vector.
      let sum = 0;
      for (let i = 0; i < content.length; i += 1) sum += content.charCodeAt(i);
      return makeVec(sum % 97);
    },
    async upsertVector(nodeRowid: number, vector: Float32Array): Promise<void> {
      backend.upsertCount += 1;
      // A vector STORE that rejects is a distinct failure from an embedding
      // MODEL that rejects: the embed already succeeded, so the degrade path
      // is reached with a valid vector in hand and nothing to persist it to.
      if (opts?.failUpsert) throw new Error('makeEmbeddingBackend: forced vector-store failure');
      await vec.upsert(nodeRowid, vector, SPACE);
    },
    async deleteVector(nodeRowid: number): Promise<void> {
      backend.deleteCount += 1;
      await vec.delete(nodeRowid, MODEL_ID);
    },
  };
  return backend satisfies IEmbeddingBackend & { upsertCount: number; deleteCount: number };
}

/** Opens a real store + a real `TursoVectorBackend` sharing its adapter — no `embedding`/`search` wiring yet, since building an `IEmbeddingBackend` needs `vec` first (see {@link withEmbedding}). */
async function openWriteAndVec(dir: string): Promise<{ writeHandle: TestIssueStore; vec: TursoVectorBackend }> {
  const writeHandle = await openTestIssueStore(`${dir}/issues.db`);
  const vec = await openTursoVectorStore(writeHandle.adapter, { dim: SPACE.dim, modelId: SPACE.modelId });
  return { writeHandle, vec };
}

/**
 * Builds the FINAL handle object literal `createIssue`/`update`/`deleteIssue`
 * are called with — `embedding`/`search` are `readonly` on
 * `IWriteStoreHandle`/`IDuplicateScanHandle` by design (§4b's "opt-in, never
 * silently reconfigurable mid-flight" posture), so every test bakes its
 * configuration in at construction time via this helper rather than mutating
 * a live handle's field.
 */
function withEmbedding(
  writeHandle: TestIssueStore,
  opts?: { embedding?: IEmbeddingBackend; search?: IDuplicateScanHandle['search'] },
): TestIssueStore & IDuplicateScanHandle {
  return {
    ...writeHandle,
    close: writeHandle.close.bind(writeHandle),
    embedding: opts?.embedding,
    search: opts?.search,
  };
}

/** Reads back the ordered list of `audit.name` values (the action) recorded via a live `audits` edge FROM `subjectRowid` — the real graph read this file's assertions use instead of any spy. */
async function auditActionsFor(handle: TestIssueStore, subjectRowid: number): Promise<string[]> {
  const { rows } = await handle.adapter.executeAll<{ name: string | null }>(
    `SELECT n.name AS name FROM edge e JOIN node n ON n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL ORDER BY n.rowid ASC`,
    [subjectRowid],
  );
  return rows.map((r) => r.name ?? '');
}

async function rowidForUid(handle: TestIssueStore, uid: string): Promise<number> {
  const node = await handle.graph.getNodeByUid(uid);
  if (!node) throw new Error(`rowidForUid: no live node for uid ${uid}`);
  return node.id;
}

let dir: string;

beforeEach(() => {
  dir = freshTmpDir('embedding-observer');
});

afterEach(() => {
  removeTestIssueStoreDir(dir);
});

describe('createIssue — on-write embedding (§4b, §9 AC-4)', () => {
  it('a genuine create produces the vector via the embedding backend, and exactly one embedding_upserted audit row', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const result = await createIssue(handle, {
      by: 'tester', project: projectUid, title: 'title-a', body: 'body-a', awaitEmbed: true,
    });
    expect(result.created).toBe(true);
    if (!result.created || !result.uid) throw new Error('expected created');

    const rowid = await rowidForUid(handle, result.uid);
    const stored = await vec.get(rowid, MODEL_ID);
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual(Array.from(await backend.embedDocument('title-a\nbody-a')));

    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(1);

    await writeHandle.close();
  });

  it('an unconfigured embedding backend is a true no-op — no vector, no embedding_* audit row, create still succeeds', async () => {
    const { writeHandle } = await openWriteAndVec(dir);
    const handle = withEmbedding(writeHandle); // no embedding backend at all
    const { projectUid } = await seedProject(handle, 'proj-a');

    const result = await createIssue(handle, { by: 'tester', project: projectUid, title: 't', body: 'b', awaitEmbed: true });
    expect(result.created).toBe(true);
    if (!result.created || !result.uid) throw new Error('expected created');

    const rowid = await rowidForUid(handle, result.uid);
    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(0);

    await writeHandle.close();
  });

  it('duplicateAction:"abort" (suppressed create) never touches embedding — no issue node exists to embed', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const handle = withEmbedding(writeHandle, { embedding: backend }); // no `search` mounted — scanForDuplicates always returns [] regardless, isolating this test to the abort branch's own embedding behavior.
    const { projectUid } = await seedProject(handle, 'proj-a');

    const first = await createIssue(handle, { by: 'tester', project: projectUid, title: 'dup', body: 'dup-body', awaitEmbed: true });
    expect(first.created).toBe(true);

    // Exactly the one genuine create's upsert — no phantom second call.
    expect(backend.upsertCount).toBe(1);
    await writeHandle.close();
  });

  it('duplicateAction:"comment" writes zero issue rows and schedules no embedding at all', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const search = new StoreSearchBackend(vec, writeHandle.graph);
    const handle = withEmbedding(writeHandle, { embedding: backend, search: { backend: search, embedQuery: async () => makeVec(5) } });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const target = await createIssue(handle, { by: 'tester', project: projectUid, title: 'orig', body: 'orig-body' });
    expect(target.created).toBe(true);
    if (!target.created || !target.uid) throw new Error('expected created');
    const targetRowid = await rowidForUid(handle, target.uid);
    // Directly place an exact-match vector for the scan's pinned query embedding — deterministically clears `dedupe_threshold` regardless of the on-write embed's own (already-passed) upsert above.
    await vec.upsert(targetRowid, makeVec(5), SPACE);

    const beforeUpserts = backend.upsertCount;
    const commentResult = await createIssue(handle, {
      by: 'tester', project: projectUid, title: 'orig', body: 'orig-body', duplicateAction: 'comment', awaitEmbed: true,
    });
    expect(commentResult.created).toBe(false);
    expect(commentResult.commentedOn).toBeDefined();

    // No NEW embedding call happened for the comment branch.
    expect(backend.upsertCount).toBe(beforeUpserts);

    await writeHandle.close();
  });

  it('a failed embed degrades to an embedding_failed audit row and never fails the create itself', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec, { failEmbedFor: () => true });
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const result = await createIssue(handle, { by: 'tester', project: projectUid, title: 't', body: 'b', awaitEmbed: true });
    expect(result.created).toBe(true);
    if (!result.created || !result.uid) throw new Error('expected created');

    const rowid = await rowidForUid(handle, result.uid);
    const stored = await vec.get(rowid, MODEL_ID);
    expect(stored).toBeNull();

    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(1);

    await writeHandle.close();
  });

  it('a failing vector STORE (embed succeeded, persist did not) also degrades to embedding_failed and never fails the create', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    // Distinct from the test above: `embedDocument` SUCCEEDS here and only
    // `upsertVector` throws. That is the half of the round trip the other
    // test cannot reach, and it is the likelier production failure — a model
    // that answers fine while the store behind it is unwritable.
    const backend = makeEmbeddingBackend(vec, { failUpsert: true });
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const result = await createIssue(handle, {
      by: 'tester', project: projectUid, title: 't', body: 'b', awaitEmbed: true,
    });

    // The issue is fully committed and readable even though its vector is not.
    expect(result.created).toBe(true);
    if (!result.created || !result.uid) throw new Error('expected created');

    const rowid = await rowidForUid(handle, result.uid);
    expect(await vec.get(rowid, MODEL_ID)).toBeNull();

    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a === 'embedding_failed')).toHaveLength(1);
    // Never a false success row for a write that did not land.
    expect(actions.filter((a) => a === 'embedding_upserted')).toHaveLength(0);

    await writeHandle.close();
  });
});

describe('update — on-write re-embedding (§4b, §9 AC-4)', () => {
  it("a body-changing update (supersede) deletes the OLD node's vector and upserts the NEW node's, each with its own audit row", async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const created = await createIssue(handle, { by: 'tester', project: projectUid, title: 'orig-title', body: 'orig-body', awaitEmbed: true });
    if (!created.created || !created.uid) throw new Error('expected created');
    const oldUid = created.uid;
    const oldRowid = await rowidForUid(handle, oldUid);
    expect(await vec.get(oldRowid, MODEL_ID)).not.toBeNull();

    const outcome = await update(handle, { uid: oldUid, by: 'tester', body: 'new-body', awaitEmbed: true });
    expect(outcome.changed).toContain('body');
    const newUid = outcome.uid;
    expect(newUid).not.toBe(oldUid);
    const newRowid = await rowidForUid(handle, newUid);

    // OLD node's vector is gone — never left stale for `searchRanked` to
    // surface a phantom, unopenable "issue" (embedding-observer.ts's own
    // doc comment on this scope decision).
    expect(await vec.get(oldRowid, MODEL_ID)).toBeNull();
    // NEW node's vector is present, composed from the NEW title+body.
    const newVec = await vec.get(newRowid, MODEL_ID);
    expect(newVec).not.toBeNull();
    expect(Array.from(newVec!)).toEqual(Array.from(await backend.embedDocument('orig-title\nnew-body')));

    const oldActions = await auditActionsFor(handle, oldRowid);
    expect(oldActions.filter((a) => a === 'embedding_deleted')).toHaveLength(1);
    const newActions = await auditActionsFor(handle, newRowid);
    expect(newActions.filter((a) => a === 'embedding_upserted')).toHaveLength(1);

    await writeHandle.close();
  });

  it("a title-only touch (no body change) schedules NO re-embed at all — parity with the library's own writeNode-only observer trigger", async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const created = await createIssue(handle, { by: 'tester', project: projectUid, title: 'orig-title', body: 'orig-body', awaitEmbed: true });
    if (!created.created || !created.uid) throw new Error('expected created');
    const rowid = await rowidForUid(handle, created.uid);
    const upsertsAfterCreate = backend.upsertCount;

    const outcome = await update(handle, { uid: created.uid, by: 'tester', title: 'new-title', awaitEmbed: true });
    expect(outcome.changed).toEqual(['title']);
    expect(outcome.uid).toBe(created.uid); // no supersede — identity unchanged

    // No additional upsert/delete calls happened for the touch.
    expect(backend.upsertCount).toBe(upsertsAfterCreate);
    expect(backend.deleteCount).toBe(0);

    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(1); // only the original create's embedding_upserted

    await writeHandle.close();
  });
});

describe('deleteIssue — vector removal on invalidate (§9 AC-4)', () => {
  it('invalidating an issue removes its vector and records exactly one embedding_deleted audit row', async () => {
    const { writeHandle, vec } = await openWriteAndVec(dir);
    const backend = makeEmbeddingBackend(vec);
    const handle = withEmbedding(writeHandle, { embedding: backend });
    const { projectUid } = await seedProject(handle, 'proj-a');

    const created = await createIssue(handle, { by: 'tester', project: projectUid, title: 't', body: 'b', awaitEmbed: true });
    if (!created.created || !created.uid) throw new Error('expected created');
    const rowid = await rowidForUid(handle, created.uid);
    expect(await vec.get(rowid, MODEL_ID)).not.toBeNull();

    const outcome = await deleteIssue(handle, { uid: created.uid, by: 'tester', reason: 'no longer needed', awaitEmbed: true });
    expect(outcome.invalidated).toBe(true);

    expect(await vec.get(rowid, MODEL_ID)).toBeNull();
    const actions = await auditActionsFor(handle, rowid);
    expect(actions.filter((a) => a === 'embedding_deleted')).toHaveLength(1);
    expect(actions.filter((a) => a.startsWith('embedding_'))).toHaveLength(2); // embedding_upserted (create) + embedding_deleted (this delete)

    await writeHandle.close();
  });
});
