# `@adhd/backlog` — RAG-Enabled Intelligent Plan-Graph System

**Version:** v0.3.0
**Date:** 2026-08-08
**Status:** Design basis for EPIC-G. Builds on the plugin architecture (`docs/spec/backlog/PLUGIN_ARCHITECTURE.md`) and the dimensional graph model v2 (`docs/spec/backlog/GRAPH_MODEL_v2.md`). Targets `@adhd/sox-graph-store` 0.6.0 (adapter-based, async), `@adhd/sox-store-adapter` (Turso substrate), `@adhd/sox-embedding-provider` 0.2.0, `@adhd/sox-service-proxy`.

**Companion reading:** `SPEC.md` (operation surface, personas, status vocabulary), `DESIGN.md` (graph mapping, claim protocol), `PLUGIN_ARCHITECTURE.md` (how the embedding capability plugs into backlog), `GRAPH_MODEL_v2.md` (the dimensional node/edge model this layer's vectors attach to).

---

## 0. Substrate — verified facts

- **Adapter:** `@adhd/sox-store-adapter` `createStoreAdapter({ dbPath })` defaults to `turso` (`@tursodatabase/database@^0.7.1`, `TursoAdapterImpl`). The adapter is the single handle for graph, vector, and escape-hatch SQL — one file, one writer.
- **Graph:** `@adhd/sox-graph-store` 0.6.0 `createGraphBackend(adapter: StoreAdapter, opts?: { typePolicy })` — the entire API is async; `StoreAdapter.transaction(fn, { mode: 'immediate' })` is the CAS primitive; `buildNodeFilterClause` is exported for predicate pushdown into any adapter query.
- **Vectors:** `createVectorDialect(adapter.config.type)` → `TursoVectorDialect` — `F32_BLOB(dim)` columns (dimension is structural at the schema level), `CREATE INDEX ON (embedding)` (Turso infers the DiskANN index), `vector_distance_cos/l2/dot`, and a `topKQuery` emitting a parameterised `WHERE` seam for filter pushdown. `vecToBlob`/`blobToFloat32` are the vector byte codecs.
- **Embedding provider:** `@adhd/sox-embedding-provider` 0.2.0 — `EmbeddingProvider` interface (`embedSingle(text, role?)` / `embedBatch`), fastembed `bge-base-en-v1.5` (768-dim), shared ONNX/fastembed child singleton, cache-hit/cache-miss warmup budgets (a cache hit is single-digit seconds; a cache miss is the model-download budget).
- **Service transport:** `@adhd/sox-service-proxy` — `serveBackend` (generic JSON-RPC dispatcher over a UDS socket), `dialBackend`, `ensureBackend` (O_EXCL singleton spawn-lock). The embedding daemon is a sox-owned bundled service; backlog is a client via the `embedding-remote` plugin (PLUGIN_ARCHITECTURE.md §3, §6).

Backlog never touches a raw SQLite handle. Every escape-hatch SQL path goes through the adapter; the raw-handle construction sites are gone.

## 1. Design principles

1. **The embedding capability is a plugin.** Backlog's store code talks only to the `EmbeddingProvider` interface. The transport (UDS to the sox embedding service) is the `embedding-remote` plugin's concern.
2. **Transport-agnostic store.** `scheduleEmbed`, `semanticSearch`, `dedupeScan`, `suggestDependencies` all see `store.embedding.provider` — never the socket, never the service.
3. **Vectors attach to items by `node_id`.** The vector table is keyed by the graph node's rowid — a direct 1:1 join key, unchanged by the dimensional model (repo/author/reporter are edge-connected nodes, not item payload).
4. **Correct-by-construction reads.** Dimensional filters push into the SQL predicate (via `buildNodeFilterClause` + the dialect's filter seam) before any limit — pagination is never a post-filter.
5. **Truthful health and provenance.** A provider is never reported healthy without a resolved backend; the `embed_model` stamp comes from the resolved model, never from config.
6. **RAG is opt-in.** Absent embedding configuration, the v1 surface is unchanged: `listItems({ grep })` stays FTS-only, semantic operations throw `RagNotConfiguredError` — never a silent no-op.

## 2. Embedding on write — the two-phase pattern

### 2.1 Phase A / Phase B

**Phase A (synchronous, inside the CAS transaction):** `createItem` / `updateItem` write the node via the mutation primitives — no embedding call inside the transaction. The node is immediately FTS-searchable.

**Phase B (after commit, off the write lock):** `scheduleEmbed(store, nodeId, content)` embeds `${title}\n\n${body}` (never the raw stored `content` column — the uniqueness marker is stripped first) via `store.embedding.provider.embedSingle(content, 'document')`, then upserts the vector in its own small transaction. The upsert is idempotent per `(nodeId, modelId)`.

`scheduleEmbed` is never called from inside the mutation updater — always after the transaction has committed and released the write lock. ONNX inference runs on the service's child process, so the call never blocks the SQLite/Turso write path.

### 2.2 Durability for short-lived processes

Fire-and-forget is correct for a long-lived server (the vector lands milliseconds later). It is wrong for a one-shot process — a CLI command that exits before the embed resolves loses the vector permanently. The store keeps a per-store tracked in-flight set and a drain:

- `CreateItemInput` / `UpdateItemInput` gain `awaitEmbed?: boolean` (default `false` — today's fire-and-forget server behavior).
- `GraphBacklogStore.flushEmbeds()` drains the in-flight set (bounded, deterministic).
- `closeGraphBacklogStore` becomes async and drains before closing the adapter.

A one-shot host must do one of: pass `awaitEmbed: true` on every write, or call `flushEmbeds()` once before exit, or simply `await closeGraphBacklogStore(store)` — the drain is the belt-and-suspenders backstop. A caller that does none of these reproduces the lost-vector defect; the drain mechanism is what closes the gap, and a negative-control test proves it (reopen a fresh store and assert the vector is `null` when the drain was bypassed).

### 2.3 Re-embed on edit

`updateItem` schedules a re-embed on every title/body change — the vector is always recomputable and re-synced, independent of any FTS content-immutability constraints, because the vector upsert is a plain overwrite.

### 2.4 Provenance

The `embed_model` stamp is written in the same transaction as the vector upsert, using **`provider.metadata.modelId` resolved from the service's `modelInfo`** — never a config default and never a pre-initialised value (a stamp that can be written before a provider resolves is unfalsifiable and is not accepted). A row with a null stamp is honest: provenance unknown.

### 2.5 Failure handling

`scheduleEmbed` never throws into the caller. A failed embed degrades that item's semantic results (it is FTS-reachable, not vector-reachable) and is repaired by the backfill sweep (§7). A backend-down (`TransientEmbeddingError`) defers to backfill. A returned vector whose dimension does not match the resolved model is a `PermanentEmbeddingError` — the dimensional contract is structural, never silently truncated.

## 3. Semantic retrieval

### 3.1 Hybrid search behind `semanticSearch`

`grep` is **pure FTS, always** — keyword search keeps its exact-match semantics and never changes shape when the semantic layer lands (INTERFACE_v2 §7.6 / AC-11: `grep` and `semantic` compose additively; a user can always tell which channel returned a hit). The vector channel lives exclusively behind `semantic` / `view:"similar"` / `sort:"relevance"`.

`semanticSearch(ctx, query, opts?)` is the explicit vector-recall surface: it returns a documented `RagNotConfiguredError` when no embedding is configured — a caller relying on vector recall is never quietly downgraded to keyword search. It is also the **primary channel of the natural-language query form** (INTERFACE_v2 §2.1b): the positional `backlog query "nx bugs and apigen"` sends the *entire string* through `semanticSearch` (paraphrase-aware recall), **unscoped across all repos by default** — the query planner's dimensional extraction (kind/package/repo) runs alongside only as ranking boosts and surfaced suggestions, and never narrows semantic recall; explicit `--repo`/`--package` flags are the only way to scope.

The `BacklogFilter` / `listItems` signature does not change; only what runs inside does. Dimensional filters (repo/author/reporter/project/package from GRAPH_MODEL_v2) push into the vector channel's candidate selection via `buildNodeFilterClause` through the dialect's filter seam — a repo-scoped semantic search never returns another repo's items.

### 3.2 `relatedItems(id)` — nearest neighbor

Embed the query item's vector and KNN with the dimensional filter (`namespace`/repo scoping in the predicate, not a post-filter). The query item itself is excluded; only live items are returned.

### 3.3 Reranking — optional

A cross-encoder rerank is an optional post-fusion step on `semanticSearch` only (never on `listItems({ grep })`, which stays cheap and always-on). Default: threshold-gated (rerank only when the top fused score is ambiguous).

### 3.4 Vector payloads

Vectors travel as compact blobs in the service RPC payloads (base64 of the raw `Float32Array` bytes, ~4 KB per 768-dim vector), never as verbose JSON number arrays. Localhost UDS carries them in microseconds; the dominant per-call cost is inference, which the shared daemon amortizes to one warm model per host.

## 4. Semantic dedup

`dedupeScan` gains a semantic candidate source alongside the existing FTS/metadata sources: embed the incoming `${title}\n\n${body}`, KNN within the repo scope, and surface candidates above the near-dup threshold band as `duplicateCandidates`. `createItem`'s result contract reports suppression explicitly — `{ ok, created: boolean, humanId?, duplicateCandidates?, reason? }` — a silent drop is never possible (GRAPH_MODEL_v2 §5.1).

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

All RAG operations land inside the 6-tool surface (INTERFACE_v2): read side as `backlog_query` views (`view: "similar"` + `sort: "relevance"`, plan-graph ops as compositions of `view: "plan"` / `view: "order"`), write/ops side as `backlog_admin` actions (`run_dedup_sweep`, `cluster_into_plans` / `promote_cluster_to_plan`, `backfill_embeddings`, `list_near_duplicates`, `embedding_health` — snake_case throughout, INTERFACE_v2 §6).

## 7. Backfill and ops

`backfillEmbeddings` iterates every live, **non-terminal** item lacking a vector and schedules embeds, batched to bound concurrent inference (via the task-queue substrate). `dryRun` reports the count without calling the provider. A **re-embed-on-content-change sweep** ships with the graph-model migration: any item whose `content_hash` changed (e.g. canonical repo-string re-stamp) gets its embedding regenerated — a stale vector is a correctness defect, and the backfill's "only if null" predicate alone would never repair it. The sweep reuses the same batching and dry-run discipline. Terminal items (`isTerminalStatus`) are excluded by default and counted in the report as `skippedTerminal` — `run_dedup_sweep` iterates every vector with no status predicate of its own, so an embedded closed item would otherwise pull live items into advisory `SAME_AS` edges with already-closed work (`cluster_into_plans` already filters terminal items at its own candidate step). `includeTerminal: true` opts closed history back in.

## 8. Testing / DoD (real components, teeth, no proxies)

1. **Real semantic search returns ranked results** — real Turso adapter + real fastembed provider, ≥5 real items, a paraphrased query matching one item's content but not its exact words ranks in the top 3 (driven through `semanticSearch` — the vector channel; `grep` stays pure FTS). Negative control: zero the vector weight — the item drops out, proving the vector channel contributes.
2. **Real critical path** — real `DEPENDS_ON` chain A→B→C plus an independent D; `criticalPath` returns the chain end with length strictly greater than D's. Negative control: break the weight accumulation — all paths report length 1.
3. **Semantic dedup catches a paraphrased duplicate** — two items with no shared words beyond one; the second surfaces as `duplicateCandidates` of the first via the vector channel; the FTS-only path does not catch the pair. Negative control proves the semantic addition is load-bearing.
4. **`suggestDependencies` never writes an edge** — candidates are correct AND the edge table is unchanged before/after the call.
5. **`blockerImpact` counts a real transitive cone** — chain A→B→C→D; `blockerImpact('D')` reports 3. Negative control: cap depth at 1 — the count drops to 1.
6. **`clusterIntoPlans` groups real embedded items** — 4 semantically close OAuth items cluster together; 2 unrelated items stay out. Asserts on real DBSCAN output.
7. **RAG-not-configured degrades cleanly** — semantic operations throw `RagNotConfiguredError` against a store without embedding config, while `listItems({ grep })` keeps returning real FTS results.
8. **`nx build backlog` + `nx run backlog:verify-dist-load`** stay green — the shipped `dist/` loads the native/ONNX-bearing dependencies.
9. **A short-lived process's embed survives exit** — `awaitEmbed` / `flushEmbeds` / async close, reopen a fresh store on the same file, assert the vector is present AND `relatedItems`/`semanticSearch` returns the item. Negative control: bypass the drain (bare close) — the reopened store's vector lookup is `null`, proving the drain is what closes the gap.
10. **Provenance** — `embed_model` stamp equals the resolved `modelInfo` modelId. Negative control: a backend reporting a model id the client never resolved is rejected.

Every test uses a real Turso DB + real embeddings under `tmp/backlog/<test-name>/`, removed on teardown.

## 9. Phasing

0. **Phase 0 — substrate (EPIC-F).** graph-store 0.6.0 + adapter + async conversion; forced-immediate supersede transactions. Everything below depends on it.
1. **Phase 1 — plugin host + embedding service (G-part-1).** Plugin seam, `embedding-remote`, the sox embedding bundle, the upstream Turso vector backend prerequisite. `semanticSearch` / `relatedItems` / upgraded `listItems({ grep })` / flushEmbeds / awaitEmbed (the durability fix ships here, not deferred — it is a correctness fix).
2. **Phase 2 — semantic dedup (G-part-2).** `dedupeScan`'s semantic source, `listNearDuplicates`, `runDedupSweep`. Depends on Phase 1 embeddings.
3. **Phase 3 — plan-graph intelligence.** `criticalPath`, `blockerImpact` (pure traversal — can ship in Phase 1), `clusterIntoPlans` / `promoteClusterToPlan`, `planReadiness`, `recommendNextWork`, `suggestDependencies` / `suggestRelated`.
4. **Phase 4 — backfill/ops.** `backfillEmbeddings`, the re-embed-on-content-change sweep.

Reranking is an optional knob within Phase 1 — ship fusion-only first, add `opts.rerank` once quality is measured against real usage.

## 10. Embedding model

`bge-base-en-v1.5` (768-dim) is the service default, owned by the embedding service — one model per host keeps the dimensional contract uniform. Model choice is a service configuration, not a per-call backlog concern.
