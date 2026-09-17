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
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { GraphBackend } from '@adhd/sox-graph-store';
import type {
  SearchQuery,
  SignalSpec,
  StoreSearchBackend,
} from '@adhd/sox-hybrid-search';
import {
  type IProjectPolicy,
  type IResolvedCatalogRow,
  type IResolvedProjectRow,
  mintOrResolveCatalogTx,
  nextPriorityRankTx,
  resolveComponentTx,
  resolveDefaultComponentTx,
  resolveEdgeKindTx,
  resolveProjectPolicy,
  resolveProjectTx,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  composeEmbedText,
  scheduleIssueEmbedding,
} from './embedding-observer.js';
import {
  CitationUnverifiableError,
  InvalidArgumentError,
  WriteIOError,
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
// Read-only reuse of the query layer's own, direction-bug-fixed project/
// component ownership-chain resolver (SPEC.md §6.4 point 1: the duplicate
// scan is scoped to `filter.project`, "the target project only" — never a
// second, hand-rolled traversal of `owns_project`/`owns_component` here).
// This is an IMPORT, not an edit, of a file this slice does not own
// (`src/query/**`) — see this module's own `IDuplicateScanHandle` doc
// comment for why the two packages' handle shapes are structurally, not
// nominally, compatible.
import { resolveSimilarFilterIds } from '../query/views/semantic.js';
import type { IIssueFilter } from '../query/types.js';

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
  /** catalog name or uid; default is `policy.defaultStatus`, falling back to the global `"open"` row (minted with `terminal:false` if it does not yet exist). An unresolved NAME mints with `terminal:false`; a uid-shaped ref that does not resolve throws (§6.1). */
  status?: string;
  /** catalog name or uid; genuinely OPTIONAL — §6.3.2 states minting behavior for a GIVEN unresolved name but, unlike `kind`/`status`, states no fallback for the omitted case; omitted therefore writes no `has_priority` edge at all (a deliberate reading of §6.3.2's more precise per-field text over §4's summary prose — see this project's own README/CHANGELOG note on this slice for the citation). An unresolved NAME mints with `rank` = one past the current max (lowest urgency); a uid-shaped ref that does not resolve throws. */
  priority?: string;
  citations?: ICitationInput[];
  /** catalog agent name/uid; defaults to `by`. An unresolved NAME mints; a uid-shaped ref that does not resolve throws (§6.1). */
  author?: string;
  /** Plain metadata scalar (§6.2) — no edge. */
  assignee?: string;
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
   *   reason:'duplicate-suppressed', duplicateCandidates}`.
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
 * express §6.4 point 4's degraded case: a `StoreSearchBackend` can be wired
 * (FTS/text always available, since it runs off the graph store directly)
 * while no embedding model/vector space is configured — the search
 * itself stays callable, just scoped to `signals:[{text}]` rather than
 * `signals:[{text},{vec}]` (and, having no vector channel, surfacing no
 * duplicate candidates — see {@link scanForDuplicates}). `search` itself stays OPTIONAL (no backend
 * mounted at all) for the same "never silently go dark" posture §6.4 point 4
 * states, but applied one layer further out: `scanForDuplicates` treats a
 * wholly-absent backend as "scan unavailable" (zero candidates, `create`
 * proceeds normally) rather than throwing — filing an issue must never hard-
 * fail because the product-feature-only dedupe UX (§6.4's own framing: "a
 * missed warning, not a correctness defect") happens to be unwired in a given
 * environment.
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
 *   (`duplicateAction:'abort'`, the default).
 * - `commentedOn` — present iff `duplicateAction:'comment'` fired.
 * - `supersededUid` — always absent from `createIssue` alone; only the
 *   `supersedes` composition (§6.3.2, not yet built here) would set it.
 */
export interface ICreateIssueResult {
  created: boolean;
  uid?: string;
  item?: ICreateIssueCard;
  duplicateCandidates?: IDuplicateCandidate[];
  reason?: 'duplicate-suppressed';
  supersededUid?: string;
  commentedOn?: { uid: string; noteId: string };
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
 * §8.5's two-branch citation-sha rule, run identically at live-write time
 * (§8.5: "this is also the canonical rule for computing citation.sha on the
 * LIVE write path"). Confined to `project.metadata.path` (BUG blind-review
 * finding 1): a citation whose resolved path lands OUTSIDE the project root
 * — an absolute path anywhere else on the host, or a relative path that
 * walks back out via `../` — is treated identically to "file not found":
 * it returns `'unverified'`, never reads the file, and never throws a third
 * branch. This is a deliberate choice to keep §8.5's rule exactly
 * two-branched (project has no known path → unverified; file not
 * confirmed → unverified) rather than adding an escape-specific throw. It
 * still closes the reported hole: under the default
 * `project_policy.citation_requires_sha` (`true`), `'unverified'` is
 * REJECTED by `createIssue`'s own policy gate below, so an escaping path can
 * never satisfy that policy and can never be used as a
 * file-exists/readable oracle for paths outside the project — the read
 * itself never happens, so no distinguishable success/failure signal about
 * the escaped path ever reaches the caller.
 *
 * The confinement check uses `path.resolve` + `path.relative` (never a raw
 * string `startsWith` on `projectPath`, which a sibling directory sharing a
 * name prefix — e.g. `/repo` vs `/repo-evil` — would defeat).
 */
async function computeCitationSha(
  project: IResolvedProjectRow,
  file: string
): Promise<string> {
  const projectPath = project.metadata?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0)
    return 'unverified';

  const root = resolvePath(projectPath);
  const candidate = isAbsolute(file)
    ? resolvePath(file)
    : resolvePath(root, file);
  const rel = relative(root, candidate);
  const escapesRoot =
    rel === '..' ||
    rel.startsWith(`..${'/'}`) ||
    rel.startsWith('..\\') ||
    isAbsolute(rel);
  if (escapesRoot) return 'unverified';

  try {
    const content = await readFile(candidate);
    return createHash('sha256').update(content).digest('hex');
  } catch (err) {
    // §4c's error taxonomy, reused (never a parallel classification, BUG
    // blind-review finding 3): "the cited file genuinely is not there" is
    // the ONLY case that legitimately degrades to the `'unverified'`
    // sentinel — ENOENT (missing path segment) and ENOTDIR (a path segment
    // that should be a directory is a file, so the target cannot exist)
    // both mean exactly that. Any other failure (EACCES, EPERM, EMFILE,
    // EISDIR, ELOOP, …) is a REAL I/O failure, not a "file doesn't exist"
    // signal, and must surface as `WriteIOError` rather than silently
    // masquerade as an absent citation.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'unverified';
    throw new WriteIOError(err);
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
 * 2. **Degraded (no-embedding) mode.** §6.4 point 4: when the search
 *    substrate cannot embed (`search.embedQuery` absent — see
 *    {@link IDuplicateScanHandle}'s own doc comment), the scan still RUNS
 *    (`signals:[{text}]`, never skipped) rather than going dark. It simply
 *    surfaces no candidates, because with no vector channel there is no
 *    calibrated similarity to compare against the threshold — §6.4's own "a
 *    missed warning, not a correctness defect" trade, taken in the only
 *    direction that cannot produce false positives.
 *
 * Returns `[]` (never throws) when: `project_policy.dedupe_scan_enabled` is
 * `false`; no search backend is mounted at all (§6.4's "a missed warning,
 * not a correctness defect" framing, extended one layer further — see
 * {@link IDuplicateScanHandle}); or the project has zero existing issues to
 * compare against. Returns only candidates AT OR ABOVE
 * `project_policy.dedupe_threshold`, best-first — never the raw, unfiltered
 * top-N.
 */
async function scanForDuplicates(
  handle: IDuplicateScanHandle,
  project: IResolvedProjectRow,
  policy: IProjectPolicy,
  title: string,
  body: string
): Promise<IDuplicateCandidate[]> {
  if (!policy.dedupeScanEnabled) return [];
  const { search, graph } = handle;
  if (!search || !graph) return [];

  // §6.4 point 1: scoped to `project` only — reuses the query layer's own
  // direction-bug-fixed `owns_project`/`owns_component` traversal
  // (`resolveSimilarFilterIds`) rather than a second, hand-rolled one here.
  const filter: IIssueFilter = { project: project.uid };
  const candidateIds = await resolveSimilarFilterIds(graph, filter);
  // `resolveSimilarFilterIds` only ever returns `undefined` when NO filter
  // dimension was given at all — unreachable here since `project` always is
  // (§6.3.2: `project` is REQUIRED). A resolved-but-empty set (a brand new
  // project with no prior issues) short-circuits — see this module's own
  // "empty ids means unfiltered, never match-nothing" hazard doc comment in
  // `query/views/semantic.ts`, which this guard exists specifically to avoid
  // tripping.
  if (!candidateIds || candidateIds.size === 0) return [];

  // MUST stay byte-identical to `embedding-observer.ts`'s `composeEmbedText`
  // — both this scan's query vector and the on-write vector populate/query
  // the SAME vector space under the SAME `modelId`; see that function's own
  // doc comment for why the two call sites import one shared composer
  // instead of each keeping its own copy.
  const text = composeEmbedText(title, body);
  const canEmbed = typeof search.embedQuery === 'function';
  const vec = canEmbed ? await search.embedQuery!(text) : undefined;

  const signals: SignalSpec[] = vec
    ? [{ kind: 'text' }, { kind: 'vec' }]
    : [{ kind: 'text' }];
  const query: SearchQuery = {
    text,
    vec,
    signals,
    filters: { ids: [...candidateIds] },
  };
  // The gate only ever needs to know whether ANY candidate clears threshold
  // (all three `duplicateAction`s act on the full returned/filtered list,
  // never a single arbitrary "top match" beyond `'comment'`'s own top-1 use,
  // §6.4 point 3) — unbounded would cost an unnecessary full-table rank on
  // every single `createIssue` call.
  const SCAN_LIMIT = 5;
  // FETCH_LIMIT deliberately over-fetches. `StoreSearchBackend.search`
  // applies its `.slice(0, limit)` to a merge map in INSERTION order — every
  // text hit first, vector-only hits after — so slicing at SCAN_LIMIT would
  // discard exactly the vector-only near-duplicates this gate exists to
  // catch whenever the text channel alone already returned SCAN_LIMIT rows.
  // Over-fetch, threshold-filter, sort, then take the top SCAN_LIMIT.
  const FETCH_LIMIT = SCAN_LIMIT * 4;
  // NOTE — this calls `backend.search`, NOT `backend.searchRanked`, and that
  // is load-bearing, not a style choice. `searchRanked` fuses its channels
  // with reciprocal-rank fusion (`Σ w_i/(RRF_K + rank_i)`), and RRF is a RANK
  // device: it discards magnitude by construction, so its output cannot be
  // converted back into a similarity by ANY normalization. Dividing it by its
  // theoretical rank-1 maximum — which this function used to do — yields a
  // rank ladder (rank 1 → 1.0, rank 2 → 61/62 ≈ 0.984, rank 5 → 61/65 ≈ 0.938),
  // every rung of which sits above the default `dedupeThreshold` of 0.8. That
  // suppressed EVERY create into a project holding at least one prior issue,
  // no matter how unrelated. `backend.search` instead returns the RAW
  // per-channel scores, and its `vecScore` is the cosine similarity straight
  // off `vec.knn` (`store/semantic-search.ts`'s `SemanticMatch.score`:
  // "a similarity score, HIGHER-IS-BETTER") — a genuinely calibrated [0,1]
  // quantity that IS comparable to `dedupeThreshold`.
  const results = await search.backend.search(query, FETCH_LIMIT);
  if (results.length === 0) return [];

  const nodes = await graph.getNodesByIds(results.map((r) => r.id));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  const candidates: IDuplicateCandidate[] = [];
  for (const r of results) {
    const node = byId.get(r.id);
    if (!node) continue; // raced away (invalidated) between search and this lookup — never surfaced as a candidate
    // `vecScore` is the ONLY calibrated similarity available. It is absent
    // when the vector channel did not run at all — §6.4 point 4's degraded
    // (no `embedQuery`) mode, or no vector space matching the query's
    // dimension — and when it ran but this row came back from the text
    // channel only. In every one of those cases there is no similarity to
    // compare against `dedupeThreshold`, so the row is not a candidate.
    // Never fall back to `textScore`: BM25 is an uncalibrated, corpus-
    // relative magnitude, and substituting it here would reintroduce the
    // exact false-positive class described above under a different name.
    const score = r.vecScore;
    if (score === undefined) continue;
    // Defence in depth on scoping: `filters.ids` IS a first-class
    // `buildFilterClause` key, so the backend honours it on both channels —
    // but a duplicate gate that silently widened to the whole store would be
    // a correctness defect, not a UX one, so the membership is re-asserted
    // here rather than trusted.
    if (!candidateIds.has(r.id)) continue;
    if (score >= policy.dedupeThreshold) {
      candidates.push({ uid: node.uid, title: node.name ?? '', score });
    }
  }
  // `backend.search` returns merge-map INSERTION order, not best-first (that
  // is `searchRanked`'s contract, and this no longer calls it) — so the sort
  // is what makes `candidates[0]` the top-scoring match that
  // `duplicateAction:'comment'` (§6.4 point 3) attaches its note to.
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, SCAN_LIMIT);
}

/**
 * Create a new issue (§4, §6.3.2). One `immediate` transaction; `skipDedupe:
 * true` on every entity write (§1) via `writeNodeTx`.
 *
 * Errors: `InvalidArgumentError` (missing/blank `title`/`body`/`project`/`by`,
 * or a blank `citations[i].file`), `CatalogNotFoundError('project'|'component'|
 * 'kind'|'status'|'priority'|'agent', ref)` (`'component'` fires only when a
 * name/uid was GIVEN and did not resolve — omitting `component` never throws
 * it), `CitationUnverifiableError(file)` (policy-gated via
 * `project_policy.citation_requires_sha`), `InvalidArgumentError('duplicateAction', ...)`
 * (an unrecognized value — §6.4), `WriteContentionError`/
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
  const citations = input.citations ?? [];
  citations.forEach((citation, i) =>
    assertNonBlank(`citations[${i}].file`, citation.file)
  );

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
  const citationShas: string[] = [];
  for (const citation of citations) {
    const sha = await computeCitationSha(preResolvedProject, citation.file);
    if (sha === 'unverified' && preResolvedPolicy.citationRequiresSha) {
      throw new CitationUnverifiableError(citation.file);
    }
    citationShas.push(sha);
  }

  // §6.4 point 1: the scan runs BEFORE the `immediate` transaction opens —
  // the scan is an external, potentially network-backed round-trip
  // (an embedding-service call), and holding the RESERVED lock across it
  // would stall every other concurrent writer for its duration. Deliberately
  // NOT a CAS (§6.4 point 1's own accepted-gap framing) — see
  // `scanForDuplicates`'s doc comment.
  const duplicateCandidates = await scanForDuplicates(
    handle,
    preResolvedProject,
    preResolvedPolicy,
    input.title,
    input.body
  );

  // §6.4 point 3: `'abort'` (default) with ≥1 candidate at/above threshold —
  // nothing is written, not even inside a transaction that immediately rolls
  // back. This is the ONLY branch that returns before `executeWriteTransaction`
  // is ever called.
  if (duplicateCandidates.length > 0 && duplicateAction === 'abort') {
    return {
      created: false,
      reason: 'duplicate-suppressed',
      duplicateCandidates,
    };
  }

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

      const kindName = input.kind ?? policy.defaultKind ?? 'issue';
      const kindRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'kind',
        ref: kindName,
        at: now,
      });
      enforceAllowedSet(policy.allowedKinds, 'kind', kindRow.name);

      const statusName = input.status ?? policy.defaultStatus ?? 'open';
      const statusRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'status',
        ref: statusName,
        at: now,
        mintMetadata: async () => ({ terminal: false }),
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

      const issueMetadata: Record<string, unknown> = {};
      if (input.assignee !== undefined) issueMetadata.assignee = input.assignee;

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
        },
        // §6.4 point 3: present on `'force'` when the scan found ≥1 candidate
        // (reported for the caller's own audit trail even though the write
        // proceeded) — absent on a zero-candidate scan, per this file's own
        // `ICreateIssueResult` doc comment.
        ...(duplicateCandidates.length > 0 ? { duplicateCandidates } : {}),
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
