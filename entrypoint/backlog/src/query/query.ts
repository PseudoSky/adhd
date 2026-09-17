/**
 * query.ts — the `query` verb (SPEC.md §5, §5a, §6.5) and its `view` union.
 *
 * `queryIssues` implements §6.5's "one composition algorithm" (rules 1-7) for
 * `view:'list'` (the default) in full, then dispatches every other `view`
 * value to its own focused implementation — each is a graph traversal over
 * the SAME read-only primitives in `resolve.ts`/`card.ts`, never a second
 * copy of the pagination machinery.
 */

import type { GraphBackend, NodeFilter, NodeRecord } from '@adhd/sox-graph-store';
import type { SearchQuery, SearchResult, StoreSearchBackend } from '@adhd/sox-hybrid-search';
import { BacklogValidationError, InvalidArgumentError } from '../write/errors.js';
import { assembleIssueCards, assertKnownIssueFields, isStatusTerminal } from './card.js';
import {
  getOutgoingEdges,
  intersectCandidateSets,
  resolveIssuePlacement,
  tryResolveComponentRef,
  tryResolveRef,
} from './resolve.js';
import type { IQueryEnvelopeMeta } from '../envelope.js';
import {
  DEFAULT_ISSUE_CARD_FIELDS,
  DEFAULT_QUERY_LIMIT,
  type IComponentSummary,
  type IDependencyGraph,
  type IIssueCard,
  type IIssueField,
  type IIssueFilter,
  type IIssuePage,
  type IIssueQueryInput,
  type IIssueQueryResult,
  type ILocationSummary,
  type IOverlapGroup,
  type IProjectSummary,
  type ITopoOrderResult,
  MAX_QUERY_LIMIT,
} from './types.js';
import { querySimilarView } from './views/semantic.js';
import { listComponents, listLocations, listProjects } from './views/registry.js';
import { isSemanticSearchReadable } from '../store/semantic-search.js';

/**
 * The dependencies `query`/the view helpers need. `search` is OPTIONAL —
 * `@adhd/sox-embedding-provider`/`@adhd/sox-vector-store` are
 * `optionalDependencies` of this package (package.json), so a store opened
 * without a configured embedding backend simply cannot serve
 * `filter.semantic`/`view:'similar'`; those paths throw
 * `InvalidArgumentError('semantic', ...)` rather than silently degrading to a
 * grep-only result the caller did not ask for.
 */
export interface IQueryStoreHandle {
  readonly graph: GraphBackend;
  readonly search?: {
    readonly backend: StoreSearchBackend;
    /** Embeds `filter.semantic`'s free text into the SAME vector space `backend`'s vector store was built against. */
    embedQuery(text: string): Promise<Float32Array>;
  };
}

function assertQueryLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_QUERY_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer ≤ ${MAX_QUERY_LIMIT}, got ${limit}`);
  }
  return limit;
}

/** SPEC.md §6.5 rule 5: `after` is incompatible with `sort` and with `grep`/`semantic`. */
function assertKeysetCompatibility(input: IIssueQueryInput): void {
  if (input.after === undefined) return;
  if (input.sort !== undefined) {
    throw new InvalidArgumentError(
      'sort',
      'sort is incompatible with keyset pagination (after) — request the first page unsorted, or page by offset if a non-insertion order is required',
    );
  }
  if (input.filter?.grep !== undefined || input.filter?.semantic !== undefined) {
    throw new InvalidArgumentError(
      'after',
      'after (keyset) is incompatible with grep/semantic search — these route through the ranked search primitives, which have no rowid-ordered keyset contract; page a searched result set by sort + offset (rule 6) instead',
    );
  }
}

/** Union the incoming-edge `src` sets for every resolved target of a multi-valued edge-scoped filter value (e.g. `kind: ['BUG','FEAT']` — OR within one filter dimension; AND is applied ACROSS dimensions by the caller via {@link intersectCandidateSets}). */
async function resolveMultiValuedEdgeScoped(
  graph: GraphBackend,
  input: { rel: string; expectedKind: string; refs: readonly string[] },
): Promise<Set<number>> {
  const union = new Set<number>();
  for (const ref of input.refs) {
    const resolved = await tryResolveRef(graph, input.expectedKind, ref);
    if (!resolved) continue; // unresolved name/uid contributes nothing — never an error on a read path (§6.1)
    const edges = await graph.getEdges({ dst: resolved.id, rel: input.rel });
    for (const e of edges) union.add(e.src);
  }
  return union;
}

/** `status: 'open' | 'closed' | 'all'` (SPEC.md §6.5's carried-forward `IStatusSelector`) — resolved by scanning the `status` catalog for its `terminal` flag, then unioning `has_status` edges into every matching status row. */
async function resolveOpenClosedCandidates(graph: GraphBackend, want: 'open' | 'closed'): Promise<Set<number>> {
  const statuses = await graph.queryNodes({ kind: 'status', liveOnly: true });
  const matching = statuses.filter((s) => isStatusTerminal(s) === (want === 'closed'));
  const union = new Set<number>();
  for (const s of matching) {
    const edges = await graph.getEdges({ dst: s.id, rel: 'has_status' });
    for (const e of edges) union.add(e.src);
  }
  return union;
}

/** Resolve every edge-scoped filter dimension present in `filter` to its candidate set, then AND them together (SPEC.md §6.5 rules 3-4). Returns `undefined` when no edge-scoped filter was given at all (⇒ no `ids` restriction on the composed `NodeFilter`). */
async function resolveEdgeScopedFilterIds(graph: GraphBackend, filter: IIssueFilter | undefined): Promise<Set<number> | undefined> {
  if (!filter) return undefined;
  const perDimension: Array<Set<number>> = [];

  let projectUid: string | undefined;
  if (filter.project !== undefined) {
    const project = await tryResolveRef(graph, 'project', filter.project);
    if (!project) return new Set(); // unresolved project name ⇒ zero matches (§6.1 read-path rule), short-circuit
    projectUid = project.uid;
    const ownedComponents = await graph.getEdges({ src: project.id, rel: 'owns_project' });
    const union = new Set<number>();
    for (const compEdge of ownedComponents) {
      const issueEdges = await graph.getEdges({ src: compEdge.dst, rel: 'owns_component' });
      for (const e of issueEdges) union.add(e.dst);
    }
    perDimension.push(union);
  }

  if (filter.component !== undefined) {
    const component = projectUid !== undefined
      ? await tryResolveComponentRef(graph, projectUid, filter.component)
      : await tryResolveRef(graph, 'component', filter.component);
    if (!component) return new Set();
    const edges = await graph.getEdges({ src: component.id, rel: 'owns_component' });
    perDimension.push(new Set(edges.map((e) => e.dst)));
  }

  if (filter.kind !== undefined) {
    const refs = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    perDimension.push(await resolveMultiValuedEdgeScoped(graph, { rel: 'has_kind', expectedKind: 'kind', refs }));
  }

  if (filter.status !== undefined && filter.status !== 'all') {
    if (filter.status === 'open' || filter.status === 'closed') {
      perDimension.push(await resolveOpenClosedCandidates(graph, filter.status));
    } else {
      const refs = Array.isArray(filter.status) ? filter.status : [filter.status];
      perDimension.push(await resolveMultiValuedEdgeScoped(graph, { rel: 'has_status', expectedKind: 'status', refs }));
    }
  }

  if (filter.priority !== undefined) {
    const refs = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
    perDimension.push(await resolveMultiValuedEdgeScoped(graph, { rel: 'has_priority', expectedKind: 'priority', refs }));
  }

  if (filter.author !== undefined) {
    perDimension.push(await resolveMultiValuedEdgeScoped(graph, { rel: 'authored_by', expectedKind: 'agent', refs: [filter.author] }));
  }

  if (filter.plan !== undefined) {
    // `part_of` is declared `issue -> issue` (both endpoints the SAME kind),
    // so the generic `relIsSourceDirected` direction lookup cannot disambiguate
    // it (source_kind === target_kind === 'issue'). Hand-roll the traversal
    // instead of routing through `resolveEdgeScopedCandidates`: a plan is the
    // edge TARGET, its members are `getEdges({dst: plan.id, rel:'part_of'})`'s
    // `src`s — the same dst-directed shape `resolveMultiValuedEdgeScoped`
    // already uses for `kind`/`status`/`priority`/`author`.
    const plan = await tryResolveRef(graph, 'issue', filter.plan);
    if (!plan) return new Set(); // unresolved plan ⇒ zero matches (§6.1 read-path rule)
    const edges = await graph.getEdges({ dst: plan.id, rel: 'part_of' });
    perDimension.push(new Set(edges.map((e) => e.src)));
  }

  if (filter.projectPath !== undefined) {
    // `projectPath` matches `component.meta.path` (repo-relative, SPEC.md §3)
    // exactly — distinct from `filter.component`'s uid/name lookup. Multiple
    // live components CAN share a path across different projects, so every
    // match's owned issues are unioned, mirroring the permissive multi-match
    // handling every other edge-scoped dimension already uses.
    const components = await graph.queryNodes({
      kind: 'component',
      liveOnly: true,
      metadata: { path: { eq: filter.projectPath } },
    } as unknown as NodeFilter);
    if (components.length === 0) return new Set(); // unresolved path ⇒ zero matches (§6.1 read-path rule)
    const union = new Set<number>();
    for (const component of components) {
      const edges = await graph.getEdges({ src: component.id, rel: 'owns_component' });
      for (const e of edges) union.add(e.dst);
    }
    perDimension.push(union);
  }

  return intersectCandidateSets(perDimension);
}

/** `NodeFilter.metadata` for `assignee`/`claimedBy`/`closedAt` (SPEC.md §6.5 rule 4). */
function buildMetadataFilter(filter: IIssueFilter | undefined): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  const metadata: Record<string, unknown> = {};
  if (filter.assignee !== undefined) metadata.assignee = { eq: filter.assignee };
  if (filter.claimedBy !== undefined) metadata.claimedBy = { eq: filter.claimedBy };
  if (filter.closedAt !== undefined) {
    if (filter.closedAt.since && filter.closedAt.until) {
      metadata.closedAt = { between: [filter.closedAt.since, filter.closedAt.until] };
    } else if (filter.closedAt.since) {
      metadata.closedAt = { gte: filter.closedAt.since };
    } else if (filter.closedAt.until) {
      metadata.closedAt = { lte: filter.closedAt.until };
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function sortToOrderBy(sort: IIssueQueryInput['sort']): 'tCreated' | 'tValid' | undefined {
  if (sort === 'created') return 'tCreated';
  if (sort === 'updated') return 'tValid';
  return undefined; // 'priority' has no NodeFilter column (see priority-sort note below); 'relevance'/'textMatch' only apply under grep/semantic (search-ranked ordering, not NodeFilter.orderBy)
}

/**
 * `sort:'priority'` (SPEC.md §6.5) has no direct `NodeFilter` column — a
 * priority's `rank` lives on the `priority` catalog node, one edge hop away
 * (§2/§3), and `SortField` (`@adhd/sox-graph-store` `dist/index.d.ts:174`) only
 * covers `importance`/`tCreated`/`tValid`/`name`/a metadata key on the
 * ISSUE's own row — never a joined edge target. This function resolves rank
 * for a candidate page in-memory. **Documented limitation, stated rather than
 * silently approximated:** because rule 5 already bans `sort` with `after`
 * (keyset), `sort:'priority'` only ever composes with offset-based paging
 * (rule 6), which SPEC.md's own rule 6 already states is "EXPLICITLY not
 * stable under concurrent writes" — this in-memory sort adds no NEW
 * instability beyond what offset-paging already carries, but it does mean a
 * `sort:'priority'` page is computed over exactly the `limit+1` rows the
 * underlying (unsorted) fetch returned, THEN sorted — never a true store-
 * wide top-N by priority. A store-wide priority-ranked top-N would need a
 * dedicated SQL join this app-layer read surface does not have a primitive
 * for; flagged here rather than silently shipped as if it were exact.
 */
async function sortByPriorityRank(graph: GraphBackend, issues: NodeRecord[], direction: 'asc' | 'desc'): Promise<NodeRecord[]> {
  const edgesByIssue = await Promise.all(issues.map((i) => graph.getEdges({ src: i.id, rel: 'has_priority' })));
  const priorityIds = [...new Set(edgesByIssue.flatMap((es) => es.map((e) => e.dst)))];
  const priorityNodes = priorityIds.length > 0 ? await graph.getNodesByIds(priorityIds) : [];
  const rankById = new Map(priorityNodes.map((n) => [n.id, typeof n.metadata?.rank === 'number' ? n.metadata.rank : Number.MAX_SAFE_INTEGER]));
  const rankByIssue = new Map<number, number>();
  issues.forEach((issue, i) => {
    const priorityId = edgesByIssue[i][0]?.dst;
    rankByIssue.set(issue.id, priorityId !== undefined ? (rankById.get(priorityId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER);
  });
  const sorted = [...issues].sort((a, b) => (rankByIssue.get(a.id)! - rankByIssue.get(b.id)!));
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * `view:'list'` (default) — SPEC.md §6.5's full pagination/composition
 * algorithm, plus `meta` (`envelope.ts`'s {@link IQueryEnvelopeMeta}), the
 * pre-limit truth the transport envelope exposes alongside the page.
 *
 * `meta.total`/`meta.truncated` are computed against `baseFilter` below — the
 * exact match condition (kind/ids/metadata/date-range) the real fetch runs,
 * built ONCE and shared by both, so the two can never disagree with each
 * other about what "matches."
 */
async function queryList(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<{ page: IIssuePage; meta: IQueryEnvelopeMeta }> {
  const { graph } = handle;
  assertKeysetCompatibility(input);
  assertKnownIssueFields(input.fields);
  const limit = assertQueryLimit(input.limit);
  const fields = (input.fields ?? DEFAULT_ISSUE_CARD_FIELDS) as readonly IIssueField[];

  if (input.sort === 'relevance' || input.sort === 'textMatch') {
    if (input.filter?.grep === undefined && input.filter?.semantic === undefined) {
      throw new BacklogValidationError('sort', `"${input.sort}" requires filter.grep or filter.semantic`);
    }
  }

  const candidateIds = await resolveEdgeScopedFilterIds(graph, input.filter);
  if (candidateIds && candidateIds.size === 0) {
    // An edge-scoped filter resolved to nothing — zero matches, not an error (§6.1).
    return { page: { items: [], hasMore: false }, meta: { total: 0, returned: 0, limit } };
  }

  const metadata = buildMetadataFilter(input.filter);
  const grep = input.filter?.grep;
  const semantic = input.filter?.semantic;

  const baseFilter: Record<string, unknown> = {
    kind: 'issue',
    ...(candidateIds ? { ids: [...candidateIds] } : {}),
    ...(metadata ? { metadata } : {}),
    ...(input.filter?.createdAt?.since ? { tCreatedAfter: input.filter.createdAt.since } : {}),
    ...(input.filter?.createdAt?.until ? { tCreatedBefore: input.filter.createdAt.until } : {}),
    ...(input.filter?.updatedAt?.since ? { tUpdatedAfter: input.filter.updatedAt.since } : {}),
    ...(input.filter?.updatedAt?.until ? { tUpdatedBefore: input.filter.updatedAt.until } : {}),
  };

  if (grep !== undefined || semantic !== undefined) {
    let ranked: SearchResult[] | undefined;
    let grepIds: Set<number> | undefined;
    if (grep !== undefined) {
      const grepResults = await graph.searchNodes(grep, { limit, filter: baseFilter as unknown as NodeFilter });
      grepIds = new Set(grepResults.map((r) => r.id));
    }

    if (semantic !== undefined) {
      if (!handle.search) {
        throw new InvalidArgumentError('semantic', 'semantic search is not configured for this store (no embedding/vector backend injected)');
      }
      const vec = await handle.search.embedQuery(semantic);
      const query: SearchQuery = { vec, signals: [{ kind: 'vec' }], filters: baseFilter };
      const semanticResults = await handle.search.backend.searchRanked(query, limit);
      ranked = grepIds
        ? semanticResults.filter((r) => grepIds!.has(r.id))
        : semanticResults;
    } else if (grepIds) {
      // grep-only: searchNodes already returns FTS-ranked results; re-fetch as SearchResult-shaped for a uniform downstream path.
      const grepResults = await graph.searchNodes(grep!, { limit, filter: baseFilter as unknown as NodeFilter });
      ranked = grepResults.map((r) => ({ id: r.id, score: r.score, fields: {} }));
    }

    const rankedIds = (ranked ?? []).map((r) => r.id).slice(0, limit);
    const nodes = rankedIds.length > 0 ? await graph.getNodesByIds(rankedIds) : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ordered = rankedIds.map((id) => byId.get(id)).filter((n): n is NodeRecord => n !== undefined);
    const scoreByUid = new Map((ranked ?? []).map((r) => [byId.get(r.id)?.uid, r.score] as const).filter((e): e is [string, number] => e[0] !== undefined));
    const items = await assembleIssueCards(graph, ordered, fields, scoreByUid);

    // `grep` is a genuine boolean match condition, so it narrows the
    // countable set (`countNodesFts`, run against the SAME `baseFilter` the
    // real fetch used). `semantic` never filters — `searchRanked` reranks
    // whatever `baseFilter` already matches (`views/semantic.ts`'s own top
    // doc comment: filters are resolved to concrete ids/columns BEFORE the
    // vector channel runs) — so a semantic-only read's true count is
    // `baseFilter` alone, exactly what the plain branch below counts too.
    const total = grep !== undefined
      ? await graph.countNodesFts(grep, baseFilter as unknown as NodeFilter)
      : await graph.countNodes(baseFilter as unknown as NodeFilter);

    // `grep` and `semantic` each independently pre-cap their own channel at
    // `limit` BEFORE `ranked = semanticResults.filter(r => grepIds.has(r.id))`
    // intersects them — a real loss `hasMore`/`nextCursor` cannot express
    // (rule 5 bans keyset pagination for a ranked read, so this branch always
    // reports `hasMore:false`) and one that has nothing to do with the
    // caller's own `limit`: `returned` can fall short of `min(total, limit)`
    // purely because the intersection dropped rows neither channel's own
    // top-`limit` window happened to include. That gap — not the caller's
    // limit — is exactly what `truncated` exists to name.
    const returned = items.length;
    const truncated = returned < Math.min(total, limit);

    // grep/semantic route through the ranked search primitives, which expose no rowid-ordered
    // keyset contract (rule 5) — a searched result set pages by sort+offset only, never `after`.
    return {
      page: { items, hasMore: false },
      meta: { total, returned, limit, ...(truncated ? { truncated: true } : {}) },
    };
  }

  const orderBy = sortToOrderBy(input.sort);
  const pagingFilter: Record<string, unknown> = {
    ...baseFilter,
    limit: limit + 1,
    ...(input.after !== undefined ? { after: Number(input.after) } : {}),
    ...(orderBy && input.after === undefined ? { orderBy, orderDir: input.direction ?? 'desc' } : {}),
    ...(input.after === undefined && input.offset !== undefined ? { offset: input.offset } : {}),
  };

  let nodes = await graph.queryNodes(pagingFilter as unknown as NodeFilter);

  if (input.sort === 'priority' && input.after === undefined) {
    nodes = await sortByPriorityRank(graph, nodes, input.direction ?? 'asc');
  }

  const hasMore = nodes.length > limit;
  const page = hasMore ? nodes.slice(0, limit) : nodes;
  const nextCursor = hasMore ? String(page[page.length - 1].id) : undefined;

  const items = await assembleIssueCards(graph, page, fields);

  // `assertQueryLimit` REJECTS (never clamps) a `limit` above
  // `MAX_QUERY_LIMIT` — there is no system-imposed cut on this path distinct
  // from what the caller asked for, so `truncated` is never set here; the
  // plain path's own `hasMore`/`nextCursor` already report completeness
  // truthfully for every reachable case.
  const total = await graph.countNodes(baseFilter as unknown as NodeFilter);
  const effectiveOffset = input.after === undefined ? input.offset : undefined;
  return {
    page: { items, nextCursor, hasMore },
    meta: { total, returned: items.length, limit, ...(effectiveOffset !== undefined ? { offset: effectiveOffset } : {}) },
  };
}

/**
 * `view:'ready'` — open issues whose every `blocks`-incoming blocker is
 * terminal, and which are not currently claimed (SPEC.md §5.2, remapped onto
 * `blocks`, §6.2).
 *
 * **Cost is bounded by the relation size, not by the candidate count.** The
 * obvious shape here — loop the candidates, and per issue fetch its incoming
 * `blocks` edges, then its blockers, then each blocker's status — is three
 * sequential round trips per issue, so 5,000 open issues cost ~15,000
 * serialized queries. That is the exact wrong cost model for this view: it is
 * the default "what should I work on" query an agent runs constantly, and its
 * price would scale with how big the store has grown rather than with
 * anything the caller asked for.
 *
 * Instead each relation is fetched ONCE and grouped in memory:
 * `getEdges({rel})` takes a single `src`/`dst`, never an array, so there is no
 * way to batch N specific lookups — but there is no need to, because the
 * whole `blocks` and `has_status` relations are each one query. Five queries
 * total, independent of candidate count.
 *
 * `limit` is validated and applied, matching every sibling view
 * (`queryList`/`queryGraph`/`queryOrder`). It was previously ignored entirely,
 * so this view materialized every open issue in the store no matter what the
 * caller requested. The cap is applied AFTER the readiness filter — taking the
 * first `limit` candidates and then filtering would silently return fewer
 * ready issues than exist.
 */
async function queryReady(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IIssueCard[]> {
  const { graph } = handle;
  const limit = assertQueryLimit(input.limit);
  const fields = (input.fields ?? DEFAULT_ISSUE_CARD_FIELDS) as readonly IIssueField[];
  const openIds = await resolveOpenClosedCandidates(graph, 'open');
  const candidates = await resolveEdgeScopedFilterIds(graph, input.filter);
  const scoped = candidates ? [...openIds].filter((id) => candidates.has(id)) : [...openIds];
  if (scoped.length === 0) return [];

  const issues = await graph.getNodesByIds(scoped);

  // One query per relation, grouped in memory — see this function's doc comment.
  const blocksEdges = await graph.getEdges({ rel: 'blocks' });
  const blockerSrcsByIssue = new Map<number, number[]>();
  for (const e of blocksEdges) {
    const list = blockerSrcsByIssue.get(e.dst);
    if (list) list.push(e.src);
    else blockerSrcsByIssue.set(e.dst, [e.src]);
  }

  // Only blockers that actually EXIST count, exactly as the per-issue
  // `getNodesByIds(incoming.map(e => e.src))` did: a dangling edge whose src
  // node is gone was silently dropped there and must stay dropped here, or a
  // stale edge would wrongly hold an issue back forever.
  const allBlockerIds = [...new Set(blocksEdges.map((e) => e.src))];
  const existingBlockerIds = new Set(
    (allBlockerIds.length > 0 ? await graph.getNodesByIds(allBlockerIds) : []).map((n) => n.id),
  );

  const statusEdges = await graph.getEdges({ rel: 'has_status' });
  const statusIdByNode = new Map<number, number>();
  for (const e of statusEdges) {
    // At most one live `has_status` edge per issue can exist, so this `if`
    // is a defensive no-op rather than a tiebreak: `has_status` is declared
    // `n:1` in the edge-kind catalog (`write/catalog.ts`), and
    // `checkMultiplicityTx` (`write/tx.ts`) enforces that by capping the
    // SOURCE's live out-degree at one before any edge write commits.
    // `getEdges` returns live edges only (`t_invalid IS NULL`), and
    // `transition` invalidates the old edge in the same transaction that
    // writes the new one. So replacing the old per-issue `getEdges({src})`
    // with this global scan cannot change which status is selected — there
    // is never more than one candidate to choose between.
    if (!statusIdByNode.has(e.src)) statusIdByNode.set(e.src, e.dst);
  }
  const statusNodeIds = [...new Set(statusIdByNode.values())];
  const statusById = new Map(
    (statusNodeIds.length > 0 ? await graph.getNodesByIds(statusNodeIds) : []).map((n) => [n.id, n]),
  );

  const ready: NodeRecord[] = [];
  for (const issue of issues) {
    if (ready.length >= limit) break;
    if (typeof issue.metadata?.claimedBy === 'string') continue; // currently claimed — not ready
    const blockerIds = (blockerSrcsByIssue.get(issue.id) ?? []).filter((id) => existingBlockerIds.has(id));
    if (blockerIds.length === 0) {
      ready.push(issue);
      continue;
    }
    const allBlockersTerminal = blockerIds.every((id) => {
      const statusId = statusIdByNode.get(id);
      return statusId !== undefined && isStatusTerminal(statusById.get(statusId));
    });
    if (allBlockersTerminal) ready.push(issue);
  }
  return assembleIssueCards(graph, ready, fields);
}

/** `view:'stale'` — SPEC.md §6.3.5: `staleClaims` becomes `query`'s `view:'stale'`, `NodeFilter.metadata: {claimedAt:{lt:...}, claimedBy:{exists:true}}`. `staleAfterMin` defaults to 30 (`project_policy.claim_stale_after_min`'s own default — this read path has no per-project policy row threaded through it, so it uses the GLOBAL default; a caller that knows the project's configured threshold passes `staleAfterMin` explicitly). `limit` is validated and applied via `assertQueryLimit`/`DEFAULT_QUERY_LIMIT`, matching every sibling view (`queryList`/`queryReady`/`queryGraph`/`queryOrder`) — it was previously ignored entirely, so this view returned every stale claim in the store regardless of what the caller asked for. */
async function queryStale(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IIssueCard[]> {
  const { graph } = handle;
  const limit = assertQueryLimit(input.limit);
  const fields = (input.fields ?? DEFAULT_ISSUE_CARD_FIELDS) as readonly IIssueField[];
  const staleAfterMin = input.staleAfterMin ?? 30;
  const threshold = new Date(Date.now() - staleAfterMin * 60_000).toISOString();
  const candidateIds = await resolveEdgeScopedFilterIds(graph, input.filter);
  const nodeFilter: Record<string, unknown> = {
    kind: 'issue',
    ...(candidateIds ? { ids: [...candidateIds] } : {}),
    metadata: { claimedBy: { exists: true }, claimedAt: { lt: threshold } },
    limit,
  };
  const nodes = await graph.queryNodes(nodeFilter as unknown as NodeFilter);
  return assembleIssueCards(graph, nodes, fields);
}

/** The three relations `view:'graph'` projects. Declared once so the runtime check and
 *  `IDependencyGraph['edges']`'s `rel` type cannot drift apart. */
const GRAPH_RELS = ['blocks', 'relates_to', 'part_of'] as const;

type GraphRel = (typeof GRAPH_RELS)[number];

/** Type predicate, not a `===` chain: the graph library types an edge's `rel` as a
 *  union that includes `string & {}`, which a literal comparison cannot narrow away,
 *  so the assignment to `IDependencyGraph['edges']` needs an explicit guard. */
function isGraphRel(rel: string): rel is GraphRel {
  return (GRAPH_RELS as readonly string[]).includes(rel);
}

/** `view:'graph'` — SPEC.md §5's `dependencyGraph`, remapped onto `blocks`/`relates_to`/`part_of` (§6.2). Scoped to the resolved filter's candidate set when one is given; otherwise every live issue (bounded by `limit`, default `MAX_QUERY_LIMIT`, since a full-store graph has no natural page boundary). */
async function queryGraph(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IDependencyGraph> {
  const { graph } = handle;
  const limit = assertQueryLimit(input.limit ?? MAX_QUERY_LIMIT);
  const candidateIds = await resolveEdgeScopedFilterIds(graph, input.filter);
  const nodeFilter: Record<string, unknown> = { kind: 'issue', ...(candidateIds ? { ids: [...candidateIds] } : {}), limit };
  const issues = await graph.queryNodes(nodeFilter as unknown as NodeFilter);
  const idSet = new Set(issues.map((i) => i.id));
  const statuses = await resolveStatusMap(graph, issues);

  const nodes = issues.map((i) => ({ uid: i.uid, title: i.name ?? '', status: statuses.get(i.id)?.name ?? '' }));
  const edges: IDependencyGraph['edges'] = [];
  for (const issue of issues) {
    const outgoing = await getOutgoingEdges(graph, issue.id);
    for (const e of outgoing) {
      if (isGraphRel(e.rel) && idSet.has(e.dst)) {
        const dstUid = (await graph.getNodesByIds([e.dst]))[0]?.uid;
        if (dstUid) edges.push({ from: issue.uid, to: dstUid, rel: e.rel });
      }
    }
  }
  return { nodes, edges };
}

async function resolveStatusMap(graph: GraphBackend, issues: NodeRecord[]): Promise<Map<number, NodeRecord>> {
  const edgesByIssue = await Promise.all(issues.map((i) => graph.getEdges({ src: i.id, rel: 'has_status' })));
  const statusIds = [...new Set(edgesByIssue.flatMap((es) => es.map((e) => e.dst)))];
  const statusNodes = statusIds.length > 0 ? await graph.getNodesByIds(statusIds) : [];
  const statusById = new Map(statusNodes.map((n) => [n.id, n]));
  const out = new Map<number, NodeRecord>();
  issues.forEach((issue, i) => {
    const statusId = edgesByIssue[i][0]?.dst;
    if (statusId !== undefined) {
      const s = statusById.get(statusId);
      if (s) out.set(issue.id, s);
    }
  });
  return out;
}

/** `view:'order'` — SPEC.md §5's `topoOrder`, remapped onto `blocks` (X `blocks` Y ⇒ X must come before Y in a dependency-first order). Kahn's algorithm; a non-empty remainder after exhausting all zero-in-degree nodes is a cycle, reported in full (SPEC.md §7 clause 5: "must return `{ok:false, cycle:[...]}` naming all three ids"). */
async function queryOrder(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<ITopoOrderResult> {
  const { graph } = handle;
  const limit = assertQueryLimit(input.limit ?? MAX_QUERY_LIMIT);
  const candidateIds = await resolveEdgeScopedFilterIds(graph, input.filter);
  const nodeFilter: Record<string, unknown> = { kind: 'issue', ...(candidateIds ? { ids: [...candidateIds] } : {}), limit };
  const issues = await graph.queryNodes(nodeFilter as unknown as NodeFilter);
  const idSet = new Set(issues.map((i) => i.id));
  const uidById = new Map(issues.map((i) => [i.id, i.uid]));

  const inDeg = new Map<number, number>(); // "must wait for" count
  const blockedBy = new Map<number, number[]>(); // node -> the nodes it blocks (edges to remove once processed)
  for (const i of issues) {
    inDeg.set(i.id, 0);
    blockedBy.set(i.id, []);
  }
  for (const issue of issues) {
    const outgoing = await graph.getEdges({ src: issue.id, rel: 'blocks' });
    for (const e of outgoing) {
      if (!idSet.has(e.dst)) continue;
      blockedBy.get(issue.id)!.push(e.dst);
      inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1);
    }
  }

  const queue = issues.filter((i) => (inDeg.get(i.id) ?? 0) === 0).map((i) => i.id);
  const order: number[] = [];
  const remaining = new Map(inDeg);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of blockedBy.get(id) ?? []) {
      const d = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== issues.length) {
    const cycle = issues.filter((i) => !order.includes(i.id)).map((i) => uidById.get(i.id)!);
    return { ok: false, cycle };
  }
  return { ok: true, order: order.map((id) => uidById.get(id)!) };
}

/**
 * `view:'overlap'` (SPEC.md §6.2: selected via `axis`/`uids`) — groups
 * `overlapUids` by the requested `axis`'s value,
 * surfacing every group with ≥2 members (a genuine overlap; a singleton
 * group is not a shared axis value by definition). **Interpretation
 * decision** (SPEC.md leaves the exact output shape unspecified beyond
 * "the pairwise-intersection axis selector," §6.2): this implementation
 * returns one {@link IOverlapGroup} per distinct axis value that ≥2 of the
 * input issues share, rather than every pairwise `(uidA, uidB)` combination
 * — the group form is strictly more information (a caller can derive every
 * pair from a group) and avoids an O(n²) output for a large overlapping set.
 * `axis:'file'` groups by each issue's `citations[].file` values (an issue
 * can appear in more than one file-group); `project`/`component`/`author`
 * each group by the single resolved uid from that field.
 */
async function queryOverlap(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IOverlapGroup[]> {
  const { graph } = handle;
  const axis = input.overlapAxis;
  const uids = input.overlapUids;
  if (!axis) throw new InvalidArgumentError('overlapAxis', 'required for view:"overlap"');
  if (!uids || uids.length < 2) throw new InvalidArgumentError('overlapUids', 'requires at least 2 uids to detect an overlap');

  const groups = new Map<string, Set<string>>();
  for (const uid of uids) {
    const issue = await graph.getNodeByUid(uid);
    if (!issue || issue.kind !== 'issue') continue;

    if (axis === 'file') {
      const outgoing = await getOutgoingEdges(graph, issue.id);
      const citationEdges = outgoing.filter((e) => e.rel === 'has_citation');
      const citations = citationEdges.length > 0 ? await graph.getNodesByIds(citationEdges.map((e) => e.dst)) : [];
      for (const c of citations) {
        const file = typeof c.metadata?.target === 'string' ? c.metadata.target : undefined;
        if (!file) continue;
        if (!groups.has(file)) groups.set(file, new Set());
        groups.get(file)!.add(uid);
      }
      continue;
    }

    if (axis === 'author') {
      const outgoing = await getOutgoingEdges(graph, issue.id);
      const edge = outgoing.find((e) => e.rel === 'authored_by');
      if (!edge) continue;
      const [author] = await graph.getNodesByIds([edge.dst]);
      if (!author) continue;
      if (!groups.has(author.uid)) groups.set(author.uid, new Set());
      groups.get(author.uid)!.add(uid);
      continue;
    }

    // project | component
    const { project, component } = await resolveIssuePlacement(graph, issue.id);
    const target = axis === 'project' ? project : component;
    if (!target) continue;
    if (!groups.has(target.uid)) groups.set(target.uid, new Set());
    groups.get(target.uid)!.add(uid);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.size >= 2)
    .map(([axisValue, members]) => ({ axisValue, uids: [...members] }));
}

/**
 * `view:'projects'`/`'components'`/`'locations'` (SPEC.md §3a/§9 AC-9) — the
 * registry LIST views, thin adapters over `views/registry.ts`'s own
 * `listProjects`/`listComponents`/`listLocations`. `input.filter` is
 * `IIssueFilter`, a structural superset of `views/registry.ts`'s own
 * `IRegistryQueryFilter` (`{project?, component?}`) — passed through as-is,
 * never re-shaped, so a caller's `filter.project`/`filter.component` scopes
 * these exactly like it scopes `view:'list'`.
 */
async function queryProjects(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IProjectSummary[]> {
  return listProjects(handle.graph, input.filter);
}

async function queryComponents(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IComponentSummary[]> {
  return listComponents(handle.graph, input.filter);
}

async function queryLocations(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<ILocationSummary[]> {
  return listLocations(handle.graph, input.filter);
}

/**
 * Normalises `input.text` (the natural-language query shared by every mount —
 * CLI `search`, MCP, HTTP) into `filter.semantic` or `filter.grep`, exactly
 * ONCE, so every caller gets identical routing rather than each transport
 * reimplementing it. Routes to `semantic` when {@link isSemanticSearchReadable}
 * is true AND the store handle actually carries a `search` backend (a
 * readable-but-handle-less combination cannot happen in practice, but the
 * grep fallback keeps this total rather than throwing on it); otherwise
 * routes to `grep`. The matching default `sort` (`'relevance'` /
 * `'textMatch'`) is only applied when the caller did not pass `sort`
 * explicitly — an explicit `sort` always wins.
 *
 * Exported (in addition to being called internally by {@link queryIssues})
 * so the sort-precedence rule above can be unit-tested directly: the ranked
 * grep/semantic branch of `queryList` never echoes the resolved `sort` value
 * back in its output (it only gates on relevance/textMatch requiring
 * grep/semantic, then ignores `sort` entirely when ordering ranked results),
 * so there is no way to observe "explicit sort survived" from `queryIssues`'s
 * return value alone — `text-routing.spec.ts` asserts on this function's
 * return value for that one property, and drives every other behaviour
 * through the real `queryIssues`/real store end-to-end.
 */
export function resolveTextInput(handle: IQueryStoreHandle, input: IIssueQueryInput): IIssueQueryInput {
  if (input.text === undefined) return input;

  if (input.filter?.semantic !== undefined || input.filter?.grep !== undefined) {
    throw new InvalidArgumentError(
      'text',
      'text is mutually exclusive with filter.semantic/filter.grep — pick one: the free-text positional (text), or an explicit filter.semantic/filter.grep',
    );
  }

  if (input.text.trim().length === 0) {
    throw new InvalidArgumentError('text', 'must not be blank');
  }

  const useSemantic = isSemanticSearchReadable() && handle.search !== undefined;
  const { text, ...rest } = input;

  return {
    ...rest,
    sort: rest.sort ?? (useSemantic ? 'relevance' : 'textMatch'),
    filter: {
      ...rest.filter,
      ...(useSemantic ? { semantic: text } : { grep: text }),
    },
  };
}

/** {@link queryIssuesWithMeta}'s return shape. */
export interface IQueryIssuesOutcome {
  result: IIssueQueryResult;
  /**
   * Present only for `view:'list'` — the only view whose result is a
   * filtered/paginated row set with an honestly countable pre-limit total
   * (`envelope.ts`'s {@link IQueryEnvelopeMeta}). `view:'ready'` computes
   * readiness in-memory and stops enumerating once `limit` candidates are
   * found (`queryReady`'s own doc comment: removing that early exit to count
   * a true pre-limit total would reintroduce the O(candidates) cost its
   * grouped-relation-fetch design exists to avoid), `view:'stale'` applies no
   * limit at all so every row it returns already IS the total, and
   * `view:'similar'`/`'graph'`/`'order'`/`'overlap'` are a ranking, a graph
   * projection, a topological order, and an axis grouping respectively — none
   * of them a filtered row set with a "how many matched" count. Adding a
   * `meta` to any of those would mean inventing a number this module cannot
   * stand behind.
   */
  meta?: IQueryEnvelopeMeta;
}

/**
 * `queryIssues` (below) plus the transport-facing `meta` the envelope
 * exposes for a list-shaped read (`api.ts`'s `query` mount is the one caller
 * that needs it). Every other in-process caller keeps calling `queryIssues`
 * itself, which discards `meta` and returns exactly the shape it always has.
 */
export async function queryIssuesWithMeta(handle: IQueryStoreHandle, rawInput: IIssueQueryInput = {}): Promise<IQueryIssuesOutcome> {
  const input = resolveTextInput(handle, rawInput);

  if (input.format === 'markdown') {
    // Rendering (headers + `[target sha:…]` citations, §6.5/§6.6) is the markdown-projection
    // layer's job, not this read layer's — out of scope for this slice (documented, not silently
    // faked, mirroring create-issue.ts's own `awaitEmbed` precedent).
    throw new InvalidArgumentError('format', '"markdown" rendering is not implemented in this slice — the query layer returns `json`; a markdown projection composes this result with the markdown renderer separately');
  }

  const view = input.view ?? 'list';
  switch (view) {
    case 'list': {
      const { page, meta } = await queryList(handle, input);
      return { result: { view: 'list', ...page }, meta };
    }
    case 'ready':
      return { result: { view: 'ready', items: await queryReady(handle, input) } };
    case 'graph':
      return { result: { view: 'graph', graph: await queryGraph(handle, input) } };
    case 'order':
      return { result: { view: 'order', order: await queryOrder(handle, input) } };
    case 'stale':
      return { result: { view: 'stale', items: await queryStale(handle, input) } };
    case 'similar':
      return { result: { view: 'similar', items: await querySimilarView(handle, input) } };
    case 'overlap':
      return { result: { view: 'overlap', groups: await queryOverlap(handle, input) } };
    case 'projects':
      return { result: { view: 'projects', items: await queryProjects(handle, input) } };
    case 'components':
      return { result: { view: 'components', items: await queryComponents(handle, input) } };
    case 'locations':
      return { result: { view: 'locations', items: await queryLocations(handle, input) } };
    default: {
      const exhaustive: never = view;
      throw new BacklogValidationError('view', `unknown view "${exhaustive as string}"`);
    }
  }
}

/** The `query` verb (SPEC.md §5, §6.5) — dispatches on `input.view`, default `'list'`. */
export async function queryIssues(handle: IQueryStoreHandle, rawInput: IIssueQueryInput = {}): Promise<IIssueQueryResult> {
  return (await queryIssuesWithMeta(handle, rawInput)).result;
}
