/**
 * ids.ts — human-id allocation (DESIGN.md §2.4). Reuses the exact same
 * correctness mechanism as claims (BEGIN IMMEDIATE, mutate-metadata.ts) so no
 * two concurrent `createItem` calls for the same `(repo, family)` can ever be
 * issued the same `-NNN` suffix.
 */
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { BACKLOG_ITEM_TAG, type BacklogNodeMeta } from './mapping.js';

export function allocateHumanId(store: GraphBacklogStore, repo: string, family: string): string {
  return store.db
    .transaction(() => {
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
    })
    .immediate();
}
