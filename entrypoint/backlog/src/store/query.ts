/**
 * query.ts — read-side operations: listItems/stats/spotlight/readyItems/
 * blockers/dependencyGraph/topoOrder/staleClaims (DESIGN.md §2.5/§13), plus
 * `findItemNode`, the shared (repo, humanId) -> NodeRecord lookup every other
 * store module needs.
 */
import type { NodeFilter, NodeRecord } from '@adhd/sox-graph-store';
import type { AuditTrailEntry, AuditTrailResult, BacklogFilter, BacklogItem, DependencyGraph, StatsScope, TopoOrderResult } from '../model.js';
import { BacklogItemNotFoundError, isTerminalStatus } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { BACKLOG_ITEM_TAG, buildNodeName, isLiveBacklogItemNode, sanitizeFtsQuery, toBacklogItem, type BacklogNodeMeta } from './mapping.js';
import { queryAuditEvents } from './audit-log.js';

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function nodeFilterFromBacklogFilter(filter: BacklogFilter): NodeFilter {
  const tags = [BACKLOG_ITEM_TAG];
  if (filter.kind) tags.push(filter.kind);
  if (filter.tags) tags.push(...filter.tags);

  const metadata: Record<string, unknown> = {};
  if (filter.family) metadata['family'] = filter.family;
  if (filter.priority) metadata['priority'] = filter.priority;
  if (filter.plan) metadata['plan'] = filter.plan;
  if (filter.importedFrom) metadata['importedFrom'] = filter.importedFrom;
  if (filter.assignee) metadata['assignee'] = filter.assignee;
  if (filter.claimedBy) metadata['claimedBy'] = filter.claimedBy;
  if (filter.status && filter.status !== 'open' && filter.status !== 'closed') {
    metadata['status'] = filter.status;
  }

  const nodeFilter: NodeFilter = { kind: 'generic', tags, tagsMatchAll: true };
  if (filter.repo !== undefined) nodeFilter.namespace = filter.repo;
  if (filter.projectPath !== undefined) nodeFilter.projectPath = filter.projectPath;
  if (Object.keys(metadata).length > 0) nodeFilter.metadata = metadata;
  return nodeFilter;
}

function applyOpenClosedFilter(items: BacklogItem[], filter: BacklogFilter): BacklogItem[] {
  if (filter.status === 'open') return items.filter((it) => !isTerminalStatus(it.status));
  if (filter.status === 'closed') return items.filter((it) => isTerminalStatus(it.status));
  return items;
}

/**
 * MIGRATION.md §2.2 root projection: keep only repo-level nodes — those with
 * neither a `projectPath` nor a `plan`. Applied at the NodeRecord layer so BOTH
 * `listItems` and `renderToMarkdown` (which map nodes independently) inherit it.
 * A metadata scan, not an indexed column filter, because it is an ABSENCE test
 * (two fields simultaneously unset) that `NodeFilter`'s AND-of-equals cannot
 * express. See `BacklogFilter.rootLevel`.
 */
function applyRootLevelFilter(nodes: NodeRecord[], filter: BacklogFilter): NodeRecord[] {
  if (!filter.rootLevel) return nodes;
  return nodes.filter((n) => {
    const m = n.metadata as Partial<BacklogNodeMeta> | undefined;
    return !m?.projectPath && !m?.plan;
  });
}

/** Raw NodeRecord query — used internally where the full node (not just the mapped BacklogItem) is needed. */
export function queryItemNodes(store: GraphBacklogStore, filter: BacklogFilter = {}): NodeRecord[] {
  if (filter.grep) {
    const nodeFilter = nodeFilterFromBacklogFilter({ ...filter, grep: undefined });
    // Sanitized — same FTS5-syntax-crash guard as crud.ts's dedupeScan
    // (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001): an unsanitized `grep` term
    // containing `-`/`:`/`(`/`)`/`"` crashes `searchNodes` outright.
    const ftsQuery = sanitizeFtsQuery(filter.grep);
    if (!ftsQuery) return [];
    const hits = store.graph.searchNodes(ftsQuery, {
      limit: filter.limit ?? 1000,
      filter: nodeFilter,
    });
    let live = applyRootLevelFilter(hits.filter(isLiveBacklogItemNode), filter);
    if (filter.offset) live = live.slice(filter.offset);
    return live;
  }
  const nodeFilter = nodeFilterFromBacklogFilter(filter);
  if (filter.limit !== undefined) nodeFilter.limit = filter.limit;
  if (filter.offset !== undefined) nodeFilter.offset = filter.offset;
  const nodes = store.graph.queryNodes(nodeFilter);
  return applyRootLevelFilter(nodes.filter(isLiveBacklogItemNode), filter);
}

export function listItems(store: GraphBacklogStore, filter: BacklogFilter = {}): BacklogItem[] {
  const nodes = queryItemNodes(store, filter);
  const items = nodes.map(toBacklogItem);
  return applyOpenClosedFilter(items, filter);
}

export function findItemNode(store: GraphBacklogStore, repo: string, humanId: string): NodeRecord | null {
  const name = buildNodeName(repo, humanId);
  const nodes = store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId } });
  const live = nodes.filter(isLiveBacklogItemNode);
  return live.find((n) => n.name === name) ?? live[0] ?? null;
}

function countByKey(items: BacklogItem[], keyFn: (item: BacklogItem) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function computeStats(store: GraphBacklogStore, scope: StatsScope = {}): import('../model.js').BacklogStats {
  const items = listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
  const open = items.filter((it) => !isTerminalStatus(it.status));
  const closed = items.filter((it) => isTerminalStatus(it.status));
  return {
    total: items.length,
    open: open.length,
    closed: closed.length,
    byStatus: countByKey(items, (it) => it.status),
    byKind: countByKey(items, (it) => it.kind),
    byFamily: countByKey(items, (it) => it.family),
    byPriority: countByKey(items, (it) => it.priority),
    byRepo: scope.repo === undefined ? countByKey(items, (it) => it.repo) : {},
  };
}

export function spotlight(store: GraphBacklogStore, scope: StatsScope = {}, limit = 20): BacklogItem[] {
  const items = listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'open' });
  const prioritized = items.filter((it) => it.priority !== undefined);
  prioritized.sort((a, b) => {
    const rankA = PRIORITY_RANK[a.priority ?? ''] ?? 4;
    const rankB = PRIORITY_RANK[b.priority ?? ''] ?? 4;
    return rankA - rankB || a.humanId.localeCompare(b.humanId);
  });
  return prioritized.slice(0, limit);
}

function dependsOnTargets(store: GraphBacklogStore, nodeId: number): NodeRecord[] {
  const edges = store.graph.getEdges({ src: nodeId, rel: 'DEPENDS_ON' });
  const targets: NodeRecord[] = [];
  for (const edge of edges) {
    const node = store.graph.getNode(edge.dst);
    if (node) targets.push(node);
  }
  return targets;
}

export function blockers(store: GraphBacklogStore, repo: string, humanId: string): BacklogItem[] {
  const node = findItemNode(store, repo, humanId);
  if (!node) return [];
  return dependsOnTargets(store, node.id)
    .filter((n) => !n.tInvalid)
    .map(toBacklogItem)
    .filter((it) => !isTerminalStatus(it.status));
}

export function readyItems(store: GraphBacklogStore, scope: StatsScope = {}): BacklogItem[] {
  const openItems = listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'open' });
  return openItems.filter((item) => {
    if (item.claimedBy) return false;
    const node = findItemNode(store, item.repo, item.humanId);
    if (!node) return false;
    const targets = dependsOnTargets(store, node.id).filter((n) => !n.tInvalid);
    return targets.every((t) => isTerminalStatus(toBacklogItem(t).status));
  });
}

export function dependencyGraph(store: GraphBacklogStore, scope: StatsScope = {}): DependencyGraph {
  const items = listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
  const nodes = items.map((it) => ({ humanId: it.humanId, title: it.title, status: it.status }));
  const edges: DependencyGraph['edges'] = [];
  for (const item of items) {
    const node = findItemNode(store, item.repo, item.humanId);
    if (!node) continue;
    for (const rel of ['DEPENDS_ON', 'RELATES_TO', 'PART_OF'] as const) {
      for (const edge of store.graph.getEdges({ src: node.id, rel })) {
        const dst = store.graph.getNode(edge.dst);
        if (!dst || dst.tInvalid) continue;
        const dstMeta = dst.metadata as { humanId?: string } | undefined;
        if (!dstMeta?.humanId) continue;
        edges.push({ from: item.humanId, to: dstMeta.humanId, rel });
      }
    }
  }
  return { nodes, edges };
}

export function topoOrder(store: GraphBacklogStore, scope: StatsScope = {}): TopoOrderResult {
  const graph = dependencyGraph(store, scope);
  const dependsOnEdges = graph.edges.filter((e) => e.rel === 'DEPENDS_ON');

  // adjacency: humanId -> set of humanIds it depends on (must complete first)
  const dependsOn = new Map<string, Set<string>>();
  for (const n of graph.nodes) dependsOn.set(n.humanId, new Set());
  for (const e of dependsOnEdges) dependsOn.get(e.from)?.add(e.to);

  // Kahn's algorithm over the "depends-on" relation: an item is emittable once
  // every item it depends on has already been emitted.
  const remaining = new Set(graph.nodes.map((n) => n.humanId));
  const order: string[] = [];
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const id of [...remaining].sort()) {
      const deps = dependsOn.get(id) ?? new Set();
      const allDepsEmitted = [...deps].every((d) => !remaining.has(d));
      if (allDepsEmitted) {
        order.push(id);
        remaining.delete(id);
        progressed = true;
      }
    }
  }

  if (remaining.size > 0) {
    // Extract one real cycle among the un-orderable remainder via DFS.
    const cycle = findCycle([...remaining], dependsOn);
    return { ok: false, cycle };
  }
  return { ok: true, order };
}

function findCycle(nodeIds: string[], dependsOn: Map<string, Set<string>>): string[] {
  const remaining = new Set(nodeIds);
  const visiting = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (!remaining.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of dependsOn.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    return null;
  }

  for (const id of nodeIds) {
    const found = visit(id);
    if (found) return found;
  }
  // Every remaining node fails Kahn's progress test, so a cycle MUST exist
  // among them; this is unreachable in practice but keeps the function total.
  return nodeIds;
}

export function staleClaims(store: GraphBacklogStore, maxAgeMin: number, scope: StatsScope = {}): BacklogItem[] {
  const items = listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
  const cutoffMs = maxAgeMin * 60_000;
  const now = Date.now();
  return items.filter((it) => {
    if (!it.claimedBy || !it.claimedAt) return false;
    // `>=`, not `>` (BUG-BACKLOG-STALE-CLAIMS-BOUNDARY-RACE-001, fixed here):
    // `maxAgeMin=0` means "stale as of right now" — age is NEVER negative, so
    // `>= 0` is the only comparison that's unconditionally true at the
    // boundary. A strict `>` made this flaky: `claimItem`'s write and this
    // read both resolve via `Date.now()` (millisecond resolution), and on a
    // fast/quiescent run they can land in the SAME millisecond, making
    // `now - claimedAtMs === 0` — `0 > 0` is false (item wrongly reported
    // fresh), `0 >= 0` is true (correct). Reproduced via `client.spec.ts`'s
    // "staleClaims surfaces claims older than maxAgeMin" test, which failed
    // intermittently only when run as part of the FULL `nx test backlog`
    // suite (never in isolation) — the exact signature of a sub-millisecond
    // race, not a logic bug tied to any one input.
    return now - Date.parse(it.claimedAt) >= cutoffMs;
  });
}

/**
 * Bi-temporal history + supersession chain (SPEC.md §5.6, DESIGN.md §2.3).
 * DEVIATION: the store does not persist a full mutation event log (no
 * separate transitions/claims-over-time table) — `history` is therefore
 * honestly derived from the durable fields we DO keep (a synthetic
 * `created` entry, every real `note`, every real `citation`), not a
 * fabricated replay of every status/claim change. Citation entries reuse
 * `item.updatedAt` as their timestamp since `Citation` carries no `at` field
 * of its own. Filed as DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001.
 */
export function auditTrail(store: GraphBacklogStore, repo: string, humanId: string): AuditTrailResult {
  const node = findItemNode(store, repo, humanId);
  if (!node) throw new BacklogItemNotFoundError(repo, humanId);
  const item = toBacklogItem(node);

  const history: AuditTrailEntry[] = [
    { at: item.createdAt, kind: 'created', detail: { title: item.title, repo: item.repo } },
  ];
  for (const citation of item.citations) {
    history.push({ at: item.updatedAt, kind: 'citation', detail: { ...citation } });
  }
  for (const note of item.notes) {
    history.push({ at: note.at, kind: 'note', detail: { by: note.by, text: note.text } });
  }
  // DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: real, persisted transition/claim
  // events (audit-log.ts) — previously the ONLY entries `auditTrail` could
  // ever produce were synthesized from durable fields (created/citations/
  // notes), so every past status/claim change beyond the LATEST one was
  // unrecoverable. Items created/transitioned before this fix landed simply
  // have no events here yet (nothing to backfill from) — new activity from
  // this point on is fully covered.
  history.push(...queryAuditEvents(store, node.id));
  history.sort((a, b) => a.at.localeCompare(b.at));

  const chain = store.graph.getSupersessionChain(node.id);
  let supersessionChain: AuditTrailResult['supersessionChain'];
  if (chain.length > 1) {
    const index = chain.findIndex((n) => n.id === node.id);
    const olderHumanId = index > 0 ? ((chain[index - 1]?.metadata as { humanId?: string } | undefined)?.humanId ?? undefined) : undefined;
    const newerHumanId =
      index >= 0 && index < chain.length - 1 ? ((chain[index + 1]?.metadata as { humanId?: string } | undefined)?.humanId ?? undefined) : undefined;
    supersessionChain = {};
    if (olderHumanId) supersessionChain.supersedes = olderHumanId;
    if (newerHumanId) supersessionChain.supersededBy = newerHumanId;
  }

  const result: AuditTrailResult = { humanId: item.humanId, history };
  if (supersessionChain) result.supersessionChain = supersessionChain;
  return result;
}

export type { BacklogNodeMeta };
