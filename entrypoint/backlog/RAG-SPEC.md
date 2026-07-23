# `@adhd/backlog` — RAG-Enabled Intelligent Plan-Graph System

**Version:** v0.2.0
**Date:** 2026-07-23
**Status:** DESIGN ONLY — no implementation in this document. This is an **additive**
extension of the shipped `entrypoint/backlog/` package (`@adhd/backlog@0.0.1`, committed
`1be78422`, full `client.ts`/`store/*.ts`/`server.ts` already built/tested/lint/
`verify-dist-load` green per `BACKLOG.md` "`@adhd/backlog` implementation" session
entries). `SPEC.md` v0.1.0 and `DESIGN.md` v0.1.0 remain the base contract; this document
never contradicts them, only adds new operations and swaps internals **behind** three
existing ones. A subsequent implementer builds the RAG layer from this document without
re-deriving any of the research or API verification below.

**Companion reading:** `SPEC.md` (operation surface, personas, status vocabulary),
`DESIGN.md` (graph mapping, claim protocol, §9 "The RAG seam", §14 verified
`@adhd/sox-graph-store` facts). This document assumes both in full.

---

## 0. Ground truth check — the real shipped code (read before designing, not the stale sketch)

`DESIGN.md`'s code blocks are pre-implementation sketches; the real package has since
shipped and its actual structure is authoritative for every plug-in point below:

- `entrypoint/backlog/src/store/graph-backlog-store.ts:19-32` — `openGraphBacklogStore(dbPath)`
  constructs exactly one `better-sqlite3` handle (`journal_mode=WAL`, `busy_timeout=5000`),
  passes it to `createGraphBackend(db)`, and returns `{ db, graph }`. This is THE
  construction site every RAG addition below plugs into — a third field (`vector`) is
  added here (§3.2).
- `entrypoint/backlog/src/store/query.ts:45-47` — `listItems({grep})`'s real implementation
  already calls `store.graph.searchNodes(filter.grep, {...})` as a black box, exactly as
  `DESIGN.md` §9 anticipated. Upgrading this call site (not its signature) is the entire
  `semanticSearch`-behind-`listItems` seam (§3.3).
- `entrypoint/backlog/src/store/mutate-metadata.ts` (45 lines) and
  `entrypoint/backlog/src/store/claim.ts`/`ids.ts` are the real CAS primitives `DESIGN.md`
  §4.3/§2.4 describe — reused unchanged; no RAG addition needs a new transaction pattern
  for metadata (embeddings live in a *separate* vector table, not `metadata` — §7).
- `entrypoint/backlog/package.json` — real version `0.0.1`, real `dependencies` block
  (`@adhd/sox-graph-store@^0.3.0`, `better-sqlite3@^12.10.0`, `@adhd/environment@0.0.1`,
  `@adhd/environment-base-spec@0.0.2`, four `@adhd/apigen-*` packages). This spec's new
  dependencies (§2) are added to this same block, never replacing an existing one.
- Two real, already-filed upstream debts constrain this design and are cited rather than
  rediscovered: `DEBT-BACKLOG-CONTENT-IMMUTABLE-001` (`BACKLOG.md:1138-1143` —
  `touch()` cannot update `content`, so a title/body edit does not refresh FTS) and
  `DEBT-BACKLOG-CONTENT-HASH-COLLISION-001` (`BACKLOG.md:1131-1136` — `writeNode()`
  dedupes by a global content hash, mitigated today by an HTML-comment uniqueness marker
  appended to every node's `content`). Both interact directly with "recompute an
  embedding after edit" (§7).

---

## 1. Research grounding (memory MCP recall — performed before design)

Per the task's mandatory-first-step requirement, `mcp__memory-server__memory_recall`,
`memory_search_entities`, `memory_related`, and `memory_topics` were queried for: RAG
retrieval patterns, hybrid search, reranking, graph algorithms (PageRank/centrality,
community detection, shortest-path, topological sort, critical-path/DAG scheduling),
plan graphs/task DAGs, near-duplicate detection, and sox-ecosystem/memory-core design
research, before any package was opened. Results, with UIDs:

| Topic | Memory UID | What it says | Grounds |
|---|---|---|---|
| Graph-based RAG | `01KXNX6X8AR7XJWMHM43GNCHKD` (GraphRAG Survey, arXiv 2501.13958) | Graph-structured knowledge representation, multi-hop graph retrieval, structure-aware LLM context integration; catalogs the general GraphRAG design space. | §3 (semantic retrieval design rationale — why a plan graph benefits from combining vector search with graph traversal, not vector search alone). |
| Subgraph sizing for context | `01KXNX6T9TTC4AQFD2FEPR695H` (SubgraphRAG, ICLR 2025, arXiv 2410.20724) | MLP-scored subgraph retrieval with adjustable size to fit an LLM context window; structural-distance-aware neighbor selection. | §3.4 `relatedItems` — the "how many hops / how many neighbors to return" sizing question is the same tradeoff this paper frames, even though `@adhd/backlog` uses cosine-KNN, not a trained scorer (no sox package trains one — noted as a gap, not invented). |
| Impact-cone / reachability | `01KXNWV65KFJ5YV24SDF89KJB9` (Dynamic Transitive Closure Algorithms survey, arXiv 1709.00553) | Reachability/transitive-closure algorithms for "what depends transitively on X"; explicit O(1)-query/O(V²)-storage vs O(V+E)-query/O(V+E)-storage tradeoff. | §5.2 blocker-impact ranking — directly names the algorithm class (reachability over the dependency graph) used for `blockerImpact`. |
| Change-impact analysis | `01KXNRBQB8FAF3VJGRRG7PSYGT` (A Review of Software Change Impact Analysis, cited-238) | Reachability algorithms on dependency graphs are the standard technique for computing an "impact set" (everything a change affects); same storage/query tradeoff as above. | §5.2 — the SAME impact-cone concept applied to backlog items instead of source-code dependencies; directly justifies computing blocker-impact as a **reachable-set size**, not a hand-rolled heuristic. |
| Graph-DB transaction/concurrency | `01KXNX70MJ2NKR6TYP7WB1A8MC` (Landscape of Graph Databases survey, arXiv 2505.24758) | Property-graph storage, transaction/isolation-level tradeoffs for concurrent graph mutation. | Reaffirms (does not change) `DESIGN.md` §3/§4's existing `.immediate()` CAS choice; no new RAG-specific concurrency primitive is introduced — vector upserts get their own, simpler, single-row-keyed consistency story (§3.1, §7). |
| Temporal graph model | `01KXNZAZYHFCBW4T4ME27050KF` (TEG-QL, arXiv 1604.08568) | Timestamped node/edge properties for time-travel queries; maps to an edge-journal / bitemporal history model. | Not used directly by this spec (backlog's bitemporal history is already `@adhd/sox-graph-store`'s `t_created`/`t_invalid`/`invalidate()`/`supersede()` per `DESIGN.md` §14) — recalled but not additionally grounding anything new here; noted for completeness since it surfaced on the same query. |
| memory-write provenance pitfall | `01KXPA24S25BXY1DKDJ88BPHCT` | `memory_write` without an explicit `project_path` mis-attributes to the server's cwd. | Process note only (how *I* write follow-up memories about this session), not a design input. |

**Explicit gaps — memory was thin, so nothing below is invented past what was found:**

1. **No project-specific research on PageRank / eigenvector centrality.** The recall
   surfaced zero memory nodes about PageRank, HITS, or any iterative centrality method.
   §5.2 therefore does **not** propose PageRank — it names the actually-recalled
   algorithm class (reachability/impact-cone, from the two citations above) and
   separately flags PageRank as unimplemented in `@adhd/sox-analysis` (verified by
   reading the source, §2) rather than presenting a PageRank design that was never
   grounded in either memory or a real package.
2. **No project-specific research on Louvain / modularity-based community detection.**
   Same null result. §5.3 uses the clustering primitive that actually exists
   (`@adhd/sox-analysis`'s DBSCAN-over-cosine-embeddings `cluster()`, verified by
   reading source) and explicitly documents that this is **embedding-similarity**
   clustering, not graph-topology community detection — a real substitution, flagged,
   not a silent rename.
3. **No memory hits on hybrid-search/reranking implementation patterns specific to the
   sox ecosystem** (only general GraphRAG/SubgraphRAG survey papers, which are about the
   *problem*, not the sox packages' actual APIs). Every hybrid-search/rerank/embedding
   API claim in §2–§3 below was therefore verified by **reading
   `~/dev/ai/sox-ecosystem/libs/**` source directly**, per the task's own instruction to
   verify real exported APIs rather than guess — cited by file:line throughout.

`memory_topics` search for `"sox"` returned only 4 low-volume incident/status topics
(`sox-memory-server-incidents`, `soxe`, `sox-ecosystem service lifecycle`,
`sox-ecosystem July 2 session`) — none contain algorithm research; confirms the paper
citations above are the entirety of the relevant recalled corpus.

---

## 2. Sox package inventory — verified real APIs (read from source, not guessed)

Every package below was opened at `~/dev/ai/sox-ecosystem/libs/**`; the exact export
surface used by this design is cited by file:line. No signature below is assumed.

| Package | Version (verified) | Source | Used for |
|---|---|---|---|
| `@adhd/sox-graph-store` | `0.3.0` (`libs/data/graph/graph-store/package.json`) | `libs/data/graph/graph-store/src/index.ts` | Already a dependency (§0). New use: `getSubgraph` (`:375-378`), `isReachable` (`:370-374`), `getEdges` (`:360`), `getNeighbors`/`getNeighborsWithEdges` (`:361-368`) for §5's in-package graph algorithms. |
| `@adhd/sox-embedding-provider` | `0.1.0` (`libs/data/embed/embedding-provider/package.json`) | `libs/data/embed/embedding-provider/src/index.ts` | `createEmbeddingProvider({type:'fastembed', model, options})` (`:173-190`) → `EmbeddingProvider.embedSingle(text, role?)` / `.embedBatch(texts, opts?)` (`:28-38`). Default model `bge-base-en-v1.5`, dim 768 (`libs/data/embed/embedding-provider/src/fastembed.ts:29,66`). Shared ONNX worker (`getSharedOnnxWorker`, `:154`) — the thread-isolation mechanism (§3.6). |
| `@adhd/sox-vector-store` | `0.1.0` (`libs/data/vectors/vector-store/package.json`) | `libs/data/vectors/vector-store/src/index.ts` | `SqliteVectorBackend` class (`:151-305`) constructed directly over an **existing** `Database` handle (constructor `:155`, takes `db: SQLiteDB`) — NOT the `openVectorStore` convenience factory (`:309-319`, which opens its own second connection); `.ensureSpace/.upsert/.knn/.iter/.delete/.get` (`:18-34` interface). `reembed()` helper (`:393-459`) for model migration. |
| `@adhd/sox-hybrid-search` | `0.2.0` (`libs/data/search/hybrid-search/package.json`) | `libs/data/search/hybrid-search/src/index.ts` | `SqliteSearchBackend` (`:461-607`) — a real, already-composed `SearchBackend` over one `VectorBackend` + one `GraphBackend`, honoring `NodeFilter` on **both** the text and vector channel (the BL-294 fix, `:528-544`). `search(backend, query, opts)` (`:340-457`) fuses BM25 + cosine via `fuse()`/`fuseWithBreakdown()` (`:166-324`, `min_max`/`L2`/`z_score` normalizers). `createCrossEncoder` (`cross-encoder.ts:241`) for optional reranking (`CrossEncoder.rerank(query, candidates, opts?)`, `cross-encoder.ts:42-46`). |
| `@adhd/sox-analysis` | `0.1.0` (`libs/data/analysis/analysis/package.json`) | `libs/data/analysis/analysis/src/index.ts` | `cluster(vecs, {threshold, minClusterSize})` (`:143-180`, DBSCAN over cosine distance — **not** graph-topology community detection, see §1 gap #2). `topoSort(nodeIds, getEdges)` (`:233-297`, Kahn's algorithm with wave numbers + DFS cycle extraction on failure). `criticalPath(nodeIds, getEdges, getWeight)` (`:339-363`, longest-path-in-DAG via topo order). `detectCycles`/`detectDAGStructure` (`:365-433`). `scoreImportance`/`computeImportance` (`:216-229`, `:1140-1179` — bounded degree-centrality + recency + near-dup-penalty heuristic; **not** PageRank, see §1 gap #1). `detectNearDupPairs`/`detectNearDup` (`:182-214`, `:1100-1138`). `buildAutoLinks` (`:1181-1238` — pairwise-cosine RELATES_TO writer; its `dryRun` flag suppresses the write but the function still returns `void`, surfacing **no candidate list** to the caller — a real gap, see §5.5). `runBatchEnrich` (`:1240-1313`, orchestrates all of the above). |
| `@adhd/sox-memory-core` | `0.3.0` (`libs/memory-core/package.json`) | `libs/memory-core/src/*.ts` | Not a runtime dependency of `@adhd/backlog` (backlog is not a memory episode store), but its **patterns** are reused directly: `cluster.ts`'s `materializeClusters` (`:261-360`, connected-components-over-cosine persisted as `community` nodes + `MEMBER_OF` edges — the exact shape §5.3's `clusterIntoPlans` reuses for backlog plans instead of memory communities) and `embed-pipeline.ts`'s Phase-A/Phase-B write split (`:368-426`, `schedulePendingEmbeds` — the concrete, already-shipped answer to the ONNX/SQLite-thread gotcha, reused verbatim in shape by §3.1/§3.6). |
| `@adhd/sox-task-queue` | `0.1.0` (`libs/data/queue/task-queue/package.json`) | `libs/data/queue/task-queue/src/index.ts` | `createTaskQueue`/`SqliteTaskQueue` (`:24`) — used only for the one-time embedding-backfill migration job (§7.3), not the request-path. |
| `@adhd/sox-claim-verification` | `0.1.0` | `libs/data/verify/claim-verification/src/index.ts` | **Not used.** It verifies free-text claims against source passages via NLI (`createClaimVerifier`, `:370`) — backlog's citations are `{file, lines}` structured refs, not prose claims needing textual entailment verification. Named in the brief as "use if it fits"; it does not fit any capability in §3–§6, so it is intentionally omitted rather than forced in. |
| `@adhd/sox-ingest` | `0.1.0` | `libs/data/ingest/ingest/src/*.ts` | **Not used.** Ingest's chunkers (`ast-chunker.ts`, `heading-chunker.ts`) target long documents that exceed one embedding's token budget; a backlog item's `content` (`${title}\n\n${body}`, DESIGN.md §2.2) is a short, single-chunk unit by construction (title + a bug/feature body, not a multi-page document) — chunking would add complexity with no present need. Re-evaluate only if a future `body` field is allowed to grow past the model's `maxTokens` (`fastembed.ts` model configs cap at 512–8192 tokens depending on model). |
| `@adhd/sox-blob-store` | `0.1.0` | `libs/data/store/blob-store/src/*.ts` | **Not used.** No binary/blob artifact exists in the `BacklogItem` domain model. |

---

## 3. Semantic retrieval / RAG

### 3.1 Embedding on write — the two-phase pattern (grounded in `sox-memory-core`)

`DESIGN.md` §9 already anticipated the seam ("`content` is the ONE field carrying
searchable text") but left the write-path mechanics unspecified. `@adhd/sox-memory-core`
has already solved exactly this problem for its own writes and the pattern transfers
directly:

**Phase A (synchronous, inside the existing CAS transaction).** `createItem`/`updateItem`
write the node via the existing `mutateMetadata`/`.immediate()` primitives (`DESIGN.md`
§4.3, unchanged) — **no embedding call happens inside this transaction.** The node is
immediately FTS-searchable (unchanged today) but not yet vector-searchable.

**Phase B (asynchronous, OUTSIDE the write transaction, off the SQLite writer's critical
section).** After Phase A commits and returns to the caller, `client.ts`'s `createItem`/
`updateItem` schedule a follow-up embed:

```ts
// store/embed-pipeline.ts (design sketch — mirrors sox-memory-core's
// embed-pipeline.ts:382-426 schedulePendingEmbeds shape, generalized from
// "batch of pending episodes" to "one backlog item just written")
async function scheduleEmbed(store: GraphBacklogStore, nodeId: number, content: string): Promise<void> {
  if (!store.embedding) return; // RAG not configured — no-op, see §3.2 opt-in
  try {
    const vec = await store.embedding.provider.embedSingle(content, 'document'); // off-slot: worker-thread ONNX (sox-embedding-provider's getSharedOnnxWorker)
    // A single vector upsert is its OWN tiny transaction — NOT the CAS
    // mutateMetadata primitive, because the vector table has no read-modify-write
    // race to resolve (upsert is idempotent per (nodeId, modelId); see §7).
    store.embedding.vector.upsert(nodeId, vec, store.embedding.space);
  } catch (err) {
    // Never throws into the caller's createItem/updateItem — a missing vector
    // degrades semanticSearch/relatedItems to FTS-only for this item (§3.3's
    // degrade signal) and is repaired by the backfill job (§7.3), exactly as
    // sox-memory-core's healMissingVectors repairs a Phase-B failure.
    store.env.logger?.warn?.({ err, nodeId }, 'backlog: embed scheduling failed, deferred to backfill');
  }
}
```

`createItem`/`updateItem` call `void scheduleEmbed(ctx.store, item.nodeId, content)`
(fire-and-forget, not awaited) immediately before returning — mirroring
`sox-memory-core`'s rule that Phase B is invoked **from outside any queue task**
(`embed-pipeline.ts:375-377`, "NEVER call this from inside a WriteQueue task (BL-154)").
`@adhd/backlog` has no `WriteQueue` of its own (its CAS unit is a single
`db.transaction(...).immediate()` call, not a persistent queue), so the applicable
generalization of BL-154 here is: **`scheduleEmbed` must never be called from inside
`mutateMetadata`'s updater callback** — it always runs after that transaction has
already committed and released the write lock, exactly the ordering constraint
`embed-pipeline.ts:375` states for its own case.

### 3.2 Vector store wiring — extending `openGraphBacklogStore`

```ts
// store/graph-backlog-store.ts (design sketch — extends the REAL file, §0)
import { SqliteVectorBackend, type VectorBackend, type VectorSpace } from '@adhd/sox-vector-store';
import { createEmbeddingProvider, type EmbeddingProvider } from '@adhd/sox-embedding-provider';
import * as sqliteVec from 'sqlite-vec';

export interface GraphBacklogStore {
  readonly db: Database.Database;
  readonly graph: GraphBackend;
  /** Absent when RAG is not configured (§3.2's opt-in) — every RAG call site checks this. */
  readonly embedding?: {
    readonly provider: EmbeddingProvider;
    readonly vector: VectorBackend;
    readonly space: VectorSpace;
  };
}

export async function openGraphBacklogStore(
  dbPath: string,
  opts?: { embedding?: { type: 'fastembed' | 'remote'; model?: string; options?: Record<string, unknown> } },
): Promise<GraphBacklogStore> {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const graph = createGraphBackend(db);
  graph.applySchema();

  let embedding: GraphBacklogStore['embedding'];
  if (opts?.embedding) {
    // Load sqlite-vec into the SAME connection the graph backend already owns —
    // deliberately NOT sox-vector-store's openVectorStore() convenience factory,
    // which opens a SECOND connection to the same file (index.ts:309-319). One
    // file, one writer connection, matching DESIGN.md §3's "the store adapter
    // owns the raw handle" decision — the vector table is just more tables in
    // the same db, not a separate store.
    sqliteVec.load(db);
    const vector = new SqliteVectorBackend(db);
    const provider = await createEmbeddingProvider({
      type: opts.embedding.type,
      model: opts.embedding.model ?? 'bge-base-en-v1.5',
      options: opts.embedding.options,
    });
    const space: VectorSpace = { modelId: provider.metadata.modelId, dim: provider.metadata.dimensions };
    vector.ensureSpace(space);
    embedding = { provider, vector, space };
  }

  return { db, graph, embedding };
}
```

**RAG is opt-in, not forced.** `startBacklogServer` (`server.ts`) gains an `embedding?:
{...}` field on `StartOpts`, defaulting to **absent** — every `@adhd/backlog` deployment
that does not configure it keeps behaving exactly as v0.1 (`listItems({grep})` stays
FTS5-only, `semanticSearch`/`relatedItems`/`suggestDependencies` return a documented
"RAG not configured" error rather than crashing). This is deliberate: `bge-base-en-v1.5`
warm-up costs real time/memory (`warmupTimeoutMs()` defaults to 180s,
`embedding-provider/src/index.ts:260-263`) that a lightweight CLI-only backlog user
should never pay unasked.

### 3.3 Hybrid search behind `listItems({grep})` and the new `semanticSearch`

`query.ts:45-47`'s real `listItems({grep})` implementation is upgraded from a direct
`store.graph.searchNodes(...)` call to `@adhd/sox-hybrid-search`'s composed backend —
**the `BacklogFilter`/`listItems` signature does not change**, only what runs inside:

```ts
// store/query.ts (design sketch — replaces the grep branch at the real file's :45-47)
import { SqliteSearchBackend, search as hybridSearch } from '@adhd/sox-hybrid-search';

async function listItemsGrep(store: GraphBacklogStore, filter: BacklogFilter): Promise<BacklogItem[]> {
  const nodeFilter = nodeFilterFromBacklogFilter({ ...filter, grep: undefined });
  if (!store.embedding) {
    // v0.1 behavior, unchanged — FTS5 only.
    const hits = store.graph.searchNodes(filter.grep!, { limit: filter.limit ?? 50, filter: nodeFilter });
    return hits.map(toBacklogItem);
  }
  const backend = new SqliteSearchBackend(store.embedding.vector, store.graph);
  const queryVec = await store.embedding.provider.embedSingle(filter.grep!, 'query');
  const results = hybridSearch(backend, { text: filter.grep, vec: queryVec, filters: nodeFilter }, { limit: filter.limit ?? 50 });
  return results.map((r) => toBacklogItem(store.graph.getNode(r.id)!));
}
```

`semanticSearch(ctx, query, opts?)` (new, §6) is the same call with `filter.grep`
replaced by an explicit query string and no FTS-only fallback silently swallowing the
caller's intent — it returns a documented error when `store.embedding` is absent, so a
caller relying on vector recall is never quietly downgraded to keyword search without
knowing it (contrast with `listItems({grep})`, which degrades a *generic* text filter on
purpose, per its existing "just search" contract).

### 3.4 `relatedItems(id)` — embedding nearest-neighbor

```ts
export async function relatedItems(ctx: BacklogCtx, repo: string, humanId: string, opts?: { limit?: number }): Promise<BacklogItem[]> {
  const item = requireItem(ctx, repo, humanId);
  if (!ctx.store.embedding) throw new RagNotConfiguredError('relatedItems');
  const ownVec = ctx.store.embedding.vector.get(item.nodeId, ctx.store.embedding.space.modelId);
  if (!ownVec) return []; // embedding not yet landed (Phase B pending) — not an error
  const neighbors = ctx.store.embedding.vector.knn(ownVec, ctx.store.embedding.space, (opts?.limit ?? 10) + 1);
  return neighbors
    .filter((n) => n.id !== item.nodeId)
    .map((n) => ctx.store.graph.getNode(n.id))
    .filter((n): n is NodeRecord => n !== null && isLiveBacklogItemNode(n))
    .slice(0, opts?.limit ?? 10)
    .map(toBacklogItem);
}
```

This is the SubgraphRAG-style "adjustable neighborhood size" pattern from §1's citation
`01KXNX6T9TTC4AQFD2FEPR695H`, simplified to what a real sox package actually offers: a
plain cosine-KNN (`VectorBackend.knn`, `vector-store/src/index.ts:256-265`) with a
caller-supplied `limit`, not a trained relevance scorer — no sox package trains one, so
this spec does not invent one (per §1's instruction to note rather than fabricate).

### 3.5 Reranking — optional, threshold-gated

`@adhd/sox-hybrid-search`'s `createCrossEncoder`/`CrossEncoder.rerank` (`cross-encoder.ts:
241`, `:42-46`) is wired as an **optional** post-fusion step on `semanticSearch` only
(never on `listItems({grep})`, which must stay cheap and always-on): when
`opts.rerank: true` is passed and `store.embedding.reranker` is configured, the top-N
fused hits' `content` are reranked before truncating to `limit`. `CrossEncoderRerankerConfig.mode`
(`cross-encoder.ts:59-64`: `'always-on' | 'threshold-gated' | 'skip'`) is exposed
verbatim as the `GraphBacklogStore`'s reranker config — `'threshold-gated'` (rerank only
when the top fused score is below `gateThreshold`, i.e., when the fusion result is
ambiguous) is the recommended default because a backlog corpus (hundreds to low
thousands of items, not millions) rarely needs the cost of always-on cross-encoder
inference.

### 3.6 The ONNX / SQLite-thread gotcha — the concrete answer

`DESIGN.md` §12 flagged this as "not applicable until the RAG seam is adopted." It is
now adopted, so here is the concrete mechanism, taken directly from
`@adhd/sox-embedding-provider`'s already-shipped fix (not re-derived):

- **The problem:** `better-sqlite3` is fully synchronous — a long-running ONNX inference
  call on the same JS thread as an open `.immediate()` transaction would hold the SQLite
  write lock for the inference's entire duration, starving every other reader/writer of
  the shared global-scope store (`DESIGN.md` §12's "the global-scope store is opened by
  many concurrent processes/agents/repos").
- **The fix, already built and reused, not reinvented:** `EmbeddingProvider.embedSingle`/
  `embedBatch` run ONNX inference in a **separate worker thread**
  (`getSharedOnnxWorker()`/`SharedOnnxWorkerClient`, `embedding-provider/src/index.ts:154`,
  fully implemented in `sharedOnnxWorker.ts`) or a **separate child process**
  (`getSharedFastembedProcess()`, `:166-169`, for fastembed specifically — two ONNX
  runtimes cannot safely share one process, see the BL-238/BL-171 root-cause comment at
  `:156-165`). Either way, `await provider.embedSingle(...)` never runs ONNX on the
  thread holding a SQLite handle.
- **Why §3.1's Phase-A/Phase-B split is load-bearing, not just tidy:** even with
  ONNX off-thread, `scheduleEmbed` must still not be called **synchronously inside**
  `mutateMetadata`'s transaction callback, because the callback would then `await` the
  cross-thread round-trip while still holding SQLite's `BEGIN IMMEDIATE` lock — blocking
  every other writer for the inference's wall-clock duration regardless of which thread
  actually runs the model. The fix is ordering (embed after commit), not just threading.
  This is exactly the ordering `sox-memory-core`'s `embed-pipeline.ts:375-377` documents
  ("NEVER call this from inside a WriteQueue task") for the identical reason.
- **One shared worker/process for the whole `adhd` machine, not one per backlog store.**
  `getSharedOnnxWorker()`/`getSharedFastembedProcess()` are process-wide singletons
  (`embedding-provider/src/index.ts:146-169`) — if an `agent-mcp` instance and a
  `backlog` server run in the same Node process (unlikely today, both are separate
  entrypoints) they would share one ONNX worker automatically; running as separate OS
  processes (the actual v0.1 deployment shape) each gets its own singleton, which is
  correct and requires no additional backlog-specific coordination.

---

## 4. Semantic dedup — `dedupeScan` upgrade

`DESIGN.md` §2.4's `dedupeScan` (FTS + exact-metadata match) gains a third candidate
source, exactly as §9 of that document already anticipated ("gains a third candidate
source... with zero change to `CreateItemInput`'s public shape"):

```ts
// store/mapping.ts / createItem's dedupeScan (design sketch — extends the real
// dedupeScan in the shipped store, adding to its existing two sources)
async function dedupeScanSemantic(store: GraphBacklogStore, repo: string, input: CreateItemInput): Promise<BacklogItem[]> {
  if (!store.embedding) return [];
  const content = `${input.title}\n\n${input.body}`;
  const vec = await store.embedding.provider.embedSingle(content, 'query');
  const nodeFilter = { tags: ['backlog-item'], namespace: repo };
  const matchedIds = store.graph.queryNodes(nodeFilter).map((n) => n.id); // BL-294 pattern (§2 hybrid-search entry)
  const hits = store.embedding.vector.knn(vec, store.embedding.space, 10, { ids: matchedIds });
  return hits
    .filter((h) => h.score >= 0.90) // "candidate" band per detectNearDupPairs' own default distinctThreshold/nearDupThreshold split (sox-analysis :186-187)
    .map((h) => store.graph.getNode(h.id))
    .filter((n): n is NodeRecord => n !== null)
    .map(toBacklogItem);
}
```

`createItem`'s `duplicateCandidates` (`SPEC.md` §5.1, unchanged shape) becomes the union
of the FTS/metadata candidates (unchanged) and this semantic set, de-duplicated by
`nodeId`. This directly operationalizes the global `CLAUDE.md` "dedupe before filing"
rule as **paraphrase-aware**, not just exact-symbol/FTS matching — the concrete
motivating case from that rule ("the same bug is routinely filed under a different
name") is precisely what cosine similarity over `content` catches and FTS does not.

`@adhd/sox-analysis`'s `detectNearDupPairs`/`detectNearDup` (verified §2) are the
**batch/background** counterpart, not the per-write path: a periodic
`runDedupSweep(ctx)` operation (new, §6) runs `detectNearDupPairs` over every live
item's vector in a repo/namespace and writes `SAME_AS` edges for `status:'near_dup'`
pairs (cosine ≥ 0.95, the library's own default, `sox-analysis/src/index.ts:186`) —
surfaced to a planner via the existing `memory_near_duplicates`-shaped listing pattern
(`memoryGetNearDuplicates`, `sox-memory-core/src/near-duplicates.ts:31-127`, reused as
the *pattern*, not a runtime dependency — `@adhd/backlog` implements its own
`listNearDuplicates` reading `getEdges({rel:'SAME_AS'})` directly, since it is not a
memory-core consumer). This is the sweep-and-review step the global rule already frames
dedupe as (`DESIGN.md` §2.4's own reasoning, extended: exact per-write matching is a
soft guarantee, and so is this periodic sweep — a human/planner reviews and calls
`mergeItems` explicitly; nothing here auto-merges).

---

## 5. Intelligent plan graph

### 5.1 Critical path / topological scheduling — `topoSort` + `criticalPath` (`@adhd/sox-analysis`)

`SPEC.md` §5.2's existing `topoOrder` (Kahn's-algorithm wave order, already implemented
per §0) is **re-implemented internally** on top of `@adhd/sox-analysis`'s `topoSort`
(`:233-297`) instead of a hand-rolled version, so the two share exactly one
topological-sort implementation across the codebase (DRY, per `AGENTS.md` §8):

```ts
import { topoSort, criticalPath as computeCriticalPath } from '@adhd/sox-analysis';

function getEdgesFn(store: GraphBacklogStore): (id: number) => number[] {
  return (id) => store.graph.getEdges({ src: id, rel: 'DEPENDS_ON' }).map((e) => e.dst);
}

export async function topoOrder(ctx: BacklogCtx, scope?: StatsScope): Promise<TopoOrderResult> {
  const items = await listItemsForScope(ctx.store, scope);
  const nodeIds = items.map((i) => i.nodeId);
  const { order, cycle } = topoSort(nodeIds, getEdgesFn(ctx.store));
  if (cycle) return { ok: false, cycle: cycle.map((id) => humanIdOf(ctx.store, id)) };
  return { ok: true, order: order.map((id) => humanIdOf(ctx.store, id)) };
}

/** New operation (§6): weighted longest path through the DEPENDS_ON DAG. */
export async function criticalPath(ctx: BacklogCtx, scope?: StatsScope, weightFn?: 'count' | 'priority'): Promise<CriticalPathResult> {
  const items = await listItemsForScope(ctx.store, scope);
  const nodeIds = items.map((i) => i.nodeId);
  const itemByNode = new Map(items.map((i) => [i.nodeId, i]));
  const getWeight = weightFn === 'priority'
    ? (id: number) => PRIORITY_WEIGHT[itemByNode.get(id)?.priority ?? 'LOW'] // CRITICAL=4..LOW=1
    : () => 1;
  const pathLen = computeCriticalPath(nodeIds, getEdgesFn(ctx.store), getWeight);
  const maxNode = [...pathLen.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
  return { length: maxNode[1], endItem: humanIdOf(ctx.store, maxNode[0]) /* trace back via getEdges for the full chain */ };
}
```

`criticalPath` names the exact CPM (critical-path-method) algorithm: longest path
through the DAG by processing nodes in topological order and taking
`weight(node) + max(pathLen of dependencies)` (`sox-analysis/src/index.ts:339-363`,
verified). This answers "what should be worked first" precisely because the critical
path is, by definition, the chain that determines the shortest possible completion time
for the whole scope — items on it are strictly higher priority to unblock than
off-path items with equal individual priority.

### 5.2 Blocker-impact ranking — reachability/impact-cone, built in-package over `isReachable`/`getSubgraph`

**No sox package computes this directly — it is built in-package**, exactly per the
task's instruction to say so explicitly when that is the case. It is grounded in §1's
two impact-analysis citations (`01KXNWV65KFJ5YV24SDF89KJB9`, `01KXNRBQB8FAF3VJGRRG7PSYGT`):
an item's blocker-impact is the **size of its backward-reachable set** in the
`DEPENDS_ON` graph — i.e., "how many other items become closer to workable if this one
resolves" — computed via `@adhd/sox-graph-store`'s real traversal primitives:

```ts
// New operation (§6). Built on GraphBackend.getSubgraph — cited per the task's
// "say so explicitly and cite the traversal primitives it builds on" instruction.
export async function blockerImpact(ctx: BacklogCtx, repo: string, humanId: string): Promise<BlockerImpactResult> {
  const item = requireItem(ctx.store, repo, humanId);
  // DEPENDS_ON points item -> the thing it depends on (DESIGN.md §2.3). The
  // "impact cone" of `item` is every item that depends on it, transitively —
  // i.e. the subgraph reached by walking DEPENDS_ON edges IN THE REVERSE
  // direction ('in') from `item`.
  const { nodes } = ctx.store.graph.getSubgraph(item.nodeId, { rel: 'DEPENDS_ON', direction: 'in', depth: Infinity as any /* unbounded — see note */ });
  const impactedOpenCount = nodes.filter((n) => isLiveBacklogItemNode(n) && !isTerminalStatus(metaOf(n).status)).length;
  return { humanId, impactedCount: nodes.length, impactedOpenCount, impactedHumanIds: nodes.map((n) => humanIdOf(n)) };
}
```

This directly implements the recalled survey's core technique — reachability on the
dependency graph as the impact-set computation — using `getSubgraph`'s already-verified
`direction`/`rel`/`depth` traversal (`DESIGN.md` §14's "additional verified facts:
`getEdges({src?, dst?, rel?})` exists... use it for `dependencyGraph`/`blockers`" already
established the pattern of composing directly over these primitives rather than waiting
for a higher-level library function).

For a single yes/no check (rather than the full set), `isReachable(src, dst, {rel,
direction})` (`graph-store/src/index.ts:370-374`) answers "would resolving A ever unblock
B" in O(traversal) without materializing the whole subgraph — used internally by
`readyItems`'s existing "every `DEPENDS_ON` target is terminal" check (`SPEC.md` §5.2,
unchanged) as a cheaper equivalent to the current per-edge terminal-status scan when the
dependency count is large.

`recommendNextWork` (new, §6) ranks open, unclaimed items by `(criticalPath length DESC,
blockerImpact.impactedOpenCount DESC, priority DESC)` — critical-path position first
(determines the schedule's floor), impact-cone size second (a tiebreaker that surfaces
"small but blocking many things" items the critical path alone might rank behind a
longer independent chain), priority last as the final tiebreak the human/planner
explicitly set.

**Gap, stated plainly (§1):** this is reachable-set-size ranking, not PageRank/eigenvector
centrality. `@adhd/sox-analysis`'s only importance primitive (`scoreImportance`,
`:216-229`) is a bounded weighted sum of raw degree + recency + near-dup-penalty — also
not PageRank. If a future requirement specifically wants PageRank-style "importance
propagates through importance" ranking (an item is more critical if it blocks *other
critical* items, not just *many* items), it does not exist in `@adhd/sox-analysis` today
and would need to be authored — a straightforward power-iteration over the `DEPENDS_ON`
adjacency built the same way `blockerImpact` is built here (over `getEdges`), but that
is future work, not part of this spec, and is listed in §9.

### 5.3 Automatic clustering into candidate plans — DBSCAN over embeddings (`@adhd/sox-analysis`), NOT graph-topology community detection

`clusterIntoPlans` (new, §6) reuses `@adhd/sox-analysis`'s `cluster()` (`:143-180`)
exactly as `@adhd/sox-memory-core`'s `cluster.ts`/`clusterStore` already do for memory
episodes (`memory-core/src/cluster.ts:172-183`'s `runClusters` calling the identical
`analysisCluster` function) — the same algorithm, the same library call, applied to
backlog items instead of memory episodes:

```ts
import { cluster } from '@adhd/sox-analysis';

export async function clusterIntoPlans(ctx: BacklogCtx, scope?: StatsScope, opts?: { threshold?: number }): Promise<PlanClusterResult[]> {
  if (!ctx.store.embedding) throw new RagNotConfiguredError('clusterIntoPlans');
  const items = await listItemsForScope(ctx.store, { ...scope, status: 'open' });
  const vecs = items
    .map((i) => ({ id: i.nodeId, vec: ctx.store.embedding!.vector.get(i.nodeId, ctx.store.embedding!.space.modelId) }))
    .filter((v): v is { id: number; vec: Float32Array } => v.vec !== null);
  const result = cluster(vecs, { threshold: opts?.threshold ?? 0.75, minClusterSize: 2 });
  return result.communities.map((c) => ({
    candidatePlanLabel: deriveLabel(ctx.store, c.memberIds), // same centroid-nearest-member heuristic as memory-core cluster.ts:142-154, reused
    memberHumanIds: c.memberIds.map((id) => humanIdOf(ctx.store, id)),
  }));
}
```

**This is a real substitution, stated explicitly (§1 gap #2), not silently glossed
over:** `cluster()` groups items by **semantic similarity of their embedded content**
(DBSCAN over cosine distance — items that *read* similarly), not by **graph-topology
community structure** (Louvain/modularity — items that are *densely interconnected* via
`DEPENDS_ON`/`RELATES_TO` edges, whether or not their text reads alike). `@adhd/sox-
ecosystem` has no Louvain/modularity implementation in any package read for this spec
(§2's inventory is exhaustive over the packages named in the task brief). This
substitution is actually a reasonable fit for "group backlog items into a candidate
plan" — items about the same feature area tend to *describe* similar things even before
anyone has drawn a `DEPENDS_ON` edge between them, which is exactly the case where
clustering is most useful (discovering structure that isn't graph-encoded yet) — but it
is a different algorithm from what "community detection" usually means over a
dependency graph, and an implementer must not assume it also accounts for existing
`DEPENDS_ON`/`RELATES_TO` edge density. A future graph-topology community-detection pass
(if ever wanted) is listed as an open question in §9, not designed here, because no sox
package provides one.

Persisted the same way `memory-core`'s `materializeClusters` persists communities
(`cluster.ts:261-278` pattern, reused): a `kind:'generic'` node tagged
`['backlog-plan-candidate']` per cluster + `MEMBER_OF` edges to its members —
**deliberately a different tag from `'backlog-plan'`** (`DESIGN.md` §2.1's existing,
planner-created plan node) so an auto-suggested cluster is visually and queryably
distinct from a real, planner-attached plan until a human/planner promotes it
(`promoteClusterToPlan`, new, §6 — calls the existing `attachToPlan` for each member
after creating a real plan node, then invalidates the candidate node).

### 5.4 Plan-readiness / next-action recommendation

`planReadiness(ctx, planSlug)` (new, §6) composes primitives already defined above —
no new algorithm, a pure aggregation:

```ts
export async function planReadiness(ctx: BacklogCtx, repo: string, planSlug: string): Promise<PlanReadinessResult> {
  const members = await itemsInPlan(ctx.store, repo, planSlug); // MEMBER_OF -> plan node, existing edge (DESIGN.md §2.3)
  const nodeIds = members.map((m) => m.nodeId);
  const { order, cycle } = topoSort(nodeIds, getEdgesFn(ctx.store));
  const ready = members.filter((m) => isReady(ctx.store, m)); // readyItems' existing per-item check, scoped to this plan's members
  const blocked = members.filter((m) => !isReady(ctx.store, m) && !isTerminalStatus(m.status));
  const done = members.filter((m) => isTerminalStatus(m.status));
  return {
    planSlug,
    totalCount: members.length,
    doneCount: done.length,
    readyCount: ready.length,
    blockedCount: blocked.length,
    hasCycle: cycle !== null,
    percentComplete: members.length === 0 ? 0 : done.length / members.length,
    nextRecommended: ready.length > 0 ? await recommendNextWork(ctx, { repo, plan: planSlug }, 1) : [],
  };
}
```

This is the orchestrator persona's primary consumption point (`SPEC.md` §2's
Orchestrator: "Query ready/blocked work, rollup stats") — a single call answering "is
this plan on track, and what's next" without the caller re-deriving topo order or
readiness itself.

### 5.5 Auto-suggested dependency/relation edges — human/planner confirm gate, never an auto-write

**`@adhd/sox-analysis`'s `buildAutoLinks` (`:1181-1238`) is deliberately NOT called
directly**, and this is a stated design decision, not an oversight: its `dryRun` option
suppresses the `writeEdge` call but the function still returns `void` — the caller gets
**no candidate list**, only "did it write or not." A confirm-gate feature needs the
candidates to show a human/planner, which this library function cannot supply in
dry-run mode (verified by reading the full function body, §2's citation). Rather than
depend on an unconfirmed future upstream change, `suggestDependencies`/`suggestRelated`
(new, §6) replicate `buildAutoLinks`'s **selection algorithm** (pairwise cosine above a
threshold, capped per-node, sorted by similarity descending — the same three rules,
same order) but as a **read-only composition over already-verified real primitives**
instead of calling the void-returning writer:

```ts
export async function suggestDependencies(ctx: BacklogCtx, repo: string, humanId: string, opts?: { threshold?: number; limit?: number }): Promise<SuggestedEdge[]> {
  if (!ctx.store.embedding) throw new RagNotConfiguredError('suggestDependencies');
  const item = requireItem(ctx.store, repo, humanId);
  const ownVec = ctx.store.embedding.vector.get(item.nodeId, ctx.store.embedding.space.modelId);
  if (!ownVec) return [];
  const nodeFilter = { tags: ['backlog-item'], namespace: repo };
  const matchedIds = ctx.store.graph.queryNodes(nodeFilter).map((n) => n.id); // BL-294 pattern, again (§3.3/§4)
  const neighbors = ctx.store.embedding.vector.knn(ownVec, ctx.store.embedding.space, (opts?.limit ?? 5) + 1, { ids: matchedIds });
  const existingEdgeTargets = new Set([
    ...ctx.store.graph.getEdges({ src: item.nodeId }).map((e) => e.dst),
    ...ctx.store.graph.getEdges({ dst: item.nodeId }).map((e) => e.src),
  ]);
  return neighbors
    .filter((n) => n.id !== item.nodeId && n.score >= (opts?.threshold ?? 0.80) && !existingEdgeTargets.has(n.id))
    .slice(0, opts?.limit ?? 5)
    .map((n) => ({ candidateHumanId: humanIdOf(ctx.store, n.id), similarity: n.score, suggestedRel: 'RELATES_TO' as const }));
  // DEPENDS_ON is intentionally never auto-suggested with a directional guess —
  // semantic similarity says two items are ABOUT the same thing, not which one
  // blocks the other. RELATES_TO (non-directional) is the only rel this
  // function proposes; a planner reviewing the result calls the existing
  // addDependency explicitly if they determine a real direction.
}
```

The confirm gate is structural, not a flag: `suggestDependencies`/`suggestRelated`
**never call `graph.writeEdge`** — they return a plain candidate list; the planner (or a
human) reviews it and calls the existing `linkRelated`/`addDependency` (`SPEC.md` §5.5,
unchanged) explicitly per candidate. This satisfies the task's hard requirement
verbatim: "never auto-write a hard edge from a soft signal without review."

`buildAutoLinks` itself remains available (imported, not deleted) for the batch
`runDedupSweep`-style periodic job (§4) where a `RELATES_TO` auto-write on high-
confidence pairs (similarity ≥ 0.80, capped at `maxLinksPerNode`) is an accepted
soft-edge convention already established by `@adhd/sox-analysis` itself for exactly this
edge type — `DEPENDS_ON` is never written by any automated path in this design, only
`RELATES_TO`/`SAME_AS`, both already documented as soft/non-blocking relations
(`DESIGN.md` §2.3's own table).

---

## 6. New operation surface

All new exports are added to `entrypoint/backlog/src/client.ts` (real file, §0),
following the file's existing style exactly: `ctx: BacklogCtx` first parameter, plain
JSON-serializable inputs/outputs, no business logic inline (delegates to `store/*`).

```ts
// ── RAG / semantic retrieval (implementer, orchestrator) ──────────────────────
export async function semanticSearch(ctx: BacklogCtx, query: string, opts?: { scope?: StatsScope; limit?: number; rerank?: boolean }): Promise<BacklogItem[]>;
export async function relatedItems(ctx: BacklogCtx, repo: string, humanId: string, opts?: { limit?: number }): Promise<BacklogItem[]>;
export async function listNearDuplicates(ctx: BacklogCtx, scope?: StatsScope, opts?: { threshold?: number }): Promise<NearDuplicatePairResult[]>;
export async function runDedupSweep(ctx: BacklogCtx, scope?: StatsScope, opts?: { dryRun?: boolean }): Promise<DedupSweepResult>;

// ── Intelligent plan graph (planner, orchestrator) ─────────────────────────────
export async function criticalPath(ctx: BacklogCtx, scope?: StatsScope, weightFn?: 'count' | 'priority'): Promise<CriticalPathResult>;
export async function blockerImpact(ctx: BacklogCtx, repo: string, humanId: string): Promise<BlockerImpactResult>;
export async function clusterIntoPlans(ctx: BacklogCtx, scope?: StatsScope, opts?: { threshold?: number }): Promise<PlanClusterResult[]>;
export async function promoteClusterToPlan(ctx: BacklogCtx, repo: string, clusterId: string, planSlug: string, by: string): Promise<void>;
export async function planReadiness(ctx: BacklogCtx, repo: string, planSlug: string): Promise<PlanReadinessResult>;
export async function recommendNextWork(ctx: BacklogCtx, scope?: StatsScope, limit?: number): Promise<BacklogItem[]>;
export async function suggestDependencies(ctx: BacklogCtx, repo: string, humanId: string, opts?: { threshold?: number; limit?: number }): Promise<SuggestedEdge[]>;
export async function suggestRelated(ctx: BacklogCtx, repo: string, humanId: string, opts?: { threshold?: number; limit?: number }): Promise<SuggestedEdge[]>;

// ── Backfill / migration (human, ops) ──────────────────────────────────────────
export async function backfillEmbeddings(ctx: BacklogCtx, opts?: { batchSize?: number; dryRun?: boolean }): Promise<BackfillResult>;
```

| Operation | Persona | §/algorithm |
|---|---|---|
| `semanticSearch` | implementer, orchestrator, human | §3.3 hybrid search (`sox-hybrid-search`) |
| `relatedItems` | implementer, orchestrator | §3.4 KNN (`sox-vector-store`) |
| `listNearDuplicates` | planner, human | §4 (in-package, `getEdges({rel:'SAME_AS'})`) |
| `runDedupSweep` | orchestrator (periodic), human (manual) | §4 `detectNearDupPairs` (`sox-analysis`) |
| `criticalPath` | orchestrator, planner | §5.1 `criticalPath` (`sox-analysis`) |
| `blockerImpact` | orchestrator, planner | §5.2 in-package over `getSubgraph`/`isReachable` |
| `clusterIntoPlans` | planner | §5.3 `cluster` (`sox-analysis`, DBSCAN) |
| `promoteClusterToPlan` | planner (confirm gate) | §5.3 — wraps existing `attachToPlan` |
| `planReadiness` | orchestrator | §5.4 — aggregates `topoSort` + `readyItems` |
| `recommendNextWork` | orchestrator, implementer | §5.2/§5.1 combined ranking |
| `suggestDependencies` / `suggestRelated` | planner (confirm gate) | §5.5 in-package KNN, never auto-writes |
| `backfillEmbeddings` | human, ops | §7.3 migration |

---

## 7. Data-model deltas

### 7.1 Where vector state lives

**Not** in `metadata` (which stays exactly as `DESIGN.md` §2.2 defines it — no new
`BacklogItem` field). Embeddings live in `sqlite-vec` virtual tables inside the **same**
SQLite file the graph already occupies (`vec_<sanitized-model-id>`, per
`vector-store/src/index.ts:67-69`'s `tableName()`), keyed by `node_id` = the graph
node's `id`/`rowid` — a direct 1:1 join key, no new ID scheme. `VectorSpace{modelId,
dim}` metadata is tracked in `_vector_spaces` (`vector-store/src/index.ts:158-164`,
auto-created). This is a schema addition (new tables) with **zero changes** to the
existing `node`/`edge` tables `@adhd/sox-graph-store` owns.

### 7.2 Consistency with `updateItem` edits

`DEBT-BACKLOG-CONTENT-IMMUTABLE-001` (`BACKLOG.md:1138-1143`, already filed, cited §0)
already documents that `updateItem`'s title/body patch does not refresh the graph's FTS
`content` — the same gap applies to the embedding, and this design does not paper over
it: **`updateItem` schedules a re-embed exactly like `createItem` does (§3.1's
`scheduleEmbed`, called again on every title/body change)**, computing a fresh vector
over the new `${title}\n\n${body}` and `upsert`-ing it (idempotent per `(nodeId,
modelId)`, `vector-store/src/index.ts:202-225`) — this part is NOT blocked by the FTS
debt, because `VectorBackend.upsert` is a plain overwrite, unlike `touch()`'s
content-immutability. So: **the embedding IS always recomputable and re-synced on edit,
even while the FTS `content` is not** — a real, useful asymmetry worth stating plainly
so an implementer does not assume both are equally stale. If/when
`DEBT-BACKLOG-CONTENT-IMMUTABLE-001` is resolved (e.g. via a `supersedeItem`-based
content refresh), the embedding re-sync trigger point does not change — it is already
correct.

`DEBT-BACKLOG-CONTENT-HASH-COLLISION-001`'s mitigation (an HTML-comment uniqueness
marker appended to every node's `content`, `BACKLOG.md:1134`) has **no interaction**
with embeddings: the marker is a short fixed-format comment, negligible relative to
title+body for embedding purposes, and is already stripped from `toBacklogItem()`'s
`title`/`body` reconstruction (real code) before `scheduleEmbed` would ever see it —
confirm this ordering when implementing (`scheduleEmbed` must run over the SAME
`${title}\n\n${body}` used for FTS content minus the marker, not the raw stored
`content` column, so the marker never pollutes the embedding).

### 7.3 Migration — backfilling embeddings for existing items

`backfillEmbeddings` (§6) iterates every live `backlog-item` node lacking a vector
(`vector.get(id, modelId) === null`) and schedules `scheduleEmbed` for each, batched via
`@adhd/sox-task-queue`'s `createTaskQueue` (`task-queue/src/index.ts:24`, cited §2) to
bound concurrent ONNX inference (avoid saturating the shared worker/process singleton,
§3.6) rather than firing every embed at once. `opts.dryRun` reports the count that would
be embedded without calling the provider — useful for sizing the warm-up cost (§3.2)
before enabling RAG on an existing large backlog. This is a one-time operational job,
not a `client.ts` hot path, matching `@adhd/sox-vector-store`'s own `reembed()` helper
shape (`vector-store/src/index.ts:393-459`) for the *model-migration* case (switching
embedding models later reuses that exact function, not reinvented here).

---

## 8. Testing / DoD (per `AGENTS.md` §7 — real components, teeth, no proxies)

1. **Real hybrid search returns ranked results.** A test constructs a real
   `SqliteVectorBackend` + real `SqliteGraphBackend` over one temp SQLite file, writes
   ≥5 real backlog items via `createItem` with a **real** `fastembed` provider (the
   qualifying case for a default-running, unflagged test per `AGENTS.md` §7 rule 5 —
   `fastembed` runs a local ONNX model, it is not a paid third-party service, so no
   env-gate applies; only a genuine remote-API provider would qualify for gating), calls
   `semanticSearch` with a paraphrased query matching one item's content but not its
   exact words, and asserts that item ranks in the top 3. Revert the fusion weighting
   (set `vec` weight to 0) as the negative control and confirm the item drops out of the
   top 3 — proving the vector channel actually contributes, not just that the call
   doesn't crash.
2. **Real critical path over a real dependency DAG.** Real `addDependency` calls build
   A→B→C (a 3-item chain) plus an independent single item D; `criticalPath` must return
   `endItem: 'C'`-equivalent (the chain end) with `length` reflecting the chain's node
   count (or priority-weighted sum, per the `weightFn` argument) strictly greater than
   D's path length of 1. Negative control: comment out the `getWeight` accumulation
   (`+ maxDepPath` reverting to just `getWeight(id)`) and confirm the assertion fails
   (all paths report length 1).
3. **Semantic dedup catches a paraphrased duplicate.** `createItem` for "Login button
   does not respond on Safari" followed by `createItem` for "Safari: clicking sign-in
   has no effect" (real fastembed embeddings, no shared words beyond "Safari") must
   surface the second as a `duplicateCandidates` entry of the first via the vector
   channel — assert the FTS-only path (temporarily disable the vector candidate source)
   does NOT catch this pair, proving the semantic addition is load-bearing, not
   redundant with existing FTS matching.
4. **`suggestDependencies` never writes an edge.** Real KNN over 3 similar real items;
   call `suggestDependencies`, assert the returned candidates are correct AND assert
   `getEdges({src: item.nodeId})`/`getEdges({dst: item.nodeId})` are unchanged
   before/after the call — proving the confirm-gate structural guarantee (no write path
   exists), not just that the function happens not to call `writeEdge` today.
5. **`blockerImpact` counts a real transitive impact cone.** Real chain A→B→C→D
   (`DEPENDS_ON`, each pointing at the next), `blockerImpact('D')` must report
   `impactedCount: 3` (A, B, C all transitively depend on D) via real `getSubgraph`
   traversal — not just direct dependents (which would incorrectly report 1). Negative
   control: cap `depth` at 1 and confirm the count drops to 1, proving the test actually
   exercises the transitive (not just direct) case.
6. **`clusterIntoPlans` groups real embedded items and excludes the rest.** 4 items
   about "OAuth token refresh" (semantically close) + 2 unrelated items ("update
   README", "bump lodash version") — real embeddings, real `cluster()` call — must
   produce one cluster containing all 4 OAuth items and leave the 2 unrelated items in
   `unclustered` (or their own singleton, suppressed per `minClusterSize:2`). Asserts on
   real DBSCAN output, not a mocked clustering result.
7. **RAG-not-configured path degrades cleanly, not silently.** `semanticSearch`/
   `relatedItems`/`clusterIntoPlans`/`suggestDependencies` against a store opened
   WITHOUT `opts.embedding` must throw a documented `RagNotConfiguredError` (not crash
   with an undefined-property error, not silently return `[]` pretending success) —
   while `listItems({grep})` against the same unconfigured store must keep returning
   real FTS results unchanged, proving the v0.1 surface truly never regresses.
8. **`nx build backlog` + `nx run backlog:verify-dist-load`** stay green after the new
   dependencies are added (`AGENTS.md` §5) — the shipped `dist/` entry must actually load
   `@adhd/sox-vector-store`/`@adhd/sox-embedding-provider`/`@adhd/sox-hybrid-search`/
   `@adhd/sox-analysis` as real native/ONNX-bearing dependencies, not just resolve them
   at the source level.

Every test above uses a real DB + real embeddings under `tmp/backlog/<test-name>/`
(`AGENTS.md` §10), removed on teardown, per the existing `SPEC.md`/`DESIGN.md`
convention this document does not change.

---

## 9. Phasing & open questions

### Phasing

1. **Phase 1 — retrieval only (§3).** `openGraphBacklogStore`'s `embedding` opt-in,
   `scheduleEmbed` Phase-A/Phase-B wiring, `semanticSearch`, `relatedItems`, upgraded
   `listItems({grep})`. No plan-graph algorithms yet. This is the smallest slice that
   makes RAG real and independently testable (DoD items 1, 7).
2. **Phase 2 — semantic dedup (§4).** `dedupeScan`'s third candidate source,
   `listNearDuplicates`, `runDedupSweep`. Depends on Phase 1's embeddings existing.
3. **Phase 3 — plan-graph intelligence (§5).** `criticalPath`, `blockerImpact` (does
   NOT depend on embeddings — pure graph traversal, could actually ship in Phase 1
   alongside retrieval if the implementer prefers, since it has no vector dependency),
   `clusterIntoPlans`/`promoteClusterToPlan`, `planReadiness`, `recommendNextWork`,
   `suggestDependencies`/`suggestRelated`.
4. **Phase 4 — backfill/ops (§7.3).** `backfillEmbeddings`, wired to
   `@adhd/sox-task-queue`. Ships whenever Phase 1 is adopted on a non-empty existing
   backlog (irrelevant for a brand-new store).

Reranking (§3.5) is an **optional knob within Phase 1**, not its own phase — ship
`semanticSearch` without it first, add `opts.rerank` once fusion-only quality is
measured against real usage.

### Open questions / assumptions for the implementer

1. **`buildAutoLinks`'s dry-run-with-no-candidates gap (§5.5) is a real upstream
   limitation of `@adhd/sox-analysis`, not an `@adhd/backlog` bug.** Filed to this
   repo's `BACKLOG.md` as `DEBT-BACKLOG-AUTOLINK-DRYRUN-NO-CANDIDATES-001` (below) so it
   is tracked rather than silently worked around forever — `suggestDependencies`/
   `suggestRelated`'s in-package replication (§5.5) is a fine permanent design on its
   own merits (it needs to return read-only candidates regardless of what
   `buildAutoLinks` does), but if `@adhd/sox-analysis` ever adds a
   `AutoLinkOpts.returnCandidates` mode, `runDedupSweep`'s soft-edge batch write (§5.5's
   last paragraph) could switch to it instead of its own separate pairwise loop.
2. **PageRank / eigenvector centrality (§5.2) and Louvain / modularity community
   detection (§5.3) do not exist in any sox-ecosystem package read for this spec.** If a
   future requirement specifically needs either, it must be authored net-new (a
   power-iteration over `getEdges`-derived adjacency for the former; a modularity-
   optimization pass over `getSubgraph`-derived neighborhoods for the latter) — this
   spec does not design either, per §1's "note the gap rather than invent" instruction.
3. **`VectorBackend.knn`'s `VecFilter` only supports `{ids}`, not a general `NodeFilter`**
   (`vector-store/src/index.ts:14-16`, verified) — every RAG call site in this design
   that needs scoping (repo/namespace) first resolves the id set via
   `graph.queryNodes(nodeFilter)` and passes `{ids}` to `knn` (the exact BL-294 pattern
   `SqliteSearchBackend` already uses internally, `hybrid-search/src/index.ts:536-542`).
   This is a real perf cost at large scale (materializing every matching id before the
   KNN call) — acceptable at backlog's expected scale (hundreds to low thousands of
   items per repo, matching `DESIGN.md` §2.2's own "~100 package / few-thousand-item
   scale" assumption) but worth re-measuring if that assumption changes.
4. **`getSubgraph`'s `depth` parameter's exact semantics for "unbounded" were not
   independently verified against the real signature beyond the type
   (`opts?: { rel?, depth?, direction? }`, `graph-store/src/index.ts:375-378`)** — §5.2's
   sketch passes `Infinity` speculatively; the implementer must confirm whether the real
   implementation accepts `Infinity`, treats `depth` omission as unbounded, or requires
   an explicit large finite bound, and adjust `blockerImpact` accordingly before
   shipping. Flagged rather than assumed silently.
5. **Embedding model choice (`bge-base-en-v1.5`, 768-dim, the package default) is
   proposed, not mandated** — a repo with very short backlog titles/bodies (the common
   case) may get equally good results from a smaller/faster model
   (`MODEL_CONFIGS`, `fastembed.ts:18-65`, other options are 384–1024 dim). This spec
   defaults to the package default rather than picking a specific alternative, since no
   research or benchmark was recalled or available to justify a different choice for
   this specific corpus shape (another explicit gap, not a silent choice).

**New `BACKLOG.md` entry filed alongside this spec** (per the global `CLAUDE.md`
disclosure rule — discovered during this design pass, not deferred to later):

> `DEBT-BACKLOG-AUTOLINK-DRYRUN-NO-CANDIDATES-001` — `@adhd/sox-analysis`'s
> `buildAutoLinks(vec, graph, opts)` (`~/dev/ai/sox-ecosystem/libs/data/analysis/
> analysis/src/index.ts:1181-1238`) accepts `opts.dryRun` to suppress its `writeEdge`
> calls but the function still returns `void` — a caller cannot retrieve the candidate
> list a dry run would have written, only whether it ran. This blocks
> `entrypoint/backlog/RAG-SPEC.md` §5.5's `suggestDependencies`/`suggestRelated` from
> reusing this library function for its confirm-gate feature; the spec instead
> replicates the selection algorithm in-package over `VectorBackend.knn` +
> `GraphBackend.getEdges`/`queryNodes`. Upstream fix direction: add a
> `returnCandidates?: boolean` mode to `AutoLinkOpts` that returns
> `Array<{a,b,sim}>` instead of `void` when set (mirrors `detectNearDupPairs`'
> already-correct pure/return-value shape in the same file, `:182-214`, which has no
> such gap). Status: OPEN — worked around in `@adhd/backlog`'s design, not blocking
> implementation.

---

## 10. Summary — algorithm → package → research citation map

| Capability | Algorithm | Package (real API cited) | Research grounding |
|---|---|---|---|
| Embedding on write | Two-phase async write (embed off the SQLite write lock) | `@adhd/sox-embedding-provider` (`createEmbeddingProvider`, `getSharedOnnxWorker`) + pattern from `@adhd/sox-memory-core`'s `embed-pipeline.ts` | No direct memory hit; verified via source + reused shipped pattern |
| Vector persistence | sqlite-vec virtual table, node-id keyed | `@adhd/sox-vector-store` (`SqliteVectorBackend`) | — |
| Hybrid search | BM25 + cosine fusion (min_max/L2/z_score) | `@adhd/sox-hybrid-search` (`SqliteSearchBackend`, `fuse`) | GraphRAG survey `01KXNX6X8AR7XJWMHM43GNCHKD` (structure-aware retrieval rationale) |
| Nearest-neighbor "related items" | Cosine KNN | `@adhd/sox-vector-store` (`VectorBackend.knn`) | SubgraphRAG `01KXNX6T9TTC4AQFD2FEPR695H` (adjustable-neighborhood framing) |
| Reranking | Cross-encoder, threshold-gated | `@adhd/sox-hybrid-search` (`createCrossEncoder`) | — |
| Semantic dedup | Cosine threshold bands (near_dup/candidate/distinct) | `@adhd/sox-analysis` (`detectNearDupPairs`) | Global `CLAUDE.md` dedupe rule (paraphrase case) |
| Topological scheduling | Kahn's algorithm, wave order | `@adhd/sox-analysis` (`topoSort`) | — |
| Critical path | Longest path in DAG (CPM) | `@adhd/sox-analysis` (`criticalPath`) | — |
| Blocker-impact ranking | Reachability / transitive closure (impact cone) | In-package, over `@adhd/sox-graph-store` (`getSubgraph`, `isReachable`) | Dynamic Transitive Closure survey `01KXNWV65KFJ5YV24SDF89KJB9`; Change Impact Analysis survey `01KXNRBQB8FAF3VJGRRG7PSYGT` |
| Candidate-plan clustering | DBSCAN over cosine embedding distance | `@adhd/sox-analysis` (`cluster`) — reused from `@adhd/sox-memory-core`'s `cluster.ts` pattern | No Louvain/modularity research recalled or available — explicit substitution (§1 gap #2, §5.3) |
| Auto-suggested relation edges | Pairwise cosine threshold + per-node cap, read-only | In-package, over `@adhd/sox-vector-store` (`knn`) + `@adhd/sox-graph-store` (`getEdges`) — NOT `buildAutoLinks` (§5.5 gap) | Global `CLAUDE.md` "never auto-write a hard edge from a soft signal" requirement |
| PageRank / eigenvector centrality | — | **Not implemented anywhere in scope** | No memory hit; not designed here (§1 gap #1, §9 open question 2) |
