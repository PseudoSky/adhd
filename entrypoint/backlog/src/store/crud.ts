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

/**
 * Common English stopwords excluded from the title-overlap check below
 * (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001). Small and deliberately
 * conservative — it only strips words with essentially zero discriminating
 * power ("the", "a", "is", ...), never a domain word. A false negative here
 * (a stopword slipping through as "meaningful") just makes the overlap
 * fraction slightly harder to hit, which is the safe failure direction;
 * stripping a real content word would be the unsafe one, so the list stays
 * short by design rather than exhaustive.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'such', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Minimum fraction of the NEW item's meaningful title tokens that must also
 * appear in a CANDIDATE's title for the candidate to count as a duplicate
 * (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001). Exported so callers/tests can
 * tune it without touching this file's internals.
 *
 * Why title-to-title overlap instead of the FTS hit's bm25 `score`:
 * `store.graph.searchNodes()` (`@adhd/sox-graph-store`) DOES return a
 * per-hit `score` (`-fts_node.rank`, i.e. a positive, higher-is-better bm25
 * score) — but bm25 is corpus- and document-length-relative, not an absolute
 * similarity measure, and empirically it does NOT discriminate this bug's
 * failure mode: a live probe reproducing the exact reported case (a short
 * generic new title vs. a long, verbose, unrelated document that happens to
 * repeat a couple of the new title's common words many times) scored
 * `~0.0000109`, while a genuine short-title-vs-short-title near-duplicate
 * scored `~0.0000113` — the SAME order of magnitude, with no clean
 * separating threshold between them. A long document's sheer token count
 * inflates its bm25 term-frequency component enough to rival a real
 * duplicate's score. Title-to-title token overlap has no such document-
 * length confound: a new item's title can only ever match against a
 * candidate's (typically similarly short) title, so incidental repetition
 * buried in a long candidate BODY can no longer count toward "looks like a
 * duplicate" at all.
 *
 * 0.5 (at least half the new title's meaningful tokens must recur in the
 * candidate's title) was chosen because DESIGN.md §2.4's own worked example
 * ("same bug, different words") is a near-total title rewrite that still
 * shares most of its content words ("database connection pool leaks under
 * load" -> "the database connection pool leaks under load" is 6/6); dropping
 * to a small minority match (e.g. 1-2 shared generic words out of 5) is
 * exactly the false-positive shape this bug reports and must NOT pass.
 */
export const TITLE_OVERLAP_MIN_FRACTION = 0.5;

/**
 * Tokenizes a title into lowercase, stopword-filtered words for the overlap
 * check above. Reuses `sanitizeFtsQuery`'s Unicode-aware letter/number/
 * underscore allowlist so tokenization is consistent with what actually
 * reached the FTS query in the first place.
 */
function meaningfulTitleTokens(title: string): string[] {
  return sanitizeFtsQuery(title)
    .toLowerCase()
    .split(' ')
    .filter((tok) => tok.length > 0 && !TITLE_STOPWORDS.has(tok));
}

/**
 * True iff `candidateTitle` shares at least `TITLE_OVERLAP_MIN_FRACTION` of
 * `newTitleTokens` (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001's second-pass
 * filter — see `TITLE_OVERLAP_MIN_FRACTION`'s doc comment for why this runs
 * instead of / in addition to the FTS hit's own score). If the new title has
 * NO meaningful tokens at all (e.g. it is entirely stopwords/punctuation —
 * an edge case with no positive signal to check), this falls back to
 * `true` (preserve the prior FTS-only behavior) rather than silently
 * disabling dedupe for every all-stopword title.
 */
function titleMeaningfullyOverlaps(newTitleTokens: readonly string[], candidateTitle: string): boolean {
  if (newTitleTokens.length === 0) return true;
  const candidateTokens = new Set(meaningfulTitleTokens(candidateTitle));
  const shared = newTitleTokens.filter((tok) => candidateTokens.has(tok)).length;
  return shared / newTitleTokens.length >= TITLE_OVERLAP_MIN_FRACTION;
}

function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): BacklogItem[] {
  const candidates = new Map<number, NodeRecord>();

  // 1. FTS over title + body — catches "same bug, different words". Sanitized
  // first (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001) — an unsanitized title
  // containing an FTS5-syntax-significant character (`-`, `:`, `(`, `)`, `"`)
  // crashes `searchNodes` outright instead of returning candidates.
  //
  // BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001: a raw FTS hit is NOT itself proof
  // of a duplicate — `searchNodes` has no relevance floor, so any hit within
  // the top 10 used to count, including a long unrelated document that
  // merely repeats a couple of the new title's common words many times.
  // Every FTS hit is now required to ALSO clear the title-to-title overlap
  // check (`titleMeaningfullyOverlaps` — see its doc comment for why this,
  // not the hit's bm25 `score`, is the discriminating signal).
  const ftsQuery = sanitizeFtsQuery(input.title);
  if (ftsQuery) {
    const newTitleTokens = meaningfulTitleTokens(input.title);
    for (const hit of store.graph.searchNodes(ftsQuery, {
      limit: 10,
      filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
    })) {
      if (!isLiveBacklogItemNode(hit)) continue;
      const candidateTitle = (hit.metadata as { title?: string } | null)?.title ?? hit.summary ?? '';
      if (!titleMeaningfullyOverlaps(newTitleTokens, candidateTitle)) continue;
      candidates.set(hit.id, hit);
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
  // BUG-BACKLOG-HUMANID-COLLISION-001 fix #1: `family` is REQUIRED unless
  // `idOverride` is given (SPEC.md §5.1, model.ts `CreateItemInput.family`
  // doc comment). Validated HERE, before any allocation runs, so a missing/
  // empty/whitespace-only `family` can never reach `computeNextHumanId`'s
  // `${family}-NNN` template literal, which used to silently coerce JS
  // `undefined` to the literal string `"undefined"` and mint a
  // `humanId: "undefined-001"` that collides with every other item that hit
  // the same bug. This is store-level defense in depth — it must hold
  // regardless of whether the caller's own schema validation (e.g.
  // apigen-core-client's extracted `CreateItemInput` shape,
  // BUG-APIGEN-CORE-CLIENT-001) enforces `family` as required.
  if (!input.idOverride && (typeof input.family !== 'string' || input.family.trim().length === 0)) {
    throw new InvalidArgumentError(
      'family',
      `backlog: createItem requires a non-empty "family" (e.g. "BUG-APIGEN") unless "idOverride" is given — ` +
        `received family=${JSON.stringify(input.family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }

  // Same defense-in-depth rationale as the `family` guard above (and the
  // upstream BUG-APIGEN-CORE-CLIENT-001 fix it deliberately mirrors): TS
  // `required` only guarantees a caller SUPPLIED the property, never that it
  // is non-empty. `title`/`body`/`repo` are the three other fields whose
  // whole purpose collapses if the value is `""`/whitespace-only — an empty
  // title/body files an unreadable item, and an empty `repo` breaks every
  // `(repo, humanId)`-keyed lookup this store relies on (query.ts, this
  // file's own `dedupeScan`/`knownRepos`). Reject before allocation runs, for
  // the exact reason `family` is checked here rather than left to
  // `computeNextHumanId`.
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

  // BUG-BACKLOG-REPO-LOOKUP-UX-001 (write-time half): a genuinely NEW repo
  // must always be allowed to file its first item (an empty `known` set, or
  // `input.repo` already known, both produce no warning) — this only flags
  // the case most likely to be a typo/inconsistent-repo-string drift: a repo
  // this store has NEVER seen before, filed alongside others it HAS seen.
  // Soft warning only — never blocks the write (per the backlog item's fix
  // direction and this repo's CLAUDE.md "never hard-fail on new repo" rule).
  const known = knownRepos(store);
  const repoWarning =
    known.size > 0 && !known.has(input.repo)
      ? `repo '${input.repo}' is new to this store — existing repo value(s) here: ${[...known].sort().join(', ')}. If this is meant to be the same project, use the existing repo value instead.`
      : undefined;

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
    return { item: toBacklogItem(node), created: true, duplicateCandidates: [], ...(repoWarning !== undefined ? { repoWarning } : {}) };
  });
}

export function getItemNode(store: GraphBacklogStore, repo: string, humanId: string): BacklogItem | null {
  const node = findItemNode(store, repo, humanId);
  return node ? toBacklogItem(node) : null;
}

function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string): NodeRecord {
  const node = findItemNode(store, repo, humanId);
  if (!node) throw buildNotFoundError(store, repo, humanId);
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
    store.graph.touch(node.id, touchPatch);
  }
  if (patch.title !== undefined || patch.body !== undefined) {
    const newContent = buildNodeContent(repo, humanId, finalTitle, finalBody);
    store.db
      .prepare(`UPDATE node SET content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`)
      .run(newContent, computeContentHash(newContent), node.id);
  }
  const updated = store.graph.getNode(node.id);
  if (!updated) throw buildNotFoundError(store, repo, humanId);
  return toBacklogItem(updated);
}

export function softDeleteItemNode(store: GraphBacklogStore, repo: string, humanId: string, reason: string): void {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidArgumentError(
      'reason',
      `backlog: softDeleteItem requires a non-empty "reason" — received reason=${JSON.stringify(reason)}.`
    );
  }
  const node = requireItemNode(store, repo, humanId);
  store.graph.invalidate(node.id, reason);
}

export { dedupeScan };
