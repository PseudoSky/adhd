/**
 * query.ts — read-side operations: listItems/stats/spotlight/readyItems/
 * blockers/dependencyGraph/topoOrder/staleClaims (DESIGN.md §2.5/§13), plus
 * `findItemNode`, the shared (repo, humanId) -> NodeRecord lookup every other
 * store module needs.
 */
import type { NodeFilter, NodeRecord } from '@adhd/sox-graph-store';
import type { AuditTrailEntry, AuditTrailResult, BacklogFilter, BacklogItem, DependencyGraph, StatsScope, TopoOrderResult } from '../model.js';
import { AmbiguousHumanIdError, BacklogItemNotFoundError, isTerminalStatus } from '../model.js';
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

function applyRootLevelFilter(nodes: NodeRecord[], filter: BacklogFilter): NodeRecord[] {
  if (!filter.rootLevel) return nodes;
  return nodes.filter((n) => {
    const m = n.metadata as Partial<BacklogNodeMeta> | undefined;
    return !m?.projectPath && !m?.plan;
  });
}

function applyExcludeArchivedFilter(nodes: NodeRecord[], filter: BacklogFilter): NodeRecord[] {
  if (!filter.excludeArchived) return nodes;
  return nodes.filter((n) => !(n.metadata as Partial<BacklogNodeMeta> | undefined)?.archivedAt);
}

/** Raw NodeRecord query — used internally where the full node (not just the mapped BacklogItem) is needed. */
export async function queryItemNodes(store: GraphBacklogStore, filter: BacklogFilter = {}): Promise<NodeRecord[]> {
  if (filter.grep) {
    const nodeFilter = nodeFilterFromBacklogFilter({ ...filter, grep: undefined });
    const ftsQuery = sanitizeFtsQuery(filter.grep);
    if (!ftsQuery) return [];
    let hits: Awaited<ReturnType<typeof store.graph.searchNodes>> = [];
    try {
      hits = await store.graph.searchNodes(ftsQuery, {
        limit: filter.limit ?? 1000,
        filter: nodeFilter,
      });
    } catch {
      // FTS unavailable (turso Tantivy vs FTS5) — grep returns empty
    }
    let live = applyExcludeArchivedFilter(applyRootLevelFilter(hits.filter(isLiveBacklogItemNode), filter), filter);
    if (filter.offset) live = live.slice(filter.offset);
    return live;
  }
  const nodeFilter = nodeFilterFromBacklogFilter(filter);
  if (filter.limit !== undefined) nodeFilter.limit = filter.limit;
  if (filter.offset !== undefined) nodeFilter.offset = filter.offset;
  const nodes = await store.graph.queryNodes(nodeFilter);
  return applyExcludeArchivedFilter(applyRootLevelFilter(nodes.filter(isLiveBacklogItemNode), filter), filter);
}

export async function listItems(store: GraphBacklogStore, filter: BacklogFilter = {}): Promise<BacklogItem[]> {
  const nodes = await queryItemNodes(store, filter);
  const items = nodes.map(toBacklogItem);
  return applyOpenClosedFilter(items, filter);
}

export async function findItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord | null> {
  const name = buildNodeName(repo, humanId);
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId } });
  const live = nodes.filter(isLiveBacklogItemNode);
  if (live.length > 1) {
    throw new AmbiguousHumanIdError(repo, humanId, live.map((n) => n.id));
  }
  return live.find((n) => n.name === name) ?? live[0] ?? null;
}

function nodeRepo(node: NodeRecord): string {
  return (node.metadata as { repo?: string } | undefined)?.repo ?? node.namespace ?? '';
}

export async function findHumanIdInAnyRepo(store: GraphBacklogStore, humanId: string): Promise<NodeRecord[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], metadata: { humanId } });
  return nodes.filter(isLiveBacklogItemNode);
}

export async function knownRepos(store: GraphBacklogStore): Promise<Set<string>> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG] });
  const repos = new Set<string>();
  for (const node of nodes) {
    if (!isLiveBacklogItemNode(node)) continue;
    const repo = nodeRepo(node);
    if (repo) repos.add(repo);
  }
  return repos;
}

export async function buildNotFoundError(store: GraphBacklogStore, repo: string, humanId: string): Promise<BacklogItemNotFoundError> {
  const elsewhere = (await findHumanIdInAnyRepo(store, humanId)).filter((n) => nodeRepo(n) !== repo);
  const foundInRepos = [...new Set(elsewhere.map(nodeRepo).filter((r) => r.length > 0))];
  return new BacklogItemNotFoundError(repo, humanId, foundInRepos);
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

export async function computeStats(store: GraphBacklogStore, scope: StatsScope = {}): Promise<import('../model.js').BacklogStats> {
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
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

export async function spotlight(store: GraphBacklogStore, scope: StatsScope = {}, limit = 20): Promise<BacklogItem[]> {
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'open' });
  const prioritized = items.filter((it) => it.priority !== undefined);
  prioritized.sort((a, b) => {
    const rankA = PRIORITY_RANK[a.priority ?? ''] ?? 4;
    const rankB = PRIORITY_RANK[b.priority ?? ''] ?? 4;
    return rankA - rankB || a.humanId.localeCompare(b.humanId);
  });
  return prioritized.slice(0, limit);
}

async function dependsOnTargets(store: GraphBacklogStore, nodeId: number): Promise<NodeRecord[]> {
  const edges = await store.graph.getEdges({ src: nodeId, rel: 'DEPENDS_ON' });
  const targets: NodeRecord[] = [];
  for (const edge of edges) {
    const node = await store.graph.getNode(edge.dst);
    if (node) targets.push(node);
  }
  return targets;
}

export async function blockers(store: GraphBacklogStore, repo: string, humanId: string): Promise<BacklogItem[]> {
  const node = await findItemNode(store, repo, humanId);
  if (!node) return [];
  return (await dependsOnTargets(store, node.id))
    .filter((n) => !n.tInvalid)
    .map(toBacklogItem)
    .filter((it) => !isTerminalStatus(it.status));
}

export async function readyItems(store: GraphBacklogStore, scope: StatsScope = {}): Promise<BacklogItem[]> {
  const openItems = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath, status: 'open' });
  const result: BacklogItem[] = [];
  for (const item of openItems) {
    if (item.claimedBy) continue;
    const node = await findItemNode(store, item.repo, item.humanId);
    if (!node) continue;
    const targets = (await dependsOnTargets(store, node.id)).filter((n) => !n.tInvalid);
    if (targets.every((t) => isTerminalStatus(toBacklogItem(t).status))) {
      result.push(item);
    }
  }
  return result;
}

export async function dependencyGraph(store: GraphBacklogStore, scope: StatsScope = {}): Promise<DependencyGraph> {
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
  const nodes = items.map((it) => ({ humanId: it.humanId, title: it.title, status: it.status }));
  const edges: DependencyGraph['edges'] = [];
  for (const item of items) {
    const node = await findItemNode(store, item.repo, item.humanId);
    if (!node) continue;
    for (const rel of ['DEPENDS_ON', 'RELATES_TO', 'PART_OF'] as const) {
      for (const edge of await store.graph.getEdges({ src: node.id, rel })) {
        const dst = await store.graph.getNode(edge.dst);
        if (!dst || dst.tInvalid) continue;
        const dstMeta = dst.metadata as { humanId?: string } | undefined;
        if (!dstMeta?.humanId) continue;
        edges.push({ from: item.humanId, to: dstMeta.humanId, rel });
      }
    }
  }
  return { nodes, edges };
}

export async function topoOrder(store: GraphBacklogStore, scope: StatsScope = {}): Promise<TopoOrderResult> {
  const graph = await dependencyGraph(store, scope);
  const dependsOnEdges = graph.edges.filter((e) => e.rel === 'DEPENDS_ON');

  const dependsOn = new Map<string, Set<string>>();
  for (const n of graph.nodes) dependsOn.set(n.humanId, new Set());
  for (const e of dependsOnEdges) dependsOn.get(e.from)?.add(e.to);

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
  return nodeIds;
}

export async function staleClaims(store: GraphBacklogStore, maxAgeMin: number, scope: StatsScope = {}): Promise<BacklogItem[]> {
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
  const cutoffMs = maxAgeMin * 60_000;
  const now = Date.now();
  return items.filter((it) => {
    if (!it.claimedBy || !it.claimedAt) return false;
    return now - Date.parse(it.claimedAt) >= cutoffMs;
  });
}

export async function auditTrail(store: GraphBacklogStore, repo: string, humanId: string): Promise<AuditTrailResult> {
  const node = await findItemNode(store, repo, humanId);
  if (!node) throw await buildNotFoundError(store, repo, humanId);
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
  history.push(...(await queryAuditEvents(store, node.id)));
  history.sort((a, b) => a.at.localeCompare(b.at));

  const chain = await store.graph.getSupersessionChain(node.id);
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
