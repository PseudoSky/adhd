/**
 * repo-nodes.ts — EPIC-A / FEAT-BACKLOG-004: `Repository` and `Package` as
 * FIRST-CLASS GRAPH NODES, linked to backlog items by role-typed edges
 * (GRAPH_MODEL_v2.md §2.1/§2.2/§3), replacing the free-string `repo` field as
 * the *authoritative* repo identity.
 *
 * ## The measured problem this exists to fix
 *
 * `repo` is a free string in two places that can (and did) diverge:
 * `node.namespace` — what every repo-scoped filter keys on today
 * (query.ts:49 `nodeFilter.namespace = filter.repo`) — and `metadata.repo`,
 * what every rendered `BacklogItem.repo` reads (mapping.ts's `toBacklogItem`:
 * `repo: meta.repo ?? node.namespace`). Nothing reconciles two spellings of
 * the SAME repo, so this store currently holds items filed under BOTH `adhd`
 * and `PseudoSky/adhd` — `BUG-001..004`, `DEBT-001`, `DEBT-002`, `TASK-001`
 * and `FEAT-001` all independently exist under both (empirically confirmed,
 * repo-migration.ts:20-24). A query filtered to one key silently returns the
 * other key's items as if they did not exist. That is the "wrong data with no
 * error" class the design forbids outright.
 *
 * The fix is not a smarter string comparison. It is an identity node: one
 * `IRepositoryNode` per real repository, carrying every string ever used to
 * address it in `aliases[]`, so `adhd` and `PseudoSky/adhd` resolve to ONE
 * canonical node and a query through either key returns the union
 * (INTERFACE_v2.md §10.3 AC-7).
 *
 * ## COEXISTENCE — the legacy string field is NOT deleted by this module
 *
 * **`node.namespace` and `metadata.repo` both remain the source of truth for
 * every existing read path until the EPIC-A backfill migration has run AND
 * been verified.** Nothing here deletes, rewrites, or stops writing either
 * field; `createItemNode` keeps stamping them exactly as before. This module
 * only *adds* the node/edge layer alongside them. Concretely:
 *
 *  - {@link findItemNodesInRepository} — the read path — is deliberately a
 *    UNION of two legs: the `IN_REPO` edge leg (the v2 model) and a legacy
 *    leg that string-matches `namespace`/`metadata.repo` against every alias
 *    spelling of the resolved repository node. During coexistence an item that has not
 *    been backfilled yet has no `IN_REPO` edge, and the legacy leg is the only
 *    thing that finds it — dropping that leg before the backfill is verified
 *    would make un-backfilled items invisible, i.e. it would *re-create* the
 *    exact silent-miss bug this work exists to kill.
 *  - The legacy leg is removable in exactly one situation: the backfill
 *    migration has written an `IN_REPO` edge for every live item AND a parity
 *    check has proven the edge leg alone returns the same set. Until that
 *    evidence exists, `includeLegacyAliasMatch` defaults to `true` and callers
 *    must not turn it off in production code.
 *
 * ## Why a second `GraphBackend` over the same adapter
 *
 * `IN_REPO` / `IN_PACKAGE` / `PROJECT_OF` / `AUTHORED_BY` / `REPORTED_BY`
 * (GRAPH_MODEL_v2.md §2.2) are NOT in `@adhd/sox-graph-store`'s
 * `DEFAULT_EDGE_RELS`, and `createGraphBackend(adapter)` with no options
 * installs `DEFAULT_TYPE_POLICY` — the CLOSED ten-rel vocabulary. Measured,
 * not assumed: `store.graph.writeEdge(item, repo, 'IN_REPO')` throws
 * `ConstraintError: Unknown edge rel "IN_REPO". Allowed rels: MENTIONS,
 * SUPPORTS, RELATES_TO, SUPERSEDES, DERIVED_FROM, MEMBER_OF, PART_OF,
 * SAME_AS, ASSIGNED_TO, DEPENDS_ON.`
 *
 * `TypePolicy` injection is upstream's own sanctioned extension point for
 * exactly this ("graph-store owns no vocabulary of its own — a TypePolicy is
 * pure in-process validation with NO reference to DDL", index.d.ts:260-266),
 * so {@link dimensionGraph} builds a SECOND `GraphBackend` over the SAME
 * `StoreAdapter` with {@link backlogTypePolicy}. One connection, one lock, one
 * transaction domain — the two handles differ only in their write-boundary
 * vocabulary check. The rel vocabulary is a *write*-boundary gate only, so
 * edges written through the dimension handle are readable through the plain
 * `store.graph` handle unchanged (verified against the real store).
 *
 * This is deliberately NOT done by editing `openGraphBacklogStore` to pass a
 * policy: that would change the vocabulary of every existing write path in
 * the package at once. Scoping the widened vocabulary to the dimension layer
 * keeps item-level writes on the closed default policy. When EPIC-A's
 * migration lands, `graph-backlog-store.ts` can adopt {@link backlogTypePolicy}
 * wholesale and {@link dimensionGraph} becomes a one-line passthrough.
 *
 * The fresh 0.6.0+ store DDL carries no `rel` CHECK (`INLINE_MIGRATION_DDL`),
 * so no schema migration is needed for the new rels on a store created by
 * this package. A pre-0.6.0 store whose `edge` table still has the closed
 * `CHECK (rel IN (...))` clause (`EDGE_TABLE_DDL`) rejects them at the DDL
 * level and needs the open-schema edge-table rebuild first — that is the
 * migration's job (GRAPH_MODEL_v2.md §7 step 2), not this module's.
 */
import {
  DEFAULT_EDGE_RELS,
  DEFAULT_NODE_KINDS,
  createGraphBackend,
  type GraphBackend,
  type NodeRecord,
  type TypePolicy,
} from '@adhd/sox-graph-store';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { BacklogItem, IPackageNode, IRepositoryNode } from '../model.js';
import { InvalidArgumentError } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, toBacklogItem } from './mapping.js';
import { withImmediateRetry } from './immediate-retry.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Tag identifying a repository dimension node (GRAPH_MODEL_v2.md §2.1). */
export const BACKLOG_REPO_TAG = 'backlog-repo';
/** Tag identifying a package dimension node (GRAPH_MODEL_v2.md §2.1). */
export const BACKLOG_PACKAGE_TAG = 'backlog-package';

/**
 * Dimension nodes live in their own reserved namespace so they can never be
 * confused with — or swept up by — a repo-scoped item scan. Every item query
 * in this package filters `kind: 'generic'` + `tags: ['backlog-item']`
 * (query.ts's `nodeFilterFromBacklogFilter`), and dimension nodes are
 * `kind: 'entity'`, so the separation is already twofold; the namespace makes
 * it threefold and keeps `namespace = <repo>` meaning exactly one thing.
 *
 * The literal value MUST stay byte-identical to `epic-a-backfill.ts`'s
 * `BACKLOG_DIMENSION_NAMESPACE` (epic-a-backfill.ts:154). `queryNodes` filters
 * on the namespace exactly, so two spellings would give this module and the
 * backfill migration each their OWN invisible set of repository nodes — a
 * split-brain in which the backfill mints `adhd` and this module never finds
 * it, then mints a second `adhd`. That is the same silent-partial-corpus
 * failure AC-7 exists to kill, reintroduced one layer up.
 */
export const BACKLOG_DIMENSION_NAMESPACE = 'backlog-dimensions';

/** Dimension nodes are `entity` — a member of `DEFAULT_NODE_KINDS`, so no kind-policy widening is needed. */
export const BACKLOG_DIMENSION_KIND = 'entity';

/** item → repository (GRAPH_MODEL_v2.md §2.2). */
export const REL_IN_REPO = 'IN_REPO';
/** item → package (GRAPH_MODEL_v2.md §2.2). */
export const REL_IN_PACKAGE = 'IN_PACKAGE';
/** repository → project (GRAPH_MODEL_v2.md §2.2). Reserved here so the policy accepts it when the project node lands. */
export const REL_PROJECT_OF = 'PROJECT_OF';
/** item → identity, author role (GRAPH_MODEL_v2.md §2.2). Reserved for the identity-node agent. */
export const REL_AUTHORED_BY = 'AUTHORED_BY';
/** item → identity, reporter role (GRAPH_MODEL_v2.md §2.2). Reserved for the identity-node agent. */
export const REL_REPORTED_BY = 'REPORTED_BY';

/**
 * package → repository. Deliberately `PART_OF`, which is ALREADY in
 * `DEFAULT_EDGE_RELS` — a package genuinely is a part of its repository, and
 * reusing an existing rel costs nothing. Disambiguated by the destination
 * node's tag exactly the way GRAPH_MODEL_v2.md §2.2 disambiguates its reused
 * `MEMBER_OF` ("the node kind disambiguates plan-membership from any other
 * `MEMBER_OF` use").
 */
export const REL_PACKAGE_PART_OF_REPO = 'PART_OF';

/**
 * fork → upstream repository. `DERIVED_FROM` is likewise already in
 * `DEFAULT_EDGE_RELS` and means precisely this; GRAPH_MODEL_v2.md §2.2 names
 * no dedicated fork rel, so no vocabulary is invented for it.
 */
export const REL_FORK_OF = 'DERIVED_FROM';

/** The five new dimension rels this package adds on top of `DEFAULT_EDGE_RELS`. */
export const BACKLOG_DIMENSION_RELS: readonly string[] = [
  REL_IN_REPO,
  REL_IN_PACKAGE,
  REL_PROJECT_OF,
  REL_AUTHORED_BY,
  REL_REPORTED_BY,
];

/** `DEFAULT_EDGE_RELS` widened by {@link BACKLOG_DIMENSION_RELS} — the backlog's full rel vocabulary. */
export const BACKLOG_EDGE_RELS: readonly string[] = [
  ...(DEFAULT_EDGE_RELS as readonly string[]),
  ...BACKLOG_DIMENSION_RELS,
];

/**
 * The backlog's `TypePolicy`: upstream's default node-kind vocabulary,
 * upstream's rel vocabulary PLUS the five dimension rels. Kinds are
 * deliberately NOT widened — every node this package writes is `generic`
 * (items) or `entity` (dimensions), both already in `DEFAULT_NODE_KINDS`.
 *
 * The error messages mirror upstream's own `ConstraintError` wording so a
 * rejection reads the same whichever policy produced it.
 */
export const backlogTypePolicy: TypePolicy = {
  validateKind(kind: string): void {
    if (!(DEFAULT_NODE_KINDS as readonly string[]).includes(kind)) {
      throw new InvalidArgumentError(
        'kind',
        `backlog: unknown node kind ${JSON.stringify(kind)}. Allowed kinds: ${DEFAULT_NODE_KINDS.join(', ')}.`
      );
    }
  },
  validateRel(rel: string): void {
    if (!BACKLOG_EDGE_RELS.includes(rel)) {
      throw new InvalidArgumentError(
        'rel',
        `backlog: unknown edge rel ${JSON.stringify(rel)}. Allowed rels: ${BACKLOG_EDGE_RELS.join(', ')}.`
      );
    }
  },
};

/**
 * One dimension-vocabulary `GraphBackend` per `StoreAdapter`, memoized. Keyed
 * on the adapter (not the `GraphBacklogStore` wrapper) because the adapter IS
 * the connection: two `GraphBacklogStore` objects over one adapter must share
 * one dimension handle, and a closed adapter drops out of the map with the
 * store that owned it.
 *
 * @param store an open backlog store
 * @returns a `GraphBackend` on the same connection whose write boundary
 *   accepts the five dimension rels
 */
export function dimensionGraph(store: GraphBacklogStore): GraphBackend {
  const cached = DIMENSION_GRAPHS.get(store.adapter);
  if (cached) return cached;
  const created = createGraphBackend(store.adapter, { typePolicy: backlogTypePolicy });
  DIMENSION_GRAPHS.set(store.adapter, created);
  return created;
}

const DIMENSION_GRAPHS = new WeakMap<StoreAdapter, GraphBackend>();

// ---------------------------------------------------------------------------
// Key normalization (GRAPH_MODEL_v2.md §3)
// ---------------------------------------------------------------------------

/** The deterministic parts a raw repo string normalizes to. */
export interface IRepoKeyParts {
  /** `owner/name` when an owner segment survives normalization, else just `name`. */
  qualified: string;
  /** The bare last path segment — the canonical key when it is unambiguous. */
  bare: string;
  /** The owner segment, when the raw string carried one. */
  owner?: string;
}

/**
 * Deterministic repo-key normalization (GRAPH_MODEL_v2.md §3): trim, strip a
 * URL scheme, strip an `scp`-style `user@host:` prefix, strip a trailing
 * `.git`, collapse slashes, then take the last segment as the bare name and
 * the one before it as the owner. A `host` segment (anything containing a
 * dot, e.g. `github.com`) is dropped so `https://github.com/PseudoSky/adhd.git`
 * and `git@github.com:PseudoSky/adhd.git` both normalize to the same
 * `{ qualified: 'PseudoSky/adhd', bare: 'adhd', owner: 'PseudoSky' }`.
 *
 * Pure and total for any non-empty string — resolution against what the store
 * already knows happens in {@link resolveRepository}, never here.
 *
 * Deliberately NOT named `normalizeRepoKey`: `model.ts` already exports that
 * name with a DIFFERENT signature (`(raw) => string`, the bare name —
 * model.ts:1924), and `epic-a-backfill.ts` imports that one. Two same-named
 * exports with different return types in one package is a mis-import waiting
 * to happen, so this parts-returning function carries its own name and
 * {@link canonicalRepoKey} is the value-compatible bridge to model's.
 *
 * @throws InvalidArgumentError when `raw` is not a non-empty string, or
 *   normalizes away to nothing (e.g. `"/"`, `".git"`).
 */
export function parseRepoKey(raw: string): IRepoKeyParts {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArgumentError('repo', `backlog: repo key must be a non-empty string, received ${JSON.stringify(raw)}`);
  }
  let work = raw.trim();
  work = work.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // scheme://
  work = work.replace(/^[^/@\s]+@([^/:\s]+):/, '$1/'); // git@host:owner/name -> host/owner/name
  work = work.replace(/\.git$/i, '');
  const segments = work
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
  // A leading host segment (`github.com`, `gitlab.example.org`) is transport,
  // not identity — two remotes for the same repo differ only there.
  while (segments.length > 2 && segments[0]?.includes('.')) segments.shift();
  if (segments.length === 2 && segments[0]?.includes('.')) segments.shift();
  const bare = segments[segments.length - 1];
  if (!bare) {
    throw new InvalidArgumentError('repo', `backlog: repo key ${JSON.stringify(raw)} normalizes to an empty key`);
  }
  const owner = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  return { qualified: owner ? `${owner}/${bare}` : bare, bare, owner };
}

/**
 * The deterministic-normalization half of GRAPH_MODEL_v2.md §3's
 * `canonicalRepoKey`: the bare name. The *store-aware* half — "the bare name
 * wins iff no other known repo shares that segment" — is
 * {@link resolveRepository}, which is the only thing that can decide it.
 *
 * Returns the SAME value as `model.ts`'s `normalizeRepoKey` for every repo
 * spelling (locked by a test in `repo-nodes.spec.ts`); the two must never
 * disagree, or this module and `epic-a-backfill.ts` would disagree about
 * which node a raw key belongs to.
 */
export function canonicalRepoKey(raw: string): string {
  return parseRepoKey(raw).bare;
}

/** Normalizes a package path: strips `./`, leading/trailing slashes, collapses runs of slashes. */
export function normalizePackagePath(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArgumentError('packagePath', `backlog: package path must be a non-empty string, received ${JSON.stringify(raw)}`);
  }
  const normalized = raw
    .trim()
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');
  if (normalized.length === 0) {
    throw new InvalidArgumentError('packagePath', `backlog: package path ${JSON.stringify(raw)} normalizes to an empty path`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Node shapes
// ---------------------------------------------------------------------------

/**
 * A repository as a first-class graph node — the authoritative repo identity
 * that replaces the free `repo` string as the thing queries resolve against
 * (the string field itself stays, see this file's COEXISTENCE section).
 *
 * The FIELD contract is `model.ts`'s {@link IRepositoryNode} (model.ts:1868),
 * deliberately imported rather than restated: `epic-a-backfill.ts` binds to
 * that same interface (epic-a-backfill.ts:113), so a second, structurally
 * different declaration of the same name here would let the two halves of
 * EPIC-A drift apart while both still compiled in isolation. This adds only
 * the rowid, which is storage identity rather than domain contract and so has
 * no business in `model.ts`.
 *
 * NOTE the `aliases` contract inherited from `model.ts`: it holds every OTHER
 * spelling and **never includes `canonicalKey`**. Use {@link allSpellings}
 * whenever you need "every string that addresses this repo".
 */
export interface IRepositoryNodeRecord extends IRepositoryNode {
  /** The graph node rowid. Stable for the life of the repository — never rewritten by reconciliation. */
  nodeId: number;
}

/**
 * A package (nx project / directory) as a first-class node, linked to its
 * repository. Field contract is `model.ts`'s {@link IPackageNode}
 * (model.ts:1880) for the same reason as {@link IRepositoryNodeRecord}; note
 * it names the owning repo `repo` (the PERSISTED metadata key is `repoKey` —
 * see {@link IPackageNodeMeta}) and requires `projectName`.
 */
export interface IPackageNodeRecord extends IPackageNode {
  /** The graph node rowid. */
  nodeId: number;
}

/**
 * The full outcome of resolving a raw repo string. `warnings` is non-empty
 * exactly when resolution was ambiguous — GRAPH_MODEL_v2.md §3 and
 * INTERFACE_v2.md AC-24 both require ambiguity to be *surfaced*, never a
 * silent narrow, so callers must propagate these into the outcome envelope's
 * `warnings` rather than dropping them.
 */
export interface IRepositoryResolution {
  node: IRepositoryNodeRecord;
  /** True when this call minted the node. */
  created: boolean;
  /** True when this call folded a previously-unknown spelling into `node.aliases`. */
  aliasAdded: boolean;
  /** True when more than one known repository shares the bare name and a winner had to be chosen. */
  ambiguous: boolean;
  warnings: string[];
}

/** Persisted `metadata` shape of a repository node (GRAPH_MODEL_v2.md §2.1). */
interface IRepositoryNodeMeta {
  canonicalKey: string;
  aliases: string[];
  forkOf?: string;
}

/**
 * Persisted `metadata` shape of a package node (GRAPH_MODEL_v2.md §2.1).
 * The stored keys are `repoKey`/`projectPath`, which is NOT the in-memory
 * field naming ({@link IPackageNode} uses `repo`/`path`). The split is
 * `epic-a-backfill.ts`'s (epic-a-backfill.ts:317-318, :414) and is matched
 * exactly here so either module can read the other's nodes.
 */
interface IPackageNodeMeta {
  repoKey: string;
  projectPath: string;
  projectName: string;
}

// ---------------------------------------------------------------------------
// Node content / read helpers
// ---------------------------------------------------------------------------

/**
 * `writeNode()` dedupes GLOBALLY on `sha256(content.trim().toLowerCase())`
 * and, on a hit, returns the existing rowid WITHOUT applying the new node's
 * meta (mapping.ts's file-level DEVIATION note; re-verified here against the
 * real store). For dimension nodes that behaviour is an ally, not a hazard,
 * *provided* content is a pure function of the canonical key: two concurrent
 * resolutions of the same repo then converge on one rowid instead of racing
 * to create two. The `<!-- ... -->` marker makes that collision intentional
 * and total — and, being a distinct prefix from mapping.ts's item marker, it
 * can never collide with an item's content.
 *
 * Because meta is NOT applied on a dedupe hit, every metadata change after
 * creation goes through `touch()` under `BEGIN IMMEDIATE` (see
 * {@link writeRepositoryMeta}) — never a re-`writeNode`.
 *
 * The rendered string MUST stay byte-identical to `epic-a-backfill.ts`'s
 * `dimensionContent()` (epic-a-backfill.ts:256-258). Dedupe is on
 * `sha256(content.trim().toLowerCase())`, so a marker that differs by even
 * one character makes this module and the backfill mint TWO nodes for one
 * repository instead of converging on the rowid that already exists — the
 * fork-key duplication bug, recreated at the dimension layer.
 */
function dimensionContent(kindLabel: string, key: string): string {
  return `${kindLabel}: ${key}\n\n<!-- adhd-backlog-dim:${kindLabel}::${key} -->`;
}

function repoNodeContent(canonicalKey: string): string {
  return dimensionContent(BACKLOG_REPO_TAG, canonicalKey);
}

/** `${canonicalRepoKey}::${normalizedPath}` — the package's identity, matching `epic-a-backfill.ts`'s `packageKeyFor`. */
export function packageKeyFor(repoKey: string, path: string): string {
  return `${repoKey}::${path}`;
}

function packageNodeContent(repoKey: string, path: string): string {
  return dimensionContent(BACKLOG_PACKAGE_TAG, packageKeyFor(repoKey, path));
}

/** A dimension node counts as live iff it is neither invalidated nor superseded — same rule as `isLiveBacklogItemNode`. */
function isLiveDimensionNode(node: NodeRecord): boolean {
  return !node.tInvalid && !node.isSuperseded;
}

function toRepositoryNode(node: NodeRecord): IRepositoryNodeRecord {
  const meta = (node.metadata ?? {}) as Partial<IRepositoryNodeMeta>;
  const canonicalKey = meta.canonicalKey ?? node.name ?? '';
  const stored = Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === 'string') : [];
  const node_: IRepositoryNodeRecord = {
    nodeId: node.id,
    canonicalKey,
    // `aliases` excludes `canonicalKey` (model.ts:1871). A node written by
    // `epic-a-backfill.ts` already honours that, but a hand-written or
    // older-shaped node might not, so it is enforced on the way in rather
    // than assumed.
    aliases: withoutKey(uniqueKeys(stored), canonicalKey),
  };
  if (typeof meta.forkOf === 'string' && meta.forkOf.length > 0) node_.forkOf = meta.forkOf;
  return node_;
}

function toPackageNode(node: NodeRecord): IPackageNodeRecord {
  const meta = (node.metadata ?? {}) as Partial<IPackageNodeMeta>;
  const path = meta.projectPath ?? '';
  return {
    nodeId: node.id,
    repo: meta.repoKey ?? '',
    path,
    // `projectName` is required by the contract, so an older node that lacks
    // one falls back to the same last-path-segment default the backfill
    // stamps (epic-a-backfill.ts:404) rather than surfacing `undefined`
    // through a non-optional field.
    projectName:
      typeof meta.projectName === 'string' && meta.projectName.length > 0 ? meta.projectName : defaultProjectName(path),
  };
}

/**
 * GRAPH_MODEL §2.1 notes an nx project name "is not always the last path
 * segment", so this is an honest DEFAULT for a caller that does not know the
 * real name — never a claim to have looked it up. `resolvePackage` upgrades it
 * in place the moment a caller supplies the true name.
 */
function defaultProjectName(path: string): string {
  return path.split('/').filter((s) => s.length > 0).pop() ?? path;
}

/** Every string that addresses this repository: `canonicalKey` first, then each alias. */
function allSpellings(repo: IRepositoryNodeRecord): string[] {
  return uniqueKeys([repo.canonicalKey, ...repo.aliases]);
}

/** `keys` minus `key`, case-insensitively — how `aliases` is kept free of `canonicalKey`. */
function withoutKey(keys: readonly string[], key: string): string[] {
  const lower = key.toLowerCase();
  return keys.filter((k) => k.toLowerCase() !== lower);
}

/** Case-insensitive de-duplication that preserves each key's first-seen spelling. */
function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(key);
  }
  return out;
}

/**
 * Every live repository node in the store. Repos number in the tens even in a
 * large multi-repo backlog, so alias resolution loads them all and matches in
 * memory rather than pushing a (necessarily JSON-scanning) alias predicate
 * into SQL.
 */
export async function listRepositoryNodes(store: GraphBacklogStore): Promise<IRepositoryNodeRecord[]> {
  const nodes = await dimensionGraph(store).queryNodes({
    kind: BACKLOG_DIMENSION_KIND,
    tags: [BACKLOG_REPO_TAG],
    tagsMatchAll: true,
    namespace: BACKLOG_DIMENSION_NAMESPACE,
  });
  return nodes.filter(isLiveDimensionNode).map(toRepositoryNode).sort((a, b) => a.nodeId - b.nodeId);
}

/**
 * Every live package node in the store, across every repository. Added for
 * `IRepoNodesApi` (epic-a-backfill.ts's port): a whole-corpus sweep needs a
 * single scan rather than one `packagesOfRepository` call per distinct repo
 * key it discovers along the way.
 */
export async function listPackageNodes(store: GraphBacklogStore): Promise<IPackageNodeRecord[]> {
  const nodes = await dimensionGraph(store).queryNodes({
    kind: BACKLOG_DIMENSION_KIND,
    tags: [BACKLOG_PACKAGE_TAG],
    tagsMatchAll: true,
    namespace: BACKLOG_DIMENSION_NAMESPACE,
  });
  return nodes.filter(isLiveDimensionNode).map(toPackageNode).sort((a, b) => a.nodeId - b.nodeId);
}

/** Every distinct owner segment appearing in this repository's known spellings. */
function knownOwners(repo: IRepositoryNodeRecord): Set<string> {
  const owners = new Set<string>();
  for (const alias of allSpellings(repo)) {
    let parts: IRepoKeyParts;
    try {
      parts = parseRepoKey(alias);
    } catch {
      continue; // a malformed persisted alias must never break resolution
    }
    if (parts.owner) owners.add(parts.owner.toLowerCase());
  }
  return owners;
}

/** True iff any known spelling of `repo` normalizes to `bare`. */
function sharesBareName(repo: IRepositoryNodeRecord, bare: string): boolean {
  const target = bare.toLowerCase();
  return allSpellings(repo).some((alias) => {
    try {
      return parseRepoKey(alias).bare.toLowerCase() === target;
    } catch {
      return false;
    }
  });
}

function matchesExactly(repo: IRepositoryNodeRecord, parts: IRepoKeyParts): boolean {
  const wanted = parts.qualified.toLowerCase();
  return allSpellings(repo).some((alias) => {
    if (alias.toLowerCase() === wanted) return true;
    try {
      return parseRepoKey(alias).qualified.toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Resolution (GRAPH_MODEL_v2.md §3)
// ---------------------------------------------------------------------------

/**
 * The decision half of resolution, as a pure function of the raw key and what
 * the store already knows. Split out from the I/O so the fork-key rules are
 * testable without a database and so the read path
 * ({@link lookupRepository}) and the write path ({@link resolveRepository})
 * can never drift apart — they share this one decision.
 */
type IRepoDecision =
  | { action: 'hit'; repo: IRepositoryNodeRecord; ambiguous: boolean; warnings: string[] }
  | { action: 'fold'; repo: IRepositoryNodeRecord; ambiguous: boolean; warnings: string[] }
  | { action: 'create'; canonicalKey: string; aliases: string[]; warnings: string[] };

function decideRepository(parts: IRepoKeyParts, known: readonly IRepositoryNodeRecord[]): IRepoDecision {
  const exact = known.find((repo) => matchesExactly(repo, parts));
  if (exact) {
    // An exact alias hit narrows correctly — but if the caller passed a BARE
    // name and some OTHER repository also answers to that bare name, the
    // narrowing is still a choice among several, and AC-24 forbids making it
    // silently. The hit stands; the warning makes it honest.
    const others = known.filter((repo) => repo.nodeId !== exact.nodeId && sharesBareName(repo, parts.bare));
    if (parts.owner === undefined && others.length > 0) {
      return { action: 'hit', repo: exact, ambiguous: true, warnings: [ambiguityWarning(parts, [exact, ...others], exact)] };
    }
    return { action: 'hit', repo: exact, ambiguous: false, warnings: [] };
  }

  const candidates = known.filter((repo) => sharesBareName(repo, parts.bare));

  if (candidates.length === 0) {
    // Nothing in the store shares this bare name: the bare name wins, and the
    // caller's own (possibly qualified) spelling is recorded as an alias so a
    // later query through EITHER spelling lands here. This is the whole
    // fork-key fix in one line — `PseudoSky/adhd` filed first still answers to
    // a bare `adhd` query afterwards.
    return {
      action: 'create',
      canonicalKey: parts.bare,
      // `aliases` never carries `canonicalKey` (model.ts:1871), so a bare
      // input yields an EMPTY alias list and a qualified one records only the
      // qualified spelling.
      aliases: withoutKey(uniqueKeys([parts.qualified]), parts.bare),
      warnings: [],
    };
  }

  if (parts.owner === undefined) {
    // A bare input can only ever narrow by bare name. One candidate is
    // unambiguous; more than one is the genuine ambiguity AC-24 requires be
    // surfaced rather than silently narrowed.
    const onlyCandidate = soleMatch(candidates);
    if (onlyCandidate) return { action: 'fold', repo: onlyCandidate, ambiguous: false, warnings: [] };
    return ambiguousDecision(parts, candidates);
  }

  const ownerLower = parts.owner.toLowerCase();
  const ownerMatches = candidates.filter((repo) => knownOwners(repo).has(ownerLower));
  const soleOwnerMatch = soleMatch(ownerMatches);
  if (soleOwnerMatch) return { action: 'fold', repo: soleOwnerMatch, ambiguous: false, warnings: [] };
  if (ownerMatches.length > 1) return ambiguousDecision(parts, ownerMatches);

  // No candidate knows this owner. A candidate that knows NO owner at all is
  // the unqualified spelling of some repo — which is exactly the measured
  // `adhd` (no owner) vs `PseudoSky/adhd` (owner) fork-key split, so the
  // qualified spelling folds into it. A candidate that knows a DIFFERENT
  // owner is a genuinely different repository that merely shares a bare name,
  // and must get its own node.
  const unowned = candidates.filter((repo) => knownOwners(repo).size === 0);
  const soleUnowned = soleMatch(unowned);
  if (soleUnowned) return { action: 'fold', repo: soleUnowned, ambiguous: false, warnings: [] };
  if (unowned.length > 1) return ambiguousDecision(parts, unowned);

  return {
    action: 'create',
    canonicalKey: parts.qualified,
    aliases: [],
    warnings: [
      `backlog: repository ${JSON.stringify(parts.qualified)} shares the bare name ${JSON.stringify(parts.bare)} with ` +
        `${candidates.map((c) => JSON.stringify(c.canonicalKey)).join(', ')} — it is being tracked as a SEPARATE repository, ` +
        `and the bare name ${JSON.stringify(parts.bare)} is now ambiguous. Qualify it (owner/name) to address either one unambiguously.`,
    ],
  };
}

/** The single element of `matches`, or `undefined` when there is not exactly one. */
function soleMatch(matches: readonly IRepositoryNodeRecord[]): IRepositoryNodeRecord | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

/** Only ever reached from a branch with two or more candidates, so `reduce` needs no seed. */
function ambiguousDecision(parts: IRepoKeyParts, candidates: readonly IRepositoryNodeRecord[]): IRepoDecision {
  // Deterministic winner: lowest nodeId — the repository that was known
  // first. Deterministic matters more than clever here; the warning is what
  // makes the choice honest.
  const winner = candidates.reduce((lowest, repo) => (repo.nodeId < lowest.nodeId ? repo : lowest));
  return { action: 'fold', repo: winner, ambiguous: true, warnings: [ambiguityWarning(parts, candidates, winner)] };
}

/** The one wording for "this bare name matches more than one repository" (AC-24), shared by every path that can hit it. */
function ambiguityWarning(parts: IRepoKeyParts, candidates: readonly IRepositoryNodeRecord[], winner: IRepositoryNodeRecord): string {
  const names = [...candidates].sort((a, b) => a.nodeId - b.nodeId).map((c) => JSON.stringify(c.canonicalKey)).join(', ');
  return (
    `backlog: repo key ${JSON.stringify(parts.qualified)} is ambiguous — ${candidates.length} known repositories share the ` +
    `bare name ${JSON.stringify(parts.bare)}: ${names}. Resolved to ${JSON.stringify(winner.canonicalKey)}. ` +
    `Qualify the key (owner/name) to select a different one.`
  );
}

/**
 * Resolves any spelling of a repository to its canonical node, MINTING the
 * node on first use and folding a previously-unknown spelling into
 * `aliases[]` (GRAPH_MODEL_v2.md §3). This is the write-path entry point —
 * `createItem`, `migrateRepo`, and the EPIC-A backfill call it.
 *
 * Read paths must call {@link lookupRepository} instead: a *query* for an
 * unknown repo must return nothing, never mint a repository node as a side
 * effect of being asked about it.
 *
 * The read-modify-write of `aliases[]` runs inside `BEGIN IMMEDIATE` under
 * `withImmediateRetry`, exactly like `mutateMetadata` — `touch()` replaces
 * `meta` wholesale, so two concurrent resolutions of two different spellings
 * would otherwise lose one alias. Node creation is separately safe by
 * construction: `writeNode`'s global content-hash dedupe means both racers
 * converge on the same rowid (see {@link repoNodeContent}).
 *
 * @param store an open backlog store
 * @param raw any spelling of the repo — `adhd`, `PseudoSky/adhd`,
 *   `git@github.com:PseudoSky/adhd.git`, `https://github.com/PseudoSky/adhd`
 * @returns the canonical node plus whether it was created, whether an alias
 *   was folded in, and any ambiguity warnings the caller MUST surface
 */
export async function resolveRepository(store: GraphBacklogStore, raw: string): Promise<IRepositoryResolution> {
  const parts = parseRepoKey(raw);
  return withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        // Re-read inside the transaction: a concurrent resolution may have
        // created the node or folded an alias since the caller last looked.
        const known = await listRepositoryNodes(store);
        const decision = decideRepository(parts, known);

        if (decision.action === 'create') {
          const meta: IRepositoryNodeMeta = { canonicalKey: decision.canonicalKey, aliases: decision.aliases };
          const nodeId = await dimensionGraph(store).writeNode(repoNodeContent(decision.canonicalKey), {
            kind: BACKLOG_DIMENSION_KIND,
            name: decision.canonicalKey,
            summary: `Repository ${decision.canonicalKey}`,
            tags: [BACKLOG_REPO_TAG],
            namespace: BACKLOG_DIMENSION_NAMESPACE,
            metadata: meta as unknown as Record<string, unknown>,
          });
          // A content-hash dedupe hit returns an existing rowid WITHOUT
          // applying meta, so the alias set is written explicitly either way.
          await writeRepositoryMeta(store, nodeId, meta);
          return {
            node: { nodeId, canonicalKey: decision.canonicalKey, aliases: decision.aliases },
            created: true,
            aliasAdded: false,
            ambiguous: false,
            warnings: decision.warnings,
          };
        }

        const repo = decision.repo;
        const merged = withoutKey(uniqueKeys([...repo.aliases, parts.qualified, parts.bare]), repo.canonicalKey);
        const aliasAdded = merged.length !== repo.aliases.length;
        if (aliasAdded) {
          const meta: IRepositoryNodeMeta = { canonicalKey: repo.canonicalKey, aliases: merged };
          if (repo.forkOf) meta.forkOf = repo.forkOf;
          await writeRepositoryMeta(store, repo.nodeId, meta);
        }
        return {
          node: { ...repo, aliases: merged },
          created: false,
          aliasAdded,
          ambiguous: decision.ambiguous,
          warnings: decision.warnings,
        };
      },
      { mode: 'immediate' }
    )
  );
}

/**
 * Read-only resolution: returns the canonical node for any known spelling, or
 * `null` when no repository in the store answers to it. Never writes — the
 * query path must not mint a repository node just because someone asked about
 * one (and must not fold aliases in on a read either).
 *
 * @returns the resolution, or `null` when the key is unknown to this store
 */
export async function lookupRepository(store: GraphBacklogStore, raw: string): Promise<IRepositoryResolution | null> {
  const parts = parseRepoKey(raw);
  const known = await listRepositoryNodes(store);
  const decision = decideRepository(parts, known);
  if (decision.action === 'create') return null;
  return { node: decision.repo, created: false, aliasAdded: false, ambiguous: decision.ambiguous, warnings: decision.warnings };
}

/** Writes a repository node's COMPLETE metadata object (`touch()` replaces `meta` wholesale — never pass a partial). */
async function writeRepositoryMeta(store: GraphBacklogStore, nodeId: number, meta: IRepositoryNodeMeta): Promise<void> {
  await dimensionGraph(store).touch(nodeId, { metadata: meta as unknown as Record<string, unknown> });
}

/**
 * Records that `forkRaw` is a fork of `upstreamRaw`: a `DERIVED_FROM` edge
 * fork → upstream plus a `forkOf` stamp carrying the upstream's canonical key
 * (the edge is the graph fact; the stamp is what {@link IRepositoryNode}
 * surfaces without a traversal).
 *
 * Both repositories are resolved (and minted if unknown) first, so a fork can
 * be declared before either side has any items.
 *
 * @throws InvalidArgumentError when both keys resolve to the SAME node — a
 *   repository cannot be its own fork, and silently writing a self-edge would
 *   make `forkOf` a lie.
 */
export async function setRepositoryFork(
  store: GraphBacklogStore,
  forkRaw: string,
  upstreamRaw: string
): Promise<{ fork: IRepositoryNodeRecord; upstream: IRepositoryNodeRecord; warnings: string[] }> {
  const upstream = await resolveRepository(store, upstreamRaw);
  const fork = await resolveRepository(store, forkRaw);
  if (fork.node.nodeId === upstream.node.nodeId) {
    throw new InvalidArgumentError(
      'forkOf',
      `backlog: ${JSON.stringify(forkRaw)} and ${JSON.stringify(upstreamRaw)} resolve to the SAME repository ` +
        `(${JSON.stringify(fork.node.canonicalKey)}) — a repository cannot be a fork of itself.`
    );
  }
  await dimensionGraph(store).writeEdge(fork.node.nodeId, upstream.node.nodeId, REL_FORK_OF);
  const meta: IRepositoryNodeMeta = {
    canonicalKey: fork.node.canonicalKey,
    aliases: fork.node.aliases,
    forkOf: upstream.node.canonicalKey,
  };
  await withImmediateRetry(() =>
    store.adapter.transaction(() => writeRepositoryMeta(store, fork.node.nodeId, meta), { mode: 'immediate' })
  );
  return {
    fork: { ...fork.node, forkOf: upstream.node.canonicalKey },
    upstream: upstream.node,
    warnings: [...fork.warnings, ...upstream.warnings],
  };
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/** Input describing a package: its repo, its repo-relative path, and optionally its nx project name. */
export interface IPackageInput {
  repo: string;
  path: string;
  /** The nx project name (`backlog`, `apigen-core-client`). */
  projectName?: string;
}

/**
 * Resolves (minting on first use) the package node for `input`, linked to its
 * repository by a `PART_OF` edge. The package's identity is
 * `${canonicalRepoKey}::${normalizedPath}` — the path is the identity, the nx
 * project name is descriptive metadata that can be filled in later without
 * changing which node the package is.
 */
export async function resolvePackage(
  store: GraphBacklogStore,
  input: IPackageInput
): Promise<{ node: IPackageNodeRecord; repository: IRepositoryNodeRecord; created: boolean; warnings: string[] }> {
  const repository = await resolveRepository(store, input.repo);
  const path = normalizePackagePath(input.path);
  const repoKey = repository.node.canonicalKey;

  return withImmediateRetry(() =>
    store.adapter.transaction(
      async () => {
        const existing = (
          await dimensionGraph(store).queryNodes({
            kind: BACKLOG_DIMENSION_KIND,
            tags: [BACKLOG_PACKAGE_TAG],
            tagsMatchAll: true,
            namespace: BACKLOG_DIMENSION_NAMESPACE,
            metadata: { repoKey, projectPath: path },
          })
        ).filter(isLiveDimensionNode);

        const meta: IPackageNodeMeta = {
          repoKey,
          projectPath: path,
          projectName: input.projectName ?? defaultProjectName(path),
        };

        const [node] = existing;
        if (node) {
          const current = toPackageNode(node);
          // Fill in a project name learned later; never erase a known one
          // with the last-path-segment default, which is a guess.
          if (input.projectName && current.projectName !== input.projectName) {
            await dimensionGraph(store).touch(node.id, { metadata: meta as unknown as Record<string, unknown> });
            return {
              node: { ...current, projectName: input.projectName },
              repository: repository.node,
              created: false,
              warnings: repository.warnings,
            };
          }
          return { node: current, repository: repository.node, created: false, warnings: repository.warnings };
        }

        const nodeId = await dimensionGraph(store).writeNode(packageNodeContent(repoKey, path), {
          kind: BACKLOG_DIMENSION_KIND,
          name: packageKeyFor(repoKey, path),
          summary: `Package ${packageKeyFor(repoKey, path)}`,
          tags: [BACKLOG_PACKAGE_TAG],
          namespace: BACKLOG_DIMENSION_NAMESPACE,
          metadata: meta as unknown as Record<string, unknown>,
        });
        await dimensionGraph(store).touch(nodeId, { metadata: meta as unknown as Record<string, unknown> });
        await dimensionGraph(store).writeEdge(nodeId, repository.node.nodeId, REL_PACKAGE_PART_OF_REPO);
        const built: IPackageNodeRecord = { nodeId, repo: repoKey, path, projectName: meta.projectName };
        return { node: built, repository: repository.node, created: true, warnings: repository.warnings };
      },
      { mode: 'immediate' }
    )
  );
}

/** Every live package node belonging to the repository `repoRaw` resolves to. Empty when the repo is unknown. */
export async function packagesOfRepository(store: GraphBacklogStore, repoRaw: string): Promise<IPackageNodeRecord[]> {
  const resolution = await lookupRepository(store, repoRaw);
  if (!resolution) return [];
  const edges = await dimensionGraph(store).getEdges({ dst: resolution.node.nodeId, rel: REL_PACKAGE_PART_OF_REPO });
  const nodes = await Promise.all(edges.map((edge) => dimensionGraph(store).getNode(edge.src)));
  return nodes
    .filter((node): node is NodeRecord => node !== null && isLiveDimensionNode(node) && node.tags.includes(BACKLOG_PACKAGE_TAG))
    .map(toPackageNode)
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Item ↔ dimension edges
// ---------------------------------------------------------------------------

async function requireLiveItemNode(store: GraphBacklogStore, itemNodeId: number): Promise<NodeRecord> {
  const node = await store.graph.getNode(itemNodeId);
  if (!node || node.tInvalid || !isLiveBacklogItemNode(node)) {
    throw new InvalidArgumentError(
      'itemNodeId',
      `backlog: node ${itemNodeId} is not a live backlog item — cannot link it to a dimension node.`
    );
  }
  return node;
}

/**
 * Links a backlog item to its repository with an `IN_REPO` edge, resolving
 * (and minting on first use) the repository node.
 *
 * The item's own `namespace` / `metadata.repo` strings are deliberately left
 * ALONE — see this file's COEXISTENCE section. This adds the edge; it does not
 * re-stamp the item.
 *
 * `writeEdge` is an upsert on `(src, dst, rel)`, so calling this twice for the
 * same pair is a no-op rather than a duplicate edge.
 */
export async function linkItemToRepository(store: GraphBacklogStore, itemNodeId: number, repoRaw: string): Promise<IRepositoryResolution> {
  await requireLiveItemNode(store, itemNodeId);
  const resolution = await resolveRepository(store, repoRaw);
  await dimensionGraph(store).writeEdge(itemNodeId, resolution.node.nodeId, REL_IN_REPO);
  return resolution;
}

/** Links a backlog item to its package with an `IN_PACKAGE` edge (and ensures the package → repository link exists). */
export async function linkItemToPackage(
  store: GraphBacklogStore,
  itemNodeId: number,
  input: IPackageInput
): Promise<{ node: IPackageNodeRecord; repository: IRepositoryNodeRecord; warnings: string[] }> {
  await requireLiveItemNode(store, itemNodeId);
  const resolved = await resolvePackage(store, input);
  await dimensionGraph(store).writeEdge(itemNodeId, resolved.node.nodeId, REL_IN_PACKAGE);
  return { node: resolved.node, repository: resolved.repository, warnings: resolved.warnings };
}

/** The repository an item is linked to by its `IN_REPO` edge, or `null` when it has not been linked (or backfilled) yet. */
export async function repositoryOfItem(store: GraphBacklogStore, itemNodeId: number): Promise<IRepositoryNodeRecord | null> {
  const edges = await dimensionGraph(store).getEdges({ src: itemNodeId, rel: REL_IN_REPO });
  for (const edge of edges) {
    const node = await dimensionGraph(store).getNode(edge.dst);
    if (node && isLiveDimensionNode(node) && node.tags.includes(BACKLOG_REPO_TAG)) return toRepositoryNode(node);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The read path — what makes `filter.repo` traverse the graph
// ---------------------------------------------------------------------------

/** Result of a repo-scoped item scan. `warnings` carries any ambiguity the resolution surfaced (AC-24). */
export interface IRepositoryItemScan {
  /** The repository the raw key resolved to, or `null` when the key is unknown to this store. */
  repository: IRepositoryNodeRecord | null;
  nodes: NodeRecord[];
  warnings: string[];
}

export interface IRepositoryScanOptions {
  /**
   * Include items matched by the LEGACY string fields (`namespace` /
   * `metadata.repo` equal to the canonical key or ANY alias), not just
   * items carrying an `IN_REPO` edge. Defaults to `true` and must stay `true`
   * in production until the EPIC-A backfill has been run and verified — see
   * this file's COEXISTENCE section. `false` exists so a post-backfill parity
   * check can assert the edge leg alone returns the same set.
   */
  includeLegacyAliasMatch?: boolean;
}

/**
 * The repo-scoped read path: every live backlog item node belonging to the
 * repository that `repoRaw` resolves to — INCLUDING items filed under any
 * other alias of that repository (INTERFACE_v2.md AC-7), and EXCLUDING any
 * other repository's items.
 *
 * This is what makes `filter.repo` traverse the graph instead of string-
 * matching `namespace`. Two legs, unioned by node id:
 *
 *  1. **Edge leg (v2).** `IN_REPO` edges into the canonical repository node.
 *  2. **Legacy alias leg (coexistence).** `namespace` or `metadata.repo`
 *     equal to the canonical key or any alias. Both fields are scanned because they are already
 *     known to diverge on real data (repo-migration.ts:11-19).
 *
 * Wiring this into `query.ts`'s `nodeFilterFromBacklogFilter` (which today
 * does `nodeFilter.namespace = filter.repo`, query.ts:49) is deliberately NOT
 * done here — `query.ts` is outside this change's file ownership. This
 * function is the primitive that wiring calls.
 *
 * @param repoRaw any spelling of the repo
 * @returns the resolved repository (or `null`), the matching live item nodes,
 *   and any ambiguity warnings the caller must surface in its envelope
 */
export async function findItemNodesInRepository(
  store: GraphBacklogStore,
  repoRaw: string,
  opts: IRepositoryScanOptions = {}
): Promise<IRepositoryItemScan> {
  const includeLegacy = opts.includeLegacyAliasMatch ?? true;
  const resolution = await lookupRepository(store, repoRaw);
  if (!resolution) {
    // An unknown repo key has no items — and must NOT fall back to a bare
    // string scan, which is exactly how a foreign repo's items would leak in.
    return { repository: null, nodes: [], warnings: [] };
  }

  const byId = new Map<number, NodeRecord>();

  const edges = await dimensionGraph(store).getEdges({ dst: resolution.node.nodeId, rel: REL_IN_REPO });
  if (edges.length > 0) {
    const linked = await store.graph.queryNodes({
      ids: edges.map((edge) => edge.src),
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      tagsMatchAll: true,
    });
    for (const node of linked) if (isLiveBacklogItemNode(node)) byId.set(node.id, node);
  }

  if (includeLegacy) {
    // `allSpellings`, not `aliases` — `aliases` excludes `canonicalKey`
    // (model.ts:1871), and the canonical key is precisely the spelling most
    // legacy items were filed under. Iterating `aliases` alone would drop
    // them.
    for (const alias of allSpellings(resolution.node)) {
      const [byNamespace, byMeta] = await Promise.all([
        store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], tagsMatchAll: true, namespace: alias }),
        store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_ITEM_TAG], tagsMatchAll: true, metadata: { repo: alias } }),
      ]);
      for (const node of [...byNamespace, ...byMeta]) if (isLiveBacklogItemNode(node)) byId.set(node.id, node);
    }
  }

  return {
    repository: resolution.node,
    nodes: [...byId.values()].sort((a, b) => a.id - b.id),
    warnings: resolution.warnings,
  };
}

/** {@link findItemNodesInRepository}, mapped to `BacklogItem`s. */
export async function queryItemsInRepository(
  store: GraphBacklogStore,
  repoRaw: string,
  opts: IRepositoryScanOptions = {}
): Promise<{ repository: IRepositoryNodeRecord | null; items: BacklogItem[]; warnings: string[] }> {
  const scan = await findItemNodesInRepository(store, repoRaw, opts);
  return { repository: scan.repository, items: scan.nodes.map(toBacklogItem), warnings: scan.warnings };
}
