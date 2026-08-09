/**
 * audit-log.ts — DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: a real, persisted,
 * append-only `transition`/`claim` event log.
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
  const eventNodeId = await store.graph.writeNode(content, {
    kind: 'generic',
    name: `audit-event::${repo}::${humanId}::${at}`,
    tags: [BACKLOG_AUDIT_EVENT_TAG],
    namespace: repo,
    metadata: meta as unknown as Record<string, unknown>,
  });
  await store.graph.writeEdge(eventNodeId, itemNodeId, 'DERIVED_FROM');
}

export async function queryAuditEvents(store: GraphBacklogStore, itemNodeId: number): Promise<AuditTrailEntry[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_AUDIT_EVENT_TAG], metadata: { itemNodeId } });
  return nodes
    .map((n) => n.metadata as unknown as AuditEventMeta | undefined)
    .filter((m): m is AuditEventMeta => m !== undefined && m.itemNodeId === itemNodeId)
    .map((m) => ({ at: m.at, kind: m.kind, detail: m.detail }))
    .sort((a, b) => a.at.localeCompare(b.at));
}
