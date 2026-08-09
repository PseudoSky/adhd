/**
 * ids.ts — human-id allocation (DESIGN.md §2.4).
 *
 * `allocateHumanIdAndInsert` (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001)
 * runs id-resolution AND the caller's insert in ONE `mode: 'immediate'`
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
 * concurrent `mode: 'immediate'` transactions can interleave.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { AmbiguousHumanIdError, InvalidArgumentError } from '../model.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, type BacklogNodeMeta } from './mapping.js';
import { withImmediateRetry } from './immediate-retry.js';

async function computeNextHumanId(store: GraphBacklogStore, repo: string, family: string): Promise<string> {
  if (typeof family !== 'string' || family.trim().length === 0) {
    throw new InvalidArgumentError(
      'family',
      `backlog: cannot allocate a humanId for repo=${JSON.stringify(repo)} — "family" is required and must be a ` +
        `non-empty string, received ${JSON.stringify(family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }
  const existing = await store.graph.queryNodes({
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

async function findLiveByHumanId(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord | null> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId } });
  const live = nodes.filter(
    (n) => isLiveBacklogItemNode(n) && (n.metadata as Partial<BacklogNodeMeta> | undefined)?.humanId === humanId,
  );
  if (live.length > 1) {
    throw new AmbiguousHumanIdError(repo, humanId, live.map((n) => n.id));
  }
  return live[0] ?? null;
}

export async function allocateHumanIdAndInsert<T>(
  store: GraphBacklogStore,
  repo: string,
  family: string,
  idOverride: string | undefined,
  insert: (humanId: string, existing: NodeRecord | null) => Promise<T>,
): Promise<T> {
  return withImmediateRetry(() =>
    store.adapter.transaction(async () => {
      if (idOverride) {
        const existing = await findLiveByHumanId(store, repo, idOverride);
        return insert(idOverride, existing);
      }
      const humanId = await computeNextHumanId(store, repo, family);
      return insert(humanId, null);
    }, { mode: 'immediate' })
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
export async function allocateHumanId(store: GraphBacklogStore, repo: string, family: string): Promise<string> {
  return withImmediateRetry(() =>
    store.adapter.transaction(async () => computeNextHumanId(store, repo, family), { mode: 'immediate' })
  );
}
