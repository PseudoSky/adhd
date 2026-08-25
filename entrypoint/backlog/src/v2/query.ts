/**
 * v2/query.ts — INTERFACE_v2 §2, `backlog_query`: the query layer, and the
 * design centre of the whole v2 surface.
 *
 * This is a COMPOSITION layer over `../store/query.ts`, not a second query
 * engine. Every read here delegates: the filtered node fetch is
 * `queryItemNodes` (which is `fetchFilteredNodes` — FTS/grep, rootLevel,
 * excludeArchived, live-only, `stableNodeOrder` — plus `paginate`),
 * `view:"ready"` is `readyItems`, `view:"order"` is `topoOrder`,
 * `view:"graph"` is `dependencyGraph`, `view:"stale"` is `staleClaims`,
 * `view:"summary"` is `computeStats`, and the per-item blocker/rollup/audit
 * projections are `blockers` / `PART_OF` traversal / `queryAuditEvents`. What
 * this file adds is the surface the store layer deliberately does not have:
 * the closed input contract, the v2 filter axes, ranking, projection,
 * grouping, and the outcome envelope.
 *
 * Five contracts here are load-bearing and must not be softened:
 *
 * 1. **§2.1 / BUG-BACKLOG-003 — pagination composes, or it is a bug.**
 *    `limit`/`offset` are applied EXACTLY ONCE, LAST, to an array that has
 *    already been fully filtered AND fully sorted. The pre-fix defect was a
 *    page boundary drawn *before* the open/closed post-filter, so
 *    `{status:"open", limit:145}` silently returned fewer than 145 open items
 *    with no signal that more existed. The v2 layer inherits that ordering
 *    discipline and extends it: the v2-only filters (dateRange, dupeHitsMin,
 *    author/reporter, criteria/citation presence …) and the SORT both run
 *    before the slice. `{ total, returned }` always ships in the envelope's
 *    `meta`, so a short page is distinguishable from the true last page.
 * 2. **§0.2 / AC-18 projection discipline.** The default projection is the
 *    terse card (`DEFAULT_CARD_FIELDS`). Bodies, notes, citations, audit
 *    trails, rollups and embedding blobs are each opt-in BY NAME. 36 items
 *    were 90KB of bodies because the read tool's own default returned
 *    everything; that default is the bug, not the caller.
 * 3. **§7 "never accept-and-ignore an input key."** Every top-level key, every
 *    filter key, every projection field and every enum value is checked
 *    against a closed set, and anything unrecognised — or recognised but
 *    meaningless for the requested `view` — is a TYPED error naming the key.
 *    A parameter that is quietly dropped is indistinguishable from one that
 *    was honoured, which is the exact failure class AC-23 exists to close.
 * 4. **§7.1 "a read never silently narrows."** Ambiguity is a `warnings` entry
 *    or an error, never a quiet pick: a bare repo name that resolves to two
 *    genuinely different repos returns BOTH repos' items plus a warning
 *    naming the ambiguity (AC-24), and the grep path reports
 *    `meta.truncated` when it hits the documented FTS fetch budget.
 * 5. **AC-12 — the semantic channel degrades LOUDLY.** This build has no
 *    embedding backend, so `filter.semantic`, `filter.anchor`,
 *    `view:"similar"`, `sort:"relevance"` and the `_score`/`_vector`
 *    projections all return `rag_not_configured` rather than quietly
 *    answering a semantic question with a keyword result. `grep` and every
 *    dimensional query keep working, exactly as AC-12 requires.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type {
  AuditTrailEntry,
  BacklogFilter,
  BacklogItem,
  BacklogStatus,
  DependencyGraph,
  IBacklogCard,
  IBacklogField,
  IBacklogFilter,
  IBacklogQueryInput,
  IBacklogSort,
  IBacklogStats,
  IBacklogView,
  ICriticalPathResult,
  IGroupBucket,
  IGroupBy,
  IGroupByAxis,
  IGroupedView,
  IItemRollup,
  IOrderResult,
  IOutcomeEnvelope,
  IOverlapAxis,
  IOverlapPair,
  IOverlapView,
  IPathWeightFn,
  IPlanReadinessResult,
  IPlanView,
  IQueryEnvelopeMeta,
  IQueryPlan,
  IExtractedTerm,
  ISortDirection,
  IStaleClaimEntry,
  ISummaryBucket,
  Priority,
} from '../model.js';
import {
  BACKLOG_SORTS,
  BACKLOG_STATUSES,
  BACKLOG_VIEWS,
  BacklogValidationError,
  DEFAULT_CARD_FIELDS,
  InvalidArgumentError,
  RagNotConfiguredError,
  assertKnownFields,
  assertKnownFilterKeys,
  assertQueryLimit,
  canonicalIdentityKey,
  errorEnvelope,
  isBacklogSort,
  isBacklogView,
  isTerminalStatus,
  normalizeGroupBy,
  okEnvelope,
  resolveStatusSelector,
  toOutcomeError,
} from '../model.js';
import type { GraphBacklogStore } from '../store/graph-backlog-store.js';
import { queryAuditEvents } from '../store/audit-log.js';
import { BACKLOG_ITEM_TAG, toBacklogItem, type BacklogNodeMeta } from '../store/mapping.js';
import { parseRepoKey } from '../store/repo-nodes.js';
import {
  blockers as blockersOp,
  computeStats,
  dependencyGraph as dependencyGraphOp,
  knownRepos,
  queryItemNodes,
  readyItems as readyItemsOp,
  staleClaims as staleClaimsOp,
  topoOrder as topoOrderOp,
} from '../store/query.js';

// ----------------------------------------------------------------------------
// Input surface.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §2 — `backlog_query`'s input.
 *
 * Extends the contract's `IBacklogQueryInput` with the ONE knob `view:"stale"`
 * cannot exist without. §2.2 defines `stale` as "items whose claims are older
 * than the lease window", and the lease window is a parameter of the shipped
 * read it absorbs (`staleClaims(ctx, maxAgeMin, scope)` — SKILL.md line 68).
 * `IBacklogQueryInput` has no field for it, so it is declared here rather
 * than hard-coded: a caller that means "stale after 5 minutes" must be able
 * to say so, and the SKILL's documented default (30 minutes) is what an
 * absent value means.
 */
export interface IBacklogQueryOptions extends IBacklogQueryInput {
  /**
   * §2.2 `view:"stale"` — the claim-lease window in minutes. Defaults to
   * `DEFAULT_STALE_AFTER_MINUTES`. Rejected with `invalid_argument` on every
   * other view (§7: an ignored key is a bug).
   */
  staleAfterMinutes?: number;
}

/**
 * INTERFACE_v2 §7 — the CLOSED set of top-level keys `backlog_query` accepts.
 * `additionalProperties: false` is only actually closed if something
 * enumerates it at runtime.
 */
export const BACKLOG_QUERY_INPUT_KEYS = [
  'view',
  'filter',
  'fields',
  'sort',
  'direction',
  'limit',
  'offset',
  'groupBy',
  'humanIds',
  'overlapBy',
  'text',
  'bucket',
  'weightFn',
  'format',
  'staleAfterMinutes',
] as const;

// Compile-time exhaustiveness: adding a property to `IBacklogQueryOptions`
// without adding it to `BACKLOG_QUERY_INPUT_KEYS` fails the BUILD rather than
// silently becoming a runtime-rejected key. Mirrors `BACKLOG_FILTER_KEYS`'
// own guard in model.ts and `BACKLOG_GET_INPUT_KEYS`' in v2/get.ts.
type UncoveredQueryKey = Exclude<keyof IBacklogQueryOptions, (typeof BACKLOG_QUERY_INPUT_KEYS)[number]>;
const _QUERY_KEY_COVERAGE: UncoveredQueryKey extends never ? true : never = true;
void _QUERY_KEY_COVERAGE;

/**
 * §2.1a / AC-23's trap in the other direction: an agent reaching for
 * `backlog_get`'s grammar on `backlog_query`. These get a targeted
 * `invalid_argument` pointing at the right tool, rather than the generic
 * "unknown key" a typo gets.
 */
const GET_ONLY_KEYS: readonly string[] = ['humanId', 'repo', 'includeDeleted'];

/** SKILL.md's documented staleness default (30 minutes) — see `IBacklogQueryOptions.staleAfterMinutes`. */
export const DEFAULT_STALE_AFTER_MINUTES = 30;

/**
 * Mirror of `store/query.ts`'s module-private `GREP_FETCH_BUDGET` (query.ts:143).
 * Used for ONE thing only: detecting that the FTS path came back exactly at
 * the budget, so `meta.truncated` can say so. §7.4 accepts the grep
 * full-fetch-then-slice budget as a documented limitation — a documented
 * limitation that is invisible at the call site is just a silent truncation,
 * which §0.3 forbids.
 */
const GREP_FETCH_BUDGET = 1000;

/** `spotlight`'s ranking table, reproduced verbatim from query.ts:30 so `sort:"priority"` IS spotlight's order (AC-5). */
const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * §2.3 — the natural direction of each sort key, i.e. what the caller means
 * when they do not pass `direction`. `priority` ascends (CRITICAL first,
 * matching `spotlight`); recency and demand descend (newest / most-demanded
 * first). An explicit `direction` overrides.
 */
const DEFAULT_SORT_DIRECTION: Record<IBacklogSort, ISortDirection> = {
  priority: 'asc',
  updated: 'desc',
  created: 'desc',
  demand: 'desc',
  relevance: 'desc',
};

/**
 * §2.2 — which filter keys each view can actually HONOUR.
 *
 * `'all'` means the view runs the full filter pipeline. The narrow views
 * delegate to store operations that take only a `StatsScope`
 * (`{repo, projectPath}`) or have an inherently unfiltered domain, and
 * accepting a filter key those computations cannot express would be exactly
 * the accept-and-ignore §7 forbids — so those keys are a typed error naming
 * both the key and the view.
 *
 * Two deliberate absences, both spec-driven:
 * - `status` is not honourable on `summary` (an all-status breakdown scoped
 *   to "open" is tautological — model.ts's `IBacklogStats.byStatus` doc) nor
 *   on `plan` (the two-axis rollup §5a.1 requires ALL members, open and
 *   closed; a status filter would silently corrupt `childrenClosed`).
 * - `claimedBy` on `plan` is NOT a member filter — §5a.6/AC-16 define it as
 *   the selector for the `myClaims` set. It is handled there, and the member
 *   set stays whole.
 */
const VIEW_FILTER_KEYS: Record<IBacklogView, 'all' | readonly (keyof IBacklogFilter)[]> = {
  list: 'all',
  ready: 'all',
  grouped: 'all',
  similar: 'all',
  order: ['repo', 'projectPath'],
  graph: ['repo', 'projectPath'],
  stale: ['repo', 'projectPath'],
  summary: ['repo', 'projectPath', 'dateRange'],
  plan: ['plan', 'repo', 'projectPath', 'claimedBy', 'dateRange'],
  overlap: ['repo', 'projectPath'],
};

/** §2.4 — views whose payload is built from projected cards, and therefore the only ones for which `fields` has a meaning. */
const PROJECTING_VIEWS: readonly IBacklogView[] = ['list', 'ready', 'grouped', 'plan', 'similar'];

/** §2.3 / §2.1 — views that yield an ordered, pageable item list. `sort`/`direction`/`limit`/`offset` belong to these and nowhere else. */
const PAGEABLE_VIEWS: readonly IBacklogView[] = ['list', 'ready', 'stale', 'similar'];

/** §7.3 — `--format table` renders these three for humans; every other view is agent-native JSON only. */
const TABLE_VIEWS: readonly IBacklogView[] = ['summary', 'grouped', 'plan'];

// ----------------------------------------------------------------------------
// Result surface.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §2 — `backlog_query`'s payload, discriminated by `view`.
 *
 * One object rather than a bare array per view, because §2.1b requires the
 * compiled natural-language plan to ride along as `data.query` (AC-27) — a
 * bare array has nowhere to put it, and an envelope that changes SHAPE
 * between spellings of the same query is the thing §2.1b's parity clause
 * forbids. Exactly one payload field is populated for any given `view`.
 */
export interface IBacklogQueryResult {
  /** The view that produced this payload. Always echoed, so a caller never has to infer which field to read. */
  view: IBacklogView;
  /** `view:"list"` / `view:"ready"` — projected terse cards (§2.4). */
  items?: IBacklogCard[];
  /** `view:"stale"` — claims older than the lease window (§2.2). */
  stale?: IStaleClaimEntry[];
  /** `view:"order"` — the topological order plus wave numbers, or the cycle that prevents one. */
  order?: IOrderResult;
  /** `view:"graph"` — dependency/related/part-of edges. */
  graph?: DependencyGraph;
  /** `view:"summary"` — FEAT-010 aggregate over transition history. */
  summary?: IBacklogStats;
  /** `view:"grouped"` — FEAT-007 `groupBy`-keyed buckets. */
  grouped?: IGroupedView;
  /** `view:"plan"` — FEAT-015's one-call resume surface. */
  plan?: IPlanView;
  /** `view:"plan"` + `weightFn` — §5a.8's pinned `criticalPath` shape. */
  criticalPath?: ICriticalPathResult;
  /** `view:"plan"` — §5a.8's pinned `planReadiness` shape, always computed (it is free once the plan view has its member set). */
  readiness?: IPlanReadinessResult;
  /** `view:"overlap"` — FEAT-005 Stage 3 pairwise intersections. */
  overlap?: IOverlapView;
  /** §2.1b / AC-27 — the compiled plan for a `text` query. Present ONLY when `text` was supplied, so a caller can see exactly what the string became. */
  query?: IQueryPlan;
  /** §7.3 — the human-readable rendering, present only when `format: "table"` was requested. The structured payload above is ALSO present; `table` never replaces it. */
  table?: string;
}

/** One item as this layer carries it: the mapped `BacklogItem` plus the `NodeRecord` the v2-only dimensional/demand metadata still lives on. */
interface IQueryRow {
  node: NodeRecord;
  item: BacklogItem;
}

/** FEAT-012 / FEAT-013 / §5a.3 metadata that has no `BacklogNodeMeta` field yet — read defensively off the node, exactly as `v2/get.ts` does. */
interface IV2Meta {
  author?: string;
  reporter?: string;
  project?: string;
  packagePath?: string;
  dupeHits?: number;
  files?: string[];
  criteria?: unknown[];
}

// ----------------------------------------------------------------------------
// The operation.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §2 — `backlog_query`, the query layer.
 *
 * Absorbs v1's `list-items`, `spotlight`, `ready-items`, `topo-order`,
 * `dependency-graph`, `stats` and `stale-claims`, and adds the unbuilt read
 * features: aggregate/export (FEAT-010, `view:"summary"`), group-bys
 * (FEAT-007, `view:"grouped"`), pairwise overlap (FEAT-005 Stage 3,
 * `view:"overlap"`), the resume surface (FEAT-015, `view:"plan"`), demand
 * ranking (FEAT-013, `sort:"demand"`) and projection (§2.4, `fields`).
 *
 * `view:"list"` with the default sort IS today's `spotlight` ordering
 * (`PRIORITY_RANK` then `humanId` — query.ts:515-524, AC-5) with ONE stated
 * difference: `spotlight` DROPS items that carry no `priority`, and a general
 * list tool must not silently hide rows (§7.1), so unprioritised items sort
 * last instead of disappearing. The prioritised prefix is byte-identical to
 * `spotlight`'s answer, which is what the AC-5 parity test asserts.
 *
 * @param store an open backlog graph store
 * @param input `{ view?, filter?, fields?, sort?, limit?, offset?, groupBy?, … }` — any other key is a typed error
 * @returns the §7.1 outcome envelope: `ok:true` + `IBacklogQueryResult` (with
 *   `meta` carrying `{ total, returned }` for pageable views), or `ok:false`
 *   with `validation` / `invalid_argument` / `item_not_found` /
 *   `rag_not_configured` / `store_busy` / `internal`
 */
export async function backlogQuery(store: GraphBacklogStore, input: IBacklogQueryOptions): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  try {
    const raw = (input ?? {}) as unknown as Record<string, unknown>;
    assertKnownQueryKeys(raw);

    const view = resolveView(raw['view']);
    const filterInput: Record<string, unknown> = (raw['filter'] as Record<string, unknown> | undefined) ?? {};
    assertKnownFilterKeys(filterInput);
    assertViewFilterKeys(view, filterInput);
    assertViewScopedKeys(view, raw);

    const warnings: string[] = [];
    let filter = filterInput as IBacklogFilter;
    let queryPlan: IQueryPlan | undefined;

    if (typeof raw['text'] === 'string') {
      const compiled = await compileTextQuery(store, raw['text'], filter, raw['sort'] as IBacklogSort | undefined);
      filter = compiled.filter;
      queryPlan = compiled.plan;
      warnings.push(...compiled.warnings);
    }

    // AC-12 — every semantic input, checked BEFORE any work is done, so the
    // degrade is the first thing the caller learns rather than a surprise
    // after a full (and wrong) keyword answer.
    assertNoSemanticInputs(view, filter, raw);

    const sort = resolveSort(raw['sort'], queryPlan);
    const direction = resolveDirection(raw['direction'], sort);
    const limit = raw['limit'] as number | undefined;
    const offset = resolveOffset(raw['offset']);
    assertQueryLimit(limit);

    const fields = resolveFields(view, raw['fields'] as readonly IBacklogField[] | undefined);
    const format = resolveFormat(view, raw['format']);

    const ctx: IQueryContext = { store, view, filter, fields, sort, direction, limit, offset, warnings, queryPlan };

    switch (view) {
      case 'list':
        return await runListView(ctx);
      case 'ready':
        return await runReadyView(ctx);
      case 'stale':
        return await runStaleView(ctx, raw['staleAfterMinutes'] as number | undefined);
      case 'order':
        return await runOrderView(ctx);
      case 'graph':
        return await runGraphView(ctx);
      case 'summary':
        return await runSummaryView(ctx, (raw['bucket'] as ISummaryBucket | undefined) ?? 'day', format);
      case 'grouped':
        return await runGroupedView(ctx, raw['groupBy'] as IGroupByAxis | IGroupBy | undefined, format);
      case 'plan':
        return await runPlanView(ctx, raw['weightFn'] as IPathWeightFn | undefined, format);
      case 'overlap':
        return await runOverlapView(ctx, raw['humanIds'] as unknown, (raw['overlapBy'] as IOverlapAxis | undefined) ?? 'file');
      case 'similar':
        // Unreachable: `assertNoSemanticInputs` above rejects `view:"similar"`
        // outright (AC-12). Kept explicit so a future embedding backend has
        // exactly one place to land, and so the switch stays exhaustive.
        throw new RagNotConfiguredError('view:"similar"');
      default: {
        const never: never = view;
        throw new InvalidArgumentError('view', `view: unhandled view ${JSON.stringify(never)}`);
      }
    }
  } catch (err) {
    const outcome = toOutcomeError(err);
    return errorEnvelope(outcome.code, outcome.message, outcome.details);
  }
}

/** Everything the view runners share. Assembled once, in `backlogQuery`, after validation — so no runner can see an unvalidated input. */
interface IQueryContext {
  store: GraphBacklogStore;
  view: IBacklogView;
  filter: IBacklogFilter;
  fields: Set<IBacklogField>;
  sort: IBacklogSort;
  direction: ISortDirection;
  limit: number | undefined;
  offset: number;
  warnings: string[];
  queryPlan: IQueryPlan | undefined;
}

/** Wraps a payload in the §7.1 envelope, attaching `data.query`, warnings and pagination meta uniformly so no view can forget one. */
function envelopeOf(ctx: IQueryContext, payload: Omit<IBacklogQueryResult, 'view' | 'query'>, meta?: IQueryEnvelopeMeta): IOutcomeEnvelope<IBacklogQueryResult> {
  const data: IBacklogQueryResult = { view: ctx.view, ...payload };
  if (ctx.queryPlan) data.query = ctx.queryPlan;
  const extra: { warnings?: string[]; meta?: IQueryEnvelopeMeta } = {};
  if (ctx.warnings.length > 0) extra.warnings = [...ctx.warnings];
  if (meta) extra.meta = meta;
  return okEnvelope(data, extra);
}

// ----------------------------------------------------------------------------
// Validation — §7 "never accept-and-ignore an input key".
// ----------------------------------------------------------------------------

/** §7.8 — the top-level key check. `backlog_get`'s keys get a targeted message; anything else is a plain unknown-key `validation` error. */
function assertKnownQueryKeys(input: Record<string, unknown>): void {
  const known: ReadonlySet<string> = new Set<string>(BACKLOG_QUERY_INPUT_KEYS);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length === 0) return;

  const getOnly = unknown.filter((k) => GET_ONLY_KEYS.includes(k));
  if (getOnly.length > 0) {
    throw new InvalidArgumentError(
      getOnly[0] ?? 'humanId',
      `backlog_query: ${getOnly.map((k) => `"${k}"`).join(', ')} ${getOnly.length === 1 ? 'is a' : 'are'} backlog_get parameter${getOnly.length === 1 ? '' : 's'} — ` +
        `a single item is \`backlog_get({ humanId })\`; to select items here use \`filter\` (INTERFACE_v2 §1/§2.1)`
    );
  }
  throw new BacklogValidationError(`backlog_query: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}`, unknown);
}

/** §2.2 — an unknown `view` is `invalid_argument`, NEVER a silent fallback to `list`. */
function resolveView(value: unknown): IBacklogView {
  if (value === undefined) return 'list';
  if (!isBacklogView(value)) {
    throw new InvalidArgumentError('view', `view: unknown view ${JSON.stringify(value)} (expected one of ${BACKLOG_VIEWS.join(', ')})`);
  }
  return value;
}

/** §2.2 / §7 — a filter key the requested view cannot express is an error naming BOTH the key and the view, not a quietly-dropped predicate. */
function assertViewFilterKeys(view: IBacklogView, filter: Record<string, unknown>): void {
  const allowed = VIEW_FILTER_KEYS[view];
  if (allowed === 'all') return;
  const allowedSet: ReadonlySet<string> = new Set<string>(allowed as readonly string[]);
  const rejected = Object.keys(filter).filter((k) => !allowedSet.has(k));
  if (rejected.length === 0) return;
  throw new InvalidArgumentError(
    'filter',
    `filter: view:"${view}" cannot honour filter key(s) ${rejected.map((k) => `"${k}"`).join(', ')} — ` +
      `it accepts ${(allowed as readonly string[]).map((k) => `"${k}"`).join(', ')}. ` +
      `Silently ignoring a filter would return a result that looks scoped and is not (INTERFACE_v2 §7).`
  );
}

/**
 * §7 — the per-view applicability of the TOP-LEVEL keys.
 *
 * `groupBy` on a `list` query, `humanIds` on a `summary`, `bucket` on a
 * `graph`, `sort` on an unordered aggregate: every one of these is a caller
 * who believes something is happening that is not. Each is named explicitly.
 */
function assertViewScopedKeys(view: IBacklogView, raw: Record<string, unknown>): void {
  const reject = (key: string, why: string): never => {
    throw new InvalidArgumentError(key, `${key}: has no meaning for view:"${view}" — ${why} (INTERFACE_v2 §2.2)`);
  };

  if (raw['groupBy'] !== undefined && view !== 'grouped') reject('groupBy', 'bucketing is view:"grouped"');
  if (raw['humanIds'] !== undefined && view !== 'overlap') reject('humanIds', 'the explicit id set is view:"overlap"\'s payload');
  if (raw['overlapBy'] !== undefined && view !== 'overlap') reject('overlapBy', 'the overlap axis is view:"overlap"\'s');
  if (raw['bucket'] !== undefined && view !== 'summary') reject('bucket', 'period bucketing is view:"summary"\'s');
  if (raw['weightFn'] !== undefined && view !== 'plan') reject('weightFn', 'critical-path weighting is view:"plan"\'s (§5a.8)');
  if (raw['staleAfterMinutes'] !== undefined && view !== 'stale') reject('staleAfterMinutes', 'the claim-lease window is view:"stale"\'s');
  if (raw['text'] !== undefined && view !== 'list') {
    reject('text', 'the natural-language form compiles into a list query (§2.1b); for raw vector recall use view:"similar"');
  }
  if (view === 'grouped' && raw['groupBy'] === undefined) {
    throw new InvalidArgumentError('groupBy', 'groupBy: view:"grouped" requires an axis — there is no default bucketing (INTERFACE_v2 §2.2)');
  }
  for (const key of ['sort', 'direction', 'limit', 'offset']) {
    if (raw[key] !== undefined && !PAGEABLE_VIEWS.includes(view)) {
      reject(key, `view:"${view}" returns an aggregate/graph payload with no item ordering to rank or page`);
    }
  }
}

/** §2.3 — an unknown `sort` is `invalid_argument`. A `text` query defaults to the FTS fallback ranking the planner chose (§2.1b step 5). */
function resolveSort(value: unknown, queryPlan: IQueryPlan | undefined): IBacklogSort {
  if (value === undefined) return queryPlan?.sort ?? 'priority';
  if (!isBacklogSort(value)) {
    throw new InvalidArgumentError('sort', `sort: unknown sort ${JSON.stringify(value)} (expected one of ${BACKLOG_SORTS.join(', ')})`);
  }
  return value;
}

/** §2.3 — `direction` overrides the sort key's natural order (`DEFAULT_SORT_DIRECTION`). */
function resolveDirection(value: unknown, sort: IBacklogSort): ISortDirection {
  if (value === undefined) return DEFAULT_SORT_DIRECTION[sort];
  if (value !== 'asc' && value !== 'desc') {
    throw new InvalidArgumentError('direction', `direction: expected "asc" or "desc", received ${JSON.stringify(value)}`);
  }
  return value;
}

/** §2.1 — `offset` is validated the same way `limit` is: a bad value fails, it is never coerced to 0. */
function resolveOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BacklogValidationError(`offset: must be a non-negative integer (got ${JSON.stringify(value)})`, ['offset']);
  }
  return value as number;
}

/**
 * §2.4 / AC-19 — projection resolution.
 *
 * `fields` is ADDITIVE to the default card (the identity spine is
 * non-optional on `IBacklogCard`, so it is always present), unknown fields
 * are a `validation` error rather than a silent omission, `items` is
 * meaningful only inside `view:"grouped"` buckets, and any `fields` at all on
 * a view whose payload is not built from cards is an error — because the
 * projection would simply never appear in the response.
 */
function resolveFields(view: IBacklogView, requested: readonly IBacklogField[] | undefined): Set<IBacklogField> {
  if (requested !== undefined) {
    if (!Array.isArray(requested)) {
      throw new BacklogValidationError(`fields: expected an array of field names (got ${JSON.stringify(requested)})`, ['fields']);
    }
    assertKnownFields(requested as readonly string[]);
    if (!PROJECTING_VIEWS.includes(view)) {
      throw new InvalidArgumentError(
        'fields',
        `fields: view:"${view}" returns an aggregate/graph payload, not projected cards — ` +
          `the requested field(s) ${requested.map((f) => `"${f}"`).join(', ')} would be silently absent from the response (INTERFACE_v2 §2.4)`
      );
    }
    if (requested.includes('items') && view !== 'grouped') {
      throw new BacklogValidationError(
        `fields: "items" is view:"grouped"'s per-bucket item list (INTERFACE_v2 §2.2) and has no meaning for view:"${view}"`,
        ['items']
      );
    }
  }
  return new Set<IBacklogField>([...DEFAULT_CARD_FIELDS, ...(requested ?? [])]);
}

/** §7.3 — `table` is a rendering of the summary/grouped/plan payloads; asking for it elsewhere is an error, not a no-op. */
function resolveFormat(view: IBacklogView, value: unknown): 'json' | 'table' {
  if (value === undefined) return 'json';
  if (value !== 'json' && value !== 'table') {
    throw new InvalidArgumentError('format', `format: expected "json" or "table", received ${JSON.stringify(value)}`);
  }
  if (value === 'table' && !TABLE_VIEWS.includes(view)) {
    throw new InvalidArgumentError('format', `format: "table" renders ${TABLE_VIEWS.map((v) => `view:"${v}"`).join(' / ')} for humans; view:"${view}" is JSON-only (INTERFACE_v2 §7.3)`);
  }
  return value;
}

/**
 * AC-12 — the semantic channel degrades LOUDLY.
 *
 * `grep` and every dimensional query keep working; anything that would need
 * an embedding matcher returns `rag_not_configured` naming the input. The
 * alternative — quietly answering `semantic` with FTS — is precisely the
 * silently-wrong result §0.3 ranks as worse than a failure, and §7.6 forbids
 * `grep` from becoming the hybrid stand-in.
 */
function assertNoSemanticInputs(view: IBacklogView, filter: IBacklogFilter, raw: Record<string, unknown>): void {
  const requested: string[] = [];
  if (filter.semantic !== undefined) requested.push('filter.semantic');
  if (filter.anchor !== undefined) requested.push('filter.anchor');
  if (view === 'similar') requested.push('view:"similar"');
  if (raw['sort'] === 'relevance') requested.push('sort:"relevance"');
  const fields = raw['fields'];
  if (Array.isArray(fields)) {
    if (fields.includes('_score')) requested.push('fields:"_score"');
    if (fields.includes('_vector')) requested.push('fields:"_vector"');
  }
  if (requested.length === 0) return;
  // Named as one feature string so the message lists everything the caller
  // asked for, not just the first thing that tripped.
  throw new RagNotConfiguredError(requested.join(' + '));
}

// ----------------------------------------------------------------------------
// Filter compilation + the base fetch. Delegation lives here.
// ----------------------------------------------------------------------------

/** FEAT-012 / FEAT-013 / §5a.3 metadata read defensively off the node — these axes have no `BacklogNodeMeta` field until their epics land (mapping.ts:98-124). */
function v2Meta(node: NodeRecord): IV2Meta {
  return (node.metadata ?? {}) as IV2Meta;
}

/**
 * §2.1 — compiles the v2 filter into the shipped v1 `BacklogFilter` that
 * `store/query.ts` already knows how to push into SQL.
 *
 * ONLY the predicates the store can express are compiled down; everything
 * else is applied by `applyV2Filters` over the mapped rows. Two rules keep
 * that split honest:
 *
 * - `limit`/`offset` are NEVER compiled down (BUG-BACKLOG-003 fix (a)). The
 *   store applying a page boundary before this layer's post-filters and sort
 *   have run is the exact defect the query layer exists to prevent.
 * - `status` is not compiled down as a closedness word either; the v2
 *   selector is richer than v1's (`resolveStatusSelector` accepts an explicit
 *   LIST), so closedness is resolved once, here, over mapped items. A single
 *   concrete status still pushes down as a metadata equality, which is a pure
 *   optimisation — `applyStatusSelector` re-applies it regardless.
 */
function compileV1Filter(filter: IBacklogFilter, repoCandidates: ReadonlySet<string> | undefined): BacklogFilter {
  const out: BacklogFilter = {};
  // A single resolved repo pushes into `NodeFilter.namespace`; an alias set
  // with more than one member cannot be expressed as one equality, so it
  // becomes a post-filter instead of a silently-narrowed single pick (AC-7/AC-24).
  if (repoCandidates && repoCandidates.size === 1) out.repo = [...repoCandidates][0];
  if (filter.projectPath !== undefined) out.projectPath = filter.projectPath;
  if (filter.kind !== undefined) out.kind = filter.kind;
  if (filter.family !== undefined) out.family = filter.family;
  if (typeof filter.priority === 'string') out.priority = filter.priority;
  if (filter.plan !== undefined) out.plan = filter.plan;
  if (filter.assignee !== undefined) out.assignee = filter.assignee;
  if (filter.claimedBy !== undefined) out.claimedBy = filter.claimedBy;
  if (filter.tags !== undefined) out.tags = [...filter.tags];
  if (filter.grep !== undefined) out.grep = filter.grep;
  if (filter.importedFrom !== undefined) out.importedFrom = filter.importedFrom;
  if (filter.rootLevel !== undefined) out.rootLevel = filter.rootLevel;
  if (filter.excludeArchived !== undefined) out.excludeArchived = filter.excludeArchived;

  const resolved = resolveStatusSelector(filter.status);
  if (resolved.mode === 'explicit' && resolved.statuses.length === 1) out.status = resolved.statuses[0];
  return out;
}

/**
 * AC-7 / AC-24 — resolves a caller's repo string against the repo strings
 * items are actually filed under.
 *
 * AC-7: `repo:"adhd"` must include items filed under the alias
 * `PseudoSky/adhd` — same repo, two spellings — so resolution is by
 * `parseRepoKey`'s normalised bare key, not string equality.
 * AC-24: when a bare name matches two GENUINELY DIFFERENT repos (different
 * owners), the query returns BOTH and warns. A read never silently narrows
 * (§7.1), and picking one would be exactly that.
 */
async function resolveRepoCandidates(store: GraphBacklogStore, rawRepo: string): Promise<{ candidates: Set<string>; warning?: string }> {
  const asked = parseRepoKey(rawRepo);
  const known = await knownRepos(store);
  const candidates = new Set<string>();
  const owners = new Set<string>();
  for (const filed of known) {
    let parsed;
    try {
      parsed = parseRepoKey(filed);
    } catch {
      // A stored repo string that no longer parses is data, not input — skip
      // it rather than failing an unrelated caller's query.
      continue;
    }
    if (parsed.bare !== asked.bare) continue;
    // A caller who spelled an owner means that owner; a bare ask matches every owner.
    if (asked.owner !== undefined && parsed.owner !== undefined && parsed.owner !== asked.owner) continue;
    candidates.add(filed);
    if (parsed.owner !== undefined) owners.add(parsed.owner);
  }
  // Nothing filed under it yet is not an error — it is an empty result (§7.2:
  // "an empty list result is ok:true, data:[]").
  if (candidates.size === 0) return { candidates: new Set([rawRepo]) };
  if (owners.size > 1) {
    return {
      candidates,
      warning:
        `repo "${rawRepo}" is ambiguous: it matches ${candidates.size} filed repo keys under ${owners.size} different owners ` +
        `(${[...candidates].sort().join(', ')}). All of them are included — qualify the repo (e.g. "${[...owners].sort()[0]}/${asked.bare}") to narrow (INTERFACE_v2 §7.1/AC-24).`,
    };
  }
  return { candidates };
}

/** §2.1 — one closedness knob, resolved once over mapped items (v1's `applyOpenClosedFilter` cannot express an explicit status LIST). */
function applyStatusSelector(rows: IQueryRow[], selector: IBacklogFilter['status']): IQueryRow[] {
  const resolved = resolveStatusSelector(selector);
  if (resolved.mode === 'explicit') {
    const wanted = new Set<BacklogStatus>(resolved.statuses);
    return rows.filter((r) => wanted.has(r.item.status));
  }
  if (resolved.closedness === 'all') return rows;
  const wantOpen = resolved.closedness === 'open';
  return rows.filter((r) => !isTerminalStatus(r.item.status) === wantOpen);
}

/** §5a.7 — the recognised acceptance-criteria body convention: a `## Criteria` / `## Acceptance` heading. Presence only; clause content is NEVER parsed. */
const CRITERIA_HEADING = /^\s*#{1,6}\s*(acceptance|criteria)\b/im;

/** §5a.7 — does this item carry the acceptance-criteria signal (heading convention OR a supplied `metadata.criteria` array)? */
function hasCriteria(row: IQueryRow): boolean {
  const meta = v2Meta(row.node);
  if (Array.isArray(meta.criteria) && meta.criteria.length > 0) return true;
  return CRITERIA_HEADING.test(row.item.body ?? '');
}

/** ISO-8601 strings compare lexicographically the same as chronologically — every timestamp here is `toISOString()`'s fixed-width format (mirrors query.ts:326's `withinWindow`). */
function withinBound(at: string | undefined, bound: { since?: string; until?: string } | undefined): boolean {
  if (!bound) return true;
  if (at === undefined) return false;
  if (bound.since !== undefined && at < bound.since) return false;
  if (bound.until !== undefined && at > bound.until) return false;
  return true;
}

/**
 * §2.1 — the v2-only filter axes, applied over mapped rows.
 *
 * These are post-filters BY NECESSITY, not by laziness: `dateRange.updated`
 * has no `NodeFilter` predicate until EPIC-F adds `tUpdatedAfter/Before`
 * (§2.1's "lands with" table owns that gap explicitly), the dimensional axes
 * live in node metadata until EPIC-A turns them into edges, and criteria /
 * citation presence are absence tests `NodeFilter`'s AND-of-equals cannot
 * express (the same reason `applyRootLevelFilter` is a post-filter,
 * query.ts:69-75). What matters for correctness is not WHERE they run but
 * that they run BEFORE the sort and the page boundary — which is the whole
 * of BUG-BACKLOG-003.
 */
function applyV2Filters(rows: IQueryRow[], filter: IBacklogFilter): IQueryRow[] {
  let out = rows;

  if (Array.isArray(filter.priority)) {
    const wanted = new Set<Priority>(filter.priority);
    out = out.filter((r) => r.item.priority !== undefined && wanted.has(r.item.priority));
  }

  // FEAT-012 / AC-13: "items missing the field are excluded when the filter is
  // present". AC-14: identities are canonicalised, so `researcher:a1` and
  // `researcher:b2` both match `author: "researcher"` — one bucket, never one
  // per process run.
  if (filter.author !== undefined) {
    const wanted = canonicalIdentityKey(filter.author);
    out = out.filter((r) => {
      const raw = v2Meta(r.node).author;
      return raw !== undefined && canonicalIdentityKey(raw) === wanted;
    });
  }
  if (filter.reporter !== undefined) {
    const wanted = canonicalIdentityKey(filter.reporter);
    out = out.filter((r) => {
      const raw = v2Meta(r.node).reporter;
      return raw !== undefined && canonicalIdentityKey(raw) === wanted;
    });
  }
  if (filter.project !== undefined) out = out.filter((r) => v2Meta(r.node).project === filter.project);
  if (filter.packagePath !== undefined) out = out.filter((r) => v2Meta(r.node).packagePath === filter.packagePath);

  if (filter.dateRange?.created) out = out.filter((r) => withinBound(r.item.createdAt, filter.dateRange?.created));
  if (filter.dateRange?.updated) out = out.filter((r) => withinBound(r.item.updatedAt, filter.dateRange?.updated));

  if (filter.dupeHitsMin !== undefined) {
    if (!Number.isInteger(filter.dupeHitsMin) || filter.dupeHitsMin < 0) {
      throw new BacklogValidationError(`filter.dupeHitsMin: must be a non-negative integer (got ${JSON.stringify(filter.dupeHitsMin)})`, ['dupeHitsMin']);
    }
    out = out.filter((r) => (v2Meta(r.node).dupeHits ?? 0) >= (filter.dupeHitsMin as number));
  }

  // §5a.3 — declared files only. The tool NEVER reads the filesystem; an item
  // matches when its declared set intersects the asked-for set.
  if (filter.files !== undefined) {
    const wanted = new Set(filter.files);
    out = out.filter((r) => (v2Meta(r.node).files ?? []).some((f) => wanted.has(f)));
  }

  if (filter.hasAcceptanceCriteria !== undefined && filter.missingAcceptanceCriteria !== undefined) {
    throw new InvalidArgumentError(
      'filter',
      'filter: hasAcceptanceCriteria and missingAcceptanceCriteria are complements — passing both is a contradiction, not a conjunction (INTERFACE_v2 §5a.7)'
    );
  }
  if (filter.hasAcceptanceCriteria !== undefined) out = out.filter((r) => hasCriteria(r) === filter.hasAcceptanceCriteria);
  if (filter.missingAcceptanceCriteria !== undefined) out = out.filter((r) => hasCriteria(r) !== filter.missingAcceptanceCriteria);
  if (filter.missingCitation !== undefined) out = out.filter((r) => (r.item.citations.length === 0) === filter.missingCitation);

  return out;
}

/**
 * The one base read every item-yielding view starts from: the FULLY filtered,
 * UNPAGINATED row set.
 *
 * Delegates the store half to `queryItemNodes` — which is
 * `fetchFilteredNodes` (FTS/grep with its sanitiser, `rootLevel`,
 * `excludeArchived`, live-only, `stableNodeOrder`) followed by `paginate`
 * with no `limit`/`offset`, i.e. the whole filtered set in a deterministic
 * order. This layer then adds the status selector and the v2 axes. Nothing
 * here slices: paging happens once, later, in `paginateRows`.
 */
async function fetchRows(store: GraphBacklogStore, filter: IBacklogFilter, warnings: string[]): Promise<{ rows: IQueryRow[]; truncated: boolean }> {
  let repoCandidates: Set<string> | undefined;
  if (filter.repo !== undefined) {
    const resolution = await resolveRepoCandidates(store, filter.repo);
    repoCandidates = resolution.candidates;
    if (resolution.warning) warnings.push(resolution.warning);
  }

  const v1 = compileV1Filter(filter, repoCandidates);
  const nodes = await queryItemNodes(store, v1);
  // §7.4 — the grep path's documented fetch budget, made VISIBLE. A
  // truncation nobody can see is a silent truncation.
  const truncated = filter.grep !== undefined && nodes.length >= GREP_FETCH_BUDGET;

  let rows: IQueryRow[] = nodes.map((node) => ({ node, item: toBacklogItem(node) }));
  if (repoCandidates !== undefined && repoCandidates.size !== 1) {
    const allowed = repoCandidates;
    rows = rows.filter((r) => allowed.has(r.item.repo));
  }
  rows = applyStatusSelector(rows, filter.status);
  rows = applyV2Filters(rows, filter);
  return { rows, truncated };
}

// ----------------------------------------------------------------------------
// Ranking + pagination — §2.3 / §2.1.
// ----------------------------------------------------------------------------

/**
 * §2.3 — ranking.
 *
 * `priority` is `spotlight`'s comparator, character for character
 * (query.ts:518-523): `PRIORITY_RANK` with an unknown/absent priority
 * ranking last (`?? 4`), `humanId` as the deterministic tiebreak. That is
 * what makes AC-5's "view:list with default sort equals today's spotlight
 * semantics" a fact rather than a hope.
 *
 * `demand` (FEAT-013) is the dupe counter FIRST and dominant — AC-17's
 * negative control exists precisely to prove the counter is not an incidental
 * tiebreak behind priority. Priority breaks ties within an equal dupe count.
 */
function compareRows(a: IQueryRow, b: IQueryRow, sort: IBacklogSort): number {
  switch (sort) {
    case 'priority': {
      const rankA = PRIORITY_RANK[a.item.priority ?? ''] ?? 4;
      const rankB = PRIORITY_RANK[b.item.priority ?? ''] ?? 4;
      return rankA - rankB || a.item.humanId.localeCompare(b.item.humanId);
    }
    case 'updated':
      return a.item.updatedAt.localeCompare(b.item.updatedAt) || a.item.humanId.localeCompare(b.item.humanId);
    case 'created':
      return a.item.createdAt.localeCompare(b.item.createdAt) || a.item.humanId.localeCompare(b.item.humanId);
    case 'demand': {
      const demandA = v2Meta(a.node).dupeHits ?? 0;
      const demandB = v2Meta(b.node).dupeHits ?? 0;
      if (demandA !== demandB) return demandA - demandB;
      const rankA = PRIORITY_RANK[a.item.priority ?? ''] ?? 4;
      const rankB = PRIORITY_RANK[b.item.priority ?? ''] ?? 4;
      // Priority ranks ASCEND (CRITICAL=0) while demand ASCENDS with the
      // counter; this comparator is written ascending throughout and the
      // caller's `direction` (default `desc` for demand) does the flip, so
      // the tiebreak has to be inverted here to stay "better first" after it.
      return rankB - rankA || b.item.humanId.localeCompare(a.item.humanId);
    }
    case 'relevance':
      // Unreachable — `assertNoSemanticInputs` rejects `sort:"relevance"`
      // with `rag_not_configured` before any row is fetched (AC-12).
      throw new RagNotConfiguredError('sort:"relevance"');
    default: {
      const never: never = sort;
      throw new InvalidArgumentError('sort', `sort: unhandled sort ${JSON.stringify(never)}`);
    }
  }
}

/** §2.3 — sorts ascending by the sort key, then applies `direction` (`DEFAULT_SORT_DIRECTION` when the caller did not say). */
function sortRows(rows: IQueryRow[], sort: IBacklogSort, direction: ISortDirection): IQueryRow[] {
  const sorted = [...rows].sort((a, b) => compareRows(a, b, sort));
  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * §2.1 / §7.4 / BUG-BACKLOG-003 — the ONE place a page boundary is ever drawn.
 *
 * Mirrors `store/query.ts`'s `paginate` (query.ts:124-133) and holds the same
 * invariant one layer up: the array reaching this function has already had
 * EVERY filter applied (v1 pushdown, status selector, v2 axes) AND has
 * already been sorted, so `offset`/`limit` slice the final answer rather than
 * a prefix that later shrinks. The store's own copy cannot be reused for this
 * because ranking happens here — `stableNodeOrder` is insertion order, and
 * slicing before the sort would page a different list than the one returned.
 *
 * `total` is the count BEFORE the slice, so `returned < limit` is
 * distinguishable from "the result set legitimately ended".
 */
function paginateRows(sorted: IQueryRow[], limit: number | undefined, offset: number, truncated: boolean): { page: IQueryRow[]; meta: IQueryEnvelopeMeta } {
  const page = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
  const meta: IQueryEnvelopeMeta = { total: sorted.length, returned: page.length };
  if (limit !== undefined) meta.limit = limit;
  if (offset !== 0) meta.offset = offset;
  if (truncated) meta.truncated = true;
  return { page, meta };
}

// ----------------------------------------------------------------------------
// Projection — §2.4, the context-blow fix.
// ----------------------------------------------------------------------------

/** Pseudo-fields resolved by this module; each costs a real extra read, which is why none of them is ever in a default projection (§0.2/AC-18). */
const PSEUDO_FIELD_SET: ReadonlySet<string> = new Set<string>(['body', 'audit_trail', 'blockers', 'citations', 'notes', 'rollup', 'items', '_score', '_vector']);

/**
 * §2.4 — projects one row into a terse card plus exactly the fields the
 * caller named.
 *
 * The identity spine (`humanId`/`kind`/`title`/`status`) is non-optional on
 * `IBacklogCard` and is therefore always present; `priority` is in the
 * default card too (`DEFAULT_CARD_FIELDS`). Everything else — and in
 * particular `body`, the 90KB problem, and `_vector`, the blob Linear's
 * lesson names explicitly — appears ONLY when asked for by name.
 */
async function buildCard(store: GraphBacklogStore, row: IQueryRow, fields: ReadonlySet<IBacklogField>): Promise<IBacklogCard> {
  const { item, node } = row;
  const card: IBacklogCard = { humanId: item.humanId, kind: item.kind, title: item.title, status: item.status };
  const meta = v2Meta(node);
  const setIfDefined = <K extends keyof IBacklogCard>(key: K, value: IBacklogCard[K] | undefined): void => {
    if (value !== undefined) card[key] = value;
  };

  for (const field of fields) {
    if (PSEUDO_FIELD_SET.has(field)) continue; // resolved below — each costs a read
    switch (field) {
      case 'humanId':
      case 'kind':
      case 'title':
      case 'status':
        break; // already on the spine
      case 'priority':
        setIfDefined('priority', item.priority);
        break;
      case 'repo':
        setIfDefined('repo', item.repo);
        break;
      case 'family':
        setIfDefined('family', item.family);
        break;
      case 'projectPath':
        setIfDefined('projectPath', item.projectPath);
        break;
      case 'plan':
        setIfDefined('plan', item.plan);
        break;
      case 'assignee':
        setIfDefined('assignee', item.assignee);
        break;
      case 'claimedBy':
        setIfDefined('claimedBy', item.claimedBy);
        break;
      case 'claimedAt':
        setIfDefined('claimedAt', item.claimedAt);
        break;
      case 'tags':
        setIfDefined('tags', item.tags);
        break;
      case 'createdAt':
        setIfDefined('createdAt', item.createdAt);
        break;
      case 'updatedAt':
        setIfDefined('updatedAt', item.updatedAt);
        break;
      case 'importedFrom':
        setIfDefined('importedFrom', item.importedFrom);
        break;
      case 'author':
        setIfDefined('author', meta.author === undefined ? undefined : canonicalIdentityKey(meta.author));
        break;
      case 'reporter':
        setIfDefined('reporter', meta.reporter === undefined ? undefined : canonicalIdentityKey(meta.reporter));
        break;
      case 'dupeHits':
        setIfDefined('dupeHits', meta.dupeHits ?? 0);
        break;
      case 'files':
        setIfDefined('files', meta.files);
        break;
      default:
        break;
    }
  }

  if (fields.has('body')) card.body = item.body;
  if (fields.has('citations')) card.citations = item.citations;
  if (fields.has('notes')) card.notes = item.notes;
  if (fields.has('audit_trail')) card.audit_trail = await queryAuditEvents(store, node.id);
  if (fields.has('blockers')) card.blockers = (await blockersOp(store, item.repo, item.humanId)).map((b) => b.humanId);
  if (fields.has('rollup')) card.rollup = await computeRollup(store, row);
  return card;
}

/** Projects a whole page. Sequential on purpose: the pseudo-fields hit the same SQLite connection, and a fan-out would only contend for it. */
async function buildCards(store: GraphBacklogStore, rows: readonly IQueryRow[], fields: ReadonlySet<IBacklogField>): Promise<IBacklogCard[]> {
  const cards: IBacklogCard[] = [];
  for (const row of rows) cards.push(await buildCard(store, row, fields));
  return cards;
}

/**
 * §5a.1 / §5a.5 — the two-axis rollup, DERIVED ON READ, never materialised
 * (materialising it recreates the drift problem the design rejects).
 *
 * Children point AT the parent (`writeEdge(child, parent, 'PART_OF')` —
 * structure.ts:239), so the traversal is by `dst`. The two axes are
 * independent on purpose: "children all closed, parent never transitioned"
 * and "parent closed, children still open" are different states and both are
 * real — a single boolean cannot express either.
 */
async function computeRollup(store: GraphBacklogStore, row: IQueryRow): Promise<IItemRollup> {
  const edges = await store.graph.getEdges({ dst: row.node.id, rel: 'PART_OF' });
  let childrenTotal = 0;
  let childrenClosed = 0;
  const childrenOpen: string[] = [];
  for (const edge of edges) {
    const child = await store.graph.getNode(edge.src);
    if (!child || child.tInvalid || !child.tags.includes(BACKLOG_ITEM_TAG) || child.isSuperseded) continue;
    const childItem = toBacklogItem(child);
    childrenTotal += 1;
    if (isTerminalStatus(childItem.status)) childrenClosed += 1;
    else childrenOpen.push(childItem.humanId);
  }
  return {
    childrenTotal,
    childrenClosed,
    childrenOpen,
    selfVerified: isTerminalStatus(row.item.status) && row.item.citations.length > 0,
  };
}

/** §5a.1's second axis, computed over an arbitrary member set (the plan view rolls up its members, not a `PART_OF` cone). */
function rollupOver(members: readonly IQueryRow[], parent: IQueryRow | undefined): IItemRollup {
  const childrenOpen = members.filter((m) => !isTerminalStatus(m.item.status)).map((m) => m.item.humanId);
  return {
    childrenTotal: members.length,
    childrenClosed: members.length - childrenOpen.length,
    childrenOpen,
    selfVerified: parent !== undefined && isTerminalStatus(parent.item.status) && parent.item.citations.length > 0,
  };
}

// ----------------------------------------------------------------------------
// Views — §2.2. Each one delegates its computation; none re-implements a store op.
// ----------------------------------------------------------------------------

/**
 * §2.2 `view:"list"` — terse cards, `sort:"priority"` over non-terminal items
 * by default. Absorbs BOTH `list-items` and `spotlight` (AC-5): the item set
 * is `list-items`', the ordering is `spotlight`'s.
 */
async function runListView(ctx: IQueryContext): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  const { rows, truncated } = await fetchRows(ctx.store, ctx.filter, ctx.warnings);
  const { page, meta } = paginateRows(sortRows(rows, ctx.sort, ctx.direction), ctx.limit, ctx.offset, truncated);
  return envelopeOf(ctx, { items: await buildCards(ctx.store, page, ctx.fields) }, meta);
}

/**
 * §2.2 `view:"ready"` — items claimable right now: non-terminal, unclaimed,
 * every dependency terminal.
 *
 * The readiness computation is `readyItems` (query.ts:545-557) verbatim — it
 * is the one place that walks `DEPENDS_ON` and tests each target's terminality
 * — and this layer intersects it with the caller's full filter. Composition,
 * not a second implementation: if readiness ever changes, it changes once.
 */
async function runReadyView(ctx: IQueryContext): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  const { rows, truncated } = await fetchRows(ctx.store, ctx.filter, ctx.warnings);
  const readySet = await readyKeySet(ctx.store, ctx.filter);
  const ready = rows.filter((r) => readySet.has(itemKey(r.item)));
  const { page, meta } = paginateRows(sortRows(ready, ctx.sort, ctx.direction), ctx.limit, ctx.offset, truncated);
  return envelopeOf(ctx, { items: await buildCards(ctx.store, page, ctx.fields) }, meta);
}

/** `(repo, humanId)` — the identity a `BacklogItem` is unique under (SPEC.md §3), so two repos' `BUG-001` never collide in a Set. */
function itemKey(item: BacklogItem): string {
  return `${item.repo}::${item.humanId}`;
}

/** Delegates to `readyItems` for the scope, as a lookup set the caller's filter can be intersected with. */
async function readyKeySet(store: GraphBacklogStore, filter: IBacklogFilter): Promise<Set<string>> {
  const scope: { repo?: string; projectPath?: string } = {};
  if (filter.repo !== undefined) scope.repo = filter.repo;
  if (filter.projectPath !== undefined) scope.projectPath = filter.projectPath;
  return new Set((await readyItemsOp(store, scope)).map(itemKey));
}

/**
 * §2.2 `view:"stale"` — claims older than the lease window. A READ (§6: not
 * an admin action). Delegates to `staleClaims`, whose `>=` boundary carries
 * its own fix (BUG-BACKLOG-STALE-CLAIMS-BOUNDARY-RACE-001), so AC-5's "the
 * same items stale-claims returns today" is true by construction.
 */
async function runStaleView(ctx: IQueryContext, staleAfterMinutes: number | undefined): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  if (staleAfterMinutes !== undefined && (typeof staleAfterMinutes !== 'number' || !Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 0)) {
    throw new BacklogValidationError(`staleAfterMinutes: must be a non-negative number (got ${JSON.stringify(staleAfterMinutes)})`, ['staleAfterMinutes']);
  }
  const maxAgeMin = staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
  const scope = scopeOf(ctx.filter);
  const items = await staleClaimsOp(ctx.store, maxAgeMin, scope);
  const now = Date.now();
  const entries: IStaleClaimEntry[] = items.map((it) => ({
    humanId: it.humanId,
    title: it.title,
    claimedBy: it.claimedBy ?? '',
    claimedAt: it.claimedAt ?? '',
    ageMinutes: it.claimedAt ? Math.floor((now - Date.parse(it.claimedAt)) / 60_000) : 0,
  }));
  // `IStaleClaimEntry` has a fixed shape, so paging it is still meaningful
  // even though projection is not (see `resolveFields`).
  const total = entries.length;
  const page = ctx.limit === undefined ? entries.slice(ctx.offset) : entries.slice(ctx.offset, ctx.offset + ctx.limit);
  const meta: IQueryEnvelopeMeta = { total, returned: page.length };
  if (ctx.limit !== undefined) meta.limit = ctx.limit;
  if (ctx.offset !== 0) meta.offset = ctx.offset;
  return envelopeOf(ctx, { stale: page }, meta);
}

/** The `StatsScope` the narrow store ops take. Only `repo`/`projectPath` reach them, which is exactly what `VIEW_FILTER_KEYS` permits for those views. */
function scopeOf(filter: IBacklogFilter): { repo?: string; projectPath?: string } {
  const scope: { repo?: string; projectPath?: string } = {};
  if (filter.repo !== undefined) scope.repo = filter.repo;
  if (filter.projectPath !== undefined) scope.projectPath = filter.projectPath;
  return scope;
}

/**
 * §2.2 `view:"order"` — the topological order, plus the wave numbers v1's
 * `topo-order` never returned.
 *
 * The ORDER is `topoOrder`'s, delegated unchanged (AC-5: "the same
 * topological order topo-order does today"), including its cycle report. The
 * waves are derived from the same `DEPENDS_ON` edges: an item's wave is one
 * past the deepest wave it depends on, so wave N is exactly "everything that
 * can run once waves 0..N-1 are done". A wave number is a DERIVED read, never
 * a stored dispatch decision — §5a.4 refuses to persist waves.
 */
async function runOrderView(ctx: IQueryContext): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  const scope = scopeOf(ctx.filter);
  const topo = await topoOrderOp(ctx.store, scope);
  if (!topo.ok) return envelopeOf(ctx, { order: { ok: false, cycle: topo.cycle } });

  const graph = await dependencyGraphOp(ctx.store, scope);
  const dependsOn = new Map<string, string[]>();
  for (const node of graph.nodes) dependsOn.set(node.humanId, []);
  for (const edge of graph.edges) {
    if (edge.rel !== 'DEPENDS_ON') continue;
    dependsOn.get(edge.from)?.push(edge.to);
  }
  const wave = new Map<string, number>();
  // `topo.order` is dependency-first, so every dependency's wave is already
  // known by the time its dependent is visited — one pass, no fixpoint.
  for (const humanId of topo.order) {
    const deps = dependsOn.get(humanId) ?? [];
    const deepest = deps.reduce((max, dep) => Math.max(max, wave.get(dep) ?? -1), -1);
    wave.set(humanId, deepest + 1);
  }
  return envelopeOf(ctx, { order: { ok: true, order: topo.order.map((humanId) => ({ humanId, wave: wave.get(humanId) ?? 0 })) } });
}

/** §2.2 `view:"graph"` — dependency/related/part-of edges, delegated verbatim to `dependencyGraph`. */
async function runGraphView(ctx: IQueryContext): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  return envelopeOf(ctx, { graph: await dependencyGraphOp(ctx.store, scopeOf(ctx.filter)) });
}

/**
 * §2.2 `view:"summary"` (FEAT-010) — the aggregate/export surface, and the
 * absorption of v1 `admin:stats` (§6: "how many X" is a read, not an admin
 * action).
 *
 * The statistics themselves are `computeStats`, delegated whole — including
 * BUG-023's open-scoped counts, its `assertOpenScopedStats` runtime guard,
 * the median/p90 time-to-resolution and time-in-status, the reopen rate, and
 * the REQUIRED `coverage` block that makes partial audit history visible
 * (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001). The window is
 * `filter.dateRange.updated`, defaulting to the last 30 days (AC-15).
 *
 * The one thing this layer adds is `transitionsByBucket`: FEAT-010's
 * "transition counts bucketed by period", which `computeStats` does not
 * produce. It is computed from the SAME audit events (`queryAuditEvents`) over
 * the SAME window, so a bucket total can never disagree with the coverage
 * block beside it.
 */
async function runSummaryView(ctx: IQueryContext, bucket: ISummaryBucket, format: 'json' | 'table'): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  if (!['hour', 'day', 'week', 'month'].includes(bucket)) {
    throw new InvalidArgumentError('bucket', `bucket: expected "hour" | "day" | "week" | "month", received ${JSON.stringify(bucket)}`);
  }
  const scope = scopeOf(ctx.filter);
  const statsScope = ctx.filter.dateRange === undefined ? scope : { ...scope, dateRange: ctx.filter.dateRange };
  const stats = await computeStats(ctx.store, statsScope);
  stats.transitionsByBucket = await transitionsByBucket(ctx.store, ctx.filter, stats.window ?? {}, bucket);
  const payload: Omit<IBacklogQueryResult, 'view' | 'query'> = { summary: stats };
  if (format === 'table') payload.table = renderSummaryTable(stats);
  return envelopeOf(ctx, payload);
}

/** FEAT-010 — transition events per period, over the SAME window `computeStats` reported. `AC-15`'s bound is honoured, not computed from all history. */
async function transitionsByBucket(
  store: GraphBacklogStore,
  filter: IBacklogFilter,
  window: { since?: string; until?: string },
  bucket: ISummaryBucket
): Promise<Array<{ bucket: string; count: number }>> {
  const nodes = await queryItemNodes(store, { repo: filter.repo, projectPath: filter.projectPath });
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const event of await queryAuditEvents(store, node.id)) {
      if (event.kind !== 'transition') continue;
      if (!withinBound(event.at, window)) continue;
      const key = bucketKey(event.at, bucket);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ bucket: key, count }));
}

/** Period key for a bucketed count. ISO prefixes for hour/day/month; ISO-8601 week (`YYYY-Www`) for week, so buckets sort lexicographically in chronological order. */
function bucketKey(at: string, bucket: ISummaryBucket): string {
  switch (bucket) {
    case 'hour':
      return at.slice(0, 13);
    case 'day':
      return at.slice(0, 10);
    case 'month':
      return at.slice(0, 7);
    case 'week': {
      const date = new Date(at);
      // ISO week: Thursday of the same week determines the week-numbering year.
      const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
      const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
      firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
      const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
      return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    default: {
      const never: never = bucket;
      throw new InvalidArgumentError('bucket', `bucket: unhandled bucket ${JSON.stringify(never)}`);
    }
  }
}

/**
 * §2.2 `view:"grouped"` (FEAT-007) — `groupBy`-keyed buckets.
 *
 * Counts-only by default: per-bucket item lists are opt-in via
 * `fields: ["items"]`, so a grouped query can never become a body dump
 * (§2.2/AC-20). Query-time bucketing only — §5a.4 refuses to persist
 * grouping, and the durable primitive is the parent/child rollup instead.
 *
 * Identity axes are canonicalised (AC-14): two runs of the same agent
 * (`researcher:a1`, `researcher:b2`) land in ONE `researcher` bucket, never
 * one bucket per process.
 */
async function runGroupedView(ctx: IQueryContext, groupByInput: IGroupByAxis | IGroupBy | undefined, format: 'json' | 'table'): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  const groupBy = normalizeGroupBy(groupByInput);
  if (!groupBy) throw new InvalidArgumentError('groupBy', 'groupBy: view:"grouped" requires an axis (INTERFACE_v2 §2.2)');
  const { rows } = await fetchRows(ctx.store, ctx.filter, ctx.warnings);
  const withItems = ctx.fields.has('items');
  const buckets = await bucketRows(ctx.store, rows, groupBy.primary, groupBy.secondary, withItems, ctx.fields);
  const grouped: IGroupedView = { groupBy, buckets };
  const payload: Omit<IBacklogQueryResult, 'view' | 'query'> = { grouped };
  if (format === 'table') payload.table = renderGroupedTable(grouped);
  return envelopeOf(ctx, payload);
}

/** The bucket key(s) one row contributes on an axis. `file` is multi-valued (an item touching 3 files is in 3 buckets); every other axis yields exactly one. */
function axisKeys(row: IQueryRow, axis: IGroupByAxis): string[] {
  const meta = v2Meta(row.node);
  switch (axis) {
    case 'kind':
      return [row.item.kind];
    case 'family':
      return [row.item.family];
    case 'priority':
      return [row.item.priority ?? NO_VALUE_BUCKET];
    case 'status':
      return [row.item.status];
    case 'projectPath':
      return [row.item.projectPath ?? NO_VALUE_BUCKET];
    case 'repo':
      return [row.item.repo];
    case 'plan':
      return [row.item.plan ?? NO_VALUE_BUCKET];
    case 'assignee':
      return [row.item.assignee ?? NO_VALUE_BUCKET];
    case 'author':
      return [meta.author === undefined ? NO_VALUE_BUCKET : canonicalIdentityKey(meta.author)];
    case 'reporter':
      return [meta.reporter === undefined ? NO_VALUE_BUCKET : canonicalIdentityKey(meta.reporter)];
    case 'project':
      return [meta.project ?? NO_VALUE_BUCKET];
    case 'packagePath':
      return [meta.packagePath ?? NO_VALUE_BUCKET];
    case 'file':
      // §2.2: a files-backed axis — "empty groups when items carry no
      // `files`". An item with no declared files contributes to NO bucket
      // (as opposed to a `(none)` bucket), because §5a.3's declared-file
      // axis is about overlap, and "no declared files" is not a shared unit.
      return [...(meta.files ?? [])];
    default: {
      const never: never = axis;
      throw new InvalidArgumentError('groupBy', `groupBy: unhandled axis ${JSON.stringify(never)}`);
    }
  }
}

/** The bucket an item with no value on the axis lands in. Named, not empty-string, so a caller can see the gap instead of guessing at a blank key. */
const NO_VALUE_BUCKET = '(none)';

/** Buckets rows on `primary`, optionally nesting a `secondary` rollup inside each bucket. Ordered by count desc, then key asc — deterministic across runs. */
async function bucketRows(
  store: GraphBacklogStore,
  rows: readonly IQueryRow[],
  primary: IGroupByAxis,
  secondary: IGroupByAxis | undefined,
  withItems: boolean,
  fields: ReadonlySet<IBacklogField>
): Promise<IGroupBucket[]> {
  const groups = new Map<string, IQueryRow[]>();
  for (const row of rows) {
    for (const key of axisKeys(row, primary)) {
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
  }
  const buckets: IGroupBucket[] = [];
  for (const [key, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const bucket: IGroupBucket = { key, count: members.length };
    if (secondary !== undefined) bucket.buckets = await bucketRows(store, members, secondary, undefined, withItems, fields);
    if (withItems) bucket.items = await buildCards(store, members, fields);
    buckets.push(bucket);
  }
  return buckets;
}

/**
 * §2.2 `view:"plan"` (FEAT-015) — the native resume surface.
 *
 * ONE call answers "where was I": the plan card, the §5a.1 two-axis rollup
 * over its members, the ready set, the blocked set WITH the dependency doing
 * the blocking, the audit delta since `filter.dateRange.updated.since`, the
 * needs-human set, the caller's own claims, and an `asOf` checkpoint token to
 * pass back as the next `since`. §5a.6 is explicit that if a plan cannot be
 * resumed from a single call, that is an interface defect — so nothing here
 * requires a second query or a hand-persisted ledger timestamp.
 *
 * Two parameter semantics are spec-mandated and worth stating, because both
 * look like ordinary filters and are not:
 * - `filter.claimedBy` does NOT narrow the member set. §5a.6/AC-16 define it
 *   as the selector for `myClaims` — the interrupted agent's own in-progress
 *   work, in the SAME envelope as the ready/blocked sets.
 * - `filter.dateRange.updated.since` does NOT narrow the member set either;
 *   it bounds the `delta`. The member set is always whole, because a rollup
 *   computed over a filtered subset would report a false `childrenClosed`.
 *
 * `asOf` is captured BEFORE the delta is read, never after: a token stamped
 * after the read would silently swallow any event that landed during it.
 */
async function runPlanView(ctx: IQueryContext, weightFn: IPathWeightFn | undefined, format: 'json' | 'table'): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  const planSlug = ctx.filter.plan;
  if (typeof planSlug !== 'string' || planSlug.trim().length === 0) {
    throw new InvalidArgumentError('filter', 'filter.plan: view:"plan" needs the plan slug to resume — pass `filter: { plan: "<slug>" }` (INTERFACE_v2 §2.2)');
  }
  if (weightFn !== undefined && weightFn !== 'count' && weightFn !== 'priority') {
    throw new InvalidArgumentError('weightFn', `weightFn: expected "count" or "priority", received ${JSON.stringify(weightFn)} (INTERFACE_v2 §5a.8)`);
  }
  const asOf = new Date().toISOString();

  // Members: the whole plan, every status (§5a.1 needs both axes).
  const memberFilter: IBacklogFilter = { plan: planSlug, status: 'all' };
  if (ctx.filter.repo !== undefined) memberFilter.repo = ctx.filter.repo;
  if (ctx.filter.projectPath !== undefined) memberFilter.projectPath = ctx.filter.projectPath;
  const { rows: members } = await fetchRows(ctx.store, memberFilter, ctx.warnings);
  // The plan's own `DEPENDS_ON` subgraph, read ONCE: both the readiness
  // cycle check and the critical path are traversals of the same edges, and
  // walking the store twice would let the two disagree.
  const deps = await memberDependencies(ctx.store, members);

  // §5a.5 — "the plan parent itself is an item", addressed by the slug.
  const parent = members.find((m) => m.item.humanId === planSlug) ?? (await findPlanParent(ctx.store, planSlug, ctx.filter.repo));
  const rollup = rollupOver(
    members.filter((m) => m.item.humanId !== planSlug),
    parent
  );

  const readySet = await readyKeySet(ctx.store, scopeOf(ctx.filter));
  const ready: IQueryRow[] = [];
  const blocked: Array<{ row: IQueryRow; blockedBy: string[] }> = [];
  const needsHuman: IQueryRow[] = [];
  for (const member of members) {
    if (isTerminalStatus(member.item.status)) continue;
    const openBlockers = (await blockersOp(ctx.store, member.item.repo, member.item.humanId)).map((b) => b.humanId);
    if (openBlockers.length > 0) {
      blocked.push({ row: member, blockedBy: openBlockers });
      continue;
    }
    if (readySet.has(itemKey(member.item))) ready.push(member);
    // §9 Q11 — "needs human" is derived from existing state: non-terminal,
    // unclaimed, blocked on nothing external, i.e. waiting on input from
    // outside the graph. In THIS build that predicate coincides with the
    // ready set; it diverges the moment EPIC-B adds `awaiting_input` /
    // `open_question`, which become ADDITIONAL members. It is computed
    // independently (not aliased to `ready`) so that divergence is a one-line
    // change here rather than a re-derivation.
    if (member.item.claimedBy === undefined) needsHuman.push(member);
  }

  const since = ctx.filter.dateRange?.updated?.since;
  const delta = await planDelta(ctx.store, members, since);
  const myClaims = ctx.filter.claimedBy === undefined ? [] : members.filter((m) => m.item.claimedBy === ctx.filter.claimedBy);

  const plan: IPlanView = {
    plan: planSlug,
    rollup,
    ready: await buildCards(ctx.store, ready, ctx.fields),
    blocked: await Promise.all(blocked.map(async (b) => ({ item: await buildCard(ctx.store, b.row, ctx.fields), blockedBy: b.blockedBy }))),
    delta,
    needsHuman: await buildCards(ctx.store, needsHuman, ctx.fields),
    myClaims: await buildCards(ctx.store, myClaims, ctx.fields),
    asOf,
  };
  if (parent) plan.card = await buildCard(ctx.store, parent, ctx.fields);

  const payload: Omit<IBacklogQueryResult, 'view' | 'query'> = { plan, readiness: planReadiness(planSlug, members, ready, blocked, deps) };
  if (weightFn !== undefined) payload.criticalPath = criticalPath(planSlug, members, deps, weightFn);
  if (format === 'table') payload.table = renderPlanTable(plan, payload.readiness as IPlanReadinessResult);
  return envelopeOf(ctx, payload);
}

/** The plan parent as an item, when it lives outside the member set (a parent that is not itself attached to its own plan slug). */
async function findPlanParent(store: GraphBacklogStore, planSlug: string, repo: string | undefined): Promise<IQueryRow | undefined> {
  const nodes = await queryItemNodes(store, repo === undefined ? {} : { repo });
  const node = nodes.find((n) => (n.metadata as Partial<BacklogNodeMeta> | undefined)?.humanId === planSlug);
  return node === undefined ? undefined : { node, item: toBacklogItem(node) };
}

/** AC-16 — the audit events after the caller's checkpoint. With no `since`, the plan's whole history: a first resume has no prior checkpoint to be relative to. */
async function planDelta(store: GraphBacklogStore, members: readonly IQueryRow[], since: string | undefined): Promise<AuditTrailEntry[]> {
  const delta: AuditTrailEntry[] = [];
  for (const member of members) {
    for (const event of await queryAuditEvents(store, member.node.id)) {
      if (since !== undefined && event.at <= since) continue;
      delta.push({ ...event, detail: { ...event.detail, humanId: member.item.humanId } });
    }
  }
  return delta.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The plan's internal `DEPENDS_ON` adjacency (`humanId` -> the members it
 * depends on). Edges leaving the plan are dropped: a plan's critical path and
 * its internal cycles are properties OF the plan, and an external dependency
 * is reported by the blocked set instead.
 */
async function memberDependencies(store: GraphBacklogStore, members: readonly IQueryRow[]): Promise<Map<string, string[]>> {
  const byId = new Set(members.map((m) => m.item.humanId));
  const deps = new Map<string, string[]>();
  for (const member of members) {
    const targets: string[] = [];
    for (const edge of await store.graph.getEdges({ src: member.node.id, rel: 'DEPENDS_ON' })) {
      const dst = await store.graph.getNode(edge.dst);
      if (!dst || dst.tInvalid) continue;
      const humanId = (dst.metadata as Partial<BacklogNodeMeta> | undefined)?.humanId;
      if (humanId !== undefined && byId.has(humanId)) targets.push(humanId);
    }
    deps.set(member.item.humanId, targets);
  }
  return deps;
}

/**
 * §5a.8 — `planReadiness`, with the pinned output shape. Pure composition
 * over the member/ready/blocked sets the plan view already has, plus a real
 * Kahn pass over the plan's own edges for `hasCycle` — a plan whose members
 * deadlock each other must SAY so, not report `false` because nobody looked.
 */
function planReadiness(
  planSlug: string,
  members: readonly IQueryRow[],
  ready: readonly IQueryRow[],
  blocked: readonly { row: IQueryRow }[],
  deps: ReadonlyMap<string, string[]>
): IPlanReadinessResult {
  const doneCount = members.filter((m) => isTerminalStatus(m.item.status)).length;
  const result: IPlanReadinessResult = {
    planSlug,
    totalCount: members.length,
    doneCount,
    readyCount: ready.length,
    blockedCount: blocked.length,
    hasCycle: hasDependencyCycle(deps),
    percentComplete: members.length === 0 ? 0 : Math.round((doneCount / members.length) * 100),
  };
  const next = ready[0];
  if (next) result.nextRecommended = next.item.humanId;
  return result;
}

/** Kahn over the plan's internal adjacency — anything left unemitted is in (or behind) a cycle. Mirrors `topoOrder`'s own detection (query.ts:588-611). */
function hasDependencyCycle(deps: ReadonlyMap<string, string[]>): boolean {
  const remaining = new Set(deps.keys());
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const humanId of [...remaining]) {
      if ((deps.get(humanId) ?? []).every((dep) => !remaining.has(dep))) {
        remaining.delete(humanId);
        progressed = true;
      }
    }
  }
  return remaining.size > 0;
}

/**
 * §5a.8 — `criticalPath`: the weighted longest path through `DEPENDS_ON`
 * within the plan.
 *
 * `weightFn:"count"` weights every item 1 (the longest chain); `"priority"`
 * weights by urgency (CRITICAL 4 … LOW 1, unprioritised 0), so the critical
 * chain is the most-urgent dependency spine rather than merely the longest.
 * Pure graph traversal — no embedding dependency, so it ships ahead of
 * EPIC-G (RAG-SPEC §5, Phase 3).
 */
function criticalPath(planSlug: string, members: readonly IQueryRow[], deps: ReadonlyMap<string, string[]>, weightFn: IPathWeightFn): ICriticalPathResult {
  const byId = new Map(members.map((m) => [m.item.humanId, m]));

  const weightOf = (humanId: string): number => {
    if (weightFn === 'count') return 1;
    const priority = byId.get(humanId)?.item.priority;
    return priority === undefined ? 0 : 4 - (PRIORITY_RANK[priority] ?? 4);
  };

  // Memoised longest-path-to-here. `visiting` makes a cycle terminate with a
  // finite answer instead of blowing the stack — `view:"order"` is the
  // surface that REPORTS cycles; this one must not hang on them.
  const best = new Map<string, { weight: number; chain: string[] }>();
  const visiting = new Set<string>();
  const walk = (humanId: string): { weight: number; chain: string[] } => {
    const cached = best.get(humanId);
    if (cached) return cached;
    if (visiting.has(humanId)) return { weight: 0, chain: [] };
    visiting.add(humanId);
    let bestDep: { weight: number; chain: string[] } = { weight: 0, chain: [] };
    for (const dep of deps.get(humanId) ?? []) {
      const candidate = walk(dep);
      if (candidate.weight > bestDep.weight) bestDep = candidate;
    }
    visiting.delete(humanId);
    const result = { weight: bestDep.weight + weightOf(humanId), chain: [...bestDep.chain, humanId] };
    best.set(humanId, result);
    return result;
  };

  let winner: { weight: number; chain: string[] } = { weight: 0, chain: [] };
  for (const member of [...members].sort((a, b) => a.item.humanId.localeCompare(b.item.humanId))) {
    const candidate = walk(member.item.humanId);
    if (candidate.weight > winner.weight) winner = candidate;
  }
  return { plan: planSlug, criticalChain: winner.chain, length: winner.weight, endItem: winner.chain[winner.chain.length - 1] ?? '' };
}

/**
 * §5a.3 / AC-28 `view:"overlap"` (FEAT-005 Stage 3) — pairwise intersections
 * over an explicit id set.
 *
 * An INPUT to wave selection, never a scheduler: this reports DECLARED
 * overlap and nothing else. It never reads the filesystem and never chooses a
 * wave (§5a.4 refuses to model waves at all).
 *
 * The axis is `overlapBy`, never `by` — §5a.3 reserves `by` for the actor
 * identity on mutations, and the two must not share a name in one tool
 * family. Only pairs with a NON-EMPTY intersection are returned: a pair that
 * shares nothing is not an overlap, and emitting O(n²) empty pairs would bury
 * the collisions the caller asked about.
 */
async function runOverlapView(ctx: IQueryContext, humanIdsRaw: unknown, overlapBy: IOverlapAxis): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  if (!['file', 'project', 'package', 'author'].includes(overlapBy)) {
    throw new InvalidArgumentError('overlapBy', `overlapBy: expected "file" | "project" | "package" | "author", received ${JSON.stringify(overlapBy)} (INTERFACE_v2 §5a.3)`);
  }
  if (!Array.isArray(humanIdsRaw) || humanIdsRaw.length === 0 || humanIdsRaw.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new InvalidArgumentError('humanIds', 'humanIds: view:"overlap" needs a non-empty array of humanIds to intersect (INTERFACE_v2 §2.2)');
  }
  const humanIds = humanIdsRaw as string[];
  const { rows } = await fetchRows(ctx.store, { ...scopeOf(ctx.filter), status: 'all' }, ctx.warnings);
  const byId = new Map(rows.map((r) => [r.item.humanId, r]));

  const missing = humanIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    // A silently-dropped id would report "no collision" for a pair that was
    // never compared — the worst possible answer for a wave-collision check.
    throw new InvalidArgumentError('humanIds', `humanIds: ${missing.map((id) => `"${id}"`).join(', ')} not found in this scope — an id that cannot be compared must not be reported as non-overlapping`);
  }

  const units = new Map<string, Set<string>>();
  for (const id of humanIds) units.set(id, new Set(overlapUnits(byId.get(id) as IQueryRow, overlapBy)));

  const pairs: IOverlapPair[] = [];
  for (let i = 0; i < humanIds.length; i += 1) {
    for (let j = i + 1; j < humanIds.length; j += 1) {
      const a = humanIds[i] as string;
      const b = humanIds[j] as string;
      const shared = [...(units.get(a) as Set<string>)].filter((unit) => (units.get(b) as Set<string>).has(unit)).sort();
      if (shared.length > 0) pairs.push({ a, b, shared });
    }
  }
  return envelopeOf(ctx, { overlap: { axis: overlapBy, pairs } as IOverlapView });
}

/** §5a.3 — the shared units an item declares on an axis. Metadata-backed until EPIC-A turns these into edges; an item declaring nothing simply shares nothing. */
function overlapUnits(row: IQueryRow, axis: IOverlapAxis): string[] {
  const meta = v2Meta(row.node);
  switch (axis) {
    case 'file':
      return meta.files ?? [];
    case 'project':
      return meta.project === undefined ? [] : [meta.project];
    case 'package':
      return meta.packagePath === undefined ? [] : [meta.packagePath];
    case 'author':
      return meta.author === undefined ? [] : [canonicalIdentityKey(meta.author)];
    default: {
      const never: never = axis;
      throw new InvalidArgumentError('overlapBy', `overlapBy: unhandled axis ${JSON.stringify(never)}`);
    }
  }
}

// ----------------------------------------------------------------------------
// §2.1b — the natural-language query planner.
// ----------------------------------------------------------------------------

/**
 * §2.1b / AC-27 — compiles `text` (the CLI's positional form) into a query.
 *
 * The contract this implements is "semantic search first, planner refinement
 * second", and the three rules that make it that rather than a string-shredder:
 *
 * 1. **The ENTIRE string is the query.** `plan.semantic` always carries the
 *    whole input, never a remainder after extraction. With an embedding
 *    backend it routes to the matcher; without one — this build — it falls
 *    back to FTS via `filter.grep`, which §2.1b step 1 names explicitly ("the
 *    planner never requires EPIC-G to function"). `plan.filter` reports what
 *    ACTUALLY ran, so the fallback is visible rather than implied.
 * 2. **Unscoped by default — cross-repo recall is the contract.** Dimensional
 *    extraction NEVER narrows recall. A term recognised as a repo, kind,
 *    status or plan slug becomes a `boost` and a surfaced suggestion, never a
 *    filter: AC-27's own worked example ("nx bugs and apigen") pins
 *    `filter: {}` even though "bugs" is a kind word. The only way to scope is
 *    to say so with an explicit flag.
 * 3. **Time expressions are the ONE exception**, because §2.1b step 4 makes
 *    them a filter by name — and they are still surfaced in `extracted` with
 *    `applied: "filter"`, so nothing is silent either way.
 */
async function compileTextQuery(
  store: GraphBacklogStore,
  text: string,
  filter: IBacklogFilter,
  requestedSort: IBacklogSort | undefined
): Promise<{ filter: IBacklogFilter; plan: IQueryPlan; warnings: string[] }> {
  if (text.trim().length === 0) {
    throw new InvalidArgumentError('text', 'text: the natural-language query must not be empty (INTERFACE_v2 §2.1b)');
  }
  if (filter.grep !== undefined) {
    // Without embeddings the text query IS the grep query; accepting both
    // would silently drop one of two keyword predicates the caller believes
    // are both running.
    throw new InvalidArgumentError(
      'text',
      'text: cannot be combined with filter.grep — without an embedding backend the natural-language form compiles INTO filter.grep (INTERFACE_v2 §2.1b step 1). Pass one or the other.'
    );
  }

  const warnings: string[] = [];
  const extracted: IExtractedTerm[] = [];
  const compiled: IBacklogFilter = { ...filter, grep: text };

  const repos = await knownRepos(store);
  const repoBare = new Map<string, string>();
  for (const repo of repos) {
    try {
      repoBare.set(parseRepoKey(repo).bare.toLowerCase(), repo);
    } catch {
      continue;
    }
  }
  const nodes = await queryItemNodes(store, {});
  const kinds = new Set<string>();
  const plans = new Set<string>();
  for (const node of nodes) {
    const meta = node.metadata as Partial<BacklogNodeMeta> | undefined;
    if (meta?.kind) kinds.add(meta.kind.toLowerCase());
    if (meta?.plan) plans.add(meta.plan.toLowerCase());
  }
  const statuses = new Set<string>([...BACKLOG_STATUSES.map((s) => s.toLowerCase()), 'open', 'closed']);

  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 0);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    // A token can legitimately look like more than one dimension (a repo
    // named "bug", a plan slug named after a package). Every match is
    // surfaced, and the collision itself becomes a warning — §2.1b step 6:
    // "ambiguous extractions surface in warnings — never silent".
    const matches: IExtractedTerm['type'][] = [];
    const singular = token.replace(/s$/, '');
    if (repoBare.has(token)) matches.push('repo');
    if (kinds.has(token) || kinds.has(singular)) matches.push('kind');
    if (statuses.has(token)) matches.push('status');
    if (plans.has(token)) matches.push('plan');
    for (const type of matches) {
      extracted.push({ term: token, type, confidence: matches.length === 1 ? 0.9 : 0.5, applied: 'boost' });
    }
    if (matches.length > 1) {
      warnings.push(`text: "${token}" matched more than one dimension (${matches.join(', ')}) — it was applied as a ranking boost only, never as a filter (INTERFACE_v2 §2.1b)`);
    }
  }

  const since = extractTimeExpression(text);
  if (since) {
    compiled.dateRange = { ...(compiled.dateRange ?? {}), updated: { ...(compiled.dateRange?.updated ?? {}), since: since.iso } };
    extracted.push({ term: since.term, type: 'time', confidence: 0.95, applied: 'filter' });
  }

  const plan: IQueryPlan = {
    semantic: text,
    filter: compiled,
    boosts: extracted.filter((e) => e.applied === 'boost'),
    extracted,
    // §2.1b step 5: `relevance` when embeddings are configured, `priority` as
    // the FTS fallback. This build has no matcher, so the fallback is the
    // truth — and an explicit `sort:"relevance"` is rejected by
    // `assertNoSemanticInputs` rather than silently downgraded to this.
    sort: requestedSort ?? 'priority',
  };
  return { filter: compiled, plan, warnings };
}

/** §2.1a/§2.1b — the natural-language date vocabulary, resolved to ISO server-side (`today`, `yesterday`, `N days ago`/`Nd`, `last week`). */
function extractTimeExpression(text: string): { term: string; iso: string } | undefined {
  const lower = text.toLowerCase();
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const daysAgo = (n: number): string => new Date(startOfToday.getTime() - n * 24 * 3600 * 1000).toISOString();

  if (/\blast week\b/.test(lower)) return { term: 'last week', iso: daysAgo(7) };
  if (/\byesterday\b/.test(lower)) return { term: 'yesterday', iso: daysAgo(1) };
  if (/\btoday\b/.test(lower)) return { term: 'today', iso: daysAgo(0) };
  const explicit = /\b(\d+)\s*(?:d\b|days? ago\b)/.exec(lower);
  if (explicit && explicit[1]) return { term: explicit[0].trim(), iso: daysAgo(Number(explicit[1])) };
  return undefined;
}

// ----------------------------------------------------------------------------
// §7.3 — `format: "table"`. A rendering OF the payload, never a replacement.
// ----------------------------------------------------------------------------

/** Renders aligned columns. Deliberately dependency-free: this is a two-column-ish report, not a layout engine. */
function renderRows(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** §7.3 — `view:"summary"` for humans. */
function renderSummaryTable(stats: IBacklogStats): string {
  const status = renderRows(
    ['STATUS', 'COUNT'],
    Object.entries(stats.byStatus)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => [key, String(count)])
  );
  const totals = renderRows(
    ['METRIC', 'VALUE'],
    [
      ['total', String(stats.total)],
      ['open', String(stats.open)],
      ['closed', String(stats.closed)],
      ['window.since', stats.window?.since ?? '(none)'],
      ['coverage.itemsWithHistory', `${stats.coverage.itemsWithHistory}/${stats.coverage.itemsTotal}`],
      ['timeToResolution.medianMs', String(stats.timeToResolution?.medianMs ?? '(n/a)')],
      ['reopenRate', String(stats.reopenRate ?? '(n/a)')],
    ]
  );
  return `${totals}\n\n${status}`;
}

/** §7.3 — `view:"grouped"` for humans. Nested buckets are indented under their parent key rather than flattened into an ambiguous single column. */
function renderGroupedTable(grouped: IGroupedView): string {
  const rows: string[][] = [];
  for (const bucket of grouped.buckets) {
    rows.push([bucket.key, String(bucket.count)]);
    for (const nested of bucket.buckets ?? []) rows.push([`  └ ${nested.key}`, String(nested.count)]);
  }
  return renderRows([grouped.groupBy.primary.toUpperCase(), 'COUNT'], rows);
}

/** §7.3 — `view:"plan"` for humans: the resume card, then the actionable sets. */
function renderPlanTable(plan: IPlanView, readiness: IPlanReadinessResult): string {
  const summary = renderRows(
    ['METRIC', 'VALUE'],
    [
      ['plan', plan.plan],
      ['children', `${plan.rollup.childrenClosed}/${plan.rollup.childrenTotal} closed`],
      ['selfVerified', String(plan.rollup.selfVerified)],
      ['percentComplete', `${readiness.percentComplete}%`],
      ['ready', String(plan.ready.length)],
      ['blocked', String(plan.blocked.length)],
      ['needsHuman', String(plan.needsHuman.length)],
      ['myClaims', String(plan.myClaims.length)],
      ['delta events', String(plan.delta.length)],
      ['asOf', plan.asOf],
    ]
  );
  const sets = renderRows(
    ['SET', 'ITEM', 'DETAIL'],
    [
      ...plan.ready.map((c) => ['ready', c.humanId, c.title]),
      ...plan.blocked.map((b) => ['blocked', b.item.humanId, `blocked by ${b.blockedBy.join(', ')}`]),
      ...plan.needsHuman.map((c) => ['needsHuman', c.humanId, c.title]),
      ...plan.myClaims.map((c) => ['myClaims', c.humanId, c.title]),
    ]
  );
  return `${summary}\n\n${sets}`;
}
