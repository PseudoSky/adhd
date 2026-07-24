/**
 * ids.ts — human-id allocation (DESIGN.md §2.4).
 *
 * `allocateHumanIdAndInsert` (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001)
 * runs id-resolution AND the caller's insert in ONE `.immediate()`
 * transaction — the two used to be split across separate transactions
 * (compute-next-id here, commit; insert-the-node later, in a second,
 * unrelated write), which left a genuine TOCTOU window: two concurrent
 * `createItem` calls for the same `(repo, family)` could each compute the
 * SAME "max + 1" before either one's node existed yet, and both mint a node
 * claiming the identical humanId — a silent violation of the "humanId is
 * unique within (repo, family)" invariant (SPEC.md §4.1), discovered via the
 * MIGRATION.md §3.3 20-writer scale test (13/20 unique ids under real
 * concurrency, not 20). Wrapping BOTH steps in the same `BEGIN IMMEDIATE`
 * transaction — the identical mechanism `mutate-metadata.ts`/`claim.ts`
 * already rely on for their own CAS correctness — closes the window: no two
 * concurrent `.immediate()` transactions can interleave.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, type BacklogNodeMeta } from './mapping.js';
import { withImmediateRetry } from './immediate-retry.js';

function computeNextHumanId(store: GraphBacklogStore, repo: string, family: string): string {
  const existing = store.graph.queryNodes({
    kind: 'generic',
    tags: [BACKLOG_ITEM_TAG],
    namespace: repo,
    metadata: { family },
  });
  let max = 0;
  for (const node of existing) {
    const meta = node.metadata as Partial<BacklogNodeMeta> | undefined;
    const match = /-(\d+)$/.exec(meta?.humanId ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${family}-${String(max + 1).padStart(3, '0')}`;
}

function findLiveByHumanId(store: GraphBacklogStore, repo: string, humanId: string): NodeRecord | null {
  // BUG-BACKLOG-IMPORT-TOMBSTONE-BLOCKS-RECREATE-001: this is the authoritative
  // in-transaction existence check `createItemNode` relies on to decide
  // create-vs-idempotent-noop. It MUST agree with `findItemNode`
  // (query.ts) — which filters `isLiveBacklogItemNode` — or the two disagree:
  // a soft-deleted (invalidated) node with this humanId made this function
  // return the TOMBSTONE, so the insert short-circuited to created:false, but
  // every downstream lookup (`updateItemNode`→`requireItemNode`→`findItemNode`)
  // then failed with "backlog item not found" because those DO filter dead
  // nodes — leaving a real markdown item (e.g. a distinct bug reusing an id a
  // prior supersede/merge tombstoned) permanently unimportable. A soft-deleted
  // id must read as ABSENT here so re-import resurrects it as a fresh live node.
  const nodes = store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId } });
  return (
    nodes.find(
      (n) => isLiveBacklogItemNode(n) && (n.metadata as Partial<BacklogNodeMeta> | undefined)?.humanId === humanId,
    ) ?? null
  );
}

/**
 * Resolves the humanId to insert under (either `idOverride`, re-verified for
 * an already-live node, or the next auto-allocated `family-NNN`) and invokes
 * `insert(humanId, existing)` — ALL inside one retried `.immediate()`
 * transaction, so no other concurrent `.immediate()`-wrapped write can
 * interleave between "the id was resolved" and "a node claiming it landed".
 * `existing` is the already-live node under `idOverride` (re-checked HERE,
 * not just by an earlier, racy caller-side check) — `insert` is expected to
 * short-circuit on a non-null `existing` exactly like `createItemNode`'s
 * documented idempotent-reimport behavior, but now race-free.
 */
export function allocateHumanIdAndInsert<T>(
  store: GraphBacklogStore,
  repo: string,
  family: string,
  idOverride: string | undefined,
  insert: (humanId: string, existing: NodeRecord | null) => T,
): T {
  return withImmediateRetry(() =>
    store.db
      .transaction(() => {
        if (idOverride) {
          const existing = findLiveByHumanId(store, repo, idOverride);
          return insert(idOverride, existing);
        }
        const humanId = computeNextHumanId(store, repo, family);
        return insert(humanId, null);
      })
      .immediate(),
  );
}

/**
 * @deprecated kept ONLY as a standalone id-generator for any caller that does
 * not need an atomic insert alongside it. `createItemNode`/
 * `supersedeItemNode` no longer use this (see `allocateHumanIdAndInsert`'s
 * doc comment for why splitting allocate-then-insert-later is unsafe under
 * concurrency). Still correct in isolation — just NOT TOCTOU-safe when the
 * caller's own insert happens in a separate, later transaction.
 */
export function allocateHumanId(store: GraphBacklogStore, repo: string, family: string): string {
  return withImmediateRetry(() => store.db.transaction(() => computeNextHumanId(store, repo, family)).immediate());
}
