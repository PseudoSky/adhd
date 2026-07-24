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
import { allocateHumanIdAndInsert } from './ids.js';
import { findItemNode } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import {
  BACKLOG_ITEM_TAG,
  buildNodeContent,
  buildNodeName,
  buildTags,
  computeContentHash,
  humanIdFamily,
  humanIdKind,
  importanceForPriority,
  isLiveBacklogItemNode,
  sanitizeFtsQuery,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';

function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): BacklogItem[] {
  const candidates = new Map<number, NodeRecord>();

  // 1. FTS over title + body — catches "same bug, different words". Sanitized
  // first (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001) — an unsanitized title
  // containing an FTS5-syntax-significant character (`-`, `:`, `(`, `)`, `"`)
  // crashes `searchNodes` outright instead of returning candidates.
  const ftsQuery = sanitizeFtsQuery(input.title);
  if (ftsQuery) {
    for (const hit of store.graph.searchNodes(ftsQuery, {
      limit: 10,
      filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
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
  //
  // This is a SPECULATIVE fast-path check only (cheap early-out so a known
  // duplicate never runs the dedupe scan below for nothing) — the
  // AUTHORITATIVE check is the one inside `allocateHumanIdAndInsert`'s own
  // `.immediate()` transaction below, which is the one actually safe under
  // concurrency (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001).
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

  return allocateHumanIdAndInsert(store, input.repo, input.family, input.idOverride, (humanId, existingAtCommit) => {
    if (existingAtCommit) {
      const existingItem = toBacklogItem(existingAtCommit);
      return { item: existingItem, created: false, duplicateCandidates: [existingItem] };
    }

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
    if (input.importedFrom !== undefined) meta.importedFrom = input.importedFrom;
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
  });
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
 * DEVIATION (mitigated — DEBT-BACKLOG-CONTENT-IMMUTABLE-001): `@adhd/sox-graph-store`
 * exposes no PUBLIC primitive to update a node's `content` column after
 * creation (`touch()`'s `Partial<NodeMeta>` covers
 * name/summary/topic/tags/importance/confidence/tExpires/metadata — never
 * `content`; verified against the real source). `title` updates the `summary`
 * column (source of truth for the API) AND `metadata.title`; `body` updates
 * `metadata.body` (source of truth for the API). Below, a title/body change
 * ALSO re-synchronizes the FTS-indexed `content`/`content_hash` columns
 * directly via raw SQL on the store-owned `db` handle — the same DESIGN.md
 * §14-sanctioned escape hatch `structure.ts`'s `removeDependencyNode` already
 * uses for the one other gap (`edge` deletion) the `GraphBackend` API lacks.
 * This is safe specifically because `fts_node_au` (the real schema's `AFTER
 * UPDATE ON node` trigger — `~/dev/ai/sox-ecosystem/libs/data/graph/graph-store/
 * src/index.ts`'s `FTS_TRIGGERS`) re-indexes `fts_node` automatically on
 * ANY write to `node.content`/`name`/`summary`, so no separate FTS statement
 * is needed here.
 */
export function updateItemNode(store: GraphBacklogStore, repo: string, humanId: string, patch: UpdateItemInput): BacklogItem {
  const node = requireItemNode(store, repo, humanId);
  let finalTitle = '';
  let finalBody = '';
  mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const next: BacklogNodeMeta = { ...meta, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.projectPath !== undefined) next.projectPath = patch.projectPath;
    finalTitle = next.title;
    finalBody = next.body;
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
  if (patch.title !== undefined || patch.body !== undefined) {
    const newContent = buildNodeContent(repo, humanId, finalTitle, finalBody);
    store.db
      .prepare(`UPDATE node SET content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`)
      .run(newContent, computeContentHash(newContent), node.id);
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
