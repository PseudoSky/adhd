/**
 * resolve.ts — read-only (non-transactional) uid/name resolution and edge
 * traversal (SPEC.md §5, §6.1, §6.5).
 *
 * **Why this file is safe to build directly on `GraphBackend`, unlike
 * `write/tx.ts`.** SPEC.md §4c's hand-composed-SQL rule exists ONLY because a
 * write verb needs to observe ITS OWN transaction's uncommitted state
 * (check-then-act inside one `BEGIN IMMEDIATE`) — `writeNode`/`writeEdge`/
 * `invalidateEdge`/`getNodeByUid` all run against the bare adapter and would
 * autocommit outside an open `tx`, which is a correctness hazard ONLY when a
 * verb is composing a multi-statement write around them. A pure READ that
 * never opens a transaction of its own has no such hazard: `queryNodes`/
 * `getNodesByIds`/`getEdges`/`getNodeByUid`/`searchNodes`/`countBy` are the
 * library's OWN read surface (`GraphBackend`, `@adhd/sox-graph-store`
 * `dist/index.d.ts:279-334`), already committed-state-consistent by
 * definition (the store adapter serves a read against the latest committed
 * snapshot), and every one of them is written to run standalone. This module
 * therefore calls them directly — never the `tx.ts` hand-composed forms,
 * which exist for a different, transaction-scoped problem this file does not
 * have.
 *
 * **Why this module exists at all — reuse across `get`/`query` AND the six
 * sibling write verbs.** `update`/`transition`/`claim`/`relate`/`move`/
 * `delete` all need, post-commit, to re-resolve a `uid` → node, resolve a
 * catalog/project/component reference on a READ path (e.g. a `filter`
 * parameter, never inside their own `immediate` transaction), or read a
 * node's edges to assemble the `IIssueCard` their own outcome shape returns
 * (SPEC.md §6.3's outcome interfaces all embed card-shaped fields). Rather
 * than each of the six re-implement this resolution logic against the bare
 * `GraphBackend`, they import it from here — the SAME functions `get.ts`/
 * `query.ts` use for the read verbs proper.
 */

import type {
  EdgeRecord,
  GraphBackend,
  NodeRecord,
} from '@adhd/sox-graph-store';
import {
  BacklogValidationError,
  CatalogNotFoundError,
  StaleSupersedeError,
} from '../write/errors.js';
import { isUidShaped } from '../write/catalog.js';
import { followRedirect } from './redirect.js';
import {
  classifyUidRef,
  isUidPrefixShaped,
  missingUidError,
  queryLiveUidPrefixCandidates,
  selectUniqueUidCandidate,
  tooShortUidError,
} from '../write/uid-prefix.js';

export { isUidShaped };

/** A resolved catalog/registry row, read-only. */
export interface IResolvedRef {
  id: number;
  uid: string;
  name: string;
  record: NodeRecord;
}

/**
 * The shared core of uid resolution on the READ path: exact match, else a
 * UNIQUE uid prefix (via `write/uid-prefix.ts`'s candidate query). Returns
 * `null` when nothing live matches the expected kind — the caller decides
 * whether that is a hard error ({@link resolveUidPrefix}) or an
 * unresolved-name fallback ({@link tryResolveUidPrefix}). A prefix matching
 * two or more live nodes throws `AmbiguousReferenceError` from
 * {@link selectUniqueUidCandidate}, naming every candidate; it never
 * auto-selects.
 *
 * The prefix candidate read runs inside a read-only `graph.transaction`, which
 * is the only way to issue raw SQL through a `GraphBackend` without reaching
 * into its private adapter (`GraphTransaction` is a documented structural
 * superset of the raw transaction surface).
 */
async function resolveUidPrefixImpl(
  graph: GraphBackend,
  ref: string,
  expectedKind: string | undefined
): Promise<NodeRecord | null> {
  const exact = await graph.getNodeByUid(ref);
  if (exact) {
    if (
      exact.tInvalid !== undefined ||
      (expectedKind !== undefined && exact.kind !== expectedKind)
    ) {
      return null;
    }
    return exact;
  }

  if (classifyUidRef(ref) !== 'prefix') return null;

  const candidates = await graph.transaction((tx) =>
    queryLiveUidPrefixCandidates(tx, ref)
  );
  const narrowed =
    expectedKind !== undefined
      ? candidates.filter((c) => c.kind === expectedKind)
      : candidates;
  const chosen = selectUniqueUidCandidate(ref, narrowed);
  if (!chosen) return null;

  const record = await graph.getNodeByUid(chosen.uid);
  return record && record.tInvalid === undefined ? record : null;
}

/**
 * Resolve `ref` to exactly one LIVE node, by exact uid or by a UNIQUE uid
 * prefix. Exact match is the fast path and always wins.
 *
 * Errors: `AmbiguousReferenceError` when a prefix matches ≥2 live nodes (the
 * candidates are carried on the error and named in its message);
 * `IssueNotFoundError` (kind `issue`) / `CatalogNotFoundError` (any other
 * kind) when an exact uid or prefix matches nothing; `InvalidArgumentError`
 * when `ref` is a uid attempt shorter than the minimum prefix length.
 */
export async function resolveUidPrefix(
  graph: GraphBackend,
  ref: string,
  opts?: { expectedKind?: string }
): Promise<NodeRecord> {
  if (classifyUidRef(ref) === 'too-short') throw tooShortUidError(ref);
  const record = await resolveUidPrefixImpl(graph, ref, opts?.expectedKind);
  if (!record) {
    throw missingUidError(
      opts?.expectedKind,
      ref,
      classifyUidRef(ref) === 'prefix'
    );
  }
  return record;
}

/**
 * Like {@link resolveUidPrefix}, but `null` instead of a not-found error when
 * nothing matches — for callers that treat a uid miss as "fall through to a
 * name lookup." An AMBIGUOUS prefix still throws (never silently picks one),
 * and a too-short uid attempt returns `null` so a genuine short business name
 * is not swallowed.
 */
export async function tryResolveUidPrefix(
  graph: GraphBackend,
  ref: string,
  opts?: { expectedKind?: string }
): Promise<NodeRecord | null> {
  if (classifyUidRef(ref) === 'too-short') return null;
  return resolveUidPrefixImpl(graph, ref, opts?.expectedKind);
}

/**
 * Resolve `uid` → the live `issue` node, or throw {@link IssueNotFoundError}
 * (SPEC.md §6.1: "a `uid` with no matching live node throws
 * `IssueNotFoundError(uid)`"). This is the READ-PATH counterpart of
 * `write/tx.ts`'s `getNodeByUidTx` — safe to call standalone because it is
 * not composing a check-then-act write around the result.
 *
 * Accepts an exact uid or a UNIQUE uid prefix (see {@link resolveUidPrefix});
 * a superseded node — whether reached by exact uid or prefix — throws the same
 * {@link StaleSupersedeError} pointing at the chain head.
 */
export async function resolveIssueByUid(
  graph: GraphBackend,
  uid: string
): Promise<NodeRecord> {
  const record = await resolveUidPrefix(graph, uid, { expectedKind: 'issue' });
  if (record.isSuperseded) {
    throw new StaleSupersedeError(uid, await currentUidOf(graph, record));
  }
  return record;
}

/**
 * Resolve a token to the LOGICAL node it names TODAY: follow a one-hop merge
 * redirect (C1's soft-retired project/component rows), then walk the
 * `SUPERSEDES` chain to its head. NEVER throws on a superseded uid — that is
 * the whole point of the split from {@link resolveIssueByUid}, which throws
 * `StaleSupersedeError` because its callers (`get`, `card` blockers, `stats`)
 * want to be told a reference is stale, not silently forwarded.
 *
 * This is the non-throwing resolver C3's attestation `subject.id` uses: an
 * attestation written against a uid that a later body-edit superseded must
 * still name the SAME logical item, and a caller holding a stale citation
 * wants today's issue, not the next-oldest corpse.
 *
 * Delegates the chain walk to {@link currentUidOf} rather than re-implementing
 * it (ADR-0002 — one concept, one implementation). Returns the head
 * `NodeRecord`; when the chain dead-ends with no live successor it returns the
 * node it started from, which is the most useful answer available.
 */
export async function resolveLogicalIssue(
  graph: GraphBackend,
  ref: string
): Promise<NodeRecord> {
  const record = await resolveUidPrefix(graph, ref);
  const redirected = await followRedirect(graph, record);
  const current = redirected ?? record;
  if (!current.isSuperseded) return current;

  const headUid = await currentUidOf(graph, current);
  if (headUid === undefined) return current;
  const head = await graph.getNodeByUid(headUid);
  return head && head.tInvalid === undefined ? head : current;
}

/**
 * Walk the `SUPERSEDES` chain forward from a superseded node to the uid the
 * issue lives under NOW.
 *
 * `update`'s body path mints a new node and writes `SUPERSEDES` new→old, so
 * the successor of a node is the `src` of the edge whose `dst` is that node —
 * the reverse of the direction the edge reads. Repeated edits build a chain,
 * and a uid cited before several edits is several hops back, so this follows
 * the chain to its head rather than stopping at the first hop: a caller
 * holding a stale citation wants today's issue, not the next-oldest corpse.
 *
 * Defensive, because this runs on an error path that must not itself throw:
 * a cycle (impossible by construction, since each edit mints a fresh node,
 * but not enforced by a constraint) is bounded by `seen`; a missing or
 * invalidated successor ends the walk and yields the last good uid, and a
 * chain that dead-ends immediately yields `undefined` — which
 * {@link StaleSupersedeError} documents as "not known here".
 */
export async function currentUidOf(
  graph: GraphBackend,
  superseded: NodeRecord
): Promise<string | undefined> {
  const seen = new Set<number>([superseded.id]);
  let head: NodeRecord | undefined;
  let cursor = superseded;

  for (;;) {
    const incoming = await graph.getEdges({
      dst: cursor.id,
      rel: 'SUPERSEDES',
    });
    const next = incoming.find((e) => !seen.has(e.src));
    if (!next) return head?.uid;

    seen.add(next.src);
    const successor = (await graph.getNodesByIds([next.src]))[0];
    // A successor that is missing or soft-deleted ends the walk: the last
    // LIVE node we reached is still the most useful answer we have.
    if (!successor || successor.tInvalid) return head?.uid;

    head = successor;
    // The head of the chain is the one node that is not itself superseded.
    if (!successor.isSuperseded) return successor.uid;
    cursor = successor;
  }
}

/**
 * Resolve `ref` (uid or name, disambiguated by shape — SPEC.md §6.1) against
 * `expectedKind`, on the READ path: an unresolved NAME is never an error here
 * (unlike the write-path `mintOrResolveCatalogTx`) — SPEC.md §6.1's own read-
 * path rule: "an unresolved `name` is not an error; it resolves to zero
 * matches." Callers that need read-path "resolve or throw" semantics (e.g.
 * `get`'s `project`/`component` display resolution once an issue's edges are
 * already known to exist) use {@link resolveRefOrThrow} instead.
 */
export async function tryResolveRef(
  graph: GraphBackend,
  expectedKind: string,
  ref: string
): Promise<IResolvedRef | null> {
  if (isUidShaped(ref) || isUidPrefixShaped(ref)) {
    const record = await tryResolveUidPrefix(graph, ref, { expectedKind });
    if (record) {
      return { id: record.id, uid: record.uid, name: record.name ?? ref, record };
    }
    // A full uid that matches nothing is NOT a business name — never fall
    // through. A prefix-shaped ref with no uid match MAY be a genuine
    // business name that happens to read as hex, so it falls through.
    if (isUidShaped(ref)) return null;
  }
  const matches = await graph.queryNodes({
    kind: expectedKind,
    name: ref,
    liveOnly: true,
    limit: 1,
  });
  const record = matches[0];
  if (record) {
    return { id: record.id, uid: record.uid, name: record.name ?? ref, record };
  }
  // C1 (AC5) — a soft-RETIRED project/component's old name must still resolve
  // to its canonical survivor via a ONE-HOP redirect. This runs ONLY after the
  // live-name lookup missed, so it can never change the result of a name that
  // resolves to a live row (the blast-radius audit condition on `tryResolveRef`).
  // The retired row is `t_invalid`-stamped, so it is invisible to every list
  // view; it is reachable here by name, and `followRedirect` hands back the
  // live survivor (a redirect→redirect chain throws, never chains silently).
  if (expectedKind === 'project' || expectedKind === 'component') {
    const retired = await graph.queryNodes({
      kind: expectedKind,
      name: ref,
      liveOnly: false,
      metadata: { redirectTo: { exists: true } },
      limit: 5,
    });
    for (const row of retired) {
      const target = await followRedirect(graph, row);
      if (target) {
        return {
          id: target.id,
          uid: target.uid,
          name: target.name ?? ref,
          record: target,
        };
      }
    }
  }
  return null;
}

/** Like {@link tryResolveRef}, but throws {@link CatalogNotFoundError} on a miss — for call sites that need "this reference must already exist." */
export async function resolveRefOrThrow(
  graph: GraphBackend,
  expectedKind: string,
  ref: string
): Promise<IResolvedRef> {
  const resolved = await tryResolveRef(graph, expectedKind, ref);
  if (!resolved) throw new CatalogNotFoundError(expectedKind, ref);
  return resolved;
}

/** `component`, scoped within `project` (SPEC.md §6.1) — read path, `component.meta.metadata.projectUid` must match. */
export async function tryResolveComponentRef(
  graph: GraphBackend,
  projectUid: string,
  ref: string
): Promise<IResolvedRef | null> {
  if (isUidShaped(ref) || isUidPrefixShaped(ref)) {
    const resolved = await tryResolveRef(graph, 'component', ref);
    if (!resolved || resolved.record.metadata?.projectUid !== projectUid)
      return null;
    return resolved;
  }
  const matches = await graph.queryNodes({
    kind: 'component',
    name: ref,
    liveOnly: true,
    metadata: { projectUid: { eq: projectUid } },
    limit: 1,
  });
  const record = matches[0];
  if (!record) return null;
  return { id: record.id, uid: record.uid, name: record.name ?? ref, record };
}

/** The single live edge of `rel` FROM `srcId` (SPEC.md §3's `n:1` rels — `has_kind`/`has_status`/`has_priority`/`authored_by`), or `null` when none exists. */
export function pickSingleEdge(
  edges: EdgeRecord[],
  rel: string,
  srcId: number
): EdgeRecord | undefined {
  return edges.find((e) => e.rel === rel && e.src === srcId);
}

/**
 * All edges ORIGINATING at `nodeId` — a single `getEdges({src})` call covers
 * every `n:1`/`1:n` outgoing rel an issue carries (`has_kind`/`has_status`/
 * `has_priority`/`authored_by`/`has_note`/`has_citation`/`has_transition`/
 * `audits`/`relates_to`/`supersedes`/`duplicate_of`/`part_of`/`blocks`) —
 * cheaper than one `getEdges` call per rel.
 */
export function getOutgoingEdges(
  graph: GraphBackend,
  nodeId: number
): Promise<EdgeRecord[]> {
  return graph.getEdges({ src: nodeId });
}

/** All edges TARGETING `nodeId` — used for the reverse traversals (`owns_component`'s issue→component lookup, `blocks`'s incoming-blocker lookup, `duplicate_of`'s incoming lookup). */
export function getIncomingEdges(
  graph: GraphBackend,
  nodeId: number
): Promise<EdgeRecord[]> {
  return graph.getEdges({ dst: nodeId });
}

/**
 * The component that owns `issueId` (SPEC.md §3: `owns_component: component →
 * issue (1:n)`) and, one hop further, the project that owns that component
 * (`owns_project: project → component (1:n)`). Every live issue has exactly
 * one of each (§8 AC-23), so this returns `undefined` only for a
 * pre-invariant / corrupted row, never as an expected steady-state case.
 */
export async function resolveIssuePlacement(
  graph: GraphBackend,
  issueId: number
): Promise<{ component?: NodeRecord; project?: NodeRecord }> {
  const ownsComponentEdges = await graph.getEdges({
    dst: issueId,
    rel: 'owns_component',
  });
  const componentId = ownsComponentEdges[0]?.src;
  if (componentId === undefined) return {};
  const [component] = await graph.getNodesByIds([componentId]);
  if (!component) return {};

  const ownsProjectEdges = await graph.getEdges({
    dst: componentId,
    rel: 'owns_project',
  });
  const projectId = ownsProjectEdges[0]?.src;
  if (projectId === undefined) return { component };
  const [project] = await graph.getNodesByIds([projectId]);
  return { component, project };
}

/**
 * Resolve an edge-scoped filter value (SPEC.md §6.5 rule 3: `kind`/`status`/
 * `priority`/`project`/`component`/`author` live on EDGES, not `NodeFilter`
 * columns) to the set of candidate issue rowids satisfying it.
 *
 * **Direction is looked up, not assumed.** The six edge-scoped dimensions do
 * NOT all run the same way: `has_kind`/`has_status`/`has_priority`/
 * `authored_by` point issue → catalog (the catalog node is the edge TARGET),
 * while `owns_project`/`owns_component` point catalog → child (the catalog
 * node is the edge SOURCE). This function previously hard-coded the first
 * shape — `getEdges({dst: resolved.id, rel})` collecting `src` — for all six,
 * so calling it for `project`/`component` looked for edges INTO a component
 * when every real `owns_component` edge points OUT of it, and it silently
 * returned an EMPTY set for a component that genuinely owned issues. Silent,
 * because an empty candidate set is indistinguishable from "nothing matched."
 *
 * `views/semantic.ts` worked around this by hand-composing its own
 * source-directed traversal for those two dimensions and reusing this
 * function only for the four it got right, flagging in its own header that
 * "a future caller who takes that doc comment at face value for
 * component/project will reproduce this exact miss." That is now fixed at
 * source instead: the `edge_kind` row for `rel` carries `source_kind`/
 * `target_kind` (the same rows `resolveEdgeKindTx` reads on the write path),
 * so the traversal direction is derived from the data rather than assumed,
 * and stays correct for any rel added later.
 *
 * Returns `undefined` (never an empty array) when `ref` does not resolve to
 * any live catalog/registry row — SPEC.md §6.1's read-path rule ("an
 * unresolved name is not an error; it resolves to zero matches") is realized
 * by the CALLER treating `undefined` as "this filter can never match
 * anything," short-circuiting the whole query to an empty page rather than
 * querying with a meaningless empty `ids: []` (which `NodeFilter.ids` would
 * otherwise interpret as "no restriction" on some backends — never rely on
 * that ambiguity here).
 */
export async function resolveEdgeScopedCandidates(
  graph: GraphBackend,
  input: { rel: string; expectedKind: string; ref: string; projectUid?: string }
): Promise<Set<number> | undefined> {
  const resolved =
    input.expectedKind === 'component' && input.projectUid !== undefined
      ? await tryResolveComponentRef(graph, input.projectUid, input.ref)
      : await tryResolveRef(graph, input.expectedKind, input.ref);
  if (!resolved) return undefined;

  if (await relIsSourceDirected(graph, input.rel, input.expectedKind)) {
    // Catalog node is the edge SOURCE (`owns_project`/`owns_component`):
    // walk OUT of it and collect the children.
    const edges = await graph.getEdges({ src: resolved.id, rel: input.rel });
    return new Set(edges.map((e) => e.dst));
  }
  const edges = await graph.getEdges({ dst: resolved.id, rel: input.rel });
  return new Set(edges.map((e) => e.src));
}

/**
 * True when `rel`'s declared `source_kind` is `expectedKind` — i.e. the
 * catalog/registry node sits at the edge's SOURCE and the issues hang off its
 * target side.
 *
 * Reads the `edge_kind` catalog row (`kind:'edge_kind'`, `name: rel`, with
 * `source_kind`/`target_kind` in its metadata) — the same rows the write
 * path's `resolveEdgeKindTx` consults, so read and write cannot drift apart
 * on direction. An absent row falls back to `false`, preserving the
 * issue→catalog default that the four `has_*`/`authored_by` rels use.
 */
async function relIsSourceDirected(
  graph: GraphBackend,
  rel: string,
  expectedKind: string
): Promise<boolean> {
  const rows = await graph.queryNodes({
    kind: 'edge_kind',
    name: rel,
    liveOnly: true,
    limit: 1,
  });
  const meta = rows[0]?.metadata as Record<string, unknown> | undefined;
  return (
    typeof meta?.['source_kind'] === 'string' &&
    meta['source_kind'] === expectedKind
  );
}

// ---------------------------------------------------------------------------
// BUG-BACKLOG-QUERY-UNKNOWN-FILTER-SILENT-001 — validating `kind`/`status`/
// `priority` filter values against the catalog's own live rows.
//
// `kind`/`status`/`priority` are OPEN string vocabularies (DATA_MODEL.md
// §0.2/§2) — there is no fixed enum to `assertKnown*` a filter value against,
// unlike `IIssueField`. But they are NOT unbounded either: each one's real
// value space is exactly the set of live catalog rows of that kind. A filter
// value that matches NO live row (neither by uid nor by name) is a typo, not
// a legitimate "no issues currently have this value" read — and previously
// both cases returned the byte-identical `{total:0, items:[]}`, with zero
// signal to the caller which one happened. `query.ts`'s `queryList`/
// `queryReady`/`queryStale`/`queryGraph`/`queryOrder` (via
// `resolveEdgeScopedFilterIds`) AND `views/semantic.ts`'s `view:'similar'`
// (via `resolveSimilarFilterIds`) share this ONE validation so the two read
// paths cannot silently diverge on which filter values are "real."
// ---------------------------------------------------------------------------

/** Every live catalog row's `name` for a given open-vocabulary catalog kind — used only to VALIDATE a filter value against what genuinely exists, never to constrain what a caller may create. */
export async function fetchCatalogNames(
  graph: GraphBackend,
  catalogKind: 'kind' | 'status' | 'priority'
): Promise<string[]> {
  const rows = await graph.queryNodes({ kind: catalogKind, liveOnly: true });
  return rows
    .map((r) => r.name)
    .filter((n): n is string => typeof n === 'string');
}

/** Plain Levenshtein edit distance — small, dependency-free, and cheap enough for a typically single/low-double-digit-row catalog. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Nearest-name suggestions for an unresolved filter value — case-insensitive
 * edit distance over the catalog's OWN live names, bounded to a distance
 * proportional to the typo'd value's own length so an unrelated short
 * catalog name is never suggested for a long, clearly-different value.
 * Sorted nearest-first, capped at `max`.
 */
export function suggestClosestCatalogNames(
  value: string,
  candidates: readonly string[],
  max = 3
): string[] {
  const threshold = Math.max(2, Math.ceil(value.length / 2));
  return candidates
    .map((candidate) => ({
      candidate,
      distance: levenshteinDistance(value.toLowerCase(), candidate.toLowerCase()),
    }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, max)
    .map((entry) => entry.candidate);
}

/**
 * Resolves a multi-valued `kind`/`status`/`priority` filter dimension
 * (OR-union across `refs`), rejecting with a `BacklogValidationError` naming
 * every ref that matches NO live catalog row of that kind — see this
 * section's top doc comment for the full rationale. Never rejects a ref that
 * resolves to a real row with zero owning issues; that still contributes an
 * empty set exactly as a plain unresolved-name read would.
 */
export async function resolveValidatedCatalogFilter(
  graph: GraphBackend,
  input: {
    rel: string;
    catalogKind: 'kind' | 'status' | 'priority';
    field: string;
    refs: readonly string[];
  }
): Promise<Set<number>> {
  const catalogNames = await fetchCatalogNames(graph, input.catalogKind);
  const union = new Set<number>();
  const unknown: string[] = [];
  for (const ref of input.refs) {
    const resolved = await tryResolveRef(graph, input.catalogKind, ref);
    if (!resolved) {
      unknown.push(ref);
      continue;
    }
    const edges = await graph.getEdges({ dst: resolved.id, rel: input.rel });
    for (const e of edges) union.add(e.src);
  }
  if (unknown.length > 0) {
    const existing =
      catalogNames.length > 0
        ? catalogNames.map((n) => `"${n}"`).join(', ')
        : '(no live rows exist for this catalog yet)';
    const detail = unknown
      .map((ref) => {
        const suggestions = suggestClosestCatalogNames(ref, catalogNames);
        return suggestions.length > 0
          ? `"${ref}" (did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?)`
          : `"${ref}"`;
      })
      .join(', ');
    throw new BacklogValidationError(
      input.field,
      `unknown ${input.catalogKind} value(s): ${detail} — no live "${input.catalogKind}" catalog row matches (existing ${input.catalogKind} values: ${existing})`
    );
  }
  return union;
}

/** Intersect a list of candidate-rowid sets (SPEC.md §6.5 rule 3: "AND semantics — an issue must satisfy every edge-scoped filter given"). An empty input list means "no edge-scoped filter was given" — returns `undefined` (no restriction), never an empty set. */
export function intersectCandidateSets(
  sets: ReadonlyArray<Set<number>>
): Set<number> | undefined {
  if (sets.length === 0) return undefined;
  let [acc] = sets;
  for (const s of sets.slice(1)) {
    const next = new Set<number>();
    for (const id of acc) if (s.has(id)) next.add(id);
    acc = next;
  }
  return acc;
}
