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
  /**
   * FEAT-BACKLOG-006 — the symbol this citation is about, if known (e.g. a
   * function/class name). Purely opt-in: supplying it is what enables the
   * best-effort `blastRadius` enrichment below (`store/enrichment.ts`); a
   * citation naming only a file/lines is unaffected.
   */
  symbol?: string;
  /**
   * FEAT-BACKLOG-006 — best-effort blast-radius enrichment, computed at
   * write time by shelling out to `gitnexus impact <symbol>` (bounded
   * timeout, never blocks or fails the write). Absent whenever `symbol` was
   * not given, `gitnexus` is not installed/indexed for this repo, the call
   * timed out, or the symbol was not found — a caller must treat absence as
   * "not enriched," never as "zero blast radius."
   */
  blastRadius?: CitationBlastRadius;
}

/** FEAT-BACKLOG-006 — see `Citation.blastRadius`. */
export interface CitationBlastRadius {
  /** `gitnexus impact`'s own risk bucket; `'UNKNOWN'` when gitnexus returned a value outside its documented vocabulary. */
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  /** Total impacted-symbol count, when gitnexus reported one. */
  impactedCount?: number;
  /** Which direction the blast radius was computed in — upstream (dependants) is the default gitnexus uses. */
  direction?: 'upstream' | 'downstream';
  /** ISO timestamp the enrichment ran at — this is a point-in-time snapshot, not a live value. */
  computedAt: string;
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
  /**
   * FEAT-012 — canonicalised author role, stamped at create time (defaults to
   * `canonicalIdentityKey(by)` when the caller doesn't pass one explicitly —
   * see `client.ts`'s `create()`). Plain metadata only in this build; the
   * `AUTHORED_BY` graph edge (GRAPH_MODEL_v2.md §2.2) is reserved for the
   * identity-node agent (`repo-nodes.ts`).
   */
  author?: string;
  /** FEAT-012 — canonicalised reporter role, defaults to `author` when absent. Same plain-metadata scope as `author`. */
  reporter?: string;
}

// ============================================================================
// Errors (thrown by client.ts / store/*) — the citation/reason gate has teeth
// (SPEC.md §7 DoD clause 6): a transition into a terminal status without the
// required evidence THROWS, it never silently succeeds.
// ============================================================================

/**
 * BUG-BACKLOG-REPO-LOOKUP-UX-001: a `(repo, humanId)` miss is frequently NOT
 * "this item doesn't exist" but "this item exists under a DIFFERENT `repo`
 * string" (e.g. `"adhd"` vs `"PseudoSky/adhd"` both live in the same store
 * for what is logically one project). `foundInRepos` — populated by
 * `store/query.ts`'s `buildNotFoundError` helper, which every throw site now
 * calls instead of constructing this directly — carries the OTHER repo
 * value(s) the humanId actually lives under, so the thrown message names the
 * fix instead of leaving the caller to guess.
 */
export class BacklogItemNotFoundError extends Error {
  constructor(
    repo: string,
    humanId: string,
    public readonly foundInRepos: string[] = []
  ) {
    const hint =
      foundInRepos.length > 0
        ? ` - did you mean repo ${foundInRepos.map((r) => `'${r}'`).join(' or ')}?`
        : '';
    super(`backlog item not found: ${repo}::${humanId}${hint}`);
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

/**
 * BUG-BACKLOG-HUMANID-COLLISION-001 (fix #1 — write-time guard):
 * `createItemNode` rejects a `family` that is missing/empty/whitespace-only
 * UNLESS `idOverride` is also given (SPEC.md §5.1's `CreateItemInput.family`
 * contract: "required unless idOverride given"). Thrown BEFORE
 * `allocateHumanIdAndInsert`/`computeNextHumanId` ever run, so a caller that
 * omits `family` (previously silently coerced to the literal string
 * `"undefined"` by `computeNextHumanId`'s template literal, producing
 * `humanId: "undefined-001"` and colliding with every other item that hit
 * the same bug) now fails loudly instead of minting a collision. This is
 * defense in depth: it must hold regardless of whether an upstream caller's
 * own input-schema validation (e.g. apigen-core-client's extracted
 * `CreateItemInput` schema, BUG-APIGEN-CORE-CLIENT-001) enforces `family` as
 * required — the store's own write path must never trust the caller alone.
 */
export class InvalidArgumentError extends Error {
  constructor(
    public readonly argument: string,
    message: string,
    /**
     * Internal doc/plan reference (e.g. `"EPIC-A / INTERFACE_v2 §7.5"`) kept
     * OUT of `message` and surfaced only in `error.details.internalRef` — a
     * user-facing message should read as English, not leak an internal
     * ticket/section id an external caller cannot look up.
     */
    public readonly internalRef?: string
  ) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * BUG-BACKLOG-HUMANID-COLLISION-001 (fix #2 — read-time guard): every
 * `(repo, humanId)`-keyed lookup used to silently resolve to "whichever
 * live node is found first" when more than one live node shared the same
 * key (the exact shape of the pre-existing `"undefined-001"` collisions,
 * and the root cause of a real mis-transition this session — see the
 * backlog item's body). Any lookup that finds >1 live match now throws this
 * instead of guessing, listing every colliding `nodeId` so a caller can
 * disambiguate (there is no tool-level nodeId-addressed path yet — the
 * caller must go through the store's own repair primitives, e.g.
 * `renameHumanId`, to resolve the collision).
 */
export class AmbiguousHumanIdError extends Error {
  constructor(
    repo: string,
    humanId: string,
    public readonly nodeIds: number[]
  ) {
    super(
      `backlog: ambiguous lookup — ${nodeIds.length} live items share the same (repo, humanId) key ` +
        `"${repo}"::"${humanId}" (nodeIds: ${nodeIds.join(', ')}). Refusing to silently pick one — ` +
        `this is a data-integrity defect (see BUG-BACKLOG-HUMANID-COLLISION-001); repair the collision ` +
        `(e.g. rename one of these nodeIds to a distinct humanId) before retrying this operation.`
    );
    this.name = 'AmbiguousHumanIdError';
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
  /**
   * FEAT-012 — the item's author role. Defaults to `canonicalIdentityKey(by)`
   * when absent (stamped by `client.ts`'s `create()`, which is the only
   * caller with `by` in scope) — TASK-004: previously declared on
   * `ICreateItemInputV2` but never read by `createItemNode`, so a caller
   * passing it got a success response with the value silently discarded.
   */
  author?: string;
  /** FEAT-012 — the item's reporter role. Defaults to `author` when absent. Same TASK-004 fix as `author`. */
  reporter?: string;
  /**
   * Citations to attach at creation time (BUG-BACKLOG-CREATE-ITEM-DROPS-CITATIONS-001).
   * Previously absent from this interface entirely — a caller passing
   * `citations` on create got a success response with the item created and
   * the citations silently discarded (no such field existed to carry them
   * through). Validated the same way as every other citation write path
   * (`Citation.file` non-empty — see `lifecycle.ts`'s `assertValidCitation`)
   * and rejected as a whole (no partial write) before allocation runs.
   */
  citations?: Citation[];
  /**
   * RAG-SPEC.md §2.2 — durability for short-lived processes. Fire-and-forget
   * embedding (the default, `false`) is correct for a long-lived server: the
   * vector lands milliseconds after `createItem` returns. A one-shot CLI
   * process that exits before that promise settles loses the vector
   * permanently even though the item itself is already durably committed —
   * `awaitEmbed: true` makes `createItem` wait for the embed (or its
   * swallowed failure, §2.5 — this never turns a create into a failure) to
   * settle before returning. See also `GraphBacklogStore.flushEmbeds()` and
   * `closeGraphBacklogStore`'s automatic drain — either is an equally valid
   * way to get the same guarantee across a batch of writes without setting
   * this on every single one.
   */
  awaitEmbed?: boolean;
}

export interface CreateItemResult {
  item: BacklogItem;
  created: boolean; // false ⇒ no node written; see duplicateCandidates
  duplicateCandidates: BacklogItem[];
  /**
   * BUG-BACKLOG-REPO-LOOKUP-UX-001: set (soft warning, never blocks the
   * write) when `input.repo` doesn't match any repo value already known to
   * this store — a likely typo/inconsistent-repo-string drift (e.g. filing
   * under `"adhd"` when every existing item uses `"PseudoSky/adhd"`) rather
   * than a genuine first-time-use of a new repo, which is always allowed.
   */
  repoWarning?: string;
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
  /** RAG-SPEC.md §2.2 — see `CreateItemInput.awaitEmbed`'s doc comment; same durability knob, applied to a re-embed on title/body change (§2.3). */
  awaitEmbed?: boolean;
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
  /**
   * Drops items with `metadata.archivedAt` set (BACKLOG-adoption's
   * `archiveResolved` — SPEC.md §5.4). `renderToMarkdown` always applies
   * this internally (a markdown projection never shows archived rows), but
   * `listItems`/`queryItemNodes` do NOT default to it — auditing/reporting
   * consumers legitimately need to see archived items too. A caller that
   * needs to reproduce `renderToMarkdown`'s exact item set through
   * `listItems` (e.g. `render-projections.mjs`/`parity-check.mjs` verifying
   * a rendered projection against the graph's own view of the same filter —
   * BUG-BACKLOG-RENDER-VERIFY-ARCHIVED-MISMATCH-001) must set this
   * explicitly; otherwise the two queries diverge on every archived row.
   */
  excludeArchived?: boolean;
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
  byRepo: Record<string, number>; // single-key when scope.repo is set, full breakdown otherwise (BUG-024)
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
  /** See `CreateItemResult.repoWarning` (BUG-BACKLOG-REPO-LOOKUP-UX-001) — computed once for `input.repo`, not per item. */
  repoWarning?: string;
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

// ============================================================================
// BUG-BACKLOG-REPO-SPLIT-001 / DEBT-BACKLOG-REPO-MOVE-001 — repo migration.
//
// `repo` has no dedicated mutation primitive anywhere in this store (see
// DEBT-BACKLOG-REPO-MOVE-001 Finding 1) and is stored in TWO places that can
// diverge — the graph node's `namespace` column (what every `repo`-scoped
// FILTER/lookup keys on) and `metadata.repo` (what every RENDERED
// `BacklogItem.repo` reads — `mapping.ts`'s `toBacklogItem`) — see Finding 2.
// `planRepoMigration`/`migrateRepo` (`store/repo-migration.ts`) are the
// dedicated primitive: they operate on `namespace` (so a node whose fields
// have already diverged, e.g. `namespace:"adhd"` but `metadata.repo:
// "PseudoSky/adhd"`, is still found and fully repaired — both fields end up
// consistent again), and write BOTH fields atomically per item.
// ============================================================================

/** One item's move within a `RepoMigrationPlan` — always dry-runnable, never mutates on its own. */
export interface RepoMigrationPlanItem {
  nodeId: number;
  /** The humanId this item currently carries in `fromRepo`. */
  humanId: string;
  /**
   * The humanId this item will carry in `toRepo` — identical to `humanId`
   * unless `renamed` is true. Deterministic: preserves the item's `family`
   * prefix and picks the next free number in that family within `toRepo`
   * (mirrors `computeNextHumanId`'s own `max + 1` allocation rule), scanning
   * BOTH `toRepo`'s pre-existing items AND every earlier item in this same
   * plan already assigned a number in that family — so two colliding items
   * sharing a family (e.g. two different `BUG-001`s) never collide with each
   * other's rename target either.
   */
  targetHumanId: string;
  /** True iff `humanId` already exists as a LIVE item in `toRepo` and had to be renamed to avoid an id collision. */
  renamed: boolean;
  title: string;
  status: BacklogStatus;
}

/**
 * The full, deterministic plan for moving every live item out of `fromRepo`
 * into `toRepo` — computed by a pure read-only scan (`planRepoMigration`),
 * safe to call repeatedly and to inspect before ever mutating anything.
 */
export interface RepoMigrationPlan {
  fromRepo: string;
  toRepo: string;
  items: RepoMigrationPlanItem[];
  /** Count of `items` where `renamed === true` — the collision count. */
  collisionCount: number;
}

/** Per-item outcome of actually executing a `RepoMigrationPlan`. Every planned item gets exactly one of these — nothing is ever silently dropped. */
export interface RepoMigrationItemResult {
  nodeId: number;
  fromHumanId: string;
  toHumanId: string;
  renamed: boolean;
  ok: boolean;
  /** Present iff `ok === false` — the item was left untouched in `fromRepo`, never partially moved. */
  error?: string;
}

/**
 * `migrateRepo`'s result. When `dryRun` is true (the default — a caller must
 * pass `dryRun:false` explicitly to mutate anything), `results` is absent and
 * NOTHING was written; `plan` alone previews exactly what would happen.
 */
export interface RepoMigrationResult {
  fromRepo: string;
  toRepo: string;
  dryRun: boolean;
  plan: RepoMigrationPlan;
  /** Present only when `dryRun === false`. One entry per `plan.items` entry, same order. */
  results?: RepoMigrationItemResult[];
  succeeded?: number;
  failed?: number;
}

// ============================================================================
// ██  INTERFACE v2 — the consolidated 6-tool type surface  ██
//
// Everything below this banner is ADDITIVE. Nothing above it changed: the v1
// exports (`BacklogItem`, `BacklogFilter`, `BacklogStats`, `UpdateItemInput`,
// `TopoOrderResult`, …) are still imported by `store/query.ts`,
// `store/crud.ts`, `store/structure.ts`, `client.ts` and `index.ts`'s
// `export * from './model.js'`, and they keep working verbatim. v2 types are
// `I`-prefixed per the repo AGENTS.md §9 naming rule and live here so the
// ~20 work orders of `docs/plan/backlog-interface-v2-dispatch/DISPATCH.md`
// bind to ONE contract instead of each inventing their own.
//
// Authority: `docs/spec/backlog/INTERFACE_v2.md` (the sections cited per type)
// and `docs/spec/backlog/GRAPH_MODEL_v2.md`.
// ============================================================================

// ----------------------------------------------------------------------------
// §7.1 — the response envelope. Every tool returns one of these.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §7.1 — the CLOSED set of envelope error codes.
 *
 * Defends AC-6: `item_not_found` and `internal` are DISTINCT members, so the
 * "single item missing" outcome can never collide with "the server blew up"
 * even though both map to CLI exit code 1 (§7.2). A caller distinguishes them
 * by `error.code`, never by exit status alone.
 *
 * Also defends DEBT-BACKLOG-API-RETURN-VALUES-001 / backlog-001: a mutation
 * that cannot report an outcome must report an ERROR from this union — a bare
 * `null`/`void` "success" is not expressible in `IOutcomeEnvelope`.
 */
export const BACKLOG_ERROR_CODES = [
  /** Unknown command / unresolvable identifier that is NOT a single-item lookup. Exit 4. */
  'not_found',
  /** Single-item lookup miss (`backlog_get`). Distinct from `not_found`. Exit 1. AC-6. */
  'item_not_found',
  /** >1 live node shares a `(repo, humanId)` key — `AmbiguousHumanIdError`. */
  'ambiguous',
  /** Bad flag / bad parameter shape. Exit 2. */
  'invalid_argument',
  /** Schema rejection: unknown filter key, unknown projection field, over-MAX_LIMIT. Exit 2. AC-19/AC-23. */
  'validation',
  /** Filing-time interception fired: near-duplicates found, nothing written (§3, FEAT-013). */
  'duplicate_candidate',
  /** The write was suppressed by the dedupe gate (BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001). */
  'dedupe_suppressed',
  /** Legal request the current build cannot serve (e.g. `patch.repo` before EPIC-A). Exit 2. */
  'unsupported',
  /** SQLITE_BUSY / lease contention. `details.retryable === true` + `retryAfterMs`. */
  'store_busy',
  /** The addressed item is soft-deleted (BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001). */
  'soft_deleted',
  /** `semantic`/`anchor`/`view:similar`/`sort:relevance` with no embedding backend (AC-12). */
  'rag_not_configured',
  /** CAS/lease conflict — someone else holds the claim (`ClaimHeldError`). */
  'conflict',
  /** A gate refused: missing citation/reason on a terminal transition, dependency cycle (§5a.2). */
  'precondition_failed',
  /** Unexpected server-side failure. Exit 1, and NEVER the same code as `item_not_found`. AC-6. */
  'internal',
] as const;

/** INTERFACE_v2 §7.1 — closed union of envelope error codes. See `BACKLOG_ERROR_CODES`. */
export type BacklogErrorCode = (typeof BACKLOG_ERROR_CODES)[number];

const BACKLOG_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(BACKLOG_ERROR_CODES);

/**
 * Runtime membership test for the closed error-code union (INTERFACE_v2 §7.1).
 * The union is only "closed" if something checks it at runtime — a transport
 * that hand-builds an envelope with a typo'd code would otherwise ship an
 * error an agent cannot switch on.
 */
export function isBacklogErrorCode(value: unknown): value is BacklogErrorCode {
  return typeof value === 'string' && BACKLOG_ERROR_CODE_SET.has(value);
}

/**
 * INTERFACE_v2 §7.2 — code → CLI process exit code.
 *
 * Verified against `packages/apigen/apigen-base-errors/src/lib/errors.ts:57-63`
 * (`CLI_EXIT_CODE`: `invalid_argument: 2, not_found: 4, internal: 1`); the v2
 * codes extend that table without remapping any of it. AC-6's four cases are
 * the load-bearing rows: `item_not_found`→1, `not_found`→4,
 * `invalid_argument`→2, `internal`→1.
 */
export const BACKLOG_EXIT_CODE: Readonly<Record<BacklogErrorCode, number>> = {
  not_found: 4,
  item_not_found: 1,
  ambiguous: 1,
  invalid_argument: 2,
  validation: 2,
  duplicate_candidate: 1,
  dedupe_suppressed: 1,
  unsupported: 2,
  store_busy: 1,
  soft_deleted: 1,
  rag_not_configured: 1,
  conflict: 1,
  precondition_failed: 1,
  internal: 1,
} as const;

/**
 * INTERFACE_v2 §7.1 — `error.details`. `retryable`/`retryAfterMs` exist so an
 * agent knows whether to retry a `store_busy` and with what backoff instead of
 * hot-looping. Open-ended beyond those two: individual codes attach their own
 * evidence (`nodeIds` for `ambiguous`, `keys` for `validation`, …).
 */
export interface IOutcomeErrorDetails {
  /** True only for transient codes (today: `store_busy`). */
  retryable?: boolean;
  /** Suggested backoff in milliseconds; only meaningful when `retryable`. */
  retryAfterMs?: number;
  /**
   * Internal doc/plan reference for an `invalid_argument` whose underlying
   * reason cites internal terminology (a plan id, a spec section) that does
   * not belong in the user-facing `message` — see `InvalidArgumentError`'s
   * own `internalRef` param. Absent on every other error code.
   */
  internalRef?: string;
  [key: string]: unknown;
}

/** INTERFACE_v2 §7.1 — the error arm's payload. */
export interface IOutcomeError {
  code: BacklogErrorCode;
  message: string;
  details?: IOutcomeErrorDetails;
}

/**
 * INTERFACE_v2 §7.4 / AC-25 — pagination truth carried beside the data.
 * `total` is the count BEFORE `limit`/`offset`; `returned` is `data.length`.
 * BUG-BACKLOG-003: a silently-truncated list is indistinguishable from a
 * complete one unless the envelope says how many there really were.
 */
export interface IQueryEnvelopeMeta {
  /** Matching rows before limit/offset. AC-25 asserts this is the TRUE count. */
  total: number;
  /** Rows actually in `data`. */
  returned: number;
  limit?: number;
  offset?: number;
  /**
   * Set when the result set was cut short by anything other than the caller's
   * own `limit` (e.g. the documented grep full-fetch-then-slice budget, §7.4).
   * BUG-BACKLOG-003 forbids a silent cap — if it happens, it is stated here.
   */
  truncated?: boolean;
}

/** INTERFACE_v2 §7.1 — the success arm. `data` is always present (never `null` as a stand-in for "missing"). */
export interface IOutcomeSuccess<T> {
  ok: true;
  data: T;
  /**
   * §7.1 / AC-24 / GRAPH_MODEL §3: non-fatal ambiguity surfaced at resolution
   * time (a bare repo name matching several repo nodes). A read NEVER silently
   * narrows — it either warns here or fails with `ambiguous`.
   */
  warnings?: string[];
  /** §7.4 — present on list-shaped reads. */
  meta?: IQueryEnvelopeMeta;
}

/** INTERFACE_v2 §7.1 — the failure arm. There is no `data` on this arm at all. */
export interface IOutcomeFailure {
  ok: false;
  error: IOutcomeError;
  warnings?: string[];
}

/**
 * INTERFACE_v2 §7.1 + AC-6 — THE response envelope for all six v2 tools.
 *
 * Defends DEBT-BACKLOG-API-RETURN-VALUES-001, backlog-001 and BUG-025: a
 * `void`/`null` return is rendered by apigen as `{"result": null}` for BOTH
 * success and failure, which makes the write unverifiable. The union has no
 * arm that can express that: success carries `data`, failure carries `error`,
 * and `ok` discriminates them.
 *
 * It is a discriminated union rather than `{ ok, data?, error? }` on purpose —
 * `{ ok: true, data: null }` for a missing item (the exact shape AC-6 forbids)
 * is not assignable when `T` is a real item type.
 */
export type IOutcomeEnvelope<T> = IOutcomeSuccess<T> | IOutcomeFailure;

/** Narrow an envelope to its success arm (INTERFACE_v2 §7.1). */
export function isOutcomeOk<T>(env: IOutcomeEnvelope<T>): env is IOutcomeSuccess<T> {
  return env.ok === true;
}

/**
 * Narrow an envelope to its failure arm (INTERFACE_v2 §7.1).
 *
 * This is the predicate every CLI/MCP/REST host branches on, so it is
 * deliberately structural (`ok === false` AND a well-formed `error`) — a
 * malformed half-envelope is neither ok nor a usable error, and callers must
 * not treat it as success by accident.
 */
export function isOutcomeError<T>(env: IOutcomeEnvelope<T>): env is IOutcomeFailure {
  return env.ok === false && typeof env.error === 'object' && env.error !== null && isBacklogErrorCode(env.error.code);
}

/** Build a success envelope (INTERFACE_v2 §7.1). */
export function okEnvelope<T>(data: T, extra?: { warnings?: string[]; meta?: IQueryEnvelopeMeta }): IOutcomeSuccess<T> {
  const env: IOutcomeSuccess<T> = { ok: true, data };
  if (extra?.warnings && extra.warnings.length > 0) env.warnings = extra.warnings;
  if (extra?.meta) env.meta = extra.meta;
  return env;
}

/** Build a failure envelope (INTERFACE_v2 §7.1). `store_busy` is stamped retryable by default. */
export function errorEnvelope(code: BacklogErrorCode, message: string, details?: IOutcomeErrorDetails): IOutcomeFailure {
  const error: IOutcomeError = { code, message };
  const merged: IOutcomeErrorDetails = { ...(details ?? {}) };
  if (code === 'store_busy' && merged.retryable === undefined) merged.retryable = true;
  if (Object.keys(merged).length > 0) error.details = merged;
  return { ok: false, error };
}

/** INTERFACE_v2 §7.2 — the process exit code a CLI host must use for an envelope. Success is always 0. */
export function exitCodeForEnvelope<T>(env: IOutcomeEnvelope<T>): number {
  return env.ok ? 0 : BACKLOG_EXIT_CODE[env.error.code];
}

/**
 * Structural guard for a value that came back from a transport, where the
 * static type is erased. Recognises BOTH arms: `{ok:true,…}` and
 * `{ok:false, error:{code,…}}`.
 *
 * Used by the CLI's `options.exitCode` hook — a non-envelope result (a
 * `--use` mount, a plugin's own synthetic op) must fall through to apigen's
 * default exit-0-on-return, never be mapped by this table.
 */
export function isOutcomeEnvelope(value: unknown): value is IOutcomeEnvelope<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['ok'] !== 'boolean') return false;
  if (v['ok']) return true;
  const err = v['error'];
  if (err === null || typeof err !== 'object') return false;
  const code = (err as Record<string, unknown>)['code'];
  return typeof code === 'string' && code in BACKLOG_EXIT_CODE;
}

// ----------------------------------------------------------------------------
// v2 error classes — the throw-side counterparts of the codes that had none.
// (The v1 classes above — BacklogItemNotFoundError, AmbiguousHumanIdError,
// CitationRequiredError, ReasonRequiredError, ClaimHeldError,
// DependencyCycleError, InvalidArgumentError — are unchanged and still the
// canonical throw sites; `toOutcomeError` maps every one of them.)
// ----------------------------------------------------------------------------

/** INTERFACE_v2 §7.8 / AC-19 / AC-23 — schema rejection (unknown filter key, unknown field, over-limit). Exit 2. */
export class BacklogValidationError extends Error {
  constructor(
    message: string,
    /** The offending keys/fields, named so the message is actionable rather than "invalid input". */
    public readonly keys: string[] = []
  ) {
    super(message);
    this.name = 'BacklogValidationError';
  }
}

/** INTERFACE_v2 §4 — a legal request this build cannot serve yet (e.g. `patch.repo` before EPIC-A lands). */
export class UnsupportedOperationError extends Error {
  constructor(
    public readonly operation: string,
    message: string
  ) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

/** INTERFACE_v2 AC-12 — `semantic`/`anchor`/`view:similar`/`sort:relevance` with no embedding backend configured. */
export class RagNotConfiguredError extends Error {
  constructor(feature: string) {
    super(
      `backlog: "${feature}" needs a configured embedding backend and none is available. ` +
        `Keyword (\`grep\`) and dimensional queries still work — see INTERFACE_v2 AC-12.`
    );
    this.name = 'RagNotConfiguredError';
  }
}

/** INTERFACE_v2 §1 / BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — the addressed item exists but is soft-deleted. */
export class SoftDeletedItemError extends Error {
  constructor(
    repo: string,
    public readonly humanId: string,
    public readonly deletedAt?: string
  ) {
    super(`backlog item ${repo}::${humanId} is soft-deleted${deletedAt ? ` (at ${deletedAt})` : ''}`);
    this.name = 'SoftDeletedItemError';
  }
}

/** INTERFACE_v2 §7.1 — transient store contention. Carries the backoff the envelope will surface as `retryAfterMs`. */
export class StoreBusyError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs = 50
  ) {
    super(message);
    this.name = 'StoreBusyError';
  }
}

/**
 * INTERFACE_v2 §3 — a `create` was intercepted by the dedupe scan and NOTHING was
 * written. Carries the candidate cards so the caller can pick one or re-issue with
 * `action: 'file'` (force). Thrown rather than returned so it takes the same
 * `toOutcomeError` path as every other typed failure.
 */
export class DuplicateCandidateError extends Error {
  constructor(
    title: string,
    public readonly candidates: readonly IDuplicateCandidate[]
  ) {
    super(
      `create intercepted: ${candidates.length} possible duplicate${candidates.length === 1 ? '' : 's'} of "${title}" — resolve one, or re-issue with action:'file' to force`
    );
    this.name = 'DuplicateCandidateError';
  }
}

/**
 * Map any thrown value onto the closed envelope error set (INTERFACE_v2 §7.1).
 *
 * This is the single place the `item_not_found` / `internal` distinction AC-6
 * demands is actually made. Without it every host re-derives the mapping and
 * one of them inevitably collapses "item missing" into the catch-all — which
 * is precisely the collision AC-6 says must be impossible.
 */
export function toOutcomeError(err: unknown): IOutcomeError {
  if (err instanceof BacklogItemNotFoundError) {
    return { code: 'item_not_found', message: err.message, details: { foundInRepos: err.foundInRepos } };
  }
  if (err instanceof AmbiguousHumanIdError) {
    return { code: 'ambiguous', message: err.message, details: { nodeIds: err.nodeIds } };
  }
  if (err instanceof SoftDeletedItemError) {
    return { code: 'soft_deleted', message: err.message, details: { humanId: err.humanId } };
  }
  if (err instanceof CitationRequiredError || err instanceof ReasonRequiredError) {
    return { code: 'precondition_failed', message: err.message };
  }
  if (err instanceof DependencyCycleError) {
    return { code: 'precondition_failed', message: err.message, details: { cycle: err.cycle } };
  }
  if (err instanceof ClaimHeldError) {
    return { code: 'conflict', message: err.message, details: { heldBy: err.heldBy, heldSince: err.heldSince } };
  }
  if (err instanceof BacklogValidationError) {
    return { code: 'validation', message: err.message, details: { keys: err.keys } };
  }
  if (err instanceof InvalidArgumentError) {
    return {
      code: 'invalid_argument',
      message: err.message,
      details: { argument: err.argument, ...(err.internalRef !== undefined ? { internalRef: err.internalRef } : {}) },
    };
  }
  if (err instanceof UnsupportedOperationError) {
    return { code: 'unsupported', message: err.message, details: { operation: err.operation } };
  }
  if (err instanceof RagNotConfiguredError) {
    return { code: 'rag_not_configured', message: err.message };
  }
  if (err instanceof DuplicateCandidateError) {
    return { code: 'duplicate_candidate', message: err.message, details: { candidates: err.candidates } };
  }
  if (err instanceof StoreBusyError) {
    return { code: 'store_busy', message: err.message, details: { retryable: true, retryAfterMs: err.retryAfterMs } };
  }
  const message = err instanceof Error ? err.message : String(err);
  // The store surfaces raw driver contention as a SQLITE_BUSY-bearing Error
  // (see store/busy-retry.spec.ts) — classify it as retryable rather than
  // burying a transient lock behind `internal`, which an agent will not retry.
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return { code: 'store_busy', message, details: { retryable: true, retryAfterMs: 50 } };
  }
  return { code: 'internal', message };
}

// ----------------------------------------------------------------------------
// §2.1 — status selection. ONE closedness knob, and an explicit list is a
// DIFFERENT thing from it.
// ----------------------------------------------------------------------------

/** Every `BacklogStatus`, as an ordered array (the type union's runtime twin). */
export const BACKLOG_STATUSES: readonly BacklogStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'PARTIAL',
  'OUTSTANDING',
  'DEFERRED',
  'BLOCKED',
  'MIXED',
  'UNKNOWN',
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
] as const;

const BACKLOG_STATUS_SET: ReadonlySet<string> = new Set<string>(BACKLOG_STATUSES);

/** Runtime membership test for `BacklogStatus` (case-sensitive — `'open'` is NOT `'OPEN'`, see `IStatusSelector`). */
export function isBacklogStatus(value: unknown): value is BacklogStatus {
  return typeof value === 'string' && BACKLOG_STATUS_SET.has(value);
}

/**
 * INTERFACE_v2 §2 "One closedness knob" — the lifecycle-phase selector.
 * `open` = every non-terminal status, `closed` = every terminal status,
 * `all` = no status restriction. There is no `includeClosed`; the two-knob
 * composition (`{status:"closed", includeClosed:true}`) is abolished.
 */
export type IStatusClosedness = 'open' | 'closed' | 'all';

/**
 * INTERFACE_v2 §2 — `filter.status` accepts EITHER a closedness word
 * (lowercase `open`/`closed`/`all`) OR one/many concrete `BacklogStatus`
 * values (uppercase). The two spellings never collide because the vocabularies
 * are case-disjoint (`'open'` the closedness word vs `'OPEN'` the status).
 *
 * v1's `BacklogFilter.status` (model.ts:311) could only express
 * `BacklogStatus | 'open' | 'closed'` — a single status, no list, no `all`.
 * Callers wanting "IN_PROGRESS or BLOCKED" had to run two queries and union
 * them client-side, which silently broke `limit` (each query got the full
 * limit). The array arm closes that.
 */
export type IStatusSelector = IStatusClosedness | BacklogStatus | readonly BacklogStatus[];

/** The disambiguated form of an `IStatusSelector` — see `resolveStatusSelector`. */
export type IResolvedStatusSelector =
  | { mode: 'closedness'; closedness: IStatusClosedness }
  | { mode: 'explicit'; statuses: BacklogStatus[] };

/**
 * INTERFACE_v2 §2 — turn an `IStatusSelector` into the tagged form a query
 * planner can branch on, so `"open"` (a derived non-terminal predicate) is
 * never confused with an explicit status list.
 *
 * Defends the BUG-BACKLOG-003 filter-composition class: `open`/`closed` are
 * predicates that must be pushed DOWN into the store query (they are computed
 * from `TERMINAL_STATUSES`), whereas an explicit list is a plain
 * `status IN (...)`. Today `store/query.ts:39-43` applies open/closed as a JS
 * post-filter AFTER limit/offset, which is exactly why `{status:"open",
 * limit:145}` returns fewer than 145. Tagging the two modes apart is the
 * precondition for fixing that without breaking the explicit-list path.
 *
 * @param selector the caller's `filter.status`, or `undefined`
 * @returns `{ mode: 'closedness', closedness: 'open' }` when absent (§2 default)
 * @throws {InvalidArgumentError} on an empty array or an unknown status string
 */
export function resolveStatusSelector(selector: IStatusSelector | undefined): IResolvedStatusSelector {
  if (selector === undefined) return { mode: 'closedness', closedness: 'open' };
  if (Array.isArray(selector)) {
    const list = selector as readonly BacklogStatus[];
    if (list.length === 0) {
      throw new InvalidArgumentError('status', 'filter.status: an explicit status list must not be empty (use "all" to drop the restriction)');
    }
    const bad = list.filter((s) => !isBacklogStatus(s));
    if (bad.length > 0) {
      throw new InvalidArgumentError('status', `filter.status: unknown status value(s) ${bad.map((s) => JSON.stringify(s)).join(', ')}`);
    }
    return { mode: 'explicit', statuses: [...list] };
  }
  if (selector === 'open' || selector === 'closed' || selector === 'all') {
    return { mode: 'closedness', closedness: selector };
  }
  if (isBacklogStatus(selector)) return { mode: 'explicit', statuses: [selector] };
  throw new InvalidArgumentError(
    'status',
    `filter.status: ${JSON.stringify(selector)} is neither a closedness word ("open"|"closed"|"all") nor a BacklogStatus`
  );
}

/** INTERFACE_v2 §2.1 — one time-boundary bound. ISO 8601 strings; CLI sugar (`today`/`yesterday`/`Nd`) is compiled server-side. */
export interface IDateBound {
  since?: string;
  until?: string;
}

/**
 * INTERFACE_v2 §2.1 / §7.7 — THE one time-boundary grammar for the whole
 * surface. `view:"plan"` deltas read `dateRange.updated`;
 * `view:"summary"` windows read `dateRange.updated` too, with ONE explicit
 * override: the summary-only top-level `window` param
 * (FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001) composes per-bound over
 * `dateRange.updated`, so an arbitrary historical window is expressible
 * without a list-view filter.
 *
 * Mechanism (spec-owned, not implied): `created` maps to the existing
 * `NodeFilter.tCreatedAfter/tCreatedBefore`; `updated` needs
 * `tUpdatedAfter/tUpdatedBefore` upstream (EPIC-F) or the documented raw-SQL
 * `t_updated` range predicate until it lands.
 */
export interface IDateRangeFilter {
  created?: IDateBound;
  updated?: IDateBound;
}

// ----------------------------------------------------------------------------
// §2.1 — IBacklogFilter (v2). Verified field-by-field against the shipped
// `BacklogFilter` at model.ts:309.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §2.1 — the v2 filter contract.
 *
 * Every shipped v1 `BacklogFilter` field (model.ts:309-368) is carried over
 * with the same meaning, so `IBacklogFilter` is a structural superset: a v1
 * filter value is a valid `IBacklogFilter` EXCEPT that `status` widens (see
 * `IStatusSelector`) and `limit`/`offset` move to the query input where they
 * belong. The additions are the fields the "lands with" table assigns to each
 * epic — declared here up front because `model.ts` has a single owner for this
 * program and the consuming work orders may not edit it.
 *
 * Bugs this shape defends:
 * - BUG-BACKLOG-003 — `status` is a tagged selector (`resolveStatusSelector`)
 *   so open/closed can be pushed down instead of post-filtered after `limit`.
 * - BUG-023 — nothing here is closedness-implicit: a caller that wants
 *   all-status counts must say `status: 'all'`.
 * - AC-7 — `repo` is resolved through the repo node's alias set
 *   (`resolveRepositoryNode`), so items filed under `PseudoSky/adhd` are
 *   returned by `repo: "adhd"` instead of vanishing.
 *
 * §7.8: this schema is validated with `additionalProperties: false` — an
 * unknown key is a `validation` error (exit 2), never a silent no-op. Use
 * `unknownFilterKeys` / `assertKnownFilterKeys` to enforce it.
 */
export interface IBacklogFilter {
  // ---- shipped in v1 (model.ts:309-368) -----------------------------------
  /** Repo key. Resolved through the canonical repo node's alias set — AC-7. */
  repo?: string;
  /** Package-relative path within the repo, e.g. `packages/apigen/apigen-core-client`. */
  projectPath?: string;
  /** §2 "one closedness knob". Default `'open'`. See `IStatusSelector`/`resolveStatusSelector`. */
  status?: IStatusSelector;
  /** First hyphen segment of the humanId, e.g. `BUG`. Open vocabulary. */
  kind?: string;
  /** humanId minus the trailing `-NNN`, e.g. `BUG-APIGEN`. */
  family?: string;
  priority?: Priority | readonly Priority[];
  /** Plan slug (`attachToPlan`). §5a.5: the plan parent is itself an item, so this is a filter, not a type. */
  plan?: string;
  /** Durable ownership. */
  assignee?: string;
  /** Ephemeral claim lease holder. §2.1.1: claim identity is per-instance and is NEVER canonicalized. */
  claimedBy?: string;
  tags?: readonly string[];
  /** FTS keyword query over title+body. §7.6: STAYS keyword-only forever — it never becomes hybrid (AC-11). */
  grep?: string;
  /** Exact match on the owning source path (DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001). */
  importedFrom?: string;
  /** Repo-root projection: items with NEITHER `projectPath` NOR `plan` (MIGRATION.md §2.2). */
  rootLevel?: boolean;
  /** Drop items carrying `metadata.archivedAt` (BUG-BACKLOG-RENDER-VERIFY-ARCHIVED-MISMATCH-001). */
  excludeArchived?: boolean;

  // ---- EPIC-A / FEAT-012 — dimensional axes (GRAPH_MODEL §6) --------------
  /** Item author. Resolved via `canonicalIdentityKey`, so `researcher:a1` and `researcher:b2` both match `"researcher"` (AC-14). */
  author?: string;
  /** Item reporter — the role that makes aggregate-by-reporter first class (FEAT-012). */
  reporter?: string;
  /** Project key (repo → project edge, `PROJECT_OF`). */
  project?: string;
  /** Package path as a dimension node (`IN_PACKAGE`), distinct from the `projectPath` metadata scalar. */
  packagePath?: string;

  // ---- EPIC-B / query layer ----------------------------------------------
  /** §2.1/§7.7 — the ONE time-boundary grammar. */
  dateRange?: IDateRangeFilter;

  // ---- EPIC-C / FEAT-013 + §5a.7 -----------------------------------------
  /** FEAT-013 demand signal: items re-filed at least N times. Pairs with `sort: "demand"`. */
  dupeHitsMin?: number;
  /** §5a.3 — declared file paths; the `view:"overlap"` / `groupBy:"file"` axis. The tool never reads the filesystem. */
  files?: readonly string[];
  /** §5a.7 — items whose body carries a recognized criteria section or `metadata.criteria`. Presence only; clause content is never parsed. */
  hasAcceptanceCriteria?: boolean;
  /** §5a.7 — the complement of `hasAcceptanceCriteria`. */
  missingAcceptanceCriteria?: boolean;
  /** §5a.7 — items with zero citations: the read-side mirror of the §5a.2 evidence gate. */
  missingCitation?: boolean;

  // ---- EPIC-G / semantic seam --------------------------------------------
  /** §7.6 — free-text routed to the embedding matcher. Composes with `grep`; neither swallows the other (AC-11). */
  semantic?: string;
  /** §2.1 — item-anchored similarity: nearest neighbours to THIS item's vector ("what's like BUG-42"). */
  anchor?: string;

  // ---- RAG-SPEC §5 / AC-30 — plan-graph intelligence ---------------------
  /**
   * RAG-SPEC §5 / INTERFACE_v2 AC-30 — the target item for `view:"order"`'s
   * `blockerImpact` composition: "how much work does resolving THIS item
   * unblock". Deliberately NOT a general item-identity filter (that is
   * `backlog_get`'s job, §7.5's GET_ONLY_KEYS trap) — it exists solely to
   * seed the one `view:"order"` traversal that needs a starting node, which
   * is why `VIEW_FILTER_KEYS.order` is the only view that accepts it.
   */
  humanId?: string;
}

/**
 * Every accepted `IBacklogFilter` key. INTERFACE_v2 §7.8 requires
 * `additionalProperties: false`, and a closed schema is only closed if
 * something enumerates it at runtime.
 */
export const BACKLOG_FILTER_KEYS = [
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
  'humanId',
] as const satisfies readonly (keyof IBacklogFilter)[];

/**
 * Compile-time exhaustiveness: if someone adds a field to `IBacklogFilter`
 * and forgets `BACKLOG_FILTER_KEYS`, this alias resolves to a non-`never`
 * type and the build fails. Without it the closed schema silently develops a
 * hole and the new field is rejected as "unknown" at runtime.
 */
type _FilterKeysAreExhaustive = [Exclude<keyof IBacklogFilter, (typeof BACKLOG_FILTER_KEYS)[number]>] extends [never]
  ? true
  : ['IBacklogFilter key missing from BACKLOG_FILTER_KEYS', Exclude<keyof IBacklogFilter, (typeof BACKLOG_FILTER_KEYS)[number]>];
const _filterKeysAreExhaustive: _FilterKeysAreExhaustive = true;
void _filterKeysAreExhaustive;

/** Top-level query parameters that agents most often mis-nest INSIDE `--filter` (INTERFACE_v2 §2.1a, AC-23). */
export const MISNESTED_FILTER_KEYS: readonly string[] = ['view', 'sort', 'groupBy', 'group_by', 'fields', 'format', 'limit', 'offset', 'humanIds', 'overlapBy', 'text'];

/** The result of checking a caller-supplied filter object against the closed schema (INTERFACE_v2 §7.8). */
export interface IFilterKeyCheck {
  /** Keys that are not in `BACKLOG_FILTER_KEYS` at all. */
  unknown: string[];
  /** The subset of `unknown` that are really top-level params put in the wrong place — AC-23 wants these named specifically. */
  misnested: string[];
}

/** Classify a caller-supplied filter object's keys (INTERFACE_v2 §7.8 / AC-23). Pure — never throws. */
export function unknownFilterKeys(filter: Record<string, unknown>): IFilterKeyCheck {
  const known: ReadonlySet<string> = new Set<string>(BACKLOG_FILTER_KEYS);
  const misnestedSet: ReadonlySet<string> = new Set(MISNESTED_FILTER_KEYS);
  const unknown = Object.keys(filter ?? {}).filter((k) => !known.has(k));
  return { unknown, misnested: unknown.filter((k) => misnestedSet.has(k)) };
}

/**
 * INTERFACE_v2 §7.8 + AC-23 — reject an unknown filter key instead of ignoring
 * it. `--filter '{"view":"list"}'` is the single most common agent error and
 * today it is a silent no-op that returns plausible-looking wrong data; this
 * turns it into a targeted `invalid_argument` that NAMES the stray keys.
 *
 * @throws {InvalidArgumentError} when the stray keys are mis-nested top-level params (AC-23, exit 2)
 * @throws {BacklogValidationError} for any other unknown key (`validation`, exit 2)
 */
export function assertKnownFilterKeys(filter: Record<string, unknown>): void {
  const { unknown, misnested } = unknownFilterKeys(filter);
  if (unknown.length === 0) return;
  if (misnested.length > 0) {
    throw new InvalidArgumentError(
      'filter',
      `filter: ${misnested.map((k) => `"${k}"`).join(', ')} ${misnested.length === 1 ? 'is a top-level parameter' : 'are top-level parameters'}, not filter key(s) — ` +
        `pass ${misnested.map((k) => `--${k}`).join(' / ')} outside --filter (INTERFACE_v2 §2.1a)`
    );
  }
  throw new BacklogValidationError(`filter: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}`, unknown);
}

/** DEBT-010 — the closed top-level key set for `backlog_update` (INTERFACE_v2 §7.8, mirroring `BACKLOG_FILTER_KEYS`). */
export const BACKLOG_UPDATE_INPUT_KEYS = [
  'humanId',
  'repo',
  'by',
  'patch',
  'status',
  'priority',
  'statusEvidence',
  'claim',
  'claimOpts',
  'assignedTo',
  'addNote',
  'addCitation',
  'softDeleteReason',
] as const;

/**
 * DEBT-010 — reject an unknown top-level `backlog_update` key instead of
 * silently absorbing it (the "declared-but-unwired field" failure mode that
 * `citations`/`reason` were). A caller typo (`citations` instead of
 * `statusEvidence`, or `stauts` instead of `status`) now fails loud. The
 * retired top-level `citations`/`reason` get a TARGETED error naming their
 * replacement (`statusEvidence`), not the generic unknown-key message.
 *
 * @throws {InvalidArgumentError} for the retired `citations`/`reason` fields (naming `statusEvidence`)
 * @throws {BacklogValidationError} for any other key outside {@link BACKLOG_UPDATE_INPUT_KEYS}
 */
export function assertKnownUpdateKeys(input: Record<string, unknown>): void {
  const RENAMED: Readonly<Record<string, string>> = {
    citations: 'statusEvidence',
    reason: 'statusEvidence',
  };
  for (const key of Object.keys(input ?? {})) {
    if (key in RENAMED) {
      throw new InvalidArgumentError(
        key,
        `backlog_update: "${key}" is no longer a top-level field — pass "statusEvidence" (with "status") instead.`,
      );
    }
  }
  const known: ReadonlySet<string> = new Set<string>(BACKLOG_UPDATE_INPUT_KEYS);
  const unknown = Object.keys(input ?? {}).filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  throw new BacklogValidationError(
    `backlog_update: unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}`,
    unknown,
  );
}

// ----------------------------------------------------------------------------
// §2.2 / §2.3 / §2.4 — views, sorts, projection.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §2.2 — the `backlog_query` view union.
 *
 * `order` is the RENAME of v1 `topo` (same computation — "topo" means nothing
 * to a new reader), and there is deliberately NO `spotlight`: `view:"list"`
 * with the default sort IS today's spotlight semantics (§2.2), so a separate
 * verb would be a second spelling of one behaviour.
 */
export const BACKLOG_VIEWS = [
  /** Terse cards, priority-sorted, non-terminal by default. Absorbs `list-items` AND `spotlight`. */
  'list',
  /** Claimable now: unblocked, non-terminal, unclaimed. Absorbs `ready-items`. */
  'ready',
  /** Topological order + wave numbers. RENAME of v1 `topo` — absorbs `topo-order`. */
  'order',
  /** Dependency edges. Absorbs `dependency-graph`. */
  'graph',
  /** Claims older than the lease window. Absorbs `stale-claims` — a read, not an admin action. */
  'stale',
  /** FEAT-010 aggregate/export over transition history. Absorbs v1 `admin:stats`. */
  'summary',
  /** FEAT-007 `groupBy`-keyed buckets. */
  'grouped',
  /** FEAT-011 top-k similar items + score + overlap reason. */
  'similar',
  /** FEAT-015 the native resume surface (rollup + ready + blocked + delta + myClaims + asOf). */
  'plan',
  /** FEAT-005 Stage 3 pairwise overlap over a supplied humanId set. */
  'overlap',
] as const;

/** INTERFACE_v2 §2.2 — see `BACKLOG_VIEWS`. */
export type IBacklogView = (typeof BACKLOG_VIEWS)[number];

/** Runtime membership test for `IBacklogView` — an unknown `--view` must be `invalid_argument`, never a silent fallback to `list`. */
export function isBacklogView(value: unknown): value is IBacklogView {
  return typeof value === 'string' && (BACKLOG_VIEWS as readonly string[]).includes(value);
}

/**
 * INTERFACE_v2 §2.3 — ranking.
 *
 * `demand` (FEAT-013) is the weighted dupe-counter score: an item re-filed 5
 * times outranks one filed once. It is the automatic-prioritisation surface,
 * and AC-17's negative control pins the dupe counter as the DOMINANT term
 * rather than an incidental tiebreak. `relevance` is the EPIC-G embedding hook
 * (rejected with `rag_not_configured` until an embedding backend exists —
 * `assertNoSemanticInputs`). `textMatch` is the FTS5 keyword-relevance score a
 * `text` query's `filter.grep` fallback already computes (BM25-derived,
 * `@adhd/sox-graph-store`'s `searchNodes`) — it is a REAL, already-available
 * ranking signal, unlike `relevance`, so a `text` query defaults to it instead
 * of degrading to `priority` (which discarded match quality entirely and
 * ranked by triage priority instead — not what "search for X" means).
 *
 * `impact` (RAG-SPEC §5 `recommendNextWork`) ranks by critical-path position
 * FIRST, then `blockerImpact` cone size, then priority — pure `DEPENDS_ON`
 * graph traversal, no embedding dependency, so (like `criticalPath`/
 * `blockerImpact`) it works with zero backend configured. It is meaningful
 * ONLY on `view:"ready"` (the population it ranks is exactly "claimable
 * right now"); every other view rejects it rather than silently falling
 * back to an unranked order.
 */
export const BACKLOG_SORTS = ['priority', 'updated', 'created', 'demand', 'relevance', 'textMatch', 'impact'] as const;

/** INTERFACE_v2 §2.3 — see `BACKLOG_SORTS`. */
export type IBacklogSort = (typeof BACKLOG_SORTS)[number];

/** Runtime membership test for `IBacklogSort`. */
export function isBacklogSort(value: unknown): value is IBacklogSort {
  return typeof value === 'string' && (BACKLOG_SORTS as readonly string[]).includes(value);
}

/** Sort direction. `priority` defaults to ascending rank (CRITICAL first); recency sorts default to descending. */
export type ISortDirection = 'asc' | 'desc';

/**
 * INTERFACE_v2 §2.4 / §7.3 — the ONE projection vocabulary, shared by
 * `backlog_get` and `backlog_query`.
 *
 * Defends the context-blow named in §0.2: 36 items = 90KB of full bodies, and
 * the tool's own default is what caused it. Bodies and embedding blobs are
 * opt-in, never default (AC-18/AC-20).
 */
export const BACKLOG_FIELDS = [
  // plain item fields
  'humanId',
  'kind',
  'title',
  'status',
  'priority',
  'repo',
  'family',
  'projectPath',
  'plan',
  'assignee',
  'claimedBy',
  'claimedAt',
  'tags',
  'createdAt',
  'updatedAt',
  'importedFrom',
  'author',
  'reporter',
  'dupeHits',
  'files',
  // FEAT-009 — derived in-memory from the mapped item's citation array (zero
  // extra reads), so it is a PLAIN field: the population-wide citation
  // aggregate a stats heatmap needs without per-item gets.
  'citationCount',
  // FEAT-BACKLOG-010 — derived from the persisted transition audit log (the
  // first transition into a terminal status), so it is a PSEUDO-field: it
  // costs a real `queryAuditEvents` read per item.
  'closedAt',
  // pseudo-fields — derived or expensive, therefore always opt-in (§1, §7.3)
  'body',
  'audit_trail',
  'blockers',
  'citations',
  'notes',
  'rollup',
  // BUG-025 read side — the humanIds of every live item linked via RELATES_TO.
  'related',
  'items',
  '_score',
  '_vector',
] as const;

/** INTERFACE_v2 §2.4 — see `BACKLOG_FIELDS`. */
export type IBacklogField = (typeof BACKLOG_FIELDS)[number];

/**
 * §7.3 — the pseudo-fields. These are not columns: each triggers extra work
 * (a join, a traversal, a derivation) or returns a large blob, so a caller
 * must ask for them by name.
 */
export const BACKLOG_PSEUDO_FIELDS: readonly IBacklogField[] = ['body', 'audit_trail', 'blockers', 'citations', 'closedAt', 'notes', 'rollup', 'related', 'items', '_score', '_vector'];

/** AC-18 — the default terse card for EVERY read tool. */
export const DEFAULT_CARD_FIELDS: readonly IBacklogField[] = ['humanId', 'kind', 'title', 'status', 'priority'];

/** §7.3 — `backlog_get`'s single-item affordance: the default card PLUS `projectPath`/`updatedAt`. Stated, not implied. */
export const DEFAULT_GET_FIELDS: readonly IBacklogField[] = [...DEFAULT_CARD_FIELDS, 'projectPath', 'updatedAt'];

/** §2.4 / §7.3 — the projection request. Absent `fields` means `DEFAULT_CARD_FIELDS`. */
export interface IProjection {
  /** Requested fields, in the §7.3 vocabulary. On the CLI this is a comma-separated `--fields`; on MCP/REST a JSON string array. */
  fields?: readonly IBacklogField[];
}

/** Runtime membership test for `IBacklogField`. */
export function isBacklogField(value: unknown): value is IBacklogField {
  return typeof value === 'string' && (BACKLOG_FIELDS as readonly string[]).includes(value);
}

/**
 * AC-19 — an unknown projection field is a `validation` error (exit 2), NEVER
 * a silent omission. A silently-dropped field is the same failure class as
 * BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001 on the read side: the caller gets
 * a success response that is missing exactly what it asked for.
 *
 * @throws {BacklogValidationError} naming every unknown field
 */
export function assertKnownFields(fields: readonly string[] | undefined): void {
  if (!fields) return;
  const bad = fields.filter((f) => !isBacklogField(f));
  if (bad.length > 0) {
    throw new BacklogValidationError(`fields: unknown field(s) ${bad.map((f) => `"${f}"`).join(', ')}`, bad);
  }
}

/** §7.4 / §2.1 — the hard pagination ceiling. Exceeding it is a `validation` error, NEVER a silent cap (BUG-BACKLOG-003). */
export const MAX_QUERY_LIMIT = 1000;

/**
 * §2.1 last bullet — validate a caller's `limit`.
 *
 * BUG-BACKLOG-003: the observed "~145-row cap" was a silent transport-level
 * truncation. A cap that is not an error is indistinguishable from a complete
 * result, so an over-large limit must FAIL rather than be quietly clamped.
 *
 * @throws {BacklogValidationError} when the limit is non-integral, < 1, or > `MAX_QUERY_LIMIT`
 */
export function assertQueryLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BacklogValidationError(`limit: must be a positive integer (got ${JSON.stringify(limit)})`, ['limit']);
  }
  if (limit > MAX_QUERY_LIMIT) {
    throw new BacklogValidationError(`limit: ${limit} exceeds MAX_QUERY_LIMIT (${MAX_QUERY_LIMIT}) — narrow the filter or page with offset; the tool will not silently cap`, ['limit']);
  }
}

// ----------------------------------------------------------------------------
// §5a.1 / §5a.5 / FEAT-007 — grouping axes and the per-item rollup. These are
// two DIFFERENT concepts (GRAPH_MODEL §4 naming note) and must never be
// conflated: `IGroupBy` counts across items, `IItemRollup` derives within one.
// ----------------------------------------------------------------------------

/** INTERFACE_v2 §2 `groupBy` — classic metadata axes plus the EPIC-A dimensional (edge-backed) axes. */
export const BACKLOG_GROUP_BY_AXES = [
  'kind',
  'family',
  'priority',
  'status',
  'projectPath',
  /** §5a.3 — files-backed; yields empty groups when items declare no `files`. */
  'file',
  'repo',
  'author',
  'reporter',
  'project',
  'packagePath',
  'plan',
  'assignee',
] as const;

/** INTERFACE_v2 §2 — see `BACKLOG_GROUP_BY_AXES`. */
export type IGroupByAxis = (typeof BACKLOG_GROUP_BY_AXES)[number];

/** Runtime membership test for `IGroupByAxis` — an unknown `--group-by` must be `invalid_argument`, never a silent single bucket. */
export function isGroupByAxis(value: unknown): value is IGroupByAxis {
  return typeof value === 'string' && (BACKLOG_GROUP_BY_AXES as readonly string[]).includes(value);
}

/**
 * FEAT-007 / INTERFACE_v2 §2 + §5a.1 — the grouping request.
 *
 * Two axes, because one is not enough: "open bugs per reporter" needs
 * `{ primary: 'reporter' }`, but "HIGH items per family per repo" needs a
 * second. Expressed as `{ primary, secondary? }` rather than a bare string so
 * the two-axis form is a type change, not a convention (the wire form still
 * accepts a bare axis string — see `normalizeGroupBy`).
 */
export interface IGroupBy {
  primary: IGroupByAxis;
  /** Optional second axis. Buckets nest: `bucket.buckets` carries the secondary rollup. */
  secondary?: IGroupByAxis;
}

/**
 * Accept either the sugar (`groupBy: "reporter"`) or the full two-axis object,
 * and validate both. One grammar, two spellings — the same rule §2.1a applies
 * to flag sugar.
 *
 * @throws {InvalidArgumentError} on an unknown axis, or when `secondary` repeats `primary`
 */
export function normalizeGroupBy(input: IGroupByAxis | IGroupBy | undefined): IGroupBy | undefined {
  if (input === undefined) return undefined;
  const raw: IGroupBy = typeof input === 'string' ? { primary: input } : input;
  if (!isGroupByAxis(raw.primary)) {
    throw new InvalidArgumentError('groupBy', `groupBy: unknown axis ${JSON.stringify(raw.primary)} (expected one of ${BACKLOG_GROUP_BY_AXES.join(', ')})`);
  }
  if (raw.secondary !== undefined) {
    if (!isGroupByAxis(raw.secondary)) {
      throw new InvalidArgumentError('groupBy', `groupBy.secondary: unknown axis ${JSON.stringify(raw.secondary)}`);
    }
    if (raw.secondary === raw.primary) {
      throw new InvalidArgumentError('groupBy', `groupBy: secondary axis "${raw.secondary}" repeats the primary axis — a two-axis rollup needs two DIFFERENT axes`);
    }
    return { primary: raw.primary, secondary: raw.secondary };
  }
  return { primary: raw.primary };
}

/** FEAT-007 — one bucket. `items` is populated only when `fields` includes `"items"` (§2.2 "counts-only by default"). */
export interface IGroupBucket {
  key: string;
  count: number;
  /** Present only when `IGroupBy.secondary` was requested. */
  buckets?: IGroupBucket[];
  /** Opt-in per §2.2 — never returned by default, so a grouped query cannot become a body dump. */
  items?: IBacklogCard[];
}

/** FEAT-007 — `view:"grouped"` payload. */
export interface IGroupedView {
  groupBy: IGroupBy;
  buckets: IGroupBucket[];
}

/**
 * FEAT-005 Stage 1 / INTERFACE_v2 §5a.1 — the per-item TWO-AXIS rollup,
 * derived at read time and never materialised (materialising recreates the
 * drift problem the ADR-0011 split-brain already cost us).
 *
 * Two axes, because a single boolean cannot express "not started" versus
 * "shipped, nobody transitioned it" — the consumer had 7 of 28 packets in
 * exactly that invisible state — nor its inverse (children closed, parent's
 * own acceptance unmet). All four combinations are meaningful.
 */
export interface IItemRollup {
  childrenTotal: number;
  childrenClosed: number;
  /** humanIds of the still-open children — the actionable half, so a caller needn't re-query. */
  childrenOpen: string[];
  /** Does THIS item carry its own closing evidence (≥1 citation while terminal)? The §5a.2 evidence gate's read-side twin. */
  selfVerified: boolean;
}

/** GRAPH_MODEL §6 — `aggregateByDimension`'s return shape. A dimension AGGREGATE, distinct from `IItemRollup` (GRAPH_MODEL §4 naming note). */
export type RollupResult = Record<string, number>;

// ----------------------------------------------------------------------------
// §2.2 view:"summary" / FEAT-010 — IBacklogStats v2.
// ----------------------------------------------------------------------------

/**
 * FEAT-010 / DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001 — how much of the corpus the
 * history-derived numbers actually cover.
 *
 * Audit events only exist for items touched AFTER the audit log shipped, so
 * every cycle-time number is computed over a SUBSET. A summary that reports a
 * median without saying it saw 12 of 340 items is not partially right, it is
 * misleading — so `coverage` is REQUIRED on `IBacklogStats`, never optional.
 */
export interface IStatsCoverage {
  /** Items with at least one audit event in the window. */
  itemsWithHistory: number;
  /** Items matching the filter at all — the denominator. */
  itemsTotal: number;
  /** ISO timestamp of the earliest audit event that exists. Everything before it is invisible, by construction. */
  auditWindowStart?: string;
}

/**
 * FEAT-010 / AC-15 — a duration distribution derived from audit events.
 * `null` percentiles mean "no sample", which is DIFFERENT from zero; a
 * consumer must not render an absent measurement as `0ms`.
 */
export interface IDurationStats {
  medianMs: number | null;
  p90Ms: number | null;
  /** Number of observations behind the percentiles. Read it together with `IStatsCoverage`. */
  sampleSize: number;
}

/**
 * INTERFACE_v2 §2.2 `view:"summary"` + FEAT-010 — the v2 stats contract.
 *
 * **BUG-023 (CONFIRMED LIVE 2026-08-21) is the reason this type exists in this
 * shape.** v1 `computeStats` (`store/query.ts:187-200`) computes `open` and
 * `closed` from the item list, and then computes
 * `byPriority: countByKey(items, …)` over **ALL** items on line 198 — the same
 * unscoped `items` array. So `byPriority.CRITICAL` reported 33 while only 16
 * criticals were open: the field every triage query sorts by was silently
 * counting RESOLVED/FIXED/VERIFIED rows.
 *
 * The fix is in the NAMES, so the mistake is unrepresentable rather than
 * merely discouraged:
 * - the obvious name (`byPriority`, `byKind`, `byFamily`, `byRepo`) is
 *   **open-scoped** — non-terminal items only, which is what a caller reaching
 *   for "how many criticals" means every time;
 * - the all-status variant must be spelled out in full
 *   (`byPriorityAllStatuses`, …), so nobody reaches for it by accident;
 * - **both are REQUIRED**, so an implementer cannot ship one and let the other
 *   silently default to the wrong scope.
 *
 * `byPriority` is a total `Record<Priority, number>` — all four keys are always
 * present (zero when empty) so a consumer never writes `?? 0` and never
 * mistakes an absent key for a genuine zero.
 *
 * v1's `BacklogStats` (model.ts:381) is left in place untouched for existing
 * callers; `IBacklogStats` is the v2 replacement, not a mutation of it.
 */
export interface IBacklogStats {
  /** Items matching the filter, all statuses. */
  total: number;
  /** Non-terminal items (`!isTerminalStatus`). */
  open: number;
  /** Terminal items. `open + closed === total`. */
  closed: number;

  /**
   * AC-15 — items that reached a terminal status inside `window` (default:
   * last 30 days — see `window` below). Derived from the persisted
   * `transition` audit log, so it only sees items `coverage` reports as
   * having history (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001) — partial, never
   * silently wrong.
   */
  closedInWindow: number;
  /** AC-15 — items created inside `window`, read from `item.createdAt` directly (exact for every item, unlike `closedInWindow`). */
  openedInWindow: number;
  /** AC-15 — `openedInWindow - closedInWindow`: net backlog growth/shrink over `window`. */
  netInWindow: number;

  /** Per-status counts. Inherently all-status — a status breakdown scoped to "open" would be tautological. */
  byStatus: Record<string, number>;

  /** **OPEN-SCOPED** priority counts — BUG-023's fix. All four keys always present. */
  byPriority: Record<Priority, number>;
  /** Priority counts over EVERY status. Spelled out because it is almost never what a triage caller wants. */
  byPriorityAllStatuses: Record<Priority, number>;

  /** **OPEN-SCOPED** counts by `kind`. */
  byKind: Record<string, number>;
  /** Kind counts over every status. */
  byKindAllStatuses: Record<string, number>;

  /** **OPEN-SCOPED** counts by `family`. */
  byFamily: Record<string, number>;
  /** Family counts over every status. */
  byFamilyAllStatuses: Record<string, number>;

  /** **OPEN-SCOPED** counts by repo. Single-key when `scope.repo` is set, full cross-repo breakdown otherwise (BUG-024). */
  byRepo: Record<string, number>;
  /** Repo counts over every status. */
  byRepoAllStatuses: Record<string, number>;

  /**
   * FEAT-009 — total `Citation` entries across the scoped population.
   * Derived in-memory from the mapped items (the same array every other
   * count reads), so it is free and therefore REQUIRED: a citation-coverage
   * stat that silently fell back to a stale subset would be exactly the
   * partial-right-is-misleading failure `coverage` exists to prevent.
   */
  citationsTotal: number;
  /**
   * FEAT-009 — percentage (0-100, one decimal) of scoped items carrying at
   * least one citation. `0` on an empty population — never `NaN`, never a
   * fabricated number. Read it with `byFamilyCitationCoverage` for the
   * per-family shape the web UI heatmap renders.
   */
  citationCoverage: number;
  /**
   * FEAT-009 — per-family citation coverage %, keyed by family (items with
   * no family group under `"(none)"`, matching the web UI's own fallback).
   * ALL-status — coverage is a property of the item's evidence, not its
   * lifecycle phase.
   */
  byFamilyCitationCoverage: Record<string, number>;

  /** REQUIRED — DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001. Partial history is visible, never silent. */
  coverage: IStatsCoverage;

  /** AC-15 — the window these history-derived numbers cover, from `filter.dateRange.updated` (default: last 30 days). */
  window?: IDateBound;
  /** AC-15 — created → first terminal transition, over `window`. */
  timeToResolution?: IDurationStats;
  /** AC-15 — per-status dwell time, keyed by `BacklogStatus`. */
  timeInStatus?: Record<string, IDurationStats>;
  /** AC-15 — terminal → non-terminal transitions in `window`, over items that reached terminal in it. */
  reopenRate?: number;
  /** FEAT-010 — transition counts bucketed by period. */
  transitionsByBucket?: Array<{ bucket: string; count: number }>;
  /**
   * FEAT-BACKLOG-010 — the historical closed-per-week series: each scoped
   * item's FIRST transition into a terminal status, bucketed by period.
   *
   * Window semantics (documented, never silent): DEFAULT spans ALL history —
   * this is the "historical" series the throughput stats were missing (only
   * the current-window `closedInWindow` existed). An explicit window — the
   * top-level `window` param or `filter.dateRange.updated` — BOUNDS it,
   * composing with FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001. This
   * deliberately differs from `transitionsByBucket`/`closedInWindow`, which
   * always honour the AC-15 activity window (default: last 30 days); the
   * distinction is stated so a caller never sums the two expecting them to
   * agree.
   */
  closedByBucket?: Array<{ bucket: string; count: number }>;
  /**
   * FEAT-BACKLOG-010 — the historical opened-per-week series: each scoped
   * item's creation, bucketed by period. Reads `item.createdAt` directly
   * (exact for EVERY item, including ones that predate the audit log —
   * mirrors `openedInWindow`'s reasoning), so `sum(openedByBucket)` equals
   * the scoped population size. Same window semantics as `closedByBucket`.
   */
  openedByBucket?: Array<{ bucket: string; count: number }>;
}

/** FEAT-010 — the bucketing grain for `view:"summary"`. Defaults to `"day"` (§2.2). */
export type ISummaryBucket = 'hour' | 'day' | 'week' | 'month';

/**
 * BUG-023's runtime teeth.
 *
 * `IBacklogStats`' NAMES make the bug hard to write; this makes it impossible
 * to ship. An open-scoped map can never count more items than are open, so if
 * an implementer wires `byPriority` to the all-items array (exactly line
 * `query.ts:198`), the sum exceeds `open` the moment any closed item carries a
 * priority — and this throws instead of publishing 33-when-16-are-open.
 *
 * Also checks the containment invariant in the other direction: an open-scoped
 * bucket can never exceed its own all-status bucket.
 *
 * @param stats the computed stats, before they are returned to a caller
 * @throws {InvalidArgumentError} naming the offending map and the two numbers
 */
export function assertOpenScopedStats(stats: IBacklogStats): void {
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

  if (stats.open + stats.closed !== stats.total) {
    throw new InvalidArgumentError('stats', `stats: open (${stats.open}) + closed (${stats.closed}) !== total (${stats.total})`);
  }

  const openScoped: Array<[string, Record<string, number>, Record<string, number>]> = [
    ['byPriority', stats.byPriority, stats.byPriorityAllStatuses],
    ['byKind', stats.byKind, stats.byKindAllStatuses],
    ['byFamily', stats.byFamily, stats.byFamilyAllStatuses],
    ['byRepo', stats.byRepo, stats.byRepoAllStatuses],
  ];

  for (const [name, scoped, all] of openScoped) {
    const scopedTotal = sum(scoped);
    if (scopedTotal > stats.open) {
      throw new InvalidArgumentError(
        'stats',
        `stats.${name}: sums to ${scopedTotal} but only ${stats.open} items are open — ` +
          `${name} is the OPEN-SCOPED map (BUG-023); all-status counts belong in ${name}AllStatuses`
      );
    }
    if (sum(all) > stats.total) {
      throw new InvalidArgumentError('stats', `stats.${name}AllStatuses: sums to ${sum(all)} but only ${stats.total} items match the filter`);
    }
    for (const [key, value] of Object.entries(scoped)) {
      const allValue = all[key] ?? 0;
      if (value > allValue) {
        throw new InvalidArgumentError(
          'stats',
          `stats.${name}["${key}"]: open-scoped count ${value} exceeds the all-status count ${allValue} — the open set cannot be larger than the whole set (BUG-023)`
        );
      }
    }
  }

  if (stats.coverage.itemsWithHistory > stats.coverage.itemsTotal) {
    throw new InvalidArgumentError('stats', `stats.coverage: itemsWithHistory (${stats.coverage.itemsWithHistory}) exceeds itemsTotal (${stats.coverage.itemsTotal})`);
  }
}

// ----------------------------------------------------------------------------
// §4 — IUpdatePatch. The STRICT patch type.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §4 — the complete set of item fields `backlog_update` accepts
 * in `patch`.
 *
 * **BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001 is why this type is exhaustive
 * and why `UPDATE_PATCH_KEYS` exists beside it.** Today `updateItemNode`
 * (`store/crud.ts:375-410`) reads exactly five keys off the patch — `title`,
 * `body`, `projectPath`, `importedFrom` (crud.ts:381-385) and `tags`
 * (crud.ts:391-395) — and then returns the mapped item as a SUCCESS. A caller
 * passing `priority`, `status`, `plan`, `assignee`, `kind` or `humanId` gets
 * `ok` back and no change at all: the write is silently discarded. v1's
 * `UpdateItemInput` (model.ts:302) doesn't even declare those keys, so
 * TypeScript can't catch it and the runtime doesn't try.
 *
 * The fix has two halves and this type is the first:
 * 1. **Name every accepted key** — so an implementation that handles a subset
 *    is a visible gap, and `assertNoSilentlyDiscardedPatchKeys` can prove it.
 * 2. **Reject the rest by name** — `assertKnownPatchKeys` turns an unrecognised
 *    key into `invalid_argument` instead of a silent no-op (§7.8).
 *
 * `IUpdatePatch` is a superset of v1 `UpdateItemInput`, so an existing caller's
 * patch object stays valid.
 */
export interface IUpdatePatch {
  title?: string;
  body?: string;
  tags?: string[];
  projectPath?: string;
  /**
   * Provenance backfill ONLY (see v1 `UpdateItemInput.importedFrom`): an
   * already-stamped owner is immutable and must never be reassigned.
   */
  importedFrom?: string;
  /** Was silently discarded pre-fix — BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001. */
  priority?: Priority;
  /**
   * Was silently discarded pre-fix. NOTE: a status change through `patch` is
   * still subject to the §5a.2 evidence gate (`requiresCitation`/
   * `requiresReason`, model.ts:75/79) — the patch path must not become a way
   * around the gate that `transitionStatus` enforces.
   */
  status?: BacklogStatus;
  /** Was silently discarded pre-fix. */
  plan?: string;
  /** Was silently discarded pre-fix. Durable ownership, distinct from the ephemeral `claimedBy` lease. */
  assignee?: string;
  /** Was silently discarded pre-fix. */
  kind?: string;
  /** Was silently discarded pre-fix. A rename must go through the store's `renameHumanId` repair primitive, not a blind metadata write. */
  humanId?: string;
  /**
   * DEBT-BACKLOG-REPO-MOVE-001 / INTERFACE_v2 §4: legal only once repo is a
   * graph node (EPIC-A). Until then the tool must reject it with a clear
   * `unsupported` error (`UnsupportedOperationError`) rather than pretend —
   * and rejecting is exactly what makes it different from the silent discard.
   */
  repo?: string;
  /** §5a.3 — declared file paths, the `view:"overlap"` input. */
  files?: string[];
  /** FEAT-012 — author role edge (`AUTHORED_BY`). */
  author?: string;
  /** FEAT-012 — reporter role edge (`REPORTED_BY`). */
  reporter?: string;
}

/**
 * Every key `backlog_update` accepts in `patch`. INTERFACE_v2 §7.8's
 * `additionalProperties: false` needs a runtime enumeration; this is it.
 */
export const UPDATE_PATCH_KEYS = [
  'title',
  'body',
  'tags',
  'projectPath',
  'importedFrom',
  'priority',
  'status',
  'plan',
  'assignee',
  'kind',
  'humanId',
  'repo',
  'files',
  'author',
  'reporter',
] as const satisfies readonly (keyof IUpdatePatch)[];

/**
 * Compile-time exhaustiveness guard: adding a field to `IUpdatePatch` without
 * adding it to `UPDATE_PATCH_KEYS` fails the build. Without this the two drift
 * and the new field is rejected at runtime as "unknown" — a fresh instance of
 * the very silent-discard class this type exists to kill.
 */
type _PatchKeysAreExhaustive = [Exclude<keyof IUpdatePatch, (typeof UPDATE_PATCH_KEYS)[number]>] extends [never]
  ? true
  : ['IUpdatePatch key missing from UPDATE_PATCH_KEYS', Exclude<keyof IUpdatePatch, (typeof UPDATE_PATCH_KEYS)[number]>];
const _patchKeysAreExhaustive: _PatchKeysAreExhaustive = true;
void _patchKeysAreExhaustive;

/** Keys present on a caller's patch object that `IUpdatePatch` does not accept. Pure — never throws. */
export function unknownPatchKeys(patch: Record<string, unknown>): string[] {
  const known: ReadonlySet<string> = new Set<string>(UPDATE_PATCH_KEYS);
  return Object.keys(patch ?? {}).filter((k) => !known.has(k));
}

/**
 * INTERFACE_v2 §7.8 — reject a patch key by NAME instead of ignoring it
 * (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001, write side).
 *
 * @throws {InvalidArgumentError} listing every rejected key
 */
export function assertKnownPatchKeys(patch: Record<string, unknown>): void {
  const bad = unknownPatchKeys(patch);
  if (bad.length > 0) {
    throw new InvalidArgumentError(
      'patch',
      `patch: unknown key(s) ${bad.map((k) => `"${k}"`).join(', ')} — accepted keys are ${UPDATE_PATCH_KEYS.join(', ')} (INTERFACE_v2 §4)`
    );
  }
}

/**
 * THE guard for BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.
 *
 * `assertKnownPatchKeys` catches keys nobody declared. This catches the far
 * nastier half: a key that IS declared, that the caller DID pass, and that the
 * implementation never applied — the exact shape of `updateItemNode`
 * (`store/crud.ts:375-410`) accepting `priority` in the type and writing only
 * `title`/`body`/`projectPath`/`importedFrom`/`tags`.
 *
 * The write path calls this at the end with the set of keys it actually wrote,
 * so "declared but unhandled" fails loudly instead of returning success.
 *
 * @param patch the caller's patch
 * @param appliedKeys the keys the implementation genuinely persisted
 * @throws {InvalidArgumentError} naming each requested-but-unapplied key
 */
export function assertNoSilentlyDiscardedPatchKeys(patch: Record<string, unknown>, appliedKeys: Iterable<string>): void {
  const applied: ReadonlySet<string> = new Set(appliedKeys);
  const requested = Object.keys(patch ?? {}).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const dropped = requested.filter((k) => !applied.has(k));
  if (dropped.length > 0) {
    throw new InvalidArgumentError(
      'patch',
      `patch: ${dropped.map((k) => `"${k}"`).join(', ')} ${dropped.length === 1 ? 'was' : 'were'} accepted by the schema but never written — ` +
        `refusing to report success for a discarded write (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001)`
    );
  }
}

// ----------------------------------------------------------------------------
// EPIC-A / GRAPH_MODEL §2.1, §3 — repository, package, project, identity nodes.
// ----------------------------------------------------------------------------

/**
 * GRAPH_MODEL_v2 §2.1/§3 — the repo dimension node (tag `backlog-repo`).
 *
 * **AC-7 is the whole point.** The live store holds items filed under BOTH
 * `adhd` and `PseudoSky/adhd` for what is one project, so a query for
 * `repo: "adhd"` silently returns a partial corpus today. `aliases` carries
 * every string ever used to address this repo, so both keys resolve to one
 * node and either spelling returns the union.
 */
export interface IRepositoryNode {
  /** The winning key. `BacklogItem.repo` and the node `namespace` are both stamped with this. */
  canonicalKey: string;
  /** Every other string that addresses this repo (`PseudoSky/adhd`, `adhd.git`, …). Never includes `canonicalKey`. */
  aliases: string[];
  /** Canonical key of the upstream repo when this one is a fork — fork-key reconciliation (§3). */
  forkOf?: string;
  /** Human label for display; never used for resolution. */
  displayName?: string;
}

/** GRAPH_MODEL_v2 §2.1 — the package dimension node (tag `backlog-package`, name `${repoKey}::${projectPath}`). */
export interface IPackageNode {
  /** `IRepositoryNode.canonicalKey` of the owning repo. */
  repo: string;
  /** Repo-relative package path, e.g. `packages/apigen/apigen-core-client`. */
  path: string;
  /** The Nx project name, e.g. `apigen-core-client` — what `nx` calls it, which is not always the last path segment. */
  projectName: string;
}

/** GRAPH_MODEL_v2 §2.1 — the project dimension node (tag `backlog-project`); target of the repo→project `PROJECT_OF` edge. */
export interface IProjectNode {
  projectKey: string;
  /** Canonical repo keys that belong to this project — the cross-repo query axis (AC-8). */
  repos?: string[];
}

/**
 * GRAPH_MODEL_v2 §2.1.1 — the identity node (tag `backlog-identity`), serving
 * TWO roles that must not be conflated:
 * - **claim identity** is ephemeral and per-instance (`researcher:a1b2c3`) and
 *   must NEVER be aggregated — those nodes carry `claimOnly`;
 * - **author/reporter identity** is stable and canonicalised (`researcher`).
 *
 * AC-14's "stable across agent runs" requirement rests entirely on that split.
 */
export interface IIdentityNode {
  canonicalKey: string;
  aliases: string[];
  /** True for nodes minted solely to hold a claim lease — excluded from author/reporter aggregation. */
  claimOnly?: boolean;
}

/**
 * GRAPH_MODEL_v2 §3 — deterministic repo-key normalisation: trim, strip a
 * trailing `.git`, take the last path segment.
 *
 * Pure and store-free on purpose (the store-backed resolver
 * `canonicalRepoKeyFor` lives in `store/identity.ts` and layers the alias map
 * on top). The bare name only WINS if no other known repo shares the segment —
 * that ambiguity check needs the alias map, so it lives in
 * `resolveRepositoryNode`, not here.
 *
 * @throws {InvalidArgumentError} on an empty/whitespace-only key
 */
export function normalizeRepoKey(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArgumentError('repo', 'repo: must be a non-empty string');
  }
  const trimmed = raw.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : trimmed;
}

/** Every string that addresses a repo node: its canonical key, its aliases, and the normalised bare form of each (GRAPH_MODEL §3). */
export function repoAliasSet(node: IRepositoryNode): ReadonlySet<string> {
  const out = new Set<string>();
  for (const key of [node.canonicalKey, ...node.aliases]) {
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    out.add(key.trim());
    out.add(normalizeRepoKey(key));
  }
  return out;
}

/** The outcome of resolving a caller's raw repo string against the known repo nodes (GRAPH_MODEL §3, AC-7/AC-24). */
export interface IRepoResolution {
  /** The chosen repo node, or `null` when nothing matched. */
  node: IRepositoryNode | null;
  /** Every node the raw key matched. Length > 1 means the bare name was genuinely ambiguous. */
  candidates: IRepositoryNode[];
  /**
   * AC-24 — set when `candidates.length > 1`. The caller MUST surface this in
   * the envelope's `warnings`: a read never silently narrows.
   */
  warning?: string;
}

/**
 * GRAPH_MODEL_v2 §3 + INTERFACE_v2 AC-7/AC-24 — resolve a raw repo string to
 * exactly one repo node, and NEVER narrow silently.
 *
 * AC-7: `resolveRepositoryNode(nodes, "adhd")` must find the node whose
 * aliases contain `PseudoSky/adhd`, so a query for `adhd` returns items filed
 * under both keys instead of half the corpus.
 *
 * AC-24: when a bare name matches two genuinely different repos, the caller
 * still gets a resolved node (queries stay usable) AND a `warning` naming the
 * ambiguity and the node chosen — the "wrong data with no error" class the
 * design forbids. Selection is deterministic (lowest canonical key by
 * `localeCompare`) so the warning is reproducible rather than order-dependent.
 */
export function resolveRepositoryNode(nodes: readonly IRepositoryNode[], raw: string): IRepoResolution {
  const needleExact = typeof raw === 'string' ? raw.trim() : '';
  if (needleExact.length === 0) throw new InvalidArgumentError('repo', 'repo: must be a non-empty string');
  const needleBare = normalizeRepoKey(needleExact);

  // Exact canonical-key hits win outright — an exact key is never ambiguous.
  const exact = nodes.filter((n) => n.canonicalKey === needleExact);
  if (exact.length === 1) return { node: exact[0], candidates: exact };

  const matches = nodes.filter((n) => {
    const aliases = repoAliasSet(n);
    return aliases.has(needleExact) || aliases.has(needleBare);
  });
  if (matches.length === 0) return { node: null, candidates: [] };
  if (matches.length === 1) return { node: matches[0], candidates: matches };

  const sorted = [...matches].sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));
  return {
    node: sorted[0],
    candidates: sorted,
    warning:
      `repo "${needleExact}" is ambiguous — it matches ${sorted.length} repos (${sorted.map((n) => n.canonicalKey).join(', ')}); ` +
      `resolved to "${sorted[0].canonicalKey}". Pass a fully-qualified repo key to disambiguate.`,
  };
}

/**
 * GRAPH_MODEL_v2 §2.1.1 — strip the per-process `:instanceId` suffix so two
 * runs of the same agent aggregate into ONE author/reporter bucket.
 *
 * **AC-14 depends on exactly this.** Items filed by `researcher:x` and
 * `researcher:y` must land in one `researcher` bucket; per-process buckets
 * make aggregate-by-reporter useless across agent runs. Case is preserved —
 * lowercasing would merge genuinely different identities.
 *
 * NOT applied to `claimedBy`: claim identity is deliberately per-instance for
 * CAS correctness (§2.1.1) and must stay ephemeral.
 *
 * @throws {InvalidArgumentError} on an empty identity, or one that is only a suffix (`":abc"`)
 */
export function canonicalIdentityKey(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArgumentError('identity', 'identity: must be a non-empty string');
  }
  const base = raw.trim().split(':')[0].trim();
  if (base.length === 0) {
    throw new InvalidArgumentError('identity', `identity: ${JSON.stringify(raw)} has no name before the ":instanceId" suffix`);
  }
  return base;
}

/**
 * INTERFACE_v2 §7.5 / §4 — `by` is an EXPLICIT parameter on every mutation
 * because MCP transports are stateless. An unattributed mutation is rejected,
 * never silently stamped with a placeholder.
 *
 * @returns the trimmed actor string (NOT canonicalised — attribution records
 *   the acting instance; `canonicalIdentityKey` is for the author/reporter
 *   NODE, §2.1.1)
 * @throws {InvalidArgumentError} when `by` is absent or blank
 */
export function assertAttribution(by: string | undefined): string {
  if (typeof by !== 'string' || by.trim().length === 0) {
    throw new InvalidArgumentError('by', 'by: every mutation must be attributed — pass `by` explicitly (INTERFACE_v2 §7.5); the CLI resolves it from the env override or `git config user.name`');
  }
  return by.trim();
}

// ----------------------------------------------------------------------------
// §2.4 — the item shapes a read tool returns.
// ----------------------------------------------------------------------------

/**
 * AC-18 — the default terse card. `humanId, kind, title, status, priority`
 * (§2.4), plus the pseudo-fields a caller opted into via `fields`.
 *
 * Defends §0.2's context-blow: 36 items were 90KB of full bodies because the
 * read tool's own default returned everything. Every extra property here is
 * optional, so the default projection is genuinely five fields.
 */
export interface IBacklogCard {
  humanId: string;
  kind: string;
  title: string;
  status: BacklogStatus;
  priority?: Priority;
  // ---- `backlog_get`'s single-item affordance (§7.3) ----------------------
  projectPath?: string;
  updatedAt?: string;
  // ---- opt-in via `fields` ----------------------------------------------
  repo?: string;
  family?: string;
  plan?: string;
  assignee?: string;
  claimedBy?: string;
  claimedAt?: string;
  tags?: string[];
  createdAt?: string;
  importedFrom?: string;
  /** FEAT-012 — canonicalised author (`canonicalIdentityKey`). */
  author?: string;
  /** FEAT-012 — canonicalised reporter. */
  reporter?: string;
  /** FEAT-013 — see `IBacklogItemV2.dupeHits`. */
  dupeHits?: number;
  /** §5a.3 — declared file paths. */
  files?: string[];
  /**
   * `fields: ["citationCount"]` — FEAT-009: how many `Citation` entries this
   * item carries. Derived in-memory from the mapped item (`item.citations`),
   * so it costs ZERO extra reads — the whole point: a citation-coverage
   * heatmap can be served off a single population query instead of a
   * per-item `backlog_get` fan-out. Always a number (0 when none).
   */
  citationCount?: number;
  /**
   * `fields: ["closedAt"]` — FEAT-BACKLOG-010: the ISO timestamp of this
   * item's FIRST transition into a terminal status, reconstructed from the
   * persisted transition audit log (the bi-temporal store already has the
   * data — this is a read, never a guess). Absent for items that have never
   * reached a terminal status. Costs one `queryAuditEvents` read, so it is
   * opt-in like every other pseudo-field.
   */
  closedAt?: string;
  /** `fields: ["body"]` — never present by default (AC-18). */
  body?: string;
  /** `fields: ["citations"]`. */
  citations?: Citation[];
  /** `fields: ["notes"]`. */
  notes?: Note[];
  /** `fields: ["audit_trail"]` — the transition/claim event log. */
  audit_trail?: AuditTrailEntry[];
  /** `fields: ["blockers"]` — humanIds this item is dependency-blocked by. */
  blockers?: string[];
  /** `fields: ["rollup"]` — §5a.1's two-axis derivation, computed per item on read. */
  rollup?: IItemRollup;
  /** `fields: ["related"]` — BUG-025 read side: humanIds of every OTHER live item linked to this one via `RELATES_TO` (either direction). */
  related?: string[];
  /** `fields: ["_score"]` — matcher score on `view:"similar"` / `sort:"relevance"`. */
  _score?: number;
  /** `fields: ["_vector"]` — AC-20: the embedding blob is returned ONLY when named explicitly. */
  _vector?: number[];
  /**
   * DEBT-BACKLOG-GET-001 — the complement of every pseudo-field the caller
   * COULD have named (§7.3's `BACKLOG_PSEUDO_FIELDS`) but did not. Lets a
   * caller tell "body omitted by projection" from "body actually is the
   * empty string" without re-requesting it just to check. Absent (never an
   * empty array) once every pseudo-field has been requested.
   */
  omittedFields?: readonly IBacklogField[];
}

/**
 * The v2 item: v1 `BacklogItem` (model.ts:96) plus the dimensional and demand
 * fields. Every addition is optional, so a v1 `BacklogItem` value is a valid
 * `IBacklogItemV2` and existing mappers keep compiling.
 */
export interface IBacklogItemV2 extends BacklogItem {
  /** FEAT-012 — canonicalised author identity (`AUTHORED_BY`). Defaults to `canonicalIdentityKey(by)` on create (GRAPH_MODEL §2.1.1). */
  author?: string;
  /** FEAT-012 — canonicalised reporter identity (`REPORTED_BY`). */
  reporter?: string;
  /**
   * FEAT-013 — how many times this item has been re-filed. The demand signal
   * behind `sort:"demand"` and `filter.dupeHitsMin`: an item filed 5 times is
   * wanted more than one filed once. Always a number (0, never undefined) once
   * FEAT-013 lands, so a sort comparator needs no fallback.
   */
  dupeHits?: number;
  /** §5a.3 — declared file paths, the `view:"overlap"` input. The tool never reads the filesystem to populate this. */
  files?: string[];
  /** §5a.1 — derived on read, never materialised. Present only when `fields` includes `"rollup"`. */
  rollup?: IItemRollup;
}

// ----------------------------------------------------------------------------
// §3 — backlog_create: instantiation + filing-time interception.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §3 / FEAT-013 — what to do when the filing-time dedupe scan
 * finds candidates. Named in the signature so an agent chooses discoverably,
 * never via a guessed `confirm` boolean.
 */
export type IDuplicateAction =
  /** DEFAULT — refuse the create and return the candidates. */
  | 'abort'
  /** Confirmed re-file (idempotent under CAS; counts once). Migrations/backfills pass this to bypass interception deliberately. */
  | 'file'
  /** The one-action path: convert the draft into a note on the canonical item and increment its dupe counter. */
  | 'comment';

/** GRAPH_MODEL_v2 §5.1 — why a create variant wrote nothing. Never a silent drop. */
export type ICreateSuppressionReason = 'duplicate-suppressed' | 'id-collision' | 'content-collision';

/** §3 — a dedupe candidate surfaced at filing time, with the score that produced it. */
export interface IDuplicateCandidate {
  item: IBacklogCard;
  /** Matcher score. FTS-overlap in v1; embedding similarity once EPIC-G lands (§9 Q2). */
  score?: number;
  /** Why it matched — shared symbol/path/error text, or shared files/citations (§2.2 `similar`). */
  reason?: string;
}

/** FEAT-012 — create input. `author`/`reporter` are the roles; `by` is the acting attribution (§7.5). */
export interface ICreateItemInputV2 extends CreateItemInput {
  /**
   * FEAT-012 — the item's author role. GRAPH_MODEL §2.1.1: when absent this
   * DEFAULTS to `canonicalIdentityKey(by)` (a stated contract, because AC-14's
   * aggregate stability depends entirely on it), which is why the field is
   * optional here while the WRITE always has one.
   */
  author?: string;
  /** FEAT-012 — the item's reporter role. Defaults to the author when absent. */
  reporter?: string;
  /** §5a.3 — declared file paths. */
  files?: string[];
}

/**
 * INTERFACE_v2 §3 + GRAPH_MODEL §5.1 — the OUTCOME shape every create variant
 * returns: `create`, `split`, and `supersede` alike.
 *
 * Defends BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 (CRITICAL). The
 * verified silent-drop paths are `splitItemNode` (discards the `created` flag
 * and reports the canonical item as if created — `store/structure.ts:142-144`)
 * and `supersedeItemNode` (skips the dedupe scan entirely —
 * `store/structure.ts:73-121`). Making `created` a required boolean on ONE
 * shared shape is what stops a variant from quietly reporting a write it
 * never did.
 */
export interface ICreateOutcome {
  /** False ⇒ NOTHING was written; read `reason` and `duplicateCandidates`. */
  created: boolean;
  /** Present iff `created` — the id actually allocated. */
  humanId?: string;
  /** Present iff `created`. */
  item?: IBacklogItemV2;
  /** Present when interception fired or a collision suppressed the write. */
  duplicateCandidates?: IDuplicateCandidate[];
  /** Present iff `!created` — why. */
  reason?: ICreateSuppressionReason;
  /** BUG-BACKLOG-REPO-LOOKUP-UX-001 — soft warning; never blocks the write. */
  repoWarning?: string;
  /** `duplicateAction: "comment"` — the note written onto the canonical item instead of a new node. */
  commentedOn?: { humanId: string; noteIndex: number; dupeHits: number };
}

/**
 * GRAPH_MODEL_v2 §5.1 — `splitItemNode`'s outcome. `PART_OF` is written only
 * for children that were ACTUALLY created; suppressed children are reported,
 * never dropped (BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001,
 * `store/structure.ts:142-144`).
 */
export interface ISplitItemResult {
  parentHumanId: string;
  created: IBacklogItemV2[];
  suppressed: Array<{ item?: IBacklogCard; reason: ICreateSuppressionReason; duplicateCandidates?: IDuplicateCandidate[] }>;
}

/**
 * GRAPH_MODEL_v2 §5.1 — `supersedeItemNode`'s outcome. It runs the dedupe scan
 * BEFORE minting and never mints on suppression (today it skips the scan
 * entirely — `store/structure.ts:73-121`).
 */
export interface ISupersedeResult extends ICreateOutcome {
  /** The item that was superseded. Present whether or not the replacement was created. */
  supersededHumanId: string;
}

// ----------------------------------------------------------------------------
// §4 / §5 — mutation and edge outcomes.
// ----------------------------------------------------------------------------

/** §4 — `backlog_update`'s claim verb. */
export type IClaimAction = 'claim' | 'release' | 'renew';

/**
 * INTERFACE_v2 §4 — the outcome contract for `backlog_update`.
 * `changed` is the list of fields that ACTUALLY changed, which is what makes a
 * silent discard visible: a patch key that never reaches `changed` is a
 * defect, not a no-op (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001, and see
 * `assertNoSilentlyDiscardedPatchKeys`).
 */
export interface IUpdateOutcome {
  humanId: string;
  /** Fields genuinely persisted by this call. Empty array = a genuine no-op, and it is stated. */
  changed: Array<keyof IUpdatePatch | 'status' | 'claim' | 'assignee' | 'note' | 'citation' | 'softDeleted'>;
  newStatus?: BacklogStatus;
  claimState?: ClaimStatus | 'released' | 'release-noop';
  /** Index of the note appended by `addNote`, so a caller can address it. */
  noteId?: number;
  /** The edge written when the update also created one. */
  edge?: IEdgeOutcome;
}

/** INTERFACE_v2 §5 — `backlog_relate`'s relation vocabulary. Widens to repo/project edges with EPIC-A. */
export type IRelationKind = 'dependency' | 'related' | 'plan';

/** INTERFACE_v2 §5 — the written/removed edge, reported rather than assumed. */
export interface IEdgeOutcome {
  from: string;
  to: string;
  rel: 'DEPENDS_ON' | 'RELATES_TO' | 'MEMBER_OF' | 'PART_OF' | 'IN_REPO' | 'IN_PACKAGE' | 'PROJECT_OF' | 'AUTHORED_BY' | 'REPORTED_BY';
  action: 'add' | 'remove';
  /** True when the edge already existed (add) or did not exist (remove) — an idempotent call is stated, not disguised as a fresh write. */
  noop: boolean;
}

/**
 * INTERFACE_v2 §5 / backlog-001 — the outcome of linking two items as related.
 *
 * **BUG-025 is why this type exists.** `linkRelatedNode`
 * (`store/structure.ts:57-61`) returns `Promise<void>`, which apigen renders
 * as `{"result": null}` — the SAME payload for a successful link and for a
 * failure. Confirmed live: there is no way for a caller to tell whether the
 * edge was written, which makes the write unverifiable and the tool untestable
 * through its real seam.
 *
 * `linked` is the literal `true` because the failure path is the envelope's
 * error arm (`IOutcomeEnvelope`), never a `linked: false` success. `repo` and
 * both humanIds are echoed so the response identifies WHICH edge was written
 * without the caller correlating against its own request. `alreadyLinked`
 * distinguishes a fresh write from an idempotent re-link — the distinction
 * `{"result": null}` erased.
 */
export interface ILinkRelatedResult {
  linked: true;
  repo: string;
  humanIdA: string;
  humanIdB: string;
  /** True when the `RELATES_TO` edge already existed — the call was idempotent, and that fact is reported rather than hidden. */
  alreadyLinked: boolean;
}

// ----------------------------------------------------------------------------
// §2.2 — the remaining view payloads (pinned here so no work order invents one).
// ----------------------------------------------------------------------------

/**
 * §2.2 `view:"order"` — the rename of v1 `topo`, with wave numbers.
 * v1 `TopoOrderResult` (model.ts:397) returns bare humanIds; the wave number
 * is what an orchestrator actually dispatches on, so it is part of the shape.
 */
export type IOrderResult = { ok: true; order: Array<{ humanId: string; wave: number }> } | { ok: false; cycle: string[] };

/** §2.2 `view:"stale"` — claims older than the lease window. A read filter preset, NOT an admin action (§6). */
export interface IStaleClaimEntry {
  humanId: string;
  title: string;
  claimedBy: string;
  claimedAt: string;
  ageMinutes: number;
}

/** FEAT-011 / §2.2 `view:"similar"` — a candidate plus why it matched. */
export interface ISimilarHit {
  item: IBacklogCard;
  /** Matcher score. FTS-overlap in v1, embedding cosine once EPIC-G lands — the endpoint contract is stable across the swap (§7.6). */
  score: number;
  /** Overlap reason: shared files, shared citations, shared symbols. */
  sharedFiles?: string[];
  sharedCitations?: string[];
}

/**
 * RAG-SPEC §5 `suggestDependencies` — a read-only, NON-DIRECTIONAL dependency
 * candidate. `rel` is the LITERAL `'RELATES_TO'` (not `EdgeRel`, not
 * `'RELATES_TO' | 'DEPENDS_ON'`) so that a caller who tries to widen this
 * shape to also carry a directional `DEPENDS_ON` guess gets a COMPILE ERROR,
 * not a runtime check — "a confirm gate is structural, not a flag" (RAG-SPEC
 * §5) starts at the type. `hit` reuses the pinned `ISimilarHit` shape (same
 * KNN candidate, same score, same "why it matched" fields) rather than
 * inventing a second candidate shape for what is the same underlying match.
 */
export interface ISuggestedDependency {
  readonly rel: 'RELATES_TO';
  hit: ISimilarHit;
}

/** §5a.3 / AC-28 — the overlap axis. NEVER named `by`: that is reserved for the actor identity on mutations (§4/§7.5). */
export type IOverlapAxis = 'file' | 'project' | 'package' | 'author';

/** §5a.3 — one pairwise intersection. */
export interface IOverlapPair {
  a: string;
  b: string;
  /** The shared units on `axis`. AC-28 asserts `file` and `project` produce DIFFERENT results on the same set. */
  shared: string[];
}

/** §5a.3 `view:"overlap"` — an INPUT to wave selection, never a scheduler: the tool reports declared overlap and nothing else (§5a.4). */
export interface IOverlapView {
  axis: IOverlapAxis;
  pairs: IOverlapPair[];
}

/**
 * FEAT-015 / §2.2 `view:"plan"` + AC-16 — the native resume surface. One call
 * answers "where was I": rollup, ready set, blocked set, the delta since the
 * last checkpoint, the needs-human set, the caller's own claims, and the next
 * checkpoint token.
 *
 * "If a plan cannot be resumed from a single tool call, that is an interface
 * defect, not a workflow gap" (§5a.6) — which is why every one of these lives
 * in ONE payload instead of across five queries.
 */
export interface IPlanView {
  plan: string;
  /** The plan parent item's own card (§5a.5: the plan parent IS an item). */
  card?: IBacklogCard;
  /** §5a.1's two-axis rollup over the plan's members. */
  rollup: IItemRollup;
  ready: IBacklogCard[];
  /** Each blocked member WITH the dependency blocking it — not just "blocked". */
  blocked: Array<{ item: IBacklogCard; blockedBy: string[] }>;
  /** Audit events after `filter.dateRange.updated.since` — the session-boundary primitive. */
  delta: AuditTrailEntry[];
  /** §9 Q11 — derived from existing state: non-terminal, unclaimed, blocked on nothing external. Testable without EPIC-B statuses. */
  needsHuman: IBacklogCard[];
  /** AC-16 — the caller's own in-progress work, from `filter.claimedBy`. An interrupted agent sees its claims in the SAME envelope. */
  myClaims: IBacklogCard[];
  /**
   * AC-16 — the checkpoint token to pass back as the next
   * `filter.dateRange.updated.since`. Tool-native, so a resuming agent never
   * hand-persists a timestamp in a ledger. AC-16 pins its provenance: calling
   * twice with the first `asOf` must SHRINK the delta.
   */
  asOf: string;
}

/** §5a.8 — `criticalPath`. Pinned here so Phase 3 never invents the shape at implementation time. */
export interface ICriticalPathResult {
  plan: string;
  /** The weighted longest path through `DEPENDS_ON`. */
  criticalChain: string[];
  length: number;
  endItem: string;
}

/** §5a.8 — `blockerImpact`: the BACKWARD-reachable (transitive) cone, not just direct dependents. AC-30's negative control caps depth at 1 to prove transitivity. */
export interface IBlockerImpactResult {
  humanId: string;
  impactedCount: number;
  impactedOpenCount: number;
  impactedHumanIds: string[];
}

/** §5a.8 — `planReadiness`. */
export interface IPlanReadinessResult {
  planSlug: string;
  totalCount: number;
  doneCount: number;
  readyCount: number;
  blockedCount: number;
  hasCycle: boolean;
  percentComplete: number;
  nextRecommended?: string;
}

/** §5a.8 — the `criticalPath` weighting function. */
export type IPathWeightFn = 'count' | 'priority';

// ----------------------------------------------------------------------------
// §2.1b — the natural-language query plan (transparency, never silent).
// ----------------------------------------------------------------------------

/**
 * §2.1b step 3 / AC-27 — one dimension the planner extracted from a
 * natural-language query.
 *
 * `applied` is the load-bearing field: extraction NEVER narrows semantic
 * recall implicitly. A term becomes a `boost` (ranking signal) unless it is an
 * unambiguous structural word, and either way it is SURFACED here so the user
 * sees every guess and can escalate it to a real filter with a flag.
 */
export interface IExtractedTerm {
  term: string;
  type: 'repo' | 'project' | 'package' | 'kind' | 'status' | 'plan' | 'author' | 'reporter' | 'time';
  confidence: number;
  applied: 'boost' | 'filter';
}

/**
 * §2.1b step 6 / AC-27 — the compiled plan, returned in the envelope as
 * `data.query`, so an agent or human sees exactly what the string became
 * (including what was NOT filtered) and can correct either channel.
 * AC-27(d): re-running this plan as the explicit `view:list` + filter +
 * semantic form must return the SAME items.
 */
export interface IQueryPlan {
  /** The ENTIRE input string — never a remainder after extraction (§2.1b step 1). */
  semantic: string;
  filter: IBacklogFilter;
  boosts: IExtractedTerm[];
  extracted: IExtractedTerm[];
  sort: IBacklogSort;
}

// ----------------------------------------------------------------------------
// §1-§6 — the six tool inputs.
// ----------------------------------------------------------------------------

/** INTERFACE_v2 §1 — `backlog_get({ humanId, fields? })`. */
export interface IBacklogGetInput extends IProjection {
  humanId: string;
  /** Explicit until EPIC-A's repo node lands (§7.5). */
  repo?: string;
}

/** INTERFACE_v2 §2 — `backlog_query`. Flag sugar (§2.1a) compiles into `filter` before this shape is built. */
export interface IBacklogQueryInput extends IProjection {
  view?: IBacklogView;
  filter?: IBacklogFilter;
  sort?: IBacklogSort;
  direction?: ISortDirection;
  limit?: number;
  offset?: number;
  groupBy?: IGroupByAxis | IGroupBy;
  /** §2.2 `view:"overlap"` payload — the set to compute pairwise intersections over. */
  humanIds?: string[];
  /** §5a.3 — the overlap axis. NOT `by` (§4/§7.5 reserves that name for the actor). */
  overlapBy?: IOverlapAxis;
  /** §2.1b — the natural-language query; also the CLI positional form. */
  text?: string;
  /** §2.2 — bucketing grain for `view:"summary"`. Default `"day"`. */
  bucket?: ISummaryBucket;
  /** §5a.8 — `criticalPath` weighting on `view:"plan"`. */
  weightFn?: IPathWeightFn;
  /** §7.3 — `table` renders summary/grouped/plan for humans; `json` (default) stays agent-native. */
  format?: 'json' | 'table';
  /**
   * FEAT-BACKLOG-STATS-TIME-WINDOWED-THROUGHPUT-001 — `view:"summary"`'s
   * EXPLICIT time window (default: last 30 days via `resolveStatsWindow`).
   * Per-bound fields COMPOSE with `filter.dateRange.updated` (a provided
   * `since` overrides the dateRange `since`, an absent one falls through),
   * so an arbitrary historical window can be asked for without contorting a
   * list-view filter. Meaningful only on `view:"summary"` — any other view
   * rejects it (INTERFACE_v2 §7: an ignored key is a bug).
   */
  window?: IDateBound;
}

/** INTERFACE_v2 §3 — `backlog_create`. Absorbs `create-item`, `split-item`, `supersede-item`. */
export interface IBacklogCreateInput {
  /**
   * The item payload. Named `item`, not `input` — a prior shape put the item
   * payload on a field ALSO named `input` (`IBacklogCreateInput.input`),
   * which double-nested every call as `{"input":{"input":{...}}}` and reads
   * as a typo. `item` says what the field actually holds.
   */
  item: ICreateItemInputV2;
  /** §7.5 — REQUIRED. `assertAttribution` rejects an absent/blank value rather than stamping a placeholder. */
  by: string;
  splitFrom?: string;
  children?: ICreateItemInputV2[];
  supersedes?: string;
  reason?: string;
  /** §3 — default `"abort"`. §9 Q10: in batch/import this is per-item skip-with-report, never whole-batch abort. */
  duplicateAction?: IDuplicateAction;
}

/** INTERFACE_v2 §4 — `backlog_update`. Absorbs all twelve v1 mutation commands. */
export interface IBacklogUpdateInput {
  humanId: string;
  /** REQUIRED — a humanId is only unique within a repo. */
  repo: string;
  /** §7.5 — REQUIRED. */
  by: string;
  patch?: IUpdatePatch;
  status?: BacklogStatus;
  /**
   * Priority reassignment. A SEPARATE top-level field, not `patch.priority`
   * (which `updateItemNode` rejects outright — priority changes go through
   * the dedicated `setPriority` store primitive, same as `status` goes
   * through `transitionStatus`). Partial fix of
   * BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001: before this field existed
   * there was no path to reassign priority through the six-verb surface at
   * all — `patch.priority` always threw, and nothing else called
   * `setPriority`.
   */
  priority?: Priority;
  /**
   * §5a.2 transition evidence — `citations` and `reason` are ONLY meaningful on
   * a `status` transition, so they are bundled here rather than exposed as
   * standalone top-level fields (DEBT-010: the old top-level `citations`/`reason`
   * were silently dropped unless `status` was also present). Passing
   * `statusEvidence` without `status` is a client error and fails loud.
   */
  statusEvidence?: { citations?: Citation[]; reason?: string };
  claim?: IClaimAction;
  claimOpts?: ClaimOpts;
  assignedTo?: string;
  addNote?: string;
  addCitation?: Citation;
  softDeleteReason?: string;
}

/** INTERFACE_v2 §5 — `backlog_relate`. */
export interface IBacklogRelateInput {
  sourceId: string;
  targetId: string;
  relation: IRelationKind;
  action: 'add' | 'remove';
  /** REQUIRED — the repo `sourceId` resolves in (and `targetId`'s too, unless `targetRepo` overrides it). */
  repo: string;
  /**
   * Overrides which repo `sourceId` resolves in, when it differs from
   * `targetId`'s repo. Defaults to `repo`. Together with `targetRepo`, this
   * is the cross-repo relate fix (FEAT-BACKLOG-004's still-real gap): a
   * single `repo` alone could never resolve two endpoints living in two
   * different repos.
   */
  sourceRepo?: string;
  /** Overrides which repo `targetId` resolves in. Defaults to `repo`. See `sourceRepo`. */
  targetRepo?: string;
  /** §7.5 — REQUIRED. */
  by: string;
}

/** INTERFACE_v2 §6 — `backlog_admin`'s action union. §6's growth rule: at ~25 actions, split a `backlog_system` tool rather than accrete. */
export const BACKLOG_ADMIN_ACTIONS = [
  'archive',
  'export',
  'import',
  'render',
  'merge',
  'migration_status',
  'set_migration_phase',
  'version',
  'skill',
  'batch',
  'doctor',
  'prune',
  'migrate_model_v2',
  'reconcile_repo',
  'run_dedup_sweep',
  'cluster_into_plans',
  'promote_cluster_to_plan',
  'embedding_backfill',
  'embedding_health',
  'list_near_duplicates',
] as const;

/** INTERFACE_v2 §6 — see `BACKLOG_ADMIN_ACTIONS`. `install`/`install-skill`/`serve` are deliberately NOT here (the §6 host-command carve-out). */
export type IBacklogAdminAction = (typeof BACKLOG_ADMIN_ACTIONS)[number];

/** INTERFACE_v2 §6 — `backlog_admin({ action, params? })`. */
export interface IBacklogAdminInput {
  action: IBacklogAdminAction;
  params?: Record<string, unknown>;
  /** §7.5 — REQUIRED for the mutating actions. */
  by?: string;
}

/** INTERFACE_v2 AC-0 — the six verbs, and ONLY the six. `install`/`serve` are host commands (§6 carve-out) and must never appear here. */
export const BACKLOG_V2_TOOLS = ['get', 'query', 'create', 'update', 'relate', 'admin'] as const;

/** INTERFACE_v2 AC-0 — see `BACKLOG_V2_TOOLS`. */
export type IBacklogV2Tool = (typeof BACKLOG_V2_TOOLS)[number];

/** GRAPH_MODEL_v2 §6 — `migrateGraphModelV2`'s result. `dryRun` defaults true; nothing is written unless a caller opts out explicitly. */
export interface IMigrateModelV2Result {
  dryRun: boolean;
  itemCount: number;
  edgeCount: number;
  repoReconciliations: Array<{ from: string; to: string; itemCount: number }>;
  collisions: Array<{ humanId: string; detail: string }>;
  /** GRAPH_MODEL §7 step 6 — old-vs-new parity must be ZERO drift before the migration commits. */
  parityOk: boolean;
}
