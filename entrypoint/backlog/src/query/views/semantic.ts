/**
 * views/semantic.ts — the semantic read views (SPEC.md §5a, FEAT-022):
 * `view:'similar'`, the fused-relevance ranking primitive it is built on
 * (exported so a future `sort:'relevance'`/`'textMatch'` integration under
 * `view:'list'` can reuse the SAME `searchRanked` call shape §5a specifies,
 * rather than a second bespoke ranking path), and `_score` exposure via
 * `card.ts`'s existing `IAssembleIssueCardOptions.score` seam.
 *
 * SPEC.md §5a, verbatim: "`view:similar`/`relevance`/`_score` route through
 * `StoreSearchBackend.searchRanked(query, limit)` with `signals:[{text},
 * {vec}]` + `rescore:[{kind:'temporal',decay}]`... A title/body text match
 * surfaces even when its vector is not nearest." — i.e. `view:'similar'` is
 * NOT the embedding-only path (that is `filter.semantic`'s OWN route under
 * `view:'list'`, per §5a's very next sentence: "the embedding-only path is
 * `searchRanked({vec, signals:[{vec}]})`"); it always fuses a text-FTS
 * channel alongside the vector channel via reciprocal-rank fusion, plus a
 * temporal-recency rescore. Both `filter.anchor` (the anchor issue's own
 * title+body) and `filter.semantic` (the caller's free text) supply BOTH
 * `query.text` and the string `embedQuery`'s vector is derived from — the
 * same text feeds both channels, which is exactly what lets a keyword match
 * surface even when the embedding isn't the nearest neighbour.
 *
 * ── The vector-store-filter-purity hazard (load-bearing, read before editing) ──
 *
 * `@adhd/sox-vector-store`'s `VecFilter` contract is PURELY `{ids}` (its own
 * DEBT-011 doc comment: "it knows nothing about the graph's node table") —
 * confirmed empirically against the installed dist: the store adapter's
 * synchronous vector backend's `.knn` (via its `BruteForceBackend.search`)
 * and `.iter` both only apply an `ids` restriction when
 * `filter.ids.length > 0`; the SAME empty-array-means-
 * unfiltered convention exists one layer up too, in
 * `@adhd/sox-graph-store`'s OWN `buildNodeFilterClause`
 * (`if (filter.ids !== undefined && filter.ids.length > 0)`). So `filters:
 * {ids: []}` passed into `StoreSearchBackend.searchRanked` does NOT mean
 * "match nothing" — it means "no ids restriction at all," which
 * `searchRanked`'s own internal `zeroMatches` short-circuit (it re-resolves
 * `filters` via `graph.queryNodes` before ever calling `vec.knn`) happens to
 * dodge for a GENUINELY resolved-to-zero filter (it checks `matchingIds.length
 * === 0` and skips the vec channel), but only because THIS module never lets
 * an already-known-empty candidate set reach that call at all. Every
 * `unrecognized filter key` (anything outside `buildFilterClause`'s closed
 * list — `kind`/`topic`/`tags`/`importance_min`/`project_path`/`agent_id`/
 * `namespace`/`ids`/`confidence`) is silently dropped from the vector/text
 * channels too (`StoreSearchBackend` records it in `unsupportedFilters` but
 * never applies it) — so `metadata`/`tCreatedAfter`/`tUpdatedAfter`/etc. can
 * NEVER be handed to `searchRanked` directly; this module resolves EVERY
 * `IIssueFilter` dimension (edge-scoped catalog refs, `assignee`/`claimedBy`/
 * `closedAt` metadata, `createdAt`/`updatedAt` ranges) to a concrete node-id
 * set via the graph FIRST, and only ever passes `{ids:[...]}` (a non-empty
 * array) or the bare `{kind:'issue'}` fast path (no filter given at all) into
 * `query.filters`. `resolveSimilarFilterIds`/`rankByFusedRelevance` below both
 * enforce this: a resolved-but-empty candidate set short-circuits to `[]`
 * BEFORE `searchRanked` is ever called — never an empty `ids: []` sent
 * through, which (per the confirmed convention above) would silently widen
 * to an unfiltered scan across every live issue instead of matching none.
 *
 * ── `src/query/resolve.ts`'s `resolveEdgeScopedCandidates` — NOT used for
 * `project`/`component` (a real, confirmed direction bug) ──
 *
 * That function's contract is `getEdges({dst: resolved.id, rel}) → collect
 * .src` — correct for `has_kind`/`has_status`/`has_priority`/`authored_by`
 * (§3's `EDGE_KIND_TABLE`, `write/catalog.ts:246-250`: all four declare
 * `sourceKind:'issue'`, i.e. the ISSUE is the edge source, the catalog node
 * is the edge target — `dst=catalog, collect .src=issue` is exactly right).
 * t` declare the OPPOSITE direction
 * (`sourceKind:'project'|'component'`, `targetKind:'component'|'issue'` —
 * the CATALOG node is the edge source, the child is the target), unlike the
 * issue → catalog shape of `has_kind`/`has_status`/`has_priority`/
 * `authored_by`.
 *
 * `resolveEdgeScopedCandidates` used to hard-code the issue → catalog shape
 * for all six dimensions and therefore returned an empty set for a component
 * that genuinely owned issues, which is why this module hand-composes the
 * `project`/`component` traversal itself in the correct (source-directed)
 * order — mirroring `query.ts`'s own private `resolveEdgeScopedFilterIds`.
 *
 * **That bug is now fixed at source**: `resolveEdgeScopedCandidates` reads
 * the `edge_kind` row's `source_kind` and walks whichever direction the data
 * declares, so it is correct for all six dimensions and the workaround here
 * is no longer load-bearing. The hand-composed traversal below is kept for
 * now only because it is on the hot semantic path and collapsing three
 * implementations into one is a separate, separately-verified change; doing
 * that collapse is the remaining cleanup, tracked as follow-up. Do not cite
 * this comment as evidence the shared resolver is still wrong — it is not.
 */

import type { GraphBackend, NodeFilter, NodeRecord } from '@adhd/sox-graph-store';
import type { SearchQuery, SearchResult } from '@adhd/sox-hybrid-search';
import { BacklogValidationError, InvalidArgumentError } from '../../write/errors.js';
import { assembleIssueCards, assertKnownIssueFields, isStatusTerminal } from '../card.js';
import {
  resolveEdgeScopedCandidates,
  resolveIssueByUid,
  tryResolveComponentRef,
  tryResolveRef,
} from '../resolve.js';
import {
  DEFAULT_ISSUE_CARD_FIELDS,
  DEFAULT_QUERY_LIMIT,
  type IIssueCard,
  type IIssueField,
  type IIssueFilter,
  type IIssueQueryInput,
  MAX_QUERY_LIMIT,
} from '../types.js';
import type { IQueryStoreHandle } from '../query.js';

/**
 * FEAT-022's rescore knob (SPEC.md §5a: `rescore:[{kind:'temporal',decay}]`)
 * — SPEC.md names the shape but states no value anywhere, and neither
 * `IIssueFilter` nor `IIssueQueryInput` (the frozen filter/cursor contract)
 * exposes a caller-supplied one. Rather than fabricate a number, this mirrors
 * the ALREADY-established sibling convention `sox-hybrid-search` itself is
 * pinned to for its OTHER FEAT-022 constant: `RRF_K = 60` is documented
 * in that package's own source as "Matches memory-core's RRF_K so a
 * 3-channel cutover produces the same rank magnitudes" — i.e. this package
 * is deliberately kept rank-compatible with the sibling `memory-core` system
 * FEAT-022 originated in. That system's own documented temporal-rescore
 * convention is "recency×importance rerank (0.995/hour decay)"
 * (`docs/sox/CAPABILITY-CATALOG.md:336`, this monorepo). `temporalRescore`'s
 * formula is `exp(-decay * ageHours)`, so a 0.995-per-hour retention factor
 * is `decay = -ln(0.995) ≈ 0.0050125`. Citing the same precedent this
 * package's own `RRF_K` already cites, not inventing a fresh figure — but
 * genuinely a decision this module makes, not a value SPEC.md itself states;
 * flagged here rather than silently asserted as spec-given.
 */
export const DEFAULT_TEMPORAL_DECAY_PER_HOUR = 0.0050125;

function assertSimilarLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_QUERY_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer ≤ ${MAX_QUERY_LIMIT}, got ${limit}`);
  }
  return limit;
}

/** OR-union a multi-valued catalog-edge filter dimension (`kind`/`status`/`priority`/`author`) across its refs — reuses `resolve.ts`'s `resolveEdgeScopedCandidates`, which IS correctly directioned for these four (see this file's own top doc comment for why NOT `project`/`component`). An unresolved ref contributes nothing (never an error on a read path, SPEC.md §6.1). */
async function resolveMultiValuedCatalogEdge(
  graph: GraphBackend,
  input: { rel: string; expectedKind: string; refs: readonly string[] },
): Promise<Set<number>> {
  const union = new Set<number>();
  for (const ref of input.refs) {
    const candidates = await resolveEdgeScopedCandidates(graph, { rel: input.rel, expectedKind: input.expectedKind, ref });
    if (candidates) for (const id of candidates) union.add(id);
  }
  return union;
}

/** `status: 'open' | 'closed'` — scan the `status` catalog for its `terminal` flag, then union `has_status` edges into every matching row (mirrors `query.ts`'s private `resolveOpenClosedCandidates`, reusing `card.ts`'s exported `isStatusTerminal` rather than re-deriving it). */
async function resolveOpenClosedIds(graph: GraphBackend, want: 'open' | 'closed'): Promise<Set<number>> {
  const statuses = await graph.queryNodes({ kind: 'status', liveOnly: true });
  const matching = statuses.filter((s) => isStatusTerminal(s) === (want === 'closed'));
  const union = new Set<number>();
  for (const s of matching) {
    const edges = await graph.getEdges({ dst: s.id, rel: 'has_status' });
    for (const e of edges) union.add(e.src);
  }
  return union;
}

/**
 * `project`/`component` — hand-composed in the CORRECT (source-directed)
 * order (`owns_project: project→component`, `owns_component: component→
 * issue`, both `component`/`issue` as the EDGE TARGET) — see this file's top
 * doc comment for why `resolve.ts`'s `resolveEdgeScopedCandidates` cannot be
 * reused here. Returns `undefined` when neither `project` nor `component` was
 * given (no restriction), or a `Set` (possibly empty, meaning "resolves to
 * nothing") otherwise.
 */
async function resolveOwnershipChainIds(graph: GraphBackend, filter: IIssueFilter): Promise<Set<number> | undefined> {
  if (filter.project === undefined && filter.component === undefined) return undefined;

  let projectUid: string | undefined;
  let projectScopedIssueIds: Set<number> | undefined;

  if (filter.project !== undefined) {
    const project = await tryResolveRef(graph, 'project', filter.project);
    if (!project) return new Set();
    projectUid = project.uid;
    const ownedComponents = await graph.getEdges({ src: project.id, rel: 'owns_project' });
    const union = new Set<number>();
    for (const compEdge of ownedComponents) {
      const issueEdges = await graph.getEdges({ src: compEdge.dst, rel: 'owns_component' });
      for (const e of issueEdges) union.add(e.dst);
    }
    projectScopedIssueIds = union;
  }

  if (filter.component === undefined) return projectScopedIssueIds;

  const component = projectUid !== undefined
    ? await tryResolveComponentRef(graph, projectUid, filter.component)
    : await tryResolveRef(graph, 'component', filter.component);
  if (!component) return new Set();
  const edges = await graph.getEdges({ src: component.id, rel: 'owns_component' });
  const componentScopedIssueIds = new Set(edges.map((e) => e.dst));

  if (!projectScopedIssueIds) return componentScopedIssueIds;
  const intersected = new Set<number>();
  for (const id of componentScopedIssueIds) if (projectScopedIssueIds.has(id)) intersected.add(id);
  return intersected;
}

/** `assignee`/`claimedBy`/`closedAt` (metadata) + `createdAt`/`updatedAt` (node-column range) — the `NodeFilter` shape these compile to. `undefined` when none of these dimensions were given. */
function buildScalarNodeFilter(filter: IIssueFilter): Record<string, unknown> | undefined {
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

  const out: Record<string, unknown> = {};
  if (Object.keys(metadata).length > 0) out.metadata = metadata;
  if (filter.createdAt?.since) out.tCreatedAfter = filter.createdAt.since;
  if (filter.createdAt?.until) out.tCreatedBefore = filter.createdAt.until;
  if (filter.updatedAt?.since) out.tUpdatedAfter = filter.updatedAt.since;
  if (filter.updatedAt?.until) out.tUpdatedBefore = filter.updatedAt.until;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolves every edge-scoped/metadata/date dimension of `filter` (everything
 * EXCEPT `grep`/`semantic`/`anchor`, which the caller consumes separately) to
 * a concrete candidate issue-id set — the "resolve any node filter to
 * concrete ids via the graph first" this module's top doc comment names.
 *
 * Returns:
 *  - `undefined` — no filter dimension this function handles was given at
 *    all; the caller may use the cheap `{kind:'issue'}` fast path (`kind` IS
 *    one of `buildFilterClause`'s recognized keys, so `searchRanked` applies
 *    it correctly on its own) rather than paying for an unbounded
 *    `queryNodes` scan just to re-derive "every live issue."
 *  - a `Set` (possibly empty) — at least one dimension was given; an empty
 *    `Set` means the filter, taken as a whole, matches zero issues. The
 *    caller MUST treat this as "return `[]`", NEVER pass it through as
 *    `ids: []` (see this file's top doc comment for why that would silently
 *    do the OPPOSITE — an unfiltered scan).
 */
export async function resolveSimilarFilterIds(graph: GraphBackend, filter: IIssueFilter | undefined): Promise<Set<number> | undefined> {
  if (!filter) return undefined;

  const edgeScoped: Array<Set<number>> = [];

  // `resolveOwnershipChainIds` returns `undefined` only when neither
  // `project` nor `component` was given; otherwise it always returns a `Set`
  // (possibly empty, meaning "resolves to nothing" — a `Set` is truthy
  // regardless of `.size`, so this is an explicit `!== undefined` check, not
  // a truthiness check that would miss the empty case).
  const ownership = await resolveOwnershipChainIds(graph, filter);
  if (ownership !== undefined) edgeScoped.push(ownership);

  if (filter.kind !== undefined) {
    const refs = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    edgeScoped.push(await resolveMultiValuedCatalogEdge(graph, { rel: 'has_kind', expectedKind: 'kind', refs }));
  }

  if (filter.status !== undefined && filter.status !== 'all') {
    if (filter.status === 'open' || filter.status === 'closed') {
      edgeScoped.push(await resolveOpenClosedIds(graph, filter.status));
    } else {
      const refs = Array.isArray(filter.status) ? filter.status : [filter.status];
      edgeScoped.push(await resolveMultiValuedCatalogEdge(graph, { rel: 'has_status', expectedKind: 'status', refs }));
    }
  }

  if (filter.priority !== undefined) {
    const refs = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
    edgeScoped.push(await resolveMultiValuedCatalogEdge(graph, { rel: 'has_priority', expectedKind: 'priority', refs }));
  }

  if (filter.author !== undefined) {
    edgeScoped.push(await resolveMultiValuedCatalogEdge(graph, { rel: 'authored_by', expectedKind: 'agent', refs: [filter.author] }));
  }

  const scalarFilter = buildScalarNodeFilter(filter);

  if (edgeScoped.length === 0 && !scalarFilter) return undefined;

  let edgeIntersected: Set<number> | undefined;
  if (edgeScoped.length > 0) {
    let [acc] = edgeScoped;
    for (const s of edgeScoped.slice(1)) {
      const next = new Set<number>();
      for (const id of acc) if (s.has(id)) next.add(id);
      acc = next;
    }
    edgeIntersected = acc;
    if (edgeIntersected.size === 0) return new Set();
  }

  if (!scalarFilter) return edgeIntersected;

  const nodeFilter: Record<string, unknown> = {
    kind: 'issue',
    liveOnly: true,
    ...(edgeIntersected ? { ids: [...edgeIntersected] } : {}),
    ...scalarFilter,
  };
  const nodes = await graph.queryNodes(nodeFilter as unknown as NodeFilter);
  return new Set(nodes.map((n) => n.id));
}

export interface IRelevanceRankOptions {
  /** FTS query text — fused via the `'text'` RRF signal. */
  text?: string;
  /** Embedding query vector — fused via the `'vec'` RRF signal. */
  vec: Float32Array;
  /**
   * A pre-resolved candidate id set (see {@link resolveSimilarFilterIds}).
   * `undefined` ⇒ no restriction beyond `kind:'issue'`. A DEFINED-BUT-EMPTY
   * set short-circuits to `[]` WITHOUT calling `searchRanked` at all — this
   * guard exists at THIS layer too (not only in {@link querySimilarView}),
   * so a future direct caller of this exported primitive gets the same
   * protection against the empty-`ids`-means-unfiltered hazard by
   * construction, not by caller discipline.
   */
  candidateIds?: Set<number>;
  limit: number;
  /** Overrides {@link DEFAULT_TEMPORAL_DECAY_PER_HOUR} — for tests and any future caller that wants a different recency curve. */
  decayPerHour?: number;
}

/**
 * The one `searchRanked` call shape SPEC.md §5a specifies for `view:'similar'`
 * / `sort:'relevance'` / `sort:'textMatch'` / `_score`: fused text+vec (RRF)
 * plus a temporal-recency rescore. Exported standalone (not only reachable
 * via {@link querySimilarView}) so a future `view:'list'` ranked-sort
 * integration can call the EXACT same primitive `view:'similar'` uses,
 * rather than reimplementing a second ranking path — that reuse is the
 * "relevance ordering" half of this module's brief, distinct from
 * `view:'similar'` itself.
 */
export async function rankByFusedRelevance(handle: IQueryStoreHandle, opts: IRelevanceRankOptions): Promise<SearchResult[]> {
  if (!handle.search) {
    throw new InvalidArgumentError('semantic', 'semantic search is not configured for this store (no embedding/vector backend injected)');
  }
  if (opts.candidateIds && opts.candidateIds.size === 0) return [];

  const filters: Record<string, unknown> = opts.candidateIds ? { ids: [...opts.candidateIds] } : { kind: 'issue' };
  const query: SearchQuery = {
    text: opts.text,
    vec: opts.vec,
    signals: [{ kind: 'text' }, { kind: 'vec' }],
    rescore: [{ kind: 'temporal', decay: opts.decayPerHour ?? DEFAULT_TEMPORAL_DECAY_PER_HOUR }],
    filters,
  };
  return handle.search.backend.searchRanked(query, opts.limit);
}

/**
 * `view:'similar'` (SPEC.md §5a) — `filter.anchor` (item-anchored) or
 * `filter.semantic` (free text), fused text+vec ranked via
 * {@link rankByFusedRelevance}, projected to `IIssueCard`s with `_score`
 * populated when requested (`card.ts`'s existing
 * `IAssembleIssueCardOptions.score` seam — SPEC.md §5a's `_score` exposure).
 *
 * The anchor issue is EXCLUDED from its own results (RAG-SPEC.md §3.2's
 * carried-forward "the query item itself is excluded" — SPEC.md §5a does not
 * restate this explicitly, a genuine spec gap this implementation fills per
 * that precedent rather than silently, since "similar to X" trivially
 * self-matching X at rank 1 is a real usability defect, not a feature).
 * Exclusion is done POST-search (fetch one extra candidate, drop the anchor,
 * slice to `limit`) rather than by enumerating the whole issue table to
 * subtract one id up front — far cheaper for the common "no other filter"
 * case, and still exactly correct.
 *
 * Errors: `IssueNotFoundError(anchor)` (SPEC.md §6.1's general `uid`-
 * addressing convention — `anchor` is `uid`-typed per §6.1's own statement
 * that it is "the SAME `uid`-typed field" as every other addressing field;
 * reused directly from `resolve.ts`'s `resolveIssueByUid` rather than
 * re-derived, which also means this gets the SPEC-correct error class for
 * free). `InvalidArgumentError('semantic', ...)` (no search backend configured).
 * `InvalidArgumentError('filter', ...)` (neither `anchor` nor `semantic`
 * given). `BacklogValidationError('limit', ...)` (out-of-range `limit`).
 */
export async function querySimilarView(handle: IQueryStoreHandle, input: IIssueQueryInput): Promise<IIssueCard[]> {
  const { graph } = handle;
  if (!handle.search) {
    throw new InvalidArgumentError('semantic', 'semantic search is not configured for this store (no embedding/vector backend injected)');
  }
  assertKnownIssueFields(input.fields);
  const fields = (input.fields ?? DEFAULT_ISSUE_CARD_FIELDS) as readonly IIssueField[];
  const limit = assertSimilarLimit(input.limit);

  let text: string;
  let anchor: NodeRecord | undefined;
  if (input.filter?.anchor !== undefined) {
    anchor = await resolveIssueByUid(graph, input.filter.anchor);
    text = `${anchor.name ?? ''}\n${anchor.content}`.trim();
  } else if (input.filter?.semantic !== undefined) {
    text = input.filter.semantic;
  } else {
    throw new InvalidArgumentError('filter', '`view:"similar"` requires `filter.anchor` or `filter.semantic`');
  }

  const candidateIds = await resolveSimilarFilterIds(graph, input.filter);
  if (candidateIds && anchor) candidateIds.delete(anchor.id);
  if (candidateIds && candidateIds.size === 0) return [];

  const vec = await handle.search.embedQuery(text);
  // Fetch one extra candidate when anchored so dropping the anchor post-search
  // still leaves `limit` results. NOT capped at MAX_QUERY_LIMIT: that cap
  // bounds the CALLER-FACING `limit` (assertSimilarLimit, above), but this is
  // an internal fetch size handed straight to `searchRanked(query, limit:
  // number)`, which the installed `@adhd/sox-hybrid-search` contract
  // (`dist/index.d.ts:204`) declares as a plain unbounded `number` — no
  // documented upper bound. Clamping it here previously silently dropped one
  // result whenever `limit === MAX_QUERY_LIMIT` and the anchor placed inside
  // the fetched window (verified: `Math.min(1001, 1000) === 1000`, so the
  // anchor's removal left only 999 rows for a caller that asked for 1000).
  const fetchLimit = anchor ? limit + 1 : limit;
  const results = await rankByFusedRelevance(handle, { text, vec, candidateIds, limit: fetchLimit });
  const page = (anchor ? results.filter((r) => r.id !== anchor!.id) : results).slice(0, limit);
  if (page.length === 0) return [];

  const nodes = await graph.getNodesByIds(page.map((r) => r.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ordered = page.map((r) => byId.get(r.id)).filter((n): n is NodeRecord => n !== undefined);
  const scoreByUid = new Map(
    page.map((r) => [byId.get(r.id)?.uid, r.score] as const).filter((e): e is [string, number] => e[0] !== undefined),
  );
  return assembleIssueCards(graph, ordered, fields, scoreByUid);
}
