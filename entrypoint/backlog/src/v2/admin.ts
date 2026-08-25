/**
 * v2/admin.ts - INTERFACE_v2 6 `backlog_admin`: the bulk / maintenance /
 * system verb of the six-tool surface, plus the 5a.3 `files`/`overlap`
 * computation the query layer mounts as `view:"overlap"`.
 *
 * This is a COMPOSITION layer and nothing else. Every action delegates to the
 * store operation that already implements it (`store/lifecycle.ts`'s
 * `archiveTerminalItems` via `client.ts`, `store/repo-migration.ts`'s
 * `migrateRepo`, `store/crud.ts`'s `softDeleteItemNode`, `markdown.ts`'s
 * render/import path). The only genuinely NEW behaviour here is `doctor`
 * (FEAT-008) and `prune` (FEAT-009), which have no v1 implementation to
 * delegate to.
 *
 * Three contracts are load-bearing across everything below (INTERFACE_v2 7):
 *
 * 1. **Envelope or nothing.** Every exported operation returns
 *    `IOutcomeEnvelope<T>`. No bare values, no `null` that means both "empty"
 *    and "missing" (7.1, DEBT-BACKLOG-API-RETURN-VALUES-001).
 * 2. **Never accept-and-ignore an input key.** Each action declares its
 *    parameter vocabulary; an unrecognised key is a `validation` error NAMING
 *    the key, and a key this build cannot honour is `unsupported` naming it.
 *    A silently-dropped parameter is the exact failure mode
 *    BUG-BACKLOG-BATCH-CLI-001 is about (every natural `batch` invocation
 *    failed with exit 2/4 because the surface was undocumented).
 * 3. **Destructive actions are dry-run by default.** `prune`, `archive`,
 *    `merge`, `import` and `reconcile_repo` compute and report their full
 *    candidate set with ZERO writes unless the caller passes `confirm: true`.
 *    `by` is only demanded on the call that actually writes - a dry run is a
 *    read, and 7.5's attribution rule is about mutations.
 *
 * **Host-command carve-out (6, verified against cli.ts:243-265).**
 * `install`, `install-skill` and `serve` are NOT folded in: the first two are
 * pure filesystem/config operations that must never open the store, and
 * `serve` is a long-lived listener with a different lifecycle. `'skill'` is
 * nevertheless a member of `BACKLOG_ADMIN_ACTIONS` (model.ts:2517) - the two
 * halves of 6 disagree, and the carve-out is the half that wins here: the
 * action is *discoverable* (it is in the union, and asking for it produces a
 * message naming the real host command) but this data tool will never perform
 * the install. See the `case 'skill'` arm.
 */
import { existsSync } from 'node:fs';
import type {
  BacklogFilter,
  BacklogItem,
  IOutcomeEnvelope,
  IOutcomeError,
  IOverlapAxis,
  IOverlapPair,
  IOverlapView,
  IBacklogAdminAction,
  IBacklogAdminInput,
  ImportResult,
  MigrationPhase,
  MigrationStatusResult,
  RepoMigrationResult,
  SetMigrationPhaseResult,
} from '../model.js';
import {
  AmbiguousHumanIdError,
  BACKLOG_ADMIN_ACTIONS,
  BacklogItemNotFoundError,
  BacklogValidationError,
  InvalidArgumentError,
  RagNotConfiguredError,
  UnsupportedOperationError,
  assertAttribution,
  canonicalIdentityKey,
  errorEnvelope,
  isTerminalStatus,
  okEnvelope,
  toOutcomeError,
} from '../model.js';
import type { BacklogCtx, BacklogVersionInfo } from '../client.js';
import {
  archiveResolved as archiveResolvedOp,
  exportJson as exportJsonOp,
  importFromMarkdown as importFromMarkdownOp,
  mergeItems as mergeItemsOp,
  migrateRepo as migrateRepoOp,
  migrationStatus as migrationStatusOp,
  renderToMarkdown as renderToMarkdownOp,
  setMigrationPhase as setMigrationPhaseOp,
  version as versionOp,
} from '../ops-v1.js';
import { findHumanIdInAnyRepo, findItemNode, queryItemNodes, topoOrder } from '../store/query.js';
import { getItemNode, softDeleteItemNode } from '../store/crud.js';
import { toBacklogItem, type BacklogNodeMeta } from '../store/mapping.js';
import { listRepositoryNodes, lookupRepository } from '../store/repo-nodes.js';

// ============================================================================
// Shared plumbing - envelope wrapping + parameter validation.
// ============================================================================

/**
 * Runs `body` and wraps whatever it produces (or throws) in the 7.1 outcome
 * envelope. `toOutcomeError` (model.ts:906) is the ONE place the closed error
 * union is derived from a thrown value, so every action inherits the same
 * `item_not_found` / `internal` distinction AC-6 demands rather than each
 * re-deriving it.
 */
async function envelope<T>(body: () => Promise<{ data: T; warnings?: string[] }>): Promise<IOutcomeEnvelope<T>> {
  try {
    const { data, warnings } = await body();
    return okEnvelope(data, warnings && warnings.length > 0 ? { warnings } : undefined);
  } catch (err) {
    const mapped: IOutcomeError = toOutcomeError(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.details);
  }
}

/** Params always arrive as an untyped bag (`IBacklogAdminInput.params`), so every read is a validated read. */
type ParamBag = Record<string, unknown>;

/**
 * 7 cross-cutting rule 2 - an unknown parameter key is a `validation` error
 * naming the key, never a silent no-op. Without this an agent that typos
 * `--older-than` gets a successful-looking prune that used the DEFAULT
 * window, which is worse than a failure.
 */
function assertKnownParams(action: IBacklogAdminAction, params: ParamBag, allowed: readonly string[]): void {
  const allowedSet = new Set<string>(allowed);
  const unknown = Object.keys(params).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new BacklogValidationError(
      `backlog_admin(${action}): unknown param key(s) ${unknown.map((k) => `"${k}"`).join(', ')} - accepted: ${
        allowed.length > 0 ? allowed.map((k) => `"${k}"`).join(', ') : '(none)'
      }`,
      unknown
    );
  }
}

function readString(params: ParamBag, key: string): string | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArgumentError(key, `backlog_admin: "${key}" must be a non-empty string, received ${JSON.stringify(raw)}`);
  }
  return raw.trim();
}

function requireString(params: ParamBag, key: string): string {
  const value = readString(params, key);
  if (value === undefined) {
    throw new InvalidArgumentError(key, `backlog_admin: "${key}" is required`);
  }
  return value;
}

function readBoolean(params: ParamBag, key: string): boolean | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new InvalidArgumentError(key, `backlog_admin: "${key}" must be a boolean, received ${JSON.stringify(raw)}`);
  }
  return raw;
}

function readInteger(params: ParamBag, key: string, min: number, max: number): number | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new InvalidArgumentError(
      key,
      `backlog_admin: "${key}" must be an integer in [${min}, ${max}], received ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

function readStringArray(params: ParamBag, key: string): string[] | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new InvalidArgumentError(key, `backlog_admin: "${key}" must be an array of non-empty strings`);
  }
  return (raw as string[]).map((entry) => entry.trim());
}

function readEnum<T extends string>(params: ParamBag, key: string, allowed: readonly T[]): T | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new InvalidArgumentError(
      key,
      `backlog_admin: "${key}" must be one of ${allowed.map((v) => `"${v}"`).join(' | ')}, received ${JSON.stringify(raw)}`
    );
  }
  return raw as T;
}

/**
 * The v1 `BacklogFilter` keys `exportJson`/`renderToMarkdown` actually honour
 * (model.ts:319-374). The v2 `IBacklogFilter` is a strict superset; forwarding
 * a v2-only key (`semantic`, `dateRange`, `files`) into the v1 read path
 * would silently drop it - exactly the accept-and-ignore failure 7 forbids -
 * so those are rejected as `unsupported` NAMING the key rather than obeyed
 * halfway.
 */
const V1_FILTER_KEYS: readonly (keyof BacklogFilter)[] = [
  'repo',
  'projectPath',
  'status',
  'kind',
  'family',
  'priority',
  'plan',
  'assignee',
  'claimedBy',
  'tags',
  'grep',
  'importedFrom',
  'rootLevel',
  'excludeArchived',
  'limit',
  'offset',
];

/** v2 filter keys that exist in the contract but have no v1 read-path implementation behind `export`/`render`. */
const V2_ONLY_FILTER_KEYS: readonly string[] = [
  'author',
  'reporter',
  'project',
  'packagePath',
  'dateRange',
  'dupeHitsMin',
  'files',
  'hasAcceptanceCriteria',
  'missingAcceptanceCriteria',
  'missingCitation',
  'semantic',
  'anchor',
];

function readFilter(params: ParamBag, key = 'filter'): BacklogFilter | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidArgumentError(key, `backlog_admin: "${key}" must be an object`);
  }
  const bag = raw as ParamBag;
  const supported = new Set<string>(V1_FILTER_KEYS as readonly string[]);
  const v2Only = Object.keys(bag).filter((k) => V2_ONLY_FILTER_KEYS.includes(k));
  if (v2Only.length > 0) {
    throw new UnsupportedOperationError(
      `${key}.${v2Only[0]}`,
      `backlog_admin: filter key(s) ${v2Only
        .map((k) => `"${k}"`)
        .join(', ')} belong to the v2 query layer and are not honoured by the bulk export/render path - use backlog_query for them (INTERFACE_v2 2.1)`
    );
  }
  const unknown = Object.keys(bag).filter((k) => !supported.has(k));
  if (unknown.length > 0) {
    throw new BacklogValidationError(`backlog_admin: unknown filter key(s) ${unknown.map((k) => `"${k}"`).join(', ')}`, unknown);
  }
  return bag as BacklogFilter;
}

/** `MigrationPhase`'s runtime twin - model.ts declares the union but exports no array for it (model.ts:517). */
const MIGRATION_PHASES = [
  'not-started',
  'phase-1',
  'phase-2',
  'phase-3',
  'phase-4',
  'phase-5',
  'complete',
] as const satisfies readonly MigrationPhase[];

/**
 * 6 - the actions that only land with the embedding layer (EPIC-G). Asking
 * for one against a build with no configured matcher is `rag_not_configured`
 * (AC-12's contract), never a fabricated empty result.
 */
const EPIC_G_ACTIONS: readonly IBacklogAdminAction[] = [
  'run_dedup_sweep',
  'cluster_into_plans',
  'promote_cluster_to_plan',
  'embedding_backfill',
  'embedding_health',
  'list_near_duplicates',
];

// ============================================================================
// FEAT-008 - `doctor`: the integrity report.
// ============================================================================

/** FEAT-008 - the integrity checks `doctor` knows how to run. */
export const DOCTOR_CHECKS = [
  'duplicate_human_ids',
  'dangling_edges',
  'missing_citations',
  'terminal_without_citations',
  'orphaned_repo_keys',
  'dependency_cycles',
] as const;

/** FEAT-008 - see {@link DOCTOR_CHECKS}. */
export type IDoctorCheckName = (typeof DOCTOR_CHECKS)[number];

/** FEAT-008 - a terse reference to one offending item. Doctor never returns bodies (7.3 projection discipline). */
export interface IDoctorItemRef {
  humanId: string;
  repo: string;
  nodeId: number;
  title: string;
  status: string;
}

/**
 * FEAT-008 - two or more LIVE nodes answering to the same `(repo, humanId)`.
 *
 * `repo` is the EFFECTIVE repo (`metadata.repo ?? namespace`, matching
 * `toBacklogItem`), which is what a caller addresses an item by. That makes
 * this check catch the class the DB-level unique index cannot: the index is
 * keyed on `namespace` (store/ids.ts:117-122), so a node whose `metadata.repo`
 * drifted away from its `namespace` - a half-applied repo migration - passes
 * the index while being both a duplicate AND unreachable through
 * `findItemNode` (which queries by namespace, store/query.ts:216-226).
 */
export interface IDoctorDuplicateGroup {
  repo: string;
  humanId: string;
  count: number;
  nodes: Array<IDoctorItemRef & { namespace: string }>;
}

/** FEAT-008 - an edge pointing at a node that is gone or invalidated. */
export interface IDoctorDanglingEdge {
  edgeRowid: number;
  src: number;
  dst: number;
  rel: string;
  /** Which endpoint is bad, and why. Both endpoints can be listed. */
  broken: Array<{ endpoint: 'src' | 'dst'; nodeId: number; reason: 'missing-node' | 'invalidated-node' }>;
}

/** FEAT-008 - a repo key items are filed under that no repository node claims (EPIC-A reconciliation candidate). */
export interface IDoctorOrphanedRepoKey {
  repo: string;
  itemCount: number;
}

/** FEAT-008 - per-check summary. `count` is EXACT; `sampled` is how many made it into the report's arrays. */
export interface IDoctorCheckSummary {
  name: IDoctorCheckName;
  count: number;
  ok: boolean;
  sampled: number;
  truncated: boolean;
}

/**
 * FEAT-008 - the `doctor` report.
 *
 * Counts are always exact. The per-check arrays are SAMPLES capped at
 * `limitPerCheck` (7.3: a maintenance read must not become the context-blow
 * it is meant to detect) - `checks[].truncated` says so explicitly, so a
 * short array is never mistaken for a small problem.
 */
export interface IDoctorReport {
  /** Present only when the scan was scoped to one repo. */
  repo?: string;
  scannedItems: number;
  /** True iff every check that RAN found nothing. Read together with `complete`. */
  ok: boolean;
  /** False when `checks` was narrowed - `ok` is then a partial claim, and says so. */
  complete: boolean;
  checks: IDoctorCheckSummary[];
  skipped: IDoctorCheckName[];
  duplicateHumanIds: IDoctorDuplicateGroup[];
  danglingEdges: IDoctorDanglingEdge[];
  missingCitations: IDoctorItemRef[];
  /** The headline number: share of scanned items carrying zero citations, 0-100, one decimal. */
  missingCitationsPercent: number;
  terminalWithoutCitations: IDoctorItemRef[];
  orphanedRepoKeys: IDoctorOrphanedRepoKey[];
  /** At most one representative cycle - `topoOrder` extracts one, not all (store/query.ts:611). */
  dependencyCycles: string[][];
}

const DOCTOR_PARAM_KEYS = ['repo', 'checks', 'limitPerCheck'] as const;
const DEFAULT_DOCTOR_LIMIT_PER_CHECK = 100;

/**
 * `SUPERSEDES` and `SAME_AS` are the two rels whose whole purpose is to point
 * at a tombstone: `supersedeItemNode` invalidates the old node right after
 * writing `SUPERSEDES` (store/structure.ts:144-232) and `mergeItemsNode`
 * invalidates the dropped node right after writing `SAME_AS`
 * (store/structure.ts:250-280). Counting those as "dangling" would make
 * `doctor` fire on every correctly-executed merge - a false positive that
 * teaches operators to ignore the report. They are excluded by rel, and
 * `admin.spec.ts` pins that with a real merge.
 */
const TOMBSTONE_REFERENCING_RELS: ReadonlySet<string> = new Set(['SUPERSEDES', 'SAME_AS']);

interface RawDanglingEdgeRow {
  edge_rowid: number;
  src: number;
  dst: number;
  rel: string;
  src_id: number | null;
  dst_id: number | null;
  src_invalid: string | null;
  dst_invalid: string | null;
  src_ns: string | null;
  dst_ns: string | null;
}

/**
 * `@adhd/sox-graph-store` exposes no bulk edge read (`getEdges` is per-node,
 * index.d.ts:219-223) and no edge delete at all - DESIGN.md 14 sanctions raw
 * SQL on the store-owned handle for exactly this gap, the same escape hatch
 * `removeDependencyNode` already uses (store/structure.ts:50-55).
 */
async function scanDanglingEdges(store: BacklogCtx['store'], repo: string | undefined): Promise<IDoctorDanglingEdge[]> {
  const { rows } = await store.adapter.executeAll<RawDanglingEdgeRow>(
    `SELECT e.rowid AS edge_rowid, e.src AS src, e.dst AS dst, e.rel AS rel,
            s.rowid AS src_id, s.t_invalid AS src_invalid, s.namespace AS src_ns,
            d.rowid AS dst_id, d.t_invalid AS dst_invalid, d.namespace AS dst_ns
       FROM edge e
       LEFT JOIN node s ON s.rowid = e.src
       LEFT JOIN node d ON d.rowid = e.dst
      WHERE e.t_invalid IS NULL
        AND (s.rowid IS NULL OR d.rowid IS NULL OR s.t_invalid IS NOT NULL OR d.t_invalid IS NOT NULL)`
  );
  const out: IDoctorDanglingEdge[] = [];
  for (const row of rows) {
    if (TOMBSTONE_REFERENCING_RELS.has(row.rel)) continue;
    if (repo !== undefined && row.src_ns !== repo && row.dst_ns !== repo) continue;
    const broken: IDoctorDanglingEdge['broken'] = [];
    if (row.src_id === null) broken.push({ endpoint: 'src', nodeId: row.src, reason: 'missing-node' });
    else if (row.src_invalid !== null) broken.push({ endpoint: 'src', nodeId: row.src, reason: 'invalidated-node' });
    if (row.dst_id === null) broken.push({ endpoint: 'dst', nodeId: row.dst, reason: 'missing-node' });
    else if (row.dst_invalid !== null) broken.push({ endpoint: 'dst', nodeId: row.dst, reason: 'invalidated-node' });
    if (broken.length === 0) continue;
    out.push({ edgeRowid: row.edge_rowid, src: row.src, dst: row.dst, rel: row.rel, broken });
  }
  return out.sort((a, b) => a.edgeRowid - b.edgeRowid);
}

function itemRef(item: BacklogItem): IDoctorItemRef {
  return { humanId: item.humanId, repo: item.repo, nodeId: item.nodeId, title: item.title, status: item.status };
}

async function runDoctor(ctx: BacklogCtx, params: ParamBag): Promise<{ data: IDoctorReport; warnings?: string[] }> {
  assertKnownParams('doctor', params, DOCTOR_PARAM_KEYS);
  const repo = readString(params, 'repo');
  const limitPerCheck = readInteger(params, 'limitPerCheck', 1, 1000) ?? DEFAULT_DOCTOR_LIMIT_PER_CHECK;
  const requested = readStringArray(params, 'checks');
  if (requested) {
    const bad = requested.filter((name) => !(DOCTOR_CHECKS as readonly string[]).includes(name));
    if (bad.length > 0) {
      throw new BacklogValidationError(
        `backlog_admin(doctor): unknown check(s) ${bad.map((c) => `"${c}"`).join(', ')} - known: ${DOCTOR_CHECKS.join(', ')}`,
        bad
      );
    }
    if (requested.length === 0) {
      throw new BacklogValidationError('backlog_admin(doctor): "checks" was an empty list - omit it to run every check', ['checks']);
    }
  }
  const selected = new Set<IDoctorCheckName>((requested as IDoctorCheckName[] | undefined) ?? DOCTOR_CHECKS);
  // A check that could not COMPLETE is demoted out of `selected` into
  // `skipped` rather than reported as clean. Doctor is the tool you reach for
  // when the store is already sick, so one broken check must never take the
  // whole report down NOR quietly turn into a zero.
  const ran = new Set<IDoctorCheckName>(selected);
  const warnings: string[] = [];

  const nodes = await queryItemNodes(ctx.store, repo !== undefined ? { repo } : {});
  const items = nodes.map((node) => ({ node, item: toBacklogItem(node) }));
  const scannedItems = items.length;

  // --- duplicate humanIds -------------------------------------------------
  const duplicateHumanIds: IDoctorDuplicateGroup[] = [];
  if (selected.has('duplicate_human_ids')) {
    const byKey = new Map<string, Array<(typeof items)[number]>>();
    for (const entry of items) {
      // `JSON.stringify` of the pair, not a delimiter-joined string: a repo key
      // is user-supplied and may contain any character, so a hand-picked
      // separator could make two DIFFERENT (repo, humanId) pairs collide into
      // one false 'duplicate'.
      const key = JSON.stringify([entry.item.repo, entry.item.humanId]);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(entry);
      else byKey.set(key, [entry]);
    }
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue;
      const first = bucket[0].item;
      duplicateHumanIds.push({
        repo: first.repo,
        humanId: first.humanId,
        count: bucket.length,
        nodes: bucket.map((entry) => ({ ...itemRef(entry.item), namespace: entry.node.namespace ?? '' })),
      });
    }
    duplicateHumanIds.sort((a, b) => (a.repo === b.repo ? a.humanId.localeCompare(b.humanId) : a.repo.localeCompare(b.repo)));
  }

  // --- citation coverage --------------------------------------------------
  const missingCitations: IDoctorItemRef[] = [];
  if (selected.has('missing_citations')) {
    for (const { item } of items) if (item.citations.length === 0) missingCitations.push(itemRef(item));
  }
  const terminalWithoutCitations: IDoctorItemRef[] = [];
  if (selected.has('terminal_without_citations')) {
    // 5a.2's read-side mirror: v1 ALREADY refuses a terminal-done transition
    // without a citation (model.ts:75, store/lifecycle.ts:65), so anything
    // found here predates that gate or was written around it - a strictly
    // stronger finding than a plain missing citation.
    for (const { item } of items) {
      if (isTerminalStatus(item.status) && item.citations.length === 0) terminalWithoutCitations.push(itemRef(item));
    }
  }

  // --- dangling edges -----------------------------------------------------
  const danglingEdges = selected.has('dangling_edges') ? await scanDanglingEdges(ctx.store, repo) : [];

  // --- orphaned repo keys -------------------------------------------------
  const orphanedRepoKeys: IDoctorOrphanedRepoKey[] = [];
  if (selected.has('orphaned_repo_keys')) {
    const counts = new Map<string, number>();
    for (const { item } of items) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
    const repoNodes = await listRepositoryNodes(ctx.store);
    if (repoNodes.length === 0) {
      // Honest inertness beats a false alarm: with no repository nodes at all
      // (EPIC-A's backfill has not run on this store) EVERY key would be
      // reported, which is noise, not a finding.
      warnings.push(
        'doctor: no repository nodes exist in this store (EPIC-A backfill has not run) - the orphaned_repo_keys check is inert, not clean'
      );
    } else {
      for (const [key, itemCount] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        try {
          const resolved = await lookupRepository(ctx.store, key);
          if (!resolved) orphanedRepoKeys.push({ repo: key, itemCount });
        } catch (err) {
          // `parseRepoKey` refuses a key that normalizes away to nothing
          // (repo-nodes.ts:257-280). That IS a finding, but it is not an
          // "orphan" - report it as a warning rather than mislabelling it.
          warnings.push(
            `doctor: repo key ${JSON.stringify(key)} (${itemCount} item(s)) could not be normalized: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }

  // --- dependency cycles --------------------------------------------------
  const dependencyCycles: string[][] = [];
  if (selected.has('dependency_cycles')) {
    try {
      const order = await topoOrder(ctx.store, repo !== undefined ? { repo } : {});
      if (!order.ok) dependencyCycles.push(order.cycle);
    } catch (err) {
      // `topoOrder` resolves every item through `findItemNode`, which REFUSES
      // an ambiguous `(repo, humanId)` (store/query.ts:216-226) - i.e. exactly
      // the corruption `duplicate_human_ids` above just reported. Demote the
      // cycle check instead of letting it sink the whole report.
      ran.delete('dependency_cycles');
      warnings.push(
        `doctor: the dependency_cycles check could not run (${
          err instanceof Error ? err.message : String(err)
        }) - it is reported as skipped, not clean`
      );
    }
  }

  const cappedDuplicates = duplicateHumanIds.slice(0, limitPerCheck);
  const cappedDangling = danglingEdges.slice(0, limitPerCheck);
  const cappedMissing = missingCitations.slice(0, limitPerCheck);
  const cappedTerminal = terminalWithoutCitations.slice(0, limitPerCheck);
  const cappedOrphans = orphanedRepoKeys.slice(0, limitPerCheck);
  const cappedCycles = dependencyCycles.slice(0, limitPerCheck);

  const findings: Record<IDoctorCheckName, { count: number; sampled: number }> = {
    duplicate_human_ids: { count: duplicateHumanIds.length, sampled: cappedDuplicates.length },
    dangling_edges: { count: danglingEdges.length, sampled: cappedDangling.length },
    missing_citations: { count: missingCitations.length, sampled: cappedMissing.length },
    terminal_without_citations: { count: terminalWithoutCitations.length, sampled: cappedTerminal.length },
    orphaned_repo_keys: { count: orphanedRepoKeys.length, sampled: cappedOrphans.length },
    dependency_cycles: { count: dependencyCycles.length, sampled: cappedCycles.length },
  };

  const checks: IDoctorCheckSummary[] = [];
  const skipped: IDoctorCheckName[] = [];
  for (const name of DOCTOR_CHECKS) {
    if (!ran.has(name)) {
      skipped.push(name);
      continue;
    }
    const finding = findings[name];
    checks.push({
      name,
      count: finding.count,
      ok: finding.count === 0,
      sampled: finding.sampled,
      truncated: finding.sampled < finding.count,
    });
  }

  const report: IDoctorReport = {
    ...(repo !== undefined ? { repo } : {}),
    scannedItems,
    ok: checks.every((check) => check.ok),
    complete: skipped.length === 0,
    checks,
    skipped,
    duplicateHumanIds: cappedDuplicates,
    danglingEdges: cappedDangling,
    missingCitations: cappedMissing,
    missingCitationsPercent:
      scannedItems === 0 ? 0 : Math.round((findings.missing_citations.count / scannedItems) * 1000) / 10,
    terminalWithoutCitations: cappedTerminal,
    orphanedRepoKeys: cappedOrphans,
    dependencyCycles: cappedCycles,
  };
  return { data: report, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * FEAT-008 / INTERFACE_v2 6 - run the integrity report.
 *
 * Read-only: `doctor` never writes, so it needs no `by` and no `confirm`.
 * Counts are exact; the arrays are capped samples (`limitPerCheck`, default
 * 100) with `checks[].truncated` telling the caller when a list was cut.
 *
 * @param params `{ repo?, checks?: IDoctorCheckName[], limitPerCheck?: number }`
 */
export async function adminDoctor(ctx: BacklogCtx, params: ParamBag = {}): Promise<IOutcomeEnvelope<IDoctorReport>> {
  return envelope(() => runDoctor(ctx, params));
}

// ============================================================================
// FEAT-009 - `prune`: bounded, dry-run-by-default maintenance deletion.
// ============================================================================

/** FEAT-009 - what a `prune` run targets. */
export const PRUNE_TARGETS = ['archived', 'dangling_edges'] as const;

/** FEAT-009 - see {@link PRUNE_TARGETS}. */
export type IPruneTarget = (typeof PRUNE_TARGETS)[number];

/** FEAT-009 - one thing prune would remove (dry run) or did remove. */
export interface IPruneCandidate {
  kind: 'item' | 'edge';
  /** Why this candidate qualified - always populated, so a dry run explains itself. */
  reason: string;
  humanId?: string;
  repo?: string;
  nodeId?: number;
  archivedAt?: string;
  edge?: { edgeRowid: number; src: number; dst: number; rel: string };
}

/** FEAT-009 - the `prune` outcome. `dryRun: true` guarantees `pruned === 0`. */
export interface IPruneReport {
  target: IPruneTarget;
  dryRun: boolean;
  /** ISO cutoff for `target: "archived"`; absent for edge pruning. */
  cutoff?: string;
  candidateCount: number;
  candidates: IPruneCandidate[];
  pruned: number;
  /** Per-candidate failures. One failure never aborts the rest of the sweep. */
  failures: Array<{ candidate: IPruneCandidate; message: string }>;
}

const PRUNE_PARAM_KEYS = ['target', 'repo', 'olderThanDays', 'confirm', 'limit', 'reason'] as const;
const DEFAULT_PRUNE_OLDER_THAN_DAYS = 90;
const DEFAULT_PRUNE_LIMIT = 500;

async function runPrune(
  ctx: BacklogCtx,
  params: ParamBag,
  by: string | undefined
): Promise<{ data: IPruneReport; warnings?: string[] }> {
  assertKnownParams('prune', params, PRUNE_PARAM_KEYS);
  const target = readEnum(params, 'target', PRUNE_TARGETS) ?? 'archived';
  const repo = readString(params, 'repo');
  const olderThanDays = readInteger(params, 'olderThanDays', 0, 36_500) ?? DEFAULT_PRUNE_OLDER_THAN_DAYS;
  const limit = readInteger(params, 'limit', 1, 5000) ?? DEFAULT_PRUNE_LIMIT;
  const confirm = readBoolean(params, 'confirm') ?? false;
  const reason = readString(params, 'reason');
  const warnings: string[] = [];

  // The destructive-action contract: nothing is written without an explicit
  // `confirm: true`, and the write - only the write - demands attribution
  // (7.5). A dry run is a READ, so it deliberately does not require `by`.
  const actor = confirm ? assertAttribution(by) : undefined;
  if (!confirm) {
    warnings.push('prune: dry run - nothing was written. Re-run with `confirm: true` (and `by`) to apply.');
  }

  const candidates: IPruneCandidate[] = [];
  let cutoffIso: string | undefined;

  if (target === 'archived') {
    const cutoffMs = Date.now() - olderThanDays * 86_400_000;
    cutoffIso = new Date(cutoffMs).toISOString();
    const nodes = await queryItemNodes(ctx.store, repo !== undefined ? { repo } : {});
    for (const node of nodes) {
      const meta = (node.metadata ?? {}) as Partial<BacklogNodeMeta>;
      const archivedAt = meta.archivedAt;
      if (!archivedAt) continue;
      const archivedMs = Date.parse(archivedAt);
      if (!Number.isFinite(archivedMs) || archivedMs > cutoffMs) continue;
      const item = toBacklogItem(node);
      // Defence in depth: `archiveTerminalItems` only ever stamps terminal
      // items (store/lifecycle.ts:152-165), but prune must never retire a
      // reopened item that merely still carries a stale `archivedAt`.
      if (!isTerminalStatus(item.status)) continue;
      candidates.push({
        kind: 'item',
        reason: `archived at ${archivedAt}, older than ${olderThanDays}d`,
        humanId: item.humanId,
        repo: item.repo,
        nodeId: item.nodeId,
        archivedAt,
      });
    }
    candidates.sort((a, b) => (a.nodeId ?? 0) - (b.nodeId ?? 0));
  } else {
    const dangling = await scanDanglingEdges(ctx.store, repo);
    for (const edge of dangling) {
      candidates.push({
        kind: 'edge',
        reason: `${edge.rel} edge with ${edge.broken.map((b) => `${b.endpoint} ${b.reason}`).join(' + ')}`,
        edge: { edgeRowid: edge.edgeRowid, src: edge.src, dst: edge.dst, rel: edge.rel },
      });
    }
  }

  const total = candidates.length;
  const bounded = candidates.slice(0, limit);
  if (bounded.length < total) {
    warnings.push(`prune: ${total} candidates matched but the sweep is bounded at limit=${limit} - re-run to continue.`);
  }

  const report: IPruneReport = {
    target,
    dryRun: !confirm,
    ...(cutoffIso !== undefined ? { cutoff: cutoffIso } : {}),
    candidateCount: bounded.length,
    candidates: bounded,
    pruned: 0,
    failures: [],
  };
  if (!confirm) return { data: report, warnings };

  for (const candidate of bounded) {
    try {
      if (candidate.kind === 'item') {
        // Through the real seam (`softDeleteItemNode`) rather than a raw
        // `invalidate`, so prune inherits its reason validation and its
        // (repo, humanId) resolution - including the ambiguity refusal.
        await softDeleteItemNode(
          ctx.store,
          candidate.repo as string,
          candidate.humanId as string,
          reason ?? `pruned by ${actor}: ${candidate.reason}`
        );
      } else {
        // No edge-delete primitive exists upstream - the DESIGN.md 14
        // sanctioned raw DELETE, identical in shape to
        // `removeDependencyNode`'s (store/structure.ts:50-55).
        await ctx.store.adapter.executeRun(`DELETE FROM edge WHERE rowid = ?`, [candidate.edge?.edgeRowid]);
      }
      report.pruned += 1;
    } catch (err) {
      // A per-candidate failure never aborts the sweep and never goes
      // unreported (the same contract `migrateRepo` states for its own
      // per-item results, client.ts:288-290).
      report.failures.push({ candidate, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { data: report, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * FEAT-009 / INTERFACE_v2 6 - bounded maintenance deletion.
 *
 * DRY RUN BY DEFAULT. Without `confirm: true` this writes nothing and returns
 * the full candidate list with a warning. With `confirm: true` it also
 * requires `by` (7.5) and reports `pruned` plus per-candidate `failures`.
 *
 * `target: "archived"` (default) soft-deletes terminal items archived longer
 * ago than `olderThanDays` (default 90) - bi-temporal invalidation, never a
 * hard delete, so the audit trail survives. `target: "dangling_edges"` removes
 * edge rows whose endpoint node is missing or invalidated.
 *
 * @param params `{ target?, repo?, olderThanDays?, limit?, confirm?, reason? }`
 * @param by required when `confirm: true`
 */
export async function adminPrune(ctx: BacklogCtx, params: ParamBag = {}, by?: string): Promise<IOutcomeEnvelope<IPruneReport>> {
  return envelope(() => runPrune(ctx, params, by));
}

// ============================================================================
// `archive` - archive-resolved, dry-run by default.
// ============================================================================

/** INTERFACE_v2 6 `archive` - the outcome of an archive sweep. `dryRun: true` guarantees `archivedCount === 0`. */
export interface IArchiveReport {
  dryRun: boolean;
  candidateCount: number;
  candidates: Array<{ humanId: string; repo: string; status: string }>;
  archivedCount: number;
  /** CHANGELOG.md-formatted markdown for the archived set; empty on a dry run (nothing was archived). */
  changelogMarkdown: string;
}

const ARCHIVE_PARAM_KEYS = ['repo', 'projectPath', 'exclude', 'confirm'] as const;

async function runArchive(
  ctx: BacklogCtx,
  params: ParamBag,
  by: string | undefined
): Promise<{ data: IArchiveReport; warnings?: string[] }> {
  assertKnownParams('archive', params, ARCHIVE_PARAM_KEYS);
  const repo = readString(params, 'repo');
  const projectPath = readString(params, 'projectPath');
  const exclude = readStringArray(params, 'exclude') ?? [];
  const confirm = readBoolean(params, 'confirm') ?? false;
  const scope = { ...(repo !== undefined ? { repo } : {}), ...(projectPath !== undefined ? { projectPath } : {}) };
  const warnings: string[] = [];
  if (confirm) assertAttribution(by);
  else warnings.push('archive: dry run - nothing was written. Re-run with `confirm: true` (and `by`) to apply.');

  // The candidate set is computed the same way `archiveTerminalItems` selects
  // (terminal, not excluded) plus "not already archived", so a dry run and the
  // confirmed run agree. `archivedAt` is not on `BacklogItem`, so it is read
  // off the node metadata here (store/mapping.ts:224 declares it).
  const excluded = new Set(exclude.map((id) => id.toUpperCase()));
  const nodes = await queryItemNodes(ctx.store, scope);
  const candidates = nodes
    .filter((node) => !(node.metadata as Partial<BacklogNodeMeta> | undefined)?.archivedAt)
    .map(toBacklogItem)
    .filter((item) => isTerminalStatus(item.status) && !excluded.has(item.humanId.toUpperCase()))
    .map((item) => ({ humanId: item.humanId, repo: item.repo, status: item.status as string }));

  if (!confirm) {
    return {
      data: { dryRun: true, candidateCount: candidates.length, candidates, archivedCount: 0, changelogMarkdown: '' },
      warnings,
    };
  }
  const result = await archiveResolvedOp(ctx, scope, { exclude });
  return {
    data: {
      dryRun: false,
      candidateCount: candidates.length,
      candidates,
      archivedCount: result.archivedCount,
      changelogMarkdown: result.changelogMarkdown,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * INTERFACE_v2 6 `archive` - mark terminal items archived and render the
 * CHANGELOG section. Dry-run by default; `confirm: true` requires `by`.
 *
 * @param params `{ repo?, projectPath?, exclude?: string[], confirm? }`
 */
export async function adminArchive(ctx: BacklogCtx, params: ParamBag = {}, by?: string): Promise<IOutcomeEnvelope<IArchiveReport>> {
  return envelope(() => runArchive(ctx, params, by));
}

// ============================================================================
// `merge` - dry-run-by-default item merge.
// ============================================================================

/** INTERFACE_v2 6 `merge` - the outcome of a merge. `dryRun: true` guarantees nothing was written. */
export interface IMergeReport {
  dryRun: boolean;
  repo: string;
  keep: string;
  drop: string;
  reason: string;
  merged: boolean;
  /** The surviving item, present only when the merge actually ran. */
  item?: BacklogItem;
}

const MERGE_PARAM_KEYS = ['repo', 'keep', 'drop', 'reason', 'confirm'] as const;

async function runMerge(
  ctx: BacklogCtx,
  params: ParamBag,
  by: string | undefined
): Promise<{ data: IMergeReport; warnings?: string[] }> {
  assertKnownParams('merge', params, MERGE_PARAM_KEYS);
  const repo = requireString(params, 'repo');
  const keep = requireString(params, 'keep');
  const drop = requireString(params, 'drop');
  const reason = requireString(params, 'reason');
  const confirm = readBoolean(params, 'confirm') ?? false;
  if (keep === drop) {
    throw new InvalidArgumentError('drop', `backlog_admin(merge): "keep" and "drop" are the same item (${keep})`);
  }
  const warnings: string[] = [];
  if (confirm) assertAttribution(by);
  else warnings.push('merge: dry run - nothing was written. Re-run with `confirm: true` (and `by`) to apply.');

  // A dry run that does not verify both endpoints is a rehearsal of nothing -
  // resolve both BEFORE reporting, so `item_not_found` surfaces on the safe
  // call rather than only on the destructive one.
  for (const humanId of [keep, drop]) {
    const found = await getItemNode(ctx.store, repo, humanId);
    if (!found) throw new BacklogItemNotFoundError(repo, humanId);
  }
  if (!confirm) {
    return { data: { dryRun: true, repo, keep, drop, reason, merged: false }, warnings };
  }
  const item = await mergeItemsOp(ctx, repo, keep, drop, reason);
  return {
    data: { dryRun: false, repo, keep, drop, reason, merged: true, item },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * INTERFACE_v2 6 `merge` - `SAME_AS(drop -> keep)` plus invalidation of the
 * dropped item. Dry-run by default; both endpoints are resolved on the dry run
 * too, so a typo'd id fails safely.
 *
 * @param params `{ repo, keep, drop, reason, confirm? }`
 */
export async function adminMerge(ctx: BacklogCtx, params: ParamBag = {}, by?: string): Promise<IOutcomeEnvelope<IMergeReport>> {
  return envelope(() => runMerge(ctx, params, by));
}

// ============================================================================
// Bulk data ops - export / render / import.
// ============================================================================

const EXPORT_PARAM_KEYS = ['filter'] as const;
const RENDER_PARAM_KEYS = ['filter'] as const;
const IMPORT_PARAM_KEYS = ['path', 'repo', 'projectPath', 'plan', 'sourcePath', 'confirm'] as const;

/** INTERFACE_v2 6 `import` - the v1 `ImportResult` plus the dry-run flag that produced it. */
export interface IImportReport {
  dryRun: boolean;
  result: ImportResult;
}

async function runImport(
  ctx: BacklogCtx,
  params: ParamBag,
  by: string | undefined
): Promise<{ data: IImportReport; warnings?: string[] }> {
  assertKnownParams('import', params, IMPORT_PARAM_KEYS);
  const path = requireString(params, 'path');
  const repo = requireString(params, 'repo');
  const projectPath = readString(params, 'projectPath');
  const plan = readString(params, 'plan');
  const sourcePath = readString(params, 'sourcePath');
  const confirm = readBoolean(params, 'confirm') ?? false;
  if (!existsSync(path)) {
    // `importFromMarkdown` would throw a raw ENOENT here, which maps to
    // `internal` - a caller typo deserves `invalid_argument` (exit 2).
    throw new InvalidArgumentError('path', `backlog_admin(import): no such file: ${path}`);
  }
  const warnings: string[] = [];
  if (confirm) assertAttribution(by);
  else warnings.push('import: dry run - nothing was written. Re-run with `confirm: true` (and `by`) to apply.');

  const result = await importFromMarkdownOp(ctx, {
    path,
    repo,
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    dryRun: !confirm,
  });
  return { data: { dryRun: !confirm, result }, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * INTERFACE_v2 6 `export` - the full item set for a filter, as data.
 * Read-only. Only the v1-honoured filter keys are accepted; a v2-only key is
 * `unsupported` naming it rather than silently dropped.
 */
export async function adminExport(ctx: BacklogCtx, params: ParamBag = {}): Promise<IOutcomeEnvelope<BacklogItem[]>> {
  return envelope(async () => {
    assertKnownParams('export', params, EXPORT_PARAM_KEYS);
    const filter = readFilter(params);
    return { data: await exportJsonOp(ctx, filter) };
  });
}

/** INTERFACE_v2 6 `render` - the markdown projection for a filter. Read-only. */
export async function adminRender(ctx: BacklogCtx, params: ParamBag = {}): Promise<IOutcomeEnvelope<{ markdown: string }>> {
  return envelope(async () => {
    assertKnownParams('render', params, RENDER_PARAM_KEYS);
    const filter = readFilter(params);
    return { data: { markdown: await renderToMarkdownOp(ctx, filter) } };
  });
}

/**
 * INTERFACE_v2 6 `import` - import a BACKLOG.md into the graph.
 * Dry-run by default (the parse/diagnostics still run and are reported).
 *
 * @param params `{ path, repo, projectPath?, plan?, sourcePath?, confirm? }`
 */
export async function adminImport(ctx: BacklogCtx, params: ParamBag = {}, by?: string): Promise<IOutcomeEnvelope<IImportReport>> {
  return envelope(() => runImport(ctx, params, by));
}

// ============================================================================
// System ops - migration status / phase, version, repo reconciliation.
// ============================================================================

/** INTERFACE_v2 6 `migration_status` - read-only. */
export async function adminMigrationStatus(
  ctx: BacklogCtx,
  params: ParamBag = {}
): Promise<IOutcomeEnvelope<MigrationStatusResult>> {
  return envelope(async () => {
    assertKnownParams('migration_status', params, []);
    return { data: await migrationStatusOp(ctx) };
  });
}

/**
 * INTERFACE_v2 6 `set_migration_phase` - writes the global `migration.phase`
 * config value. Attributed (`by` required) because it is a durable,
 * cross-process, cross-repo mutation; there is no dry-run form because the
 * "candidate set" is a single scalar the caller already supplied.
 *
 * @param params `{ phase: MigrationPhase }`
 */
export async function adminSetMigrationPhase(
  ctx: BacklogCtx,
  params: ParamBag = {},
  by?: string
): Promise<IOutcomeEnvelope<SetMigrationPhaseResult>> {
  return envelope(async () => {
    assertKnownParams('set_migration_phase', params, ['phase']);
    const phase = readEnum(params, 'phase', MIGRATION_PHASES);
    if (phase === undefined) {
      throw new InvalidArgumentError('phase', 'backlog_admin(set_migration_phase): "phase" is required');
    }
    assertAttribution(by);
    return { data: await setMigrationPhaseOp(ctx, phase) };
  });
}

/** INTERFACE_v2 6 `version` - this package's real name/version, read fresh from package.json. Read-only. */
export async function adminVersion(ctx: BacklogCtx, params: ParamBag = {}): Promise<IOutcomeEnvelope<BacklogVersionInfo>> {
  return envelope(async () => {
    assertKnownParams('version', params, []);
    return { data: await versionOp(ctx) };
  });
}

const RECONCILE_PARAM_KEYS = ['from', 'to', 'confirm'] as const;

/**
 * INTERFACE_v2 6 `reconcile_repo` - move every live item off a legacy repo
 * key onto the canonical one (BUG-BACKLOG-REPO-SPLIT-001). Delegates wholesale
 * to `store/repo-migration.ts`'s `migrateRepo`, which already owns collision
 * renaming, edge preservation and per-item outcome reporting; this layer adds
 * only the uniform dry-run/confirm gate.
 *
 * @param params `{ from, to, confirm? }`
 */
export async function adminReconcileRepo(
  ctx: BacklogCtx,
  params: ParamBag = {},
  by?: string
): Promise<IOutcomeEnvelope<RepoMigrationResult>> {
  return envelope(async () => {
    assertKnownParams('reconcile_repo', params, RECONCILE_PARAM_KEYS);
    const from = requireString(params, 'from');
    const to = requireString(params, 'to');
    const confirm = readBoolean(params, 'confirm') ?? false;
    // `migrateRepo` stamps `by` into the audit note it attaches to every moved
    // item, so a confirmed run must be attributed; a dry run writes nothing and
    // the value is never persisted.
    const actor = confirm ? assertAttribution(by) : (by ?? 'dry-run');
    const warnings = confirm
      ? []
      : ['reconcile_repo: dry run - nothing was written. Re-run with `confirm: true` (and `by`) to apply.'];
    return {
      data: await migrateRepoOp(ctx, from, to, actor, !confirm),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

// ============================================================================
// BUG-BACKLOG-BATCH-CLI-001 - `batch`, given a discoverable, documented home.
// ============================================================================

/** 6 `batch` - the fan-out mode vocabulary, mirroring `@adhd/apigen-engine-runtime`'s `BatchOptions.mode` (batch.ts:68). */
export const BATCH_MODES = ['parallel', 'serial', 'chained'] as const;

/** 6 `batch` - see {@link BATCH_MODES}. */
export type IBatchMode = (typeof BATCH_MODES)[number];

/** 6 `batch` - per-item failure policy, mirroring `BatchOptions.onItemError` (apigen-engine-runtime batch.ts:60). */
export const BATCH_ON_ITEM_ERROR = ['continue', 'abort'] as const;

/** 6 `batch` - see {@link BATCH_ON_ITEM_ERROR}. */
export type IBatchOnItemError = (typeof BATCH_ON_ITEM_ERROR)[number];

/**
 * Mirrors `@adhd/apigen-engine-runtime`'s `BATCH_DEFAULT_CONCURRENCY`
 * (batch.ts:27). Duplicated as a constant rather than imported because
 * `entrypoint/backlog` does not depend on `@adhd/apigen-engine-runtime`
 * (package.json lists only the plugin, `@adhd/apigen-plugin-batch`) and adding
 * a dependency to document a default is the wrong trade. If the runtime
 * changes these, this must change with it.
 */
export const BATCH_DEFAULT_CONCURRENCY = 4;
/** See {@link BATCH_DEFAULT_CONCURRENCY}. */
export const BATCH_MAX_CONCURRENCY = 32;

/** 6 `batch` - the normalized, validated request. Returned even when nothing executes, so the invocation is inspectable. */
export interface IBatchPlan {
  operation: string;
  itemCount: number;
  mode: IBatchMode;
  /** Effective concurrency: always 1 for `serial`/`chained` (apigen-engine-runtime batch.ts:144). */
  concurrency: number;
  onItemError: IBatchOnItemError;
  itemTimeoutMs?: number;
}

/** 6 `batch` - where this exact request is executable. The literal cure for BUG-BACKLOG-BATCH-CLI-001's undocumented surface. */
export interface IBatchDispatchHint {
  http: string;
  mcp: string;
  note: string;
}

/** 6 `batch` - one item's outcome. Rejections carry a real envelope error code, never a bare string. */
export interface IBatchItemOutcome {
  index: number;
  ok: boolean;
  value?: unknown;
  error?: IOutcomeError;
  /** True when an earlier failure under `onItemError:"abort"`/`mode:"chained"` stopped the sweep before this item ran. */
  notAttempted?: boolean;
}

/** 6 `batch` - the outcome of an admin batch call. */
export interface IBatchReport {
  plan: IBatchPlan;
  /** False when no dispatcher was supplied - the plan is returned, and nothing ran. Never a fake success. */
  executed: boolean;
  dispatch: IBatchDispatchHint;
  results?: IBatchItemOutcome[];
  fulfilled?: number;
  rejected?: number;
  notAttempted?: number;
}

/**
 * The fan-out callback. Supplied by the HOST (CLI/MCP/REST wiring), never by a
 * serialized caller - which is why it is a separate runtime argument to
 * {@link backlogAdmin} rather than a field of `IBacklogAdminInput` (a
 * function-typed property would break apigen's schema extraction).
 */
export type IAdminBatchDispatch = (operation: string, item: Record<string, unknown>, index: number) => Promise<unknown>;

/** Non-serializable runtime collaborators for {@link backlogAdmin}. */
export interface IAdminRuntime {
  /** When present, `action:"batch"` really fans out; when absent it returns the validated plan with `executed: false`. */
  batchDispatch?: IAdminBatchDispatch;
}

const BATCH_PARAM_KEYS = ['operation', 'items', 'concurrency', 'mode', 'onItemError', 'itemTimeoutMs'] as const;

function batchDispatchHint(operation: string): IBatchDispatchHint {
  return {
    http: `POST /_batch/action {"operation":"${operation}","items":[...],"concurrency":N,"mode":"parallel|serial|chained","onItemError":"continue|abort","itemTimeoutMs":N}`,
    mcp: `batch_action({ operation: "${operation}", items: [ ... ] })`,
    note:
      'The batch mount is transport-level (@adhd/apigen-plugin-batch, mounted in server.ts) - this admin action validates and normalizes the same request shape so it is discoverable from the tool surface (BUG-BACKLOG-BATCH-CLI-001).',
  };
}

/** Rejects after `ms`, so an item that never settles cannot hold the sweep open forever. */
function withItemTimeout<T>(promise: Promise<T>, ms: number | undefined, index: number): Promise<T> {
  if (ms === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`backlog_admin(batch): item ${index} exceeded itemTimeoutMs=${ms}`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

async function runBatch(
  params: ParamBag,
  by: string | undefined,
  dispatch: IAdminBatchDispatch | undefined
): Promise<{ data: IBatchReport; warnings?: string[] }> {
  assertKnownParams('batch', params, BATCH_PARAM_KEYS);
  const operation = requireString(params, 'operation');
  const rawItems = params['items'];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new InvalidArgumentError(
      'items',
      'backlog_admin(batch): "items" must be a non-empty array of operation argument objects'
    );
  }
  const items = rawItems.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InvalidArgumentError(
        'items',
        `backlog_admin(batch): items[${index}] must be an object, received ${JSON.stringify(entry)}`
      );
    }
    return entry as Record<string, unknown>;
  });
  const mode = readEnum(params, 'mode', BATCH_MODES) ?? 'parallel';
  const onItemError = readEnum(params, 'onItemError', BATCH_ON_ITEM_ERROR) ?? 'continue';
  const requestedConcurrency = readInteger(params, 'concurrency', 1, BATCH_MAX_CONCURRENCY);
  const itemTimeoutMs = readInteger(params, 'itemTimeoutMs', 1, 3_600_000);
  const concurrency = mode === 'parallel' ? (requestedConcurrency ?? BATCH_DEFAULT_CONCURRENCY) : 1;

  const plan: IBatchPlan = {
    operation,
    itemCount: items.length,
    mode,
    concurrency,
    onItemError,
    ...(itemTimeoutMs !== undefined ? { itemTimeoutMs } : {}),
  };
  const dispatchHint = batchDispatchHint(operation);

  if (!dispatch) {
    return {
      data: { plan, executed: false, dispatch: dispatchHint },
      warnings: [
        'batch: no fan-out dispatcher is wired into this admin invocation - the request was validated and normalized but NOT executed. Use the transport mount named in `dispatch`.',
      ],
    };
  }
  assertAttribution(by);

  const results: IBatchItemOutcome[] = new Array(items.length);
  let cursor = 0;
  let stop = false;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (stop) {
        results[index] = {
          index,
          ok: false,
          notAttempted: true,
          error: {
            code: 'internal',
            message: `backlog_admin(batch): item ${index} not attempted - an earlier item failed and ${
              mode === 'chained' ? 'mode is "chained"' : 'onItemError is "abort"'
            }`,
          },
        };
        continue;
      }
      try {
        const value = await withItemTimeout(dispatch(operation, items[index], index), itemTimeoutMs, index);
        results[index] = { index, ok: true, value };
      } catch (err) {
        results[index] = { index, ok: false, error: toOutcomeError(err) };
        if (mode === 'chained' || onItemError === 'abort') stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const fulfilled = results.filter((r) => r.ok).length;
  const notAttempted = results.filter((r) => r.notAttempted === true).length;
  return {
    data: {
      plan,
      executed: true,
      dispatch: dispatchHint,
      results,
      fulfilled,
      rejected: results.length - fulfilled - notAttempted,
      notAttempted,
    },
  };
}

/**
 * INTERFACE_v2 6 `batch` / BUG-BACKLOG-BATCH-CLI-001 - the documented,
 * discoverable home for the bulk fan-out.
 *
 * Always validates and normalizes the request (`operation`, `items`,
 * `concurrency`, `mode`, `onItemError`, `itemTimeoutMs`) against the SAME
 * vocabulary `@adhd/apigen-plugin-batch` parses, and always returns the
 * transport invocation that runs it. It executes the fan-out only when the
 * host supplies a `batchDispatch` - with none, `executed` is `false` and a
 * warning says so, which is the honest answer rather than a fabricated
 * success.
 *
 * @param ctx unused - kept so every `admin*` export has the same
 *   `(ctx, params, by, ...)` shape a host can call uniformly, exactly as
 *   `client.ts`'s `version(ctx)` keeps its unused `ctx` for signature
 *   consistency rather than special-casing one export.
 * @param params `{ operation, items, concurrency?, mode?, onItemError?, itemTimeoutMs? }`
 * @param by required only when a dispatcher is present (the fan-out mutates)
 */
export async function adminBatch(
  ctx: BacklogCtx,
  params: ParamBag = {},
  by?: string,
  dispatch?: IAdminBatchDispatch
): Promise<IOutcomeEnvelope<IBatchReport>> {
  void ctx;
  return envelope(() => runBatch(params, by, dispatch));
}

// ============================================================================
// 5a.3 - declared `files` overlap. `view:"overlap"`'s computation.
// ============================================================================

/** 5a.3 / AC-28 - the axes an overlap query can be computed on. Mirrors `IOverlapAxis` (model.ts:2310). */
export const OVERLAP_AXES: readonly IOverlapAxis[] = ['file', 'project', 'package', 'author'];

/** 5a.3 - pairwise comparison is quadratic; a hard, stated ceiling beats an unbounded scan. */
export const MAX_OVERLAP_IDS = 200;

/**
 * The declared units one item contributes on `axis`.
 *
 * 5a.3 is emphatic that this tool "never reads the filesystem" - every unit
 * comes from what the item DECLARES in its own metadata. `files` is not
 * surfaced by `toBacklogItem` yet (store/mapping.ts:168-217 maps the v1 field
 * set), so it is read straight off the node metadata here.
 */
function overlapUnits(metadata: Record<string, unknown> | undefined, axis: IOverlapAxis): string[] {
  const meta = (metadata ?? {}) as Partial<BacklogNodeMeta> & {
    files?: unknown;
    packagePath?: unknown;
    author?: unknown;
  };
  switch (axis) {
    case 'file':
      return Array.isArray(meta.files)
        ? (meta.files as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
        : [];
    case 'project':
      return typeof meta.projectPath === 'string' && meta.projectPath.length > 0 ? [meta.projectPath] : [];
    case 'package':
      return typeof meta.packagePath === 'string' && meta.packagePath.length > 0 ? [meta.packagePath] : [];
    case 'author':
      // Canonicalised (2.1.1) so `researcher:a` and `researcher:b` overlap as
      // one `researcher`, matching AC-14's aggregate-stability rule.
      return typeof meta.author === 'string' && meta.author.length > 0 ? [canonicalIdentityKey(meta.author)] : [];
    default:
      return [];
  }
}

/**
 * INTERFACE_v2 5a.3 / AC-28 - pairwise declared-overlap over a supplied
 * humanId set. This is the computation `backlog_query({ view: "overlap" })`
 * mounts; it lives here because it is a maintenance/wave-selection input
 * rather than an item read.
 *
 * **An input to wave selection, never a scheduler** (5a.4): it reports
 * declared overlap and nothing else - it never reads the filesystem and never
 * chooses a wave.
 *
 * Unresolvable ids are an error, not a silent narrowing: an unknown id is
 * `item_not_found`, and an id that is live under more than one repo is
 * `ambiguous`. A repeated id is de-duplicated with a warning.
 *
 * @param humanIds the set to intersect (2..{@link MAX_OVERLAP_IDS})
 * @param axis default `"file"`
 * @param repo optional scope; without it each id must be unique across repos
 */
export async function computeOverlapView(
  ctx: BacklogCtx,
  humanIds: readonly string[],
  axis: IOverlapAxis = 'file',
  repo?: string
): Promise<IOutcomeEnvelope<IOverlapView>> {
  return envelope(async () => {
    if (!Array.isArray(humanIds) || humanIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
      throw new InvalidArgumentError('humanIds', 'backlog_admin/overlap: "humanIds" must be an array of non-empty strings');
    }
    if (!OVERLAP_AXES.includes(axis)) {
      throw new InvalidArgumentError(
        'overlapBy',
        `backlog_admin/overlap: "overlapBy" must be one of ${OVERLAP_AXES.join(' | ')}`
      );
    }
    const warnings: string[] = [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of humanIds) {
      const id = raw.trim();
      if (seen.has(id)) {
        warnings.push(
          `overlap: humanId "${id}" was supplied more than once - de-duplicated (the pair set is over distinct items)`
        );
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    if (ids.length < 2) {
      throw new InvalidArgumentError(
        'humanIds',
        `backlog_admin/overlap: needs at least 2 distinct humanIds, received ${ids.length}`
      );
    }
    if (ids.length > MAX_OVERLAP_IDS) {
      throw new BacklogValidationError(
        `backlog_admin/overlap: ${ids.length} humanIds exceeds MAX_OVERLAP_IDS (${MAX_OVERLAP_IDS}) - pairwise comparison is quadratic; narrow the set`,
        ['humanIds']
      );
    }

    const units = new Map<string, string[]>();
    for (const humanId of ids) {
      let node = repo !== undefined ? await findItemNode(ctx.store, repo, humanId) : null;
      if (repo === undefined) {
        const matches = await findHumanIdInAnyRepo(ctx.store, humanId);
        if (matches.length > 1) {
          throw new AmbiguousHumanIdError(
            '*',
            humanId,
            matches.map((n) => n.id)
          );
        }
        node = matches[0] ?? null;
      }
      if (!node) throw new BacklogItemNotFoundError(repo ?? '*', humanId);
      units.set(humanId, overlapUnits(node.metadata as Record<string, unknown> | undefined, axis));
    }

    const pairs: IOverlapPair[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const setA = new Set(units.get(a) ?? []);
        const shared = [...new Set((units.get(b) ?? []).filter((unit) => setA.has(unit)))].sort();
        if (shared.length === 0) continue;
        pairs.push({ a, b, shared });
      }
    }
    return { data: { axis, pairs }, ...(warnings.length > 0 ? { warnings } : {}) };
  });
}

// ============================================================================
// The `backlog_admin` entry point.
// ============================================================================

/**
 * The tagged per-action payload `backlog_admin` returns. Tagged so a caller
 * that dispatched dynamically can narrow the result without re-reading its own
 * request (0.4 outcome-reporting).
 */
export type IAdminResult =
  | { action: 'doctor'; report: IDoctorReport }
  | { action: 'prune'; report: IPruneReport }
  | { action: 'archive'; report: IArchiveReport }
  | { action: 'merge'; report: IMergeReport }
  | { action: 'export'; items: BacklogItem[] }
  | { action: 'render'; markdown: string }
  | { action: 'import'; report: IImportReport }
  | { action: 'migration_status'; status: MigrationStatusResult }
  | { action: 'set_migration_phase'; status: SetMigrationPhaseResult }
  | { action: 'version'; version: BacklogVersionInfo }
  | { action: 'batch'; report: IBatchReport }
  | { action: 'reconcile_repo'; report: RepoMigrationResult };

/** Re-wraps a per-action envelope into the tagged union, preserving warnings and the exact error. */
function tag<T>(env: IOutcomeEnvelope<T>, build: (data: T) => IAdminResult): IOutcomeEnvelope<IAdminResult> {
  if (!env.ok) return env;
  return okEnvelope<IAdminResult>(build(env.data), env.warnings ? { warnings: env.warnings } : undefined);
}

/**
 * INTERFACE_v2 6 - `backlog_admin({ action, params?, by? })`.
 *
 * The single bulk/maintenance/system verb of the six-tool surface. Dispatches
 * to the per-action operations above; every one of them returns the 7.1
 * envelope, so this never throws for a caller error.
 *
 * Actions that are NOT served, and why (each is an explicit refusal with a
 * typed code, never a silent success):
 * - `skill` -> `unsupported`. 6's host-command carve-out: `install-skill` is a
 *   pure filesystem/config operation that must never open the store
 *   (cli.ts:243-256), so it stays a host command.
 * - `migrate_model_v2` -> `unsupported`. GRAPH_MODEL_v2 6's migration has a
 *   result contract (`IMigrateModelV2Result`, model.ts:2548) but no
 *   implementation in this build.
 * - the six EPIC-G actions -> `rag_not_configured` (AC-12), since the embedding
 *   substrate they operate on is not wired in this build.
 *
 * @param input `{ action, params?, by? }` - `by` is required by the actions
 *   that actually write (see each `admin*` function).
 * @param runtime host-supplied, non-serializable collaborators (today: the
 *   batch fan-out dispatcher).
 */
export async function backlogAdmin(
  ctx: BacklogCtx,
  input: IBacklogAdminInput,
  runtime: IAdminRuntime = {}
): Promise<IOutcomeEnvelope<IAdminResult>> {
  const action = input?.action;
  if (!(BACKLOG_ADMIN_ACTIONS as readonly string[]).includes(action)) {
    // An unknown ACTION is `not_found` (exit 4, "unknown command"), which 7.2
    // deliberately separates from a bad flag (`invalid_argument`, exit 2).
    return errorEnvelope(
      'not_found',
      `backlog_admin: unknown action ${JSON.stringify(action)} - known actions: ${BACKLOG_ADMIN_ACTIONS.join(', ')}`,
      { action }
    );
  }
  const rawParams: unknown = input.params ?? {};
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
    return errorEnvelope('invalid_argument', 'backlog_admin: "params" must be an object', { argument: 'params' });
  }
  const params = rawParams as ParamBag;
  const by = input.by;

  if (EPIC_G_ACTIONS.includes(action)) {
    return envelope<IAdminResult>(async () => {
      throw new RagNotConfiguredError(`backlog_admin(${action})`);
    });
  }

  switch (action) {
    case 'doctor':
      return tag(await adminDoctor(ctx, params), (report) => ({ action: 'doctor', report }));
    case 'prune':
      return tag(await adminPrune(ctx, params, by), (report) => ({ action: 'prune', report }));
    case 'archive':
      return tag(await adminArchive(ctx, params, by), (report) => ({ action: 'archive', report }));
    case 'merge':
      return tag(await adminMerge(ctx, params, by), (report) => ({ action: 'merge', report }));
    case 'export':
      return tag(await adminExport(ctx, params), (items) => ({ action: 'export', items }));
    case 'render':
      return tag(await adminRender(ctx, params), ({ markdown }) => ({ action: 'render', markdown }));
    case 'import':
      return tag(await adminImport(ctx, params, by), (report) => ({ action: 'import', report }));
    case 'migration_status':
      return tag(await adminMigrationStatus(ctx, params), (status) => ({ action: 'migration_status', status }));
    case 'set_migration_phase':
      return tag(await adminSetMigrationPhase(ctx, params, by), (status) => ({ action: 'set_migration_phase', status }));
    case 'version':
      return tag(await adminVersion(ctx, params), (info) => ({ action: 'version', version: info }));
    case 'batch':
      return tag(await adminBatch(ctx, params, by, runtime.batchDispatch), (report) => ({ action: 'batch', report }));
    case 'reconcile_repo':
      return tag(await adminReconcileRepo(ctx, params, by), (report) => ({ action: 'reconcile_repo', report }));
    case 'skill':
      return envelope<IAdminResult>(async () => {
        throw new UnsupportedOperationError(
          'skill',
          'backlog_admin(skill): install-skill is a HOST command, not a data operation - it must never open the store (INTERFACE_v2 6 host-command carve-out, cli.ts:243-256). Run `backlog install-skill` instead.'
        );
      });
    case 'migrate_model_v2':
      return envelope<IAdminResult>(async () => {
        throw new UnsupportedOperationError(
          'migrate_model_v2',
          'backlog_admin(migrate_model_v2): the GRAPH_MODEL_v2 6 migration has a pinned result contract (IMigrateModelV2Result) but no implementation in this build - it lands with EPIC-A.'
        );
      });
    default:
      return errorEnvelope('not_found', `backlog_admin: action ${JSON.stringify(action)} has no handler in this build`, {
        action,
      });
  }
}
