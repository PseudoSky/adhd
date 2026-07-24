/**
 * model.ts — the `BacklogItem` domain shape and every operation-surface input
 * / output type. Ported verbatim from `SPEC.md` §4/§5. Pure types + a handful
 * of tiny, dependency-free classification helpers — no store/env imports.
 */

// ============================================================================
// §4.1 — BacklogItem
// ============================================================================

export type BacklogStatus =
  // open
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'PARTIAL'
  | 'OUTSTANDING'
  | 'DEFERRED'
  | 'BLOCKED'
  | 'MIXED'
  | 'UNKNOWN'
  // terminal — done
  | 'FIXED'
  | 'RESOLVED'
  | 'DONE'
  | 'SHIPPED'
  | 'VERIFIED'
  | 'REMOVED'
  // terminal — workaround
  | 'MITIGATED'
  // terminal — dismissed
  | 'SUPERSEDED'
  | 'INVALID'
  | 'DUPLICATE'
  | 'WONTFIX';

/** §4.2 rule 3 — terminal-done + terminal-workaround: require ≥1 citation. */
export const TERMINAL_DONE_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  'FIXED',
  'RESOLVED',
  'DONE',
  'SHIPPED',
  'VERIFIED',
  'REMOVED',
]);

export const TERMINAL_WORKAROUND_STATUSES: ReadonlySet<BacklogStatus> = new Set(['MITIGATED']);

/** §4.2 rule 3 — terminal-dismissed: require a reason (citation optional). */
export const TERMINAL_DISMISSED_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  'SUPERSEDED',
  'INVALID',
  'DUPLICATE',
  'WONTFIX',
]);

export const TERMINAL_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  'FIXED',
  'RESOLVED',
  'DONE',
  'SHIPPED',
  'VERIFIED',
  'REMOVED',
  'MITIGATED',
  'SUPERSEDED',
  'INVALID',
  'DUPLICATE',
  'WONTFIX',
]);

export function isTerminalStatus(status: BacklogStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** §4.2 rule 3 — "a transition INTO any terminal status requires evidence." */
export function requiresCitation(status: BacklogStatus): boolean {
  return TERMINAL_DONE_STATUSES.has(status) || TERMINAL_WORKAROUND_STATUSES.has(status);
}

export function requiresReason(status: BacklogStatus): boolean {
  return TERMINAL_DISMISSED_STATUSES.has(status);
}

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Citation {
  /** Repo-relative path, matching the global CLAUDE.md citation format. */
  file: string;
  /** e.g. "42-58"; omit for a whole-file citation. */
  lines?: string;
  /** Free text — active git context / agent name / model, per the citation format. */
  context?: string;
}

export interface Note {
  by: string;
  at: string; // ISO
  text: string;
}

export interface BacklogItem {
  /** The graph node id (see DESIGN.md §2). Never exposed to markdown; internal only. */
  nodeId: number;
  /** Human-facing id, e.g. "BUG-APIGEN-014". Unique within (repo, family). */
  humanId: string;
  /** First hyphen segment of humanId, e.g. "BUG". Open vocabulary — not an enum. */
  kind: string;
  /** humanId with the trailing "-NNN" stripped, e.g. "BUG-APIGEN". */
  family: string;
  title: string;
  /** Markdown body — the full entry text minus the header line. */
  body: string;
  status: BacklogStatus;
  priority?: Priority;
  /** Stable repo slug — see SPEC.md §3 "Repo identity". */
  repo: string;
  /** Package-relative path within the repo, e.g. "packages/apigen/apigen-core-client". Optional — repo-level items omit it. */
  projectPath?: string;
  /** Plan slug this item is attached to, if any — e.g. "agent-registry-schema". */
  plan?: string;
  /** Source markdown path this item was imported from, if any (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001). */
  importedFrom?: string;
  /** Durable ownership — who this item is assigned to (may differ from the active claimant). */
  assignee?: string;
  /** Ephemeral claim lease — see SPEC.md §5. */
  claimedBy?: string;
  claimedAt?: string; // ISO
  citations: Citation[];
  notes: Note[];
  tags: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

// ============================================================================
// Errors (thrown by client.ts / store/*) — the citation/reason gate has teeth
// (SPEC.md §7 DoD clause 6): a transition into a terminal status without the
// required evidence THROWS, it never silently succeeds.
// ============================================================================

export class BacklogItemNotFoundError extends Error {
  constructor(repo: string, humanId: string) {
    super(`backlog item not found: ${repo}::${humanId}`);
    this.name = 'BacklogItemNotFoundError';
  }
}

export class CitationRequiredError extends Error {
  constructor(status: BacklogStatus) {
    super(
      `transition to terminal status "${status}" requires at least one citation ` +
        `(either already attached via addCitation or passed inline to transitionStatus/resolveItem) — ` +
        `per the global CLAUDE.md rule "No citation, no claim."`
    );
    this.name = 'CitationRequiredError';
  }
}

export class ReasonRequiredError extends Error {
  constructor(status: BacklogStatus) {
    super(`transition to terminal-dismissed status "${status}" requires a reason string`);
    this.name = 'ReasonRequiredError';
  }
}

export class ClaimHeldError extends Error {
  constructor(
    public readonly heldBy: string,
    public readonly heldSince: string
  ) {
    super(`item is claimed by "${heldBy}" since ${heldSince} (not stale) — cannot start work`);
    this.name = 'ClaimHeldError';
  }
}

export class DependencyCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'DependencyCycleError';
  }
}

// ============================================================================
// §5.1 — CRUD
// ============================================================================

export interface DedupeScanInput {
  symbol?: string;
  path?: string;
  errorText?: string;
}

export interface CreateItemInput {
  family: string; // e.g. "BUG-APIGEN" — required unless idOverride given
  idOverride?: string; // explicit human id (import path, or planner-chosen)
  title: string;
  body: string;
  repo: string;
  projectPath?: string;
  priority?: Priority;
  tags?: string[];
  plan?: string;
  /** Source markdown path this item is being imported from, if any (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001). */
  importedFrom?: string;
  dedupeScan?: DedupeScanInput;
  /** Skip the dedupe gate and file anyway (planner override after reviewing candidates). */
  force?: boolean;
}

export interface CreateItemResult {
  item: BacklogItem;
  created: boolean; // false ⇒ no node written; see duplicateCandidates
  duplicateCandidates: BacklogItem[];
}

export interface UpdateItemInput {
  title?: string;
  body?: string;
  tags?: string[];
  projectPath?: string;
  /**
   * Provenance owner of this item (the source-file path that authored it).
   * Only ever set to BACKFILL a legacy row whose `importedFrom` was never
   * stamped (created before the provenance field existed) — see
   * `importFromMarkdown`'s owning-import branch. An already-stamped owner is
   * immutable and must never be reassigned via this patch.
   */
  importedFrom?: string;
}

export interface BacklogFilter {
  repo?: string;
  projectPath?: string;
  status?: BacklogStatus | 'open' | 'closed';
  kind?: string;
  family?: string;
  priority?: Priority;
  plan?: string;
  assignee?: string;
  claimedBy?: string;
  tags?: string[];
  grep?: string; // FTS query over title+body
  /**
   * Exact-match on `BacklogItem.importedFrom` — the sourcePath that OWNS an
   * item's canonical content (DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001).
   * Needed for a root-level `BACKLOG.md` projection: filtering by bare
   * `{repo}` alone would also surface every item cross-referenced FROM root
   * by a plan/package file (which correctly carries a `plan`/`projectPath`
   * of its own once ownership-gating lands) — `importedFrom` is the only
   * field that reliably answers "does THIS file own this item's content",
   * independent of which OTHER files also cite the same id.
   */
  importedFrom?: string;
  /**
   * Repo-level projection selector (MIGRATION.md §2.2 "root BACKLOG.md =
   * repo-only, no projectPath/plan"). When true, returns only items that carry
   * NEITHER a `projectPath` NOR a `plan` — i.e. items owned by the repo root
   * rather than a package or plan projection. Unlike the `importedFrom`
   * workaround it does not depend on provenance, so a freshly tool-created
   * repo-level item (which has no `importedFrom`) still appears in the root
   * projection — the Phase-3 DoD ("a fresh create-item appears in the
   * regenerated BACKLOG.md") requires this. Cross-referenced items that carry a
   * `plan`/`projectPath` render in that plan/package projection instead, never
   * duplicated into root.
   */
  rootLevel?: boolean;
  limit?: number;
  offset?: number;
}

// ============================================================================
// §5.2 — Query / report
// ============================================================================

export interface StatsScope {
  repo?: string; // absent + global scope ⇒ cross-repo rollup
  projectPath?: string;
}

export interface BacklogStats {
  total: number;
  open: number;
  closed: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  byFamily: Record<string, number>;
  byPriority: Record<string, number>;
  byRepo: Record<string, number>; // only populated when scope.repo is absent
}

export interface DependencyGraph {
  nodes: Array<{ humanId: string; title: string; status: BacklogStatus }>;
  edges: Array<{ from: string; to: string; rel: 'DEPENDS_ON' | 'RELATES_TO' | 'PART_OF' }>;
}

export type TopoOrderResult =
  | { ok: true; order: string[] } // humanIds, dependency-first
  | { ok: false; cycle: string[] }; // humanIds forming a cycle

// ============================================================================
// §5.3 — Multi-agent coordination
// ============================================================================

export interface ClaimOpts {
  /** Minutes after which an unrenewed claim is considered abandoned. Default: 30 (DESIGN.md §4.2). */
  staleAfterMin?: number;
  /** Explicitly override a claim that is NOT stale (human-confirmed abandonment). */
  force?: boolean;
}

export type ClaimStatus = 'claimed' | 'renewed' | 'reclaimed-stale' | 'held';

export interface ClaimResult {
  status: ClaimStatus;
  claimedBy: string;
  claimedAt: string; // ISO
  /** Only present when status === 'held'. */
  heldBy?: string;
  heldSince?: string;
  /** Only present when status === 'reclaimed-stale' — the abandoned claimant, for audit. */
  previousClaimant?: string;
}

export interface ReleaseResult {
  status: 'released' | 'release-noop';
  wasClaimedBy?: string;
}

// ============================================================================
// §5.4 — Lifecycle
// ============================================================================

export interface TransitionOpts {
  by: string;
  note?: string;
  citations?: Citation[]; // required (≥1) when status is terminal-done/terminal-workaround — see §4.2 rule 3
  reason?: string; // required when status is terminal-dismissed — see §4.2 rule 3
}

export interface ArchiveOpts {
  /** Exclude specific humanIds from the sweep even though they're terminal (mirrors tools/util/backlog.mjs's --exclude). */
  exclude?: string[];
}

export interface ArchiveResult {
  archivedCount: number;
  changelogMarkdown: string; // caller (CLI) writes this into CHANGELOG.md
}

// ============================================================================
// §5.6 — Interop
// ============================================================================

export interface ImportMarkdownInput {
  path: string;
  repo: string;
  projectPath?: string;
  /** Plan slug to attach every imported item to (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001) — replaces the post-import attachToPlan-per-id workaround. */
  plan?: string;
  /**
   * Provenance path recorded on each imported node's `importedFrom` field
   * (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001). Defaults to `path` when
   * omitted — the file actually read IS the source, so a caller only needs
   * to set this explicitly when it differs (e.g. importing from a scratch
   * copy but wanting the ORIGINAL path recorded).
   */
  sourcePath?: string;
  dryRun?: boolean;
}

/** A `##`/`###` header line that failed the strict `HEADER_RE` id pattern but looks like an attempted id (DEBT-BACKLOG-IMPORT-SILENT-DROP-001). */
export interface MalformedHeaderInfo {
  /** 1-based line number in the source file. */
  line: number;
  headerLine: string;
}

export interface ImportResult {
  parsed: number;
  created: number;
  skippedDuplicates: number;
  /**
   * Of `skippedDuplicates` (an already-existing humanId), how many had a
   * title/body/priority/status that DIFFERED from the graph's current copy
   * and were refreshed to match the re-imported source
   * (BUG-BACKLOG-IMPORT-INSERT-ONLY-NO-UPDATE-001 — re-importing used to be
   * pure insert-only: a status/content change made directly in a
   * `BACKLOG.md` file after the first import was silently never reflected
   * in the graph on a later re-import). An unchanged existing item is a
   * true no-op — never counted here.
   */
  updated: number;
  errors: Array<{ humanId: string; message: string }>;
  /** Headers that look like a corrupted/typo'd id and were dropped instead of parsed — never silent (DEBT-BACKLOG-IMPORT-SILENT-DROP-001). */
  malformedHeaders: MalformedHeaderInfo[];
}

export interface AuditTrailEntry {
  at: string;
  kind: 'created' | 'transition' | 'claim' | 'note' | 'citation' | 'supersession';
  detail: Record<string, unknown>;
}

export interface AuditTrailResult {
  humanId: string;
  history: AuditTrailEntry[];
  supersessionChain?: { supersedes?: string; supersededBy?: string };
}

// ============================================================================
// MIGRATION.md §4.4 — migration-state signal (queried, never hardcoded prose)
// ============================================================================

export type MigrationPhase = 'not-started' | 'phase-1' | 'phase-2' | 'phase-3' | 'phase-4' | 'phase-5' | 'complete';

export interface MigrationStatusResult {
  phase: MigrationPhase;
  /** One-line human-readable meaning of `phase`, e.g. "phase-2: BACKLOG.md is still authoritative; the tool is shadow-running in parity-check mode." */
  description: string;
  /** True once the graph (not hand-edited markdown) is authoritative — phase-3 and later. */
  toolIsAuthoritative: boolean;
}

/** `setMigrationPhase`'s result — `MigrationStatusResult` plus the absolute
 *  path of the GLOBAL `config.yaml` the new phase was persisted to (so a
 *  caller can confirm this was a durable, cross-process write, not merely an
 *  in-memory value). */
export interface SetMigrationPhaseResult extends MigrationStatusResult {
  configPath: string;
}
