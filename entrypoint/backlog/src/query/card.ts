/**
 * card.ts — assembling a field-projected {@link IIssueCard} from a live
 * `issue` `NodeRecord` (SPEC.md §6.5).
 *
 * One issue card costs, in the worst case (every pseudo field requested):
 * one `getEdges({src: issueId})` (covers `has_kind`/`has_status`/
 * `has_priority`/`authored_by`/`has_note`/`has_citation`/`has_transition`/
 * `audits`/`relates_to`/`supersedes`/`duplicate_of`/`part_of`/`blocks` in one
 * round trip), one `getEdges({dst: issueId, rel:'owns_component'})` +
 * `getEdges({dst: componentId, rel:'owns_project'})` for placement, and one
 * `getNodesByIds` batch covering every distinct target rowid collected above
 * — never one query per field. The DEFAULT five-field card
 * (`uid,kind,title,status,priority`) costs exactly the first `getEdges` call
 * plus one batched `getNodesByIds` — no placement traversal, no pseudo-field
 * reads.
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
  ISSUE_PLAIN_FIELDS,
  ISSUE_PSEUDO_FIELDS,
  isKnownIssueField,
} from './types.js';
import { BacklogValidationError } from '../write/errors.js';
import {
  getIncomingEdges,
  getOutgoingEdges,
  resolveIssuePlacement,
} from './resolve.js';

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
 * Resolve the `n:1` catalog edges every issue carries (`has_kind`/
 * `has_status`/`has_priority`/`authored_by`) from one already-fetched
 * `getEdges({src: issueId})` result, batching the target reads into one
 * `getNodesByIds` call.
 */
async function resolveCatalogTargets(
  graph: GraphBackend,
  issueId: number,
  outgoing: EdgeRecord[]
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
  const nodes = await graph.getNodesByIds(ids);
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
  outgoing: EdgeRecord[]
): Promise<IIssueCitation[]> {
  const edges = outgoing.filter(
    (e) => e.rel === 'has_citation' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
  return nodes.map((n) => ({
    uid: n.uid,
    file:
      typeof n.metadata?.target === 'string' ? n.metadata.target : n.name ?? '',
    lines: typeof n.metadata?.line === 'string' ? n.metadata.line : undefined,
    context: n.content || undefined,
    symbol:
      typeof n.metadata?.symbol === 'string' ? n.metadata.symbol : undefined,
    sha: typeof n.metadata?.sha === 'string' ? n.metadata.sha : 'unverified',
    at: typeof n.metadata?.at === 'string' ? n.metadata.at : n.tCreated,
  }));
}

async function resolveNotes(
  graph: GraphBackend,
  issueId: number,
  outgoing: EdgeRecord[]
): Promise<IIssueNote[]> {
  const edges = outgoing.filter(
    (e) => e.rel === 'has_note' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
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
  outgoing?: EdgeRecord[]
): Promise<IIssueAuditEntry[]> {
  const edges = (outgoing ?? (await getOutgoingEdges(graph, issueId))).filter(
    (e) => e.rel === 'audits' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const nodes = await graph.getNodesByIds(edges.map((e) => e.dst));
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
  issueId: number
): Promise<IIssueRef[]> {
  const incoming = await graph.getEdges({ dst: issueId, rel: 'blocks' });
  if (incoming.length === 0) return [];
  const blockerIds = incoming.map((e) => e.src);
  const blockers = await graph.getNodesByIds(blockerIds);
  const statuses = await resolveStatusesFor(graph, blockers);
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
  outgoing?: EdgeRecord[]
): Promise<IIssueRef[]> {
  const out = outgoing ?? (await getOutgoingEdges(graph, issueId));
  const incoming = await getIncomingEdges(graph, issueId);

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
  const others = await graph.getNodesByIds([...relById.keys()]);
  const statuses = await resolveStatusesFor(graph, others);
  return others.map((n) => ({
    uid: n.uid,
    title: n.name ?? '',
    status: statuses.get(n.id)?.name ?? '',
    rel: relById.get(n.id),
  }));
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
  outgoing?: EdgeRecord[]
): Promise<IIssueRef[]> {
  const edges = (outgoing ?? (await getOutgoingEdges(graph, issueId))).filter(
    (e) => e.rel === 'blocks' && e.src === issueId
  );
  if (edges.length === 0) return [];
  const targets = await graph.getNodesByIds(edges.map((e) => e.dst));
  if (targets.length === 0) return [];
  const statuses = await resolveStatusesFor(graph, targets);
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
  scope?: ReadonlySet<number>
): Promise<number> {
  const visited = new Set<number>();
  const queue: number[] = [issueId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const edges = await graph.getEdges({ src: id, rel: 'blocks' });
    for (const e of edges) {
      if (e.dst === issueId || visited.has(e.dst)) continue;
      if (scope && !scope.has(e.dst)) continue;
      visited.add(e.dst);
      queue.push(e.dst);
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
  outgoing?: EdgeRecord[]
): Promise<IIssueRef | null> {
  const edge = (outgoing ?? (await getOutgoingEdges(graph, issueId))).find(
    (e) => e.rel === 'part_of' && e.src === issueId
  );
  if (!edge) return null;
  const [parent] = await graph.getNodesByIds([edge.dst]);
  if (!parent) return null;
  const statuses = await resolveStatusesFor(graph, [parent]);
  return {
    uid: parent.uid,
    title: parent.name ?? '',
    status: statuses.get(parent.id)?.name ?? '',
    rel: 'part_of',
  };
}

/**
 * Batch-resolve `has_status` targets for a set of issue nodes — one
 * `getEdges({rel:'has_status'})` covering every `has_status` edge in the
 * store, filtered down to `issues` in memory, plus one `getNodesByIds` for
 * the distinct status targets. `getEdges` only accepts a single `src`/`dst`
 * (see `queryReady` in `query.ts` for the same relation-wide-fetch pattern),
 * so a per-issue `getEdges({src, rel})` call — even fired concurrently via
 * `Promise.all` — is still N round trips to the backend, not the constant
 * number this function promises its callers.
 */
async function resolveStatusesFor(
  graph: GraphBackend,
  issues: NodeRecord[]
): Promise<Map<number, NodeRecord>> {
  if (issues.length === 0) return new Map();
  const issueIds = new Set(issues.map((i) => i.id));
  const edges = await graph.getEdges({ rel: 'has_status' });
  const statusEdgeByIssue = new Map<number, number>();
  for (const e of edges) {
    if (issueIds.has(e.src) && !statusEdgeByIssue.has(e.src))
      statusEdgeByIssue.set(e.src, e.dst);
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
  /** Pre-fetched outgoing edges (`getEdges({src: issue.id})`) — pass when the caller already has them (e.g. a batch `query` page) to avoid a redundant round trip. */
  outgoingEdges?: EdgeRecord[];
  /**
   * The candidate id set a `dependents` walk is bounded to (C2). A list page
   * passes its own page id set so an N-item page costs N bounded walks; a
   * single `get` omits it, leaving the walk unbounded (but cycle-safe). Only
   * consulted when `fields` requests `dependents`.
   */
  scope?: ReadonlySet<number>;
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

  const outgoing =
    opts.outgoingEdges ??
    (needsCatalogTargets ||
    needsCitations ||
    needsNotes ||
    needsAuditTrail ||
    needsRelated ||
    needsBlocksOut ||
    needsPartOf
      ? await getOutgoingEdges(graph, issue.id)
      : undefined);

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
    const targets = await resolveCatalogTargets(graph, issue.id, outgoing);
    if (want('kind') && targets.kind) card.kind = targets.kind.name ?? '';
    if (want('status') && targets.status)
      card.status = targets.status.name ?? '';
    if (want('priority') && targets.priority)
      card.priority = targets.priority.name ?? '';
    if (want('author') && targets.author)
      card.author = targets.author.name ?? '';
  }

  if (needsPlacement) {
    const { project, component } = await resolveIssuePlacement(graph, issue.id);
    if (want('project') && project) card.project = project.uid;
    if (want('component') && component) card.component = component.uid;
  }

  if (needsCitations && outgoing)
    card.citations = await resolveCitations(graph, issue.id, outgoing);
  if (needsNotes && outgoing)
    card.notes = await resolveNotes(graph, issue.id, outgoing);
  if (needsAuditTrail && outgoing)
    card.auditTrail = await resolveAuditTrail(graph, issue.id, outgoing);
  if (needsBlockers) card.blockers = await resolveBlockers(graph, issue.id);
  if (needsRelated && outgoing)
    card.related = await resolveRelated(graph, issue.id, outgoing);
  if (needsBlocksOut && outgoing)
    card.blocksOut = await resolveBlocksOut(graph, issue.id, outgoing);
  if (needsDependents)
    card.dependents = await resolveDependents(graph, issue.id, opts.scope);
  if (needsPartOf && outgoing)
    card.partOf = await resolvePartOf(graph, issue.id, outgoing);

  if (want('_score') && opts.score !== undefined) card._score = opts.score;
  // `_vector` (§6.5's pseudo field) only exists on a raw vector-search response, which this
  // card assembler never sees directly (StoreSearchBackend.searchRanked returns fused
  // SearchResult, not the raw embedding) — never populated here; a future embedding-surfacing
  // slice would thread it through IAssembleIssueCardOptions exactly like `score` above.

  return card;
}

/** Batch-assemble cards for a page of issue nodes, sharing one `getNodesByIds`-batched catalog/placement resolution pass where possible. Falls back to per-issue assembly (still batches internally) — a cross-issue batch would require a different, `getEdges`-list API this file's dependency (`GraphBackend`) does not expose.
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
  scoreByUid?: ReadonlyMap<string, number>
): Promise<IIssueCard[]> {
  const scope = new Set(issues.map((i) => i.id));
  return Promise.all(
    issues.map((issue) =>
      assembleIssueCard(graph, issue, fields, {
        score: scoreByUid?.get(issue.uid),
        scope,
      })
    )
  );
}
