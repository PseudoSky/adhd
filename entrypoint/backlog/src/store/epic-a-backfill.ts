/**
 * epic-a-backfill.ts — EPIC-A / GRAPH_MODEL_v2 §2.1, §2.2, §3, §7: the
 * one-shot admin migration that puts every EXISTING backlog item onto the
 * repository/package dimension nodes, by writing the `IN_REPO` and
 * `IN_PACKAGE` role edges the v2 query layer (`store/dimensional.ts`, A-03)
 * will read.
 *
 * ## What it does, and deliberately does NOT do
 *
 * It writes EDGES (and the dimension nodes those edges point at). It never
 * touches an item's `content`, `content_hash`, `namespace`, `metadata.repo`,
 * `humanId`, `name`, or `tags`. That scope line is load-bearing, not
 * fastidiousness:
 *
 *  - Re-stamping `metadata.repo`/`namespace`/the content marker to the
 *    canonical key is `reconcile.ts`'s job (A-08, GRAPH_MODEL §3). Doing it
 *    here too would mean two modules racing to rewrite the same five fields.
 *  - Because `content` never changes, `content_hash` never changes, so the
 *    **re-embed-on-content-change sweep** (GRAPH_MODEL §7 last para) has
 *    nothing to do for this migration. A backfill that silently invalidated
 *    every RAG vector would be a far more expensive event than the edges it
 *    was adding.
 *  - Item rowids never change, so every existing edge (`DEPENDS_ON`,
 *    `RELATES_TO`, `PART_OF`, `MEMBER_OF`, `SUPERSEDES`, `SAME_AS`,
 *    `DERIVED_FROM`, `ASSIGNED_TO`) and the RAG vector join key survive
 *    untouched. There is nothing to re-link.
 *
 * ## The four operational guarantees (and how each is mechanized)
 *
 *  1. **ATOMIC per item.** Every item's edge repair — the stale-edge DELETEs
 *     and both edge INSERTs — happens inside ONE
 *     `adapter.transaction(fn, { mode: 'immediate' })`, wrapped in
 *     `withImmediateRetry` exactly like `mutate-metadata.ts` / `ids.ts` /
 *     `repo-migration.ts`. This is the direct lesson of
 *     BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001: an item that needs both an
 *     `IN_REPO` and an `IN_PACKAGE` edge has TWO writes, and a crash between
 *     them would leave a half-dimensioned item that reads as "migrated" to
 *     the repo axis and "never migrated" to the package axis — a split state
 *     no reader can detect. A native turso panic (uncatchable from JS) has
 *     happened on this store twice in three days, so "crash between write 1
 *     and write 2" is a demonstrated event class here, not a hypothetical.
 *
 *  2. **IDEMPOTENT.** The plan is derived ENTIRELY from observed state — the
 *     live `IN_REPO`/`IN_PACKAGE` edges each item currently has versus the
 *     ones it should have. An item already carrying exactly the right single
 *     repo edge (and the right package edge, or none when it has no
 *     `projectPath`) is classified `needsWrite: false` and its transaction is
 *     never opened. A second run therefore issues ZERO statements — provable
 *     by diffing the whole `node`+`edge` tables across it, which
 *     `epic-a-backfill.spec.ts` does.
 *
 *  3. **RESUMABLE.** Falls out of (2) for free, and for the same reason
 *     `repo-migration.ts` needs no resume machinery: because the plan is a
 *     function of current state, a run killed after item 5 produces, on
 *     restart, a plan containing only items 6..N. A completed item is never
 *     revisited, so there is no double-write and nothing to replay by hand.
 *     Detection is separate and explicit: the backup manifest is written with
 *     `completedAt` ABSENT and only gets it once the run returns, so a
 *     manifest missing `completedAt` on disk IS the "this run was
 *     interrupted" signal — findable by
 *     `findIncompleteEpicABackfillBackups` without opening the store at all.
 *
 *  4. **REVERSIBLE.** `createEpicABackfillBackup` snapshots, for every item
 *     the plan will touch, the exact `IN_REPO`/`IN_PACKAGE` edge sets it has
 *     BEFORE any write in the run, plus the ids of every dimension node that
 *     already existed. `restoreEpicABackfillBackup` replays that manifest —
 *     one item per `immediate` transaction — and invalidates the dimension
 *     nodes the run itself minted. `runEpicABackfill` fails CLOSED if the
 *     backup cannot be written: no item is touched without one on disk. The
 *     manifest carries its own `restoreCommand` string, so an operator who
 *     finds the file mid-incident does not have to reconstruct the
 *     invocation (see `EPIC_A_BACKFILL_RESTORE_COMMAND_TEMPLATE`).
 *
 * ## It is an EXPLICIT admin action. It must never run on store open.
 *
 * Nothing in this module is called by `openGraphBacklogStore` and nothing may
 * ever call it from there. A migration that fires implicitly on open runs
 * once per process, concurrently, on every CLI invocation and every MCP
 * server start — which is how a "safe, idempotent" migration turns into N
 * writers contending for the write lock on a 550-item production store. The
 * spec pins this two ways: behaviourally (open a store with items; assert
 * zero dimension nodes and zero role edges appear) and structurally (assert
 * no module other than the spec imports this file).
 *
 * ## Why the edges are written with raw SQL
 *
 * `store.graph.writeEdge()` runs `typePolicy.validateRel(rel)` first, and
 * `graph-backlog-store.ts` constructs the backend as
 * `createGraphBackend(adapter)` with NO `typePolicy` — so it gets
 * `DEFAULT_TYPE_POLICY`, whose vocabulary is the CLOSED ten-rel
 * `DEFAULT_EDGE_RELS` list (`MENTIONS, SUPPORTS, RELATES_TO, SUPERSEDES,
 * DERIVED_FROM, MEMBER_OF, PART_OF, SAME_AS, ASSIGNED_TO, DEPENDS_ON`).
 * `IN_REPO` and `IN_PACKAGE` are not in it, so `writeEdge` throws
 * `ConstraintError: Unknown edge rel "IN_REPO"` today. Registering the five
 * new rels in a `backlogTypePolicy` is A-03's work on a file this module does
 * not own (GRAPH_MODEL §2.2 — "a policy object, not a schema migration").
 * Until that lands, the edge INSERT goes through DESIGN.md §14's sanctioned
 * raw-SQL escape hatch — the same one `structure.ts`'s
 * `removeDependencyNode` already uses to DELETE an edge, for the same reason
 * (no primitive exists). The SQL is a byte-for-byte mirror of graph-store's
 * own `writeEdgeInternal` upsert, minus the policy call, so the rows are
 * indistinguishable from ones `writeEdge` would have written.
 *
 * The DDL half of that question is checked, not assumed:
 * `assertEdgeRelVocabularyOpen` reads the live `edge` table DDL and refuses
 * to run against a legacy pre-0.6.0 store whose `CHECK (rel IN (...))` would
 * reject the new rels at the database level (GRAPH_MODEL §7 step 2 —
 * `ensureCheckConstraints` will NOT rebuild such a table; the edge-schema
 * reopen is A-07/EPIC-F work). Failing there with a named, actionable error
 * beats failing 300 items into a run with a raw driver message.
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import { InvalidArgumentError, normalizeRepoKey } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { withImmediateRetry } from './immediate-retry.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, type BacklogNodeMeta } from './mapping.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKLOG_DIMENSION_KIND,
  BACKLOG_DIMENSION_NAMESPACE,
  BACKLOG_PACKAGE_TAG,
  BACKLOG_REPO_TAG,
  dimensionGraph,
  listPackageNodes,
  listRepositoryNodes,
  lookupRepository,
  packageKeyFor,
  resolvePackage,
  resolveRepository,
  type IPackageNodeRecord,
  type IRepositoryNodeRecord,
} from './repo-nodes.js';

// ---------------------------------------------------------------------------
// Vocabulary — GRAPH_MODEL_v2 §2.1 / §2.2. These are the spec's own strings.
//
// `BACKLOG_REPO_TAG`, `BACKLOG_PACKAGE_TAG`, `BACKLOG_DIMENSION_KIND`,
// `BACKLOG_DIMENSION_NAMESPACE`, and `packageKeyFor` used to be redefined
// here, byte-for-byte identical to `store/repo-nodes.ts`'s own constants —
// two hand-typed copies of the same five spec strings that could silently
// drift apart. They are now IMPORTED from `repo-nodes.ts` (above) and
// re-exported below so every existing external import of this module
// (`repo-nodes.spec.ts` imports `BACKLOG_DIMENSION_NAMESPACE` and
// `BACKLOG_REPO_TAG` from here) keeps resolving, but there is exactly one
// definition of each in the codebase.
// ---------------------------------------------------------------------------

export { BACKLOG_DIMENSION_KIND, BACKLOG_DIMENSION_NAMESPACE, BACKLOG_PACKAGE_TAG, BACKLOG_REPO_TAG, packageKeyFor };
export type { IPackageNodeRecord, IRepositoryNodeRecord };

/** §2.2 — item → repo. */
export const IN_REPO_REL = 'IN_REPO';
/** §2.2 — item → package. */
export const IN_PACKAGE_REL = 'IN_PACKAGE';

// ---------------------------------------------------------------------------
// The repo-nodes port — the seam to `store/repo-nodes.ts` (A-02)
// ---------------------------------------------------------------------------

/** A dimension node this backfill resolved or minted. */
export interface IDimensionNodeRef {
  /** `node.rowid` — the edge `dst`. */
  nodeId: number;
  /** `canonicalKey` for a repo node; `${repoKey}::${projectPath}` for a package node. */
  key: string;
  /** True iff THIS call created the node (drives the manifest's mint list). */
  created: boolean;
  /**
   * GRAPH_MODEL §3 / AC-24 — set when a bare repo name matched more than one
   * known repo. It MUST reach the caller: "a read never silently narrows" is
   * the spec's stated correctness principle, so this backfill propagates the
   * warning up into `IEpicABackfillResult.warnings` rather than resolving
   * quietly to the deterministic winner.
   */
  warning?: string;
}

/** Options common to both find-or-create calls on {@link IRepoNodesApi}. */
export interface IDimensionResolveOptions {
  /**
   * `false` ⇒ resolve ONLY; never write. Returns `null` when the node does
   * not exist yet. This is what `dryRun` uses, and it is why dry-run can
   * report exactly what a real run would create while provably touching
   * nothing.
   */
  create?: boolean;
}

/**
 * The narrow contract this backfill needs from the repo/package node layer —
 * `store/repo-nodes.ts` (work order A-02).
 *
 * At the time this module was written that file did not exist on disk, so the
 * shape below is bound to **`docs/spec/backlog/GRAPH_MODEL_v2.md` §2.1/§2.2/§3**
 * — the authority both modules answer to — and NOT to any in-flight peer
 * file. `canonicalRepoKeyFor` is the spec's own name for the find-or-create
 * seam (§3: "alias-map lookup → deterministic normalization → (create if
 * absent) → canonical repo node").
 *
 * `listRepositoryNodes`/`listPackageNodes` are NOT mandated by the spec —
 * §3 defines alias resolution as a lookup, not a client-side scan. They are
 * declared here as **this module's own requirement**: a backfill sweep visits
 * every item in the corpus and must resolve every distinct repo/package key
 * without issuing one full-table scan per item. If `repo-nodes.ts` ships
 * without them, this port keeps working via {@link PROVISIONAL_REPO_NODES_API}
 * and only the two find-or-create methods need re-pointing.
 */
export interface IRepoNodesApi {
  /**
   * GRAPH_MODEL §3 — resolve `raw` through the alias map (falling back to
   * `normalizeRepoKey`) to the one canonical repository node, creating it if
   * absent unless `opts.create === false`.
   */
  canonicalRepoKeyFor(
    store: GraphBacklogStore,
    raw: string,
    opts?: IDimensionResolveOptions
  ): Promise<IDimensionNodeRef | null>;

  /** GRAPH_MODEL §2.1 — the package node named `${repoKey}::${projectPath}`. */
  packageNodeFor(
    store: GraphBacklogStore,
    repoKey: string,
    projectPath: string,
    opts?: IDimensionResolveOptions
  ): Promise<IDimensionNodeRef | null>;

  /** Every live repository dimension node. See the interface doc for why this is here. */
  listRepositoryNodes(store: GraphBacklogStore): Promise<IRepositoryNodeRecord[]>;

  /** Every live package dimension node. */
  listPackageNodes(store: GraphBacklogStore): Promise<IPackageNodeRecord[]>;
}

/**
 * The binding of {@link IRepoNodesApi} onto `store/repo-nodes.ts` — the safe,
 * owner-aware fork-key resolution (GRAPH_MODEL_v2 §3, `decideRepository`) —
 * kept behind this module's own port interface rather than called directly,
 * so the backfill's plan/apply split stays intact: `create: false` (the
 * `dryRun`/planning leg, {@link planEpicABackfill}) MUST resolve without
 * writing, and `create: true` (the apply leg, {@link runEpicABackfill}) is
 * the only caller allowed to mint nodes or fold aliases.
 *
 * This used to be a STANDALONE implementation over `model.ts`'s
 * `resolveRepositoryNode` — bare-name matching with no owner awareness at
 * all, so `alice/tools` and `bob/tools` (or any two repos that merely share a
 * bare name) silently fused into one node and the foreign spelling was
 * written into the winner's `aliases`. That defect is why this binding now
 * routes every decision through `repo-nodes.ts`'s `resolveRepository` /
 * `lookupRepository`, which resolve through the SAME owner-aware
 * `decideRepository` the read path uses (see `store/repo-nodes.spec.ts`'s
 * fork-key coverage) — two repos that share a bare name but disagree on
 * owner are minted as two distinct nodes, never fused.
 *
 * The name is kept as `PROVISIONAL_REPO_NODES_API` (rather than renamed) only
 * because `repo-nodes.spec.ts` imports it by that name from this module.
 */
export const PROVISIONAL_REPO_NODES_API: IRepoNodesApi = {
  listRepositoryNodes,
  listPackageNodes,

  async canonicalRepoKeyFor(
    store: GraphBacklogStore,
    raw: string,
    opts: IDimensionResolveOptions = {}
  ): Promise<IDimensionNodeRef | null> {
    const create = opts.create !== false;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length === 0) {
      throw new InvalidArgumentError('repo', 'backlog: canonicalRepoKeyFor requires a non-empty repo string');
    }

    if (!create) {
      // Read-only: `lookupRepository` never mints a node and never folds an
      // alias — exactly the guarantee a dry-run plan needs.
      const resolution = await lookupRepository(store, trimmed);
      if (!resolution) return null;
      return {
        nodeId: resolution.node.nodeId,
        key: resolution.node.canonicalKey,
        created: false,
        warning: resolution.warnings[0],
      };
    }

    // Write path: mints on first use, folds a previously-unknown spelling
    // into `aliases`, and disambiguates by owner (GRAPH_MODEL §3) rather than
    // by bare name alone.
    const resolution = await resolveRepository(store, trimmed);
    return {
      nodeId: resolution.node.nodeId,
      key: resolution.node.canonicalKey,
      created: resolution.created,
      warning: resolution.warnings[0],
    };
  },

  async packageNodeFor(
    store: GraphBacklogStore,
    repoKey: string,
    projectPath: string,
    opts: IDimensionResolveOptions = {}
  ): Promise<IDimensionNodeRef | null> {
    const create = opts.create !== false;
    const path = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (path.length === 0) {
      throw new InvalidArgumentError('projectPath', 'backlog: packageNodeFor requires a non-empty projectPath');
    }
    const key = packageKeyFor(repoKey, path);

    if (!create) {
      // Read-only: a plain scan of the already-resolved package list, never a
      // write — `resolvePackage` (the write path below) itself resolves
      // `repoKey` through `resolveRepository`, which this leg must not do.
      const existing = (await listPackageNodes(store)).find((p) => p.repo === repoKey && p.path === path);
      return existing ? { nodeId: existing.nodeId, key, created: false } : null;
    }

    // `repoKey` here is already the canonical key the repo-resolution leg
    // produced, so `resolvePackage`'s own `resolveRepository(store, repoKey)`
    // call hits the exact-match branch and writes nothing new for the repo —
    // only the package node (and its `PART_OF` edge) can be minted here.
    const result = await resolvePackage(store, { repo: repoKey, path });
    return { nodeId: result.node.nodeId, key, created: result.created };
  },
};

function resolveRepoNodesApi(options: IEpicABackfillPlanOptions): IRepoNodesApi {
  // `PROVISIONAL_REPO_NODES_API` is now itself backed by `store/repo-nodes.ts`
  // (see its own doc comment) — this default no longer needs swapping.
  return options.repoNodes ?? PROVISIONAL_REPO_NODES_API;
}

// ---------------------------------------------------------------------------
// Preflight — legacy edge-schema rel CHECK (GRAPH_MODEL §7 step 2)
// ---------------------------------------------------------------------------

/** Outcome of the legacy-schema preflight. */
export interface IEdgeRelVocabularyCheck {
  /** False when the live DDL text could not be read at all (see `warning`). */
  checked: boolean;
  /** The `edge` table DDL as the engine reports it, when readable. */
  ddl?: string;
  warning?: string;
}

/**
 * Refuses to run against a legacy pre-0.6.0 store whose `edge` table still
 * carries a closed `CHECK (rel IN (...))`, which rejects `IN_REPO`/
 * `IN_PACKAGE` at the DATABASE level — `ensureCheckConstraints` will not
 * rebuild such a table (GRAPH_MODEL §7 step 2), so the edge-schema reopen has
 * to happen first (A-07 / EPIC-F). Fresh 0.6.0 stores have no rel CHECK
 * (graph-store's own `graphDdl()` declares `rel TEXT NOT NULL`, no CHECK) and
 * pass.
 *
 * Read-only: safe in `dryRun`, and deliberately run there too — a dry-run
 * that cheerfully reports "would write 550 edges" against a store that would
 * reject every one of them is worse than useless.
 *
 * @throws {InvalidArgumentError} when a rel CHECK is definitively present
 */
export async function assertEdgeRelVocabularyOpen(store: GraphBacklogStore): Promise<IEdgeRelVocabularyCheck> {
  let row: { sql?: unknown } | null = null;
  try {
    row = await store.adapter.executeGet<{ sql?: unknown }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'edge'`
    );
  } catch (err) {
    // Not fatal, and not silently swallowed either: the caller surfaces this
    // in `warnings`. An engine that cannot report its own DDL is a reason to
    // say so out loud, not a reason to refuse an otherwise valid migration.
    return {
      checked: false,
      warning:
        `epic-a backfill: could not read the live edge-table DDL to check for a legacy rel CHECK ` +
        `(${err instanceof Error ? err.message : String(err)}); proceeding unverified — see GRAPH_MODEL_v2 §7 step 2.`,
    };
  }
  const ddl = typeof row?.sql === 'string' ? row.sql : undefined;
  if (ddl === undefined) {
    return {
      checked: false,
      warning: `epic-a backfill: the edge table reported no DDL text, so the legacy rel-CHECK preflight could not run (GRAPH_MODEL_v2 §7 step 2).`,
    };
  }
  // Match the CHECK only when it constrains `rel` — the fresh DDL DOES carry
  // an unrelated `origin` CHECK, and a naive `includes('CHECK')` would reject
  // every healthy store.
  if (/CHECK\s*\(\s*rel\s+IN\s*\(/i.test(ddl)) {
    throw new InvalidArgumentError(
      'store',
      `backlog: this store's "edge" table still carries a legacy closed rel CHECK, which rejects ${IN_REPO_REL}/${IN_PACKAGE_REL} ` +
        `at the DDL level. The edge-schema reopen (GRAPH_MODEL_v2 §7 step 2) must run before the EPIC-A backfill. ` +
        `ensureCheckConstraints will NOT rebuild this table on its own. Live DDL: ${ddl}`
    );
  }
  return { checked: true, ddl };
}

// ---------------------------------------------------------------------------
// Plan — pure, read-only, deterministic
// ---------------------------------------------------------------------------

/** One item's dimension state: what it has now versus what it must have. */
export interface IEpicABackfillPlanItem {
  nodeId: number;
  humanId: string;
  /** The raw repo string carried by the item (`metadata.repo ?? node.namespace`, mirroring `toBacklogItem`). */
  rawRepo: string;
  /** Canonical repo key this item must be edged to, or `null` when no repo node exists yet AND none may be created (dry-run). */
  repoKey: string | null;
  /** Rowid of that repo node, `null` when it does not exist yet. */
  repoNodeId: number | null;
  /** Live `IN_REPO` dsts the item has right now. Anything other than exactly `[repoNodeId]` is a repair. */
  existingRepoEdgeDsts: number[];
  projectPath?: string;
  packageKey: string | null;
  packageNodeId: number | null;
  existingPackageEdgeDsts: number[];
  /** True iff the per-item transaction would issue at least one statement. */
  needsWrite: boolean;
  /** Edges that must be DELETEd: duplicates, wrong targets, or package edges on an item with no `projectPath`. */
  staleEdgeCount: number;
  /** GRAPH_MODEL §3 / AC-24 repo-ambiguity warning. Never dropped. */
  warning?: string;
}

/** The full read-only sweep. Safe to call any number of times; the exact scan `dryRun` reports from. */
export interface IEpicABackfillPlan {
  items: IEpicABackfillPlanItem[];
  /** Distinct canonical repo keys that do not have a node yet. */
  repoKeysToCreate: string[];
  /** Distinct `${repoKey}::${projectPath}` keys that do not have a node yet. */
  packageKeysToCreate: string[];
  itemsNeedingWrite: number;
  itemsAlreadyLinked: number;
  staleEdgesToRemove: number;
  warnings: string[];
}

function itemMetaOf(node: NodeRecord): Partial<BacklogNodeMeta> {
  return (node.metadata ?? {}) as Partial<BacklogNodeMeta>;
}

/**
 * Every LIVE backlog item in the store, across ALL namespaces — this is a
 * whole-corpus migration, so it is deliberately NOT repo-scoped (a
 * repo-scoped sweep would have to be told the very alias set the repo nodes
 * exist to reconcile, which is circular).
 */
async function liveItemNodes(store: GraphBacklogStore): Promise<NodeRecord[]> {
  const nodes = await store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG] });
  return nodes.filter(isLiveBacklogItemNode);
}

async function liveEdgeDsts(store: GraphBacklogStore, src: number, rel: string): Promise<number[]> {
  const edges = await store.graph.getEdges({ src, rel });
  return edges.map((e) => e.dst).sort((a, b) => a - b);
}

/**
 * Pure read-only scan. Writes NOTHING — every dimension lookup runs with
 * `create: false`, which is the whole reason `dryRun` can promise "reports
 * exactly what it would do, touching nothing" without a second code path
 * that could drift from the real one.
 */
export async function planEpicABackfill(
  store: GraphBacklogStore,
  options: IEpicABackfillPlanOptions = {}
): Promise<IEpicABackfillPlan> {
  const api = resolveRepoNodesApi(options);
  const nodes = await liveItemNodes(store);
  // humanId order: stable and reproducible across repeated calls, so two
  // plans of the same store are diffable (same discipline as
  // `planRepoMigration`'s sort).
  const sorted = [...nodes].sort((a, b) => (itemMetaOf(a).humanId ?? '').localeCompare(itemMetaOf(b).humanId ?? ''));

  const items: IEpicABackfillPlanItem[] = [];
  const repoKeysToCreate = new Set<string>();
  const packageKeysToCreate = new Set<string>();
  const warnings: string[] = [];
  // Per-run resolution caches. Without them a 550-item sweep would issue 550
  // full dimension-table scans; with them it issues one per DISTINCT key.
  const repoCache = new Map<string, IDimensionNodeRef | null>();
  const packageCache = new Map<string, IDimensionNodeRef | null>();

  let itemsNeedingWrite = 0;
  let staleEdgesToRemove = 0;

  for (const node of sorted) {
    const meta = itemMetaOf(node);
    const humanId = meta.humanId ?? '';
    // Mirrors `toBacklogItem`'s own precedence exactly: `metadata.repo`
    // first, `node.namespace` as the fallback. An item whose two repo fields
    // have already diverged (empirically real on this store — see
    // repo-migration.ts's header) is dimensioned by the one a reader
    // actually sees, not by the one the partition happens to say.
    const rawRepo = (meta.repo ?? node.namespace ?? '').trim();
    if (rawRepo.length === 0) {
      warnings.push(
        `epic-a backfill: item nodeId=${node.id} (humanId=${JSON.stringify(humanId)}) has neither metadata.repo nor a namespace — skipped; it cannot be placed on a repo dimension.`
      );
      continue;
    }

    let repoRef = repoCache.get(rawRepo);
    if (repoRef === undefined) {
      repoRef = await api.canonicalRepoKeyFor(store, rawRepo, { create: false });
      repoCache.set(rawRepo, repoRef);
      if (repoRef?.warning) warnings.push(repoRef.warning);
    }
    // With no node yet, the key a real run WILL mint is the deterministic
    // normalization — the same value `canonicalRepoKeyFor`'s create branch
    // computes, so the dry-run report names the real future key.
    const repoKey = repoRef?.key ?? normalizeRepoKey(rawRepo);
    if (!repoRef) repoKeysToCreate.add(repoKey);

    const projectPath = typeof meta.projectPath === 'string' && meta.projectPath.trim().length > 0 ? meta.projectPath.trim() : undefined;
    let packageRef: IDimensionNodeRef | null = null;
    let packageKey: string | null = null;
    if (projectPath) {
      packageKey = packageKeyFor(repoKey, projectPath);
      const cached = packageCache.get(packageKey);
      if (cached === undefined) {
        packageRef = await api.packageNodeFor(store, repoKey, projectPath, { create: false });
        packageCache.set(packageKey, packageRef);
      } else {
        packageRef = cached;
      }
      if (!packageRef) packageKeysToCreate.add(packageKey);
    }

    const existingRepoEdgeDsts = await liveEdgeDsts(store, node.id, IN_REPO_REL);
    const existingPackageEdgeDsts = await liveEdgeDsts(store, node.id, IN_PACKAGE_REL);

    const repoOk = repoRef !== null && existingRepoEdgeDsts.length === 1 && existingRepoEdgeDsts[0] === repoRef.nodeId;
    let packageOk: boolean;
    if (packageRef) {
      packageOk = existingPackageEdgeDsts.length === 1 && existingPackageEdgeDsts[0] === packageRef.nodeId;
    } else if (projectPath) {
      packageOk = false; // needs a package node that does not exist yet
    } else {
      packageOk = existingPackageEdgeDsts.length === 0;
    }

    const staleRepoEdges = existingRepoEdgeDsts.filter((d) => repoRef === null || d !== repoRef.nodeId).length;
    const stalePackageEdges = existingPackageEdgeDsts.filter((d) => packageRef === null || d !== packageRef.nodeId).length;
    const staleEdgeCount = staleRepoEdges + stalePackageEdges;
    const needsWrite = !repoOk || !packageOk || staleEdgeCount > 0;

    if (needsWrite) itemsNeedingWrite += 1;
    staleEdgesToRemove += staleEdgeCount;

    items.push({
      nodeId: node.id,
      humanId,
      rawRepo,
      repoKey,
      repoNodeId: repoRef?.nodeId ?? null,
      existingRepoEdgeDsts,
      projectPath,
      packageKey,
      packageNodeId: packageRef?.nodeId ?? null,
      existingPackageEdgeDsts,
      needsWrite,
      staleEdgeCount,
      warning: repoRef?.warning,
    });
  }

  return {
    items,
    repoKeysToCreate: [...repoKeysToCreate].sort(),
    packageKeysToCreate: [...packageKeysToCreate].sort(),
    itemsNeedingWrite,
    itemsAlreadyLinked: items.length - itemsNeedingWrite,
    staleEdgesToRemove,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Backup — taken before any write, replayable, self-describing
// ---------------------------------------------------------------------------

/** One item's pre-backfill dimension-edge state. */
export interface IEpicABackfillBackupItem {
  nodeId: number;
  humanId: string;
  /** Live `IN_REPO` dsts before the run. */
  inRepo: number[];
  /** Live `IN_PACKAGE` dsts before the run. */
  inPackage: number[];
}

/**
 * A pre-existing repository node's mutable metadata, snapshotted BEFORE the
 * run — the alias-fold that `resolveRepository`'s write path performs
 * (folding a newly-seen spelling into `aliases[]`) mutates a node that was
 * already live, so it is invisible to `dimensionNodeIdsBefore` (which only
 * ever distinguishes "existed before" from "minted by this run") and to
 * `items[].inRepo`/`inPackage` (which snapshot EDGES, not node metadata).
 * Without this, `restoreEpicABackfillBackup` reverts every edge and
 * invalidates every newly-minted node but leaves a folded alias standing on
 * a node that existed before the run — the corruption survives the restore.
 */
export interface IEpicABackfillRepositorySnapshot {
  nodeId: number;
  canonicalKey: string;
  aliases: string[];
  forkOf?: string;
  displayName?: string;
}

export interface IEpicABackfillBackupResultSummary {
  itemsWritten: number;
  itemsSkipped: number;
  staleEdgesRemoved: number;
  repoNodesCreated: number;
  packageNodesCreated: number;
}

/**
 * The on-disk snapshot for one real (`dryRun:false`) run.
 *
 * `completedAt`/`resultSummary` are absent from the moment the file is
 * written until the run returns — their ABSENCE on a manifest found on disk
 * IS the "this run never finished" signal, readable without opening the
 * store (see `findIncompleteEpicABackfillBackups`).
 */
export interface IEpicABackfillBackupManifest {
  version: 1;
  kind: 'epic-a-backfill';
  actor: string;
  /** The store this manifest belongs to — a manifest replayed onto the wrong store would be silent corruption. */
  dbPath?: string;
  createdAt: string;
  completedAt?: string;
  resultSummary?: IEpicABackfillBackupResultSummary;
  /**
   * Every dimension node id that ALREADY existed when the backup was taken.
   * Restore invalidates any dimension node NOT in this list — i.e. exactly
   * the ones this run minted — so an undo leaves no orphan repo/package
   * nodes behind.
   */
  dimensionNodeIdsBefore: number[];
  /**
   * Every repository node's `canonicalKey`/`aliases`/`forkOf`/`displayName`
   * as they stood BEFORE the run — see {@link IEpicABackfillRepositorySnapshot}.
   * Absent on a manifest written before this field existed; restore treats
   * that as "nothing to revert on the alias axis" rather than an error, so an
   * old manifest still replays (it just cannot undo an alias fold it never
   * recorded).
   */
  repositoriesBefore?: IEpicABackfillRepositorySnapshot[];
  items: IEpicABackfillBackupItem[];
  /** A real, copy-pasteable undo. See {@link EPIC_A_BACKFILL_RESTORE_COMMAND_TEMPLATE}. */
  restoreCommand: string;
}

export interface IEpicABackfillBackupHandle {
  backupPath: string;
  itemCount: number;
}

/**
 * The documented undo, run from the MONOREPO ROOT. `<manifest>` and `<db>`
 * are substituted with real absolute paths when the manifest is written, so
 * the string stored in the file is directly runnable.
 *
 * A first-class `backlog admin` subcommand for this belongs to the admin/CLI
 * work order (A-07 wires `migrate-model-v2`; C-07 owns the full admin
 * surface) — neither `cli.ts` nor `migration-admin.ts` is owned by this
 * module, so the documented command drives the exported function directly
 * rather than inventing a command surface here.
 */
export const EPIC_A_BACKFILL_RESTORE_COMMAND_TEMPLATE =
  `npx tsx -e "const g=await import('./entrypoint/backlog/src/store/graph-backlog-store.ts');` +
  `const m=await import('./entrypoint/backlog/src/store/epic-a-backfill.ts');` +
  `const s=await g.openGraphBacklogStore('<db>');` +
  `console.log(JSON.stringify(await m.restoreEpicABackfillBackup(s,'<manifest>'),null,2));` +
  `await g.closeGraphBacklogStore(s);"`;

/**
 * Default backup root — `process.cwd()` at MODULE LOAD time, matching
 * `repo-migration.ts`'s `DEFAULT_REPO_MIGRATION_BACKUP_DIR` and
 * `test/helpers/tmp-store.ts`'s `TMP_ROOT` for the same reason: re-resolving
 * per call would let two calls in one run disagree about where this run's
 * backup lives. `tmp/` is AGENTS.md §10's canonical ephemeral root —
 * "ephemeral" meaning operator-cleaned, NOT safe to lose mid-incident.
 */
const DEFAULT_EPIC_A_BACKFILL_BACKUP_DIR = join(process.cwd(), 'tmp', 'backlog', 'epic-a-backfill-backups');

function writeManifestAtomic(path: string, manifest: IEpicABackfillBackupManifest): void {
  // Write-then-rename: a crash mid-write leaves the TEMP file unfinished; the
  // rename is what makes the real path exist at all, and renaming a
  // fully-written file is atomic on the same filesystem. Without this, the
  // crash signal (`completedAt` absent) could not be distinguished from an
  // unparseable half-written file.
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

/**
 * Snapshots every dimension edge the run can touch, read BEFORE any write in
 * the run, to a durable JSON manifest. Read-only against the store.
 */
export async function createEpicABackfillBackup(
  store: GraphBacklogStore,
  plan: IEpicABackfillPlan,
  actor: string,
  backupDir: string = DEFAULT_EPIC_A_BACKFILL_BACKUP_DIR,
  api: IRepoNodesApi = PROVISIONAL_REPO_NODES_API
): Promise<IEpicABackfillBackupHandle> {
  const createdAt = new Date().toISOString();
  const dbPath = store.adapter.config.dbPath;
  const repositoriesBeforeList = await api.listRepositoryNodes(store);
  const dimensionNodeIdsBefore = [
    ...repositoriesBeforeList.map((r) => r.nodeId),
    ...(await api.listPackageNodes(store)).map((p) => p.nodeId),
  ].sort((a, b) => a - b);
  // Snapshot every pre-existing repo node's full mutable metadata — the
  // alias-fold guarantee this manifest now carries. See
  // {@link IEpicABackfillRepositorySnapshot}.
  const repositoriesBefore: IEpicABackfillRepositorySnapshot[] = repositoriesBeforeList.map((r) => ({
    nodeId: r.nodeId,
    canonicalKey: r.canonicalKey,
    aliases: [...r.aliases],
    ...(r.forkOf !== undefined ? { forkOf: r.forkOf } : {}),
    ...(r.displayName !== undefined ? { displayName: r.displayName } : {}),
  }));

  // Every item in the PLAN, not merely the ones needing a write: a restore
  // must be able to reassert the full pre-run edge set without depending on
  // the classification that the run itself might have got wrong.
  const items: IEpicABackfillBackupItem[] = plan.items.map((i) => ({
    nodeId: i.nodeId,
    humanId: i.humanId,
    inRepo: [...i.existingRepoEdgeDsts],
    inPackage: [...i.existingPackageEdgeDsts],
  }));

  mkdirSync(backupDir, { recursive: true });
  // The timestamp ALONE is not a unique filename: two runs started inside the
  // same millisecond (a resume immediately after an interrupted run, an
  // operator retrying, two `backlog` processes) would produce the same path
  // and the second `writeManifestAtomic` would silently overwrite the first —
  // destroying the very crash record the interrupted run left behind. The
  // random suffix makes that collision impossible rather than merely
  // unlikely.
  const fileName = `epic-a-backfill-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
  const backupPath = join(backupDir, fileName);
  const manifest: IEpicABackfillBackupManifest = {
    version: 1,
    kind: 'epic-a-backfill',
    actor,
    dbPath,
    createdAt,
    dimensionNodeIdsBefore,
    repositoriesBefore,
    items,
    restoreCommand: EPIC_A_BACKFILL_RESTORE_COMMAND_TEMPLATE.replace('<db>', dbPath ?? '<db>').replace(
      '<manifest>',
      backupPath
    ),
  };
  writeManifestAtomic(backupPath, manifest);
  return { backupPath, itemCount: items.length };
}

/** Stamps `completedAt` + the result summary — i.e. "this run finished". */
export async function markEpicABackfillBackupComplete(
  backupPath: string,
  summary: IEpicABackfillBackupResultSummary
): Promise<void> {
  const manifest = JSON.parse(readFileSync(backupPath, 'utf8')) as IEpicABackfillBackupManifest;
  manifest.completedAt = new Date().toISOString();
  manifest.resultSummary = summary;
  writeManifestAtomic(backupPath, manifest);
}

/**
 * Every manifest under `backupDir` whose run never reached completion. Pure
 * filesystem read — never touches the store, so it is usable when the store
 * itself is the thing that is wedged.
 *
 * An interrupted run's manifest stays flagged FOREVER — a later, successful
 * run writes its own separate manifest and never retroactively stamps the
 * crashed one. That is deliberate: the incomplete manifest is the durable
 * record of an incident (and the only thing that can undo the partial writes
 * that run DID commit), so "the next run tidied it away" would erase
 * exactly the evidence an operator needs. Clearing it is an operator
 * decision — delete the file once the incident is closed.
 */
export async function findIncompleteEpicABackfillBackups(
  backupDir: string = DEFAULT_EPIC_A_BACKFILL_BACKUP_DIR
): Promise<IEpicABackfillBackupManifest[]> {
  if (!existsSync(backupDir)) return [];
  const out: IEpicABackfillBackupManifest[] = [];
  for (const file of readdirSync(backupDir)) {
    if (!file.endsWith('.json')) continue;
    const manifest = JSON.parse(readFileSync(join(backupDir, file), 'utf8')) as IEpicABackfillBackupManifest;
    if (manifest.kind === 'epic-a-backfill' && !manifest.completedAt) out.push(manifest);
  }
  return out;
}

/** Per-item outcome of replaying a backup manifest back onto the live store. */
export interface IEpicABackfillRestoreItemResult {
  nodeId: number;
  humanId: string;
  ok: boolean;
  error?: string;
}

/** Per-node outcome of reverting a repository node's alias-fold. */
export interface IEpicABackfillAliasRestoreItemResult {
  nodeId: number;
  canonicalKey: string;
  ok: boolean;
  error?: string;
}

export interface IEpicABackfillRestoreResult {
  backupPath: string;
  results: IEpicABackfillRestoreItemResult[];
  succeeded: number;
  failed: number;
  /** Dimension nodes minted by the run being undone, now invalidated. */
  dimensionNodesInvalidated: number[];
  /**
   * Per pre-existing repository node, whether its `canonicalKey`/`aliases`/
   * `forkOf`/`displayName` were restored to their pre-run snapshot. Empty on
   * a manifest written before `repositoriesBefore` existed (see that field's
   * doc) — nothing to revert on the alias axis because nothing was recorded.
   */
  repositoryAliasesRestored: IEpicABackfillAliasRestoreItemResult[];
}

/**
 * Replays a manifest back onto the live store: every item's `IN_REPO`/
 * `IN_PACKAGE` edge set is restored byte-for-byte, one item per `immediate`
 * transaction (the same atomicity guarantee the forward run gets); every
 * dimension node the run minted is invalidated afterwards — edges first, so
 * no edge is ever left pointing at an invalidated node; and every
 * PRE-EXISTING repository node's `canonicalKey`/`aliases`/`forkOf`/
 * `displayName` is written back to its `repositoriesBefore` snapshot, undoing
 * any alias-fold the run performed on a node it did not mint (see
 * {@link IEpicABackfillRepositorySnapshot} — this is the manifest-alias gap
 * fix; without it a folded alias on a pre-existing node survived a restore).
 *
 * A single item (or repository node) failing does NOT abort the batch; it is
 * reported per-item/per-node, mirroring `restoreRepoMigrationBackup`.
 */
export async function restoreEpicABackfillBackup(
  store: GraphBacklogStore,
  backupPath: string,
  api: IRepoNodesApi = PROVISIONAL_REPO_NODES_API
): Promise<IEpicABackfillRestoreResult> {
  const manifest = JSON.parse(readFileSync(backupPath, 'utf8')) as IEpicABackfillBackupManifest;
  if (manifest.kind !== 'epic-a-backfill') {
    throw new InvalidArgumentError(
      'backupPath',
      `backlog: ${JSON.stringify(backupPath)} is not an epic-a-backfill manifest (kind=${JSON.stringify(manifest.kind)}) — refusing to replay it.`
    );
  }
  const results: IEpicABackfillRestoreItemResult[] = [];
  for (const item of manifest.items) {
    try {
      await withImmediateRetry(() =>
        store.adapter.transaction(
          async (tx) => {
            await tx.executeRun(`DELETE FROM edge WHERE src = ? AND rel IN (?, ?)`, [item.nodeId, IN_REPO_REL, IN_PACKAGE_REL]);
            for (const dst of item.inRepo) await insertDimensionEdge(tx, item.nodeId, dst, IN_REPO_REL);
            for (const dst of item.inPackage) await insertDimensionEdge(tx, item.nodeId, dst, IN_PACKAGE_REL);
          },
          { mode: 'immediate' }
        )
      );
      results.push({ nodeId: item.nodeId, humanId: item.humanId, ok: true });
    } catch (err) {
      results.push({
        nodeId: item.nodeId,
        humanId: item.humanId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const before = new Set(manifest.dimensionNodeIdsBefore);
  const nowIds = [
    ...(await api.listRepositoryNodes(store)).map((r) => r.nodeId),
    ...(await api.listPackageNodes(store)).map((p) => p.nodeId),
  ];
  const minted = nowIds.filter((id) => !before.has(id)).sort((a, b) => a - b);
  for (const id of minted) {
    await withImmediateRetry(() =>
      store.adapter.transaction(() => store.graph.invalidate(id, 'epic-a backfill restore'), { mode: 'immediate' })
    );
  }

  // ---- Revert any alias-fold onto a PRE-EXISTING repository node ---------
  // Runs AFTER the mint-invalidation above so a node that both existed before
  // AND is (impossibly, but defensively) also in `minted` never gets written
  // to after being invalidated — `nowIds`/`minted` were computed before this
  // point, so ordering here is the one that keeps them consistent.
  const repositoryAliasesRestored: IEpicABackfillAliasRestoreItemResult[] = [];
  for (const snapshot of manifest.repositoriesBefore ?? []) {
    try {
      // Read the LIVE node first. `touch()` replaces `metadata` wholesale (see
      // writeRepositoryMeta in repo-nodes.ts), so blindly writing only the four
      // fields we snapshot would silently erase any other metadata key the node
      // carries (or ever will carry) that this snapshot never captured. We must
      // (a) skip the write entirely when the node already matches the snapshot
      // — sparing every UNTOUCHED pre-existing node a needless touch/t_updated
      // bump — and (b) when it doesn't match, overlay the snapshotted fields
      // onto the node's CURRENT raw metadata rather than replacing it outright.
      const currentNode = await dimensionGraph(store).getNode(snapshot.nodeId);
      const currentMeta = (currentNode?.metadata ?? {}) as Record<string, unknown>;
      const currentAliases = Array.isArray(currentMeta.aliases)
        ? (currentMeta.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
      const currentCanonicalKey = typeof currentMeta.canonicalKey === 'string' ? currentMeta.canonicalKey : undefined;
      const currentForkOf = typeof currentMeta.forkOf === 'string' ? currentMeta.forkOf : undefined;
      const aliasesMatch =
        currentAliases.length === snapshot.aliases.length &&
        currentAliases.every((a, i) => a === snapshot.aliases[i]);
      const alreadyMatchesSnapshot =
        currentCanonicalKey === snapshot.canonicalKey && currentForkOf === snapshot.forkOf && aliasesMatch;
      if (alreadyMatchesSnapshot) {
        repositoryAliasesRestored.push({ nodeId: snapshot.nodeId, canonicalKey: snapshot.canonicalKey, ok: true });
        continue;
      }
      const restoredMeta: Record<string, unknown> = {
        ...currentMeta,
        canonicalKey: snapshot.canonicalKey,
        aliases: snapshot.aliases,
      };
      // Optional fields: match the codebase-wide convention (see repo-nodes.ts
      // writeRepositoryMeta/setRepositoryFork) of OMITTING the key entirely
      // rather than ever writing a literal `undefined` into metadata — never
      // rely on JSON dropping it downstream.
      if (snapshot.forkOf !== undefined) {
        restoredMeta.forkOf = snapshot.forkOf;
      } else {
        delete restoredMeta.forkOf;
      }
      if (snapshot.displayName !== undefined) {
        restoredMeta.displayName = snapshot.displayName;
      } else {
        delete restoredMeta.displayName;
      }
      await withImmediateRetry(() =>
        store.adapter.transaction(
          () => dimensionGraph(store).touch(snapshot.nodeId, { metadata: restoredMeta }),
          { mode: 'immediate' }
        )
      );
      repositoryAliasesRestored.push({ nodeId: snapshot.nodeId, canonicalKey: snapshot.canonicalKey, ok: true });
    } catch (err) {
      repositoryAliasesRestored.push({
        nodeId: snapshot.nodeId,
        canonicalKey: snapshot.canonicalKey,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    backupPath,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    dimensionNodesInvalidated: minted,
    repositoryAliasesRestored,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The transactional context handed to the {@link IEpicABackfillOptions.onAfterRepoEdgeWrite} seam. */
export interface IEpicABackfillItemContext {
  nodeId: number;
  humanId: string;
  repoNodeId: number;
  packageNodeId: number | null;
  /** 0-based position in the write sequence. */
  index: number;
}

/**
 * Options for the READ-ONLY planning sweep ({@link planEpicABackfill}).
 *
 * Split out of {@link IEpicABackfillOptions} so that the planning leg — which
 * cannot write under any argument — keeps an all-optional shape, while the
 * WRITING leg can demand an explicit `dryRun` decision. Sharing one type
 * forced `dryRun` to stay optional on both.
 */
export interface IEpicABackfillPlanOptions {
  /**
   * The repo/package node layer. Defaults to {@link PROVISIONAL_REPO_NODES_API}
   * (itself backed by `store/repo-nodes.ts`'s owner-aware fork-key
   * resolution) — override only for tests that need a stub.
   */
  repoNodes?: IRepoNodesApi;
  /** Recorded in the manifest for provenance. */
  actor?: string;
}

export interface IEpicABackfillOptions extends IEpicABackfillPlanOptions {
  /**
   * REQUIRED, and deliberately not defaulted.
   *
   * `true` reports only and writes NOTHING — not a store row, not a backup
   * file. `false` performs the real, whole-store migration.
   *
   * There is no default because both possible defaults are dangerous for a
   * one-shot admin migration over every item in the store. Defaulting to a
   * real run (the previous behaviour: `options.dryRun === true`, so ANY
   * omission wrote) means a caller that forgets the flag silently rewrites
   * the entire store. Defaulting to a dry run means an operator who believes
   * they have migrated has not, and finds out later. Requiring the caller to
   * state intent is the only option with no silent failure mode, so an
   * omitted or non-boolean `dryRun` is refused at runtime — not just in the
   * type, which an `as` cast or a JS caller can bypass.
   */
  dryRun: boolean;
  /**
   * Directory backup manifests are written under. Tests should always pass a
   * dir inside their own tmp store so backups are cleaned up with everything
   * else.
   */
  backupDir?: string;
  /**
   * **TEST SEAM.** Invoked INSIDE each item's transaction, after the
   * `IN_REPO` edge is written and BEFORE the `IN_PACKAGE` edge is — the exact
   * point at which a non-transactional implementation would leave a
   * half-dimensioned item. Throwing here kills the run deterministically at
   * that seam (no timers, no sleeps), which is how
   * `epic-a-backfill.spec.ts` proves both the rollback and its negative
   * control. Production callers never set it.
   */
  onAfterRepoEdgeWrite?: (ctx: IEpicABackfillItemContext) => void | Promise<void>;
}

export interface IEpicABackfillResult {
  dryRun: boolean;
  plan: IEpicABackfillPlan;
  /** Present whenever a backup was taken (i.e. every real run with at least one item). */
  backupPath?: string;
  repoNodesCreated: string[];
  packageNodesCreated: string[];
  itemsWritten: number;
  itemsSkipped: number;
  staleEdgesRemoved: number;
  /** Repo ambiguity (AC-24), skipped items, and an unverifiable DDL preflight all surface here. Never swallowed. */
  warnings: string[];
}

/**
 * Mirrors `@adhd/sox-graph-store`'s own `writeEdgeInternal` upsert exactly —
 * same columns, same `ON CONFLICT(src, dst, rel) DO UPDATE`, same
 * `origin: 'user_asserted'` — so a row written here is indistinguishable
 * from one `graph.writeEdge()` would have written. The ONLY difference is
 * the absent `typePolicy.validateRel()` call, which is the entire reason this
 * exists (see the file header). The `DO UPDATE ... t_invalid = NULL` clause
 * is also what makes re-linking a previously-invalidated edge work rather
 * than silently no-op'ing on the unique index.
 */
async function insertDimensionEdge(
  tx: { executeRun(sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertRowid: number | bigint }> },
  src: number,
  dst: number,
  rel: string
): Promise<void> {
  const now = new Date().toISOString();
  await tx.executeRun(
    `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
     VALUES (?, ?, ?, ?, 'user_asserted', ?, ?, ?)
     ON CONFLICT(src, dst, rel) DO UPDATE SET
       meta = excluded.meta, weight = excluded.weight,
       t_invalid = NULL, t_valid = excluded.t_valid`,
    [src, dst, rel, 1.0, null, now, now]
  );
}

/**
 * Run the EPIC-A dimension backfill.
 *
 * **This is an explicit admin action.** It must never be called from
 * `openGraphBacklogStore` or from any request path — see the file header.
 *
 * @param store an open backlog store
 * @param options see {@link IEpicABackfillOptions}; `dryRun` writes nothing at all
 * @throws {InvalidArgumentError} on a legacy edge schema, or when the backup cannot be written
 */
export async function runEpicABackfill(
  store: GraphBacklogStore,
  options: IEpicABackfillOptions
): Promise<IEpicABackfillResult> {
  // Refuse an unstated intent BEFORE anything else — before the preflight,
  // before the plan scan, and long before the first write. See
  // `IEpicABackfillOptions.dryRun`: omission used to mean "write the whole
  // store", so a caller that simply forgot the flag performed the real
  // migration. The type now makes `dryRun` required, but this runtime guard
  // is what actually holds: a JS caller, or a TS caller using an `as` cast,
  // bypasses the type entirely.
  if (typeof options?.dryRun !== 'boolean') {
    throw new InvalidArgumentError(
      'dryRun',
      'backlog: runEpicABackfill requires an explicit dryRun boolean — pass { dryRun: true } to report, ' +
        '{ dryRun: false } to perform the real migration. It is never inferred.'
    );
  }
  const api = resolveRepoNodesApi(options);
  const dryRun = options.dryRun;
  const actor = options.actor ?? 'epic-a-backfill';
  const warnings: string[] = [];

  // Preflight FIRST, before the plan scan and long before any write: a store
  // that would reject every edge should say so in one line, not 550.
  const relCheck = await assertEdgeRelVocabularyOpen(store);
  if (relCheck.warning) warnings.push(relCheck.warning);

  const plan = await planEpicABackfill(store, options);
  warnings.push(...plan.warnings);

  if (dryRun) {
    return {
      dryRun: true,
      plan,
      repoNodesCreated: [],
      packageNodesCreated: [],
      itemsWritten: 0,
      itemsSkipped: plan.items.length,
      staleEdgesRemoved: 0,
      warnings,
    };
  }

  // ---- Backup, before ANY write. Fails CLOSED. --------------------------
  const backupDir = options.backupDir ?? DEFAULT_EPIC_A_BACKFILL_BACKUP_DIR;
  const backup = plan.items.length > 0 ? await createEpicABackfillBackup(store, plan, actor, backupDir, api) : undefined;

  // ---- Materialize dimension nodes ---------------------------------------
  // Deliberately OUTSIDE the per-item transactions. Minting a repo node is
  // idempotent and shared by many items; doing it inside one item's
  // transaction would make that item's rollback also destroy a node several
  // other items had already been linked to.
  const repoNodesCreated: string[] = [];
  const packageNodesCreated: string[] = [];
  const repoRefs = new Map<string, IDimensionNodeRef>();
  const packageRefs = new Map<string, IDimensionNodeRef>();

  for (const item of plan.items) {
    if (!repoRefs.has(item.rawRepo)) {
      const ref = await api.canonicalRepoKeyFor(store, item.rawRepo, { create: true });
      if (!ref) {
        throw new InvalidArgumentError(
          'repo',
          `backlog: canonicalRepoKeyFor returned null with create:true for ${JSON.stringify(item.rawRepo)} — the repo-nodes layer must always yield a node on the create path (GRAPH_MODEL_v2 §3).`
        );
      }
      repoRefs.set(item.rawRepo, ref);
      if (ref.created) repoNodesCreated.push(ref.key);
      if (ref.warning && !warnings.includes(ref.warning)) warnings.push(ref.warning);
    }
    const repoRef = repoRefs.get(item.rawRepo)!;
    if (item.projectPath) {
      const key = packageKeyFor(repoRef.key, item.projectPath);
      if (!packageRefs.has(key)) {
        const ref = await api.packageNodeFor(store, repoRef.key, item.projectPath, { create: true });
        if (!ref) {
          throw new InvalidArgumentError(
            'projectPath',
            `backlog: packageNodeFor returned null with create:true for ${JSON.stringify(key)} — the repo-nodes layer must always yield a node on the create path (GRAPH_MODEL_v2 §2.1).`
          );
        }
        packageRefs.set(key, ref);
        if (ref.created) packageNodesCreated.push(ref.key);
      }
    }
  }

  // ---- Per-item edge repair, one immediate transaction each --------------
  let itemsWritten = 0;
  let itemsSkipped = 0;
  let staleEdgesRemoved = 0;
  let index = 0;

  for (const item of plan.items) {
    const repoRef = repoRefs.get(item.rawRepo)!;
    const packageRef = item.projectPath ? (packageRefs.get(packageKeyFor(repoRef.key, item.projectPath)) ?? null) : null;

    // Re-evaluate against the node ids we now actually have. An item the
    // plan called `needsWrite` ONLY because its repo node did not exist yet
    // is still a write; one that already had the right edge is still a skip.
    const repoOk = item.existingRepoEdgeDsts.length === 1 && item.existingRepoEdgeDsts[0] === repoRef.nodeId;
    const packageOk = packageRef
      ? item.existingPackageEdgeDsts.length === 1 && item.existingPackageEdgeDsts[0] === packageRef.nodeId
      : item.existingPackageEdgeDsts.length === 0;
    if (repoOk && packageOk) {
      itemsSkipped += 1;
      continue;
    }

    const ctx: IEpicABackfillItemContext = {
      nodeId: item.nodeId,
      humanId: item.humanId,
      repoNodeId: repoRef.nodeId,
      packageNodeId: packageRef?.nodeId ?? null,
      index,
    };

    // ONE transaction. Everything below either all commits or all rolls back
    // — the whole point of BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001's
    // remediation, applied here before the same defect can be reintroduced.
    const removed = await withImmediateRetry(() =>
      store.adapter.transaction(
        async (tx) => {
          let deleted = 0;

          // 1. Drop every IN_REPO edge that is not the one correct edge.
          //    "exactly one repository edge to the right canonical node" is
          //    the invariant; duplicates and wrong targets are both repairs.
          const delRepo = await tx.executeRun(`DELETE FROM edge WHERE src = ? AND rel = ? AND dst <> ?`, [
            item.nodeId,
            IN_REPO_REL,
            repoRef.nodeId,
          ]);
          deleted += delRepo.rowsAffected;

          // 2. Write the correct IN_REPO edge (upsert — safe on re-run).
          await insertDimensionEdge(tx, item.nodeId, repoRef.nodeId, IN_REPO_REL);

          // TEST SEAM — see IEpicABackfillOptions.onAfterRepoEdgeWrite.
          if (options.onAfterRepoEdgeWrite) await options.onAfterRepoEdgeWrite(ctx);

          // 3. Package edge: exactly one when the item has a projectPath,
          //    none at all when it does not.
          if (packageRef) {
            const delPkg = await tx.executeRun(`DELETE FROM edge WHERE src = ? AND rel = ? AND dst <> ?`, [
              item.nodeId,
              IN_PACKAGE_REL,
              packageRef.nodeId,
            ]);
            deleted += delPkg.rowsAffected;
            await insertDimensionEdge(tx, item.nodeId, packageRef.nodeId, IN_PACKAGE_REL);
          } else {
            const delPkg = await tx.executeRun(`DELETE FROM edge WHERE src = ? AND rel = ?`, [item.nodeId, IN_PACKAGE_REL]);
            deleted += delPkg.rowsAffected;
          }

          return deleted;
        },
        { mode: 'immediate' }
      )
    );

    staleEdgesRemoved += removed;
    itemsWritten += 1;
    index += 1;
  }

  const summary: IEpicABackfillBackupResultSummary = {
    itemsWritten,
    itemsSkipped,
    staleEdgesRemoved,
    repoNodesCreated: repoNodesCreated.length,
    packageNodesCreated: packageNodesCreated.length,
  };
  // Only on a NORMAL return. A run that throws leaves `completedAt` absent —
  // which is exactly the crash signal `findIncompleteEpicABackfillBackups`
  // reads.
  if (backup) await markEpicABackfillBackupComplete(backup.backupPath, summary);

  return {
    dryRun: false,
    plan,
    backupPath: backup?.backupPath,
    repoNodesCreated,
    packageNodesCreated,
    itemsWritten,
    itemsSkipped,
    staleEdgesRemoved,
    warnings,
  };
}
