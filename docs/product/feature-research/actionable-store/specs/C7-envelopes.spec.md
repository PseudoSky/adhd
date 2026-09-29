# C7 — Honest envelopes & store observability

> **Ticket:** `395cfcad-b42a-46c1-8a59-c345840b6b9d` (HIGH) · component `9a7bf578`
> **Design:** `../DESIGN.md` §2 Invariant 5, §5 AC7 · **Conceptual test:** `../CONCEPTUAL_TEST.md` §B.8, §D.7-8
> **ADRs read:** ADR-0001 (store atomicity — read-only here; the store owns its reads), ADR-0002 (correct the source), ADR-0003 (CJS), ADR-0004 (flat payload).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 1 · **Dependencies:** none (Wave 1, independent) · **Evidence requirement:** `nx test backlog` green driving the real query/get/rollup paths, with the AC1–AC7 negative controls (each must go RED) — notably AC2 keeps the existing `meta-wire.e2e.ts` green and AC7 is an independent recomputation. Exit-code keyed.

## Summary

Make every page self-describing: a completeness flag on each item-list view, a named count on every derived score (`score_kind`), bounded `part-of-rollup` and `get` sub-collections, and a `report` grouped rollup whose every number is computed from the store at report time. Extend the existing `meta` shape (`total`/`returned`/`limit`/`offset?`/`truncated?`) — **never replace it**; consumers key on `truncated`.

## Premise corrections (read before implementing)

1. **The `meta` omission is deliberate and correct for non-row-set views.** `dispatchQueryView`'s own comment documents why `graph`/`order`/`overlap`/`similar` carry no `meta`: they are a graph, a topo order, an axis grouping, and a ranking — none a filtered row set with an honest "how many matched" count. **Do not bolt a `meta` onto those.** C7's completeness flag applies to the **item-list** views (`ready`, `stale`, `similar`), where `has_more`/`returned`/`limit` are all honestly derivable. The existing `meta-wire.e2e.ts` assertion that `view:'graph'` carries **no** `meta` is a load-bearing regression test — keep it green.
2. **`queryReady` cannot report a true pre-limit `total`** (documented in its own comment): it stops enumerating at `limit`. So the honest flag on `ready` is `has_more` (derived by fetching `limit+1`), **not** a fabricated `total`. Where a true count is unknowable at list cost, omit `total` rather than invent it (the design's own rule, DESIGN §7 condition 2).
3. **`part-of-rollup` already inlines every descendant uid** (`childrenOpenUids` in `stats.ts`), with **no** `limit`/`count_only` — `IPartOfRollupInput` is `{uid}` only. AC3 is a genuine new mode.
4. **`_score` is the RRF/temporal fused score** (`views/semantic.ts`) but is emitted untagged (`card.ts`); `score_kind` does not exist anywhere in the package (confirmed by exhaustive search). AC5 is entirely additive.
5. **`priorityMatrix` (in `views/stats.ts`) already computes counts by priority**, and `openCurve` already reconstructs age/status history. C7 AC7's `report` must **compose** these, not re-derive them (ADR-0002).

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | src/envelope.ts | modify | 60 | 60 |
| entrypoint/backlog | src/query/types.ts | modify | 90 | 140 |
| entrypoint/backlog | src/query/query.ts | modify | 260 | 340 |
| entrypoint/backlog | src/query/card.ts | modify | 120 | 160 |
| entrypoint/backlog | src/query/get.ts | modify | 30 | 90 |
| entrypoint/backlog | src/query/views/semantic.ts | modify | 120 | 160 |
| entrypoint/backlog | src/query/views/stats.ts | modify | 80 | 180 |
| entrypoint/backlog | src/query/views/report.ts | create | 0 | 260 |
| entrypoint/backlog | src/api.ts | modify | 50 | 120 |
| entrypoint/backlog | src/server.ts | modify | 20 | 20 |
| entrypoint/backlog | src/index.ts | modify | 20 | 30 |

## Interface changes

### src/envelope.ts — named count with exactness, and score provenance

```typescript
// AFTER — IQueryEnvelopeMeta gains two OPTIONAL keys (superset-compatible)
export type CountRelation = 'eq' | 'gte';

export interface ILabelledCount {
  value: number;
  /** How exact `value` is: `eq` exact, `gte` a lower bound (the ES `hits.total.relation` pattern). */
  relation: CountRelation;
}

export interface IQueryEnvelopeMeta {
  /** Existing — kept verbatim; consumers key on it. */
  total: number;
  returned: number;
  limit?: number;
  offset?: number;
  truncated?: boolean;
  // NEW (all optional — absent means "as before"):
  /** Set when `total` is a lower bound rather than exact (e.g. a capped scan). */
  total_relation?: CountRelation;
  /** True iff more rows exist beyond this page. Preferred spelling for views where `total` is unknowable. */
  has_more?: boolean;
  /** Opaque continuation token for cursor-paged views that are not keyset-paged today. */
  next_cursor?: string;
}
```
`IQueryEnvelopeMeta` is derived-not-curated where possible; adding optional keys is the migration (DESIGN Invariant 5).

### src/query/types.ts — score provenance + bounded sub-collections

```typescript
// AFTER
export type IScoreKind = 'rrf' | 'bm25' | 'cosine' | 'rank' | 'priority';

export interface IIssueCard {
  // ...existing...
  _score?: number;
  /** Provenance tag for `_score`. A rank-derived score is ordinal — never labelled similarity/confidence. */
  _score_kind?: IScoreKind;
}

export interface IIssueGetByUidInput {
  uid: IssueUid;
  fields?: readonly IIssueField[];
  /** Bounds the `auditTrail`/`citations`/`related`/`blocksOut` pseudo fields to the LAST N rows. */
  lastN?: number;
  /** Cursor for the bounded sub-collection (opaque; from the previous page's `nextCursor`). */
  after?: string;
}

// part-of-rollup
export interface IPartOfRollupInput {
  uid: string;
  /** Count-only mode: return the counts, omit the uid list entirely. */
  countOnly?: boolean;
  /** Max uids in `childrenOpenUids` when not count-only (default 50, max 1000). */
  limit?: number;
  /** Opaque cursor for the paged uid list. */
  after?: string;
}
export interface IPartOfRollupResult {
  uid: string;
  childrenTotal: number;
  childrenOpen: number;
  childrenClosed: number;
  /** Absent in count-only mode, or present and bounded by `limit`. */
  childrenOpenUids?: readonly string[];
  nextCursor?: string;
  hasMore?: boolean;
}
```

### src/query/views/report.ts (new) — the grouped rollup

```typescript
export interface IReportInput {
  filter?: { project?: string; component?: string; kind?: string | string[]; status?: 'open'|'closed'|'all' };
}
export interface IReportResult {
  /** Counts by `kind` name (live rows only). Composed from the same edge-scoping `priorityMatrix` uses. */
  byKind: Array<{ kind: string; count: number }>;
  /** Counts by `priority` name + rank. */
  byPriority: Array<{ priority: string; rank?: number; count: number }>;
  /** Status histogram. */
  byStatus: Array<{ status: string; terminal: boolean; count: number }>;
  /** Average age in days of open items, computed from `tCreated` at report time. */
  avgAgeDays: number;
  /** Every number above is derived from the store in THIS call; `statusScope` names what was counted. */
  statusScope: NonNullable<IIssueFilter['status']>;
  computedAt: string;
}
export async function report(handle: IQueryStoreHandle, input: IReportInput): Promise<IReportResult>;
```

## Behavioral changes

### `query {view:"ready", limit:5}` (AC1, AC2)
- **Change:** `queryReady` fetches `limit+1` and returns `{ items, hasMore }`; the `dispatchQueryView` meta-attachment (in `query.ts`) attaches `meta: { total, returned, limit, has_more }`. `total` is **omitted** (unknowable at bounded cost) or, when cheap, set with `total_relation:'gte'`.
- **Same for `stale` and `similar`.** `stale` applies no limit today, so `has_more` is `false`; still emit the meta for uniformity.
- **`meta` keys are a superset extension** — `total`/`returned`/`limit`/`offset?`/`truncated?` remain byte-identical on the `list` path (the existing `queryList` meta shape).

### `_score` provenance (AC5)
- **Change:** thread a `scoreKind` alongside `score` in `IAssembleIssueCardOptions` (in `card.ts`); set `card._score_kind`. `view:'similar'` and the list `semantic` branch set `'rrf'`; the list `grep`-only branch (`searchNodes` in `query.ts`) sets `'bm25'`; `sort:'priority'` sets `'priority'`.
- **`assembleIssueCards`** (in `card.ts`) gains an optional `scoreKind` map; the existing `scoreByUid` map stays.

### `filter.semantic` meta (AC6)
- **Change:** on the ranked list branch, `meta.total` is the **`baseFilter` count** (semantic reranks, never narrows), and `has_more` is `returned < limit` evaluated against the ranked window. Add `total_relation` when the ranked window truncated the true rerank set, so "matches" is never conflated with "corpus".

### Bounded sub-collections (AC3, AC4)
- **`get {fields:["auditTrail"], lastN:5}`** → ≤5 rows, newest-last (preserving `resolveAuditTrail`'s oldest-first order, sliced to the tail). `resolveAuditTrail`/`resolveCitations`/`resolveRelated` gain an optional `{ lastN, after }` bound applied in `assembleIssueCard` (in `card.ts`).
- **`part-of-rollup {uid, countOnly:true}`** → counts only, no `childrenOpenUids`. Paged mode returns ≤`limit` uids + `nextCursor`.

### `report` (AC7)
- **Change:** new mounted verb `report` (`api.ts` + `BACKLOG_VERBS`). Every field composed from live reads in the same call; no stored metric.

## Data / migration steps

- **None.** All read-path. No backfill, no schema change. `_score_kind` is computed, never stored.

## Test list (each AC → a test, with its negative control)

| AC | Test | Negative control (must go RED) |
|----|------|-------------------------------|
| AC1 | `query {view:"ready", limit:5}` with >5 matches → `meta.has_more===true`; with ≤5 → `false`. Assert both. | A build returning no `meta` for `ready` must fail |
| AC2 | Existing `meta-wire.e2e.ts` stays green: list `meta` has `total`/`returned`/`limit`, `truncated` absent when not truncated, `graph` has **no** `meta` | Removing `truncated` from the list meta, or adding `meta` to `graph`, must fail |
| AC3 | `part-of-rollup {uid, countOnly:true}` returns counts with **no** `childrenOpenUids`; paged mode returns ≤N uids + cursor | A build always inlining the full uid list must fail |
| AC4 | `get {fields:["auditTrail"], lastN:5}` returns ≤5 rows | The unbounded `resolveAuditTrail` in `assembleIssueCard` must fail |
| AC5 | Every `similar`/ranked result carries `_score_kind:"rrf"` | A bare `_score` with no `_score_kind` must fail |
| AC6 | `filter.semantic` meta reports a match count distinct from the corpus count (or omits it); `has_more` false on the final page | A build reporting corpus total as the match count must fail |
| AC7 | `report` output equals an **independent recomputation** over the same filter (run the same counts with a second code path in the test) | A report carrying a hardcoded/uncomputed metric must fail |

Trust runner exit codes, not stdout. The independent-recomputation test for AC7 must compute counts via direct store reads, not by calling `report` twice.

## Blast radius (gitnexus)

- `IQueryEnvelopeMeta` — consumed by `envelope.ts` success arm, `queryIssuesWithMeta`, `cli-envelope`/`meta-wire`/`paging-wire` e2e. **All new keys optional** → no consumer breaks.
- `dispatchQueryView` (in `query.ts`) — the single place view→meta is decided; only `list` currently attaches meta. Adding `ready`/`stale`/`similar` is local.
- `assembleIssueCard(s)` — callers: `get`, `query` (all list views), `semantic`, and the six write verbs' embedded cards. `_score_kind` is opt-in (only set when `_score` requested + kind known).
- `resolveAuditTrail` — callers: `assembleIssueCard` and `views/stats.ts` (`openCurve`'s batched version; **do not** bound that path — it needs the full trail). Add the bound at the `assembleIssueCard` call site, not inside `resolveAuditTrail`.
- `partOfRollup` — mounted in `api.ts`; sole consumer. Widening the result is additive.
- `server.ts` `BACKLOG_VERBS` — `report` must be added there or it is dropped from the extraction/transport surface.

## Independent segments (execution order)

### Segment 1 — Envelope + types (files: `envelope.ts`, `query/types.ts`)
- Deps: none. Read ~150 tok. Out ~200 tok.

### Segment 2 — List-view meta (file: `query/query.ts`)
- Deps: Segment 1. Read `:419-633`, `:1098-1188` (~260 tok). Out ~340 tok.
- `queryReady`/`queryStale` fetch `limit+1`; `dispatchQueryView` attaches meta.

### Segment 3 — Score provenance (files: `card.ts`, `query/query.ts`, `views/semantic.ts`)
- Deps: Segment 1. Read ~240 tok. Out ~300 tok.

### Segment 4 — Bounds (files: `card.ts`, `get.ts`, `views/stats.ts`)
- Deps: Segment 1. Read ~180 tok. Out ~280 tok.

### Segment 5 — `report` (files: `views/report.ts` create, `api.ts`, `server.ts`, `index.ts`)
- Deps: Segment 1. Read `views/stats.ts:243-393` (priorityMatrix precedent) ~120 tok. Out ~350 tok.

## Documentation

- `README`/`SKILL.md`: `meta` keys, `has_more`, `total_relation`, `_score_kind`, `lastN`, `part-of-rollup` modes, the new `report` verb.
- State explicitly that `graph`/`order`/`overlap` intentionally carry no `meta` (the DESIGN rationale), so no future agent re-adds one.
