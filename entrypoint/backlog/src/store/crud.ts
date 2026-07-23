/**
 * crud.ts — createItem/getItem/updateItem/softDeleteItem + the dedupe scan
 * (DESIGN.md §2.4). `createItem`'s dedupe scan runs BEFORE humanId
 * allocation and is an intentionally soft guarantee (a scan racing a
 * concurrent create can miss a just-created near-duplicate — acceptable per
 * DESIGN.md §2.4).
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { BacklogItem, CreateItemInput, CreateItemResult, UpdateItemInput } from '../model.js';
import { BacklogItemNotFoundError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { allocateHumanId } from './ids.js';
import { findItemNode } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import {
  BACKLOG_ITEM_TAG,
  buildNodeContent,
  buildNodeName,
  buildTags,
  humanIdFamily,
  humanIdKind,
  importanceForPriority,
  isLiveBacklogItemNode,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';

function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): BacklogItem[] {
  const candidates = new Map<number, NodeRecord>();

  // 1. FTS over title + body — catches "same bug, different words".
  for (const hit of store.graph.searchNodes(input.title, {
    limit: 10,
    filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
  })) {
    if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
  }

  // 2. Exact metadata match on symbol/path/errorText.
  const scan = input.dedupeScan;
  if (scan?.symbol) {
    for (const hit of store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupeSymbol: scan.symbol },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.path) {
    for (const hit of store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupePath: scan.path },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.errorText) {
    for (const hit of store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupeErrorText: scan.errorText },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }

  return [...candidates.values()].map(toBacklogItem);
}

export function createItemNode(store: GraphBacklogStore, input: CreateItemInput): CreateItemResult {
  // `idOverride` (import path, or a planner-chosen id) must never mint a
  // SECOND node claiming an already-live humanId — `humanId` is documented
  // as "unique within (repo, family)" (SPEC.md §4.1). This is a HARD check,
  // not the soft dedupe-scan heuristic below, and is NOT bypassed by
  // `force` (force overrides "maybe a near-duplicate", never "this exact id
  // already exists") — it is what makes `importFromMarkdown` idempotent on
  // re-import (SPEC.md §5.6) and correctly surfaces a genuine duplicate
  // humanId WITHIN one source file (the legacy tool's own `stats` command
  // documents that real `BACKLOG.md` files do contain duplicate ids) as a
  // dedupe candidate instead of silently minting a second, id-colliding node.
  if (input.idOverride) {
    const existing = findItemNode(store, input.repo, input.idOverride);
    if (existing) {
      const existingItem = toBacklogItem(existing);
      return { item: existingItem, created: false, duplicateCandidates: [existingItem] };
    }
  }

  const duplicateCandidates = input.force ? [] : dedupeScan(store, input.repo, input);
  if (duplicateCandidates.length > 0 && !input.force) {
    return { item: duplicateCandidates[0], created: false, duplicateCandidates };
  }

  const humanId = input.idOverride ?? allocateHumanId(store, input.repo, input.family);
  const kind = humanIdKind(humanId);
  const family = humanIdFamily(humanId);
  const nowIso = new Date().toISOString();

  const meta: BacklogNodeMeta = {
    humanId,
    kind,
    family,
    title: input.title,
    body: input.body,
    status: 'OPEN',
    repo: input.repo,
    citations: [],
    notes: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (input.priority !== undefined) meta.priority = input.priority;
  if (input.projectPath !== undefined) meta.projectPath = input.projectPath;
  if (input.plan !== undefined) meta.plan = input.plan;
  if (input.dedupeScan?.symbol !== undefined) meta.dedupeSymbol = input.dedupeScan.symbol;
  if (input.dedupeScan?.path !== undefined) meta.dedupePath = input.dedupeScan.path;
  if (input.dedupeScan?.errorText !== undefined) meta.dedupeErrorText = input.dedupeScan.errorText;

  const nodeId = store.graph.writeNode(buildNodeContent(input.repo, humanId, input.title, input.body), {
    kind: 'generic',
    name: buildNodeName(input.repo, humanId),
    summary: input.title,
    tags: buildTags(kind, family, input.tags),
    namespace: input.repo,
    importance: importanceForPriority(input.priority),
    confidence: 'confirmed',
    ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
    metadata: meta as unknown as Record<string, unknown>,
  });

  const node = store.graph.getNode(nodeId);
  if (!node) throw new Error(`backlog: writeNode returned an id that does not resolve: ${nodeId}`);
  return { item: toBacklogItem(node), created: true, duplicateCandidates: [] };
}

export function getItemNode(store: GraphBacklogStore, repo: string, humanId: string): BacklogItem | null {
  const node = findItemNode(store, repo, humanId);
  return node ? toBacklogItem(node) : null;
}

function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string): NodeRecord {
  const node = findItemNode(store, repo, humanId);
  if (!node) throw new BacklogItemNotFoundError(repo, humanId);
  return node;
}

/**
 * DEVIATION: `@adhd/sox-graph-store` exposes no primitive to update a node's
 * `content` column after creation (`touch()`'s `Partial<NodeMeta>` covers
 * name/summary/topic/tags/importance/confidence/tExpires/metadata — never
 * `content`; verified against the real source). `title` updates the `summary`
 * column (source of truth for the API) AND `metadata.title`; `body` updates
 * ONLY `metadata.body` (source of truth for the API). The underlying FTS
 * `content` (set once at `createItem` time) therefore does not reflect a
 * later body edit — `listItems({ grep })` may miss a post-edit body term
 * until the item is superseded. Filed as DEBT-BACKLOG-CONTENT-IMMUTABLE-001.
 */
export function updateItemNode(store: GraphBacklogStore, repo: string, humanId: string, patch: UpdateItemInput): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const next: BacklogNodeMeta = { ...meta, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.projectPath !== undefined) next.projectPath = patch.projectPath;
    return next;
  });
  if (patch.title !== undefined || patch.tags !== undefined || patch.projectPath !== undefined) {
    const touchPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) touchPatch['summary'] = patch.title;
    if (patch.tags !== undefined) {
      const kind = humanIdKind(humanId);
      const family = humanIdFamily(humanId);
      touchPatch['tags'] = buildTags(kind, family, patch.tags);
    }
    if (patch.projectPath !== undefined) touchPatch['projectPath'] = patch.projectPath;
    store.graph.touch(node.id, touchPatch);
  }
  const updated = store.graph.getNode(node.id);
  if (!updated) throw new BacklogItemNotFoundError(repo, humanId);
  return toBacklogItem(updated);
}

export function softDeleteItemNode(store: GraphBacklogStore, repo: string, humanId: string, reason: string): void {
  const node = requireItemNode(store, repo, humanId);
  store.graph.invalidate(node.id, reason);
}

export { dedupeScan };
