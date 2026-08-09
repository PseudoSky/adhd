/**
 * crud.ts — createItem/getItem/updateItem/softDeleteItem + the dedupe scan
 * (DESIGN.md §2.4). `createItem`'s dedupe scan runs BEFORE humanId
 * allocation and is an intentionally soft guarantee (a scan racing a
 * concurrent create can miss a just-created near-duplicate — acceptable per
 * DESIGN.md §2.4).
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { BacklogItem, CreateItemInput, CreateItemResult, UpdateItemInput } from '../model.js';
import { InvalidArgumentError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { allocateHumanIdAndInsert } from './ids.js';
import { buildNotFoundError, findItemNode, knownRepos } from './query.js';
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

const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'such', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were',
  'will', 'with', 'would', 'you', 'your',
]);

export const TITLE_OVERLAP_MIN_FRACTION = 0.5;

function meaningfulTitleTokens(title: string): string[] {
  return sanitizeFtsQuery(title)
    .toLowerCase()
    .split(' ')
    .filter((tok) => tok.length > 0 && !TITLE_STOPWORDS.has(tok));
}

function titleMeaningfullyOverlaps(newTitleTokens: readonly string[], candidateTitle: string): boolean {
  if (newTitleTokens.length === 0) return true;
  const candidateTokens = new Set(meaningfulTitleTokens(candidateTitle));
  const shared = newTitleTokens.filter((tok) => candidateTokens.has(tok)).length;
  return shared / newTitleTokens.length >= TITLE_OVERLAP_MIN_FRACTION;
}

async function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): Promise<BacklogItem[]> {
  const candidates = new Map<number, NodeRecord>();

  const ftsQuery = sanitizeFtsQuery(input.title);
  if (ftsQuery) {
    const newTitleTokens = meaningfulTitleTokens(input.title);
    for (const hit of await store.graph.searchNodes(ftsQuery, {
      limit: 10,
      filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
    })) {
      if (!isLiveBacklogItemNode(hit)) continue;
      const candidateTitle = (hit.metadata as { title?: string } | null)?.title ?? hit.summary ?? '';
      if (!titleMeaningfullyOverlaps(newTitleTokens, candidateTitle)) continue;
      candidates.set(hit.id, hit);
    }
  }

  const scan = input.dedupeScan;
  if (scan?.symbol) {
    for (const hit of await store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupeSymbol: scan.symbol },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.path) {
    for (const hit of await store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupePath: scan.path },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.errorText) {
    for (const hit of await store.graph.queryNodes({
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

export async function createItemNode(store: GraphBacklogStore, input: CreateItemInput): Promise<CreateItemResult> {
  if (!input.idOverride && (typeof input.family !== 'string' || input.family.trim().length === 0)) {
    throw new InvalidArgumentError(
      'family',
      `backlog: createItem requires a non-empty "family" (e.g. "BUG-APIGEN") unless "idOverride" is given — ` +
        `received family=${JSON.stringify(input.family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }

  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new InvalidArgumentError(
      'title',
      `backlog: createItem requires a non-empty "title" — received title=${JSON.stringify(input.title)}.`
    );
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new InvalidArgumentError(
      'body',
      `backlog: createItem requires a non-empty "body" — received body=${JSON.stringify(input.body)}.`
    );
  }
  if (typeof input.repo !== 'string' || input.repo.trim().length === 0) {
    throw new InvalidArgumentError(
      'repo',
      `backlog: createItem requires a non-empty "repo" — received repo=${JSON.stringify(input.repo)}.`
    );
  }

  if (input.idOverride) {
    const existing = await findItemNode(store, input.repo, input.idOverride);
    if (existing) {
      const existingItem = toBacklogItem(existing);
      return { item: existingItem, created: false, duplicateCandidates: [existingItem] };
    }
  }

  const duplicateCandidates = input.force ? [] : await dedupeScan(store, input.repo, input);
  if (duplicateCandidates.length > 0 && !input.force) {
    return { item: duplicateCandidates[0], created: false, duplicateCandidates };
  }

  const known = await knownRepos(store);
  const repoWarning =
    known.size > 0 && !known.has(input.repo)
      ? `repo '${input.repo}' is new to this store — existing repo value(s) here: ${[...known].sort().join(', ')}. If this is meant to be the same project, use the existing repo value instead.`
      : undefined;

  return allocateHumanIdAndInsert(store, input.repo, input.family, input.idOverride, async (humanId, existingAtCommit) => {
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

    const nodeId = await store.graph.writeNode(buildNodeContent(input.repo, humanId, input.title, input.body), {
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

    const node = await store.graph.getNode(nodeId);
    if (!node) throw new Error(`backlog: writeNode returned an id that does not resolve: ${nodeId}`);
    return { item: toBacklogItem(node), created: true, duplicateCandidates: [], ...(repoWarning !== undefined ? { repoWarning } : {}) };
  });
}

export async function getItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<BacklogItem | null> {
  const node = await findItemNode(store, repo, humanId);
  return node ? toBacklogItem(node) : null;
}

async function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord> {
  const node = await findItemNode(store, repo, humanId);
  if (!node) throw buildNotFoundError(store, repo, humanId);
  return node;
}

export async function updateItemNode(store: GraphBacklogStore, repo: string, humanId: string, patch: UpdateItemInput): Promise<BacklogItem> {
  const node = await requireItemNode(store, repo, humanId);
  let finalTitle = '';
  let finalBody = '';
  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const next: BacklogNodeMeta = { ...meta, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.projectPath !== undefined) next.projectPath = patch.projectPath;
    if (patch.importedFrom !== undefined) next.importedFrom = patch.importedFrom;
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
    await store.graph.touch(node.id, touchPatch);
  }
  if (patch.title !== undefined || patch.body !== undefined) {
    const newContent = buildNodeContent(repo, humanId, finalTitle, finalBody);
    await store.adapter
      .executeRun(`UPDATE node SET content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`, [newContent, computeContentHash(newContent), node.id]);
  }
  const updated = await store.graph.getNode(node.id);
  if (!updated) throw buildNotFoundError(store, repo, humanId);
  return toBacklogItem(updated);
}

export async function softDeleteItemNode(store: GraphBacklogStore, repo: string, humanId: string, reason: string): Promise<void> {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidArgumentError(
      'reason',
      `backlog: softDeleteItem requires a non-empty "reason" — received reason=${JSON.stringify(reason)}.`
    );
  }
  const node = await requireItemNode(store, repo, humanId);
  await store.graph.invalidate(node.id, reason);
}

export { dedupeScan };
