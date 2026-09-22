# Sox-Integration Plan — backlog v2 ← sox-ecosystem

> Source: architect triage, 2026-09-22, per user directive: "we made heavy
> changes to sox packages to wrap up and eliminate all custom sql and all the
> modeling issues… those improvements were not properly integrated after their
> publish… make sure that all those features are correctly utilized in backlog
> v2 eliminating much of the code." Read-only analysis; ADR catalog read in
> full (`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/`, 16 ADRs; backlog-v2
> has no `docs/decisions/`). Load-bearing: ADR-0010 (open typing), ADR-0012
> (multi-process + taxonomy), ADR-0013 (no env feature-switches), ADR-0016
> (semantic facade). ADR-0015 is PROPOSED/never-accepted — do not adopt.

## 0. Headline correction — the central hypothesis is FALSE

The premise "sox shipped tx-scoped primitives, so `tx.ts` dies" does **not**
hold at any published or HEAD revision.

- graph-store HEAD v0.10.0: `writeNode` → `this.writeNodeInTx(..., this.adapter)`;
  `writeNodeInTx` is **private**; `writeEdgeInternal` **private**, runs on
  `this.adapter`; `invalidateEdge`/`touch`/`getNodeByUid` all bare-adapter;
  `transaction<T>(fn)` = `return this.adapter.transaction(fn)` — no mode, no
  adapter swap.
- Published 0.9.2 `dist/index.d.ts` declares the same private shape.

**Consequence:** upgrading removes **~0 lines of `tx.ts`**. The S-14
cluster-1 elimination (~205 tx.ts + claim/delete/catalog) is reachable **only
after G1** (new upstream work). `writeEdgeInternal` is also called without a
tx from `writeGraph`/`writeEdges` — the library's own bulk paths are not
edge-tx-safe either.

## 1. Version matrix (verified 2026-09-22)

| Package | Declared (backlog pkg.json) | Installed (worktree) | Published latest | sox HEAD |
|---|---|---|---|---|
| `sox-graph-store` | `^0.10.0` | **0.9.2** | 0.10.0 | 0.10.0 |
| `sox-store-adapter` | `^0.9.1` | **0.9.1** | 0.9.2 | 0.9.2 |
| `sox-hybrid-search` | `^0.4.3` | **0.4.3** | 0.4.5 | 0.4.5 |
| `sox-semantic` | `^0.1.2` hard | **0.1.3** | **0.1.4** | **0.1.5 (UNPUBLISHED)** |
| `sox-telemetry` | `^0.3.0` | 0.3.0 | 0.3.0 | 0.3.0 |
| `sox-vector-store` | `^0.6.0` opt | 0.6.1 | 0.6.1 | 0.6.1 |
| `sox-embedding-provider` | `^0.4.1` opt | 0.5.0 | 0.5.0 | 0.5.0 |

Main repo `node_modules` is staler still (graph-store 0.8.6, adapter 0.7.0).
Declared `^0.10.0` is **unsatisfied** in the worktree — Finding 0 is real and
is the first prerequisite.

**Notable recent changes:** graph-store `d9a5023`/`0.9.0` (surface primitives:
`transaction`, `invalidateEdge`, `writeEdges`, `getNodesByIds`, `countBy`,
edge-metadata filtering, keyset `NodeFilter.after`; `NodeUniquenessPolicy`
seam), `0bbf11e`/`0.9.1` (`NodeRecord.uid`, `getNodeByUid`), `1bc47e2`/`0.10.0`
(`NodeFilter.isSuperseded` pushdown), ADR-0010 open typing + migration module.
adapter `0.9.1`/`0.9.2` (open-race retries). vector-store 0.6.1 (`VecFilter`
pure `{ids}`; empty-ids fix in flight). embedding 0.5.0 (batch-first
`embedBatch`, three-tier taxonomy, adaptive fastembed pooling). hybrid-search
0.4.x (N-signal RRF; `StoreSearchBackend` async vector backend; 0.4.5 →
graph-store 0.10.0). semantic 0.1.0–0.1.4 (facade; deps bumps); **0.1.5 HEAD
unpublished = optional-loadability fix** (lazy dynamic imports +
optionalDependencies; residual: hybrid-search still hard-declares the heavy
two). telemetry 0.3.0 (role persistence, lock ordering, logDir re-init).

## 2. Feature → elimination map

| Upstream capability | Backlog code that dies / changes | Replacement | Behavior change |
|---|---|---|---|
| `createSemanticBackend` (semantic 0.1.5) | `write/bootstrap.ts` `deriveMembers` 237-401 (~184 lines: `Opt*` mirrors, `loadOptional`, `checkDim`, `embedding`/`search` objects); `store/semantic-search.ts` (already S-01) | `createSemanticBackend({adapter, embedding, embeddingProvider?, vectorBackend?})`; map `.embedQuery/.embedDocument/.upsertVector/.deleteVector/.health` onto `IEmbeddingBackend` + `SemanticStoreMembers.search` | Typed failure taxonomy replaces ad-hoc logs. Keep a thin `spacePopulated` probe (facade exposes no `iter`). `PermanentEmbeddingDimensionError` drops iff red/green proves `SpaceInvariantError` covers dim mismatch. **Blocked on G5.** |
| `NodeFilter.isSuperseded` (graph 0.10.0) | `as unknown as NodeFilter` casts: `views/semantic.ts:394, 455-460`; `query.ts` current-row sites | real `NodeFilter.isSuperseded` | `countNodes`/`countNodesFts` totals stop inflating; keyset pages stop coming up short. Ranked path still needs `dropSupersededResults` (G3). |
| `getNodesByIds`/`countBy`/`NodeFilter.after`/edge-meta (graph 0.9.0) | `stats.ts` N×`countNodes`; hand-rolled keyset/edge-meta reads | `graph.countBy`, `graph.getNodesByIds` (already at `semantic.ts:603`), `filter.after`, `getEdges({metadata})` | Fewer round-trips; stable paging. Read-path only. |
| `writeEdges`/`invalidateEdge` (graph 0.9.0) | ETL / `move.ts` bulk edge paths | `graph.writeEdges`/`invalidateEdge` | None only **outside** a backlog tx — unusable inside (G1). |
| adapter error predicates + open-race retries | `write/errors.ts:403-419`; `immediate-retry.ts:34-36` | already adopted; residual `isBusyContention` duplication → G2 | Fewer cold-open failures. |
| embedding batch + pooling (0.5.0) | `embed-queue.ts` serialization (S-01 list); backfill could batch | `embedBatch` | Removes head-of-line blocking. |
| `VecFilter {ids}` + empty-ids fix (in flight) | `semantic-search.ts:379-397` (dies with file); `views/semantic.ts` short-circuits | pass `NodeFilter` straight to `searchRanked` | "zero-not-unfiltered" upstream-owned (G6). |
| telemetry 0.3.0 | `serve.ts:179-204` dual-init/logDir; `index.ts:173-183` | `initTelemetry({role, logDir})` | Verify against 0.3.0 dist before deleting. |
| ADR-0010 open typing | `graph-backlog-store.ts:42` stale closed-vocab comment; `OPEN_TYPE_POLICY` stays | `NODE_TABLE_DDL_OPEN` + `migrateToOpenSchema` | The legacy closed-schema write failure resolves via cutover to an open-schema store. |

**`tx.ts`/`claim.ts`/`delete.ts`/`catalog.ts`:** the hand-composed SQL does
**not** die from any shipped feature. The reconciled ~205 (tx.ts) + ~14
(delete.ts) + ~8 (claim.ts) are reachable only after **G1**.

**Correction to the brief:** `query/views/semantic.ts` does NOT hand-roll
RRF/fusion — it delegates to `StoreSearchBackend.searchRanked` (475-518). The
custom code there is filter resolution + the supersede post-filter.

## 3. Upstream gaps

- **G1 — BLOCKING, `sox-graph-store`.** Expose tx-scoped primitives: overload
  `transaction<T>(fn, {mode})` to swap the effective adapter for the callback
  (preferred — backlog needs `BEGIN IMMEDIATE`, ADR-0012 §1), or publish
  `writeNodeInTx`/`writeEdgeInTx`/`invalidateEdgeInTx`/`touchInTx`/
  `getNodeByUidInTx`. Unlocks ~205 tx.ts + claim/delete/catalog.
- **G2 — `sox-store-adapter`.** Export a combined `isBusyOrContention(err)`.
- **G3 — `sox-hybrid-search`.** Accept `isSuperseded` (or general NodeFilter
  passthrough) in `SearchQuery.filters`; kills `dropSupersededResults` +
  over-fetch (views/semantic.ts:425-518, 591-600). This is T-07's request.
- **G4 — `sox-graph-store`.** Fix `migrateToOpenSchema` Turso refusal +
  `nodeNeedsRebuild` heuristic (cutover hardening).
- **G5 — `sox-semantic`.** Publish 0.1.5 (optional-loadability at HEAD; npm
  latest 0.1.4) + close its hybrid-search residual (hybrid-search must move
  the heavy two to optionalDependencies).
- **G6 — graph-store/vector-store/hybrid-search.** Empty-ids conflation fix
  (in flight; not re-planned here).
- **G7 — `sox-graph-store`.** `SortField` joined-edge column (if in-memory
  `sortByPriorityRank` is to die).

## 4. Sequencing (vs STATE.md §H waves)

- **Wave 0 (removal, in flight) — independent of sox + one prerequisite:**
  the lockfile re-install (declared `^0.10.0` must actually resolve 0.10.0).
  Do not delete `bootstrap.ts` — it is the adoption site.
- **Wave 1 (S-02+C-01) — no publish needed.**
- **Wave 2 (clear fixes + config) — adopt the published features:** real
  `isSuperseded` (drop the casts), `countBy`/`getNodesByIds`/`after`/edge-meta;
  align declared ranges (`embedding ^0.5.0`, `vector ^0.6.1`, `hybrid ^0.4.5`,
  `adapter ^0.9.2`, `graph ^0.10.0`); remove the dead hard dep
  `@adhd/sox-semantic` → `optionalDependencies` **only after G5**.
- **Wave 3 sub-waves:** 3a semantic adoption (waits on **G5**); 3b tx/catalog
  elimination (waits on **G1** — new sox work; dispatch after the S-13 fix
  lands in graph-store to avoid version-bump collisions); 3c ranked-path
  cleanup (waits on **G3+G6**); 3d telemetry workaround removal (verify
  against 0.3.0 dist first).

## 5. Verification requirements per integration

- **Lockfile re-install:** assert `require('@adhd/sox-graph-store/package.json').version === '0.10.0'`; `nx affected -t test`.
- **`isSuperseded` adoption:** keep green `superseded-ranking.spec.ts`,
  `superseded-views.spec.ts`, `superseded-listing.spec.ts`,
  `get-superseded-uid.spec.ts`; add a pin that `queryNodes({isSuperseded:false})`
  excludes a superseded row without a cast; negative control: drop the
  predicate → red.
- **semantic adoption:** keep green `write/bootstrap.spec.ts`,
  `api.semantic-laziness.spec.ts`, `text-routing.spec.ts`,
  `views/semantic.spec.ts`; red/green proving `SpaceInvariantError` covers dim
  mismatch before deleting `PermanentEmbeddingDimensionError`.
- **tx elimination (3b):** the load-bearing suite stays green unchanged —
  `cross-process-write-safety.spec.ts` (AC-22), `claim.spec.ts` (AC-16),
  `delete.spec.ts`, `catalog-verbs.spec.ts`, `update.spec.ts`,
  `transition.spec.ts`, `relate.spec.ts`, `move.spec.ts`, `create-issue.spec.ts`,
  `audit-fields.spec.ts`, `superseded-uid-guard.spec.ts`. Add a parity test:
  tx-scoped library write vs current hand-composed write → byte-identical rows.
  Negative control: `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred` still flips the CAS
  test red.
- **zero-not-unfiltered:** behavioral pin against the real installed vector
  store (Wave 0 A–D acceptance).
- **Consumer-outcome (§7):** drive the real `adhd-backlog create/query`
  (CLI/MCP), never a bypass.

## 6. Notes / tensions

- `ADHD_BACKLOG_UNSAFE_DEDUPE_MODE` / `ADHD_BACKLOG_UNSAFE_TX_MODE`
  (tx.ts:374-385, 776-786) gate behavior via env — ADR-0013 bans
  behavior-switching env vars, but that ADR is sox-ecosystem policy and these
  are documented negative-control-only in a different repo. Low priority.
- ADR-0015 (backlog daemon) is PROPOSED, never accepted; its env-flag escape
  hatch contradicts ADR-0013 — do not let it enter this plan.
