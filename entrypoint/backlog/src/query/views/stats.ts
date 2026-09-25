/**
 * stats.ts — the stats/rollup read views (SPEC.md §5):
 *
 * - **The status-aware priority matrix** (`priorityMatrix`, BUG-023): a
 *   per-priority breakdown of issue counts. SPEC.md §5's own words: "the
 *   priority matrix counts non-terminal (open) items by default; closed
 *   items only under an explicit terminal filter." This is a DELIBERATE
 *   divergence from `query`'s own `list` view, where an omitted
 *   `filter.status` means "no restriction" (every status) — for THIS view,
 *   an omitted `filter.status` means `'open'`. BUG-023's original defect
 *   (`model.ts:1855-1858`, `assertOpenScopedStats`) was a closed item
 *   silently inflating an "open work" count because the open-scoped map was
 *   wired to the all-status array; here that can't happen because there is
 *   only ONE count per row, and its scope is named on the result
 *   (`statusScope`) rather than left for the caller to assume.
 *
 * - **The `part_of` hierarchy rollup** (`partOfRollup`, FEAT-005): every
 *   TRANSITIVE descendant of a root issue via `part_of` (issue → issue,
 *   `n:1` — SPEC.md §3), not just direct children. Built on
 *   `GraphBackend.getSubgraph` (SPEC.md §5's own named primitive,
 *   "`getSubgraph`/`getNeighbors`") with `depth: -1` (genuinely unbounded —
 *   verified against `@adhd/sox-graph-store`'s own dist comment: `getNeighbors`'s
 *   `depth` is a ROW BUDGET, not a walk-depth bound, so `getSubgraph`'s
 *   `-1` sentinel is the only primitive that gives an unbounded, correct
 *   multi-level walk) and a library-internal visited set (cycle-safe,
 *   dedup-safe) — this is what makes "a chain more than one level deep"
 *   count exactly once: a grandchild reached only via its parent is
 *   collected into the SAME node set as a direct child, never summed twice
 *   by naively adding up each child's own subtree size on top of a second,
 *   overlapping direct-children count.
 *
 * - **`validAt` point-in-time curves** (`openCurve`, "cumulative-open
 *   curves"): for a caller-given list of instants, how many in-scope issues
 *   EXISTED at each instant (`NodeFilter.validAt` — SPEC.md §5's own named
 *   primitive) and, of those, how many were OPEN (non-terminal) at that same
 *   instant. Existence is exact (the library's own bi-temporal `t_valid`/
 *   `t_invalid` columns). Openness is RECONSTRUCTED from the issue's own
 *   audit trail (`audits` edges, §3/§4a) — see {@link reconstructStatusAt}'s
 *   own doc comment for the reconstruction rule and its one stated
 *   limitation, in the same spirit as `query.ts`'s `sortByPriorityRank` and
 *   SPEC.md §8.1's `closedAt` reconstruction: approximated and NAMED as an
 *   approximation, never silently presented as exact.
 *
 * All three views are read-only (no transaction) and share the SAME
 * project/component/kind edge-scoping rules `query.ts`'s `list` view uses
 * (SPEC.md §6.5 rule 3) — reimplemented locally in this file rather than
 * imported, because `query.ts` does not export its internal
 * `resolveEdgeScopedFilterIds`/`resolveOpenClosedCandidates`/
 * `resolveMultiValuedEdgeScoped` helpers (by design — see that file's own
 * doc comment: it is the frozen `query`-verb composition, not a shared
 * library), and because this module's default `status` handling for
 * `priorityMatrix` genuinely differs from `list`'s (the BUG-023 divergence
 * above) — sharing one function with two different defaults would be worse
 * than two small, separately-documented ones.
 */

import type {
  GraphBackend,
  NodeFilter,
  NodeRecord,
} from '@adhd/sox-graph-store';
import { InvalidArgumentError } from '../../write/errors.js';
import { isStatusTerminal } from '../card.js';
import {
  resolveIssueByUid,
  tryResolveComponentRef,
  tryResolveRef,
} from '../resolve.js';
import type { IIssueAuditEntry, IIssueFilter } from '../types.js';
import type { IQueryStoreHandle } from '../query.js';

// ---------------------------------------------------------------------------
// Shared scoping helpers (project / component / kind — the dimensions every
// view below composes with; `status` is handled per-view, since its default
// genuinely differs between them).
// ---------------------------------------------------------------------------

/** The `IIssueFilter` keys every view in this file understands. Anything else is rejected by name (never silently ignored — this repo's own "never accept-and-ignore an input key" convention). */
type IScopeFilterKey = 'project' | 'component' | 'kind' | 'status';

const SCOPE_FILTER_KEYS: readonly IScopeFilterKey[] = [
  'project',
  'component',
  'kind',
  'status',
];

/** Every `IIssueFilter` key NOT in {@link SCOPE_FILTER_KEYS} — used to build each view's own rejected-key set below without repeating the literal list. */
const ALL_FILTER_KEYS: readonly (keyof IIssueFilter)[] = [
  'project',
  'component',
  'kind',
  'status',
  'priority',
  'assignee',
  'claimedBy',
  'author',
  'grep',
  'semantic',
  'anchor',
  'closedAt',
  'createdAt',
  'updatedAt',
];

/** Throws `InvalidArgumentError` naming the first key in `filter` that isn't in `allowed` — never a silent drop. */
function assertOnlyAllowedFilterKeys(
  filter: IIssueFilter | undefined,
  allowed: ReadonlySet<string>,
  viewName: string
): void {
  if (!filter) return;
  for (const key of ALL_FILTER_KEYS) {
    if (filter[key] !== undefined && !allowed.has(key)) {
      throw new InvalidArgumentError(
        `filter.${key}`,
        `not supported by ${viewName} — this view scopes by ${[...allowed].join(
          '/'
        )} only`
      );
    }
  }
}

/** Union the incoming-edge `src` sets for every resolved target of a multi-valued edge-scoped filter value (mirrors `query.ts`'s own helper of the same shape — not importable, see this file's own doc comment). */
async function unionEdgeScoped(
  graph: GraphBackend,
  input: { rel: string; expectedKind: string; refs: readonly string[] }
): Promise<Set<number>> {
  const union = new Set<number>();
  for (const ref of input.refs) {
    const resolved = await tryResolveRef(graph, input.expectedKind, ref);
    if (!resolved) continue; // unresolved name/uid ⇒ contributes nothing, never an error on a read path (§6.1)
    const edges = await graph.getEdges({ dst: resolved.id, rel: input.rel });
    for (const e of edges) union.add(e.src);
  }
  return union;
}

/** `status: 'open' | 'closed'` — scans the `status` catalog for `terminal`, unions `has_status` edges into every matching row (mirrors `query.ts`'s `resolveOpenClosedCandidates`). */
async function unionOpenClosed(
  graph: GraphBackend,
  want: 'open' | 'closed'
): Promise<Set<number>> {
  const statuses = await graph.queryNodes({ kind: 'status', liveOnly: true });
  const matching = statuses.filter(
    (s) => isStatusTerminal(s) === (want === 'closed')
  );
  const union = new Set<number>();
  for (const s of matching) {
    const edges = await graph.getEdges({ dst: s.id, rel: 'has_status' });
    for (const e of edges) union.add(e.src);
  }
  return union;
}

function intersect(sets: ReadonlyArray<Set<number>>): Set<number> | undefined {
  if (sets.length === 0) return undefined;
  let [acc] = sets;
  for (const s of sets.slice(1)) {
    const next = new Set<number>();
    for (const id of acc) if (s.has(id)) next.add(id);
    acc = next;
  }
  return acc;
}

/**
 * Resolves `filter.project`/`filter.component`/`filter.kind` to a candidate
 * issue-rowid set (AND semantics across dimensions, OR within a multi-valued
 * `kind` — SPEC.md §6.5 rule 3). Returns `undefined` when neither dimension
 * was given (no restriction); an EMPTY set when a given `project`/`component`
 * name failed to resolve (§6.1: an unresolved name is zero matches, never an
 * error) — callers must check `.size === 0` and short-circuit to an empty
 * result, exactly as `query.ts`'s own `queryList` does.
 */
async function resolvePlacementScope(
  graph: GraphBackend,
  filter: IIssueFilter | undefined
): Promise<Set<number> | undefined> {
  if (!filter) return undefined;
  const perDimension: Array<Set<number>> = [];
  let projectUid: string | undefined;

  if (filter.project !== undefined) {
    const project = await tryResolveRef(graph, 'project', filter.project);
    if (!project) return new Set();
    projectUid = project.uid;
    const ownedComponents = await graph.getEdges({
      src: project.id,
      rel: 'owns_project',
    });
    const union = new Set<number>();
    for (const compEdge of ownedComponents) {
      const issueEdges = await graph.getEdges({
        src: compEdge.dst,
        rel: 'owns_component',
      });
      for (const e of issueEdges) union.add(e.dst);
    }
    perDimension.push(union);
  }

  if (filter.component !== undefined) {
    const component =
      projectUid !== undefined
        ? await tryResolveComponentRef(graph, projectUid, filter.component)
        : await tryResolveRef(graph, 'component', filter.component);
    if (!component) return new Set();
    const edges = await graph.getEdges({
      src: component.id,
      rel: 'owns_component',
    });
    perDimension.push(new Set(edges.map((e) => e.dst)));
  }

  if (filter.kind !== undefined) {
    const refs = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    perDimension.push(
      await unionEdgeScoped(graph, {
        rel: 'has_kind',
        expectedKind: 'kind',
        refs,
      })
    );
  }

  return intersect(perDimension);
}

// ---------------------------------------------------------------------------
// priorityMatrix — the status-aware priority breakdown (BUG-023).
// ---------------------------------------------------------------------------

export interface IPriorityMatrixRow {
  priority: string;
  priorityUid: string;
  /** `priority.meta.metadata.rank` (`nextPriorityRankTx`, §2) — lower is more urgent. Absent only for a malformed pre-existing row with no numeric rank; the count itself is still real. */
  rank?: number;
  count: number;
}

export interface IPriorityMatrixResult {
  /** Sorted by `rank` ascending (a missing rank sorts last), mirroring `query.ts`'s own `sortByPriorityRank` convention. */
  rows: IPriorityMatrixRow[];
  /** In-scope issues carrying no live `has_priority` edge at all — never silently folded into a phantom priority row, never silently dropped from the total. */
  unassigned: number;
  /** The status scope actually applied. `'open'` when `filter?.status` was omitted (BUG-023's fix) — echoed here so a caller can never mistake a default-scoped result for an all-status one. */
  statusScope: NonNullable<IIssueFilter['status']>;
}

export interface IPriorityMatrixInput {
  /** `project`/`component`/`kind`/`status` only (§6.5 rule 3's edge-scoped dimensions, restricted to what a priority breakdown composes with) — any other key throws. */
  filter?: IIssueFilter;
}

const PRIORITY_MATRIX_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'project',
  'component',
  'kind',
  'status',
]);

/** `priorityMatrix`'s own status-scope resolution — `undefined` defaults to `'open'` (the BUG-023 divergence from `list`'s "no restriction" default), everything else composes exactly like `query.ts`'s own status handling. Returns `undefined` only for the explicit `'all'` scope (no restriction). */
async function resolvePriorityMatrixStatusScope(
  graph: GraphBackend,
  status: IIssueFilter['status']
): Promise<{
  candidates: Set<number> | undefined;
  scope: NonNullable<IIssueFilter['status']>;
}> {
  const scope = status ?? 'open';
  if (scope === 'all') return { candidates: undefined, scope };
  if (scope === 'open' || scope === 'closed')
    return { candidates: await unionOpenClosed(graph, scope), scope };
  const refs = Array.isArray(scope) ? scope : [scope];
  return {
    candidates: await unionEdgeScoped(graph, {
      rel: 'has_status',
      expectedKind: 'status',
      refs,
    }),
    scope,
  };
}

/** SPEC.md §5's status-aware priority matrix (BUG-023). */
export async function priorityMatrix(
  handle: IQueryStoreHandle,
  input: IPriorityMatrixInput = {}
): Promise<IPriorityMatrixResult> {
  const { graph } = handle;
  assertOnlyAllowedFilterKeys(
    input.filter,
    PRIORITY_MATRIX_ALLOWED_KEYS,
    'priorityMatrix'
  );

  const placementScope = await resolvePlacementScope(graph, input.filter);
  if (placementScope?.size === 0) {
    return {
      rows: [],
      unassigned: 0,
      statusScope: input.filter?.status ?? 'open',
    };
  }

  const { candidates: statusScoped, scope: statusScope } =
    await resolvePriorityMatrixStatusScope(graph, input.filter?.status);
  const rawScoped = intersect(
    [placementScope, statusScoped].filter(
      (s): s is Set<number> => s !== undefined
    )
  );
  if (rawScoped?.size === 0)
    return { rows: [], unassigned: 0, statusScope };

  // `placementScope`/`statusScoped` are both derived purely from EDGE
  // existence (`owns_component`/`has_kind`/`has_status`), never from the
  // candidate issue node's own liveness — and `deleteIssue` (write/delete.ts)
  // invalidates ONLY the issue's node row, never its edges, so a soft-deleted
  // issue's edges stay live forever. `query.ts`'s own `list` view never hits
  // this trap because it always ends in one more `queryNodes({kind:'issue',
  // ids:[...candidateIds]})` call, whose `liveOnly` default (true) is what
  // actually filters a deleted issue out. Reproduce that exact final step
  // here — never trust an edge-derived id as "a live issue" on its own — so a
  // deleted issue is "neither open work nor closed work, it is gone" (the
  // same principle `partOfRollup` above already applies via `!n.tInvalid`).
  const scoped = new Set(
    (
      await graph.queryNodes({
        kind: 'issue',
        liveOnly: true,
        // Current rows only — see `queryList`'s `baseFilter` (query.ts).
        isSuperseded: false,
        ...(rawScoped ? { ids: [...rawScoped] } : {}),
      } as NodeFilter)
    ).map((n) => n.id)
  );

  const priorities = await graph.queryNodes({
    kind: 'priority',
    liveOnly: true,
  });
  const assigned = new Set<number>();
  const rows: IPriorityMatrixRow[] = [];

  for (const priority of priorities) {
    const edges = await graph.getEdges({
      dst: priority.id,
      rel: 'has_priority',
    });
    let count = 0;
    for (const e of edges) {
      if (!scoped.has(e.src)) continue;
      count += 1;
      assigned.add(e.src);
    }
    const rank =
      typeof priority.metadata?.rank === 'number'
        ? priority.metadata.rank
        : undefined;
    rows.push({
      priority: priority.name ?? '',
      priorityUid: priority.uid,
      rank,
      count,
    });
  }

  rows.sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
  );

  // "Unassigned" — in-scope, LIVE issues carrying no live has_priority edge at all.
  let unassigned = 0;
  for (const id of scoped) if (!assigned.has(id)) unassigned += 1;

  return { rows, unassigned, statusScope };
}

// ---------------------------------------------------------------------------
// partOfRollup — the FEAT-005 hierarchy rollup, transitive (not one-level).
// ---------------------------------------------------------------------------

export interface IPartOfRollupInput {
  /** The root issue's `uid` (§6.1). Throws `IssueNotFoundError` if it does not resolve to a live issue. */
  uid: string;
}

export interface IPartOfRollupResult {
  uid: string;
  /** Every TRANSITIVE descendant via `part_of` (issue → issue, `n:1`, §3) — not just direct children. Counted exactly once each, regardless of chain depth. */
  childrenTotal: number;
  childrenOpen: number;
  childrenClosed: number;
  /** `uid`s of the still-open descendants — the actionable half, mirroring the `IIssueRef`-shaped convention `card.ts`'s `blockers`/`related` already use. */
  childrenOpenUids: readonly string[];
}

/** Batch-resolve `has_status` targets for a set of already-fetched issue nodes — one `getEdges` per node (the same N-round-trip shape `card.ts`'s own unexported `resolveStatusesFor` uses; not importable from here, see this file's own doc comment), then one batched `getNodesByIds`. */
async function resolveStatusesForNodes(
  graph: GraphBackend,
  issues: NodeRecord[]
): Promise<Map<number, NodeRecord>> {
  if (issues.length === 0) return new Map();
  const edgeLists = await Promise.all(
    issues.map((i) => graph.getEdges({ src: i.id, rel: 'has_status' }))
  );
  const statusEdgeByIssue = new Map<number, number>();
  edgeLists.forEach((es, i) => {
    const e = es[0];
    if (e) statusEdgeByIssue.set(issues[i].id, e.dst);
  });
  const statusIds = [...new Set(statusEdgeByIssue.values())];
  if (statusIds.length === 0) return new Map();
  const statusNodes = await graph.getNodesByIds(statusIds);
  const statusById = new Map(statusNodes.map((n) => [n.id, n]));
  const out = new Map<number, NodeRecord>();
  for (const [issueId, statusId] of statusEdgeByIssue) {
    const s = statusById.get(statusId);
    if (s) out.set(issueId, s);
  }
  return out;
}

/**
 * SPEC.md §5's `part_of` + derived two-axis rollup (FEAT-005), realized as
 * ONE axis here — children-open/closed over the FULL transitive subtree
 * (the second axis, "does THIS item carry its own closing evidence," is a
 * `get`/card-assembly concern over the root's own citations, out of scope
 * for a rollup over its CHILDREN).
 *
 * Uses `getSubgraph(rootId, {rel:'part_of', direction:'in', depth:-1})` —
 * the unbounded walk (verified: `getNeighbors`'s `depth` is a row BUDGET,
 * not a depth bound, per `@adhd/sox-graph-store`'s own dist comment; only
 * `getSubgraph`'s `-1` sentinel gives a genuine unbounded multi-level walk)
 * with its own internal visited set, so a grandchild (or deeper) reached
 * through exactly one path is collected into the SAME node set as a direct
 * child — counted once, never re-added by also summing each child's own
 * subtree size on top of a direct-children count. `getSubgraph` does NOT
 * filter node liveness (documented on the library's own `getSubgraphIterative`:
 * "an invalidated node behind a live edge IS part of the subgraph") — a
 * soft-deleted descendant is explicitly filtered back out below, since a
 * deleted issue is neither open work nor closed work, it is gone.
 */
export async function partOfRollup(
  handle: IQueryStoreHandle,
  input: IPartOfRollupInput
): Promise<IPartOfRollupResult> {
  const { graph } = handle;
  const root = await resolveIssueByUid(graph, input.uid);

  const subgraph = await graph.getSubgraph(root.id, {
    rel: 'part_of',
    direction: 'in',
    depth: -1,
  });
  const descendants = subgraph.nodes.filter(
    (n) => n.id !== root.id && n.kind === 'issue' && !n.tInvalid
  );

  const statuses = await resolveStatusesForNodes(graph, descendants);
  let childrenOpen = 0;
  let childrenClosed = 0;
  const childrenOpenUids: string[] = [];
  for (const child of descendants) {
    if (isStatusTerminal(statuses.get(child.id))) {
      childrenClosed += 1;
    } else {
      childrenOpen += 1;
      childrenOpenUids.push(child.uid);
    }
  }

  return {
    uid: root.uid,
    childrenTotal: descendants.length,
    childrenOpen,
    childrenClosed,
    childrenOpenUids,
  };
}

// ---------------------------------------------------------------------------
// openCurve — validAt point-in-time cumulative-open curves.
// ---------------------------------------------------------------------------

export interface IOpenCurveInput {
  /** `project`/`component`/`kind` only — `status` is rejected (`InvalidArgumentError`): this view computes openness itself, per sampled instant, so a caller-given status filter would silently conflict with that computation rather than compose with it. */
  filter?: IIssueFilter;
  /** ISO-8601 instants to sample, in the given order. Must be non-empty; each is parsed via `Date.parse` and normalized to a full ISO string for lexical comparison against stored `at` timestamps — an unparsable entry throws by name rather than silently producing `NaN`-derived output. */
  at: readonly string[];
}

export interface IOpenCurvePoint {
  at: string;
  /** In-scope issues that EXISTED at this instant (`NodeFilter.validAt`: `t_created <= at` and `t_invalid` is null or after `at`) — exact, never reconstructed. */
  existed: number;
  /** Of `existed`, the count whose RECONSTRUCTED status was non-terminal at this instant (never the issue's CURRENT status) — see {@link reconstructStatusAt}. */
  open: number;
  /** `existed - open`. */
  closed: number;
}

export interface IOpenCurveResult {
  points: readonly IOpenCurvePoint[];
}

const OPEN_CURVE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'project',
  'component',
  'kind',
]);

/**
 * Reconstructs the issue's status AS OF `at` from its own audit trail
 * (`resolveCurrentStatusAndAuditTrails` below — ascending by `.at` already).
 * Three cases, in order:
 *
 * 1. **No transition-shaped entry at all** (no audit entry carries a `to` —
 *    every `create`-time audit omits it, §4/`create-issue.ts`): the issue has
 *    never changed status, so its CURRENT status is what it has always been
 *    — return `currentStatusName` unconditionally.
 * 2. **At least one transition at-or-before `at`**: return the LAST such
 *    transition's `to` — the status that transition moved the issue INTO,
 *    still in effect at `at` (no later transition has happened yet, by
 *    definition of "last at-or-before").
 * 3. **Every transition is AFTER `at`** (the issue transitioned at least
 *    once, but only after the sampled instant): return the EARLIEST
 *    transition's `from` — the status it recorded moving AWAY FROM, i.e.
 *    the status that held from creation up to that first transition, which
 *    covers `at` by this case's own precondition.
 *
 * **Stated limitation**: this assumes exactly one status held for the whole
 * span between two adjacent transitions (and from creation to the first
 * one) — true by construction, since a `has_status` edge is `n:1` (§3) and
 * every change is (assumed to be) recorded as a `transition`-shaped audit
 * entry once that write verb exists. It also classifies terminality by each
 * resolved status name's CURRENT `terminal` flag (`terminalByName`), not
 * whatever it was AT `at` — an approximation, named here rather than
 * silently shipped as exact, in the same spirit as `query.ts`'s
 * `sortByPriorityRank` and SPEC.md §8.1's `closedAt` reconstruction.
 */
function reconstructStatusAt(
  auditTrail: readonly IIssueAuditEntry[],
  at: string,
  currentStatusName: string | undefined
): string | undefined {
  const transitions = auditTrail.filter((e) => e.to !== undefined);
  if (transitions.length === 0) return currentStatusName;

  let lastAtOrBefore: IIssueAuditEntry | undefined;
  for (const t of transitions) {
    if (t.at <= at) lastAtOrBefore = t;
    else break; // ascending order — nothing after this point can qualify either
  }
  if (lastAtOrBefore) return lastAtOrBefore.to;
  return transitions[0]?.from;
}

/**
 * Batch-resolves, for EVERY issue that has ever carried either edge (not just
 * the issues a particular sampled instant's `existing` set happens to
 * contain — a whole-relation fetch is one query regardless of how many rows
 * come back, see {@link openCurve}'s own doc comment), two things that
 * `reconstructStatusAt` needs and that do NOT depend on `at`:
 *
 * 1. its CURRENT status name, via the first `has_status` edge for that issue
 *    — "first edge wins," the exact same rule (and the exact same
 *    whole-relation-then-group shape) `query.ts`'s `queryReady` already
 *    applies to this identical relation;
 * 2. its full `audits`-edge trail (SPEC.md §3: `audits: * → audit (1:n)`,
 *    subject is the edge SOURCE), sorted oldest-first — the same construction
 *    `card.ts`'s own `resolveAuditTrail` does per-issue, reproduced here
 *    because that function's signature is shaped for "I already have one
 *    issue's outgoing edges," which is exactly the one-round-trip-per-issue
 *    shape this view must NOT do.
 *
 * A `has_status`/`audits` edge whose target node no longer exists is silently
 * dropped from both maps below — `getNodesByIds` only returns nodes that
 * still exist, so a vanished target was ALREADY silently excluded by the old
 * per-issue `getNodesByIds([currentStatusId])`/`resolveAuditTrail` calls this
 * replaces; the batched form must drop it the same way, not surface it as a
 * phantom entry.
 */
async function resolveCurrentStatusAndAuditTrails(
  graph: GraphBackend
): Promise<{
  currentStatusNameByIssue: Map<number, string | undefined>;
  auditTrailByIssue: Map<number, IIssueAuditEntry[]>;
}> {
  // --- current status: one `has_status` edge per issue, "first edge wins" ---
  const statusEdges = await graph.getEdges({ rel: 'has_status' });
  const statusIdByIssue = new Map<number, number>();
  for (const e of statusEdges) {
    if (!statusIdByIssue.has(e.src)) statusIdByIssue.set(e.src, e.dst); // first edge wins, as the old per-issue `edges[0]` did
  }
  const statusNodeIds = [...new Set(statusIdByIssue.values())];
  const statusById = new Map(
    (statusNodeIds.length > 0
      ? await graph.getNodesByIds(statusNodeIds)
      : []
    ).map((n) => [n.id, n])
  );
  const currentStatusNameByIssue = new Map<number, string | undefined>();
  for (const [issueId, statusId] of statusIdByIssue) {
    currentStatusNameByIssue.set(issueId, statusById.get(statusId)?.name);
  }

  // --- audit trail: every `audits` edge, grouped by its issue-subject src ---
  const auditEdges = await graph.getEdges({ rel: 'audits' });
  const auditIdsByIssue = new Map<number, number[]>();
  for (const e of auditEdges) {
    const list = auditIdsByIssue.get(e.src);
    if (list) list.push(e.dst);
    else auditIdsByIssue.set(e.src, [e.dst]);
  }
  const allAuditNodeIds = [...new Set(auditEdges.map((e) => e.dst))];
  const auditNodesById = new Map(
    (allAuditNodeIds.length > 0
      ? await graph.getNodesByIds(allAuditNodeIds)
      : []
    ).map((n) => [n.id, n])
  );
  const auditTrailByIssue = new Map<number, IIssueAuditEntry[]>();
  for (const [issueId, auditIds] of auditIdsByIssue) {
    const entries: IIssueAuditEntry[] = auditIds
      .map((id) => auditNodesById.get(id))
      .filter((n): n is NodeRecord => n !== undefined)
      .map((n) => ({
        uid: n.uid,
        actor: typeof n.metadata?.actor === 'string' ? n.metadata.actor : '',
        action:
          typeof n.metadata?.action === 'string'
            ? n.metadata.action
            : n.name ?? '',
        from:
          typeof n.metadata?.from === 'string' ? n.metadata.from : undefined,
        to: typeof n.metadata?.to === 'string' ? n.metadata.to : undefined,
        note:
          typeof n.metadata?.note === 'string' ? n.metadata.note : undefined,
        sha: typeof n.metadata?.sha === 'string' ? n.metadata.sha : '',
        at: typeof n.metadata?.at === 'string' ? n.metadata.at : n.tCreated,
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    auditTrailByIssue.set(issueId, entries);
  }

  return { currentStatusNameByIssue, auditTrailByIssue };
}

/**
 * SPEC.md §5's `validAt`-driven cumulative-open curve.
 *
 * **Cost is bounded by the sampled-instant count and the size of the
 * `has_status`/`audits` relations, never by (instants × existing-issue
 * count).** The obvious shape — for each sampled instant, fetch the issues
 * that existed then, per issue, fetch its current-status edge, its
 * current-status node, and its full audit trail — is up to four sequential
 * round trips PER ISSUE PER INSTANT. Ten sampled instants over a 5,000-issue
 * store cost on the order of 200,000 serialized queries under that shape,
 * even though nothing about "how open was the store on these ten dates"
 * scales with store size on its own — it should scale with the number of
 * dates the caller asked about. Worse, an issue's CURRENT status and full
 * audit trail don't depend on `at` at all (`reconstructStatusAt` only reads
 * them; it never asks the backend anything itself), so the naive per-instant
 * loop was refetching the exact same unchanging per-issue data once per
 * instant for nothing.
 *
 * Instead, both relations are fetched ONCE, before the instant loop, and
 * grouped in memory — the same shape `query.ts`'s `queryReady` already uses
 * for `blocks`/`has_status`: `getEdges({rel:'has_status'})` and
 * `getEdges({rel:'audits'})` each take the WHOLE relation in a single call
 * (there is no batch-by-many-`src` primitive — `getEdges` accepts only one
 * `src`/`dst` at a time, which is exactly why fetching the whole relation
 * once is the right move), plus one `getNodesByIds` each to resolve the
 * status/audit-entry nodes those edges point at — see
 * {@link resolveCurrentStatusAndAuditTrails}. That's four queries total for
 * this cost, however many issues or instants are involved; the only
 * per-instant cost left is the one `queryNodes({validAt})` call SPEC.md's own
 * existence check requires. Total round trips: `4 + M` for `M` sampled
 * instants — independent of N, the number of issues in the store.
 */
export async function openCurve(
  handle: IQueryStoreHandle,
  input: IOpenCurveInput
): Promise<IOpenCurveResult> {
  const { graph } = handle;
  assertOnlyAllowedFilterKeys(
    input.filter,
    OPEN_CURVE_ALLOWED_KEYS,
    'openCurve'
  );

  if (input.at.length === 0) {
    throw new InvalidArgumentError(
      'at',
      'requires at least one ISO-8601 instant to sample'
    );
  }
  const instants = input.at.map((raw) => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidArgumentError(
        'at',
        `"${raw}" is not a parsable ISO-8601 instant`
      );
    }
    return parsed.toISOString();
  });

  const placementScope = await resolvePlacementScope(graph, input.filter);
  if (placementScope?.size === 0) {
    return {
      points: instants.map((at) => ({ at, existed: 0, open: 0, closed: 0 })),
    };
  }

  const statuses = await graph.queryNodes({ kind: 'status', liveOnly: true });
  const terminalByName = new Map(
    statuses.map((s) => [s.name ?? '', isStatusTerminal(s)])
  );

  // Per-ISSUE data (never per (issue, instant)) — fetched once for the whole
  // relation and reused across every sampled instant. See this function's own
  // doc comment for the cost model.
  const { currentStatusNameByIssue, auditTrailByIssue } =
    await resolveCurrentStatusAndAuditTrails(graph);

  // Per-ISSUE as well: the instant each node stopped being the head of its
  // identity chain. A body edit supersedes the old node and deliberately leaves
  // its `t_invalid` NULL (SPEC.md §4c), so `validAt` — correctly — still matches
  // it at every later instant, alongside its successor. Without this, ONE issue
  // counts as TWO from the edit onward, and N edits count it N+1 times.
  //
  // The discriminator is the `SUPERSEDES` edge's own `tCreated`, written in the
  // same transaction as the supersede: the old node is `dst`, so `dst` was the
  // chain head strictly BEFORE that instant and its successor is the head from
  // that instant on. Filtering here rather than in the node filter is exact —
  // unlike a listing, this function computes `existed`/`open` in JS from the
  // returned array, with no SQL `COUNT` behind it and no keyset page to shorten.
  const supersededAtByNode = new Map<number, string>();
  for (const e of await graph.getEdges({ rel: 'SUPERSEDES' })) {
    const previous = supersededAtByNode.get(e.dst);
    if (previous === undefined || e.tCreated < previous)
      supersededAtByNode.set(e.dst, e.tCreated);
  }

  const points: IOpenCurvePoint[] = [];
  for (const at of instants) {
    const nodeFilter: Record<string, unknown> = {
      kind: 'issue',
      validAt: at,
      // `liveOnly` defaults to `true` (verified, `@adhd/sox-graph-store` dist:
      // `queryNodes` → `buildNodeFilterClause(filter, filter?.liveOnly ?? true, ...)`)
      // and its `t_invalid IS NULL` clause is ANDed alongside — never superseded
      // by — `validAt`'s own `(t_invalid IS NULL OR t_invalid > ?)` clause. Left
      // at its default, EVERY sampled instant would silently exclude any issue
      // that has since been soft-deleted, even an instant strictly BEFORE that
      // deletion when the issue demonstrably existed — contradicting `existed`'s
      // own doc comment above ("exact, never reconstructed"). `validAt` is
      // already the correct, exact bi-temporal existence check on its own; opt
      // out of the redundant, over-restrictive current-time liveness clause.
      liveOnly: false,
      ...(placementScope ? { ids: [...placementScope] } : {}),
    };
    const existing = await graph.queryNodes(
      nodeFilter as unknown as NodeFilter
    );

    let open = 0;
    let existedCount = 0;
    for (const issue of existing) {
      // One row per identity CHAIN at this instant, never one per node.
      const supersededAt = supersededAtByNode.get(issue.id);
      if (supersededAt !== undefined && supersededAt <= at) continue;
      existedCount += 1;
      const currentStatusName = currentStatusNameByIssue.get(issue.id);
      const trail = auditTrailByIssue.get(issue.id) ?? [];
      const statusAt = reconstructStatusAt(trail, at, currentStatusName);
      const terminalAt =
        statusAt !== undefined ? terminalByName.get(statusAt) ?? false : false;
      if (!terminalAt) open += 1;
    }

    points.push({
      at,
      existed: existedCount,
      open,
      closed: existedCount - open,
    });
  }

  return { points };
}
