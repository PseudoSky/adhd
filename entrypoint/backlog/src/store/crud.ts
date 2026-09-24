/**
 * crud.ts — createItem/getItem/updateItem/softDeleteItem + the dedupe scan
 * (DESIGN.md §2.4). `createItem`'s dedupe scan runs BEFORE humanId
 * allocation and is an intentionally soft guarantee (a scan racing a
 * concurrent create can miss a just-created near-duplicate — acceptable per
 * DESIGN.md §2.4).
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { BacklogItem, CreateItemInput, CreateItemResult, ICreateSuppressionReason, IUpdatePatch } from '../model.js';
import { InvalidArgumentError, UnsupportedOperationError, assertKnownPatchKeys, assertNoSilentlyDiscardedPatchKeys } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { allocateHumanIdAndInsert, type NextOrdinalOpts } from './ids.js';
import { buildNotFoundError, findItemNode, knownRepos, resolveCanonicalRepo } from './query.js';
import { mutateMetadata } from './mutate-metadata.js';
import { assertValidCitation } from './lifecycle.js';
import { getSemanticBackend } from './semantic-search.js';
import { scheduleEmbed } from './embed-queue.js';
import {
  BACKLOG_ITEM_TAG,
  buildNodeContent,
  buildNodeName,
  buildTags,
  computeContentHash,
  humanIdFamily,
  humanIdKind,
  importanceForPriority,
  isLiveBacklogItemNode,
  normalizeRepoKey,
  sanitizeFtsQuery,
  toBacklogItem,
  type BacklogNodeMeta,
} from './mapping.js';

/**
 * RAG-SPEC.md §4 — `IUpdatePatch` (model.ts) is the STRICT, exhaustively
 * enumerated patch vocabulary (`UPDATE_PATCH_KEYS`/`assertKnownPatchKeys`,
 * BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001's fix) — adding a field to it
 * requires updating that exhaustiveness list in model.ts, which is out of
 * this file's ownership for this change. `awaitEmbed` is a WRITE-PATH
 * CONTROL FLAG (RAG-SPEC.md §2.2), not a persisted item field, so it is
 * layered on top locally instead: destructured off the incoming patch BEFORE
 * `assertKnownPatchKeys` ever sees the remainder (below), so the strict
 * vocabulary check is completely unaware this flag exists and never rejects
 * it as "unknown".
 */
export type UpdateItemPatchWithEmbed = IUpdatePatch & { awaitEmbed?: boolean };

/**
 * Common English stopwords excluded from the title-overlap check below
 * (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001). Small and deliberately
 * conservative — it only strips words with essentially zero discriminating
 * power ("the", "a", "is", ...), never a domain word. A false negative here
 * (a stopword slipping through as "meaningful") just makes the overlap
 * fraction slightly harder to hit, which is the safe failure direction;
 * stripping a real content word would be the unsafe one, so the list stays
 * short by design rather than exhaustive.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'such', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Minimum fraction of the NEW item's meaningful title tokens that must also
 * appear in a CANDIDATE's title for the candidate to count as a duplicate
 * (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001). Exported so callers/tests can
 * tune it without touching this file's internals.
 *
 * Why title-to-title overlap instead of the FTS hit's bm25 `score`:
 * `store.graph.searchNodes()` (`@adhd/sox-graph-store`) DOES return a
 * per-hit `score` (`-fts_node.rank`, i.e. a positive, higher-is-better bm25
 * score) — but bm25 is corpus- and document-length-relative, not an absolute
 * similarity measure, and empirically it does NOT discriminate this bug's
 * failure mode: a live probe reproducing the exact reported case (a short
 * generic new title vs. a long, verbose, unrelated document that happens to
 * repeat a couple of the new title's common words many times) scored
 * `~0.0000109`, while a genuine short-title-vs-short-title near-duplicate
 * scored `~0.0000113` — the SAME order of magnitude, with no clean
 * separating threshold between them. A long document's sheer token count
 * inflates its bm25 term-frequency component enough to rival a real
 * duplicate's score. Title-to-title token overlap has no such document-
 * length confound: a new item's title can only ever match against a
 * candidate's (typically similarly short) title, so incidental repetition
 * buried in a long candidate BODY can no longer count toward "looks like a
 * duplicate" at all.
 *
 * 0.5 (at least half the new title's meaningful tokens must recur in the
 * candidate's title) was chosen because DESIGN.md §2.4's own worked example
 * ("same bug, different words") is a near-total title rewrite that still
 * shares most of its content words ("database connection pool leaks under
 * load" -> "the database connection pool leaks under load" is 6/6); dropping
 * to a small minority match (e.g. 1-2 shared generic words out of 5) is
 * exactly the false-positive shape this bug reports and must NOT pass.
 */
export const TITLE_OVERLAP_MIN_FRACTION = 0.5;

/**
 * Tokenizes a title into lowercase, stopword-filtered words for the overlap
 * check above. Reuses `sanitizeFtsQuery`'s Unicode-aware letter/number/
 * underscore allowlist so tokenization is consistent with what actually
 * reached the FTS query in the first place.
 */
function meaningfulTitleTokens(title: string): string[] {
  return sanitizeFtsQuery(title)
    .toLowerCase()
    .split(' ')
    .filter((tok) => tok.length > 0 && !TITLE_STOPWORDS.has(tok));
}

/**
 * True iff `candidateTitle` contains EVERY meaningful token of the new title
 * (the dedupe's title gate — BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001's
 * second-pass filter; see `TITLE_OVERLAP_MIN_FRACTION`'s doc comment for the
 * original 0.5-fraction rationale). If the new title has NO meaningful
 * tokens at all (e.g. it is entirely stopwords/punctuation — an edge case
 * with no positive signal to check), this falls back to `true` (preserve
 * the prior FTS-only behavior) rather than silently disabling dedupe for
 * every all-stopword title.
 *
 * F-01/F-02 (adapter substrate) — WHY "every token" instead of the old
 * 0.5 fraction: the store-adapter's FTS search normalizes every multi-token
 * query to `"tok1" OR "tok2"` (BL-367 — required so SQLite FTS5 and turso
 * Tantivy return identical recall). Under OR semantics a hit exists if ANY
 * single token matches, so the fraction gate now sees candidates the old
 * FTS5-AND hit set (where a hit contained ALL query tokens) never produced:
 * `closed one` vs `open one` shares 1/2 = 0.5 (exactly the old threshold),
 * and numbered template titles `scale create number 1` vs `... number 2`
 * share 3/4 = 0.75. Both are false positives the old recall excluded by
 * construction. Requiring the candidate to contain EVERY meaningful
 * meaningful token of the new title reproduces the FTS5-AND hit condition at
 * the application layer, independent of the adapter's OR normalization —
 * the genuine-duplicate cases ("database connection pool leaks under load"
 * vs "The database connection pool leaks under load"; a shorter re-phrase
 * whose words all recur in the longer original) still pass, while the
 * OR-only shapes no longer do. `TITLE_OVERLAP_MIN_FRACTION` stays exported
 * for callers/tests that tune the heuristic, but the gate is now the
 * stronger AND form.
 */
function titleMeaningfullyOverlaps(newTitleTokens: readonly string[], candidateTitle: string): boolean {
  if (newTitleTokens.length === 0) return true;
  const candidateTokens = new Set(meaningfulTitleTokens(candidateTitle));
  return newTitleTokens.every((tok) => candidateTokens.has(tok));
}

/**
 * RAG-SPEC.md §4 — how many nearest neighbours the semantic dedupe source
 * considers. Small on purpose: this is a filing-time gate a human/agent reads,
 * not a search result set, and a long candidate list is ignored rather than
 * reviewed.
 */
export const SEMANTIC_DEDUPE_K = 5;

/**
 * RAG-SPEC.md §4 — cosine-similarity floor a KNN hit must clear to count as a
 * duplicate candidate. `knn` returns its k nearest neighbours unconditionally,
 * however distant, so without a floor every create in a sparse repo would
 * surface unrelated items and the gate would be trained away. Tuned against
 * bge-base-en-v1.5, where a genuine paraphrase scores well above this and an
 * unrelated item scores well below (an observed real spread: 0.85 for a
 * paraphrase vs 0.41-0.51 for unrelated items).
 */
export const SEMANTIC_DEDUPE_MIN_SCORE = 0.75;

async function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): Promise<BacklogItem[]> {
  const candidates = new Map<number, NodeRecord>();

  // 1. FTS over title + body — catches "same bug, different words". Sanitized
  // first (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001) — an unsanitized title
  // containing an FTS5-syntax-significant character (`-`, `:`, `(`, `)`, `"`)
  // crashes `searchNodes` outright instead of returning candidates.
  //
  // BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001: a raw FTS hit is NOT itself proof
  // of a duplicate — `searchNodes` has no relevance floor, so any hit within
  // the top 10 used to count, including a long unrelated document that
  // merely repeats a couple of the new title's common words many times.
  // Every FTS hit is now required to ALSO clear the title-to-title overlap
  // check (`titleMeaningfullyOverlaps` — see its doc comment for why this,
  // not the hit's bm25 `score`, is the discriminating signal).
  const ftsQuery = sanitizeFtsQuery(input.title);
  if (ftsQuery) {
    const newTitleTokens = meaningfulTitleTokens(input.title);
    for (const hit of await store.graph.searchNodes(ftsQuery, {
      limit: 10,
      filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
    })) {
      if (!isLiveBacklogItemNode(hit)) continue;
      const candidateTitle = (hit.metadata as { title?: string } | null)?.title ?? hit.summary ?? '';
      if (!titleMeaningfullyOverlaps(newTitleTokens, candidateTitle)) continue;
      candidates.set(hit.id, hit);
    }
  }

  // 2. Exact metadata match on symbol/path/errorText.
  const scan = input.dedupeScan;
  if (scan?.symbol) {
    for (const hit of await store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupeSymbol: scan.symbol },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.path) {
    for (const hit of await store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupePath: scan.path },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }
  if (scan?.errorText) {
    for (const hit of await store.graph.queryNodes({
      kind: 'generic',
      tags: [BACKLOG_ITEM_TAG],
      namespace: repo,
      metadata: { dedupeErrorText: scan.errorText },
    })) {
      if (isLiveBacklogItemNode(hit)) candidates.set(hit.id, hit);
    }
  }

  // 3. Semantic near-duplicates (RAG-SPEC.md §4) — the whole point of the RAG
  // layer for dedupe: catches a PARAPHRASED duplicate that shares no
  // meaningful title tokens with the new item, which source 1 (FTS +
  // `titleMeaningfullyOverlaps`) structurally cannot find, and source 2
  // (exact symbol/path/errorText) only finds when the filer happened to
  // supply the same identifiers.
  //
  // Opt-in and non-fatal, in that order:
  // - No backend configured (the default build) ⇒ skipped entirely, so
  //   dedupe behaviour is byte-identical to what it was before RAG existed.
  // - A backend that FAILS mid-scan must never block a legitimate filing:
  //   the whole block is wrapped, and an error degrades this to
  //   "FTS + exact-match only" rather than failing the create. Filing an
  //   occasional duplicate is recoverable; refusing to file a real bug
  //   because an ONNX model hiccuped is not.
  //
  // The KNN is scoped by `NodeFilter` (repo namespace + backlog-item tag) so
  // the filter is pushed DOWN into the vector query rather than applied to
  // an already-truncated top-k — post-filtering a k-limited result set would
  // silently drop true duplicates whenever the k nearest happened to be
  // out-of-repo nodes.
  const semantic = getSemanticBackend();
  if (semantic !== null) {
    try {
      const probe = `${input.title}\n\n${input.body}`;
      const hits = await semantic.knn(await semantic.embedQuery(probe), SEMANTIC_DEDUPE_K, {
        filter: { tags: [BACKLOG_ITEM_TAG], namespace: repo },
      });
      for (const hit of hits) {
        // A similarity floor is required. `knn` always returns its k nearest
        // neighbours no matter how far away they are, so without this every
        // create in a small repo would surface unrelated items as
        // "duplicates" and train filers to ignore the gate.
        if (hit.score < SEMANTIC_DEDUPE_MIN_SCORE) continue;
        if (candidates.has(hit.nodeId)) continue;
        const node = await store.graph.getNode(hit.nodeId);
        if (node && isLiveBacklogItemNode(node)) candidates.set(hit.nodeId, node);
      }
    } catch (err) {
      console.error(
        `backlog: semantic dedupe scan failed (falling back to FTS + exact-match candidates only): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return [...candidates.values()].map(toBacklogItem);
}

/**
 * Superset of the landed v1 `CreateItemResult` contract (model.ts) — extends
 * it rather than redefining it, and adds only the two fields needed to close
 * BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 and
 * BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001 without touching model.ts
 * (out of this file's ownership).
 *
 * `item` stays REQUIRED, matching `CreateItemResult` exactly, so every
 * existing caller that reads `result.item` unconditionally (`client.ts`'s
 * `createItem`/`importFromMarkdown`, `structure.ts`'s `splitItemNode`) keeps
 * compiling and keeps working: on a suppressed write `item` is still the
 * matched existing item, same as before this fix. What changes is that a
 * caller no longer has to infer "this humanId belongs to someone else" from
 * `item.humanId` alone — `existingHumanId` and `reason` name that fact
 * explicitly, so a caller that DOES check them (as every caller now should)
 * cannot mistake a suppressed write for a real one.
 *
 * `reason` reuses model.ts's own `ICreateSuppressionReason` — "why a create
 * variant wrote nothing. Never a silent drop." (model.ts `ICreateOutcome`
 * doc comment) — the type the contracts agent already ships for exactly
 * this, rather than inventing a parallel enum.
 */
export interface CreateItemOutcome extends CreateItemResult {
  /**
   * Set ONLY when `created === false` — the humanId of the EXISTING item the
   * write was suppressed in favor of. Never set when `created === true`.
   *
   * BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001: on the dedupe-scan
   * path (as opposed to the exact-idOverride-collision path, where the
   * "existing" item legitimately shares the caller's own requested id) the
   * only id `item.humanId` carries belongs to a DIFFERENT item than the one
   * the caller tried to file. A caller that stored `item.humanId` as "the
   * item I just filed" is now pointing at someone else's ticket. This field
   * is the honest, unambiguous way to read that id back.
   */
  existingHumanId?: string;
  /** Set ONLY when `created === false` — why nothing was written. */
  reason?: ICreateSuppressionReason;
}

/**
 * FEAT-013 — increments the matched item's `dupeHits` counter every time the
 * filing-time dedupe scan suppresses a create in its favor: the demand
 * signal `sort:"demand"`/`filter.dupeHitsMin` reads (model.ts
 * `IBacklogItemV2.dupeHits`, `BACKLOG_FILTER_KEYS`) — an item filed 5 times
 * is wanted more than one filed once.
 *
 * `BacklogNodeMeta` (mapping.ts) does not yet declare a `dupeHits` field —
 * mapping.ts is not owned by this fix, and node metadata storage is
 * schemaless JSON, so an undeclared key round-trips safely through
 * `mutateMetadata`'s generic `<M>` without needing a mapping.ts change.
 * `toBacklogItem` simply doesn't surface it back out yet; that read-side
 * wiring is separate, later work.
 */
async function incrementDupeHits(store: GraphBacklogStore, nodeId: number): Promise<void> {
  await mutateMetadata<BacklogNodeMeta & { dupeHits?: number }>(store, nodeId, (meta) => ({
    ...meta,
    dupeHits: (meta.dupeHits ?? 0) + 1,
  }));
}

/**
 * The pre-embedding body of `createItemNode`, split out UNCHANGED (same
 * contextual-typing shape the `allocateHumanIdAndInsert<T>` generic call
 * relies on to infer `T = CreateItemOutcome` and narrow each branch's
 * `reason` string literal correctly — moving that same `return
 * allocateHumanIdAndInsert(...)` expression behind a `.then()`/extra `await`
 * at the OUTER call site breaks that inference, per a build failure
 * encountered wiring RAG-SPEC.md §2.1 Phase B in below) so
 * `createItemNode` can layer `scheduleEmbed` on top AFTER this settles,
 * without disturbing it.
 */
async function createItemNodeCore(store: GraphBacklogStore, input: CreateItemInput, opts?: NextOrdinalOpts): Promise<CreateItemOutcome> {
  // BUG-BACKLOG-HUMANID-COLLISION-001 fix #1: `family` is REQUIRED unless
  // `idOverride` is given (SPEC.md §5.1, model.ts `CreateItemInput.family`
  // doc comment). Validated HERE, before any allocation runs, so a missing/
  // empty/whitespace-only `family` can never reach `computeNextHumanId`'s
  // `${family}-NNN` template literal, which used to silently coerce JS
  // `undefined` to the literal string `"undefined"` and mint a
  // `humanId: "undefined-001"` that collides with every other item that hit
  // the same bug. This is store-level defense in depth — it must hold
  // regardless of whether the caller's own schema validation (e.g.
  // apigen-core-client's extracted `CreateItemInput` shape,
  // BUG-APIGEN-CORE-CLIENT-001) enforces `family` as required.
  if (!input.idOverride && (typeof input.family !== 'string' || input.family.trim().length === 0)) {
    throw new InvalidArgumentError(
      'family',
      `backlog: createItem requires a non-empty "family" (e.g. "BUG-APIGEN") unless "idOverride" is given — ` +
        `received family=${JSON.stringify(input.family)}. See BUG-BACKLOG-HUMANID-COLLISION-001.`
    );
  }

  // Same defense-in-depth rationale as the `family` guard above (and the
  // upstream BUG-APIGEN-CORE-CLIENT-001 fix it deliberately mirrors): TS
  // `required` only guarantees a caller SUPPLIED the property, never that it
  // is non-empty. `title`/`body`/`repo` are the three other fields whose
  // whole purpose collapses if the value is `""`/whitespace-only — an empty
  // title/body files an unreadable item, and an empty `repo` breaks every
  // `(repo, humanId)`-keyed lookup this store relies on (query.ts, this
  // file's own `dedupeScan`/`knownRepos`). Reject before allocation runs, for
  // the exact reason `family` is checked here rather than left to
  // `computeNextHumanId`.
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new InvalidArgumentError(
      'title',
      `backlog: createItem requires a non-empty "title" — received title=${JSON.stringify(input.title)}.`
    );
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new InvalidArgumentError(
      'body',
      `backlog: createItem requires a non-empty "body" — received body=${JSON.stringify(input.body)}.`
    );
  }
  if (typeof input.repo !== 'string' || input.repo.trim().length === 0) {
    throw new InvalidArgumentError(
      'repo',
      `backlog: createItem requires a non-empty "repo" — received repo=${JSON.stringify(input.repo)}.`
    );
  }

  // BUG-BACKLOG-CREATE-ITEM-DROPS-CITATIONS-001: validated up front, before
  // any allocation runs — same "a rejected write is not a partial write"
  // guarantee as the field guards above and `transitionStatus`'s inline
  // citation validation (lifecycle.ts).
  if (input.citations) {
    for (const citation of input.citations) assertValidCitation(citation);
  }

  // `idOverride` (import path, or a planner-chosen id) must never mint a
  // SECOND node claiming an already-live humanId — `humanId` is documented
  // as "unique within (repo, family)" (SPEC.md §4.1). This is a HARD check,
  // not the soft dedupe-scan heuristic below, and is NOT bypassed by
  // `force` (force overrides "maybe a near-duplicate", never "this exact id
  // already exists") — it is what makes `importFromMarkdown` idempotent on
  // re-import (SPEC.md §5.6) and correctly surfaces a genuine duplicate
  // humanId WITHIN one source file (the legacy tool's own `stats` command
  // documents that real `BACKLOG.md` files do contain duplicate ids) as a
  // dedupe candidate instead of silently minting a second, id-colliding node.
  //
  // This is a SPECULATIVE fast-path check only (cheap early-out so a known
  // duplicate never runs the dedupe scan below for nothing) — the
  // AUTHORITATIVE check is the one inside `allocateHumanIdAndInsert`'s own
  // `.immediate()` transaction below, which is the one actually safe under
  // concurrency (BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-RACE-001).
  if (input.idOverride) {
    const existing = await findItemNode(store, input.repo, input.idOverride);
    if (existing) {
      const existingItem = toBacklogItem(existing);
      // The caller asked for THIS exact id and it already exists — not a
      // "foreign" id (the caller requested it), so `existingHumanId` is
      // still set for consistency ("never a silent drop") but always equals
      // the id the caller themselves passed as `idOverride`.
      return { item: existingItem, created: false, duplicateCandidates: [existingItem], existingHumanId: existingItem.humanId, reason: 'id-collision' };
    }
  }

  const duplicateCandidates = input.force ? [] : await dedupeScan(store, input.repo, input);
  if (duplicateCandidates.length > 0 && !input.force) {
    // BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 /
    // BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001: this is the branch
    // that used to hand back `{ item: duplicateCandidates[0], created:
    // false }` and nothing else — a shape a caller that doesn't check
    // `created` reads exactly like a real create success, with ANOTHER
    // item's humanId sitting where a caller expects its own new id. Both
    // fixes are additive fields (`existingHumanId`, `reason`), never a
    // change to `item`'s presence — see `CreateItemOutcome`'s doc comment.
    const matched = duplicateCandidates[0];
    await incrementDupeHits(store, matched.nodeId);
    return {
      item: matched,
      created: false,
      duplicateCandidates,
      existingHumanId: matched.humanId,
      reason: 'duplicate-suppressed',
    };
  }

  // BUG-BACKLOG-REPO-LOOKUP-UX-001 hardening: a case/whitespace-only variant
  // of an ALREADY-KNOWN repo is now a hard reject (was: silent write behind
  // an ignorable warning, letting 'Adhd' and 'adhd' become two permanently
  // disjoint scopes). A genuinely NEW repo string — never seen before even
  // normalized — is still always allowed to file its first item (this
  // repo's CLAUDE.md "never hard-fail on new repo" rule); it gets a soft
  // advisory warning instead, same as before.
  //
  // resolveCanonicalRepo also folds in a SEPARATE, broader match (TASK-001
  // hardening: bare-name + compatible-owner, e.g. 'adhd' and
  // 'PseudoSky/adhd') for read-side/UX resolution — those are deliberately
  // NOT the same repo for write purposes: EPIC-A/FEAT-BACKLOG-004 models
  // owner-qualified spellings as distinct, legitimate fork nodes of one
  // project, not accidental duplicates. Only reject when the input is the
  // SAME string modulo case/whitespace as the resolved canonical — never
  // when resolution crossed a bare-name/owner match.
  const { canonical, isNewRepo } = await resolveCanonicalRepo(store, input.repo);
  if (!isNewRepo && canonical !== input.repo && normalizeRepoKey(canonical) === normalizeRepoKey(input.repo)) {
    throw new InvalidArgumentError(
      'repo',
      `repo '${input.repo}' differs from the existing canonical value '${canonical}' only by case/whitespace — use '${canonical}' instead.`
    );
  }
  const known = await knownRepos(store);
  const repoWarning =
    known.size > 0 && isNewRepo
      ? `repo '${input.repo}' is new to this store — existing repo value(s) here: ${[...known].sort().join(', ')}. If this is meant to be the same project, use the existing repo value instead.`
      : undefined;

  return allocateHumanIdAndInsert(store, input.repo, input.family, input.idOverride, async (humanId, existingAtCommit) => {
    if (existingAtCommit) {
      const existingItem = toBacklogItem(existingAtCommit);
      // Same idOverride-collision case as the speculative check above, just
      // caught by the authoritative in-transaction re-check instead — see
      // that branch's comment for why `existingHumanId` here is never
      // "foreign" (it is the id the caller themselves asked to use).
      return { item: existingItem, created: false, duplicateCandidates: [existingItem], existingHumanId: existingItem.humanId, reason: 'id-collision' };
    }

    const kind = humanIdKind(humanId);
    const family = humanIdFamily(humanId);
    const nowIso = new Date().toISOString();

    const meta: BacklogNodeMeta = {
      humanId,
      kind,
      family,
      title: input.title,
      body: input.body,
      status: 'OPEN',
      repo: input.repo,
      citations: input.citations ?? [],
      notes: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (input.priority !== undefined) meta.priority = input.priority;
    if (input.projectPath !== undefined) meta.projectPath = input.projectPath;
    if (input.plan !== undefined) meta.plan = input.plan;
    if (input.importedFrom !== undefined) meta.importedFrom = input.importedFrom;
    // TASK-004: declared on CreateItemInput (FEAT-012, model.ts) but never
    // read here — a caller passing author/reporter got a success response
    // with the value silently discarded.
    if (input.author !== undefined) meta.author = input.author;
    if (input.reporter !== undefined) meta.reporter = input.reporter;
    if (input.dedupeScan?.symbol !== undefined) meta.dedupeSymbol = input.dedupeScan.symbol;
    if (input.dedupeScan?.path !== undefined) meta.dedupePath = input.dedupeScan.path;
    if (input.dedupeScan?.errorText !== undefined) meta.dedupeErrorText = input.dedupeScan.errorText;

    const nodeId = await store.graph.writeNode(buildNodeContent(input.repo, humanId, input.title, input.body), {
      kind: 'generic',
      name: buildNodeName(input.repo, humanId),
      summary: input.title,
      tags: buildTags(kind, family, input.tags),
      namespace: input.repo,
      importance: importanceForPriority(input.priority),
      confidence: 'confirmed',
      ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
      metadata: meta as unknown as Record<string, unknown>,
    });

    const node = await store.graph.getNode(nodeId);
    if (!node) throw new Error(`backlog: writeNode returned an id that does not resolve: ${nodeId}`);
    return { item: toBacklogItem(node), created: true, duplicateCandidates: [], ...(repoWarning !== undefined ? { repoWarning } : {}) };
  }, opts);
}

export async function createItemNode(store: GraphBacklogStore, input: CreateItemInput, opts?: NextOrdinalOpts): Promise<CreateItemOutcome> {
  const outcome = await createItemNodeCore(store, input, opts);
  // RAG-SPEC.md §2.1 Phase B: scheduled strictly AFTER `createItemNodeCore`
  // has returned (i.e. its CAS transaction has committed and released the
  // write lock) — never from inside `allocateHumanIdAndInsert`'s updater
  // callback. Only a REAL new write gets embedded; the `created: false`
  // branches (id-collision, dedupe-suppressed) never reach here with
  // `created === true`, so they correctly schedule nothing.
  if (outcome.created) {
    const content = buildNodeContent(input.repo, outcome.item.humanId, input.title, input.body);
    const embedPromise = scheduleEmbed(store, outcome.item.nodeId, content);
    if (input.awaitEmbed) await embedPromise;
  }
  return outcome;
}

export async function getItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<BacklogItem | null> {
  const node = await findItemNode(store, repo, humanId);
  return node ? toBacklogItem(node) : null;
}

async function requireItemNode(store: GraphBacklogStore, repo: string, humanId: string): Promise<NodeRecord> {
  const node = await findItemNode(store, repo, humanId);
  if (!node) throw await buildNotFoundError(store, repo, humanId);
  return node;
}

/**
 * DEVIATION (mitigated — DEBT-BACKLOG-CONTENT-IMMUTABLE-001): `@adhd/sox-graph-store`
 * exposes no PUBLIC primitive to update a node's `content` column after
 * creation (`touch()`'s `Partial<NodeMeta>` covers
 * name/summary/topic/tags/importance/confidence/tExpires/metadata — never
 * `content`; verified against the real source). `title` updates the `summary`
 * column (source of truth for the API) AND `metadata.title`; `body` updates
 * `metadata.body` (source of truth for the API). Below, a title/body change
 * ALSO re-synchronizes the FTS-indexed `content`/`content_hash` columns
 * directly via `adapter.executeRun` on the store-owned `adapter` handle —
 * the same DESIGN.md §14-sanctioned escape hatch `structure.ts`'s
 * `removeDependencyNode` already uses for the one other gap (`edge`
 * deletion) the `GraphBackend` API lacks, now routed through the store-
 * adapter's query surface (F-01/F-02: the raw `store.db` handle is gone).
 * This is safe specifically because `fts_node_au` (the real schema's `AFTER
 * UPDATE ON node` trigger — `~/dev/ai/sox-ecosystem/libs/data/graph/graph-store/
 * src/index.ts`'s `FTS_TRIGGERS`) re-indexes `fts_node` automatically on
 * ANY write to `node.content`/`name`/`summary`, so no separate FTS statement
 * is needed here.
 */
/**
 * BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001: this function used to read
 * exactly five keys off `patch` — `title`, `body`, `projectPath`,
 * `importedFrom`, `tags` — and return the mapped item as a SUCCESS
 * regardless of what else the caller passed. `IUpdatePatch` (model.ts §4)
 * declares ten MORE keys (`priority`, `status`, `plan`, `assignee`, `kind`,
 * `humanId`, `repo`, `files`, `author`, `reporter`); every one of them used
 * to be silently accepted and silently ignored.
 *
 * The fix is two gates, both BEFORE any write happens (a rejected patch must
 * never be a partial write, same rule `createItemNode`'s field guards
 * follow):
 *
 * 1. `assertKnownPatchKeys` — reject a key `IUpdatePatch` doesn't declare at
 *    all (a typo/unknown field) by name.
 * 2. The per-key checks below — reject a key `IUpdatePatch` DOES declare but
 *    this operation does not implement, by name, pointing at whichever
 *    operation actually owns that field (verified against this repo's own
 *    `store/*.ts` exports, not guessed):
 *      - `priority`  -> `setPriorityNode`   (store/structure.ts:210)
 *      - `status`    -> `transitionStatusNode` / `resolveItemNode` (store/lifecycle.ts) —
 *                       a raw patch must not become a way around the §5a.2
 *                       citation/reason evidence gate those enforce.
 *      - `plan`      -> `attachToPlanNode`  (store/structure.ts:234)
 *      - `assignee`  -> `assignItemNode`    (store/structure.ts:254)
 *      - `humanId`   -> `renameHumanIdNode` (store/structure.ts:295) — a
 *                       rename is never a blind metadata write.
 *      - `kind`      -> `kind` is DERIVED from `humanId`'s prefix
 *                       (`mapping.ts:humanIdKind`), not an independent field;
 *                       it can only change via the same `renameHumanIdNode`
 *                       repair primitive as `humanId` itself.
 *      - `repo`      -> `UnsupportedOperationError`, per model.ts's OWN
 *                       documented contract for this field (model.ts
 *                       `IUpdatePatch.repo` doc comment, DEBT-BACKLOG-REPO-MOVE-001):
 *                       illegal until repo is a graph node (EPIC-A); use
 *                       `migrateRepoItemNode` (store/repo-migration.ts) instead.
 *      - `files`, `author`, `reporter` -> `UnsupportedOperationError` — §5a.3
 *                       / FEAT-012 have no write path ANYWHERE in this store
 *                       yet (`BacklogNodeMeta`, mapping.ts, declares none of
 *                       these fields); there is no operation to point to.
 *
 * `assertNoSilentlyDiscardedPatchKeys` runs last, as a final defense-in-depth
 * check against the keys this function DOES claim to apply — so a future
 * regression here (a key added to the "handled" set below without actually
 * being written) still fails loudly instead of silently, exactly like the
 * bug this whole function exists to fix.
 */
export async function updateItemNode(store: GraphBacklogStore, repo: string, humanId: string, patch: UpdateItemPatchWithEmbed): Promise<BacklogItem> {
  // RAG-SPEC.md §2.2 — pulled off BEFORE `assertKnownPatchKeys` ever sees the
  // rest of the object (see `UpdateItemPatchWithEmbed`'s doc comment above):
  // the strict `IUpdatePatch` vocabulary check must never even observe this
  // key, let alone reject it as unknown.
  const { awaitEmbed, ...corePatch } = patch;
  assertKnownPatchKeys(corePatch as unknown as Record<string, unknown>);

  if (patch.priority !== undefined) {
    throw new InvalidArgumentError(
      'priority',
      `patch.priority is not applied by updateItem — priority changes go through setPriority (store/structure.ts:setPriorityNode). See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.status !== undefined) {
    throw new InvalidArgumentError(
      'status',
      `patch.status is not applied by updateItem — status changes must go through transitionStatus/resolveItem (store/lifecycle.ts), which enforce the citation/reason evidence gate a raw patch would otherwise bypass. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.plan !== undefined) {
    throw new InvalidArgumentError(
      'plan',
      `patch.plan is not applied by updateItem — plan attachment goes through attachToPlan (store/structure.ts:attachToPlanNode). See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.assignee !== undefined) {
    throw new InvalidArgumentError(
      'assignee',
      `patch.assignee is not applied by updateItem — assignment goes through assignItem (store/structure.ts:assignItemNode). See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.humanId !== undefined) {
    throw new InvalidArgumentError(
      'humanId',
      `patch.humanId is not applied by updateItem — renaming an item's humanId must go through the store's renameHumanId repair primitive (store/structure.ts:renameHumanIdNode), never a blind metadata write. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.kind !== undefined) {
    throw new InvalidArgumentError(
      'kind',
      `patch.kind is not applied by updateItem — kind is DERIVED from humanId's prefix (mapping.ts:humanIdKind), so it cannot be changed independently; rename the item via renameHumanId (store/structure.ts:renameHumanIdNode) to change its kind, or file a new item under the desired family. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.repo !== undefined) {
    throw new UnsupportedOperationError(
      'repo',
      `patch.repo cannot move an item between repos yet — repo is not a graph node until EPIC-A lands (DEBT-BACKLOG-REPO-MOVE-001). Use migrateRepoItemNode (store/repo-migration.ts) instead. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.files !== undefined) {
    throw new UnsupportedOperationError(
      'files',
      `patch.files has no write path yet — §5a.3's declared-file-paths feature is not implemented at the storage layer (BacklogNodeMeta has no "files" field). See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.author !== undefined) {
    throw new UnsupportedOperationError(
      'author',
      `patch.author has no write path yet — FEAT-012's author-role edge is not implemented at the storage layer. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }
  if (patch.reporter !== undefined) {
    throw new UnsupportedOperationError(
      'reporter',
      `patch.reporter has no write path yet — FEAT-012's reporter-role edge is not implemented at the storage layer. See BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001.`
    );
  }

  const node = await requireItemNode(store, repo, humanId);
  const appliedKeys = new Set<string>();
  let finalTitle = '';
  let finalBody = '';
  await mutateMetadata<BacklogNodeMeta>(store, node.id, (meta) => {
    const next: BacklogNodeMeta = { ...meta, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) {
      next.title = patch.title;
      appliedKeys.add('title');
    }
    if (patch.body !== undefined) {
      next.body = patch.body;
      appliedKeys.add('body');
    }
    if (patch.projectPath !== undefined) {
      next.projectPath = patch.projectPath;
      appliedKeys.add('projectPath');
    }
    if (patch.importedFrom !== undefined) {
      next.importedFrom = patch.importedFrom;
      appliedKeys.add('importedFrom');
    }
    finalTitle = next.title;
    finalBody = next.body;
    return next;
  });
  if (patch.title !== undefined || patch.tags !== undefined || patch.projectPath !== undefined) {
    const touchPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) touchPatch['summary'] = patch.title;
    if (patch.tags !== undefined) {
      const kind = humanIdKind(humanId);
      const family = humanIdFamily(humanId);
      touchPatch['tags'] = buildTags(kind, family, patch.tags);
      appliedKeys.add('tags');
    }
    if (patch.projectPath !== undefined) touchPatch['projectPath'] = patch.projectPath;
    await store.graph.touch(node.id, touchPatch);
  }
  // RAG-SPEC.md §2.3 — re-embed on every title/body change, and ONLY on a
  // title/body change: the vector upsert is a plain overwrite (idempotent
  // per (nodeId, modelId), `SemanticBackend.upsertVector`'s doc comment), so
  // there is no delete-then-insert to reason about, but re-embedding a
  // status/tags/priority-only edit would be pure waste (the text the
  // embedding model sees never changed). `newContent` mirrors EXACTLY the
  // string just written to the `content` column above (built from the same
  // repo/humanId/finalTitle/finalBody), computed here (outside the
  // transaction that already committed above) purely as a cheap string
  // operation — never inside a mutation transaction, per embed-queue.ts's
  // header.
  let newContent: string | undefined;
  if (patch.title !== undefined || patch.body !== undefined) {
    newContent = buildNodeContent(repo, humanId, finalTitle, finalBody);
    await store.adapter.executeRun(
      `UPDATE node SET content = ?, content_hash = ? WHERE rowid = ? AND t_invalid IS NULL`,
      [newContent, computeContentHash(newContent), node.id]
    );
  }

  // Final defense-in-depth, per `assertNoSilentlyDiscardedPatchKeys`'s own
  // documented purpose (model.ts): every key ABOVE that reached this point
  // must actually have landed in `appliedKeys`. It only ever fires for a
  // future regression (a key moved into the "handled" set above without its
  // write actually being wired up) — every key that reaches here today is
  // one of the five this function has always applied. `corePatch` (not
  // `patch`) is checked here — `awaitEmbed` is a write-path control flag, not
  // a persisted field this function is claiming to apply, so it must never
  // be flagged as "accepted but never written" (RAG-SPEC.md §2.2).
  assertNoSilentlyDiscardedPatchKeys(corePatch as unknown as Record<string, unknown>, appliedKeys);

  const updated = await store.graph.getNode(node.id);
  if (!updated) throw await buildNotFoundError(store, repo, humanId);

  if (newContent !== undefined) {
    const embedPromise = scheduleEmbed(store, node.id, newContent);
    if (awaitEmbed) await embedPromise;
  }

  return toBacklogItem(updated);
}

export async function softDeleteItemNode(store: GraphBacklogStore, repo: string, humanId: string, reason: string): Promise<void> {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidArgumentError(
      'reason',
      `backlog: softDeleteItem requires a non-empty "reason" — received reason=${JSON.stringify(reason)}.`
    );
  }
  const node = await requireItemNode(store, repo, humanId);
  await store.graph.invalidate(node.id, reason);

  // RAG-SPEC.md — a soft-deleted (invalidated) item must never surface as a
  // KNN neighbour: `deleteVector` drops its entry from the vector space so
  // `semanticSearch`/`relatedItems` can no longer return it. No-op (never an
  // error) when no backend is configured, and never propagates a backend
  // failure into a soft-delete that has already committed above — the same
  // "never throws into the caller" discipline as `scheduleEmbed` (§2.5): a
  // vector-cleanup failure here just means backfill/a future prune sweep
  // still needs to catch it, never that the delete itself should fail.
  const backend = getSemanticBackend();
  if (backend !== null) {
    try {
      await backend.deleteVector(node.id);
    } catch (err) {
      console.error(
        `backlog: deleteVector failed for node ${node.id} after soft-delete (item is invalidated regardless; vector cleanup will need a later sweep): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

export { dedupeScan };
