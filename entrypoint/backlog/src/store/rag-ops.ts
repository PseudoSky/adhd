/**
 * rag-ops.ts — the algorithms behind the six EPIC-G `backlog_admin` actions
 * (RAG-SPEC.md §4, §5, §7). `v2/admin.ts` stays a thin dispatch/validation
 * layer (its own header doc's "composition layer" rule) — every genuinely new
 * piece of math (pairwise near-dup scoring, DBSCAN, the backfill sweep's
 * batching + content-change predicate) lives here instead.
 *
 * Every function in this file takes an ALREADY-RESOLVED `SemanticBackend`
 * (the caller in `admin.ts` has already called `requireSemanticBackend` and
 * turned the "no backend configured" case into `RagNotConfiguredError` before
 * ever reaching here) — this module has no opinion on RAG-SPEC §1.6's
 * opt-in contract, it just operates on the vectors it is handed.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import { InvalidArgumentError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import type { SemanticBackend, SemanticHealth } from './semantic-search.js';
import { scheduleEmbed } from './embed-queue.js';
import { computeContentHash, isLiveBacklogItemNode, toBacklogItem, type BacklogNodeMeta } from './mapping.js';
import { mutateMetadata } from './mutate-metadata.js';
import { queryItemNodes } from './query.js';
import { attachToPlanNode } from './structure.js';
import { isTerminalStatus } from '../model.js';

// ============================================================================
// Shared math — cosine similarity over the raw Float32Array vectors this
// module reads via `iterVectors`/`vectorFor`. HIGHER-IS-BETTER, matching
// `SemanticBackend`'s own `knn`/`SemanticMatch` contract (semantic-search.ts).
// ============================================================================

/**
 * Plain cosine similarity, computed locally rather than delegated to the
 * backend: `SemanticBackend` exposes `knn` (query-vector vs. the whole
 * space) and `iterVectors` (every indexed vector), but no pairwise-similarity
 * primitive — §4/§5's pairwise near-dup scan and DBSCAN both need exactly
 * that, over vectors already fetched via `iterVectors`, so computing it here
 * (rather than re-querying `knn` once per item, which would silently exclude
 * candidates outside the backend's own top-k window) is both correct and
 * avoids a second round trip per pair.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** A pairwise near-dup scan/sweep over more than this many vectors is quadratic — same bound discipline as `admin.ts`'s `MAX_OVERLAP_IDS`. */
export const MAX_DEDUP_SCAN_VECTORS = 2000;

/** Default similarity floor for "these two items are probably the same thing" — a cosine similarity, not a distance (higher = closer). */
export const DEFAULT_DEDUP_THRESHOLD = 0.92;

/** Default DBSCAN parameters for `clusterIntoPlans` — see that function's doc comment for why these values. */
export const DEFAULT_CLUSTER_EPSILON = 0.35;
export const DEFAULT_CLUSTER_MIN_POINTS = 2;

interface VectorRow {
  nodeId: number;
  vec: Float32Array;
}

/** Materializes `backend.iterVectors(opts)` into an array, refusing a scan/sweep whose candidate set is quadratically too large to run synchronously. */
async function collectVectors(backend: SemanticBackend, opts: { repo?: string }, action: string): Promise<VectorRow[]> {
  const rows: VectorRow[] = [];
  const filter = opts.repo !== undefined ? { namespace: opts.repo } : undefined;
  for await (const row of backend.iterVectors(filter !== undefined ? { filter } : undefined)) {
    rows.push(row);
    if (rows.length > MAX_DEDUP_SCAN_VECTORS) {
      throw new InvalidArgumentError(
        'repo',
        `backlog_admin(${action}): more than ${MAX_DEDUP_SCAN_VECTORS} indexed vectors in scope — pairwise comparison is quadratic; narrow with "repo".`
      );
    }
  }
  return rows;
}

/** A node lookup that skips tombstoned/superseded rows — a vector can outlive the item it was indexed for (soft-delete does not always reach `deleteVector` on every path), so this is the one place §4/§5 code re-verifies liveness before trusting a `nodeId` it pulled from the vector space. */
async function liveNodeFor(store: GraphBacklogStore, nodeId: number): Promise<NodeRecord | null> {
  const node = await store.graph.getNode(nodeId);
  if (!node || !isLiveBacklogItemNode(node)) return null;
  return node;
}

// ============================================================================
// §1.5 — `embedding_health`.
// ============================================================================

/** Truthful passthrough — `admin.ts` never invents a health shape of its own; `SemanticBackend.health()` IS the truth (§1.5). */
export async function getEmbeddingHealth(backend: SemanticBackend): Promise<SemanticHealth> {
  return backend.health();
}

// ============================================================================
// §7 — `embedding_backfill`.
// ============================================================================

export interface IEmbeddingBackfillReport {
  /** `true` (the safe default): nothing was embedded, only counted — mirrors `prune`/`archive`'s "nothing written unless the caller opts in" convention (`v2/admin.ts`'s `confirm` fields), spelled `dryRun` here per RAG-SPEC §7's own vocabulary. */
  dryRun: boolean;
  /** Every live item considered, in scope — INCLUDING the terminal ones counted in `skippedTerminal`. */
  scanned: number;
  /** Of `scanned`, how many lack a current vector — missing entirely OR carrying a stale `embedContentHash` stamp (mapping.ts). This is the count a dry run reports without calling the provider. */
  needingEmbed: number;
  /** How many of `needingEmbed` this call successfully (re-)embedded. Always `0` when `dryRun`. */
  embedded: number;
  /** How many attempted embeds did not produce a usable vector (the embed failed — `scheduleEmbed` never throws, so this is detected by re-checking `vectorFor` after the attempt, per §2.5's "degrade, never abort"). Always `0` when `dryRun`. */
  failed: number;
  /** Per-item breakdown of WHY each `needingEmbed` item needed one — never double-counted (an item is missing XOR stale, never both). */
  reasons: { missing: number; staleContent: number };
  /**
   * Of `scanned`, how many were skipped for being in a TERMINAL status
   * (`isTerminalStatus`) while `includeTerminal` was false — reported
   * explicitly, never silently dropped, so a caller can always tell a
   * genuinely-clean sweep from a scoped one.
   */
  skippedTerminal: number;
}

const DEFAULT_BACKFILL_CONCURRENCY = 4;

/**
 * RAG-SPEC.md §7 — iterates every live, NON-TERMINAL item in scope lacking a
 * CURRENT vector and schedules embeds for it, batched to bound concurrent
 * inference
 * (never `Promise.all` over the whole scan — a store with thousands of items
 * would otherwise fire thousands of simultaneous ONNX calls at once).
 *
 * "Lacking a current vector" is deliberately not just `vectorFor(id) ===
 * null` — §7's re-embed-on-content-change sweep is folded into the SAME
 * scan: an item whose `computeContentHash(node.content)` no longer matches
 * the `embedContentHash` this sweep itself stamped on its last successful
 * embed is JUST as much "needs work" as an item with zero vector, because a
 * stale vector is a correctness defect (RAG-SPEC §7). An item that has never
 * been through THIS sweep (no stamp at all, e.g. its vector came from the
 * write-path's `scheduleEmbed`) is trusted as current rather than re-embedded
 * on the sweep's very first pass — see `BacklogNodeMeta.embedContentHash`'s
 * doc comment (mapping.ts) for why "no stamp" and "stale stamp" are handled
 * differently.
 *
 * `dryRun: true` (the default) computes and reports `needingEmbed` with ZERO
 * calls to `backend.embedDocument` — the exact "count without calling the
 * provider" contract RAG-SPEC §7 states explicitly.
 */
export async function runEmbeddingBackfill(
  store: GraphBacklogStore,
  backend: SemanticBackend,
  opts: { repo?: string; dryRun: boolean; concurrency?: number; includeTerminal?: boolean }
): Promise<IEmbeddingBackfillReport> {
  const concurrency = opts.concurrency ?? DEFAULT_BACKFILL_CONCURRENCY;
  const includeTerminal = opts.includeTerminal ?? false;
  const nodes = await queryItemNodes(store, opts.repo !== undefined ? { repo: opts.repo } : {});

  interface Candidate {
    node: NodeRecord;
    hash: string;
    reason: 'missing' | 'staleContent';
  }
  const candidates: Candidate[] = [];
  let skippedTerminal = 0;
  for (const node of nodes) {
    // Terminal items are excluded by DEFAULT. A resolved/duplicate/wontfix
    // item that sits in the vector space is not inert: `run_dedup_sweep`
    // iterates EVERY vector with no status predicate of its own, so an
    // embedded terminal item can pull a live item into an advisory `SAME_AS`
    // edge with something already closed. `clusterIntoPlans` had already
    // reached the same conclusion independently (its own
    // `!isTerminalStatus(item.status)` candidate filter); this makes the
    // embedding sweep that FEEDS those surfaces agree with them at the
    // source, instead of every downstream consumer re-filtering. Callers who
    // genuinely want history in the space (searching "has this been fixed
    // before?") opt back in with `includeTerminal: true`.
    if (!includeTerminal && isTerminalStatus(toBacklogItem(node).status)) {
      skippedTerminal += 1;
      continue;
    }
    const meta = (node.metadata ?? {}) as Partial<BacklogNodeMeta>;
    const hash = computeContentHash(node.content);
    const vec = await backend.vectorFor(node.id);
    if (vec === null) {
      candidates.push({ node, hash, reason: 'missing' });
      continue;
    }
    if (meta.embedContentHash !== undefined && meta.embedContentHash !== hash) {
      candidates.push({ node, hash, reason: 'staleContent' });
    }
    // vec !== null && (no stamp, OR stamp matches) => current; skip entirely,
    // never calling the provider for it (the "leave already-embedded items
    // alone" contract).
  }

  const reasons = { missing: 0, staleContent: 0 };
  for (const c of candidates) reasons[c.reason] += 1;

  const report: IEmbeddingBackfillReport = {
    dryRun: opts.dryRun,
    scanned: nodes.length,
    needingEmbed: candidates.length,
    embedded: 0,
    failed: 0,
    reasons,
    skippedTerminal,
  };
  if (opts.dryRun) return report;

  // Batched — at most `concurrency` embeds in flight at once, never the
  // whole candidate set via a single unbounded `Promise.all`.
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (c) => {
        // `scheduleEmbed` never throws (§2.5) — a failed embed degrades this
        // one item to FTS-only reachability rather than aborting the sweep.
        // Awaited here (not fire-and-forget) so this ADMIN action's own
        // result is accurate the instant it returns, matching every other
        // `backlog_admin` write action's synchronous-report contract.
        await scheduleEmbed(store, c.node.id, c.node.content);
        const vec = await backend.vectorFor(c.node.id);
        if (vec === null) return { ok: false as const };
        // Stamp the content hash ONLY on a confirmed-successful embed — a
        // stamp written on a failed attempt would be worse than no stamp at
        // all (it would tell the NEXT sweep "this is current" when it is not
        // embedded at all).
        await mutateMetadata<BacklogNodeMeta>(store, c.node.id, (meta) => ({ ...meta, embedContentHash: c.hash }));
        return { ok: true as const };
      })
    );
    for (const r of results) {
      if (r.ok) report.embedded += 1;
      else report.failed += 1;
    }
  }
  return report;
}

// ============================================================================
// §4 — `list_near_duplicates` (read-only) / `run_dedup_sweep` (writes `SAME_AS`).
// ============================================================================

export interface INearDuplicateCandidate {
  repo: string;
  a: string;
  b: string;
  aNodeId: number;
  bNodeId: number;
  score: number;
  /** `true` iff a live `SAME_AS` edge already connects this pair, either direction. */
  alreadyLinked: boolean;
}

/**
 * Shared core of §4's two actions: pairwise-compares every vector in scope
 * against every other, keeping pairs whose cosine similarity is `>=
 * threshold`. `run_dedup_sweep` and `list_near_duplicates` share this
 * function so their candidate sets can never drift apart — the write action
 * links exactly what the read action would have shown a caller first.
 */
async function scanNearDuplicates(
  store: GraphBacklogStore,
  backend: SemanticBackend,
  opts: { repo?: string; threshold: number },
  action: string
): Promise<{ scanned: number; candidates: INearDuplicateCandidate[] }> {
  const rows = await collectVectors(backend, { repo: opts.repo }, action);
  const live = new Map<number, NodeRecord>();
  for (const row of rows) {
    const node = await liveNodeFor(store, row.nodeId);
    if (node) live.set(row.nodeId, node);
  }
  const liveRows = rows.filter((r) => live.has(r.nodeId));

  const candidates: INearDuplicateCandidate[] = [];
  for (let i = 0; i < liveRows.length; i += 1) {
    for (let j = i + 1; j < liveRows.length; j += 1) {
      const rowA = liveRows[i]!;
      const rowB = liveRows[j]!;
      const score = cosineSimilarity(rowA.vec, rowB.vec);
      if (score < opts.threshold) continue;
      const nodeA = live.get(rowA.nodeId)!;
      const nodeB = live.get(rowB.nodeId)!;
      const itemA = toBacklogItem(nodeA);
      const itemB = toBacklogItem(nodeB);
      const alreadyLinked = await hasSameAsEdge(store, rowA.nodeId, rowB.nodeId);
      candidates.push({
        repo: itemA.repo,
        a: itemA.humanId,
        b: itemB.humanId,
        aNodeId: rowA.nodeId,
        bNodeId: rowB.nodeId,
        score,
        alreadyLinked,
      });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return { scanned: liveRows.length, candidates };
}

async function hasSameAsEdge(store: GraphBacklogStore, a: number, b: number): Promise<boolean> {
  const forward = await store.graph.getEdges({ src: a, dst: b, rel: 'SAME_AS' });
  if (forward.length > 0) return true;
  const backward = await store.graph.getEdges({ src: b, dst: a, rel: 'SAME_AS' });
  return backward.length > 0;
}

export interface IListNearDuplicatesReport {
  scanned: number;
  threshold: number;
  candidates: INearDuplicateCandidate[];
}

/**
 * RAG-SPEC.md §4 — read-only near-duplicate candidates within a scope. This
 * function performs NO write of any kind — no edge, no metadata touch,
 * nothing — by construction: it calls nothing but `iterVectors`, `getNode`,
 * and `getEdges`, none of which mutate. `run_dedup_sweep` below is the ONLY
 * one of these two actions with a write path, and even that only ever writes
 * `SAME_AS` — never a merge, never an invalidate (§4: "review-then-merge,
 * never auto-merge").
 */
export async function listNearDuplicates(
  store: GraphBacklogStore,
  backend: SemanticBackend,
  opts: { repo?: string; threshold?: number }
): Promise<IListNearDuplicatesReport> {
  const threshold = opts.threshold ?? DEFAULT_DEDUP_THRESHOLD;
  const { scanned, candidates } = await scanNearDuplicates(store, backend, { repo: opts.repo, threshold }, 'list_near_duplicates');
  return { scanned, threshold, candidates };
}

export interface IDedupSweepReport {
  scanned: number;
  threshold: number;
  candidates: INearDuplicateCandidate[];
  /** New `SAME_AS` edges written by THIS call. */
  linked: number;
  /** Candidates above threshold that already carried a live `SAME_AS` edge — not re-written (idempotent). */
  alreadySkipped: number;
}

/**
 * RAG-SPEC.md §4 — the periodic sweep. Runs the SAME pairwise scan as
 * `listNearDuplicates` (so a caller who ran that first sees exactly what
 * this call is about to act on), then writes a `SAME_AS` edge for every
 * confirmed pair that does not already carry one.
 *
 * Deliberately soft and non-blocking: `SAME_AS` is advisory ("these two look
 * like the same thing — a human should review and `merge` if so"), never a
 * merge and never an invalidate. Nothing in this function calls
 * `mergeItemsNode`, `invalidate`, or any delete primitive — both items in
 * every linked pair remain fully live and independently readable after this
 * call returns (pinned by `admin.spec.ts`'s "never merges or deletes").
 */
export async function runDedupSweep(
  store: GraphBacklogStore,
  backend: SemanticBackend,
  opts: { repo?: string; threshold?: number }
): Promise<IDedupSweepReport> {
  const threshold = opts.threshold ?? DEFAULT_DEDUP_THRESHOLD;
  const { scanned, candidates } = await scanNearDuplicates(store, backend, { repo: opts.repo, threshold }, 'run_dedup_sweep');

  let linked = 0;
  let alreadySkipped = 0;
  for (const c of candidates) {
    if (c.alreadyLinked) {
      alreadySkipped += 1;
      continue;
    }
    // SAME_AS(candidate -> canonical) has no natural "which one is canonical"
    // here (unlike `mergeItemsNode`'s explicit keep/drop) — §4 is advisory
    // only, so direction carries no meaning beyond "these two are linked".
    // Lower nodeId first keeps the edge deterministic/reproducible.
    const [src, dst] = c.aNodeId < c.bNodeId ? [c.aNodeId, c.bNodeId] : [c.bNodeId, c.aNodeId];
    await store.graph.writeEdge(src, dst, 'SAME_AS', { metadata: { source: 'run_dedup_sweep', score: c.score } });
    linked += 1;
  }
  return { scanned, threshold, candidates, linked, alreadySkipped };
}

// ============================================================================
// §5 — `cluster_into_plans` (DBSCAN, candidate nodes only) / `promote_cluster_to_plan`.
// ============================================================================

export const BACKLOG_CLUSTER_CANDIDATE_TAG = 'backlog-cluster-candidate';

interface ClusterCandidateMeta {
  members: Array<{ nodeId: number; humanId: string; repo: string }>;
  epsilon: number;
  minPoints: number;
  createdAt: string;
  promoted: boolean;
  promotedPlanSlug?: string;
  promotedAt?: string;
}

export interface IClusterCandidate {
  /** The candidate node's own id — `promote_cluster_to_plan`'s `candidateId` param. */
  candidateId: number;
  members: string[];
  size: number;
}

export interface IClusterIntoPlansReport {
  repo?: string;
  /** Live OPEN items considered. */
  scanned: number;
  epsilon: number;
  minPoints: number;
  clusters: IClusterCandidate[];
  /** humanIds of open items that did not join any cluster (DBSCAN noise, or excluded singleton "clusters" below `minPoints`). */
  noise: string[];
}

/**
 * A minimal, dependency-free DBSCAN over cosine DISTANCE (`1 - similarity`,
 * so `epsilon` is a distance — smaller means "must be closer"). Written
 * in-repo per AGENTS.md's "no new dependency without approval" rule; this is
 * the textbook algorithm (region query + expand), not a novel variant:
 *
 * 1. Every unvisited point's `epsilon`-neighbourhood is computed.
 * 2. A point with fewer than `minPoints - 1` OTHER points in its
 *    neighbourhood is (provisionally) noise.
 * 3. Otherwise it seeds a new cluster, which is grown by absorbing every
 *    density-reachable neighbour (a neighbour's own neighbours are added
 *    transitively when THAT neighbour is itself a core point).
 *
 * Returns 0-based cluster indices per input index; `-1` marks noise.
 */
function dbscan(vectors: Float32Array[], epsilon: number, minPoints: number): number[] {
  const n = vectors.length;
  const labels = new Array<number>(n).fill(-1); // -1 = unvisited/noise
  const visited = new Array<boolean>(n).fill(false);
  let nextCluster = 0;

  const neighborsOf = (i: number): number[] => {
    const result: number[] = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const dist = 1 - cosineSimilarity(vectors[i]!, vectors[j]!);
      if (dist <= epsilon) result.push(j);
    }
    return result;
  };

  for (let i = 0; i < n; i += 1) {
    if (visited[i]) continue;
    visited[i] = true;
    const neighbors = neighborsOf(i);
    if (neighbors.length < minPoints - 1) {
      // Provisional noise — may still be absorbed later as a BORDER point of
      // some other core point's expansion (handled below via `labels[i] ===
      // -1` checks during expansion), but never seeds its own cluster.
      continue;
    }
    const clusterId = nextCluster;
    nextCluster += 1;
    labels[i] = clusterId;
    const queue = [...neighbors];
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (!visited[j]) {
        visited[j] = true;
        const jNeighbors = neighborsOf(j);
        if (jNeighbors.length >= minPoints - 1) {
          for (const k of jNeighbors) if (!queue.includes(k)) queue.push(k);
        }
      }
      if (labels[j] === -1) labels[j] = clusterId;
    }
  }
  return labels;
}

/**
 * RAG-SPEC.md §5 — DBSCAN over LIVE, OPEN items' embeddings, grouping
 * semantically similar ones into CANDIDATE cluster nodes (tag
 * `backlog-cluster-candidate`) — never a real plan. `promote_cluster_to_plan`
 * is the only path that turns a candidate into an actual plan (§5: "a
 * human/planner promotes, never auto-created plans"); this function's own
 * writes are limited to minting candidate nodes that describe a grouping, and
 * it never calls `attachToPlanNode`/writes a `plan` field on any item.
 *
 * Items lacking an indexed vector are excluded from clustering entirely
 * (they cannot be compared) rather than silently treated as maximally
 * dissimilar — run `embedding_backfill` first if coverage looks thin.
 */
export async function clusterIntoPlans(
  store: GraphBacklogStore,
  backend: SemanticBackend,
  opts: { repo?: string; epsilon?: number; minPoints?: number }
): Promise<IClusterIntoPlansReport> {
  const epsilon = opts.epsilon ?? DEFAULT_CLUSTER_EPSILON;
  const minPoints = opts.minPoints ?? DEFAULT_CLUSTER_MIN_POINTS;

  const nodes = await queryItemNodes(store, opts.repo !== undefined ? { repo: opts.repo } : {});
  const openItems = nodes.map((node) => ({ node, item: toBacklogItem(node) })).filter(({ item }) => !isTerminalStatus(item.status));

  const withVectors: Array<{ node: NodeRecord; humanId: string; repo: string; vec: Float32Array }> = [];
  for (const { node, item } of openItems) {
    const vec = await backend.vectorFor(node.id);
    if (vec !== null) withVectors.push({ node, humanId: item.humanId, repo: item.repo, vec });
  }

  const labels = dbscan(
    withVectors.map((w) => w.vec),
    epsilon,
    minPoints
  );

  const byCluster = new Map<number, typeof withVectors>();
  const noise: string[] = [];
  labels.forEach((label, idx) => {
    const entry = withVectors[idx]!;
    if (label === -1) {
      noise.push(entry.humanId);
      return;
    }
    const bucket = byCluster.get(label) ?? [];
    bucket.push(entry);
    byCluster.set(label, bucket);
  });

  const nowIso = new Date().toISOString();
  const clusters: IClusterCandidate[] = [];
  for (const members of byCluster.values()) {
    const meta: ClusterCandidateMeta = {
      members: members.map((m) => ({ nodeId: m.node.id, humanId: m.humanId, repo: m.repo })),
      epsilon,
      minPoints,
      createdAt: nowIso,
      promoted: false,
    };
    const namespace = opts.repo ?? members[0]?.repo ?? 'global';
    const humanIds = members.map((m) => m.humanId);
    const candidateId = await store.graph.writeNode(`cluster candidate: ${humanIds.join(', ')}`, {
      kind: 'generic',
      name: `${namespace}::cluster-candidate:${humanIds.join('+')}`,
      summary: `candidate plan grouping ${humanIds.length} items`,
      tags: [BACKLOG_CLUSTER_CANDIDATE_TAG],
      namespace,
      metadata: meta as unknown as Record<string, unknown>,
    });
    clusters.push({ candidateId, members: humanIds, size: humanIds.length });
  }

  return { repo: opts.repo, scanned: withVectors.length, epsilon, minPoints, clusters, noise };
}

export interface IPromoteClusterToPlanReport {
  candidateId: number;
  planSlug: string;
  itemCount: number;
  humanIds: string[];
}

/**
 * RAG-SPEC.md §5 — the explicit human promotion step. Reads back the
 * candidate node `cluster_into_plans` minted, attaches every member item to
 * `planSlug` (via the SAME `attachToPlanNode` primitive `backlog_relate`
 * uses for an ordinary plan attach — no bespoke plan-writing path), and
 * marks the candidate `promoted: true` so a re-run of `cluster_into_plans`
 * or a listing of candidates can tell a promoted grouping from a pending
 * one. This is the ONLY EPIC-G action that creates a real plan membership —
 * `cluster_into_plans` alone never does.
 */
export async function promoteClusterToPlan(
  store: GraphBacklogStore,
  candidateId: number,
  planSlug: string
): Promise<IPromoteClusterToPlanReport> {
  const node = await store.graph.getNode(candidateId);
  if (!node || node.tInvalid || !node.tags.includes(BACKLOG_CLUSTER_CANDIDATE_TAG)) {
    throw new InvalidArgumentError(
      'candidateId',
      `backlog_admin(promote_cluster_to_plan): candidateId ${candidateId} is not a live cluster-candidate node (from cluster_into_plans)`
    );
  }
  const meta = (node.metadata ?? {}) as unknown as ClusterCandidateMeta;
  if (meta.promoted) {
    throw new InvalidArgumentError(
      'candidateId',
      `backlog_admin(promote_cluster_to_plan): candidateId ${candidateId} was already promoted to plan "${meta.promotedPlanSlug}" at ${meta.promotedAt}`
    );
  }

  // `attachToPlanNode` (structure.ts) is the same primitive `backlog_relate`
  // uses — this is genuinely the human-facing "attach to plan" action,
  // applied once per cluster member, never a bespoke plan-writing path.
  for (const member of meta.members) {
    await attachToPlanNode(store, member.repo, member.humanId, planSlug);
  }

  const nowIso = new Date().toISOString();
  await store.graph.touch(candidateId, {
    metadata: { ...meta, promoted: true, promotedPlanSlug: planSlug, promotedAt: nowIso } as unknown as Record<string, unknown>,
  });

  return { candidateId, planSlug, itemCount: meta.members.length, humanIds: meta.members.map((m) => m.humanId) };
}
