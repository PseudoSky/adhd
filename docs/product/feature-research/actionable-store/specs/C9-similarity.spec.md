# C9 — Cross-project **similarity** detection and reviewed linking

> **Ticket:** `cf97c613-2c0a-4f1b-805e-4fe773743c31` (HIGH) · component (`backlog`)
> **Design:** `../DESIGN.md` §2 Primitive 1 (Reference — merge/redirect, "over-merge is the dominant failure"), §5 AC1, §6 Identity · `../../substrate-fleet/DESIGN.md` §X1 · `../../substrate-fleet/SOX-REQUIREMENTS.md` SR-14
> **Depends on:** C1 (`merge-project`/`rm-project`, `followRedirect`, `resolveLogicalIssue`) — designed, not implemented.
> **ADRs read:** ADR-0001 (store atomicity — the store owns atomicity; no temp-file/rename/flock for backlog data), ADR-0002 (correct the source), ADR-0003 (CJS-only publish), ADR-0004 (flat MCP `content`, no `{result}` envelope).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 3 · **Dependencies:** C1 (non-terminal — C9 consumes C1's canonical/redirect shape; it does not ship before C1) · **Evidence requirement:** `similarity-scan.spec.ts`, `similar-view.spec.ts`, `relate.similar.spec.ts`, `create-similar-scope.spec.ts`, and `relate-similar.e2e.ts` (two REAL processes, file-signal latch, exit-code keyed) with the AC1–AC9 negative controls.

> **Rename (owner decision).** "Duplicate" is the wrong word in general: the scan detects **similarity**, not identity. The scan surfaces **similar** candidates (advisory, writes nothing). A reviewed link uses the **existing `relate` verb** with a new relation **`similar_to`** — **no new verb**, and `link-duplicate` is removed everywhere. `duplicate_of` is **reserved** for the reviewed judgement that two items are *actually the same*; it is kept, not repurposed. The read surface is renamed to align with the **existing `view:"similar"`** vocabulary: card pseudo-field **`similar`** (not `duplicates`), filter **`similarTo`/`hasSimilar`** (not `duplicateOf`/`hasDuplicates`).

## Summary

Make similarity detection **scope-aware** and similar-item links **visible and reviewable**, without ever auto-linking. Today the create-time scan is hard-scoped to one project (`create-issue.ts`'s `scanForDuplicates`, `filter: { project: project.uid }`), the `duplicate_of` edge already crosses projects but nothing reads it (`resolve.ts`'s `getIncomingEdges` is defined and never called; `resolveRelated` filters only `relates_to`). C9 adds: a typed scan scope (`same-project | multi-project | store-wide`, default unchanged), a multi-signal + margin guard with a **distinct** cross-project threshold, a read surface of candidate similarity **clusters** with provenance (extending the existing `view:"similar"`), a `similar` card pseudo-field, `similarTo`/`hasSimilar` filter dimensions, a reviewed link written through the existing **`relate`** verb as relation **`similar_to`**, and the issue-level canonical resolver (`resolveCanonicalIssue`) that generalizes C1's one-hop redirect from projects to issues **for the reserved `duplicate_of` relation**. **Invariant: the scan is advisory — it never writes a link.**

## Premise corrections (read before implementing)

1. **Similarity is `n:m`, so it needs no canonical head.** `similar_to` is a many-to-many advisory relation: any number of items may be similar to any number. The old "a cluster of >2 cannot be N links to one canonical" reasoning applied to `duplicate_of` (`n:1`, in `catalog.ts`) — which is **reserved** for the reviewed actual-same judgement. Keep `duplicate_of` `n:1`; do **not** repurpose it and do **not** widen its multiplicity. The canonical resolver C9 adds operates over the reserved `duplicate_of` chain only; the similarity path never needs it.
2. **`link-duplicate` is removed; the reviewed link is `relate`.** The owner decision forbids a new verb. A reviewed link is `relate {sourceUid, targetUid, rel:"similar_to", action:"add", by}`, and `similar_to` joins the **public** relation enum with an `EDGE_KIND_TABLE` row (`issue → issue`, `n:m`). **Trade-off, stated:** `relate` has no free-text `reason` field, so a `similar_to` link records only the generic audit note (`note: rel`) — the reason that a bespoke verb would have carried is dropped. If a reason is later required, that is a change to `relate`, never a new verb.
3. **`getIncomingEdges` exists and is unused** (in `resolve.ts`) — reuse it for the incoming `similar_to` direction; do not add a second reverse-lookup helper (ADR-0002).
4. **The scan uses raw `search.backend.search` + `vecScore` (cosine), deliberately not `searchRanked`** (RRF discards magnitude — see `scanForDuplicates`'s own doc comment). The multi-signal guard must extend that raw-scan path; it must **not** switch to `searchRanked`.
5. **The same-project threshold (default `0.8`) is calibrated for same-project byte-identical refiles** (in `catalog.ts`, `scanForDuplicates` doc). It must stay the same-project value; cross-project scoring gets a **distinct** policy value. Sharing one number re-suppresses legitimate cross-repo filings or admits boilerplate (AC7/AC8).
6. **AC1 is already covered by a shipped test** — `create-duplicate-gate.spec.ts` ("an identical title/body in a DIFFERENT project is never a candidate"). C9's default scope must keep it green byte-for-byte.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | `src/write/catalog.ts` | modify (foundation request — `IProjectPolicy` + defaults + `EDGE_KIND_TABLE` `similar_to` row) | 90 | 70 |
| entrypoint/backlog | `src/write/similarity-scan.ts` | create (shared scan; extracted from create-issue) | 240 | 420 |
| entrypoint/backlog | `src/query/similarity-signals.ts` | create (pure multi-signal comparator) | 0 | 200 |
| entrypoint/backlog | `src/write/create-issue.ts` | modify (call the shared scan) | 240 | 120 |
| entrypoint/backlog | `src/query/canonical.ts` | create (issue-level C1 generalization over the RESERVED `duplicate_of`) | 60 | 140 |
| entrypoint/backlog | `src/query/similar-clusters.ts` | create (`view:'similar'` cluster block) | 120 | 300 |
| entrypoint/backlog | `src/query/types.ts` | modify | 120 | 220 |
| entrypoint/backlog | `src/query/card.ts` | modify (`similar` projection) | 120 | 160 |
| entrypoint/backlog | `src/query/views/semantic.ts` | modify (`similarTo`/`hasSimilar` dims) | 140 | 120 |
| entrypoint/backlog | `src/query/query.ts` | modify (view dispatch + `resolveEdgeScopedFilterIds`) | 200 | 160 |
| entrypoint/backlog | `src/api.ts`, `src/index.ts`, `src/server.ts` | modify (mount is unchanged — the reviewed link reuses `relate`; no `BACKLOG_VERBS` change from C9) | 60 | 40 |
| entrypoint/backlog | `src/write/similarity-scan.spec.ts`, `src/write/relate-similar.e2e.ts`, `src/query/similar-view.spec.ts`, `src/write/create-similar-scope.spec.ts` | create | 0 | 1 500 |

**Foundation gate (CONTRACT.md).** `write/catalog.ts` is READ-ONLY to downstream agents. This spec **requests** (a) the four typed `IProjectPolicy` fields + `DEFAULT_PROJECT_POLICY` values, and (b) one `EDGE_KIND_TABLE` row for `similar_to`. Hand it to the foundation owner as a request, not a unilateral edit.

## Interface changes

### `src/write/catalog.ts` — scope, threshold, and the `similar_to` edge (FOUNDATION REQUEST)

```typescript
// IProjectPolicy — append four typed fields (data, never env toggles):
export type ISimilarityScope = 'same-project' | 'multi-project' | 'store-wide';
export interface IProjectPolicy {
  /* …existing similarityScanEnabled, similarityThreshold (same-project, default 0.8)… */
  /** Scan breadth for the CREATE-TIME advisory scan. Default preserves today's behaviour (AC1). */
  readonly similarityScope: ISimilarityScope;
  /** Cosine threshold for CROSS-project candidates. MUST differ from similarityThreshold (AC8). */
  readonly similarityCrossProjectThreshold: number;
  /** Minimum top-vs-next score gap for a cross-project candidate (margin guard). */
  readonly similarityCrossProjectMargin: number;
  /** Minimum title-token Jaccard overlap for the second independent signal (AC7). */
  readonly similarityCrossProjectTokenOverlap: number;
}
// DEFAULT_PROJECT_POLICY adds:
//   similarityScope: 'same-project', similarityCrossProjectThreshold: 0.92,
//   similarityCrossProjectMargin: 0.05, similarityCrossProjectTokenOverlap: 0.5

// EDGE_KIND_TABLE — append one PUBLIC row (the reserved duplicate_of row is untouched):
{ rel: 'similar_to', sourceKind: 'issue', targetKind: 'issue', multiplicity: 'n:m' }, // C9
```

### `src/query/types.ts`

```typescript
// IIssueFilter — two new edge-scoped dimensions (RENAMED from duplicateOf/hasDuplicates)
export interface IIssueFilter {
  /* …existing… */
  /** uid of X: return items linked `similar_to` X. */
  similarTo?: string;
  /** true: return items with ≥1 incoming `similar_to` link. */
  hasSimilar?: boolean;
}

// IIssuePseudoField — one new member ('similar', NOT 'duplicates').
// See C4's canonical final union; this spec adds 'similar' only.
export interface ISimilarRef {
  uid: string;
  title: string;
  status: string;
  projectUid?: string;
  repoUrl?: string;
}
export interface ISimilarLinks {
  /** Items THIS one is linked `similar_to` (outgoing, n:m). */
  similarTo: ISimilarRef[];
  /** Items linked `similar_to` THIS one (incoming, n:m). */
  similarFrom: ISimilarRef[];
}
export interface IIssueCard { /* …existing… */ similar?: ISimilarLinks; }

// `view:'similar'` is REUSED (not a new 'duplicates' view) — additive cluster block.
export interface ISimilarMember {
  uid: string; title: string;
  projectUid: string; projectName: string; componentUid?: string; repoUrl?: string;
  score?: number;            // cosine to the cluster seed (undefined for linked-only members)
  signals?: string[];        // which independent signals fired, e.g. ['cosine','title-tokens']
  linkedTo?: string;         // a `similar_to` target when linked
}
export interface ISimilarCluster {
  seedUid: string;           // the top-scoring member that anchored the cluster
  members: ISimilarMember[];
  linked: boolean;           // true iff `similar_to` edges exist among members
}
export interface ISimilarViewClusterBlock {
  candidate: ISimilarCluster[];  // advisory scan output; never writes
  linked: ISimilarCluster[];     // built from existing live `similar_to` edges
  scanned: number;
  computedAt: string;
}
```

`IIssueRef.rel` (added by **C2**) is widened by C2 to include `'similar_to'` and the reserved `'duplicate_of'` — do **not** re-declare it here.

### `src/write/similarity-scan.ts` (NEW — the ONE scan, shared by create + view)

```typescript
export interface ISimilarityScanInput {
  title: string;
  body: string;
  scope: ISimilarityScope;
  /** Required for 'same-project'/'multi-project': the filing project. */
  projectUid?: string;
  sameProjectThreshold: number;
  crossProjectThreshold: number;
  margin: number;
  tokenOverlapMin: number;
  limit?: number;
}
/**
 * Read-only advisory scan. SAME raw `search.backend.search` path the shipped
 * scan uses (never `searchRanked`). Returns best-first candidates with
 * provenance + the signals that fired. NEVER writes. Returns [] when the
 * embedding substrate is absent (the documented degraded mode).
 */
export async function scanSimilarCandidates(
  handle: ISimilarityScanHandle,
  input: ISimilarityScanInput
): Promise<ISimilarCandidate[]>;
```

`ISimilarCandidate` (currently local to `create-issue.ts`) gains **additively**:

```typescript
export interface ISimilarCandidate {
  uid: string; title: string; score: number;
  scope: 'same-project' | 'cross-project';
  provenance?: { projectUid: string; projectName: string; componentUid?: string; repoUrl?: string };
  signals?: string[];
}
```

Candidate-id resolution by scope (reusing `resolveSimilarFilterIds`/`resolveEdgeScopedCandidates` — never a second traversal):
- `same-project` → `resolveSimilarFilterIds({ project })` (today's path).
- `multi-project` → union of the filing project and every **sibling** project reachable via a **shared `repoUrl` or shared `component.meta.path`**; else the store-wide id set.
- `store-wide` → `undefined` (no `ids` restriction) with `kind:'issue', isSuperseded:false, liveOnly:true`.

The multi-signal guard (`similarity-signals.ts`, pure):
- `titleTokenOverlap(a, b): number` — Jaccard over lowercased alphanumeric tokens, stop-word-stripped.
- `sharedStructuralSignal(a, b): boolean` — any shared citation `file`/`symbol`/`errorText`/`blastRadius` token, or shared `component.meta.path` prefix.
- A **cross-project** candidate is surfaced iff `vecScore >= crossProjectThreshold` **AND** (`titleTokenOverlap >= tokenOverlapMin` **OR** `sharedStructuralSignal`) **AND** the top-vs-next margin holds. Same-project candidates keep today's cosine-only rule (no regression to AC1).
- **Cosine alone is never sufficient cross-project** (AC7).

### `src/write/create-issue.ts` (MODIFY)

`scanForDuplicates` becomes a thin caller of `scanSimilarCandidates` (same pre-transaction, read-only position in `create-issue.ts`). `duplicateAction` gating is unchanged and remains **same-project only**: a cross-project candidate is poured into the advisory `similarCandidates` report but **never** triggers `comment` (a write into a foreign project) and **never** writes a `similar_to` edge (AC3). `duplicateAction:'comment'` with a cross-project top candidate is rejected `InvalidArgumentError('duplicateAction', ...)`.

### The reviewed link — the existing `relate` verb, relation `similar_to`

There is **no `link-duplicate` verb**. A reviewed link is:

```
relate {sourceUid, targetUid, rel:'similar_to', action:'add', by}
```

`relate` resolves both uids live, rejects self-link, and writes the `similar_to` edge through the existing `writeEdgeTx` (+ `checkMultiplicityTx`; `n:m`, so many links are permitted). The audit note is the rel (`note:'similar_to'`) — `relate` has no free-text `reason`, so none is recorded (the trade-off in Premise correction 2). Idempotent on re-add.

### `src/query/canonical.ts` (NEW — C1 generalized to issues, for the RESERVED `duplicate_of`)

```typescript
/** Walk a `duplicate_of` source→target chain to the head (cycle-guarded, bounded),
 *  then C1's `resolveLogicalIssue` (merge redirect + SUPERSEDES chain) on the head.
 *  Returns the input when unlinked. NEVER throws on a linked uid.
 *  Operates over the RESERVED `duplicate_of` relation ONLY — the similarity path
 *  does not call it. */
export async function resolveCanonicalIssue(graph: GraphBackend, uid: string): Promise<string>;
/** tx-scoped variant for the reserved same-judgement write path. */
export async function resolveIssueCanonicalTx(tx: AdapterTransaction, uid: string): Promise<string>;
```

### `src/query/similar-clusters.ts` + `query.ts` (extends `view:'similar'`)

`query {view:'similar', filter:{project?|component?}, limit?}` → its result gains an optional `clusters` block (`ISimilarViewClusterBlock`). `candidate` runs `scanSimilarCandidates` with the filter's scope and clusters by mutual similarity (single-linkage, bounded by `limit`). `linked` is built from existing live `similar_to` edges via `getIncomingEdges` (the currently-dead helper). Without the embedding substrate, `candidate` is `[]` (the existing degraded mode) and `linked` still returns — matching the read-view pattern of `ready`/`stale`.

### `src/query/card.ts` — `similar` projection

```typescript
export async function resolveSimilar(graph, issueId, outgoing?): Promise<ISimilarLinks>;
// outgoing `similar_to` (n:m) + incoming via getIncomingEdges(graph, issueId) filtered rel==='similar_to'.
```
Wired behind `want('similar')` exactly like `blockers`/`related`; add `needsSimilar` to the `outgoing`-fetch guard in `assembleIssueCard`.

### `src/query/views/semantic.ts` + `src/query/query.ts` — filter dimensions

`resolveSimilarFilterIds` and `resolveEdgeScopedFilterIds` gain branches over `similar_to`: `similarTo` → resolve X live → `getEdges({dst:X.id, rel:'similar_to'})` → `src` set; `hasSimilar` → `getEdges({rel:'similar_to'})` → `dst` set. Both are edge-scoped candidate sets intersected with the rest, exactly like `plan`/`project`. `similarTo` resolves **source** ids; `hasSimilar` resolves **dst** ids.

## Behavioral changes

- **Create scan** — default `similarityScope:'same-project'` is byte-for-byte today's behaviour (AC1). `multi-project`/`store-wide` widen `candidateIds` only; the write path is untouched; no link is ever written (AC3).
- **Cross-project candidate** — carries `scope:'cross-project'` + `provenance`; never acts via `comment`; never written.
- **Reviewed link** — `relate {rel:'similar_to'}` is the ONLY writer of a `similar_to` edge from this feature; the scan never writes.
- **`resolveCanonicalIssue`** — read-only; a `duplicate_of` cycle (impossible by construction, not enforced) is bounded and returns the last good uid, mirroring `currentUidOf`'s defensive walk.
- **Card/filter/view** — all read-path, additive; a card that does not request `similar` is unchanged; `view:'similar'` without the new block is unchanged.
- **`duplicate_of`** — untouched; stays reserved, `n:1`, surfaced (legibly) via C2's widened `IIssueRef.rel`.

## Data / migration

1. **No schema change.** `similar_to` is a new relation row in `EDGE_KIND_TABLE` (foundation request). The reserved `duplicate_of` already exists. Existing `duplicate_of` edges become *visible* via C2's `related` (a read-shape change) — no backfill.
2. **Policy defaults preserve behaviour** (AC1); existing projects without the new fields resolve the defaults via `resolveProjectPolicy`.
3. **No auto-merge, no auto-link, no backfill writes.** Candidate surfacing is advisory; linking is a reviewed operator act (DESIGN §Risk: over-merge).
4. **Cross-store (different DB) similarity** is out of scope (ticket). Duplicate **project** rows remain a sox-side decision (SOX-REQUIREMENTS SR-14 / ADR-0002 D4).

## Test list (each AC → a test + its negative control)

| AC | Test (real store, real verbs, no mocks) | Negative control (must go RED) |
|----|------------------------------------------|-------------------------------|
| AC1 | `create-duplicate-gate.spec.ts` stays green; a new case asserts `resolveProjectPolicy` default `similarityScope==='same-project'` | Flip the default to `'multi-project'` → the shipped cross-project case surfaces a candidate → red |
| AC2 | Seed project B with identical content; policy `multi-project` → candidate with `scope:'cross-project'` + `provenance`; policy `same-project` → none | A scan hard-wired to `filter.project` → the ON case returns none → red |
| AC3 | With scope ON, after `createIssue`, count live `similar_to` edges in the store == pre-scan count (0) | An implementation that links from the scan → edge count 1 → red |
| AC4 | `relate {rel:'similar_to'}` cross-project writes one `similar_to` edge + one audit; a self-link is refused and writes nothing | Drop the audit write, or allow a self-link → red |
| AC5 | `get {fields:['similar']}` on a linked item returns `similarTo`+`similarFrom`; a test asserting the link is invisible fails | Revert the `want('similar')` wiring → the card omits → red |
| AC6 | `query {filter:{similarTo:<uid>}}` returns the linked item; `{hasSimilar:true}` returns the other side; both compose with `project` | An ignored dimension returns the unfiltered page → red |
| AC7 | Two near-identical boilerplate items from unrelated repos (high cosine, zero token/structural overlap) are **NOT** surfaced cross-project | Remove the multi-signal guard → boilerplate surfaces → red |
| AC8 | A paraphrase fixture (cosine in `[sameProjectThreshold, crossThreshold)`) is not surfaced; assert `similarityCrossProjectThreshold !== similarityThreshold` | Set `similarityCrossProjectThreshold = similarityThreshold` → paraphrase surfaces → red |
| AC9 | The reserved `duplicate_of` remains `n:1`; `A→C`, `B→C` resolves both to `C` via `resolveCanonicalIssue` | Widen `duplicate_of` to `n:m`, or return the source as canonical → red |

**Concurrency (latch, no sleeps).** `relate-similar.e2e.ts`: two real processes, each its own adapter connection, barrier-released to add two `similar_to` links from one source to two targets under a `duplicate_of`-style single-valued guard → for `similar_to` (`n:m`) both must succeed; a separate case over the reserved `duplicate_of` asserts exactly one `SingleValuedRelationConflictError`. Negative control: `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred` → torn state → red. Trust exit codes, not stdout.

## Blast radius (gitnexus)

> `gitnexus` is not exposed in this agent's tool set — this is **read-derived**. Run `gx impact scanForDuplicates`, `gx impact resolveSimilarFilterIds`, `gx impact assembleIssueCard`, `gx impact EDGE_KIND_TABLE`, `gx impact relate` before editing and reconcile.

- **`scanForDuplicates`** — sole caller `createIssue` (in `create-issue.ts`). Extracting it into `similarity-scan.ts` is a pure move; both call sites keep the pre-transaction position. **MEDIUM**.
- **`resolveSimilarFilterIds`** — callers: `scanForDuplicates`, `querySimilarView`. New branches must not change the result for the six existing dimensions. **MEDIUM**.
- **`IProjectPolicy`** — widening is additive; `resolveProjectPolicy` returns fresh objects; every consumer reads named fields. **LOW**, but the `.freeze` discipline means new fields must be added to `DEFAULT_PROJECT_POLICY` in the same change.
- **`IIssuePseudoField`** — the derived MCP `oneOf`/wire schema widens (`query-output-codec.spec.ts`, `server.mcp.e2e.ts`). **MEDIUM**.
- **`IIssueView`/`IIssueQueryResult`** — the existing `'similar'` view gains an additive cluster block; no new view member, so no unhandled-view path. **LOW–MEDIUM**.
- **`IIssueRef.rel` (C2 owns it)** — C2 widens the union to include `'similar_to'` and `'duplicate_of'`; C9 must **not** re-declare it. If an implementer reuses `IIssueRef` for the `similar` projection, the rel tag is `'similar_to'`.
- **`relate`** — extends its public relation enum by one (`similar_to`); the verb's transaction body is unchanged. `EDGE_KIND_TABLE` gains the `similar_to` row (foundation request). **LOW–MEDIUM**.
- **`BACKLOG_VERBS`** — **unchanged by C9** (no new verb; the reviewed link reuses `relate`).

## Independent segments (execution order)

### Segment 1 — Policy + types + edge row
- **Files:** `write/catalog.ts` (request), `query/types.ts`.
- **Deps:** none. **Read:** `catalog.ts`'s policy/`EDGE_KIND_TABLE` region, `query/types.ts`'s filter/pseudo-field/view unions. **Out** ~290.
- **Do NOT** widen `duplicate_of`'s multiplicity; add `similar_to` instead.

### Segment 2 — Scan + signals
- **Files:** `query/similarity-signals.ts` (create), `write/similarity-scan.ts` (create), `write/create-issue.ts`.
- **Deps:** 1. **Read:** `create-issue.ts`'s scan region. **Out** ~620.
- **Do NOT** switch to `searchRanked`; keep the raw `backend.search` + `vecScore` path.

### Segment 3 — Canonical (reserved) + reviewed link
- **Files:** `query/canonical.ts` (create); the reviewed link reuses `write/relate.ts` + the `similar_to` row.
- **Deps:** 1. **Read:** `relate.ts`'s tx skeleton, `resolve.ts`'s `currentUidOf`. **Out** ~440.
- `similar_to` is `n:m`; the reserved `duplicate_of` keeps its existing `n:1` multiplicity gate.

### Segment 4 — Read surface
- **Files:** `query/card.ts`, `query/similar-clusters.ts` (create), `query/views/semantic.ts`, `query/query.ts`.
- **Deps:** 2, 3. **Read:** `card.ts`'s projection region, `query.ts`'s view/filter region. **Out** ~800.

### Segment 5 — Tests
- **Files:** the four spec/e2e files. **Deps:** all. **Read** ~200. **Out** ~1 500.
- Trust runner exit codes, not stdout.

## Documentation

- `entrypoint/backlog/skill/SKILL.md`: the `similar` field, `similarTo`/`hasSimilar`, the `similar_to` relation (reviewed, via `relate`), the scope policy, the `view:"similar"` cluster block. **No `link-duplicate` verb** is documented.
- `write/CONTRACT.md`: the policy fields, the `similar_to` edge row, the **advisory-only, never-auto-link** invariant, and the reserved status of `duplicate_of`; `resolveCanonicalIssue` as C1's issue-level generalization **over the reserved relation**.
