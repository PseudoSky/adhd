/**
 * embed-backfill.spec.ts — real-component tests for `embed-backfill.ts`'s
 * orchestration logic (candidate discovery, skip rules, failure reporting,
 * idempotent re-run).
 *
 * **Real components, one faked seam.** A real `GraphBackend` + real
 * `StoreAdapter` (`openTestIssueStore`, Turso), a real `TursoVectorBackend`
 * (`@adhd/sox-vector-store`) sharing the SAME adapter, and the REAL
 * `runEmbedBackfill` calling the REAL `scheduleIssueEmbedding`/
 * `composeEmbedText` (`write/embedding-observer.ts`) — nothing about the
 * write layer is mocked. The ONLY faked seam is the embedding MODEL itself
 * (`embedDocument`), mirroring `write/embedding-observer.spec.ts`'s own
 * precedent and STATE.md's documented, scoped authorization to mock
 * embedding cost in tests. Every assertion reads back either the real
 * vector row (`vec.get`) or the real `embedding_failed` audit row the write
 * layer actually persisted.
 *
 * The REAL fastembed/onnxruntime model + a real query-path (`view:'similar'`)
 * verification is exercised separately, against the actual cutover file, via
 * `embed-backfill-cli.ts`/`embed-verify-sample.ts` run as real processes —
 * out of scope for this fast, deterministic unit-level suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTursoVectorStore, type TursoVectorBackend } from '@adhd/sox-vector-store';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../../src/test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../../src/test/helpers/tmp-store.js';
import { executeWriteTransaction, writeNodeTx } from '../../src/write/tx.js';
import type { IEmbeddingBackend } from '../../src/write/tx.js';
import { runEmbedBackfill, type IEmbedBackfillDisposition } from './embed-backfill.js';

const MODEL_ID = 'embed-backfill-spec-test-model';
const DIM = 3;

function makeVec(seed: number): Float32Array {
  return Float32Array.from([seed, seed + 1, seed + 2]);
}

/** A real-`TursoVectorBackend`-backed `IEmbeddingBackend`, with an optional forced embed failure — same shape as `embedding-observer.spec.ts`'s `makeEmbeddingBackend`. */
function makeEmbeddingBackend(
  vec: TursoVectorBackend,
  opts?: { failFor?: (content: string) => boolean }
): IEmbeddingBackend {
  return {
    modelId: MODEL_ID,
    async embedDocument(content: string): Promise<Float32Array> {
      if (opts?.failFor?.(content)) {
        throw new Error(`makeEmbeddingBackend: forced failure for ${JSON.stringify(content)}`);
      }
      let sum = 0;
      for (let i = 0; i < content.length; i += 1) sum += content.charCodeAt(i);
      return makeVec(sum % 97);
    },
    async upsertVector(nodeRowid: number, vector: Float32Array): Promise<void> {
      await vec.upsert(nodeRowid, vector, { modelId: MODEL_ID, dim: DIM });
    },
    async deleteVector(nodeRowid: number): Promise<void> {
      await vec.delete(nodeRowid, MODEL_ID);
    },
  };
}

async function seedIssue(
  store: TestIssueStore,
  opts: { name: string; content: string; superseded?: boolean; invalid?: boolean }
): Promise<{ rowid: number; uid: string }> {
  const node = await executeWriteTransaction(store, (tx) =>
    writeNodeTx(tx, { kind: 'issue', name: opts.name, content: opts.content })
  );
  if (opts.superseded) {
    await store.adapter.executeRun('UPDATE node SET is_superseded = 1 WHERE rowid = ?', [
      node.rowid,
    ]);
  }
  if (opts.invalid) {
    await store.adapter.executeRun("UPDATE node SET t_invalid = '2020-01-01T00:00:00.000Z' WHERE rowid = ?", [
      node.rowid,
    ]);
  }
  return node;
}

let dir: string;
let store: TestIssueStore;
let vec: TursoVectorBackend;

beforeEach(async () => {
  dir = freshTmpDir('embed-backfill');
  store = await openTestIssueStore(`${dir}/issues.db`);
  vec = await openTursoVectorStore(store.adapter, { dim: DIM, modelId: MODEL_ID });
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('runEmbedBackfill — candidate discovery', () => {
  it('embeds every live issue, skips superseded/invalidated ones entirely', async () => {
    const live = await seedIssue(store, { name: 'live-1', content: 'body-1' });
    await seedIssue(store, { name: 'superseded-1', content: 'body-2', superseded: true });
    await seedIssue(store, { name: 'invalid-1', content: 'body-3', invalid: true });

    const embedding = makeEmbeddingBackend(vec);
    const report = await runEmbedBackfill({ handle: store, embedding });

    expect(report.totalLiveIssues).toBe(1);
    expect(report.candidatesToEmbed).toBe(1);
    expect(report.embeddedThisRun).toBe(1);
    expect(report.failed).toEqual([]);

    const stored = await vec.get(live.rowid, MODEL_ID);
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual(
      Array.from(await embedding.embedDocument('live-1\nbody-1'))
    );
  });

  it('skips an issue whose title AND body are both blank, reporting it distinctly', async () => {
    await seedIssue(store, { name: '', content: '' });
    const withText = await seedIssue(store, { name: 't', content: 'b' });

    const embedding = makeEmbeddingBackend(vec);
    const report = await runEmbedBackfill({ handle: store, embedding });

    expect(report.totalLiveIssues).toBe(2);
    expect(report.emptyContentSkipped).toBe(1);
    expect(report.candidatesToEmbed).toBe(1);
    expect(report.embeddedThisRun).toBe(1);
    expect(await vec.get(withText.rowid, MODEL_ID)).not.toBeNull();
  });

  it('a dry run computes the candidate set but writes nothing', async () => {
    const issue = await seedIssue(store, { name: 't', content: 'b' });

    const embedding = makeEmbeddingBackend(vec);
    const report = await runEmbedBackfill({ handle: store, embedding, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.candidatesToEmbed).toBe(1);
    expect(report.embeddedThisRun).toBe(0);
    expect(await vec.get(issue.rowid, MODEL_ID)).toBeNull();
  });

  it('a second run is idempotent — already-embedded items are skipped, not re-embedded', async () => {
    const issue = await seedIssue(store, { name: 't', content: 'b' });
    const embedding = makeEmbeddingBackend(vec);

    const first = await runEmbedBackfill({ handle: store, embedding });
    expect(first.embeddedThisRun).toBe(1);

    const second = await runEmbedBackfill({ handle: store, embedding });
    expect(second.alreadyEmbedded).toBe(1);
    expect(second.candidatesToEmbed).toBe(0);
    expect(second.embeddedThisRun).toBe(0);
    void issue;
  });

  it('a failed embed is reported with the real embedding_failed audit note, and other items still succeed', async () => {
    const ok = await seedIssue(store, { name: 'ok', content: 'fine' });
    const bad = await seedIssue(store, { name: 'bad', content: 'boom' });

    const embedding = makeEmbeddingBackend(vec, {
      failFor: (content) => content.includes('boom'),
    });
    const report = await runEmbedBackfill({ handle: store, embedding });

    expect(report.embeddedThisRun).toBe(1);
    expect(await vec.get(ok.rowid, MODEL_ID)).not.toBeNull();

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.uid).toBe(bad.uid);
    expect(report.failed[0]!.error).toContain('forced failure');
    expect(await vec.get(bad.rowid, MODEL_ID)).toBeNull();
  });

  it('dispositions are reported via onItemDispositioned for every candidate, exactly once each', async () => {
    await seedIssue(store, { name: 'a', content: 'b' });
    const embedding = makeEmbeddingBackend(vec);
    const seen: Array<{ uid: string; disposition: IEmbedBackfillDisposition }> = [];

    await runEmbedBackfill({
      handle: store,
      embedding,
      onItemDispositioned: (info) => seen.push({ uid: info.uid, disposition: info.disposition }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.disposition).toBe('embedded');
  });

  it('respects a bounded concurrency setting and still embeds every candidate', async () => {
    for (let i = 0; i < 12; i += 1) {
      await seedIssue(store, { name: `issue-${i}`, content: `body-${i}` });
    }
    const embedding = makeEmbeddingBackend(vec);
    const report = await runEmbedBackfill({ handle: store, embedding, concurrency: 3 });

    expect(report.totalLiveIssues).toBe(12);
    expect(report.embeddedThisRun).toBe(12);
    expect(report.failed).toEqual([]);
  });
});
