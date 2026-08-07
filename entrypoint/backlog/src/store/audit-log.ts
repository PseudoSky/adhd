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
 * actual state change, and losing an event write (vanishingly unlikely,
 * uncaught here deliberately) is a logging gap, never a correctness bug in
 * the item's real state the way losing an id-allocation atomically would be
 * (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001 — a different class of
 * problem entirely).
 */
import type { AuditTrailEntry } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';

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
 */
export function writeAuditEvent(
  store: GraphBacklogStore,
  itemNodeId: number,
  repo: string,
  humanId: string,
  kind: AuditTrailEntry['kind'],
  detail: Record<string, unknown>,
): void {
  const at = new Date().toISOString();
  const meta: AuditEventMeta = { itemNodeId, kind, at, detail };
  const content = `audit-event::${repo}::${humanId}::${kind}::${at}::${Math.random().toString(36).slice(2)}`;
  const eventNodeId = store.graph.writeNode(content, {
    kind: 'generic',
    name: `audit-event::${repo}::${humanId}::${at}`,
    tags: [BACKLOG_AUDIT_EVENT_TAG],
    namespace: repo,
    metadata: meta as unknown as Record<string, unknown>,
  });
  store.graph.writeEdge(eventNodeId, itemNodeId, 'DERIVED_FROM');
}

/** Every persisted event for `itemNodeId`, oldest first — ready to merge
 *  straight into `auditTrail()`'s `history` array. */
export function queryAuditEvents(store: GraphBacklogStore, itemNodeId: number): AuditTrailEntry[] {
  const nodes = store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_AUDIT_EVENT_TAG], metadata: { itemNodeId } });
  return nodes
    .map((n) => n.metadata as unknown as AuditEventMeta | undefined)
    .filter((m): m is AuditEventMeta => m !== undefined && m.itemNodeId === itemNodeId)
    .map((m) => ({ at: m.at, kind: m.kind, detail: m.detail }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
