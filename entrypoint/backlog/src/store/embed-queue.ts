/**
 * embed-queue.ts — RAG-SPEC.md §2.1/§2.2: the embedding write path's Phase B
 * (`scheduleEmbed`) plus the per-store durability tracking that makes it safe
 * for a short-lived process.
 *
 * ## Phase B — after commit, off the write lock (§2.1)
 *
 * `createItemNode`/`updateItemNode` (crud.ts) write the node inside a CAS
 * transaction with NO embedding call inside it (Phase A) — the node is
 * immediately FTS-searchable the instant that transaction commits.
 * `scheduleEmbed` is called strictly AFTER that commit, never from inside the
 * mutation updater passed to `mutateMetadata`: the
 * updater callback runs INSIDE `store.adapter.transaction(fn, { mode:
 * 'immediate' })`, which holds the single write lock this whole package
 * serializes every mutation through (mutate-metadata.ts's header doc). A
 * `SemanticBackend.embedDocument()` call is a network/ONNX round trip to a
 * separate process (RAG-SPEC.md §0) — parking that INSIDE the write-lock
 * transaction would hold the lock for the embed's entire latency and
 * serialize every other write in the store behind a single ONNX inference
 * call, defeating the entire point of Turso's async, off-lock vector path.
 * So every call site in crud.ts awaits the transaction/updater call to
 * return (i.e. commit) FIRST, then calls `scheduleEmbed` on the result.
 *
 * ## Never throws into the caller (§2.5)
 *
 * A failed embed (backend down, transient network error, or a
 * `PermanentEmbeddingDimensionError` from a misconfigured provider) degrades
 * that ONE item to FTS-only reachability — it is never allowed to fail the
 * write that already committed. `scheduleEmbed`'s returned promise therefore
 * NEVER rejects; every failure is caught internally, logged, and the backfill
 * sweep (§7) is the designated repair path.
 */
import { getSemanticBackend, markSemanticVectorSpacePopulated } from './semantic-search.js';

import { mutateMetadata } from './mutate-metadata.js';

/**
 * Marker prefix for the trailing provenance comment appended to stored bodies.
 * Rehomed here from the deleted mapping module: this and `stripContentMarker`
 * below were that module's only surviving consumers, and a 275-line module is
 * not worth keeping alive for one regex.
 */
const CONTENT_MARKER_PREFIX = 'adhd-backlog:';

/**
 * Strips the trailing `<!-- adhd-backlog:... -->` provenance comment so the
 * text handed to the embedder is the author's prose and nothing else --
 * otherwise every item carries an identical marker suffix that pulls their
 * vectors toward each other.
 */
function stripContentMarker(content: string): string {
  return content.replace(new RegExp(`\\n\\n<!--\\s*${CONTENT_MARKER_PREFIX}[^>]*-->\\s*$`), '');
}
import type { GraphBacklogStore } from './graph-backlog-store.js';

/**
 * Per-store set of in-flight embed promises, keyed by the `GraphBacklogStore`
 * object itself via a `WeakMap` — never a field bolted onto the store
 * interface — so a closed/garbage-collected store's tracking set is reclaimed
 * automatically and this module stays fully independent of
 * `GraphBacklogStore`'s own shape.
 */
const pending = new WeakMap<GraphBacklogStore, Set<Promise<void>>>();

function pendingSetFor(store: GraphBacklogStore): Set<Promise<void>> {
  let set = pending.get(store);
  if (!set) {
    set = new Set();
    pending.set(store, set);
  }
  return set;
}

/**
 * Registers `promise` as in-flight for `store`, untracking it the instant it
 * settles (success OR failure). `scheduleEmbed` itself guarantees its
 * returned promise never rejects (§2.5), but this tracker makes no
 * assumption about that — untracking on either outcome means a hypothetical
 * future caller that DOES let a promise reject can never wedge the set open
 * with a permanently-"in-flight" entry that `flushEmbeds` would then hang
 * on forever.
 */
function trackEmbed(store: GraphBacklogStore, promise: Promise<void>): void {
  const set = pendingSetFor(store);
  set.add(promise);
  const untrack = (): void => {
    set.delete(promise);
  };
  promise.then(untrack, untrack);
}

/**
 * RAG-SPEC.md §2.2 — bounded, deterministic drain of every embed currently in
 * flight for `store`, INCLUDING one scheduled DURING the drain itself (a
 * re-embed racing a concurrent edit, or a caller that fires several writes in
 * a loop without awaiting each one). A single `Promise.all` over one snapshot
 * would miss anything added to the set between that snapshot and the await
 * resolving. This instead loops: snapshot the current set, await all of it,
 * then check again — the loop terminates the first time a snapshot comes
 * back empty. It is bounded in practice because each iteration can only pick
 * up NEW promises that code already running chose to schedule; there is no
 * generator here that can add work forever. No `sleep`/wall-clock anywhere —
 * every iteration is driven by real promise settlement (AGENTS.md §7.3).
 *
 * Exported both as the public `GraphBacklogStore.flushEmbeds()` surface
 * (wired in `graph-backlog-store.ts`) and directly here for tests.
 */
export async function flushEmbeds(store: GraphBacklogStore): Promise<void> {
  for (;;) {
    const set = pending.get(store);
    if (!set || set.size === 0) return;
    const snapshot = [...set];
    await Promise.allSettled(snapshot);
  }
}

/**
 * RAG-SPEC.md §2.1 Phase B / §2.4 / §2.5 — embeds `content` (the exact string
 * handed to `writeNode`/the raw-SQL `content` column update, marker and all —
 * `stripContentMarker` removes the trailing `<!-- adhd-backlog:... -->`
 * uniqueness-hash-collision guard before the text ever reaches the model,
 * per this file's header and `mapping.ts`'s `stripContentMarker` doc
 * comment) and upserts the resulting vector for `nodeId`.
 *
 * - No-op (not an error, not even logged) when no backend is configured —
 *   RAG is opt-in (RAG-SPEC.md §1.6); an unconfigured build must behave
 *   exactly as it did before this module existed.
 * - NEVER called from inside a mutation transaction — see this file's header.
 * - NEVER throws or rejects into the caller (§2.5) — every failure (a
 *   transient backend-down error, or a structural
 *   `PermanentEmbeddingDimensionError`) is caught, logged, and left for the
 *   backfill sweep (§7) to repair. The item stays fully readable and
 *   FTS-searchable either way.
 * - §2.4 provenance: on a SUCCESSFUL upsert, stamps `embedModel` onto the
 *   node's metadata (`BacklogNodeMeta.embedModel`, mapping.ts) with
 *   `backend.modelId` — the seam's own RESOLVED model id, never a config
 *   default — via `mutateMetadata`, run immediately after the vector upsert
 *   settles so a failed embed never produces a stamped-but-vectorless row.
 *
 * The returned promise is tracked in `store`'s in-flight set (so
 * `flushEmbeds`/`closeGraphBacklogStore` can drain it) and is safe to `await`
 * directly when a caller passed `awaitEmbed: true` (RAG-SPEC.md §2.2) — it
 * never rejects, so awaiting it is always safe regardless of embed outcome.
 */
export function scheduleEmbed(store: GraphBacklogStore, nodeId: number, content: string): Promise<void> {
  const backend = getSemanticBackend();
  if (backend === null) return Promise.resolve();

  const text = stripContentMarker(content);
  const promise = (async (): Promise<void> => {
    try {
      const vec = await backend.embedDocument(text);
      await backend.upsertVector(nodeId, vec);
      // BUG-045 — the space is provably non-empty from here on, so the
      // read-side §5a gates open without needing a process restart. This
      // is the ONE place a vector reaches the space (the write path and the
      // §7 backfill both funnel through here), so it is the only place the
      // flag needs flipping.
      markSemanticVectorSpacePopulated();
      // §2.4 — provenance stamp, written right after the upsert it describes
      // settles. The `SemanticBackend` seam exposes no joint-transaction
      // primitive spanning its own vector-store adapter call and this node's
      // graph metadata, so "same transaction" is honoured as tightly as the
      // seam allows: immediately, sequentially, with nothing else touching
      // this node's provenance in between.
      await mutateMetadata(store, nodeId, (meta) => ({ ...meta, embedModel: backend.modelId }));
    } catch (err) {
      // §2.5 — never propagate. FTS reachability is unaffected; backfill (§7)
      // repairs this node's vector on its next sweep.
      console.error(
        `backlog: scheduleEmbed failed for node ${nodeId} (item stays FTS-only reachable; repaired by backfill): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  })();

  trackEmbed(store, promise);
  return promise;
}
