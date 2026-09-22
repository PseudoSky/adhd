# `@adhd/backlog` — RAG-Enabled Intelligent Plan-Graph System

**Version:** 0.4.0
**Date:** 2026-09-22
**Status:** Design basis for EPIC-G. The shipped semantic seam is `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers` (memoized per `StoreAdapter`), reached lazily from `api.ts`'s `ensureSemanticReady`; the write-side embed is `write/embedding-observer.ts`'s `scheduleIssueEmbedding` (post-commit; fire-and-forget unless `awaitEmbed:true`). §1–§3 describe that shipped seam; §4–§10 remain forward design for the semantic-dedup and plan-graph layers. Builds on the store adapter and dimensional graph node/edge model (`DESIGN.md` §3/§9, `DATA_MODEL.md`). Targets `@adhd/sox-graph-store` (adapter-based, async), `@adhd/sox-store-adapter` (Turso substrate), `@adhd/sox-embedding-provider` (an `optionalDependency`).

**Companion reading:** `SPEC.md` (operation surface, personas, status vocabulary), `DESIGN.md` (graph mapping, claim protocol, the RAG seam), `DATA_MODEL.md` (the dimensional node/edge model this layer's vectors attach to).

---

## 0. Substrate — verified facts

- **Adapter:** `@adhd/sox-store-adapter` `createStoreAdapter({ dbPath })` defaults to `turso` (`@tursodatabase/database`, `TursoAdapterImpl`). The adapter is the single handle for graph, vector, and escape-hatch SQL within a process. The store is **parallel-process enabled**: any number of processes may hold concurrent write connections to the same file, serialized by the adapter's own locking (WAL + `busy_timeout` + `BEGIN IMMEDIATE`). "One file, one writer" is false and was never the invariant — ADR-0012 supersedes ADR-0007's single-writer claim, and a single writer would have no need for the CAS protocol (`DESIGN.md` §3/§4).
- **Graph:** `@adhd/sox-graph-store` 0.6.0 `createGraphBackend(adapter: StoreAdapter, opts?: { typePolicy })` — the entire API is async; `StoreAdapter.transaction(fn, { mode: 'immediate' })` is the CAS primitive; `buildNodeFilterClause` is exported for predicate pushdown into any adapter query.
- **Vectors:** `createVectorDialect(adapter.config.type)` → `TursoVectorDialect` — `F32_BLOB(dim)` columns (dimension is structural at the schema level), `CREATE INDEX ON (embedding)` (Turso infers the DiskANN index), `vector_distance_cos/l2/dot`, and a `topKQuery` emitting a parameterised `WHERE` seam for filter pushdown. `vecToBlob`/`blobToFloat32` are the vector byte codecs.
- **Embedding provider:** `@adhd/sox-embedding-provider` — `EmbeddingProvider` interface (`embedSingle(text, role?)` / `embedBatch`), fastembed `bge-base-en-v1.5` (768-dim). It is an `optionalDependency`, resolved directly by `write/bootstrap.ts` through a non-literal dynamic `import()` so an unconfigured build has zero compile-time dependency on it. The default `embedding.provider` is `fastembed` (in-process ONNX); a deployment may point it at a shared/remote provider type instead. Backlog owns no plugin host and no embedding daemon of its own — it constructs whatever provider type the config names, and sees only the derived `embedding`/`search` members from then on.

Backlog never touches a raw database driver handle. Every escape-hatch SQL path goes through the adapter; there is no direct-driver construction site anywhere in the package.

## 1. Design principles

1. **The embedding capability is an optional, injectable member.** Backlog's store code talks only to the `embedding`/`search` members `write/bootstrap.ts` derives. The transport or provider implementation (in-process fastembed, or a remote provider type) is entirely behind that member — backlog never sees a socket or a driver.
2. **Transport-agnostic store.** The write-side embed (`scheduleIssueEmbedding`, `write/embedding-observer.ts`) and the read-side semantic filters (`query/query.ts`, `query/views/semantic.ts`) see only `handle.embedding` / `handle.search` — never a provider implementation.
3. **Vectors attach to items by `node_id`.** The vector table is keyed by the graph node's rowid — a direct 1:1 join key, unchanged by the dimensional model (repo/author/reporter are edge-connected nodes, not item payload).
4. **Correct-by-construction reads.** Dimensional filters push into the SQL predicate (via `buildNodeFilterClause` + the dialect's filter seam) before any limit — pagination is never a post-filter.
5. **Truthful health and provenance.** A provider is never reported healthy without a resolved backend; the `embed_model` stamp comes from the resolved model, never from config.
6. **RAG is opt-in.** Absent embedding configuration, the keyword-search surface is unchanged: `listItems({ grep })` stays FTS-only, semantic operations throw `RagNotConfiguredError` — never a silent no-op.

## 2. Embedding on write — the two-phase pattern

### 2.1 Phase A / Phase B

**Phase A (synchronous, inside the CAS transaction):** `createItem` / `updateItem` write the node via the mutation primitives — no embedding call inside the transaction. The node is immediately FTS-searchable.

**Phase B (after commit, off the write lock):** `scheduleIssueEmbedding(handle, { action: 'upsert', subjectRowid, subjectUid, actor, content })` (`write/embedding-observer.ts`) embeds `composeEmbedText(title, body)` = `` `${title}\n${body}`.trim() `` via `handle.embedding.embedDocument(content)`, then upserts the vector with `handle.embedding.upsertVector(rowid, vec)`. The vector is keyed by the graph node's **rowid**, not its `uid`; the upsert is idempotent per `(rowid, modelId)`. It then writes its own `embedding_upserted` / `embedding_failed` audit row in a follow-up `immediate` transaction, using the same `executeWriteTransaction` every subject write uses.

`scheduleIssueEmbedding` is never called from inside the mutation updater — always after the transaction has committed and released the write lock. The provider's inference (in-process ONNX, or a remote round-trip) runs outside the Turso write path, so the call never blocks it.

### 2.2 Durability for short-lived processes

Fire-and-forget is correct for a long-lived server (the vector lands milliseconds later). It is wrong for a one-shot process — a CLI command that exits before the embed resolves loses the vector permanently. The live write layer closes that gap **per write**, not with a store-level drain:

- `CreateIssueInput` / `UpdateIssueInput` / `DeleteIssueInput` carry `awaitEmbed?: boolean` (default `false` — the fire-and-forget server behavior).
- `create`/`update`/`delete` each call `scheduleIssueEmbedding(...)` strictly AFTER their subject transaction commits, and `await` the returned promise when `awaitEmbed` is `true`.
- A one-shot host that needs a durable vector passes `awaitEmbed: true` on the write that produced it. There is no `GraphBacklogStore.flushEmbeds()` drain and no per-store in-flight set: that mechanism belonged to the deleted `store/embed-queue.ts`, and `closeGraphBacklogStore` no longer drains — it closes the adapter and nothing else. A caller that never sets `awaitEmbed: true` still reproduces the lost-vector defect; the awaited per-write promise is what closes it now.

### 2.3 Re-embed on edit

`updateItem` schedules a re-embed on every title/body change — the vector is always recomputable and re-synced, independent of any FTS content-immutability constraints, because the vector upsert is a plain overwrite.

### 2.4 Provenance

The `embed_model` stamp is written in the same transaction as the vector upsert, using **`provider.metadata.modelId` resolved from the provider itself** — never a config default and never a pre-initialised value (a stamp that can be written before a provider resolves is unfalsifiable and is not accepted). A row with a null stamp is honest: provenance unknown.

### 2.5 Failure handling

`scheduleIssueEmbedding` never throws into the caller. A failed embed degrades that item's semantic results (it is FTS-reachable, not vector-reachable), writes an `embedding_failed` audit row, and is repaired by the backfill sweep (§7). A returned vector whose dimension does not match the resolved model is a `PermanentEmbeddingDimensionError` (`write/bootstrap.ts`) — the dimensional contract is structural, never silently truncated.

## 3. Semantic retrieval

### 3.1 Hybrid search behind the semantic filters

`grep` is **pure FTS, always** — keyword search keeps its exact-match semantics and never changes shape when the semantic layer lands (SPEC.md §5a: `grep` and `semantic` compose additively; a user can always tell which channel returned a hit). The vector channel lives exclusively behind `semantic` / `view:"similar"` / `sort:"relevance"`.

The explicit vector-recall surface is `query`'s `filter.semantic` (with `view: "similar"` / `sort: "relevance"`): when no embedding backend is configured the `search` member is absent, and `queryIssues` reports `InvalidArgumentError('semantic', ...)` (mapped to the `rag_not_configured` envelope code) — a caller relying on vector recall is never quietly downgraded to keyword search. It is also the **primary channel of the natural-language query form** (SPEC.md §6.5): the `text` argument to `query` sends the _entire string_ through the semantic ranker (paraphrase-aware recall) whenever the vector space holds vectors, **unscoped across all repos by default** — the query planner's dimensional extraction (kind/package/repo) runs alongside only as ranking boosts and surfaced suggestions, and never narrows semantic recall; explicit scoping flags are the only way to narrow it.

The `BacklogFilter` / `listItems` signature does not change; only what runs inside does. Dimensional filters (repo/author/reporter/project/package, per `DATA_MODEL.md` §5) push into the vector channel's candidate selection via `buildNodeFilterClause` through the dialect's filter seam — a repo-scoped semantic search never returns another repo's items.

### 3.2 `relatedItems(id)` — nearest neighbor

Embed the query item's vector and KNN with the dimensional filter (`namespace`/repo scoping in the predicate, not a post-filter). The query item itself is excluded; only live items are returned.

### 3.3 Reranking — optional

A cross-encoder rerank is an optional post-fusion step on `semanticSearch` only (never on `listItems({ grep })`, which stays cheap and always-on). Default: threshold-gated (rerank only when the top fused score is ambiguous).

### 3.4 Vector payloads

Vectors travel as compact blobs in the service RPC payloads (base64 of the raw `Float32Array` bytes, ~4 KB per 768-dim vector), never as verbose JSON number arrays. Localhost UDS carries them in microseconds; the dominant per-call cost is inference, which the shared daemon amortizes to one warm model per host.

## 4. Semantic dedup

The duplicate gate (`scanForDuplicates`, invoked from `createItem`'s write path, SPEC.md §6.4) scores candidates on **the vector channel's raw cosine similarity, and only ever a cosine** — the same `[0,1]` scale `project_policy.dedupe_threshold` is calibrated against. It reads `StoreSearchBackend.search`'s `vecScore` straight off `vec.knn`, never `searchRanked`'s fused score: `searchRanked` combines the text and vector channels by reciprocal-rank fusion (`Σ w_i/(RRF_K + rank_i)`), and rank fusion discards each channel's magnitude by construction — no rescaling of a rank-fused number, including dividing by its theoretical rank-1 maximum, can recover a similarity from it. A prior implementation that tried exactly that rescaling produced a rank ladder (rank 1 → 1.0, rank 2 → ~0.984, rank 5 → ~0.938) sitting entirely above the default threshold, which suppressed every create into a project holding any prior issue. The scan embeds the incoming `${title}\n${body}`, restricts candidates to the same project, and surfaces every candidate at or above `dedupe_threshold` as `duplicateCandidates`, best-first. `createItem`'s result contract reports suppression explicitly — `{ created: boolean, uid?, duplicateCandidates?, reason? }` — a silent drop is never possible.

When the search substrate cannot embed (no vector channel configured), the scan still runs on the text channel alone rather than going dark; it simply surfaces no candidates, since with no vector channel there is no calibrated similarity to compare against the threshold.

A periodic `runDedupSweep` runs pairwise near-dup detection over a scope's vectors and writes `SAME_AS` edges for confirmed pairs (soft, non-blocking) — review-then-merge, never auto-merge.

## 5. Intelligent plan graph

These operations are substrate-independent (pure graph traversal over `DEPENDS_ON`) and ship with or ahead of the embedding layer:

- **`criticalPath`** — weighted longest path through the `DEPENDS_ON` DAG (CPM): what must be worked first.
- **`blockerImpact`** — the size of an item's backward-reachable set: how much work it unblocks.
- **`recommendNextWork`** — ranks open, unclaimed items by critical-path position, then impact-cone size, then priority.
- **`clusterIntoPlans`** — DBSCAN over item embeddings groups semantically similar open items into candidate plans (persisted as distinct candidate nodes; a human/planner promotes, never auto-created plans).
- **`planReadiness`** — plan rollup: total/done/ready/blocked counts, cycle detection, percent complete, next recommended item.
- **`suggestDependencies` / `suggestRelated`** — read-only candidate lists from KNN; a confirm gate is structural (no write path in the suggestion functions). `DEPENDS_ON` is never auto-suggested with a directional guess; only non-directional `RELATES_TO`.

## 6. Operation surface

RAG operations land on the existing 14-verb surface (`src/api.ts`; `get, query, lookup, create, update, transition, claim, relate, move, upsertProject, upsertComponent, upsertLocation, rmLocation, delete` — there is no `admin` verb). Read-side RAG operations are `query` views (`view: "similar"` + `sort: "relevance"`, plan-graph ops as compositions of `view: "plan"` / `view: "order"`). `run_dedup_sweep`, `cluster_into_plans` / `promote_cluster_to_plan`, and `backfill_embeddings` are one-shot/periodic maintenance operations, not verbs a caller addresses by `uid` — per SPEC.md §6.6, that is precisely why they are not mounted as a grab-bag admin action: they run as scripts directly against `src/write/`/`src/query/`, never as a 15th consumer-facing verb. `embedding_health` and `list_near_duplicates` fold into `query`'s `view:"similar"` (SPEC.md §5a) — a health/near-duplicate report is exactly "run the similarity view over the whole corpus," not a distinct code path.

## 7. Backfill and ops

`backfillEmbeddings` iterates every live, **non-terminal** item lacking a vector and schedules embeds, batched to bound concurrent inference (via the task-queue substrate). `dryRun` reports the count without calling the provider. A **re-embed-on-content-change sweep** ships alongside it: any item whose `content_hash` changed (e.g. canonical repo-string re-stamp) gets its embedding regenerated — a stale vector is a correctness defect, and the backfill's "only if null" predicate alone would never repair it. The sweep reuses the same batching and dry-run discipline. Terminal items (`isTerminalStatus`) are excluded by default and counted in the report as `skippedTerminal` — `run_dedup_sweep` iterates every vector with no status predicate of its own, so an embedded closed item would otherwise pull live items into advisory `SAME_AS` edges with already-closed work (`cluster_into_plans` already filters terminal items at its own candidate step). `includeTerminal: true` opts closed history back in.

## 8. Testing / DoD (real components, teeth, no proxies)

1. **Real semantic search returns ranked results** — real Turso adapter + real fastembed provider, ≥5 real items, a paraphrased query matching one item's content but not its exact words ranks in the top 3 (driven through `semanticSearch` — the vector channel; `grep` stays pure FTS). Negative control: zero the vector weight — the item drops out, proving the vector channel contributes.
2. **Real critical path** — real `DEPENDS_ON` chain A→B→C plus an independent D; `criticalPath` returns the chain end with length strictly greater than D's. Negative control: break the weight accumulation — all paths report length 1.
3. **Semantic dedup catches a paraphrased duplicate** — two items with no shared words beyond one; the second surfaces as `duplicateCandidates` of the first via the vector channel; the FTS-only path does not catch the pair. Negative control proves the semantic addition is load-bearing.
4. **`suggestDependencies` never writes an edge** — candidates are correct AND the edge table is unchanged before/after the call.
5. **`blockerImpact` counts a real transitive cone** — chain A→B→C→D; `blockerImpact('D')` reports 3. Negative control: cap depth at 1 — the count drops to 1.
6. **`clusterIntoPlans` groups real embedded items** — 4 semantically close OAuth items cluster together; 2 unrelated items stay out. Asserts on real DBSCAN output.
7. **RAG-not-configured degrades cleanly** — semantic operations throw `RagNotConfiguredError` against a store without embedding config, while `listItems({ grep })` keeps returning real FTS results.
8. **`nx build backlog` + `nx run backlog:verify-dist-load`** stay green — the shipped `dist/` loads the native/ONNX-bearing dependencies.
9. **A short-lived process's embed survives exit** — write with `awaitEmbed: true`, reopen a fresh store on the same file, assert the vector is present AND a semantic read (`view:"similar"`) returns the item. Negative control: write with the default fire-and-forget and exit before the returned promise settles — the reopened store's vector lookup is `null`, proving the awaited per-write promise (not any store-level drain) is what closes the gap.
10. **Provenance** — `embed_model` stamp equals the resolved `modelInfo` modelId. Negative control: a backend reporting a model id the client never resolved is rejected.

Every test uses a real Turso DB + real embeddings under `tmp/backlog/<test-name>/`, removed on teardown.

## 9. Phasing

0. **Phase 0 — substrate (EPIC-F).** graph-store + adapter + async conversion; forced-immediate supersede transactions. Everything below depends on it.
1. **Phase 1 — the semantic seam (G-part-1).** `write/bootstrap.ts`'s `bootstrapSemanticStoreMembers` (lazy, memoized per `StoreAdapter`), the derived `embedding`/`search` members, `write/embedding-observer.ts`'s `scheduleIssueEmbedding`, and `awaitEmbed` (the durability fix ships here, not deferred — it is a correctness fix). The read surface is `filter.semantic` / `view:"similar"` / `sort:"relevance"`.
2. **Phase 2 — semantic dedup (G-part-2).** `dedupeScan`'s semantic source, `listNearDuplicates`, `runDedupSweep`. Depends on Phase 1 embeddings.
3. **Phase 3 — plan-graph intelligence.** `criticalPath`, `blockerImpact` (pure traversal — can ship in Phase 1), `clusterIntoPlans` / `promoteClusterToPlan`, `planReadiness`, `recommendNextWork`, `suggestDependencies` / `suggestRelated`.
4. **Phase 4 — backfill/ops.** `backfillEmbeddings`, the re-embed-on-content-change sweep.

Reranking is an optional knob within Phase 1 — ship fusion-only first, add `opts.rerank` once quality is measured against real usage.

## 10. Embedding model

`bge-base-en-v1.5` (768-dim) is the default model. The `modelId` is taken from the provider's own resolved `metadata` (never config), and it keys the vector space — one model per space keeps the dimensional contract uniform. Model choice is `embedding.model` config, not a per-call backlog concern.
