/**
 * mutate-metadata.ts — THE single atomic read-modify-write primitive
 * (DESIGN.md §4.3). Every metadata-touching operation in the whole tool
 * (claim, renew, release, citation, note, transition, priority, assignment)
 * funnels through this function: read the CURRENT full node inside a
 * `BEGIN IMMEDIATE` transaction, compute a full new metadata object in
 * application code, and pass the COMPLETE object to `touch()` — correct
 * regardless of `touch()`'s merge semantics (which DESIGN.md §14 point 4
 * confirms is wholesale REPLACE, not deep-merge, making this the ONLY safe
 * pattern).
 *
 * `.immediate()` (not the default deferred `BEGIN`) is load-bearing: a
 * deferred transaction only acquires SQLite's write lock at the moment its
 * FIRST write statement executes, leaving a window where two processes can
 * both pass a read-check under their own deferred transaction before either
 * escalates to a write lock. `BEGIN IMMEDIATE` acquires the RESERVED lock at
 * transaction start, so a second process's own `.immediate()` call blocks
 * (up to `busy_timeout`) rather than interleaving (DESIGN.md §3).
 *
 * The `.immediate()` call is wrapped in `withImmediateRetry` (bounded,
 * jittered exponential backoff on `SQLITE_BUSY`/`SQLITE_BUSY_TIMEOUT` only —
 * DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001) so a blocked write that outlasts
 * one `busy_timeout` window gets a few more chances before the caller (a
 * one-shot CLI process, or an MCP/HTTP request) sees a crash.
 */
import type { GraphBacklogStore } from './graph-backlog-store.js';
import type { BacklogNodeMeta } from './mapping.js';
import { withImmediateRetry } from './immediate-retry.js';

export class NotFoundError extends Error {
  constructor(public readonly nodeId: number) {
    super(`backlog item not found or invalidated: node ${nodeId}`);
    this.name = 'NotFoundError';
  }
}

export function mutateMetadata<M = BacklogNodeMeta>(
  store: GraphBacklogStore,
  nodeId: number,
  updater: (current: M) => M
): M {
  return withImmediateRetry(() =>
    store.db
      .transaction(() => {
        const node = store.graph.getNode(nodeId);
        if (!node || node.tInvalid) throw new NotFoundError(nodeId);
        const current = (node.metadata ?? {}) as M;
        const next = updater(current);
        store.graph.touch(nodeId, { metadata: next as Record<string, unknown> });
        return next;
      })
      .immediate()
  );
}
