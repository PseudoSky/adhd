/**
 * query.ts — read-side operations: listItems/stats/spotlight/readyItems/
 * blockers/dependencyGraph/topoOrder/staleClaims (DESIGN.md §2.5/§13), plus
 * `findItemNode`, the shared (repo, humanId) -> NodeRecord lookup every other
 * store module needs.
 */
import type { NodeFilter, NodeRecord } from '@adhd/sox-graph-store';
import type {
  AuditTrailEntry,
  AuditTrailResult,
  BacklogFilter,
  BacklogItem,
  BacklogStatus,
  DependencyGraph,
  IBacklogFilter,
  IBacklogStats,
  IDateBound,
  IDateRangeFilter,
  IDurationStats,
  IQueryEnvelopeMeta,
  IStatsCoverage,
  Priority,
  StatsScope,
  TopoOrderResult,
} from '../model.js';
import { AmbiguousHumanIdError, BacklogItemNotFoundError, RepoAliasCollisionError, assertOpenScopedStats, isTerminalStatus, resolveStatusSelector } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { BACKLOG_ITEM_TAG, buildNodeName, isLiveBacklogItemNode, normalizeRepoKey, sanitizeFtsQuery, toBacklogItem, type BacklogNodeMeta } from './mapping.js';
import { queryAuditEvents } from './audit-log.js';
import { parseRepoKey } from './repo-nodes.js';

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Exported for RAG-SPEC §3.1's pushdown constraint: `v2/query.ts`'s vector
 * channel (`filter.semantic`/`filter.anchor`/`view:"similar"`) must push its
 * dimensional filters (repo/kind/family/…) into `SemanticBackend.knn`'s
 * `NodeFilter` seam BEFORE any limit is applied — never as a post-filter. The
 * translation from a v1 `BacklogFilter` to a `NodeFilter` already exists
 * exactly once, here; the vector channel reuses it verbatim rather than
 * hand-rolling a second (and inevitably divergent) BacklogFilter→NodeFilter
 * mapping.
 */
export function nodeFilterFromBacklogFilter(filter: BacklogFilter): NodeFilter {
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

/**
 * See `BacklogFilter.excludeArchived`'s doc comment — applied at the
 * NodeRecord layer (same as `applyRootLevelFilter`) so both `listItems` and
 * `renderToMarkdown` (which independently map nodes) share one
 * archived-exclusion implementation instead of `renderToMarkdown`
 * re-implementing its own `!metadata.archivedAt` scan.
 */
function applyExcludeArchivedFilter(nodes: NodeRecord[], filter: BacklogFilter): NodeRecord[] {
  if (!filter.excludeArchived) return nodes;
  return nodes.filter((n) => !(n.metadata as Partial<BacklogNodeMeta> | undefined)?.archivedAt);
}

/**
 * BUG-BACKLOG-003 fix (b) — a stable, deterministic ordering every page
 * boundary is drawn against. `store.graph.queryNodes` issues `LIMIT n OFFSET
 * m` with NO `ORDER BY` at all unless the caller sets `NodeFilter.orderBy`
 * (verified against the installed `@adhd/sox-graph-store` dist:
 * `buildOrderClause`, dist/index.js:754-772 — `nodeFilterFromBacklogFilter`
 * above never sets it). A `LIMIT/OFFSET` page drawn from an UNORDERED SQL
 * result set has no guarantee that two separate calls against the same
 * `WHERE` clause return rows in the same relative order — paging "page 2"
 * after "page 1" could reorder or duplicate rows already seen, even with
 * zero writes in between (confirmed live: root-caused via the installed
 * `sox-graph-store` 0.8.4 SQL, see the backlog item's evidence). Sorting by
 * `id` — the store's own monotonic insertion-order rowid — in JS, ONCE,
 * before any slicing, makes every page boundary reproducible across calls.
 */
function stableNodeOrder(nodes: NodeRecord[]): NodeRecord[] {
  return [...nodes].sort((a, b) => a.id - b.id);
}

/**
 * A `NodeRecord` as `store.graph.searchNodes` (FTS5) returns it — carrying
 * the match's relevance `score` (`@adhd/sox-graph-store`'s `ftsSearch`, which
 * already orders its rows `score DESC`, higher = better match). Structurally
 * a `NodeRecord`, so every existing `NodeRecord[]`-typed caller is untouched;
 * `score` is present only on rows that actually came from the FTS path.
 */
export type ScoredNodeRecord = NodeRecord & { score?: number };

/**
 * The one place a `queryItemNodes`/`listItems`/`listItemsPage` result gets
 * its final, pre-pagination order. A `grep` query's rows already arrived
 * from `store.graph.searchNodes` sorted by FTS relevance (`fetchFilteredNodes`
 * preserves that order — see its own doc comment) — resorting them by
 * `stableNodeOrder`'s insertion-id order, as every caller here used to do
 * unconditionally, silently discarded that ranking and replaced it with an
 * arbitrary one. A non-`grep` query has no relevance signal to preserve, so
 * it still gets `stableNodeOrder`'s deterministic paging guarantee
 * (BUG-BACKLOG-003 fix (b)).
 */
function orderForQuery(nodes: ScoredNodeRecord[], filter: Pick<BacklogFilter, 'grep'>): ScoredNodeRecord[] {
  return filter.grep ? nodes : stableNodeOrder(nodes);
}

/**
 * BUG-BACKLOG-003 fix (a) + (b) — the ONE place `limit`/`offset` are ever
 * applied, and only to an array that has ALREADY been fully filtered
 * (rootLevel, excludeArchived and — for `listItems` — the open/closed
 * status filter) and already put in `stableNodeOrder`. Previously
 * `queryItemNodes` forwarded `filter.limit`/`filter.offset` straight into
 * the SQL-level `NodeFilter` (or, on the grep path, sliced by `offset`
 * AFTER the FTS fetch had already been capped to `filter.limit` — a double
 * bug, since `offset` was then applied to an array already too short to
 * honor it), so the page boundary was drawn BEFORE the open/closed
 * post-filter ever ran: a filtered page silently under-returned instead of
 * signalling "there are more, keep paging". Returns the pagination truth
 * (INTERFACE_v2 §7.4 `IQueryEnvelopeMeta`) so a caller can tell a short page
 * (the result set legitimately ended) from one that merely filtered down
 * hard.
 */
function paginate<T>(sorted: T[], filter: Pick<BacklogFilter, 'limit' | 'offset'>): { page: T[]; meta: IQueryEnvelopeMeta } {
  const total = sorted.length;
  const offset = filter.offset ?? 0;
  const page = filter.limit !== undefined ? sorted.slice(offset, offset + filter.limit) : sorted.slice(offset);
  const meta: IQueryEnvelopeMeta = { total, returned: page.length };
  if (filter.limit !== undefined) meta.limit = filter.limit;
  if (filter.offset !== undefined) meta.offset = filter.offset;
  return { page, meta };
}

/**
 * Internal fetch budget for the grep (FTS5) path — NOT `filter.limit`
 * (BUG-BACKLOG-003 fix (a)). `limit` bounds the OUTPUT page; fetching only
 * `filter.limit` candidate rows and THEN post-filtering/paginating them (the
 * pre-fix behavior) starves both the post-filter and the pagination that
 * come after it. Candidates beyond this budget are the pre-existing,
 * documented grep truncation (INTERFACE_v2 §7.4's "grep full-fetch-then-
 * slice budget") — a separate, already-accepted limitation, not this bug.
 */
const GREP_FETCH_BUDGET = 1000;

/**
 * Fetches every LIVE node matching `filter` — rootLevel/excludeArchived
 * applied — with `limit`/`offset` deliberately WITHHELD (see `paginate`'s
 * doc comment). The shared, unpaginated base both `queryItemNodes` and
 * `listItems` page from, so pagination always runs LAST, over the fully
 * filtered set.
 *
 * A `grep` query's rows carry a real `score` (see `ScoredNodeRecord`) and
 * arrive from `store.graph.searchNodes` already ordered by FTS relevance —
 * `applyRootLevelFilter`/`applyExcludeArchivedFilter` are plain `Array#filter`
 * calls, which preserve that order, so the relevance ranking survives this
 * function intact for `orderForQuery` to use instead of `stableNodeOrder`.
 */
async function fetchFilteredNodes(store: GraphBacklogStore, filter: BacklogFilter): Promise<ScoredNodeRecord[]> {
  // Resolve a case/whitespace-variant `repo` to its canonical stored form
  // BEFORE it becomes an exact-match `namespace` filter below — otherwise
  // 'pseudosky/adhd' silently matches zero rows against 'PseudoSky/adhd'.
  const resolvedFilter: BacklogFilter =
    filter.repo !== undefined ? { ...filter, repo: (await resolveCanonicalRepo(store, filter.repo)).canonical } : filter;

  if (resolvedFilter.grep) {
    const nodeFilter = nodeFilterFromBacklogFilter({ ...resolvedFilter, grep: undefined });
    // Sanitized — same FTS5-syntax-crash guard as crud.ts's dedupeScan
    // (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001): an unsanitized `grep` term
    // containing `-`/`:`/`(`/`)`/`"` crashes `searchNodes` outright.
    const ftsQuery = sanitizeFtsQuery(resolvedFilter.grep);
    if (!ftsQuery) return [];
    const hits = await store.graph.searchNodes(ftsQuery, { limit: GREP_FETCH_BUDGET, filter: nodeFilter });
    return applyExcludeArchivedFilter(applyRootLevelFilter(hits.filter(isLiveBacklogItemNode), resolvedFilter), resolvedFilter);
  }
  // No `nodeFilter.limit`/`nodeFilter.offset` — the SQL fetch is deliberately
  // unbounded here (BUG-BACKLOG-003 fix (a)); `paginate` slices AFTER every
  // post-filter has run.
  const nodeFilter = nodeFilterFromBacklogFilter(resolvedFilter);
  const nodes = await store.graph.queryNodes(nodeFilter);
  return applyExcludeArchivedFilter(applyRootLevelFilter(nodes.filter(isLiveBacklogItemNode), resolvedFilter), resolvedFilter);
}

/** Raw NodeRecord query — used internally where the full node (not just the mapped BacklogItem) is needed. */
export async function queryItemNodes(store: GraphBacklogStore, filter: BacklogFilter = {}): Promise<ScoredNodeRecord[]> {
  const nodes = await fetchFilteredNodes(store, filter);
  return paginate(orderForQuery(nodes, filter), filter).page;
}

export async function listItems(store: GraphBacklogStore, filter: BacklogFilter = {}): Promise<BacklogItem[]> {
  // BUG-BACKLOG-003 fix (a): `applyOpenClosedFilter` reads the MAPPED
  // `BacklogItem.status` — it cannot be expressed in `NodeFilter`, so it can
  // only run once nodes are mapped. Fetch the fully-filtered but UNPAGINATED
  // node set, apply the status filter, and only THEN paginate — so a
  // limited/offset page is drawn from the already-status-filtered set,
  // never before it.
  const nodes = await fetchFilteredNodes(store, filter);
  const items = applyOpenClosedFilter(orderForQuery(nodes, filter).map(toBacklogItem), filter);
  return paginate(items, filter).page;
}

/**
 * BUG-BACKLOG-003 fix (b) — same composition as `listItems`, but ALSO
 * returns the pagination truth (`total`/`returned`/`limit`/`offset`,
 * INTERFACE_v2 §7.4 `IQueryEnvelopeMeta`) a caller needs to tell a short
 * page from the true last page, rather than guessing from `returned <
 * limit` against a `total` it never saw.
 */
export async function listItemsPage(store: GraphBacklogStore, filter: BacklogFilter = {}): Promise<{ items: BacklogItem[]; meta: IQueryEnvelopeMeta }> {
  const nodes = await fetchFilteredNodes(store, filter);
  const items = applyOpenClosedFilter(orderForQuery(nodes, filter).map(toBacklogItem), filter);
  const { page, meta } = paginate(items, filter);
  return { items: page, meta };
}

/**
 * BUG-BACKLOG-HUMANID-COLLISION-001 fix #2: this is THE shared `(repo,
 * humanId) -> NodeRecord` lookup every store module funnels through
 * (`crud.ts`/`lifecycle.ts`/`structure.ts`/`client.ts`'s `requireItem*`
 * helpers all call this, directly or via `buildNotFoundError`'s sibling
 * miss path). It used to silently resolve to "whichever live node happens
 * to match `name`, else whichever is first" when more than one live node
 * shared the same `(repo, humanId)` key — the exact shape of the
 * pre-existing `"undefined-001"` collisions, and the root cause of a real
 * mis-transition (see the backlog item body: a `resolveItem` call intended
 * for one node silently landed on a different, unrelated one). Any lookup
 * that finds >1 live match now throws `AmbiguousHumanIdError` instead of
 * guessing.
 *
 * BUG-BACKLOG-REPO-SPLIT-001 (fix #3 — cross-alias guard): `resolveCanonicalRepo`
 * only reconciles a bare-segment alias (e.g. `'widget'` vs `'acme/widget'`)
 * when at most one of the two spellings already has live nodes — once BOTH
 * are independently "known" it short-circuits each to itself and never
 * merges them (see `findAliasRepoCandidates`'s own doc comment). That means a
 * humanId minted under one alias spelling and, independently, under the
 * other, used to resolve silently to whichever spelling the caller's
 * literal string happened to hit — no error, wrong item. This probes every
 * OTHER alias namespace (`findAliasRepoCandidates`, minus `canonical`
 * itself) for a live node under the same humanId; if one exists AND it is a
 * genuinely different node than the canonical lookup found, this throws
 * `RepoAliasCollisionError` naming every colliding `(repo, nodeId)` pair
 * instead of silently returning the canonical match alone. A canonical miss
 * with an alias hit is NOT collapsed into an error here — that is the
 * existing miss-path job of `buildNotFoundError`'s "did you mean" hint,
 * unchanged.
 */
export async function findItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord | null> {
  const { canonical } = await resolveCanonicalRepo(store, repo);
  const name = buildNodeName(canonical, humanId);
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: canonical, metadata: { humanId } });
  const live = nodes.filter(isLiveBacklogItemNode);
  if (live.length > 1) {
    throw new AmbiguousHumanIdError(canonical, humanId, live.map((n) => n.id));
  }
  const canonicalMatch = live.find((n) => n.name === name) ?? live[0] ?? null;

  const aliasCandidates = (await findAliasRepoCandidates(store, repo)).filter((alias) => alias !== canonical);
  if (aliasCandidates.length > 0) {
    const collisions: Array<{ repo: string; nodeId: number }> = canonicalMatch
      ? [{ repo: canonical, nodeId: canonicalMatch.id }]
      : [];
    for (const alias of aliasCandidates) {
      const aliasNodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: alias, metadata: { humanId } });
      const aliasLive = aliasNodes.filter(isLiveBacklogItemNode);
      for (const node of aliasLive) {
        if (!canonicalMatch || node.id !== canonicalMatch.id) collisions.push({ repo: alias, nodeId: node.id });
      }
    }
    if (canonicalMatch && collisions.length > 1) {
      throw new RepoAliasCollisionError(humanId, collisions);
    }
  }

  return canonicalMatch;
}

/** `metadata.repo` is the source-of-truth field written at create time; `namespace` (== the `repo` a node was written under) is the fallback for the rare row predating that field. Mirrors `toBacklogItem`'s own `meta.repo ?? node.namespace` fallback. */
function nodeRepo(node: NodeRecord): string {
  return (node.metadata as { repo?: string } | undefined)?.repo ?? node.namespace ?? '';
}

/**
 * Finds every LIVE node carrying this `humanId`, across ALL repos (no
 * `namespace` filter) — BUG-BACKLOG-REPO-LOOKUP-UX-001's "did you mean repo
 * X?" hint needs this to distinguish "this humanId truly doesn't exist" from
 * "it exists, just filed under a different repo string than the caller
 * passed." Used only on the miss path (`buildNotFoundError`) — never on the
 * hot successful-lookup path, so it costs nothing when a lookup is correct.
 */
export async function findHumanIdInAnyRepo(store: GraphBacklogStore, humanId: string): Promise<NodeRecord[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], metadata: { humanId } });
  return nodes.filter(isLiveBacklogItemNode);
}

/**
 * FEAT-BACKLOG-006 read side — the redirect half of `mapping.ts`'s
 * `BacklogNodeMeta.renamedFrom`: every LIVE node whose append-only rename
 * history names `(repo, oldHumanId)` as an identity it used to carry.
 * `v2/get.ts`'s `resolveGetTarget` calls this on the miss path (a genuine
 * "not found" is checked FIRST via `findItemNode`/`findHumanIdInAnyRepo`, so
 * this never shadows a live node that still legitimately holds the id), so a
 * citation written against the OLD id resolves to the current item instead
 * of 404ing forever.
 *
 * `renamedFrom.repo` is deliberately the OLD (pre-rename) repo, not the
 * node's CURRENT namespace — a cross-repo migration-with-rename
 * (`repo-migration.ts`'s `migrateRepoItemNode`) moves the node's `namespace`
 * away from `repo` entirely, so this cannot be expressed as a `namespace`
 * filter on the query and instead scans every live backlog item's
 * `renamedFrom` array in application code. Same cost class as
 * `findHumanIdInAnyRepo` above (both are miss-path-only, both scan without a
 * `namespace` restriction) — renames are rare, so this is never on a hot
 * path.
 */
export async function findByRenamedFromId(store: GraphBacklogStore, repo: string | undefined, oldHumanId: string): Promise<NodeRecord[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG] });
  return nodes.filter((n) => {
    if (!isLiveBacklogItemNode(n)) return false;
    const renamedFrom = (n.metadata as Partial<BacklogNodeMeta> | undefined)?.renamedFrom;
    if (!Array.isArray(renamedFrom)) return false;
    return renamedFrom.some((entry) => entry?.humanId === oldHumanId && (repo === undefined || entry?.repo === repo));
  });
}

/**
 * Every distinct repo value any LIVE backlog item is currently filed under.
 * Used by `createItemNode`'s soft repo-drift warning (write-time half of
 * BUG-BACKLOG-REPO-LOOKUP-UX-001) — an empty store (no items yet) has no
 * "known" repos, so the very first item filed under any repo string never
 * triggers a false-positive warning.
 */
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

/**
 * Case/whitespace-insensitive repo resolution (BUG-BACKLOG-REPO-LOOKUP-UX-001
 * hardening — this repo's namespace column is otherwise matched by exact
 * string, so 'adhd' and 'PseudoSky/adhd' were two disjoint scopes to every
 * verb). Looks `repo` up against every LIVE repo value already in the store
 * via `normalizeRepoKey`. If a stored value matches once normalized, that
 * EXACT stored form is returned as `canonical` (never `repo` itself), so
 * every reader/writer converges on the one casing already on disk. A repo
 * string never seen before — even after normalizing — is always a
 * genuinely new project: `isNewRepo:true`, `canonical` equal to the input
 * unchanged. This never strips or rewrites a namespace prefix; it only
 * collapses exact case/whitespace variants of an ALREADY-namespaced value.
 *
 * TASK-001 hardening: whole-string normalization (above) cannot see past an
 * owner prefix — `normalizeRepoKey('Owner/X')` is `'owner/x'`, which never
 * equals `normalizeRepoKey('X')` (`'x'`), so a bare repo `X` and an
 * owner-qualified spelling of the SAME project, `Owner/X`, silently forked
 * into two disjoint scopes (this is `store/mapping.ts`'s lowercase-only
 * `normalizeRepoKey` — a second, narrower implementation than `model.ts`'s
 * bare-segment one, and the two never agreeing is exactly the divergence
 * TASK-001 names). `v2/query.ts`'s `resolveRepoCandidates` already treats a
 * bare name and its owner-qualified spelling as the SAME repo for reads
 * (AC-7) — this mirrors that exact predicate (same bare segment, via
 * `repo-nodes.ts`'s `parseRepoKey`, AND compatible owners: equal when both
 * sides name one, otherwise unconstrained) for the write/lookup path, so v1
 * and v2 stop disagreeing.
 *
 * A bare name that matches known repos under >1 DIFFERENT owner (AC-24's
 * genuine ambiguity — `alice/tool` and `bob/tool` both real, distinct
 * projects) is deliberately NOT collapsed: picking one would silently merge
 * two unrelated projects, which is worse than treating the ask as new. That
 * case falls through to `isNewRepo:true` (a caller resolving `tool` gets some
 * caller-visible warning through `knownRepos`-based UX elsewhere, not a
 * hidden merge here).
 */
export async function resolveCanonicalRepo(store: GraphBacklogStore, repo: string): Promise<{ canonical: string; isNewRepo: boolean }> {
  const known = await knownRepos(store);
  if (known.has(repo)) return { canonical: repo, isNewRepo: false };
  const normalized = normalizeRepoKey(repo);
  for (const candidate of known) {
    if (normalizeRepoKey(candidate) === normalized) return { canonical: candidate, isNewRepo: false };
  }

  let asked;
  try {
    asked = parseRepoKey(repo);
  } catch {
    // Not a parseable repo key at all (empty/garbage) — leave resolution to
    // the exact/case-insensitive checks above; this read path must stay
    // total rather than throwing on an already-invalid input.
    return { canonical: repo, isNewRepo: true };
  }
  const bareMatches = new Set<string>();
  for (const candidate of known) {
    let parsed;
    try {
      parsed = parseRepoKey(candidate);
    } catch {
      continue;
    }
    if (parsed.bare.toLowerCase() !== asked.bare.toLowerCase()) continue;
    if (asked.owner !== undefined && parsed.owner !== undefined && asked.owner.toLowerCase() !== parsed.owner.toLowerCase()) continue;
    bareMatches.add(candidate);
  }
  if (bareMatches.size === 1) return { canonical: [...bareMatches][0]!, isNewRepo: false };

  return { canonical: repo, isNewRepo: true };
}

/**
 * BUG-BACKLOG-REPO-SPLIT-001: every candidate namespace in `known` that
 * bare-segment-matches `repo` under the SAME predicate `resolveCanonicalRepo`
 * uses above (same bare segment, case-insensitive; compatible owners — equal
 * when both sides name one, unconstrained otherwise) — but, unlike
 * `resolveCanonicalRepo`, WITHOUT that function's line-379 early return
 * (`if (known.has(repo)) return …` before the bare-segment loop ever runs)
 * and WITHOUT collapsing to a single winner. That early return is exactly
 * what lets two literal repo strings that are the same logical project by
 * bare-segment matching (e.g. `'adhd'` and `'PseudoSky/adhd'`) go
 * unreconciled once BOTH already have live nodes: each literal spelling
 * short-circuits to itself before the alias logic ever sees the other side.
 *
 * This helper is the probe `findItemNode` uses to detect that exact
 * unreconciled-alias shape: it deliberately DOES include `repo` itself in the
 * result whenever `repo` is itself a member of `known` (the literal
 * self-match `resolveCanonicalRepo` short-circuits past), and it returns
 * EVERY matching candidate rather than only when there is exactly one — the
 * caller (`findItemNode`) needs the full candidate set to know whether more
 * than one of them independently carries a live node for the same humanId.
 *
 * Cost: a repo with no bare-segment alias in `known` returns `[]` here, so
 * the common case (no aliasing at all) is a single `knownRepos` scan plus a
 * cheap loop — no behavior change, no extra query, for every caller that
 * never hits this shape.
 */
export async function findAliasRepoCandidates(store: GraphBacklogStore, repo: string): Promise<string[]> {
  const known = await knownRepos(store);
  let asked;
  try {
    asked = parseRepoKey(repo);
  } catch {
    // Mirrors resolveCanonicalRepo's own guard (lines 385-393): an
    // unparseable repo key has no bare segment to match against, so there
    // are no alias candidates — stay total, never throw.
    return [];
  }
  const matches = new Set<string>();
  for (const candidate of known) {
    let parsed;
    try {
      parsed = parseRepoKey(candidate);
    } catch {
      continue;
    }
    if (parsed.bare.toLowerCase() !== asked.bare.toLowerCase()) continue;
    if (asked.owner !== undefined && parsed.owner !== undefined && asked.owner.toLowerCase() !== parsed.owner.toLowerCase()) continue;
    matches.add(candidate);
  }
  return [...matches];
}

/**
 * Builds the `BacklogItemNotFoundError` every miss site throws — the single
 * place that decides whether a "did you mean repo X?" hint is warranted
 * (BUG-BACKLOG-REPO-LOOKUP-UX-001, read-time half). Callers pass the SAME
 * `(repo, humanId)` they just failed to find via `findItemNode` — this
 * re-queries WITHOUT the `namespace` restriction to see if the humanId lives
 * under a different repo string instead.
 */
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

/** Every consumer of `IBacklogStats.byPriority`/`byPriorityAllStatuses` sees all four keys, zero-filled — never `?? 0` at the call site, never an absent key mistaken for a genuine zero. */
function zeroPriorities(): Record<Priority, number> {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
}

function countByPriority(items: BacklogItem[]): Record<Priority, number> {
  const out = zeroPriorities();
  for (const item of items) {
    if (item.priority) out[item.priority] += 1;
  }
  return out;
}

/**
 * `StatsScope` composed with the v2 time-boundary grammar (`IDateRangeFilter`,
 * INTERFACE_v2 §2.1/§7.7) — `computeStats`'s FEAT-010 half reads
 * `scope.dateRange.updated`, mirroring how the query surface elsewhere reads
 * `filter.dateRange.updated`. An intersection of two ALREADY-existing
 * contract types (`model.ts`'s `StatsScope` and `IDateRangeFilter`), not a
 * new parallel type — `StatsScope` itself is untouched, so every existing
 * caller (a bare `{repo, projectPath}`) is still a valid argument.
 */
export type StatsScopeWithWindow = StatsScope & { dateRange?: IDateRangeFilter };

/**
 * FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 — everything `computeStats`
 * can scope by: the FULL v2 filter vocabulary (family/status/kind/priority/…
 * are no longer silently discarded — the whole point of the work order) plus
 * the window. `StatsScopeWithWindow` is a subset, so every pre-existing
 * caller (v1 `admin:stats`, the narrow `StatsScope`-typed ops) still
 * compiles against the widened parameter type.
 */
export type StatsQuery = IBacklogFilter & { dateRange?: IDateRangeFilter };

/** AC-15: "window defaults to last 30 days when `dateRange` is absent". */
const DEFAULT_STATS_WINDOW_MS = 30 * 24 * 60 * 60_000;

function resolveStatsWindow(scope: StatsQuery): IDateBound {
  const updated = scope.dateRange?.updated;
  if (updated?.since !== undefined || updated?.until !== undefined) {
    const window: IDateBound = {};
    if (updated.since !== undefined) window.since = updated.since;
    if (updated.until !== undefined) window.until = updated.until;
    return window;
  }
  return { since: new Date(Date.now() - DEFAULT_STATS_WINDOW_MS).toISOString() };
}

/**
 * FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 — applies the v2
 * `IStatusSelector` (`open`/`closed`/`all` closedness words, a single status,
 * or an explicit status LIST) over already-mapped items. The store-level
 * `applyOpenClosedFilter` only handles the narrow v1 `BacklogFilter.status`
 * (single value), so the v2 vocabulary is resolved here, once, exactly the
 * way `v2/query.ts`'s own `applyStatusSelector` does for the list view.
 * ABSENT selector means "no status restriction" — deliberately NOT the §2
 * `'open'` default: `computeStats` is also v1 `admin:stats`'s backend, whose
 * contract is all-status, and no existing caller may silently shrink.
 *
 * Returns a `(BacklogItem) => boolean` predicate so a caller can filter a
 * JOINT `(node, item)` pair array — `computeStats` must keep nodes and
 * items index-aligned for `computeHistoryDerivedStats`.
 */
function statusKeepPredicate(selector: IBacklogFilter['status'] | undefined): (item: BacklogItem) => boolean {
  if (selector === undefined) return () => true;
  const resolved = resolveStatusSelector(selector);
  if (resolved.mode === 'explicit') {
    const wanted = new Set<BacklogStatus>(resolved.statuses);
    return (it) => wanted.has(it.status);
  }
  if (resolved.closedness === 'all') return () => true;
  const wantOpen = resolved.closedness === 'open';
  return (it) => !isTerminalStatus(it.status) === wantOpen;
}

/** FEAT-009 — one-decimal percentage, so `citationCoverage` is a clean number without floating-point noise. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** ISO-8601 strings compare lexicographically the same as chronologically — every timestamp here is `Date.prototype.toISOString()`'s fixed-width format, so this never needs `Date.parse`. */
function withinWindow(at: string, window: IDateBound): boolean {
  if (window.since !== undefined && at < window.since) return false;
  if (window.until !== undefined && at > window.until) return false;
  return true;
}

function eventTo(event: AuditTrailEntry): BacklogStatus | undefined {
  return (event.detail as { to?: BacklogStatus }).to;
}
function eventFrom(event: AuditTrailEntry): BacklogStatus | undefined {
  return (event.detail as { from?: BacklogStatus }).from;
}

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx] as number;
}

/** AC-15 — `null` percentiles mean "no sample" (`IDurationStats` doc comment), never a fabricated `0ms`. */
function durationStats(durationsMs: number[]): IDurationStats {
  if (durationsMs.length === 0) return { medianMs: null, p90Ms: null, sampleSize: 0 };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return { medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), sampleSize: sorted.length };
}

/** Clips the dwell span `[startMs, endMs)` to `window` and, if any of it survives, records the overlap under `status` — AC-15's negative control ("a transition outside the window must not contribute to the window's counts") is enforced HERE, at the one place every span is recorded. */
function addStatusSpan(durationsByStatus: Map<string, number[]>, status: string, startMs: number, endMs: number, window: IDateBound): void {
  const winStart = window.since !== undefined ? Date.parse(window.since) : -Infinity;
  const winEnd = window.until !== undefined ? Date.parse(window.until) : Infinity;
  const clippedStart = Math.max(startMs, winStart);
  const clippedEnd = Math.min(endMs, winEnd);
  if (clippedEnd <= clippedStart) return;
  const arr = durationsByStatus.get(status) ?? [];
  arr.push(clippedEnd - clippedStart);
  durationsByStatus.set(status, arr);
}

interface HistoryDerivedStats {
  coverage: IStatsCoverage;
  timeToResolution?: IDurationStats;
  timeInStatus?: Record<string, IDurationStats>;
  reopenRate?: number;
  /** Items that reached a terminal status inside `window` (AC-15's "closed this week"). */
  closedInWindow: number;
}

/**
 * FEAT-010 / DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001 — everything `IBacklogStats`
 * derives from the persisted `transition` audit-event log (`audit-log.ts`),
 * for the `(nodes, items)` pair `computeStats` already fetched (same index
 * alignment — both mapped from the identical `fetchFilteredNodes` result, in
 * the same order). One `queryAuditEvents` call per item — the same N+1
 * pattern this file already uses in `readyItems`/`dependencyGraph`.
 */
async function computeHistoryDerivedStats(store: GraphBacklogStore, nodes: NodeRecord[], items: BacklogItem[], window: IDateBound): Promise<HistoryDerivedStats> {
  let auditWindowStart: string | undefined;
  let itemsWithHistory = 0;
  const resolutionDurationsMs: number[] = [];
  const durationsByStatus = new Map<string, number[]>();
  let reachedTerminalInWindowCount = 0;
  let reopenedAfterCount = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const item = items[i];
    if (!node || !item) continue;
    const events = await queryAuditEvents(store, node.id);
    if (events.length === 0) continue;

    for (const e of events) {
      if (auditWindowStart === undefined || e.at < auditWindowStart) auditWindowStart = e.at;
    }
    if (events.some((e) => withinWindow(e.at, window))) itemsWithHistory += 1;

    const transitions = events.filter((e) => e.kind === 'transition');

    // time-to-resolution: created -> the FIRST transition into a terminal
    // status, counted only when that transition itself falls inside `window`
    // (AC-15's negative control).
    const firstTerminal = transitions.find((e) => {
      const to = eventTo(e);
      return to !== undefined && isTerminalStatus(to);
    });
    if (firstTerminal && withinWindow(firstTerminal.at, window)) {
      const createdMs = Date.parse(item.createdAt);
      const resolvedMs = Date.parse(firstTerminal.at);
      if (Number.isFinite(createdMs) && Number.isFinite(resolvedMs) && resolvedMs >= createdMs) {
        resolutionDurationsMs.push(resolvedMs - createdMs);
      }
    }

    // time-in-status: walk the transition timeline as dwell segments
    // (created -> t1.from, t1 -> t2.from, …, tLast -> now), clipping each to
    // `window` via `addStatusSpan`.
    let segStart = Date.parse(item.createdAt);
    let segStatus: BacklogStatus | undefined = transitions.length > 0 ? eventFrom(transitions[0]!) : item.status;
    for (const t of transitions) {
      const tAt = Date.parse(t.at);
      if (segStatus !== undefined) addStatusSpan(durationsByStatus, segStatus, segStart, tAt, window);
      segStart = tAt;
      segStatus = eventTo(t);
    }
    if (segStatus !== undefined) addStatusSpan(durationsByStatus, segStatus, segStart, Date.now(), window);

    // reopen rate: item reached a terminal status inside `window`, then
    // LATER transitioned to a non-terminal status (any time after).
    let sawWindowTerminal = false;
    let reopened = false;
    for (const t of transitions) {
      const to = eventTo(t);
      if (to === undefined) continue;
      if (!sawWindowTerminal) {
        if (isTerminalStatus(to) && withinWindow(t.at, window)) sawWindowTerminal = true;
      } else if (!isTerminalStatus(to)) {
        reopened = true;
      }
    }
    if (sawWindowTerminal) {
      reachedTerminalInWindowCount += 1;
      if (reopened) reopenedAfterCount += 1;
    }
  }

  const coverage: IStatsCoverage = { itemsWithHistory, itemsTotal: items.length };
  if (auditWindowStart !== undefined) coverage.auditWindowStart = auditWindowStart;

  const timeInStatus: Record<string, IDurationStats> = {};
  for (const [status, durations] of durationsByStatus) timeInStatus[status] = durationStats(durations);

  const result: HistoryDerivedStats = { coverage, closedInWindow: reachedTerminalInWindowCount };
  if (resolutionDurationsMs.length > 0) result.timeToResolution = durationStats(resolutionDurationsMs);
  if (Object.keys(timeInStatus).length > 0) result.timeInStatus = timeInStatus;
  if (reachedTerminalInWindowCount > 0) result.reopenRate = reopenedAfterCount / reachedTerminalInWindowCount;
  return result;
}

/**
 * INTERFACE_v2 §2.2 `view:"summary"` / FEAT-010 — the v2 stats contract
 * (`model.ts`'s `IBacklogStats`).
 *
 * **BUG-023 (CRITICAL, CONFIRMED LIVE 2026-08-21) fix.** The old
 * implementation computed `byPriority`/`byKind`/`byFamily` via `countByKey`
 * over ALL items (both open and closed) while `open`/`closed` were computed
 * separately — so `byPriority.CRITICAL` reported 33 (every CRITICAL item,
 * including RESOLVED/FIXED/VERIFIED ones) while only 16 CRITICAL items were
 * actually open. The fix: `byPriority`/`byKind`/`byFamily`/`byRepo` are now
 * computed over `open` ONLY (the field every triage query means), and the
 * all-status totals are carried in the separately-named
 * `byPriorityAllStatuses`/`byKindAllStatuses`/`byFamilyAllStatuses`/
 * `byRepoAllStatuses` fields — both REQUIRED, so neither can silently default
 * to the wrong scope. `assertOpenScopedStats` re-checks this invariant at
 * runtime before every return, so the exact BUG-023 shape (an open-scoped
 * map summing higher than `open`) throws instead of shipping.
 */
export async function computeStats(store: GraphBacklogStore, scope: StatsQuery = {}): Promise<IBacklogStats> {
  // FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001: the OLD code built a
  // filter from `scope.repo`/`scope.projectPath` ONLY — every other filter
  // key a caller passed (family, status, kind, priority, …) was silently
  // discarded, and the summary happily reported unscoped numbers that looked
  // scoped. The push-down below carries every store-vocabulary key the
  // caller supplied; the status selector is applied over the mapped items
  // (it is a closedness predicate NodeFilter cannot express — the same
  // reason `listItems` post-filters).
  const pushDown: BacklogFilter = {
    repo: scope.repo,
    projectPath: scope.projectPath,
    kind: scope.kind,
    family: scope.family,
    priority: typeof scope.priority === 'string' ? scope.priority : undefined,
    plan: scope.plan,
    assignee: scope.assignee,
    claimedBy: scope.claimedBy,
    tags: scope.tags !== undefined ? [...scope.tags] : undefined,
    importedFrom: scope.importedFrom,
    rootLevel: scope.rootLevel,
    excludeArchived: scope.excludeArchived,
  };
  const nodes = await fetchFilteredNodes(store, pushDown);
  const mapped = nodes.map(toBacklogItem);
  // Status selection filters the (node, item) PAIRS jointly — never `items`
  // alone: `computeHistoryDerivedStats` consumes `nodes[i]`/`items[i]` at
  // the same index, and a single-array filter would silently misalign every
  // history stat onto the wrong item (the exact silent-wrong-data class this
  // package exists to prevent).
  const keep = statusKeepPredicate(scope.status);
  const keptNodes: NodeRecord[] = [];
  const keptItems: BacklogItem[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const item = mapped[i];
    if (node === undefined || item === undefined) continue;
    if (keep(item)) {
      keptNodes.push(node);
      keptItems.push(item);
    }
  }
  const items = keptItems;
  const open = items.filter((it) => !isTerminalStatus(it.status));
  const closed = items.filter((it) => isTerminalStatus(it.status));

  const window = resolveStatsWindow(scope);
  const history = await computeHistoryDerivedStats(store, keptNodes, items, window);

  // AC-15 windowed activity: `openedInWindow` reads `item.createdAt` directly
  // (not the audit log) — an item's creation is durable on the item itself,
  // so this is exact for EVERY item, including ones that predate the audit
  // log entirely (unlike `closedInWindow`, which needs a persisted
  // `transition` event and so only sees items `coverage` reports as having
  // history — the exact reason `coverage` is REQUIRED alongside it).
  const openedInWindow = items.filter((it) => withinWindow(it.createdAt, window)).length;

  // FEAT-009 — citation aggregates, derived from the SAME in-memory items
  // every other count reads (zero extra queries). Coverage is REQUIRED on
  // the contract, so a "citation coverage" that was never computed cannot
  // silently ship as a stale number.
  const citationsTotal = items.reduce((sum, it) => sum + it.citations.length, 0);
  const itemsWithCitations = items.filter((it) => it.citations.length > 0).length;
  const citationCoverage = items.length === 0 ? 0 : round1((itemsWithCitations / items.length) * 100);
  const byFamilyCitationCoverage: Record<string, number> = {};
  for (const family of new Set(items.map((it) => it.family ?? '(none)'))) {
    const familyItems = items.filter((it) => (it.family ?? '(none)') === family);
    const familyWithCitations = familyItems.filter((it) => it.citations.length > 0).length;
    byFamilyCitationCoverage[family] = familyItems.length === 0 ? 0 : round1((familyWithCitations / familyItems.length) * 100);
  }

  const stats: IBacklogStats = {
    total: items.length,
    open: open.length,
    closed: closed.length,
    // AC-15 — "how many closed/opened THIS WEEK", answered over `window`
    // rather than all-time (the bug this fixes: `view:"summary"` used to
    // return only unwindowed all-time total/open/closed regardless of
    // `dateRange`, so a caller asking "since Monday" got the same numbers as
    // "ever").
    closedInWindow: history.closedInWindow,
    openedInWindow,
    netInWindow: openedInWindow - history.closedInWindow,
    byStatus: countByKey(items, (it) => it.status),
    // BUG-023 — OPEN-scoped, never the unscoped `items` array.
    byPriority: countByPriority(open),
    byPriorityAllStatuses: countByPriority(items),
    byKind: countByKey(open, (it) => it.kind),
    byKindAllStatuses: countByKey(items, (it) => it.kind),
    byFamily: countByKey(open, (it) => it.family),
    byFamilyAllStatuses: countByKey(items, (it) => it.family),
    // BUG-024 fix: byRepo/byRepoAllStatuses used to hardcode {} whenever
    // scope.repo was supplied, discarding the one-key breakdown the scope
    // makes trivial to compute (`{repo: n}`) instead of just returning it.
    // countByKey over the already repo-filtered `open`/`items` arrays gives
    // exactly that single-key map for a scoped call, and the full breakdown
    // for an unscoped one — no ternary needed either way.
    byRepo: countByKey(open, (it) => it.repo),
    byRepoAllStatuses: countByKey(items, (it) => it.repo),
    citationsTotal,
    citationCoverage,
    byFamilyCitationCoverage,
    coverage: history.coverage,
    window,
  };
  if (history.timeToResolution) stats.timeToResolution = history.timeToResolution;
  if (history.timeInStatus) stats.timeInStatus = history.timeInStatus;
  if (history.reopenRate !== undefined) stats.reopenRate = history.reopenRate;

  // BUG-023's runtime teeth (model.ts `assertOpenScopedStats`): throws if any
  // open-scoped map was ever computed over the wrong (all-status) array.
  assertOpenScopedStats(stats);
  return stats;
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
  const ready: BacklogItem[] = [];
  for (const item of openItems) {
    if (item.claimedBy) continue;
    const node = await findItemNode(store, item.repo, item.humanId);
    if (!node) continue;
    const targets = (await dependsOnTargets(store, node.id)).filter((n) => !n.tInvalid);
    if (targets.every((t) => isTerminalStatus(toBacklogItem(t).status))) ready.push(item);
  }
  return ready;
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

export async function staleClaims(store: GraphBacklogStore, maxAgeMin: number, scope: StatsScope = {}): Promise<BacklogItem[]> {
  const items = await listItems(store, { repo: scope.repo, projectPath: scope.projectPath });
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
  // DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: real, persisted transition/claim
  // events (audit-log.ts) — previously the ONLY entries `auditTrail` could
  // ever produce were synthesized from durable fields (created/citations/
  // notes), so every past status/claim change beyond the LATEST one was
  // unrecoverable. Items created/transitioned before this fix landed simply
  // have no events here yet (nothing to backfill from) — new activity from
  // this point on is fully covered.
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
