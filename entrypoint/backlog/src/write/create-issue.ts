/**
 * create-issue.ts — `createIssue` (SPEC.md §4 + §6.3.2).
 *
 * One `store.adapter.transaction(fn, {mode:'immediate'})` (§4c) over: resolve
 * `project` (find-only, §1/§6.1) → resolve `component` (find-only when given;
 * `project`'s reserved `(root)` default when omitted, §3/§6.1/§8 AC-23) →
 * find-or-mint `kind`/`status`/`priority`/`agent` (§1/§4c's hand-composed
 * find-then-create) → write the `issue` node → write `owns_component` +
 * `has_kind` + `has_status` (+ `has_priority` when resolved) + `authored_by`
 * + each citation's `citation` node/`has_citation` edge → `writeAudit` (§4a)
 * — all against the SAME `tx` handle, never a call to the library's
 * `writeNode`/`writeEdge`/`findOrCreateNode` themselves (§4c).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { GraphBackend } from '@adhd/sox-graph-store';
import type {
  StoreSearchBackend,
} from '@adhd/sox-hybrid-search';
import {
  type IProjectPolicy,
  type IResolvedCatalogRow,
  type IResolvedProjectRow,
  mintOrResolveCatalogTx,
  mintOrResolveStatusTx,
  nextPriorityRankTx,
  projectHasKnownPath,
  resolveComponentTx,
  resolveDefaultComponentTx,
  resolveEdgeKindTx,
  resolveProjectPolicy,
  resolveProjectTx,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  isMissingPathError,
  resolveCitationTarget,
  resolveSiblingProjectRootsTx,
  toolOwnedCitationRoots,
} from './citation-path.js';
import {
  composeEmbedText,
  scheduleIssueEmbedding,
} from './embedding-observer.js';
import {
  CitationUnverifiableError,
  InvalidArgumentError,
  citationReadError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
  resolveLiveIssueTx,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';
// Read-only reuse of the query layer's own uid→live-issue resolver for the
// declared-parent resolution this gate now needs (`dedupeExcludeUid`,
// c5460239). Like `resolveDedupeExcludeIds`'s own read of the graph, this is
// an IMPORT of a read-only module,
// never a write-path `tx.ts` call: the duplicate scan runs BEFORE the write
// transaction opens (see `scanForDuplicates`'s own doc comment), so it has no
// `tx` to hand a `resolveLiveIssueTx`, and `resolveIssueByUid` is documented
// safe to run standalone.
import { resolveIssueByUid, tryResolveComponentRef } from '../query/resolve.js';
// C9 — the ONE shared advisory similarity scan (create gate + `view:'similar'`
// cluster block run the identical scan). The former in-file `scanForDuplicates`
// scan body moved there verbatim; `scanForDuplicates` below is now a thin
// wrapper that keeps the create-gate-specific exclusion + degraded mapping.
import {
  type ISimilarCandidate,
  type SimilarityScanDegradedReason,
  scanSimilarCandidatesWithMeta,
} from './similarity-scan.js';

/**
 * A filing-time citation (§6.3.2, carried forward from the established `Citation` shape in
 * spirit — `blastRadius` stays best-effort, `model.ts:110-120`). Named
 * `ICitationInput` here (not the spec's bare `Citation`) per this repo's
 * "prefix shared/data interfaces with `I`" convention.
 */
export interface ICitationInput {
  file: string;
  lines?: string;
  context?: string;
  symbol?: string;
  /** Best-effort enrichment payload — not re-specified here; carried through verbatim into the citation node's metadata. */
  blastRadius?: unknown;
}

export interface ICreateIssueInput {
  title: string;
  body: string;
  /** uid or name — resolved per §6.1; REQUIRED (every issue has a component chain). NEVER minted by this verb (§1/§6.1). */
  project: string;
  /** uid or name, scoped within `project` — RESOLVED ONLY, never created. Omitted (undefined) resolves to `project`'s reserved default component `(root)` (§3/§6.1/§8 AC-23) — a THIRD case, distinct from a resolved or an unresolved name. */
  component?: string;
  /** catalog name or uid; default is the project's configured `policy.defaultKind`, falling back to the global `"issue"` row. An unresolved NAME mints; a uid-shaped ref that does not resolve throws (§6.1). */
  kind?: string;
  /** catalog name or uid; default is `policy.defaultStatus`, falling back to the global `"open"` row. An unresolved NAME is minted via `mintOrResolveStatusTx`: a name in the frozen reserved terminal table (`RESERVED_TERMINAL_STATUS_NAMES`, `catalog.ts`) seeds `terminal:true`, every other name seeds `terminal:false` (a novel/typo name must never silently close an item, §6.3.2); a uid-shaped ref that does not resolve throws (§6.1). */
  status?: string;
  /** catalog name or uid; genuinely OPTIONAL — §6.3.2 states minting behavior for a GIVEN unresolved name but, unlike `kind`/`status`, states no fallback for the omitted case; omitted therefore writes no `has_priority` edge at all (a deliberate reading of §6.3.2's more precise per-field text over §4's summary prose — see this project's own README/CHANGELOG note on this slice for the citation). An unresolved NAME mints with `rank` = one past the current max (lowest urgency); a uid-shaped ref that does not resolve throws. */
  priority?: string;
  citations?: ICitationInput[];
  /** catalog agent name/uid; defaults to `by`. An unresolved NAME mints; a uid-shaped ref that does not resolve throws (§6.1). */
  author?: string;
  /** Plain metadata scalar (§6.2) — no edge. */
  assignee?: string;
  /**
   * The item-level disclosure-contract git context — a plain metadata scalar
   * (a sibling of {@link assignee}, no edge), persisted verbatim into the
   * `issue` node's metadata and surfaced by reads as `IIssueCard.gitContext`.
   *
   * Repo `AGENTS.md`'s "Cite what you read" rule fixes the shape of a
   * `Citations:` block as `Citations: [<active git context>, <agent name>,
   * <active plan or task>, …]` — the git context is the block's FIRST
   * element. This field carries it. It is ITEM-level, deliberately NOT a
   * per-citation `ref`: the block renders it once, at its head, so a
   * multi-citation item never repeats it. Omitted ⇒ nothing is stored, and
   * every read/render path is byte-for-byte unchanged.
   */
  gitContext?: string;
  /**
   * A **dedupe-scoping hint only**: the uid of the item this one is being
   * filed under. It names a parent so the pre-write similarity scan (§6.4
   * point 1) EXCLUDES that item AND its `part_of` ancestor chain from the
   * duplicate candidate set, so a child that deliberately restates its
   * parent's intent is not suppressed as a duplicate OF that parent (defect
   * c5460239: a child of C7 reproduced `created:false`/
   * `duplicate-suppressed` with its own parent as the top candidate at
   * 0.9811). A child restating its GRANDPARENT is likewise not suppressed,
   * because the ancestry walk spans the whole `part_of` chain.
   *
   * It writes NO `part_of` edge — `relate` is the sole `part_of` writer
   * (§6.3.6). Because it only scopes the read-side scan, it is invisible on
   * the emitted card and nothing new is persisted; it has no effect once a
   * create is not a duplicate. An unresolvable uid throws
   * `IssueNotFoundError` (fail loud, ADR-0002 D5), never silently ignored.
   *
   * A uid ONLY, never a name (matching `relate`'s `sourceUid`/`targetUid` uid
   * convention, §1/§6.1).
   */
  dedupeExcludeUid?: string;
  /** The acting identity — agent or person (§6.3's opening rule) — REQUIRED on every mutating verb. A missing/blank value throws `InvalidArgumentError('by', ...)` before any write runs. */
  by: string;
  /**
   * The duplicate-gate control (§6.3.2, resolved in full at §6.4). Default
   * `'abort'`. Only meaningful when the pre-write similarity scan (§6.4
   * point 1) surfaces ≥1 candidate at/above `project_policy.dedupe_threshold`
   * — a zero-candidate scan proceeds to a normal create regardless of this
   * value (§6.4 point 3, first sentence).
   *
   * - `'abort'` — nothing is written; `{created:false,
   *   reason:'duplicate-suppressed', duplicateCandidates}`. If the scan was
   *   degraded in the ONE way that can NEVER resolve on its own —
   *   `no-embed-query`, the backend wired without `embedQuery` so the
   *   calibrated channel can never run — it also fails closed with
   *   `{created:false, reason:'duplicate-scan-degraded',
   *   duplicateScanDegraded:true, duplicateScanDegradedReason:'no-embed-query'}`
   *   (BUG 4e8fce2a). A `no-vector-scores` degrade (indistinguishable at read
   *   time from benign on-write embedding lag) or a `no-search-backend`
   *   degrade (dedupe never mounted) instead PROCEEDS and carries the
   *   `duplicateScanDegraded` signal.
   * - `'force'` — the write proceeds to a genuinely new, distinct `uid`
   *   despite the match; `duplicateCandidates` is still reported.
   * - `'comment'` — no new issue node is written; a `note` node is attached
   *   (`has_note`) to the TOP-scoring candidate instead, carrying the
   *   would-be issue's title+body verbatim.
   */
  duplicateAction?: 'abort' | 'force' | 'comment';
  /**
   * §4b/§6.2 — waits for the fire-and-forget on-write embedding round-trip
   * (`embedding-observer.ts`'s `scheduleIssueEmbedding`) before `createIssue`
   * returns, when `true` and `handle.embedding` is configured. Default
   * (`false`/omitted): fire-and-forget — the embed/vector-upsert and its
   * `embedding_upserted`/`embedding_failed` audit row happen in the
   * background, after this function has already returned to its caller.
   * A `true` value with NO `handle.embedding` configured is a harmless no-op
   * (nothing to await — `scheduleIssueEmbedding` resolves immediately).
   * Per-call, not per-handle — §6.2 specifies this field as kept verbatim
   * on `create`/`update`, living on the input type for each verb
   * (`ICreateIssueInput` here, `IUpdateIssueInput` in `update.ts`), not on
   * `IDuplicateScanHandle`.
   */
  awaitEmbed?: boolean;
}

/** §6.4 point 3 — the SET of legal `duplicateAction` values, checked at runtime (not just the TS type) since this verb is reachable from transports — MCP/HTTP/CLI — with no compile-time guarantee on the JSON they hand in. */
const DUPLICATE_ACTIONS = ['abort', 'force', 'comment'] as const;
type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

/**
 * A dedupe candidate surfaced at filing time (§6.4), carrying the cosine
 * similarity that produced it — see {@link scanForDuplicates}'s own doc
 * comment for where that number comes from and why it is the only score
 * this gate will accept.
 */
export interface IDuplicateCandidate {
  uid: string;
  title: string;
  /** Cosine similarity in `[0,1]`, straight off the vector channel — directly comparable to `project_policy.dedupe_threshold`. */
  score: number;
}

/**
 * Why {@link scanForDuplicates} could not produce a calibrated comparison —
 * i.e. why the gate did NOT actually scan for duplicates despite being asked
 * to. See {@link IDuplicateScanOutcome.degraded}.
 *
 * C9: this is now an ALIAS of the shared scan's own reason union
 * (`write/similarity-scan.ts`), so the create gate and the `view:'similar'`
 * cluster block can never drift on what "degraded" means. The name and every
 * member are unchanged, so existing importers/tests are unaffected.
 */
export type DuplicateScanDegradedReason = SimilarityScanDegradedReason;

/**
 * The result of {@link scanForDuplicates}. Its `candidates` arm is the
 * pre-existing return value; `degraded` is the missing signal this type now
 * carries (BUG 4e8fce2a).
 *
 * **`degraded` is the distinction the gate previously could not make.**
 * Before this type existed, `scanForDuplicates` returned only
 * `IDuplicateCandidate[]`, so an empty array meant EITHER "the scan ran and
 * genuinely found nothing" OR "the scan could not run at all" — two states
 * with opposite safety meanings that the caller had no way to tell apart. The
 * abort branch (`createIssue`) then treated both as "no duplicates" and wrote
 * the item, so `duplicateAction:'abort'` silently FAILED OPEN whenever the
 * semantic substrate was degraded (no search backend, no `embedQuery`, or an
 * empty/mismatched vector space). See {@link scanForDuplicates}'s own doc
 * comment for exactly which conditions set this flag.
 */
export interface IDuplicateScanOutcome {
  candidates: IDuplicateCandidate[];
  /**
   * C9 — advisory CROSS-project candidates surfaced alongside the
   * same-project `candidates`. Never suppress a create, never fire
   * `comment`, and the scan writes no edge for them (AC3). Empty when the
   * scope is `same-project` (the default).
   */
  similarCandidates?: ISimilarCandidate[];
  /**
   * `true` iff the scan could NOT perform a calibrated duplicate comparison
   * for the in-scope issues — no vector channel ran, so `candidates` is empty
   * because the gate is blind, NOT because the store is clean. Always `false`
   * when the project genuinely has zero issues to compare against, or when
   * `dedupeScanEnabled` is off: those are complete (if empty) scans, not
   * degraded ones.
   */
  degraded: boolean;
  /** Set iff `degraded` — the concrete reason, never a generic "unavailable". */
  degradedReason?: DuplicateScanDegradedReason;
}

/**
 * The search substrate `createIssue`'s duplicate gate needs (§6.4 point 1),
 * threaded alongside {@link IWriteStoreHandle} rather than folded into it:
 * `IWriteStoreHandle` (tx.ts) is the write layer's OWN minimal dependency
 * shape (`adapter`+`typePolicy`) and is not this slice's file to widen.
 * Structurally — not nominally — compatible with `query/query.ts`'s
 * `IQueryStoreHandle`: every real call site (`TestIssueStore` in tests,
 * and the not-yet-built store-bootstrap module in production, §6.3.2's own
 * `awaitEmbed` doc comment) already carries BOTH a `graph` and a `search`
 * alongside the write handle's `adapter`/`typePolicy`, so a caller who
 * already has an `IQueryStoreHandle`-shaped object satisfies this by
 * construction — no adapter/wrapper needed.
 *
 * `search.embedQuery` is declared OPTIONAL here (unlike
 * `IQueryStoreHandle.search.embedQuery`, which is mandatory) specifically to
 * express §6.4 point 4's `no-embed-query` degraded case: a `StoreSearchBackend`
 * can be wired (FTS/text runs off the graph store directly) while no embedding
 * model/vector space is configured, so the CALIBRATED (vector) channel can
 * never run. `scanForDuplicates` reports that as `degradedReason:
 * 'no-embed-query'`, and `createIssue`'s `abort` FAILS CLOSED on it — a
 * persistent configuration absence the operator must fix, never a transient.
 * (It deliberately does NOT fall back to a text-only scan: BM25 is
 * uncalibrated and would reintroduce the false-positive class — see
 * {@link scanForDuplicates}.) `search` itself stays OPTIONAL (no backend
 * mounted at all) for the same "never silently go dark" posture §6.4 point 4
 * states, but applied one layer further out: `scanForDuplicates` reports a
 * wholly-absent backend as `no-search-backend` (zero candidates, `create`
 * PROCEEDS and carries the signal) rather than throwing — filing an issue must
 * never hard-fail because the product-feature-only dedupe UX (§6.4's own
 * framing: "a missed warning, not a correctness defect") happens to be
 * unwired in a given environment.
 */
export interface IDuplicateScanHandle {
  readonly graph?: GraphBackend;
  readonly search?: {
    readonly backend: StoreSearchBackend;
    embedQuery?(text: string): Promise<Float32Array>;
  };
}

/**
 * The "plain" card fields (§6.5) this verb already has in hand after a
 * create — never field-projected, unlike a `query` response.
 *
 * BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001: named `ICreateIssueCard`,
 * not `IIssueCard`, deliberately. `query/types.ts` also exports an
 * `IIssueCard` (the fields-projected card `query`/`get` return, every field
 * but `uid` optional) — both interfaces were reachable from `api.d.ts`'s
 * type graph, and apigen's extraction (`ts-json-schema-generator`, invoked
 * per-operation but apparently resolving/caching declarations by bare name
 * across the whole extracted program) non-deterministically resolved the
 * `IIssueCard` bare name to EITHER declaration depending on extraction
 * order — confirmed empirically: `dist/index.js` (CJS) resolved `query`'s
 * own `items: IIssueCard[]` to THIS file's stricter shape (wrongly requiring
 * `project`/`component`/`createdAt`), while `dist/index.mjs` (ESM) failed to
 * resolve it at all (`items: {}`, unconstrained) — from the exact same
 * source, built in the same pass. This is what broke `backlog_query`'s MCP
 * `oneOf` output-schema validation the moment `get()`'s return type union
 * (AC-11) made the extractor visit both `IIssueCard` declarations. The
 * correct, permanent fix is what's below: give the two interfaces distinct
 * bare names so extraction can never conflate them, not a workaround in the
 * `get()`/`query()` call sites. Filed as
 * BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001 (apigen-core-client, out of
 * this package's ownership) — this rename is the local mitigation; the
 * extractor itself should also stop keying declarations by bare name.
 *
 * This rename fixes the CJS path (`dist/index.js`, the only bundle any real
 * transport here — CLI, MCP-stdio, HTTP serve — ever spawns/requires;
 * confirmed empirically, `dist/index.mjs` is loaded by none of them). It does
 * NOT fix a second, DISTINCT defect also present in `dist/index.mjs`: every
 * `$ref` to a NAMED exported interface (`ICreateIssueCard` here,
 * `IDuplicateCandidate`, `IIssueCard`, …) dereferences to `{}` (empty/
 * unconstrained) in the ESM build specifically, while inline/anonymous
 * object types on the SAME operation (e.g. `ICreateIssueResult.commentedOn`)
 * resolve correctly in both builds — ruling out a general extraction
 * failure and pointing at `dereferenceSchema`'s named-`$ref` resolution
 * specifically misbehaving under ESM. Reproduced on `create`'s `item`/
 * `duplicateCandidates` fields, which this file's own diff never touched,
 * so it predates and is independent of the collision above. Filed
 * separately as BUG-APIGEN-CORE-CLIENT-ESM-DEREF-EMPTY-001 — not fixed
 * here (out of this package's ownership, and no real consumer loads
 * `dist/index.mjs` today), but must not be silently dropped.
 */
export interface ICreateIssueCard {
  uid: string;
  title: string;
  kind: string;
  status: string;
  priority?: string;
  project: string;
  component: string;
  createdAt: string;
  assignee?: string;
  author?: string;
  closedAt?: string;
  /** The item-level disclosure-contract git context, echoed back from {@link ICreateIssueInput.gitContext} — present iff one was supplied. */
  gitContext?: string;
}

/**
 * `ICreateOutcome` (§6.3.2's Output section, verbatim shape — ONE interface
 * with optional fields, deliberately NOT a discriminated union): `created`
 * is the only field guaranteed present. Every other field's presence is
 * conditional per §6.4/§6.3.2:
 *
 * - `uid`/`item` — present iff `created`.
 * - `duplicateCandidates` — present iff the scan surfaced ≥1 candidate
 *   at/above threshold (§6.4 point 3) — on `'abort'` (suppressed) AND on
 *   `'force'` (written anyway, reported for audit) AND on `'comment'`.
 *   Absent entirely on a zero-candidate scan, regardless of
 *   `duplicateAction` — this is NOT an empty array in that case (§6.4 point
 *   3, first sentence).
 * - `reason` — present iff `!created` and the gate suppressed the write
 *   (`duplicateAction:'abort'`, the default) OR refused it because the scan
 *   was degraded in the never-resolvable `no-embed-query` way
 *   (`'duplicate-scan-degraded'`, BUG 4e8fce2a — see
 *   {@link IDuplicateScanOutcome}).
 * - `duplicateScanDegraded`/`duplicateScanDegradedReason` — present iff the
 *   pre-write scan could not run a calibrated comparison
 *   ({@link scanForDuplicates}'s `degraded`), on EVERY outcome: on the
 *   `'abort'` refusal for the never-resolvable `no-embed-query` degrade
 *   (`created:false`, `reason:'duplicate-scan-degraded'`), and on
 *   `'force'`/`'comment'`/the `no-vector-scores` and `no-search-backend`
 *   `'abort'` paths where the write proceeded anyway.
 *   This is the field that makes a degraded scan non-silent: absent on a
 *   healthy scan (the common case), so byte-for-byte unchanged there.
 * - `commentedOn` — present iff `duplicateAction:'comment'` fired.
 * - `supersededUid` — always absent from `createIssue` alone; only the
 *   `supersedes` composition (§6.3.2, not yet built here) would set it.
 */
export interface ICreateIssueResult {
  created: boolean;
  uid?: string;
  item?: ICreateIssueCard;
  duplicateCandidates?: IDuplicateCandidate[];
  /**
   * C9 — advisory cross-project similarity candidates. Present iff the
   * configured `similarityScope` is wider than `same-project` and the scan
   * surfaced at least one. Purely informational: it never changes whether the
   * write proceeded, and the scan writes no `similar_to` edge (AC2/AC3).
   */
  similarCandidates?: ISimilarCandidate[];
  reason?: 'duplicate-suppressed' | 'duplicate-scan-degraded';
  /** Present iff the pre-write scan was degraded — see this interface's own doc comment. Paired with {@link duplicateScanDegradedReason}. */
  duplicateScanDegraded?: boolean;
  /** Why the scan was degraded. Present iff {@link duplicateScanDegraded}. */
  duplicateScanDegradedReason?: DuplicateScanDegradedReason;
  supersededUid?: string;
  commentedOn?: { uid: string; noteId: string };
  /**
   * C1 AC8 — how the issue's component was resolved. `'explicit'` when the
   * caller supplied `component` and it resolved; `'default-root'` when the
   * caller supplied none and the project's reserved `(root)` default was used.
   * Makes "silently defaulted" distinguishable from "resolved": a supplied
   * component that does NOT resolve still throws `CatalogNotFoundError` and
   * never reaches this field.
   */
  placementResolved?: 'explicit' | 'default-root';
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * Maximum length of the item-level `gitContext` disclosure scalar, enforced
 * at WRITE time by every verb that accepts one (`create` here, `transition`).
 * The field is free-form caller text that the markdown renderer interpolates
 * inline (`query/markdown.ts`'s `sanitizeGitContext` is the render-side half
 * of the same guarantee), so an unbounded value would let a single issue's
 * citation block balloon arbitrarily. Shared by both write paths so the
 * `create`/`transition` caps never drift.
 */
export const MAX_GIT_CONTEXT_LENGTH = 512;

/** Rejects an over-long `gitContext` before any write runs (E_VALIDATION, never retried). A non-string (e.g. an untyped CLI/HTTP/MCP JSON `null`) is skipped here — the caller's own `typeof === 'string'` normalization treats it as absent. */
export function assertGitContextWithinCap(value: string | undefined): void {
  if (typeof value === 'string' && value.length > MAX_GIT_CONTEXT_LENGTH) {
    throw new InvalidArgumentError(
      'gitContext',
      `must be at most ${MAX_GIT_CONTEXT_LENGTH} characters, got ${value.length}`
    );
  }
}

/**
 * §8.5's two-branch citation-sha rule, run identically at live-write time
 * (§8.5: "this is also the canonical rule for computing citation.sha on the
 * LIVE write path").
 *
 * Branch 1: a PATH-LESS project cannot content-address anything, so every
 * citation degrades to the `'unverified'` sentinel up front.
 *
 * Branch 2: the target must resolve (canonically) within the project root OR
 * within one of the project policy's `citationAllowedExternalRoots` — see
 * `citation-path.ts`'s {@link resolveCitationTarget}. In-project resolution
 * stays the DEFAULT; the external roots are a TYPED, per-project carve-out
 * (BUG c6d35272) that makes deliberately-out-of-root evidence citable without
 * ever opening the read surface to an arbitrary absolute path. Because the
 * check canonicalizes (realpath) BOTH the candidate and every root, a `..`
 * traversal cannot widen the surface, and a symlink inside the root that
 * points outside it is rejected (the sibling defect c6d90ddf, closed here).
 * A target outside every root resolves to `'unverified'`, identically to a
 * genuinely missing file — `createIssue`'s policy gate below decides whether
 * to reject it, and the read is never performed for it.
 *
 * The only filesystem read happens AFTER acceptance, against the canonical
 * candidate. §4c's error taxonomy is preserved exactly (never a parallel
 * classification): "the cited file genuinely is not there" is the ONLY case
 * that degrades to `'unverified'` — ENOENT (missing path segment) and ENOTDIR
 * (a path segment that should be a directory is a file, so the target cannot
 * exist) both mean exactly that. `EISDIR` (the target is a directory) is a
 * caller mistake and surfaces as `CitationTargetIsDirectoryError`
 * (`E_VALIDATION`, 56a2133e). Any other failure (EACCES, EPERM, EMFILE,
 * ELOOP, …) — whether from `realpath` or the `readFile` — is a REAL I/O
 * failure, not a "file doesn't exist" signal, and surfaces as `WriteIOError`
 * (raw errno message attached and logged) rather than silently masquerading
 * as an absent citation. Both mappings live in `errors.ts`'s
 * `citationReadError`.
 */
async function computeCitationSha(
  project: IResolvedProjectRow,
  file: string,
  allowedExternalRoots: readonly string[],
  siblingRoots: readonly string[] = []
): Promise<string> {
  if (!projectHasKnownPath(project)) return 'unverified';

  try {
    const { accepted, candidate } = await resolveCitationTarget(
      project.metadata.path,
      file,
      [
        ...allowedExternalRoots,
        ...toolOwnedCitationRoots(),
        ...siblingRoots,
      ]
    );
    if (!accepted) return 'unverified';

    const content = await readFile(candidate);
    return createHash('sha256').update(content).digest('hex');
  } catch (err) {
    if (isMissingPathError(err)) return 'unverified';
    throw citationReadError(err, file);
  }
}

function enforceAllowedSet(
  allowed: readonly string[],
  field: 'kind' | 'status',
  value: string
): void {
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new InvalidArgumentError(
      field,
      `"${value}" is not in this project's allowed ${field} set`
    );
  }
}

/**
 * `project_policy.requiredFields` is generic, operator-configurable data
 * (§2) — it has no awareness of this verb's own find-or-mint/resolve-only
 * distinctions. Run it against the RESOLVED values (`component`/`kind`/
 * `status` are always a non-blank name by the time this runs — resolved
 * from a given ref, or minted, or defaulted, §6.1/§8 AC-23), never the raw
 * caller input (BUG blind-review finding 4): AC-23's own guarantee is that
 * omitting `component` NEVER throws, and a raw-input check would make an
 * operator-configured `requiredFields: ['component']` violate that
 * regardless of caller intent. Checking the resolved value instead makes
 * the guarantee hold unconditionally, because a resolved `component` is
 * never blank. `priority` stays genuinely optional per its own doc comment
 * (line ~60) — if a project's policy lists it as required and the caller
 * omitted it, `resolvedValues.priority` is `undefined` and this correctly
 * throws; that is the field's documented no-fallback behavior, not a bug.
 */
function enforceRequiredFields(
  required: readonly string[],
  resolvedValues: Record<string, unknown>
): void {
  for (const field of required) {
    const value = resolvedValues[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0)
    ) {
      throw new InvalidArgumentError(
        field,
        "is required by this project's field policy"
      );
    }
  }
}

/**
 * Resolves {@link ICreateIssueInput.dedupeExcludeUid} (a parent uid) to the
 * set of issue rowids the duplicate scan must EXCLUDE: the declared parent
 * itself PLUS its `part_of` ancestor chain (defect c5460239).
 *
 * `part_of` is declared `issue → issue` and `n:1` on its source — one parent
 * per item (`relate.ts`, `catalog.ts`'s `EDGE_KIND_TABLE`) — so the walk is
 * LINEAR: from the parent, follow its own outgoing `part_of` edge to the
 * grandparent, and so on. A `seen` set bounds the loop so a cycle (impossible
 * by construction, not DB-enforced) terminates rather than spins. A live
 * `part_of` edge may name a node that is later soft-deleted; a missing or
 * `t_invalid` ancestor simply ends the walk.
 *
 * Errors: `resolveIssueByUid` resolves the uid through
 * `query/resolve.ts`'s `resolveUidPrefix`, so this can throw
 * `IssueNotFoundError` (no live `issue` matches), `AmbiguousReferenceError`
 * (a uid prefix matching ≥2 live issues), `InvalidArgumentError` (a uid
 * attempt shorter than the minimum prefix length, via `tooShortUidError`), or
 * `StaleSupersedeError` (the uid names a superseded issue). The declaration is
 * a caller assertion, and failing loud (rather than silently ignoring the
 * hint) is what stops a typo'd parent from re-enabling the very suppression
 * this field exists to avoid (ADR-0002 D5).
 */
async function resolveDedupeExcludeIds(
  graph: GraphBackend,
  dedupeExcludeUid: string
): Promise<Set<number>> {
  const parent = await resolveIssueByUid(graph, dedupeExcludeUid);
  const excluded = new Set<number>([parent.id]);
  let cursor = parent;
  for (;;) {
    const edges = await graph.getEdges({ src: cursor.id, rel: 'part_of' });
    const ancestorId = edges[0]?.dst;
    if (ancestorId === undefined || excluded.has(ancestorId)) break;
    const [ancestor] = await graph.getNodesByIds([ancestorId]);
    if (!ancestor || ancestor.tInvalid !== undefined) break;
    excluded.add(ancestor.id);
    cursor = ancestor;
  }
  return excluded;
}

/**
 * C9 AC7 — the filing item's own (the "A") side of the cross-project
 * structural signal: its citation tokens plus its resolved owning component's
 * `meta.path`. The candidate ("B") side is read off a stored issue by
 * {@link structuralContextFor}; this derives the not-yet-written subject from
 * `createIssue`'s own input, using the SAME citation fields the B-side
 * derivation reads (`file`→`target`, `symbol`, `blastRadius`) so the two sides
 * can never disagree on what a citation token is.
 *
 * The component path is resolved READ-ONLY and best-effort: an explicit
 * `component` ref resolves scoped to `project` (a uid belonging to another
 * project never matches), and an omitted ref mirrors the write path's reserved
 * `(root)` default. The structural signal is only ever ADDITIVE evidence gating
 * an already-thresholded cosine, so a resolution miss contributes no path
 * rather than failing a filing.
 */
async function filingStructuralContext(
  graph: GraphBackend,
  project: IResolvedProjectRow,
  citations: readonly ICitationInput[],
  componentRef: string | undefined
): Promise<{ citationTokens: string[]; componentPath?: string }> {
  const citationTokens: string[] = [];
  for (const citation of citations) {
    citationTokens.push(citation.file);
    if (typeof citation.symbol === 'string')
      citationTokens.push(citation.symbol);
    if (typeof citation.blastRadius === 'string')
      citationTokens.push(citation.blastRadius);
  }

  let componentPath: unknown;
  if (componentRef !== undefined) {
    const resolved = await tryResolveComponentRef(
      graph,
      project.uid,
      componentRef
    );
    componentPath = resolved?.record.metadata?.path;
  } else {
    const ownsProjectEdges = await graph.getEdges({
      src: project.rowid,
      rel: 'owns_project',
    });
    const components = await graph.getNodesByIds(
      ownsProjectEdges.map((e) => e.dst)
    );
    const root = components.find(
      (c) => c.tInvalid === undefined && c.name === '(root)'
    );
    componentPath = root?.metadata?.path;
  }

  return {
    citationTokens,
    ...(typeof componentPath === 'string' ? { componentPath } : {}),
  };
}

/**
 * §6.4 point 1: `createIssue`'s app-level pre-write similarity scan — never
 * the library's disabled content-hash path (§1's `skipDedupe:true` is
 * untouched by this function). Runs `StoreSearchBackend.search` scoped to
 * `project` (never cross-project) over `{title, body}`, exactly as §6.4
 * specifies, with two documented, deliberate departures from a literal
 * reading:
 *
 * 1. **The score is a cosine, and only ever a cosine.** §6.4 compares a
 *    candidate's score against `project_policy.dedupe_threshold`, whose
 *    documented default is `0.8` on a `[0,1]` similarity scale
 *    (`catalog.ts`'s `DEFAULT_PROJECT_POLICY`). The only quantity on that
 *    scale is the vector channel's cosine, so that is what this gate reads —
 *    `StoreSearchBackend.search`'s raw `vecScore`, which comes straight off
 *    `vec.knn` (`store/semantic-search.ts`'s `SemanticMatch.score`: "a
 *    similarity score, HIGHER-IS-BETTER"). It deliberately does NOT use the
 *    sibling `searchRanked` entry point: that fuses channels by
 *    reciprocal-rank fusion, which discards magnitude by construction, so no
 *    rescaling of its output — including dividing by its theoretical rank-1
 *    maximum, which this function previously did — can recover a similarity
 *    from it. That rescaling produced a rank ladder (rank 1 → 1.0, rank 2 →
 *    ~0.984, rank 5 → ~0.938) sitting entirely above the 0.8 default, which
 *    suppressed every create into a project holding any prior issue.
 * 2. **Degraded (no calibrated vector channel) mode is REPORTED, never
 *    silently empty.** §6.4 point 4 anticipates the semantic substrate being
 *    unavailable and asks the gate not to "go dark" silently. This gate can
 *    only ever compare a candidate against `dedupe_threshold` with a
 *    calibrated cosine (`vecScore`), so when the vector channel cannot run
 *    there is no comparable score at all — BM25 is deliberately NOT
 *    substituted (see bullet 1's false-positive class). The previous
 *    implementation collapsed "could not scan" into the same empty
 *    `IDuplicateCandidate[]` as "scanned and found nothing", so
 *    `duplicateAction:'abort'` FAILED OPEN whenever the substrate was
 *    degraded (BUG 4e8fce2a). The scan now returns an
 *    {@link IDuplicateScanOutcome} whose `degraded` flag (with a concrete
 *    {@link DuplicateScanDegradedReason}) distinguishes the two, and
 *    `createIssue` discriminates on the REASON: it fails `'abort'` closed only
 *    for `no-embed-query` (a configuration absence that can never resolve),
 *    and PROCEEDS with the signal for the transient `no-vector-scores` (at
 *    read time indistinguishable from benign on-write embedding lag) and for
 *    the unwired `no-search-backend` — rather than blocking a legitimate
 *    create on a state that is not a detectable duplicate.
 *
 * `dedupeExcludeUid` (when supplied) is resolved and excluded FIRST, before
 * any return path below: the declared parent and every `part_of` ancestor are
 * removed from the candidate set, and the resolution failure fires whether or
 * not the project holds any other issue (c5460239). Resolving that uid runs
 * through `resolveIssueByUid` → `resolveUidPrefix`, so it can throw
 * `IssueNotFoundError` (no live `issue` matches), `AmbiguousReferenceError` (a
 * uid prefix matching ≥2 live issues), `InvalidArgumentError` (a too-short uid
 * prefix, via `tooShortUidError`), or `StaleSupersedeError` (a superseded
 * issue) — NOT only `IssueNotFoundError`. Treating a resolved-but-now-empty
 * candidate set as a COMPLETE scan of zero candidates (never a degraded one)
 * is what lets a child that restates its parent create.
 *
 * Returns `{candidates:[], degraded:false}` (the `dedupeExcludeUid`
 * resolution errors above are its only throws, and only when a uid was
 * supplied) when: the scan is
 * a COMPLETE scan of nothing — `project_policy.dedupe_scan_enabled` is
 * `false`, or the project has zero existing issues to compare against, or
 * every existing candidate was the declared parent/ancestor.
 * Returns `{candidates:[], degraded:true, degradedReason}` when the scan could
 * not run a calibrated comparison despite issues to compare against: no
 * search backend mounted (`'no-search-backend'`), no `embedQuery`
 * (`'no-embed-query'`), or the vector channel yielded no `vecScore` at all
 * (`'no-vector-scores'` — an empty or `modelId`-mismatched space). Only
 * `'no-embed-query'` makes `createIssue`'s `'abort'` fail closed; the other
 * two carry the signal and proceed. On a
 * healthy scan, returns the candidates AT OR ABOVE
 * `project_policy.dedupe_threshold`, best-first — never the raw, unfiltered
 * top-N — with `degraded:false`.
 */
async function scanForDuplicates(
  handle: IDuplicateScanHandle,
  project: IResolvedProjectRow,
  policy: IProjectPolicy,
  title: string,
  body: string,
  citations: readonly ICitationInput[],
  componentRef: string | undefined,
  dedupeExcludeUid?: string
): Promise<IDuplicateScanOutcome> {
  // The scan itself now lives in the SHARED `write/similarity-scan.ts` — the
  // exact same scan the `view:'similar'` cluster block runs (C9). This wrapper
  // only: (a) resolves the declared-parent exclusion (defect c5460239), which
  // must fail loud BEFORE any early return; (b) maps the shared outcome back
  // onto this gate's `IDuplicateScanOutcome`; and (c) preserves every
  // degraded-mode distinction the shipped fail-closed guard depends on
  // (BUG 4e8fce2a) — the shared scan carries the same reason union.
  const dedupeExcludeIds =
    dedupeExcludeUid !== undefined && handle.graph !== undefined
      ? await resolveDedupeExcludeIds(handle.graph, dedupeExcludeUid)
      : undefined;
  // A COMPLETE (if empty) scan, never a degraded one: an explicit operator
  // opt-out is a deliberate "do not scan", not a scan that failed to run.
  if (!policy.dedupeScanEnabled)
    return { candidates: [], similarCandidates: [], degraded: false };

  // C9 AC7 — the filing item's own ("A") structural context. Without it the
  // cross-project guard's only usable signal is title-token Jaccard, so a
  // genuine cross-project twin that shares a cited file or a nested component
  // path but is worded differently would never surface even at cosine 1.0.
  // Best-effort: a graph-less handle simply contributes no structural signal.
  const structuralA =
    handle.graph !== undefined
      ? await filingStructuralContext(
          handle.graph,
          project,
          citations,
          componentRef
        )
      : undefined;

  const outcome = await scanSimilarCandidatesWithMeta(handle, {
    title,
    body,
    scope: policy.similarityScope,
    projectUid: project.uid,
    sameProjectThreshold: policy.dedupeThreshold,
    crossProjectThreshold: policy.similarityCrossProjectThreshold,
    margin: policy.similarityCrossProjectMargin,
    tokenOverlapMin: policy.similarityCrossProjectTokenOverlap,
    citationTokens: structuralA?.citationTokens,
    componentPath: structuralA?.componentPath,
    excludeIds: dedupeExcludeIds,
  });

  // The WRITE gate is same-project only (§6.4; AC1/AC3). A cross-project
  // candidate is advisory: it is reported on `similarCandidates`, NEVER
  // suppresses a create, NEVER fires `comment`, and the scan writes no edge.
  const candidates: IDuplicateCandidate[] = outcome.candidates
    .filter((c) => c.scope === 'same-project')
    .map((c) => ({ uid: c.uid, title: c.title, score: c.score }));
  const similarCandidates = outcome.candidates.filter(
    (c) => c.scope === 'cross-project'
  );
  return {
    candidates,
    similarCandidates,
    degraded: outcome.degraded,
    ...(outcome.degradedReason !== undefined
      ? { degradedReason: outcome.degradedReason }
      : {}),
  };
}

/**
 * Create a new issue (§4, §6.3.2). One `immediate` transaction; `skipDedupe:
 * true` on every entity write (§1) via `writeNodeTx`.
 *
 * Errors: `InvalidArgumentError` (missing/blank `title`/`body`/`project`/`by`,
 * or a blank `citations[i].file`), `CatalogNotFoundError('project'|'component'|
 * 'kind'|'status'|'priority'|'agent', ref)` (`'component'` fires only when a
 * name/uid was GIVEN and did not resolve — omitting `component` never throws
 * it), `CitationUnverifiableError(file, allowedExternalRoots)` (policy-gated
 * via `project_policy.citation_requires_sha`, and only when the project has a
 * known `path` — a path-less project records `sha:"unverified"` verbatim; a
 * path-present project still rejects a target whose canonical path lies
 * outside the project root AND every `citationAllowedExternalRoots` entry —
 * the carve-out, BUG c6d35272 — and the error names those roots),
 * `InvalidArgumentError('duplicateAction', ...)`
 * (an unrecognized value — §6.4), the `dedupeExcludeUid` resolution errors
 * (`IssueNotFoundError` / `AmbiguousReferenceError` / `InvalidArgumentError` /
 * `StaleSupersedeError` — via `resolveIssueByUid`, see
 * {@link resolveDedupeExcludeIds}) when a `dedupeExcludeUid` was supplied but
 * does not resolve to a live, non-superseded `issue` — fail loud, ADR-0002 D5;
 * c5460239),
 * `WriteContentionError`/
 * `WriteIOError` (§4c — an exhausted driver-level retry on the underlying
 * `immediate` transaction).
 */
export async function createIssue(
  handle: IWriteStoreHandle & IDuplicateScanHandle,
  input: ICreateIssueInput
): Promise<ICreateIssueResult> {
  // §6.3's opening rule + §6.3.2's own required-field list — validated
  // before any driver call runs (E_VALIDATION, never retried, §4c).
  assertNonBlank('title', input.title);
  assertNonBlank('body', input.body);
  assertNonBlank('project', input.project);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  assertGitContextWithinCap(input.gitContext);
  const citations = input.citations ?? [];
  citations.forEach((citation, i) =>
    assertNonBlank(`citations[${i}].file`, citation.file)
  );

  // The item-level git context, normalized to `undefined` for a blank/absent
  // value so the metadata write and the echoed-back card both treat
  // "not supplied" and "supplied blank" identically — a blank disclosure
  // element is never stored.
  const gitContext =
    typeof input.gitContext === 'string' && input.gitContext.trim().length > 0
      ? input.gitContext
      : undefined;

  const duplicateAction: DuplicateAction = input.duplicateAction ?? 'abort';
  if (
    input.duplicateAction !== undefined &&
    !DUPLICATE_ACTIONS.includes(input.duplicateAction)
  ) {
    throw new InvalidArgumentError(
      'duplicateAction',
      `must be one of ${DUPLICATE_ACTIONS.map((a) => `'${a}'`).join(
        '|'
      )}, got "${input.duplicateAction}"`
    );
  }

  // BUG blind-review finding 2: every citation's `sha` is computed HERE,
  // before `executeWriteTransaction` ever opens the `immediate`-mode
  // transaction, never inside it. `handle.adapter` (a `StoreAdapter`) is a
  // structural superset of `AdapterTransaction` — it exposes the same
  // `executeGet`/`executeAll`/`executeRun`/`exec` — so `resolveProjectTx`
  // can run this same pre-resolve as a plain autocommit read with no lock
  // held, letting `computeCitationSha`'s `fs.readFile` calls run entirely
  // OUTSIDE any write-lock scope. `citation_requires_sha` is enforced here
  // too, for the same reason: it is a pure `E_VALIDATION` decision (no
  // driver call needed to make it) and belongs with every other
  // before-the-transaction check this file already runs (`assertNonBlank`
  // above). The write transaction below re-resolves `project` (and
  // therefore `policy`) fresh against its own `tx` handle — it never reuses
  // the rowid/metadata read here — so the actual writes are authoritative
  // against the transaction's own snapshot; only the already-computed
  // `sha` STRINGS are carried in.
  //
  // Window this opens (deliberately accepted, per finding 2's own ask): a
  // cited file can change or be deleted between this pre-resolve hash and
  // the transaction's commit. §8.5 already documents `citation.sha` as a
  // best-effort content-address computed "on the live write path", not a
  // durable integrity guarantee that continues to hold after the citation
  // is filed (nothing revalidates it later either, e.g. on read) — so a
  // TOCTOU on file *content* here is the same pre-existing best-effort
  // window this design always had, just shortened rather than widened: the
  // OLD code re-read every citation file again on every `E_CONTENTION`
  // retry (a strictly WIDER, per-retry re-open window on the same file),
  // where this fix reads each file exactly once no matter how many times
  // the surrounding transaction retries.
  const preResolvedProject = await resolveProjectTx(
    handle.adapter,
    input.project
  );
  const preResolvedPolicy = resolveProjectPolicy(preResolvedProject);
  // Sibling registered projects contribute their own roots so a cross-repo
  // citation is probed against the project that owns the file (AC4), never
  // falsely `unverified`.
  const preSiblingRoots = await resolveSiblingProjectRootsTx(
    handle.adapter,
    preResolvedProject.uid
  );
  const citationShas: string[] = [];
  // The `citationRequiresSha` gate applies only where verification is
  // POSSIBLE: a project with a known `path`. A path-less project can never
  // hash a citation (every target degrades to `"unverified"` at
  // `computeCitationSha`'s first branch), so the gate has nothing to reject —
  // the citation is accepted and `sha:"unverified"` is persisted verbatim,
  // exactly as the ETL's own `computeCitationSha` already does. The hard-fail
  // is preserved for a path-PRESENT project whose cited file is missing (or
  // whose CANONICAL path lies outside the project root AND every
  // `citationAllowedExternalRoots` entry — the carve-out, BUG c6d35272):
  // each still resolves to `"unverified"` and still throws, and the message
  // names the allowed roots.
  for (const citation of citations) {
    const sha = await computeCitationSha(
      preResolvedProject,
      citation.file,
      preResolvedPolicy.citationAllowedExternalRoots,
      preSiblingRoots
    );
    if (sha === 'unverified' && preResolvedPolicy.citationRequiresSha) {
      if (projectHasKnownPath(preResolvedProject)) {
        throw new CitationUnverifiableError(
          citation.file,
          preResolvedPolicy.citationAllowedExternalRoots
        );
      }
      // Observability for the deliberate path-less waiver (DEBT a934e089).
      // The gate above is enforced only where verification is POSSIBLE, so for
      // a project with no `metadata.path` the caller's default
      // `citation_requires_sha: true` is a silent no-op and `sha:"unverified"`
      // is persisted verbatim. That waiver is correct (§8.5) but would
      // otherwise be INVISIBLE — the operator set a policy and never learns it
      // did not apply. A log is the whole fix: NOT a second audit row, which
      // SPEC §4a's one-audit-node-per-state-change contract forbids for a
      // branch that changes no state.
      console.error(
        `createIssue: citation_requires_sha waived for path-less project uid="${preResolvedProject.uid}" — cannot verify citation "${citation.file}", persisting sha:"unverified" (set the project's metadata.path to make citation_requires_sha enforceable).`
      );
    }
    citationShas.push(sha);
  }

  // §6.4 point 1: the scan runs BEFORE the `immediate` transaction opens —
  // the scan is an external, potentially network-backed round-trip
  // (an embedding-service call), and holding the RESERVED lock across it
  // would stall every other concurrent writer for its duration. Deliberately
  // NOT a CAS (§6.4 point 1's own accepted-gap framing) — see
  // `scanForDuplicates`'s doc comment.
  const scan = await scanForDuplicates(
    handle,
    preResolvedProject,
    preResolvedPolicy,
    input.title,
    input.body,
    citations,
    input.component,
    input.dedupeExcludeUid
  );
  const { candidates: duplicateCandidates } = scan;
  const similarCandidates = scan.similarCandidates ?? [];

  // C9 (AC3) — `comment` attaches a note to the TOP candidate's issue. A
  // cross-project top candidate would mean writing into a FOREIGN project,
  // which is exactly the false-link/over-merge class this feature must never
  // perform. Reject it outright; the caller must pick a same-project candidate
  // or a different `duplicateAction`.
  if (duplicateAction === 'comment') {
    const topSame = duplicateCandidates[0];
    const topCross = similarCandidates[0];
    if (topCross && (!topSame || topCross.score > topSame.score)) {
      throw new InvalidArgumentError(
        'duplicateAction',
        `"comment" cannot target a cross-project candidate (top cross-project match uid="${topCross.uid}", project "${
          topCross.provenance?.projectUid ?? '?'
        }") — a reviewed similar_to link is written with relate; comment may only attach to a same-project duplicate`
      );
    }
  }

  // BUG 4e8fce2a — a DEGRADED scan must never be silently treated as "no
  // candidates" when the caller asked to be protected from duplicates.
  // `duplicateAction:'abort'` is exactly that request. The degraded shapes are
  // discriminated by REASON, because only one of them is a persistent
  // configuration absence that can never resolve on its own:
  //
  //  - `no-embed-query`: the backend is mounted but wired WITHOUT
  //    `embedQuery`, so the calibrated (vector) channel can NEVER run — a
  //    persistent configuration absence the operator must fix. `abort` fails
  //    CLOSED: nothing is written and the refusal is surfaced
  //    (`reason:'duplicate-scan-degraded'`).
  //  - `no-vector-scores`: the calibrated channel ran but no in-scope
  //    candidate carried a `vecScore` (an empty or `modelId`-mismatched
  //    space). At read time this is INDISTINGUISHABLE from benign on-write
  //    embedding lag — on-write embedding is fire-and-forget by default
  //    (`awaitEmbed` is opt-in and no production caller sets it), so a rapid
  //    second create into a not-yet-embedded project is a normal transient,
  //    NOT a broken install. Filing therefore PROCEEDS and carries the
  //    `duplicateScanDegraded` signal below; refusing here would wrongly block
  //    a legitimate create (§6.4: the miss is "a missed warning, not a
  //    correctness defect").
  //  - `no-search-backend`: the operator never mounted semantic dedupe at all.
  //    Filing must not hard-fail merely because the feature is unwired (§6.4
  //    point 4 and `IDuplicateScanHandle`'s own posture), so it also PROCEEDS
  //    — carrying the signal, so it is never SILENT about it.
  //
  // Either way this leaves the genuine zero-candidate case (an empty project,
  // `degraded:false`) proceeding exactly as §6.4 point 3 specifies.
  // `'force'`/`'comment'` are explicit "write anyway"/"attach anyway" intents
  // and proceed, but still carry the degradation signal.
  if (
    scan.degraded &&
    scan.degradedReason === 'no-embed-query' &&
    duplicateAction === 'abort'
  ) {
    return {
      created: false,
      reason: 'duplicate-scan-degraded',
      duplicateScanDegraded: true,
      ...(scan.degradedReason !== undefined
        ? { duplicateScanDegradedReason: scan.degradedReason }
        : {}),
    };
  }

  // §6.4 point 3: `'abort'` (default) with ≥1 candidate at/above threshold —
  // nothing is written, not even inside a transaction that immediately rolls
  // back. This is the ONLY branch that returns before `executeWriteTransaction`
  // is ever called.
  if (duplicateCandidates.length > 0 && duplicateAction === 'abort') {
    return {
      created: false,
      reason: 'duplicate-suppressed',
      duplicateCandidates,
      ...(similarCandidates.length > 0 ? { similarCandidates } : {}),
    };
  }

  // The degradation signal carried onto every PROCEEDING outcome (force,
  // comment, and the unconfigured-backend abort path) so a caller always
  // learns the scan did not actually run a calibrated comparison. Empty on a
  // healthy scan, so those results are byte-for-byte unchanged.
  const degradedSignal = scan.degraded
    ? {
        duplicateScanDegraded: true as const,
        ...(scan.degradedReason !== undefined
          ? { duplicateScanDegradedReason: scan.degradedReason }
          : {}),
      }
    : {};

  // §4b/§8 AC-4 — captured from INSIDE the transaction closure (the only
  // place the freshly-minted issue's rowid is ever in scope) but read only
  // AFTER `executeWriteTransaction` resolves below, never used to trigger an
  // embed from inside the closure itself (§4b: "AFTER the write layer's
  // `immediate` transaction has committed... never inside it"). Stays
  // `undefined` on every branch that writes NO issue node — `'abort'`
  // (already returned above, before this point) and `'comment'` (writes only
  // a `note`) — so neither path schedules a spurious embed.
  let embeddedIssue: { rowid: number; uid: string } | undefined;

  const outcome = await executeWriteTransaction(
    handle,
    async (tx: AdapterTransaction) => {
      // ONE timestamp for every row this logical write produces — the catalog
      // mints, the issue node, each citation node, and every edge. Captured here
      // rather than just before the issue INSERT because the kind/status/priority/
      // agent mints happen first, and letting each `writeNodeTx` stamp its own
      // `nowISO()` is what made a single `createIssue` write rows with differing
      // `t_created`, drifting from both the returned `createdAt` and the audit's `at`.
      const now = nowISO();

      // §6.4 point 3: `'comment'` with ≥1 candidate at/above threshold — no
      // issue node, no catalog resolution/minting, no edges beyond `has_note`.
      // Still inside the SAME `immediate` transaction every write verb opens
      // exactly once per invocation (§4c) — never a second, nested call.
      if (duplicateCandidates.length > 0 && duplicateAction === 'comment') {
        const [topCandidate] = duplicateCandidates;
        const targetIssue = await resolveLiveIssueTx(tx, topCandidate.uid);
        const noteText = `${input.title}\n\n${input.body}`;
        const noteNode = await writeNodeTx(tx, {
          kind: 'note',
          content: noteText,
          metadata: { author: input.by, text: noteText, at: now },
          at: now,
        });
        const hasNoteRule = await resolveEdgeKindTx(tx, 'has_note');
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: targetIssue.rowid,
          srcUid: targetIssue.uid,
          srcKind: 'issue',
          dstRowid: noteNode.rowid,
          dstUid: noteNode.uid,
          dstKind: 'note',
          rel: 'has_note',
          rule: hasNoteRule,
          typePolicy: handle.typePolicy,
        });
        return {
          created: false,
          commentedOn: { uid: targetIssue.uid, noteId: noteNode.uid },
          duplicateCandidates,
          ...(similarCandidates.length > 0 ? { similarCandidates } : {}),
          ...degradedSignal,
        };
      }

      const project = await resolveProjectTx(tx, input.project);
      const policy = resolveProjectPolicy(project);

      const component: IResolvedCatalogRow =
        input.component !== undefined
          ? await resolveComponentTx(tx, {
              projectUid: project.uid,
              ref: input.component,
            })
          : await resolveDefaultComponentTx(tx, {
              projectRowid: project.rowid,
            });
      // C1 AC8 — a supplied component that resolved is 'explicit'; none
      // supplied means the reserved `(root)` default was used. A supplied
      // component that failed to resolve threw above, so it is never here.
      const placementResolved: 'explicit' | 'default-root' =
        input.component !== undefined ? 'explicit' : 'default-root';

      const kindName = input.kind ?? policy.defaultKind ?? 'issue';
      const kindRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'kind',
        ref: kindName,
        at: now,
      });
      enforceAllowedSet(policy.allowedKinds, 'kind', kindRow.name);

      const statusName = input.status ?? policy.defaultStatus ?? 'open';
      // `mintOrResolveStatusTx` seeds `terminal` from the frozen reserved table
      // (`catalog.ts`) on a miss — never a hardcoded `terminal:false` here. A
      // reserved terminal name (`closed`, …) seeds `terminal:true`; every other
      // name keeps the `terminal:false` default (SPEC.md §6.3.2). See that
      // function's doc comment for why the seed, not a read-time name, is the
      // source of truth (ADR-0002 D1).
      const statusRow = await mintOrResolveStatusTx(tx, {
        ref: statusName,
        at: now,
      });
      enforceAllowedSet(policy.allowedStatuses, 'status', statusRow.name);

      let priorityRow: IResolvedCatalogRow | undefined;
      if (input.priority !== undefined) {
        priorityRow = await mintOrResolveCatalogTx(tx, {
          catalogKind: 'priority',
          ref: input.priority,
          at: now,
          mintMetadata: async (mintTx) => ({
            rank: await nextPriorityRankTx(mintTx),
          }),
        });
      }

      const authorName = input.author ?? input.by;
      const authorRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'agent',
        ref: authorName,
        at: now,
      });

      enforceRequiredFields(policy.requiredFields, {
        ...input,
        component: component.name,
        kind: kindRow.name,
        status: statusRow.name,
        priority: priorityRow?.name,
      });

      // C6 — seed the monotonic content revision (never-mutated issue reads 0;
      // this makes it explicit on first write rather than relying on the default).
      const issueMetadata: Record<string, unknown> = { revision: 0 };
      if (input.assignee !== undefined) issueMetadata.assignee = input.assignee;
      if (gitContext !== undefined) issueMetadata.gitContext = gitContext;

      const issue = await writeNodeTx(tx, {
        kind: 'issue',
        name: input.title,
        content: input.body,
        metadata: issueMetadata,
        at: now,
      });
      embeddedIssue = { rowid: issue.rowid, uid: issue.uid };

      const ownsComponentRule = await resolveEdgeKindTx(tx, 'owns_component');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: component.rowid,
        srcUid: component.uid,
        srcKind: 'component',
        dstRowid: issue.rowid,
        dstUid: issue.uid,
        dstKind: 'issue',
        rel: 'owns_component',
        rule: ownsComponentRule,
        typePolicy: handle.typePolicy,
      });

      const hasKindRule = await resolveEdgeKindTx(tx, 'has_kind');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: issue.rowid,
        srcUid: issue.uid,
        srcKind: 'issue',
        dstRowid: kindRow.rowid,
        dstUid: kindRow.uid,
        dstKind: 'kind',
        rel: 'has_kind',
        rule: hasKindRule,
        typePolicy: handle.typePolicy,
      });

      const hasStatusRule = await resolveEdgeKindTx(tx, 'has_status');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: issue.rowid,
        srcUid: issue.uid,
        srcKind: 'issue',
        dstRowid: statusRow.rowid,
        dstUid: statusRow.uid,
        dstKind: 'status',
        rel: 'has_status',
        rule: hasStatusRule,
        typePolicy: handle.typePolicy,
      });

      if (priorityRow) {
        const hasPriorityRule = await resolveEdgeKindTx(tx, 'has_priority');
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: issue.rowid,
          srcUid: issue.uid,
          srcKind: 'issue',
          dstRowid: priorityRow.rowid,
          dstUid: priorityRow.uid,
          dstKind: 'priority',
          rel: 'has_priority',
          rule: hasPriorityRule,
          typePolicy: handle.typePolicy,
        });
      }

      const authoredByRule = await resolveEdgeKindTx(tx, 'authored_by');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: issue.rowid,
        srcUid: issue.uid,
        srcKind: 'issue',
        dstRowid: authorRow.rowid,
        dstUid: authorRow.uid,
        dstKind: 'agent',
        rel: 'authored_by',
        rule: authoredByRule,
        typePolicy: handle.typePolicy,
      });

      if (citations.length > 0) {
        const hasCitationRule = await resolveEdgeKindTx(tx, 'has_citation');
        for (let i = 0; i < citations.length; i += 1) {
          const citation = citations[i];
          // §8.5's sha is already computed (and policy-gated) BEFORE this
          // transaction opened, above — see the `preResolvedProject`/
          // `citationShas` block. This loop only writes the already-decided
          // value; it never re-reads the filesystem inside the write lock
          // (BUG blind-review finding 2).
          const sha = citationShas[i];
          const citationNode = await writeNodeTx(tx, {
            at: now,
            kind: 'citation',
            name: citation.file,
            content: citation.context ?? citation.file,
            metadata: {
              target: citation.file,
              target_type: 'path',
              sha,
              line: citation.lines ?? null,
              at: now,
              symbol: citation.symbol ?? null,
              blastRadius: citation.blastRadius ?? null,
            },
          });
          await writeEdgeTx(tx, {
            at: now,
            srcRowid: issue.rowid,
            srcUid: issue.uid,
            srcKind: 'issue',
            dstRowid: citationNode.rowid,
            dstUid: citationNode.uid,
            dstKind: 'citation',
            rel: 'has_citation',
            rule: hasCitationRule,
            typePolicy: handle.typePolicy,
          });
        }
      }

      await writeAudit({
        tx,
        typePolicy: handle.typePolicy,
        subjectRowid: issue.rowid,
        subjectUid: issue.uid,
        subjectKind: 'issue',
        actor: input.by,
        action: 'created',
        at: now,
      });

      return {
        created: true,
        uid: issue.uid,
        item: {
          uid: issue.uid,
          title: input.title,
          kind: kindRow.name,
          status: statusRow.name,
          priority: priorityRow?.name,
          project: project.uid,
          component: component.uid,
          createdAt: now,
          assignee: input.assignee,
          author: authorRow.name,
          ...(gitContext !== undefined ? { gitContext } : {}),
        },
        // §6.4 point 3: present on `'force'` when the scan found ≥1 candidate
        // (reported for the caller's own audit trail even though the write
        // proceeded) — absent on a zero-candidate scan, per this file's own
        // `ICreateIssueResult` doc comment.
        ...(duplicateCandidates.length > 0 ? { duplicateCandidates } : {}),
        ...(similarCandidates.length > 0 ? { similarCandidates } : {}),
        ...degradedSignal,
        placementResolved,
      };
    }
  );

  // §4b/§8 AC-4 — strictly AFTER `executeWriteTransaction` above has
  // resolved, i.e. after the subject transaction committed and released its
  // RESERVED lock (`embedding-observer.ts`'s own doc comment). `embeddedIssue`
  // is set only on the genuine-create branch (never `'abort'`/`'comment'`,
  // see its own declaration above).
  if (embeddedIssue) {
    const embedPromise = scheduleIssueEmbedding(handle, {
      action: 'upsert',
      subjectRowid: embeddedIssue.rowid,
      subjectUid: embeddedIssue.uid,
      actor: input.by,
      content: composeEmbedText(input.title, input.body),
    });
    if (input.awaitEmbed) await embedPromise;
    else
      embedPromise.catch(() => {
        /* scheduleIssueEmbedding never rejects — this catch exists only to silence an unhandled-rejection warning if that contract is ever broken. */
      });
  }

  return outcome;
}
