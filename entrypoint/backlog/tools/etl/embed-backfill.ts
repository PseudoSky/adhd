/**
 * embed-backfill.ts — backfills the on-write embedding vector for every LIVE
 * `issue` node that does not already have one (STATE.md's B2b gap: the
 * cutover ETL, `run-etl.ts`, never runs an embedding step, so every item in
 * a freshly cut-over store starts with zero vectors).
 *
 * **Never a second embedding pipeline.** This module does NOT compose embed
 * text, call an embedding provider, or write a vector itself — it calls the
 * SAME real functions the on-write path (`create`/`update`) already calls:
 * `composeEmbedText` (the exact `${title}\n${body}` composition,
 * `write/embedding-observer.ts`) and `scheduleIssueEmbedding` (the exact
 * embed-or-delete-then-audit round trip that function runs post-commit for
 * every genuine create/body-changing update). The only things owned HERE are
 * (1) finding which live issues are missing a vector and (2) fanning the
 * real per-item call out with bounded concurrency — orchestration, not
 * embedding logic.
 *
 * **Resolving the embedding backend is the CALLER's job, not this module's.**
 * `IEmbedBackfillOptions.embedding` is an already-constructed
 * `IEmbeddingBackend` — production callers (`embed-backfill-cli.ts`) build it
 * via `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers`, the SAME
 * function `api.ts`'s `writeHandle` uses for every real write. Tests build a
 * fake one directly, mirroring `write/embedding-observer.spec.ts`'s own
 * precedent (mock only the embedding MODEL, never the write-layer functions
 * this module calls through it).
 */
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { GraphBackend, TypePolicy } from '@adhd/sox-graph-store';
import { TursoVectorBackend } from '@adhd/sox-vector-store';
import {
  composeEmbedText,
  scheduleIssueEmbedding,
} from '../../src/write/embedding-observer.js';
import type { IEmbeddingBackend, IWriteStoreHandle } from '../../src/write/tx.js';

/** The slice of an open store this module needs — matches `IEtlStoreHandle` (`store-bootstrap.ts`) and `TestIssueStore` (`src/test/helpers/open-test-issue-store.ts`) structurally, so either can be passed directly. */
export interface IEmbedBackfillHandle {
  readonly adapter: StoreAdapter;
  readonly graph: GraphBackend;
  readonly typePolicy: TypePolicy;
}

export type IEmbedBackfillDisposition =
  | 'embedded'
  | 'already-embedded'
  | 'empty-content'
  | 'failed';

export interface IEmbedBackfillOptions {
  handle: IEmbedBackfillHandle;
  /** Already-resolved on-write embedding backend — see this module's own header on why resolving it is out of scope here. */
  embedding: IEmbeddingBackend;
  /** The `actor` recorded on every `embedding_upserted`/`embedding_failed` audit row this run produces. Default `'etl-embed-backfill'`. */
  actor?: string;
  /** Bounded fan-out width for the per-item `scheduleIssueEmbedding` calls. Default 4 — local ONNX (fastembed) inference is CPU-bound, not I/O-bound, so unbounded concurrency buys little and risks starving the single adapter connection's busy-timeout retries under write contention. */
  concurrency?: number;
  /** Compute the candidate set and report it WITHOUT writing anything (no embed call, no vector, no audit row). Default `false`. */
  dryRun?: boolean;
  /** Observability hook — called once per candidate, always AFTER that item's own outcome is known. */
  onItemDispositioned?: (info: {
    uid: string;
    rowid: number;
    disposition: IEmbedBackfillDisposition;
  }) => void;
}

export interface IEmbedBackfillFailure {
  uid: string;
  rowid: number;
  error: string;
}

export interface IEmbedBackfillReport {
  /** Every live (`t_invalid IS NULL`, not superseded) `issue` node in the store at the time this ran. */
  totalLiveIssues: number;
  /** Already had a vector under `embedding.modelId` before this run started — untouched. */
  alreadyEmbedded: number;
  /** `composeEmbedText(name, content)` produced the empty string (both title and body blank) — no meaningful text to embed. Reported, never silently dropped. */
  emptyContentSkipped: number;
  /** The number of items this run attempted to embed — `totalLiveIssues - alreadyEmbedded - emptyContentSkipped`, computed even on a dry run (dry run just never dispatches them). */
  candidatesToEmbed: number;
  /** Successful `scheduleIssueEmbedding` upserts, verified by reading the vector back (never assumed from a non-throwing call — `scheduleIssueEmbedding` never throws either way, §4b). Always 0 on a dry run. */
  embeddedThisRun: number;
  /** Items whose vector was still absent after `scheduleIssueEmbedding` resolved — the embed/store round trip degraded to `embedding_failed` (§4b). Always empty on a dry run. */
  failed: IEmbedBackfillFailure[];
  dryRun: boolean;
}

const DEFAULT_ACTOR = 'etl-embed-backfill';
const DEFAULT_CONCURRENCY = 4;

interface ICandidateRow {
  rowid: number;
  uid: string;
  name: string | null;
  content: string | null;
}

/** Bounded worker-pool fan-out — `concurrency` workers pull from a shared index cursor until the queue is drained. No external dependency; small enough to own here rather than pull in a scheduling library for one call site. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  async function drain(): Promise<void> {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, drain));
}

/**
 * Reads back the most recent `embedding_failed` audit row's recorded note
 * for `uid` — the same `err.message` `scheduleIssueEmbedding` logged and
 * persisted (`write/embedding-observer.ts`'s `note` field, stored as both
 * `node.content` and `node.meta.note`). Never re-derives or guesses the
 * failure reason; if no such row exists (should be unreachable — a missing
 * vector after `scheduleIssueEmbedding` resolves always leaves one) the
 * caller gets an honest "no note captured" fallback instead of a silent
 * `undefined`.
 */
async function latestEmbeddingFailureNote(
  handle: IEmbedBackfillHandle,
  uid: string
): Promise<string | undefined> {
  const row = await handle.adapter.executeGet<{ content: string | null }>(
    `SELECT content FROM node
     WHERE kind = 'audit' AND name = 'embedding_failed' AND json_extract(meta, '$.target_uid') = ?
     ORDER BY rowid DESC LIMIT 1`,
    [uid]
  );
  return row?.content ?? undefined;
}

/**
 * Runs the backfill: every live `issue` node without a vector under
 * `options.embedding.modelId` gets `scheduleIssueEmbedding`'d exactly like a
 * real `create`/`update` would embed it, with bounded concurrency.
 * Idempotent and safe to re-run — a re-run only ever touches whatever is
 * STILL missing a vector (checked fresh via `TursoVectorBackend.iter`, never
 * assumed from a prior run's report).
 */
export async function runEmbedBackfill(
  options: IEmbedBackfillOptions
): Promise<IEmbedBackfillReport> {
  const { handle, embedding } = options;
  const actor = options.actor ?? DEFAULT_ACTOR;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const dryRun = options.dryRun ?? false;

  const { rows: candidates } = await handle.adapter.executeAll<ICandidateRow>(
    `SELECT rowid, uid, name, content FROM node
     WHERE kind = 'issue' AND t_invalid IS NULL AND (is_superseded IS NULL OR is_superseded = 0)
     ORDER BY rowid`
  );

  // Reuses the caller's adapter connection directly — never a second
  // connection to the file (`AsyncVectorBackend`'s own doc comment,
  // `@adhd/sox-vector-store/dist/turso.d.ts`). `ensureSpace` for this model
  // has already run as a side effect of resolving `options.embedding`
  // (`write/bootstrap.ts`'s `deriveMembers`), so the model's vector table
  // is guaranteed to exist before `iter` below queries it.
  const vec = new TursoVectorBackend(handle.adapter);
  const existingIds = new Set<number>();
  for await (const row of vec.iter(embedding.modelId)) existingIds.add(row.id);

  let alreadyEmbedded = 0;
  let emptyContentSkipped = 0;
  const work: ICandidateRow[] = [];

  for (const row of candidates) {
    if (existingIds.has(row.rowid)) {
      alreadyEmbedded += 1;
      options.onItemDispositioned?.({
        uid: row.uid,
        rowid: row.rowid,
        disposition: 'already-embedded',
      });
      continue;
    }
    const text = composeEmbedText(row.name ?? '', row.content ?? '');
    if (text.length === 0) {
      emptyContentSkipped += 1;
      options.onItemDispositioned?.({
        uid: row.uid,
        rowid: row.rowid,
        disposition: 'empty-content',
      });
      continue;
    }
    work.push(row);
  }

  let embeddedThisRun = 0;
  const failed: IEmbedBackfillFailure[] = [];

  if (!dryRun) {
    const writeHandle: IWriteStoreHandle = {
      adapter: handle.adapter,
      typePolicy: handle.typePolicy,
      embedding,
    };
    await runPool(work, concurrency, async (row) => {
      const text = composeEmbedText(row.name ?? '', row.content ?? '');
      // The real on-write round trip — embed, upsert/delete, and its own
      // post-commit audit row — never re-implemented here.
      await scheduleIssueEmbedding(writeHandle, {
        action: 'upsert',
        subjectRowid: row.rowid,
        subjectUid: row.uid,
        actor,
        content: text,
      });
      const stored = await vec.get(row.rowid, embedding.modelId);
      if (stored) {
        embeddedThisRun += 1;
        options.onItemDispositioned?.({
          uid: row.uid,
          rowid: row.rowid,
          disposition: 'embedded',
        });
      } else {
        const error =
          (await latestEmbeddingFailureNote(handle, row.uid)) ??
          'embedding_failed audit row recorded, no note captured';
        failed.push({ uid: row.uid, rowid: row.rowid, error });
        options.onItemDispositioned?.({
          uid: row.uid,
          rowid: row.rowid,
          disposition: 'failed',
        });
      }
    });
  }

  return {
    totalLiveIssues: candidates.length,
    alreadyEmbedded,
    emptyContentSkipped,
    candidatesToEmbed: work.length,
    embeddedThisRun,
    failed,
    dryRun,
  };
}
