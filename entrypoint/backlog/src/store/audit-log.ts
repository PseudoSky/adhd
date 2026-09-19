/**
 * audit-log.ts — DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: a real, persisted,
 * append-only `transition`/`claim` event log. Before this, `auditTrail()`
 * derived history from durable fields only (`notes`/`citations`, both
 * genuinely append-only already) plus a synthetic `created` entry — every
 * past `status`/`claimedBy` value was overwritten in place by `touch()`'s
 * wholesale metadata replace (DESIGN.md §14 point 4), so a transition or
 * claim/renew/release was never independently recorded once superseded by
 * the next one. SPEC.md §5.6 documents `AuditTrailEntry.kind` as including
 * `'transition'`/`'claim'` — this module is what actually makes those kinds
 * real, not just a type-level promise.
 *
 * Each event is its OWN small `kind:'generic'` node (tagged
 * `BACKLOG_AUDIT_EVENT_TAG`), linked to the item via a `DERIVED_FROM` edge
 * (event -> item, matching this package's existing "chunk derived from
 * parent" edge-direction convention) — never written INTO the item's own
 * `meta`, so it is immune to `touch()`'s replace-not-merge semantics by
 * construction. Written OUTSIDE `mutateMetadata`'s own `.immediate()`
 * transaction (after it commits) — an audit event never gates or races the
 * actual state change, and losing an event write is a logging gap, never a
 * correctness bug in the item's real state the way losing an id-allocation
 * atomically would be (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001 — a
 * different class of problem entirely).
 *
 * BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001. That "logging gap, never
 * a correctness bug" contract was the stated intent but was NOT implemented:
 * nothing caught the write, so a busy/locked bounce here propagated straight
 * out of `claimItemNode`/`transitionStatusNode` to the caller — AFTER
 * `mutateMetadata` had already committed. Measured: the audit write bounces,
 * `claimItem` throws `database is locked`, and the item reads back
 * `claimedBy: 'agent:probe'`. The caller concludes it failed to claim an item
 * it now owns and walks away, leaving the item locked until the stale-claim
 * timeout — the worst shape of ownership divergence this package exists to
 * prevent. It surfaced as a "flaky" 1-in-5 failure in `concurrency-scale.spec.ts`,
 * mis-attributed in that file's own comments to the test's timing margin and
 * once "fixed" by widening a timeout; the stack proves otherwise, landing in
 * `SqliteGraphBackend.writeNode` under `claimItem`, ~194ms in — a quarter of a
 * SINGLE `withImmediateRetry` attempt at that busy_timeout, so it never went
 * through the retry wrapper at all.
 *
 * The write is therefore now (a) routed through the SAME `withImmediateRetry`
 * wrapper as every other write in this package, so a transient bounce is
 * retried rather than lost, and (b) contained — if it still fails after the
 * retry budget, the error is traced via `@adhd/sox-telemetry` and swallowed,
 * making the docstring's contract real. It is never a bare `catch {}`: a lost
 * audit event is a real observability gap and must be visible as one.
 */
import { log } from '@adhd/sox-telemetry';
import type { AuditTrailEntry } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { withImmediateRetry } from './immediate-retry.js';

export const BACKLOG_AUDIT_EVENT_TAG = 'backlog-audit-event';

interface AuditEventMeta {
  itemNodeId: number;
  kind: AuditTrailEntry['kind'];
  at: string;
  detail: Record<string, unknown>;
}

/**
 * Records one `transition`/`claim` event for the item at `itemNodeId`.
 * `content` is a uniqueness-marker string (mirrors `buildNodeContent()`'s
 * own reasoning, `mapping.ts`) — `@adhd/sox-graph-store`'s global
 * content-hash dedup would otherwise be free to collapse two
 * byte-identical events (e.g. two items independently transitioning
 * `OPEN`→`IN_PROGRESS` with no `by`/`reason` at all) into ONE node.
 *
 * NEVER THROWS (BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001). By the
 * time this runs, the caller's state change is already COMMITTED — so any
 * error escaping here would misreport a durable success as a failure. The
 * write is retried on busy-shaped contention like every other write in this
 * package, and a genuine, sustained failure is traced and contained.
 */
export async function writeAuditEvent(
  store: GraphBacklogStore,
  itemNodeId: number,
  repo: string,
  humanId: string,
  kind: AuditTrailEntry['kind'],
  detail: Record<string, unknown>,
): Promise<void> {
  const at = new Date().toISOString();
  const meta: AuditEventMeta = { itemNodeId, kind, at, detail };
  const content = `audit-event::${repo}::${humanId}::${kind}::${at}::${Math.random().toString(36).slice(2)}`;
  try {
    const eventNodeId = await withImmediateRetry(() =>
      store.graph.writeNode(content, {
        kind: 'generic',
        name: `audit-event::${repo}::${humanId}::${at}`,
        tags: [BACKLOG_AUDIT_EVENT_TAG],
        namespace: repo,
        metadata: meta as unknown as Record<string, unknown>,
      }),
    );
    await withImmediateRetry(() => store.graph.writeEdge(eventNodeId, itemNodeId, 'DERIVED_FROM'));
  } catch (err) {
    // Contained, never silent: the caller's state change is durable and must
    // be reported as the success it is, but a dropped audit event is a real
    // observability gap and has to be visible as one.
    log.error('backlog.audit_event.write_failed', {
      repo,
      humanId,
      itemNodeId,
      kind,
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: unknown } | undefined)?.code,
    });
  }
}

/** Every persisted event for `itemNodeId`, oldest first — ready to merge
 *  straight into `auditTrail()`'s `history` array. */
export async function queryAuditEvents(store: GraphBacklogStore, itemNodeId: number): Promise<AuditTrailEntry[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_AUDIT_EVENT_TAG], metadata: { itemNodeId } });
  return nodes
    .map((n) => n.metadata as unknown as AuditEventMeta | undefined)
    .filter((m): m is AuditEventMeta => m?.itemNodeId === itemNodeId)
    .map((m) => ({ at: m.at, kind: m.kind, detail: m.detail }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
