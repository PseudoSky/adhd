/**
 * structure.ts — addDependency/removeDependency/linkRelated/supersedeItem/
 * splitItem/mergeItems/setPriority/attachToPlan/assignItem (SPEC.md §5.5,
 * DESIGN.md §2.3/§14).
 */
import type { BacklogItem, CreateItemInput, Priority } from '../model.js';
import { BacklogItemNotFoundError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { findItemNode } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import { createItemNode } from './crud.js';
import { allocateHumanId } from './ids.js';
import {
  BACKLOG_ASSIGNEE_TAG,
  BACKLOG_PLAN_TAG,
  buildNodeContent,
  buildNodeName,
  humanIdFamily,
  humanIdKind,
  importanceForPriority,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';

function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string) {
  const node = findItemNode(store, repo, humanId);
  if (!node) throw new BacklogItemNotFoundError(repo, humanId);
  return node;
}

export function addDependencyNode(store: GraphBacklogStore, repo: string, humanId: string, dependsOnHumanId: string): void {
  const from = requireItemNode(store, repo, humanId);
  const to = requireItemNode(store, repo, dependsOnHumanId);
  store.graph.writeEdge(from.id, to.id, 'DEPENDS_ON');
}

/**
 * `@adhd/sox-graph-store` exposes no edge-delete primitive (only
 * `invalidate()` for nodes, bi-temporal) — DESIGN.md §14 explicitly sanctions
 * a raw `DELETE` on the store-owned `db` handle as the one place the adapter
 * reaches past the `GraphBackend` API, confirmed against the real `edge`
 * table column names (`src`/`dst`/`rel`).
 */
export function removeDependencyNode(store: GraphBacklogStore, repo: string, humanId: string, dependsOnHumanId: string): void {
  const from = requireItemNode(store, repo, humanId);
  const to = requireItemNode(store, repo, dependsOnHumanId);
  store.db.prepare(`DELETE FROM edge WHERE src = ? AND dst = ? AND rel = 'DEPENDS_ON'`).run(from.id, to.id);
}

export function linkRelatedNode(store: GraphBacklogStore, repo: string, humanIdA: string, humanIdB: string): void {
  const a = requireItemNode(store, repo, humanIdA);
  const b = requireItemNode(store, repo, humanIdB);
  store.graph.writeEdge(a.id, b.id, 'RELATES_TO');
}

/**
 * DESIGN.md §14 point 2 (CONFIRMED against the real source): `supersede(oldId,
 * newContent, meta)` writes `SUPERSEDES` new -> old, sets `is_superseded=1`
 * on the old node, and mints the new node — ALL in one internal transaction.
 * It does NOT invalidate the old node (`t_invalid` stays null) — SPEC.md
 * §5.5 additionally requires the old item to become bi-temporally invalid
 * with `reason`, so this composes `supersede()` with a status update (BEFORE
 * invalidation — `touch()`/`mutateMetadata` throw once `t_invalid` is set)
 * and a final `invalidate(oldId, reason)`.
 */
export function supersedeItemNode(store: GraphBacklogStore, repo: string, oldHumanId: string, newInput: CreateItemInput, reason: string): BacklogItem {
  const old = requireItemNode(store, repo, oldHumanId);

  // The new item's humanId must be allocated BEFORE minting (it is baked
  // into content/meta up front) and `graph.supersede()` is the SOLE minting
  // path (DESIGN.md §14 — never hand-roll the SUPERSEDES edge), so this does
  // not go through `createItemNode` at all (that would mint a second,
  // throwaway node).
  const humanId = newInput.idOverride ?? allocateHumanId(store, repo, newInput.family);
  const kind = humanIdKind(humanId);
  const family = humanIdFamily(humanId);
  const nowIso = new Date().toISOString();
  const newMeta: BacklogNodeMeta = {
    humanId,
    kind,
    family,
    title: newInput.title,
    body: newInput.body,
    status: 'OPEN',
    repo,
    citations: [],
    notes: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (newInput.priority !== undefined) newMeta.priority = newInput.priority;
  if (newInput.projectPath !== undefined) newMeta.projectPath = newInput.projectPath;
  if (newInput.plan !== undefined) newMeta.plan = newInput.plan;

  const newId = store.graph.supersede(old.id, buildNodeContent(repo, humanId, newInput.title, newInput.body), {
    kind: 'generic',
    name: buildNodeName(repo, humanId),
    summary: newInput.title,
    tags: ['backlog-item', kind, family, ...(newInput.tags ?? [])],
    namespace: repo,
    importance: importanceForPriority(newInput.priority),
    confidence: 'confirmed',
    ...(newInput.projectPath !== undefined ? { projectPath: newInput.projectPath } : {}),
    metadata: newMeta as unknown as Record<string, unknown>,
  });

  mutateMetadata<BacklogNodeMeta>(store, old.id, (meta) => {
    const notes = [...meta.notes, { by: 'system', at: nowIso, text: `[superseded by ${humanId}] ${reason}` }];
    const next: BacklogNodeMeta = { ...meta, status: 'SUPERSEDED', notes, updatedAt: nowIso };
    delete next.claimedBy;
    delete next.claimedAt;
    return next;
  });
  store.graph.invalidate(old.id, reason);

  const newNode = store.graph.getNode(newId);
  if (!newNode) throw new Error(`backlog: supersede() returned an id that does not resolve: ${newId}`);
  return toBacklogItem(newNode);
}

/** Creates N children, each linked child PART_OF parent. Parent is left open. */
export function splitItemNode(store: GraphBacklogStore, repo: string, parentHumanId: string, children: CreateItemInput[]): BacklogItem[] {
  const parent = requireItemNode(store, repo, parentHumanId);
  const created: BacklogItem[] = [];
  for (const childInput of children) {
    const result = createItemNode(store, { ...childInput, repo });
    store.graph.writeEdge(result.item.nodeId, parent.id, 'PART_OF');
    created.push(result.item);
  }
  return created;
}

/**
 * `SAME_AS(drop -> keep)` per DESIGN.md §14 point 2 (obsolete -> canonical,
 * matching the `supersede()` convention), then `invalidate(drop, reason)`.
 * Returns the KEPT item.
 */
export function mergeItemsNode(store: GraphBacklogStore, repo: string, keepHumanId: string, dropHumanId: string, reason: string): BacklogItem {
  const keep = requireItemNode(store, repo, keepHumanId);
  const drop = requireItemNode(store, repo, dropHumanId);

  mutateMetadata<BacklogNodeMeta>(store, drop.id, (meta) => {
    const nowIso = new Date().toISOString();
    const next: BacklogNodeMeta = {
      ...meta,
      status: 'DUPLICATE',
      notes: [...meta.notes, { by: 'system', at: nowIso, text: `[merged into ${keepHumanId}] ${reason}` }],
      updatedAt: nowIso,
    };
    delete next.claimedBy;
    delete next.claimedAt;
    return next;
  });

  store.graph.writeEdge(drop.id, keep.id, 'SAME_AS');
  store.graph.invalidate(drop.id, reason);

  const keepNode = store.graph.getNode(keep.id);
  if (!keepNode) throw new BacklogItemNotFoundError(repo, keepHumanId);
  return toBacklogItem(keepNode);
}

export function setPriorityNode(store: GraphBacklogStore, repo: string, humanId: string, priority: Priority): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => ({ ...meta, priority, updatedAt: new Date().toISOString() }));
  store.graph.touch(node.id, { importance: importanceForPriority(priority) });
  const updated = store.graph.getNode(node.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}

function findOrCreatePlanNode(store: GraphBacklogStore, repo: string, planSlug: string): number {
  const name = `${repo}::plan:${planSlug}`;
  const existing = store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_PLAN_TAG], namespace: repo, metadata: { planSlug } });
  const found = existing.find((n) => n.name === name && !n.isSuperseded);
  if (found) return found.id;
  return store.graph.writeNode(`plan:${planSlug}`, {
    kind: 'generic',
    name,
    summary: planSlug,
    tags: [BACKLOG_PLAN_TAG],
    namespace: repo,
    metadata: { planSlug },
  });
}

export function attachToPlanNode(store: GraphBacklogStore, repo: string, humanId: string, planSlug: string): void {
  const item = requireItemNode(store, repo, humanId);
  const planId = findOrCreatePlanNode(store, repo, planSlug);
  mutateMetadata<BacklogNodeMeta>(store, item.id, (meta) => ({ ...meta, plan: planSlug, updatedAt: new Date().toISOString() }));
  store.graph.writeEdge(item.id, planId, 'MEMBER_OF');
}

function findOrCreateAssigneeNode(store: GraphBacklogStore, to: string): number {
  const existing = store.graph.queryNodes({ kind: 'entity', tags: [BACKLOG_ASSIGNEE_TAG], metadata: { identity: to } });
  const found = existing.find((n) => n.name === to && !n.isSuperseded);
  if (found) return found.id;
  return store.graph.writeNode(`assignee:${to}`, {
    kind: 'entity',
    name: to,
    summary: to,
    tags: [BACKLOG_ASSIGNEE_TAG],
    metadata: { identity: to },
  });
}

export function assignItemNode(store: GraphBacklogStore, repo: string, humanId: string, to: string, by: string): BacklogItem {
  const item = requireItemNode(store, repo, humanId);
  const assigneeId = findOrCreateAssigneeNode(store, to);
  mutateMetadata<BacklogNodeMeta>(store, item.id, (meta) => {
    const nowIso = new Date().toISOString();
    return { ...meta, assignee: to, notes: [...meta.notes, { by, at: nowIso, text: `assigned to ${to}` }], updatedAt: nowIso };
  });
  store.graph.writeEdge(item.id, assigneeId, 'ASSIGNED_TO');
  const updated = store.graph.getNode(item.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}
