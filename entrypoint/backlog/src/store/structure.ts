/**
 * structure.ts — addDependency/removeDependency/linkRelated/supersedeItem/
 * splitItem/mergeItems/setPriority/attachToPlan/assignItem (SPEC.md §5.5,
 * DESIGN.md §2.3/§14).
 */
import type { BacklogItem, CreateItemInput, ILinkRelatedResult, Priority } from '../model.js';
import { InvalidArgumentError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { buildNotFoundError, findItemNode } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import { createItemNode } from './crud.js';
import { allocateHumanIdAndInsert } from './ids.js';
import { assertValidCitation } from './lifecycle.js';
import { withImmediateRetry } from './immediate-retry.js';
import {
  BACKLOG_ASSIGNEE_TAG,
  BACKLOG_ITEM_TAG,
  BACKLOG_PLAN_TAG,
  buildNodeContent,
  buildNodeName,
  buildTags,
  computeContentHash,
  humanIdFamily,
  humanIdKind,
  importanceForPriority,
  isLiveBacklogItemNode,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';

async function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string) {
  const node = await findItemNode(store, repo, humanId);
  if (!node) throw await buildNotFoundError(store, repo, humanId);
  return node;
}

export async function addDependencyNode(store: GraphBacklogStore, repo: string, humanId: string, dependsOnHumanId: string): Promise<void> {
  const from = await requireItemNode(store, repo, humanId);
  const to = await requireItemNode(store, repo, dependsOnHumanId);
  await store.graph.writeEdge(from.id, to.id, 'DEPENDS_ON');
}

/**
 * `@adhd/sox-graph-store` exposes no edge-delete primitive (only
 * `invalidate()` for nodes, bi-temporal) — DESIGN.md §14 explicitly sanctions
 * a raw `DELETE` on the store-owned handle as the one place the adapter
 * reaches past the `GraphBackend` API, confirmed against the real `edge`
 * table column names (`src`/`dst`/`rel`). F-01/F-02: routed through the
 * store-adapter's `executeRun` query surface (the raw `store.db` handle is
 * gone) — same SQL, same semantics.
 */
export async function removeDependencyNode(store: GraphBacklogStore, repo: string, humanId: string, dependsOnHumanId: string): Promise<void> {
  const from = await requireItemNode(store, repo, humanId);
  const to = await requireItemNode(store, repo, dependsOnHumanId);
  await store.adapter.executeRun(`DELETE FROM edge WHERE src = ? AND dst = ? AND rel = 'DEPENDS_ON'`, [from.id, to.id]);
}

/**
 * BUG-025: `store.graph.writeEdge()` is an upsert — `INSERT ... ON CONFLICT
 * (src, dst, rel) DO UPDATE` (`@adhd/sox-graph-store`'s
 * `writeEdgeInternal`) — and returns `Promise<void>` either way, so its
 * return value cannot tell a fresh write from a no-op re-write of an edge
 * that was already there. `RELATES_TO` between two given items is only ever
 * written in ONE direction (`a -> b`, the order the caller happened to pass
 * this call) but the relation it models is symmetric — `linkRelated(A, B)`
 * and a later `linkRelated(B, A)` mean the same thing to a caller — so
 * "already linked" must check for a live `RELATES_TO` edge in EITHER
 * direction between the two nodes, not just the exact (src, dst) pair this
 * call is about to write.
 *
 * Both the existence check and the write happen inside ONE
 * `BEGIN IMMEDIATE` transaction (the same pattern `mutateMetadata` uses,
 * DESIGN.md §3/§4.3) so a concurrent `linkRelated` call on the same pair
 * cannot land between the read and the write and turn a true "already
 * linked" into a false "fresh link" (or vice versa) — `.immediate()`
 * acquires SQLite's RESERVED lock up front, so a second concurrent call
 * blocks (up to `busy_timeout`, retried by `withImmediateRetry`) rather than
 * interleaving its own read with this one's write.
 */
async function hasLiveRelatesToEdge(store: GraphBacklogStore, nodeIdA: number, nodeIdB: number): Promise<boolean> {
  const [forward, backward] = await Promise.all([
    store.graph.getEdges({ src: nodeIdA, dst: nodeIdB, rel: 'RELATES_TO' }),
    store.graph.getEdges({ src: nodeIdB, dst: nodeIdA, rel: 'RELATES_TO' }),
  ]);
  return forward.length > 0 || backward.length > 0;
}

export async function linkRelatedNode(store: GraphBacklogStore, repo: string, humanIdA: string, humanIdB: string): Promise<ILinkRelatedResult> {
  return withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        const a = await requireItemNode(store, repo, humanIdA);
        const b = await requireItemNode(store, repo, humanIdB);
        const alreadyLinked = await hasLiveRelatesToEdge(store, a.id, b.id);
        await store.graph.writeEdge(a.id, b.id, 'RELATES_TO');
        return { linked: true, repo, humanIdA, humanIdB, alreadyLinked };
      },
      { mode: 'immediate' }
    )
  );
}

/**
 * BUG-025 read side: the write becoming verifiable is only half the fix if
 * there is still no way to list what a `linkRelated` call actually produced.
 * Returns the humanIds of every OTHER live item connected to `humanId` by a
 * live `RELATES_TO` edge, checking both edge directions for the same
 * symmetric-relation reason `hasLiveRelatesToEdge` does — `linkRelated(A, B)`
 * writes `A -> B` only, so listing B's related items must also look at
 * edges where B is the `dst`, not only ones where it is the `src`, or half
 * of every link this store has ever written would be invisible from one of
 * its two endpoints.
 */
export async function listRelatedNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<string[]> {
  const node = await requireItemNode(store, repo, humanId);
  const [outgoing, incoming] = await Promise.all([
    store.graph.getEdges({ src: node.id, rel: 'RELATES_TO' }),
    store.graph.getEdges({ dst: node.id, rel: 'RELATES_TO' }),
  ]);
  const otherNodeIds = new Set<number>();
  for (const edge of outgoing) otherNodeIds.add(edge.dst);
  for (const edge of incoming) otherNodeIds.add(edge.src);

  const related: string[] = [];
  for (const otherId of otherNodeIds) {
    const other = await store.graph.getNode(otherId);
    if (!other || other.tInvalid || !isLiveBacklogItemNode(other)) continue;
    const otherHumanId = toBacklogItem(other).humanId;
    if (otherHumanId) related.push(otherHumanId);
  }
  return related.sort();
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
export async function supersedeItemNode(store: GraphBacklogStore, repo: string, oldHumanId: string, newInput: CreateItemInput, reason: string): Promise<BacklogItem> {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidArgumentError(
      'reason',
      `backlog: supersedeItem requires a non-empty "reason" — received reason=${JSON.stringify(reason)}.`
    );
  }
  // BUG-BACKLOG-CREATE-ITEM-DROPS-CITATIONS-001: `newInput` is the same
  // `CreateItemInput` shape `createItemNode` accepts and validates —
  // `supersedeItemNode` mints its replacement node by hand (see the mint
  // block below) rather than delegating to `createItemNode`, so it needs
  // the identical up-front validation or it would silently reintroduce the
  // same drop for the supersede path alone.
  if (newInput.citations) {
    for (const citation of newInput.citations) assertValidCitation(citation);
  }
  const old = await requireItemNode(store, repo, oldHumanId);

  // The new item's humanId must be allocated BEFORE minting (it is baked
  // into content/meta up front) and `graph.supersede()` is the SOLE minting
  // path (DESIGN.md §14 — never hand-roll the SUPERSEDES edge), so this does
  // not go through `createItemNode` at all (that would mint a second,
  // throwaway node).
  //
  // DEVIATION from the pre-adapter code (which wrapped BOTH the id
  // resolution AND the `supersede()` mint in ONE `.immediate()` transaction):
  // `graph.supersede()` itself opens its own `adapter.transaction()` (the
  // store-adapter's async transaction surface does NOT support nesting —
  // turso's `_txMutexChain` deadlocks on self-nesting, sqlite throws
  // "cannot start a transaction within a transaction"). So the humanId is
  // resolved atomically FIRST via `allocateHumanIdAndInsert` (which keeps
  // its own `.immediate()` transaction and the
  // BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001 counter atomicity), then
  // `supersede()` mints in its own transaction. The residual window — a
  // concurrent same-(repo,family) `createItem`/`supersedeItem` landing
  // between the id-resolution commit and the mint — is the same
  // allocate-then-insert shape `allocateHumanId`'s @deprecated doc warns
  // about; it is bounded and documented (supersedeItem is a rare admin op),
  // and closing it fully would require a graph-store primitive that accepts
  // an external transaction handle.
  const nowIso = new Date().toISOString();
  const humanId = await allocateHumanIdAndInsert(store, repo, newInput.family, newInput.idOverride, (resolvedHumanId) => resolvedHumanId);
  {
    const kind = humanIdKind(humanId);
    const family = humanIdFamily(humanId);
    const newMeta: BacklogNodeMeta = {
      humanId,
      kind,
      family,
      title: newInput.title,
      body: newInput.body,
      status: 'OPEN',
      repo,
      citations: newInput.citations ?? [],
      notes: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (newInput.priority !== undefined) newMeta.priority = newInput.priority;
    if (newInput.projectPath !== undefined) newMeta.projectPath = newInput.projectPath;
    if (newInput.plan !== undefined) newMeta.plan = newInput.plan;

    const newId = await store.graph.supersede(old.id, buildNodeContent(repo, humanId, newInput.title, newInput.body), {
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

    await mutateMetadata<BacklogNodeMeta>(store, old.id, (meta) => {
      const notes = [...meta.notes, { by: 'system', at: nowIso, text: `[superseded by ${humanId}] ${reason}` }];
      const next: BacklogNodeMeta = { ...meta, status: 'SUPERSEDED', notes, updatedAt: nowIso };
      delete next.claimedBy;
      delete next.claimedAt;
      return next;
    });
    await store.graph.invalidate(old.id, reason);

    const newNode = await store.graph.getNode(newId);
    if (!newNode) throw new Error(`backlog: supersede() returned an id that does not resolve: ${newId}`);
    return toBacklogItem(newNode);
  }
}

/** Creates N children, each linked child PART_OF parent. Parent is left open. */
export async function splitItemNode(store: GraphBacklogStore, repo: string, parentHumanId: string, children: CreateItemInput[]): Promise<BacklogItem[]> {
  const parent = await requireItemNode(store, repo, parentHumanId);
  const created: BacklogItem[] = [];
  for (const childInput of children) {
    const result = await createItemNode(store, { ...childInput, repo });
    await store.graph.writeEdge(result.item.nodeId, parent.id, 'PART_OF');
    created.push(result.item);
  }
  return created;
}

/**
 * `SAME_AS(drop -> keep)` per DESIGN.md §14 point 2 (obsolete -> canonical,
 * matching the `supersede()` convention), then `invalidate(drop, reason)`.
 * Returns the KEPT item.
 */
export async function mergeItemsNode(store: GraphBacklogStore, repo: string, keepHumanId: string, dropHumanId: string, reason: string): Promise<BacklogItem> {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidArgumentError(
      'reason',
      `backlog: mergeItems requires a non-empty "reason" — received reason=${JSON.stringify(reason)}.`
    );
  }
  const keep = await requireItemNode(store, repo, keepHumanId);
  const drop = await requireItemNode(store, repo, dropHumanId);

  await mutateMetadata<BacklogNodeMeta>(store, drop.id, (meta) => {
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

  await store.graph.writeEdge(drop.id, keep.id, 'SAME_AS');
  await store.graph.invalidate(drop.id, reason);

  const keepNode = await store.graph.getNode(keep.id);
  if (!keepNode) throw await buildNotFoundError(store, repo, keepHumanId);
  return toBacklogItem(keepNode);
}

export async function setPriorityNode(store: GraphBacklogStore, repo: string, humanId: string, priority: Priority): Promise<BacklogItem> {
  const node = await requireItemNode(store, repo, humanId);
  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => ({ ...meta, priority, updatedAt: new Date().toISOString() }));
  await store.graph.touch(node.id, { importance: importanceForPriority(priority) });
  const updated = await store.graph.getNode(node.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);
  return toBacklogItem(updated);
}

async function findOrCreatePlanNode(store: GraphBacklogStore, repo: string, planSlug: string): Promise<number> {
  const name = `${repo}::plan:${planSlug}`;
  const existing = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_PLAN_TAG], namespace: repo, metadata: { planSlug } });
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

export async function attachToPlanNode(store: GraphBacklogStore, repo: string, humanId: string, planSlug: string): Promise<void> {
  const item = await requireItemNode(store, repo, humanId);
  const planId = await findOrCreatePlanNode(store, repo, planSlug);
  await mutateMetadata<BacklogNodeMeta>(store, item.id, (meta) => ({ ...meta, plan: planSlug, updatedAt: new Date().toISOString() }));
  await store.graph.writeEdge(item.id, planId, 'MEMBER_OF');
}

async function findOrCreateAssigneeNode(store: GraphBacklogStore, to: string): Promise<number> {
  const existing = await store.graph.queryNodes({ kind: 'entity', tags: [BACKLOG_ASSIGNEE_TAG], metadata: { identity: to } });
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

export async function assignItemNode(store: GraphBacklogStore, repo: string, humanId: string, to: string, by: string): Promise<BacklogItem> {
  const item = await requireItemNode(store, repo, humanId);
  const assigneeId = await findOrCreateAssigneeNode(store, to);
  await mutateMetadata<BacklogNodeMeta>(store, item.id, (meta) => {
    const nowIso = new Date().toISOString();
    return { ...meta, assignee: to, notes: [...meta.notes, { by, at: nowIso, text: `assigned to ${to}` }], updatedAt: nowIso };
  });
  await store.graph.writeEdge(item.id, assigneeId, 'ASSIGNED_TO');
  const updated = await store.graph.getNode(item.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);
  return toBacklogItem(updated);
}

/**
 * BUG-BACKLOG-HUMANID-COLLISION-001 fix #3 (repair primitive): re-ids a
 * single, `nodeId`-scoped live backlog item to a new `humanId` within the
 * same `repo`. `nodeId`-scoped (not `(repo, oldHumanId)`-keyed) so this is
 * unambiguous EVEN under the exact collision it exists to repair — every
 * other `(repo, humanId)`-keyed lookup in this file would throw
 * `AmbiguousHumanIdError` on a colliding key (fix #2, `findItemNode`), so a
 * repair tool needs a way in that doesn't go through that same lookup.
 *
 * There is no tool-level rename/re-id operation exposed anywhere in this
 * store today (the backlog item's fix direction #5 explicitly calls this
 * gap out) — this is that primitive, added as part of this fix, kept
 * store-internal (not wired to `client.ts`/the MCP surface) since it is a
 * narrow one-off repair tool, not a general-purpose end-user operation.
 *
 * Guards:
 *  - the node at `nodeId` must be live and its CURRENT `metadata.humanId`
 *    must equal `oldHumanId` (sanity check — refuses to rename the wrong
 *    node out from under a caller who mis-copied a nodeId).
 *  - `newHumanId` must not already resolve to a DIFFERENT live node in this
 *    `repo` (refuses to rename INTO a fresh collision).
 *  - re-derives `kind`/`family` from `newHumanId`, rebuilds `tags` (swapping
 *    the old kind/family tags for the new ones, preserving every other
 *    user tag) and the node `name`/`content`/`content_hash` (which both bake
 *    in `repo::humanId` — DESIGN.md §2.2, mapping.ts's `buildNodeName`/
 *    `buildNodeContent`) so the renamed node is indistinguishable from one
 *    that was always minted under `newHumanId`.
 */
export async function renameHumanIdNode(store: GraphBacklogStore, repo: string, nodeId: number, oldHumanId: string, newHumanId: string): Promise<BacklogItem> {
  if (typeof newHumanId !== 'string' || newHumanId.trim().length === 0) {
    throw new InvalidArgumentError('newHumanId', `backlog: renameHumanId requires a non-empty newHumanId, received ${JSON.stringify(newHumanId)}`);
  }

  const node = await store.graph.getNode(nodeId);
  if (!node || node.tInvalid || !isLiveBacklogItemNode(node)) {
    throw await buildNotFoundError(store, repo, oldHumanId);
  }
  const currentMeta = node.metadata as Partial<BacklogNodeMeta> | undefined;
  const currentHumanId = currentMeta?.humanId;
  const currentRepo = currentMeta?.repo ?? node.namespace;
  if (currentHumanId !== oldHumanId || currentRepo !== repo) {
    throw new InvalidArgumentError(
      'nodeId',
      `backlog: renameHumanId nodeId=${nodeId} does not currently carry (repo=${JSON.stringify(repo)}, humanId=${JSON.stringify(oldHumanId)}) ` +
        `— it carries (repo=${JSON.stringify(currentRepo)}, humanId=${JSON.stringify(currentHumanId)}). Refusing to rename the wrong node.`
    );
  }

  // A DIFFERENT live node already claiming `newHumanId` in this repo would
  // itself be a fresh, avoidable collision — refuse. (A live node that is
  // THIS SAME nodeId, i.e. renaming to the id it already has, is a no-op
  // and allowed through.)
  const clashing = (await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { humanId: newHumanId } })).filter(
    (n) => isLiveBacklogItemNode(n) && n.id !== nodeId
  );
  if (clashing.length > 0) {
    throw new InvalidArgumentError(
      'newHumanId',
      `backlog: cannot rename nodeId=${nodeId} to humanId=${JSON.stringify(newHumanId)} in repo=${JSON.stringify(repo)} — ` +
        `already claimed by live nodeId(s) ${clashing.map((n) => n.id).join(', ')}.`
    );
  }

  const newKind = humanIdKind(newHumanId);
  const newFamily = humanIdFamily(newHumanId);
  const oldReservedTags = new Set<string>([BACKLOG_ITEM_TAG, currentMeta?.kind ?? humanIdKind(oldHumanId), currentMeta?.family ?? humanIdFamily(oldHumanId)]);
  const userTags = node.tags.filter((t) => !oldReservedTags.has(t));

  let finalTitle = '';
  let finalBody = '';
  await mutateMetadata<BacklogNodeMeta>(store, nodeId, (meta) => {
    finalTitle = meta.title;
    finalBody = meta.body;
    const nowIso = new Date().toISOString();
    return {
      ...meta,
      humanId: newHumanId,
      kind: newKind,
      family: newFamily,
      notes: [...meta.notes, { by: 'system', at: nowIso, text: `[data repair] renamed humanId from "${oldHumanId}" to "${newHumanId}" (BUG-BACKLOG-HUMANID-COLLISION-001)` }],
      updatedAt: nowIso,
    };
  });

  await store.graph.touch(nodeId, {
    name: buildNodeName(repo, newHumanId),
    tags: buildTags(newKind, newFamily, userTags),
  });

  const newContent = buildNodeContent(repo, newHumanId, finalTitle, finalBody);
  await store.adapter.executeRun(`UPDATE node SET content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`, [
    newContent,
    computeContentHash(newContent),
    nodeId,
  ]);

  const updated = await store.graph.getNode(nodeId);
  if (!updated) throw await buildNotFoundError(store, repo, newHumanId);
  return toBacklogItem(updated);
}
