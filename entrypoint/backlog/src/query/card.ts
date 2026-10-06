/**
 * card.ts — assembling a field-projected {@link IIssueCard} from a live
 * `issue` `NodeRecord` (SPEC.md §6.5).
 *
 * One issue card costs, in the worst case (every pseudo field requested):
 * one `getEdges({src: issueId})` — a single call returning EVERY outgoing
 * relation (`has_kind`/`has_status`/`has_priority`/`authored_by`/`has_note`/
 * `has_citation`/`has_transition`/`audits`/`relates_to`/`part_of`/`blocks`,
 * and also `supersedes`/`duplicate_of` — in one round trip), one
 * `getEdges({dst: issueId, rel:'owns_component'})` +
 * `getEdges({dst: componentId, rel:'owns_project'})` for placement, and one
 * `getNodesByIds` batch covering every distinct target rowid collected above
 * — never one query per field. The DEFAULT five-field card
 * (`uid,kind,title,status,priority`) costs exactly the first `getEdges` call
 * plus one batched `getNodesByIds` — no placement traversal, no pseudo-field
 * reads.
 *
 * The fetch returns `supersedes`/`duplicate_of`, but NO card field surfaces
 * them: `related` deliberately projects ONLY `relates_to`/`part_of`/`blocks`
 * (see {@link resolveRelated}), and the only read path for the full relation
 * picture is the `auditTrail` pseudo-field (ADR-0006, "Known read asymmetry —
 * `related` excludes `supersedes`/`duplicate_of`").
 */

import type {
  EdgeRecord,
  GraphBackend,
  NodeRecord,
} from '@adhd/sox-graph-store';
import {
  type IIssueAuditEntry,
  type IIssueCard,
  type IIssueCitation,
  type IIssueField,
  type IIssueNote,
  type IIssueRef,
  type IObligationView,
  type ISimilarLinks,
  type ISimilarRef,
  type IScoreKind,
  ISSUE_PLAIN_FIELDS,
  ISSUE_PSEUDO_FIELDS,
  isKnownIssueField,
} from './types.js';
import type {
  IObligationAppliesTo,
  IObligationOverride,
  IObligationSeverity,
  IPredicate,
} from '../write/obligation.js';
import { BacklogValidationError } from '../write/errors.js';
import { nowISO } from '../write/tx.js';
import { citationFromNode } from '../citation.js';
import { readRevision } from '../write/revision.js';
import {
  getIncomingEdges,
  getOutgoingEdges,
  resolveIssuePlacement,
} from './resolve.js';
import { deriveVerdict, type IVerdictRung } from './verdict.js';
import { readSpecPointer } from '../write/spec-revision.js';
import { checkSpecStaleness } from './spec-staleness.js';

/** SPEC.md §6.5's `assertKnownFields` — unknown name → `BacklogValidationError` naming it, never a silent drop. */
export function assertKnownIssueFields(
  fields: readonly string[] | undefined
): asserts fields is readonly IIssueField[] | undefined {
  if (!fields) return;
  for (const f of fields) {
    if (!isKnownIssueField(f)) {
      throw new BacklogValidationError(
        'fields',
        `unknown field "${f}" — known fields: ${[
          ...ISSUE_PLAIN_FIELDS,
          ...ISSUE_PSEUDO_FIELDS,
        ].join(', ')}`
      );
    }
  }
}

/** `status.meta.metadata.terminal` — the closedness knob (DATA_MODEL.md §3, SPEC.md §2). Defaults to `false` for a status row written before the field existed, never `true` by omission (a closedness knob that defaults closed would silently exclude items from open-item views). */
export function isStatusTerminal(
  statusRecord: NodeRecord | undefined
): boolean {
  return statusRecord?.metadata?.terminal === true;
}

interface IEdgeTargets {
  kind?: NodeRecord;
  status?: NodeRecord;
  priority?: NodeRecord;
  author?: NodeRecord;
}

/**
 * Page-level batched edge/node reads shared by every card in a `query` page
 * (built once by {@link assembleIssueCards}). The whole point is the N+1 fix:
 * a `query` page used to cost, per item, an outgoing `getEdges({src})`, one or
 * more incoming `getEdges({dst,...})`, several `getNodesByIds`, and a
 * `resolveStatusesFor` per status-bearing resolver (`blockers`/`related`/
 * `blocksOut`/`partOf`/`similar`) — O(page) store round trips. This batch pays
 * a bounded number of round trips UP FRONT (one page-keyed
 * `getEdges({srcs, rels})` + one `getEdges({dsts, rels})` + a constant number
 * of node/status reads) and every card reads from memory. It is keyed by the
 * page's node ids, so its round-trip count is independent of page size and its
 * row count is bounded by the page's own edges, not the store's size.
 */
export interface IPageReadBatch {
  /** Page-issue outgoing edges, keyed by src issue id, in the per-src order the store's `getEdges({src})` yields. */
  readonly outgoingBySrc: ReadonlyMap<number, readonly EdgeRecord[]>;
  /** Page-issue incoming edges, keyed by dst issue id, in the per-dst order `getEdges({dst})` yields. */
  readonly incomingByDst: ReadonlyMap<number, readonly EdgeRecord[]>;
  /** Every neighbour node referenced by the page's batched edges, keyed by id. */
  readonly nodeById: ReadonlyMap<number, NodeRecord>;
  /** Status node per node id, resolved page-wide in one pass (never one per item). */
  readonly statusByNodeId: ReadonlyMap<number, NodeRecord>;
  /** Outbound `blocks` adjacency (src → dst[]) over page ids, for the `dependents` walk. */
  readonly blocksOutAdj: ReadonlyMap<number, readonly number[]>;
  /** Placement per node id (page ids + neighbours), populated only when a placement-bearing field is requested. */
  readonly placementByNodeId: ReadonlyMap<
    number,
    { component?: NodeRecord; project?: NodeRecord }
  >;
}

/**
 * Resolve a set of ids to node records, preferring a page-wide pre-resolved
 * `nodeById` map over a fresh store read. Preserves `getNodesByIds`'s contract:
 * requested-id order, missing/tombstoned ids omitted.
 */
async function pickNodes(
  graph: GraphBackend,
  nodeById: ReadonlyMap<number, NodeRecord> | undefined,
  ids: readonly number[]
): Promise<NodeRecord[]> {
  if (!nodeById) return graph.getNodesByIds([...ids]);
  const out: NodeRecord[] = [];
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Resolve the `n:1` catalog edges every issue carries (`has_kind`/
 * `has_status`/`has_priority`/`authored_by`) from one already-fetched
 * `getEdges({src: issueId})` result, batching the target reads into one
 * `getNodesByIds` call.
 */
async function resolveCatalogTargets(
  graph: GraphBackend,
  issueId: number,
  outgoing: readonly EdgeRecord[],
  nodeById?: ReadonlyMap<number, NodeRecord>
): Promise<IEdgeTargets> {
  const kindEdge = outgoing.find(
    (e) => e.rel === 'has_kind' && e.src === issueId
  );
  const statusEdge = outgoing.find(
    (e) => e.rel === 'has_status' && e.src === issueId
  );
  const priorityEdge = outgoing.find(
    (e) => e.rel === 'has_priority' && e.src === issueId
  );
  const authorEdge = outgoing.find(
    (e) => e.rel === 'authored_by' && e.src === issueId
  );

  const ids = [
    kindEdge?.dst,
    statusEdge?.dst,
    priorityEdge?.dst,
    authorEdge?.dst,
  ].filter((id): id is number => id !== undefined);
  if (ids.length === 0) return {};
  const nodes = await pickNodes(graph, nodeById, ids);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    kind: kindEdge ? byId.get(kindEdge.dst) : undefined,
    status: statusEdge ? byId.get(statusEdge.dst) : undefined,
    priority: priorityEdge ? byId.get(priorityEdge.dst) : undefined,
    author: authorEdge ? byId.get(authorEdge.dst) : undefined,
  };
}

async function resolveCitations(
  graph: GraphBackend,
  issueId: number,
  outgoing: readonly EdgeRecord[],
  nodeById?: ReadonlyMap<number, NodeRecord>
): Promise<IIssueCitation[]> {
  const edges = outgoing.filter(
    (e) => e.rel === 'has_citation' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await pickNodes(graph, nodeById, edges.map((e) => e.dst));
  // The ONE decoder for the persisted citation node (`../citation.ts`) — the
  // read projection can never drift from the write encoding.
  return nodes.map((n) =>
    citationFromNode({
      uid: n.uid,
      name: n.name,
      content: n.content,
      metadata: n.metadata,
      tCreated: n.tCreated,
    })
  );
}

async function resolveNotes(
  graph: GraphBackend,
  issueId: number,
  outgoing: readonly EdgeRecord[],
  nodeById?: ReadonlyMap<number, NodeRecord>
): Promise<IIssueNote[]> {
  const edges = outgoing.filter(
    (e) => e.rel === 'has_note' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await pickNodes(graph, nodeById, edges.map((e) => e.dst));
  return nodes.map((n) => ({
    uid: n.uid,
    author: typeof n.metadata?.author === 'string' ? n.metadata.author : '',
    text: typeof n.metadata?.text === 'string' ? n.metadata.text : n.content,
    at: typeof n.metadata?.at === 'string' ? n.metadata.at : n.tCreated,
  }));
}

/** The full audit trail for an issue — `audits` edges FROM the issue (SPEC.md §3: `audits: * → audit (1:n)`, the subject is the edge SOURCE), sorted oldest-first. */
export async function resolveAuditTrail(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  nodeById?: ReadonlyMap<number, NodeRecord>
): Promise<IIssueAuditEntry[]> {
  const edges = (outgoing ?? (await getOutgoingEdges(graph, issueId))).filter(
    (e) => e.rel === 'audits' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await pickNodes(graph, nodeById, edges.map((e) => e.dst));
  const entries = nodes.map((n) => ({
    uid: n.uid,
    actor: typeof n.metadata?.actor === 'string' ? n.metadata.actor : '',
    action:
      typeof n.metadata?.action === 'string' ? n.metadata.action : n.name ?? '',
    from: typeof n.metadata?.from === 'string' ? n.metadata.from : undefined,
    to: typeof n.metadata?.to === 'string' ? n.metadata.to : undefined,
    note: typeof n.metadata?.note === 'string' ? n.metadata.note : undefined,
    sha: typeof n.metadata?.sha === 'string' ? n.metadata.sha : '',
    at: typeof n.metadata?.at === 'string' ? n.metadata.at : n.tCreated,
  }));
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * `blockers` (SPEC.md §5.2's definition, restated onto the `blocks` edge,
 * §6.2): the set of issues that `blocks` this one (incoming
 * `blocks` edges — `e.dst === issueId`) and are NOT YET terminal — "what's
 * actually blocking it right now," never the full historical blocker set.
 */
export async function resolveBlockers(
  graph: GraphBackend,
  issueId: number,
  batch?: IPageReadBatch
): Promise<IIssueRef[]> {
  const incoming = batch
    ? (batch.incomingByDst.get(issueId) ?? [])
    : await graph.getEdges({ dst: issueId, rel: 'blocks' });
  const blockEdges = incoming.filter(
    (e) => e.rel === 'blocks' && e.dst === issueId
  );
  if (blockEdges.length === 0) return [];
  const blockerIds = blockEdges.map((e) => e.src);
  const blockers = await pickNodes(graph, batch?.nodeById, blockerIds);
  const statuses =
    batch?.statusByNodeId ?? (await resolveStatusesFor(graph, blockers));
  return blockers
    .filter((b) => !isStatusTerminal(statuses.get(b.id)))
    .map((b) => ({
      uid: b.uid,
      title: b.name ?? '',
      status: statuses.get(b.id)?.name ?? '',
    }));
}

/**
 * `related` — every live relation type that touches this issue, deduplicated
 * by node and tagged with the relation that produced it (C2 — structural
 * legibility; SPEC.md §5/§6.5, DESIGN §5 AC2):
 *
 * - `relates_to` (both directions — an `n:m` symmetric-in-practice rel, §3),
 *   tagged `relates_to`;
 * - `part_of` (both directions: the parent when this item is the child, the
 *   children when it is the parent), tagged `part_of`;
 * - `blocks` outbound (this item blocks the target), tagged `blocks`; and
 *   `blocks` incoming (the source blocks this item), tagged `blocked_by`.
 *
 * `blockers` (the non-terminal INCOMING subset) is deliberately NOT removed —
 * it stays as the "what's actually blocking me right now" view; `related` is
 * the structural superset. Widening this result is additive ROWS, never a
 * signature change: a consumer reading `uid`/`title`/`status` is unaffected.
 * Dedup is by node id, first-seen wins, in the deterministic order above.
 */
export async function resolveRelated(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  batch?: IPageReadBatch
): Promise<IIssueRef[]> {
  const out = outgoing ?? (await getOutgoingEdges(graph, issueId));
  const incoming = batch
    ? (batch.incomingByDst.get(issueId) ?? [])
    : await getIncomingEdges(graph, issueId);

  const relById = new Map<number, NonNullable<IIssueRef['rel']>>();
  const add = (id: number, rel: NonNullable<IIssueRef['rel']>): void => {
    if (!relById.has(id)) relById.set(id, rel);
  };
  for (const e of out) {
    if (e.rel === 'relates_to') add(e.dst, 'relates_to');
    else if (e.rel === 'part_of') add(e.dst, 'part_of');
    else if (e.rel === 'blocks') add(e.dst, 'blocks');
  }
  for (const e of incoming) {
    if (e.rel === 'relates_to') add(e.src, 'relates_to');
    else if (e.rel === 'part_of') add(e.src, 'part_of');
    else if (e.rel === 'blocks') add(e.src, 'blocked_by');
  }
  if (relById.size === 0) return [];
  const others = await pickNodes(graph, batch?.nodeById, [...relById.keys()]);
  const statuses =
    batch?.statusByNodeId ?? (await resolveStatusesFor(graph, others));
  return others.map((n) => ({
    uid: n.uid,
    title: n.name ?? '',
    status: statuses.get(n.id)?.name ?? '',
    rel: relById.get(n.id),
  }));
}

/**
 * C9 — the reviewed `similar_to` links touching one issue, BOTH directions
 * (`n:m`). Outgoing edges (`similar_to` from this issue) become `similarTo`;
 * incoming edges (into it) become `similarFrom`. Each neighbour is projected to
 * the compact `ISimilarRef` shape (uid/title/status + owning project/repo).
 *
 * ADVISORY relation only — the reserved `duplicate_of` same-judgement relation
 * is deliberately never read here.
 */
export async function resolveSimilar(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  batch?: IPageReadBatch
): Promise<ISimilarLinks> {
  const out = outgoing ?? (await getOutgoingEdges(graph, issueId));
  const incoming = batch
    ? (batch.incomingByDst.get(issueId) ?? [])
    : await getIncomingEdges(graph, issueId);
  const toEdges = out.filter(
    (e) => e.rel === 'similar_to' && e.src === issueId
  );
  const fromEdges = incoming.filter(
    (e) => e.rel === 'similar_to' && e.dst === issueId
  );
  const ids = [
    ...new Set([...toEdges.map((e) => e.dst), ...fromEdges.map((e) => e.src)]),
  ];
  if (ids.length === 0) return { similarTo: [], similarFrom: [] };

  const nodes = await pickNodes(graph, batch?.nodeById, ids);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const statuses =
    batch?.statusByNodeId ?? (await resolveStatusesFor(graph, nodes));
  const refFor = async (id: number): Promise<ISimilarRef | undefined> => {
    const node = byId.get(id);
    if (!node) return undefined;
    const { project } = batch
      ? (batch.placementByNodeId.get(node.id) ?? {})
      : await resolveIssuePlacement(graph, node.id);
    const ref: ISimilarRef = {
      uid: node.uid,
      title: node.name ?? '',
      status: statuses.get(node.id)?.name ?? '',
    };
    if (project) {
      ref.projectUid = project.uid;
      if (typeof project.metadata?.repoUrl === 'string')
        ref.repoUrl = project.metadata.repoUrl;
    }
    return ref;
  };

  const similarTo: ISimilarRef[] = [];
  for (const edge of toEdges) {
    const ref = await refFor(edge.dst);
    if (ref) similarTo.push(ref);
  }
  const similarFrom: ISimilarRef[] = [];
  for (const edge of fromEdges) {
    const ref = await refFor(edge.src);
    if (ref) similarFrom.push(ref);
  }
  return { similarTo, similarFrom };
}

/**
 * Outbound `blocks` (C2) — the issues THIS one blocks, live targets only.
 * Mirrors {@link resolveBlockers}'s shape but for the other direction: that
 * function returns the non-terminal INCOMING blockers ("what stops me"),
 * this one returns everything this item unblocks ("what I am stopping").
 */
export async function resolveBlocksOut(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  batch?: IPageReadBatch
): Promise<IIssueRef[]> {
  const edges = (outgoing ?? (await getOutgoingEdges(graph, issueId))).filter(
    (e) => e.rel === 'blocks' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const targets = await pickNodes(graph, batch?.nodeById, edges.map((e) => e.dst));
  if (targets.length === 0) return [];
  const statuses =
    batch?.statusByNodeId ?? (await resolveStatusesFor(graph, targets));
  return targets.map((n) => ({
    uid: n.uid,
    title: n.name ?? '',
    status: statuses.get(n.id)?.name ?? '',
    rel: 'blocks',
  }));
}

/**
 * Transitive outbound dependent count (C2, AC3): how many nodes reach
 * `issueId` via `blocks` (inclusive of direct dependents — the nodes this one
 * blocks, directly or through a chain). A cycle-safe BFS over the outgoing
 * `blocks` edges: a `visited` set counts each node once and terminates a cycle
 * (the reachability set is finite even when the edge set is cyclic).
 *
 * `scope`, when given, restricts the walk to node ids in the set — a list page
 * passes its own candidate id set so an N-item page costs N bounded walks, not
 * N whole-graph walks. On a single `get`, `scope` is omitted and the walk is
 * unbounded but still cycle-safe.
 */
export async function resolveDependents(
  graph: GraphBackend,
  issueId: number,
  scope?: ReadonlySet<number>,
  blocksOutAdj?: ReadonlyMap<number, readonly number[]>
): Promise<number> {
  const visited = new Set<number>();
  const queue: number[] = [issueId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const dsts = blocksOutAdj
      ? (blocksOutAdj.get(id) ?? [])
      : (await graph.getEdges({ src: id, rel: 'blocks' })).map((e) => e.dst);
    for (const dst of dsts) {
      if (dst === issueId || visited.has(dst)) continue;
      if (scope && !scope.has(dst)) continue;
      visited.add(dst);
      queue.push(dst);
    }
  }
  return visited.size;
}

/**
 * The single `part_of` parent of this item, or `null` (C2, AC3). `part_of` is
 * declared `n:1` (one parent per item, DATA_MODEL.md §3 / `EDGE_KIND_TABLE`),
 * so at most one live outgoing `part_of` edge can exist; the multiplicity gate
 * (`checkMultiplicityTx`) enforces that at write time.
 */
export async function resolvePartOf(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  batch?: IPageReadBatch
): Promise<IIssueRef | null> {
  const edge = (outgoing ?? (await getOutgoingEdges(graph, issueId))).find(
    (e) => e.rel === 'part_of' && e.src === issueId
  );
  if (!edge) return null;
  const [parent] = await pickNodes(graph, batch?.nodeById, [edge.dst]);
  if (!parent) return null;
  const statuses =
    batch?.statusByNodeId ?? (await resolveStatusesFor(graph, [parent]));
  return {
    uid: parent.uid,
    title: parent.name ?? '',
    status: statuses.get(parent.id)?.name ?? '',
    rel: 'part_of',
  };
}

/**
 * `obligations` (C4) — the declared, typed requirements on this issue, read
 * from its live `has_obligation` targets. PURE PROJECTION: each node's stored
 * `metadata` maps straight onto an {@link IObligationView}; the predicate is
 * NEVER evaluated here (evaluation belongs to the C5 gate at transition time
 * and the C6 verdict on read). One batched `getNodesByIds`; the returned order
 * follows the edge order, and an edge whose target no longer resolves (a
 * concurrently-invalidated row) is simply skipped rather than yielding a
 * partial view.
 */
export async function resolveObligations(
  graph: GraphBackend,
  issueId: number,
  outgoing?: readonly EdgeRecord[],
  batch?: IPageReadBatch
): Promise<IObligationView[]> {
  const edges = (outgoing ?? (await getOutgoingEdges(graph, issueId))).filter(
    (e) => e.rel === 'has_obligation' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await pickNodes(graph, batch?.nodeById, edges.map((e) => e.dst));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const views: IObligationView[] = [];
  for (const e of edges) {
    const n = byId.get(e.dst);
    if (!n) continue;
    const meta = n.metadata;
    const appliesTo = meta?.['applies_to'];
    const requirement = meta?.['requirement'];
    const onFail = meta?.['on_fail'];
    if (appliesTo === undefined || requirement === undefined || onFail === undefined) {
      continue;
    }
    const view: IObligationView = {
      uid: n.uid,
      applies_to: appliesTo as IObligationAppliesTo,
      requirement: requirement as IPredicate,
      on_fail: onFail as IObligationSeverity,
    };
    const override = meta?.['override'];
    if (override !== undefined) view.override = override as IObligationOverride;
    views.push(view);
  }
  return views;
}

/**
 * Batch-resolve `has_status` targets for a set of issue nodes — one
 * page-keyed `getEdges({srcs, rels:['has_status']})` (cost bounded by the
 * number of `issues`, never by the store's total `has_status` cardinality —
 * e54afd3f), plus one `getNodesByIds` for the distinct status targets. A
 * per-issue `getEdges({src, rel})` call — even fired concurrently via
 * `Promise.all` — would be N round trips to the backend, not the constant
 * number this function promises its callers.
 */
async function resolveStatusesFor(
  graph: GraphBackend,
  issues: NodeRecord[]
): Promise<Map<number, NodeRecord>> {
  if (issues.length === 0) return new Map();
  const edges = await graph.getEdges({
    srcs: [...new Set(issues.map((i) => i.id))],
    rels: ['has_status'],
  });
  const statusEdgeByIssue = new Map<number, number>();
  for (const e of edges) {
    if (!statusEdgeByIssue.has(e.src)) statusEdgeByIssue.set(e.src, e.dst);
  }
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

export interface IAssembleIssueCardOptions {
  /** Score from a `searchRanked`/`searchNodes` response — populates `_score` when requested (§5a). */
  score?: number;
  /** Provenance of `score` — populates `_score_kind` alongside `_score` (DESIGN §2 Invariant 5). */
  scoreKind?: IScoreKind;
  /**
   * Bounds the sub-collection pseudo fields (`auditTrail`/`citations`/
   * `related`/`blockers`) — `lastN` takes the LAST N rows, `after` is an
   * opaque cursor naming a uid to resume strictly after. Applied HERE (at the
   * card-assembly call site), never inside `resolveAuditTrail` itself: the
   * `openCurve` view (`views/stats.ts`) calls an independent batched audit
   * reader that needs the FULL trail and must not be bounded.
   */
  bounds?: { lastN?: number; after?: string };
  /** Pre-fetched outgoing edges (`getEdges({src: issue.id})`) — pass when the caller already has them (e.g. a batch `query` page) to avoid a redundant round trip. */
  outgoingEdges?: readonly EdgeRecord[];
  /**
   * Page-level batched edge/node reads (see {@link IPageReadBatch}) — supplied
   * by {@link assembleIssueCards} so every edge pseudo-field resolves from one
   * bounded prefetch instead of per-item store round trips. Absent on a
   * single `get` (N=1), which resolves directly against the graph unchanged.
   */
  batch?: IPageReadBatch;
  /**
   * The candidate id set a `dependents` walk is bounded to (C2). A list page
   * passes its own page id set so an N-item page costs N bounded walks; a
   * single `get` omits it, leaving the walk unbounded (but cycle-safe). Only
   * consulted when `fields` requests `dependents`.
   */
  scope?: ReadonlySet<number>;
  /**
   * C6 — the highest verdict ladder rung this card may derive. Default 2 (the
   * list bound); a single-item `get` raises it to 3+ via `deriveThrough`.
   * Only consulted when `fields` requests `verdict`.
   */
  verdictRung?: IVerdictRung;
  /** C6 test instrumentation — threaded to `deriveVerdict`'s `onRung`. */
  onVerdictRung?: (rung: number) => void;
  /**
   * C10 — a token the caller holds; when supplied AND the `spec` field was
   * requested, `card.spec.freshness` reports whether that token is still
   * current for this item's spec revision.
   */
  specToken?: string;
}

/**
 * Apply an optional `{lastN, after}` bound to an ordered sub-collection.
 * `after` drops every row up to and including the one whose `uid` matches
 * (a resume cursor); `lastN` then keeps the tail. Passing neither returns the
 * collection unchanged, so every existing caller is byte-for-byte unaffected.
 */
function boundSubCollection<T extends { uid: string }>(
  rows: T[],
  bounds: { lastN?: number; after?: string } | undefined
): T[] {
  if (!bounds) return rows;
  let out = rows;
  if (bounds.after !== undefined) {
    const idx = out.findIndex((r) => r.uid === bounds.after);
    if (idx >= 0) out = out.slice(idx + 1);
  }
  if (bounds.lastN !== undefined) out = out.slice(-bounds.lastN);
  return out;
}

/**
 * Project `issue` onto the requested `fields` (default: the five-field terse
 * card, SPEC.md §6.5). `uid` is always populated regardless of `fields`.
 */
export async function assembleIssueCard(
  graph: GraphBackend,
  issue: NodeRecord,
  fields: readonly IIssueField[],
  opts: IAssembleIssueCardOptions = {}
): Promise<IIssueCard> {
  const card: IIssueCard = { uid: issue.uid };
  const want = (f: IIssueField): boolean => fields.includes(f);

  const needsCatalogTargets =
    want('kind') || want('status') || want('priority') || want('author');
  const needsPlacement = want('project') || want('component');
  const needsCitations = want('citations');
  const needsNotes = want('notes');
  const needsAuditTrail = want('auditTrail');
  const needsBlockers = want('blockers');
  const needsRelated = want('related');
  const needsBlocksOut = want('blocksOut');
  const needsDependents = want('dependents');
  const needsPartOf = want('partOf');
  const needsObligations = want('obligations');
  const needsVerdict = want('verdict');
  const needsSpec = want('spec');
  const needsSimilar = want('similar');

  let outgoing: readonly EdgeRecord[] | undefined;
  if (opts.outgoingEdges) {
    outgoing = opts.outgoingEdges;
  } else if (opts.batch) {
    outgoing = opts.batch.outgoingBySrc.get(issue.id) ?? [];
  } else if (
    needsCatalogTargets ||
    needsCitations ||
    needsNotes ||
    needsAuditTrail ||
    needsRelated ||
    needsBlocksOut ||
    needsPartOf ||
    needsObligations ||
    needsSimilar
  ) {
    outgoing = await getOutgoingEdges(graph, issue.id);
  }

  if (want('title')) card.title = issue.name ?? '';
  if (want('createdAt')) card.createdAt = issue.tCreated;
  if (want('updatedAt')) card.updatedAt = issue.tValid;
  if (want('assignee')) {
    const assignee = issue.metadata?.assignee;
    if (typeof assignee === 'string') card.assignee = assignee;
  }
  // Item-level disclosure-contract provenance, a sibling of `assignee` in the
  // same metadata blob — populated only when requested AND non-empty, so a
  // card that never asked for it (or an issue filed before the field existed)
  // is byte-for-byte unchanged (SPEC.md §6.5's `plain` field, DATA_MODEL.md §8).
  if (want('gitContext')) {
    const gitContext = issue.metadata?.gitContext;
    if (typeof gitContext === 'string' && gitContext.length > 0)
      card.gitContext = gitContext;
  }
  if (want('closedAt')) {
    const closedAt = issue.metadata?.closedAt;
    if (typeof closedAt === 'string') card.closedAt = closedAt;
  }
  if (want('body')) card.body = issue.content;

  if (needsCatalogTargets && outgoing) {
    const targets = await resolveCatalogTargets(
      graph,
      issue.id,
      outgoing,
      opts.batch?.nodeById
    );
    if (want('kind') && targets.kind) card.kind = targets.kind.name ?? '';
    if (want('status') && targets.status)
      card.status = targets.status.name ?? '';
    if (want('priority') && targets.priority)
      card.priority = targets.priority.name ?? '';
    if (want('author') && targets.author)
      card.author = targets.author.name ?? '';
  }

  if (needsPlacement) {
    const { project, component } = opts.batch
      ? (opts.batch.placementByNodeId.get(issue.id) ?? {})
      : await resolveIssuePlacement(graph, issue.id);
    if (want('project') && project) card.project = project.uid;
    if (want('component') && component) card.component = component.uid;
  }

  if (needsCitations && outgoing)
    card.citations = boundSubCollection(
      await resolveCitations(graph, issue.id, outgoing, opts.batch?.nodeById),
      opts.bounds
    );
  if (needsNotes && outgoing)
    card.notes = await resolveNotes(
      graph,
      issue.id,
      outgoing,
      opts.batch?.nodeById
    );
  if (needsAuditTrail && outgoing)
    card.auditTrail = boundSubCollection(
      await resolveAuditTrail(graph, issue.id, outgoing, opts.batch?.nodeById),
      opts.bounds
    );
  if (needsBlockers)
    card.blockers = boundSubCollection(
      await resolveBlockers(graph, issue.id, opts.batch),
      opts.bounds
    );
  if (needsRelated && outgoing)
    card.related = boundSubCollection(
      await resolveRelated(graph, issue.id, outgoing, opts.batch),
      opts.bounds
    );
  if (needsBlocksOut && outgoing)
    card.blocksOut = await resolveBlocksOut(
      graph,
      issue.id,
      outgoing,
      opts.batch
    );
  if (needsDependents)
    card.dependents = await resolveDependents(
      graph,
      issue.id,
      opts.scope,
      opts.batch?.blocksOutAdj
    );
  if (needsPartOf && outgoing)
    card.partOf = await resolvePartOf(graph, issue.id, outgoing, opts.batch);
  if (needsObligations && outgoing)
    card.obligations = await resolveObligations(
      graph,
      issue.id,
      outgoing,
      opts.batch
    );

  if (needsVerdict) {
    // C6 — derived on read. An UNEXPECTED derivation failure degrades to an
    // `Unknown`-block verdict, NEVER a card-wide throw: a single read-side bug
    // must not make every list read fail (DESIGN §2 Primitive 4 — `unknown`
    // is never a green light, and it must still be reported).
    try {
      card.verdict = await deriveVerdict(graph, issue, {
        ...(opts.verdictRung !== undefined ? { maxRung: opts.verdictRung } : {}),
        ...(opts.onVerdictRung !== undefined
          ? { onRung: opts.onVerdictRung }
          : {}),
      });
    } catch (err) {
      const at = nowISO();
      card.verdict = {
        actionable: 'unknown',
        evaluated_at: at,
        revision: readRevision(issue.metadata),
        conditions: [
          {
            type: 'Budget',
            status: 'Unknown',
            severity: 'block',
            code: 'Unknown',
            message: `verdict derivation failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      };
    }
  }

  if (needsSpec) {
    // C10 — expose the pointer (revision uid + its `'sha256:<hex>'` token +
    // seq), NEVER the revision body. `freshness` is included only when the
    // caller supplied a token to compare against.
    const pointer = await readSpecPointer(graph, issue.uid);
    if (pointer) {
      card.spec = {
        spec_revision: pointer.revision_uid,
        spec_revision_token: pointer.revision_token,
        revision_seq: pointer.revision_seq,
      };
      if (opts.specToken !== undefined) {
        card.spec.freshness = (
          await checkSpecStaleness(graph, {
            uid: issue.uid,
            token: opts.specToken,
          })
        ).state;
      }
    }
  }

  if (needsSimilar && outgoing)
    card.similar = await resolveSimilar(graph, issue.id, outgoing, opts.batch);

  if (want('_score') && opts.score !== undefined) {
    card._score = opts.score;
    // Provenance is emitted alongside the score it describes, never on its
    // own — a `_score_kind` with no `_score` would claim a score that is not
    // there (DESIGN §2 Invariant 5).
    if (opts.scoreKind !== undefined) card._score_kind = opts.scoreKind;
  }
  // `_vector` (§6.5's pseudo field) only exists on a raw vector-search response, which this
  // card assembler never sees directly (StoreSearchBackend.searchRanked returns fused
  // SearchResult, not the raw embedding) — never populated here; a future embedding-surfacing
  // slice would thread it through IAssembleIssueCardOptions exactly like `score` above.

  return card;
}

/**
 * Build the page-level batched edge/node reads for a `query` page (the N+1
 * fix). Determines the relations the requested `fields` need and fetches them
 * keyed by the page's node ids — ONE `getEdges({srcs, rels})` for outgoing and
 * ONE `getEdges({dsts, rels})` for incoming — so the whole page costs a bounded
 * number of store round trips independent of page size AND a row count bounded
 * by the page's own edges, not by the store's relation cardinality (e54afd3f).
 * The store yields `(src, rel, rowid)` / `(dst, rel, rowid)` order — the same
 * per-key order the indexed single-key `getEdges({src})`/`getEdges({dst})`
 * reads give — and grouping by appending preserves it, so output order is
 * preserved exactly.
 *
 * When `fields` requests no edge/pseudo data at all, this issues zero store
 * calls (the common fast path is untouched).
 */
async function buildPageReadBatch(
  graph: GraphBackend,
  issueIds: readonly number[],
  fields: readonly IIssueField[]
): Promise<IPageReadBatch> {
  const want = (f: IIssueField): boolean => fields.includes(f);
  const pageIds = new Set(issueIds);

  const outRels = new Set<string>();
  const inRels = new Set<string>();
  if (want('kind') || want('status') || want('priority') || want('author')) {
    outRels.add('has_kind');
    outRels.add('has_status');
    outRels.add('has_priority');
    outRels.add('authored_by');
  }
  if (want('citations')) outRels.add('has_citation');
  if (want('notes')) outRels.add('has_note');
  if (want('auditTrail')) outRels.add('audits');
  if (want('related')) {
    for (const rel of ['relates_to', 'part_of', 'blocks']) {
      outRels.add(rel);
      inRels.add(rel);
    }
  }
  if (want('blockers')) inRels.add('blocks');
  if (want('blocksOut') || want('dependents')) outRels.add('blocks');
  if (want('partOf')) outRels.add('part_of');
  if (want('obligations')) outRels.add('has_obligation');
  if (want('similar')) {
    outRels.add('similar_to');
    inRels.add('similar_to');
  }

  const outgoingBySrc = new Map<number, EdgeRecord[]>();
  const incomingByDst = new Map<number, EdgeRecord[]>();
  const push = (
    m: Map<number, EdgeRecord[]>,
    key: number,
    edge: EdgeRecord
  ): void => {
    const list = m.get(key);
    if (list) list.push(edge);
    else m.set(key, [edge]);
  };
  // e54afd3f AC-C1: two page-keyed reads (never a whole-relation
  // `getEdges({rel})`). The store returns `(src, rel, rowid)` /
  // `(dst, rel, rowid)` order — exactly the per-key order the indexed
  // single-key reads yield — so appending in row order reproduces the old
  // per-relation-ascending grouping byte-for-byte. `rels` narrows to the
  // relations the requested fields need, so the maps hold the same rows the
  // whole-relation path put there.
  const pageIdList = [...pageIds];
  if (outRels.size > 0) {
    const outgoing = await graph.getEdges({
      srcs: pageIdList,
      rels: [...outRels].sort(),
    });
    for (const e of outgoing) push(outgoingBySrc, e.src, e);
  }
  if (inRels.size > 0) {
    const incoming = await graph.getEdges({
      dsts: pageIdList,
      rels: [...inRels].sort(),
    });
    for (const e of incoming) push(incomingByDst, e.dst, e);
  }

  const neighbourIds = new Set<number>();
  for (const list of outgoingBySrc.values())
    for (const e of list) neighbourIds.add(e.dst);
  for (const list of incomingByDst.values())
    for (const e of list) neighbourIds.add(e.src);

  const nodeById = new Map<number, NodeRecord>();
  if (neighbourIds.size > 0) {
    const nodes = await graph.getNodesByIds([...neighbourIds]);
    for (const n of nodes) nodeById.set(n.id, n);
  }
  const statusByNodeId = await resolveStatusesFor(graph, [...nodeById.values()]);

  const blocksOutAdj = new Map<number, readonly number[]>();
  if (want('dependents')) {
    for (const [src, list] of outgoingBySrc) {
      const dsts: number[] = [];
      for (const e of list) if (e.rel === 'blocks' && e.src === src) dsts.push(e.dst);
      blocksOutAdj.set(src, dsts);
    }
  }

  const placementByNodeId = new Map<
    number,
    { component?: NodeRecord; project?: NodeRecord }
  >();
  if (
    want('project') ||
    want('component') ||
    want('similar')
  ) {
    const targets = new Set<number>([...pageIds, ...neighbourIds]);
    // `owns_component: component → issue` (component is the SOURCE); the
    // component that owns a node is the `src` of the edge into it.
    const compIdByNode = new Map<number, number>();
    for (const e of await graph.getEdges({
      dsts: [...targets],
      rel: 'owns_component',
    })) {
      if (!compIdByNode.has(e.dst)) compIdByNode.set(e.dst, e.src);
    }
    const compIds = new Set([...compIdByNode.values()]);
    // `owns_project: project → component` (project is the SOURCE); the project
    // that owns a component is the `src` of the edge into it.
    const projIdByComp = new Map<number, number>();
    for (const e of compIds.size === 0
      ? []
      : await graph.getEdges({ dsts: [...compIds], rel: 'owns_project' })) {
      if (!projIdByComp.has(e.dst)) projIdByComp.set(e.dst, e.src);
    }
    const placeIds = new Set<number>([
      ...compIds,
      ...projIdByComp.values(),
    ]);
    const placeById = new Map<number, NodeRecord>();
    if (placeIds.size > 0) {
      for (const n of await graph.getNodesByIds([...placeIds]))
        placeById.set(n.id, n);
    }
    for (const [nodeId, compId] of compIdByNode) {
      const component = placeById.get(compId);
      if (!component) continue;
      const projId = projIdByComp.get(compId);
      const project = projId === undefined ? undefined : placeById.get(projId);
      placementByNodeId.set(nodeId, project ? { component, project } : { component });
    }
  }

  return {
    outgoingBySrc,
    incomingByDst,
    nodeById,
    statusByNodeId,
    blocksOutAdj,
    placementByNodeId,
  };
}

/** Batch-assemble cards for a page of issue nodes. Every edge pseudo-field
 * (`blockers`/`partOf`/`related`/`blocksOut`/`dependents`/`obligations`/
 * `similar`) and the catalog/placement reads resolve from ONE page-level
 * prefetch ({@link buildPageReadBatch}) — a bounded number of store round trips
 * independent of page size — instead of the previous per-item (N+1) fan-out.
 * Output is byte-for-byte unchanged: the batch groups the same live edges and
 * nodes the per-item resolvers read, in the same order.
 *
 * The page's own node ids are handed to each card as the `dependents` walk's
 * `scope` (C2): a list read bounds each transitive-dependent count to the page
 * it is rendering, so an N-item page costs N bounded walks rather than N walks
 * over the whole `blocks` graph. A single `get` (which calls
 * {@link assembleIssueCard} directly, not this function) leaves the walk
 * unbounded but cycle-safe. `scope` is inert unless `fields` requests
 * `dependents`. */
export async function assembleIssueCards(
  graph: GraphBackend,
  issues: NodeRecord[],
  fields: readonly IIssueField[],
  scoreByUid?: ReadonlyMap<string, number>,
  scoreKindByUid?: ReadonlyMap<string, IScoreKind>,
  verdictOpts?: { rung?: IVerdictRung; onRung?: (rung: number) => void }
): Promise<IIssueCard[]> {
  const scope = new Set(issues.map((i) => i.id));
  const batch =
    issues.length > 0
      ? await buildPageReadBatch(
          graph,
          issues.map((i) => i.id),
          fields
        )
      : undefined;
  return Promise.all(
    issues.map((issue) =>
      assembleIssueCard(graph, issue, fields, {
        score: scoreByUid?.get(issue.uid),
        scoreKind: scoreKindByUid?.get(issue.uid),
        scope,
        ...(batch ? { batch } : {}),
        ...(verdictOpts?.rung !== undefined
          ? { verdictRung: verdictOpts.rung }
          : {}),
        ...(verdictOpts?.onRung !== undefined
          ? { onVerdictRung: verdictOpts.onRung }
          : {}),
      })
    )
  );
}
