# `@adhd/sox-*` Capability Catalog

**Compiled:** 2026-08-07 · **Method:** artifact-first (`npm pack` + untar of the published dist, plus A/B `diff` against the prior published tarball, plus live execution where practical) · **Baseline compared against:** the 2026-08-06 version snapshot recorded in `DEBT-SOX-001` / `FEAT-BACKLOG-011`.

> ## How to read this document
>
> **Every claim here is sourced to an artifact, not to a README.** This repo has three recorded cases of confidently-documented sox capabilities that did not exist (`AMA-001` hash provider, `SOX-DOC-003` role encoding, `AMA-018` wired `ModelCache`) and an entire downstream plan (`agent-mcp-authoring`) was authored against them and had to be rewritten. So: an entry marked with a `dist/…:line` or a `diff` result was **opened**; an entry without one does not exist.
>
> **Status vocabulary used per capability:**
> - `NEW` — did not exist in the prior published tarball.
> - `CHANGED` — existed, but its signature, shape, or runtime behaviour moved.
> - `PREEXISTING` — byte-identical (or logically identical) to the prior published tarball. Listed anyway when a reader would otherwise assume it was new, or when the repo backlog records it wrongly.
> - `⚠ DOC-GAP` — the package's own README / `sox` metadata claims this and the artifact does not deliver it.
>
> **§1 is the section to read first if you own a plan or a backlog item.** It lists what this catalog contradicts.

---

## §0 · Version matrix

| Package | 2026-08-06 snapshot | Now (published 2026-08-07T23:18Z unless noted) | Moved? | Nature of the move |
|---|---|---|---|---|
| `@adhd/sox-embedding-provider` | 0.1.0 | **0.2.0** | ✅ | fastembed child-process lifecycle hardening + telemetry. One breaking export signature. |
| `@adhd/sox-vector-store` | 0.3.3 | **0.4.0** | ✅ | **Breaking:** LanceDB backend now requires a `StoreAdapter`, not a raw `better-sqlite3` handle. |
| `@adhd/sox-graph-store` | 0.5.3 | **0.6.0** | ✅ | **Breaking (source-level):** open-schema DDL, injectable `TypePolicy`, widened `EdgeRel`. |
| `@adhd/sox-store-adapter` | 0.2.0 | **0.3.0** | ✅ | FTS-orphan guard (fixes a SIGABRT). Plus one **undocumented** runtime narrowing. |
| `@adhd/sox-hybrid-search` | 0.3.3 | **0.3.4** | ✅ | One ranking bug fix (`TOPIC_BOOST_FLOOR`) + dependency bumps. |
| `@adhd/sox-memory-core` | 0.5.0 | **0.6.0** (23:18:58Z) | ✅ | StoreAdapter migration, read-path embed timeout, coordinated shutdown, community GC. |
| `@adhd/sox-ingest` | 0.1.0 | **0.1.0** | ❌ | Unchanged — but ships far more than its metadata admits (see §2.6). |
| `@adhd/sox-analysis` | 0.1.4 | **0.1.5** | ✅ | **Dependency bumps only.** `dist/index.js` is a 0-line diff. |
| `@adhd/sox-telemetry` | 0.2.0 | **0.2.0** (published 2026-08-05) | ❌ | This is the package's **first and only** npm publish; there is no prior baseline. |

**Also in the family but NOT surveyed** (named in `entrypoint/backlog/RAG-SPEC.md` §2 and in `AMA-009`, not covered by this pass): `@adhd/sox-task-queue`, `@adhd/sox-blob-store`, `@adhd/sox-claim-verification`. See §5.

---

## §1 · ⚠️ CONTRADICTED ASSUMPTIONS — read before acting on any existing item or plan

These are behaviours **recorded in this repo's backlog or plan corpus** that the artifacts no longer support. Each is cited to the artifact that disproves it. Items and plans written against them are silently wrong.

### C-1 · "ONNX runs in a worker thread so `onnxruntime-node` never shares a thread with `better-sqlite3` + `sqlite-vec`" — **WRONG for fastembed, and wrong about the reason**

**Recorded in:** `AMA-021` (status FIXED, body bullet 5, cites `worker.unref()`), restated verbatim as a must-re-check constraint in `DEBT-SOX-001`, and summarised imprecisely in `entrypoint/backlog/RAG-SPEC.md:120` ("Shared ONNX worker (`getSharedOnnxWorker`, `:154`) — the thread-isolation mechanism").

**Artifact says:** `FastembedProvider` delegates *every* embed/init call to `getSharedFastembedProcess()`, which `fork()`s **one shared OS child process** running `fastembedProcessHost.js`. It is never a `worker_threads.Worker`. The stated reason is different too: fastembed's `onnxruntime-node@1.21.0` cannot safely share a **thread** with `@huggingface/transformers`' `onnxruntime-node@1.24.3` even when calls are strictly sequential (deterministic `std::bad_alloc` on the second init) — only a real **process** boundary is safe. A genuine `worker_threads.Worker` does exist in the package (`embedWorker.js`, via `getSharedOnnxWorker()`) but hosts **only** the MS-MARCO cross-encoder reranker and the DeBERTa NLI verifier — never fastembed embeddings.

**Evidence:** `dist/fastembedProcessHost.d.ts:1-58` ("Why a PROCESS, not a worker thread"); `dist/sharedOnnxWorker.d.ts:1-87` (explicitly: "fastembed embeddings … are DELIBERATELY routed elsewhere"); `dist/embedWorker.d.ts:1-76`. **This was already true at 0.1.0** — verified by diffing the packed 0.1.0 tarball, where `fastembedProcessHost.js` / `sharedFastembedProcess.js` already existed. The snapshot has been wrong since it was written, not made wrong by this release.

**Why it matters:** the `better-sqlite3` / `sqlite-vec` native-crash risk analysis in `DEBT-SOX-001` and `AMA-021` reasons from the wrong isolation mechanism. The isolation is *stronger* than assumed (a process, not a thread), and the hazard it defends against is a **dual-`onnxruntime-node`-version** conflict, not a SQLite conflict. `RAG-SPEC.md` §3.6 (line 661ff) is the one place in the corpus that gets this substantially right — it names both mechanisms — but its own package table at `:120` does not.

### C-2 · "`worker.unref()`" is the lifecycle mechanism — **it was insufficient, and it leaked processes**

**Recorded in:** `AMA-021` bullet 5 (`worker.unref()`).

**Artifact says:** `ChildProcess.unref()` alone does **not** release the separate libuv handle `fork()` creates for the IPC channel when `stdio` includes `'ipc'`. Any process that had ever embedded once stayed alive forever — observed as orphaned probe processes still resident 40+ minutes after their last output, at 0% CPU, holding an ONNX model. This was previously **misdiagnosed as ANE-contention evidence**. Fixed in 0.2.0 (BL-370) by explicitly `c.channel?.unref()`, plus the inverse fix (BL-410) `refForPending()`/`unrefIfIdle()` so a short-lived CLI process does not tear down mid-model-load and abandon a pending promise.

**Evidence:** `diff` of `dist/sharedFastembedProcess.js` 0.1.0 → 0.2.0 (both methods entirely absent from 0.1.0); `dist/sharedFastembedProcess.d.ts:38-54`.

**Why it matters:** `RAG-SPEC.md` §3.1.1's "short-lived/CLI process could exit before its embed promise resolves" gap is **partially solved upstream now** (BL-410), and any plan that budgeted for orphaned-process cleanup as an unsolved risk can drop it.

### C-3 · "`VecFilter.nodeFilter` filtered-KNN pushdown" is **SQLite-only** — LanceDB silently ignores it

**Recorded in:** `FEAT-BACKLOG-RAG-ADOPT-FILTERED-KNN-001` (the entire premise), `DEBT-SOX-001`, `RAG-SPEC.md` §2.1.

**Artifact says:** the pushdown is real and shipped for `SqliteVectorBackend` — `JOIN node n ON n.rowid = v.node_id` + `buildNodeFilterClause()` (`dist/index.js:1-2, 99-131`). But `VecFilter` is the *single shared filter type* on both backends' `knn()`/`iter()` signatures, and `LanceDbVectorBackend` crosses its synckit worker RPC boundary through a narrower `WorkerVecFilter` that has **only `ids?: number[]`**. `nodeFilter` is dropped before reaching the worker. A caller passing `{nodeFilter:{namespace:'x'}}` to a LanceDB-backed `knn()` gets unfiltered results **with no error, warning, or console output** — it type-checks cleanly.

**Evidence:** `dist/lancedb-worker.d.ts:5-7` (`WorkerVecFilter` = `{ids?}` only); `dist/lancedb-worker.js:210-226` (`knn`) and `:227-241` (`iter`), both branch only on `filter?.ids`; `src/lancedb.spec.ts:226-311` tests only `filter.ids` — no test asserts or denies this. Present identically at 0.3.3, so not a 0.4.0 regression.

**Why it matters:** the RAG design is safe **only** if it commits to `SqliteVectorBackend`. Any wording that treats the pushdown as a `VectorBackend`-interface guarantee is wrong.

### C-4 · `createGraphBackend(db)` no longer accepts a raw `better-sqlite3` handle — **`@adhd/backlog` cannot upgrade without adding `@adhd/sox-store-adapter`**

**Recorded in:** `entrypoint/backlog/src/store/graph-backlog-store.ts:28-40` (real shipped code, passes `new Database(dbPath)` straight to `createGraphBackend`), `RAG-SPEC.md` §0 (documents that construction site as "THE construction site every RAG addition below plugs into"), `FEAT-BACKLOG-RAG-ADOPT-FILTERED-KNN-001` ("bump the pinned `@adhd/sox-graph-store` to `^0.4.0`").

**Artifact says:** installed `node_modules/@adhd/sox-graph-store/dist/index.d.ts:250` is `createGraphBackend(db: Database.Database)`. At 0.6.0 it is `createGraphBackend(adapter: StoreAdapter, opts?: GraphBackendOpts)`. `entrypoint/backlog/package.json:18` pins `^0.3.0`, which **cannot** resolve 0.6.0 under semver caret. `LanceDbVectorBackend`/`openLanceDbVectorStore` made the same move at vector-store 0.4.0 (`db: Database.Database` → required `adapter: StoreAdapter`, CHANGELOG BL-389, explicitly Breaking), with a `requireStoreAdapterShape()` guard that throws a named `TypeError` if a raw driver handle is passed.

**Why it matters:** this is the single largest concrete cost hidden inside `DEBT-SOX-001`. It is not a version bump — it is a construction-site migration (`createSqliteAdapter()` wrap) plus a new runtime dependency, touching the exact file `RAG-SPEC.md` builds on, plus `@adhd/backlog`'s raw-handle CAS primitives (`mutate-metadata.ts`, `ids.ts`) which still need the unwrapped `better-sqlite3` handle.

### C-5 · `SOX-DOC-003` was closed as ALREADY_FIXED on the strength of `package.json` metadata — **the shipped README still overclaims**

**Recorded in:** `SOX-DOC-003` (status VERIFIED; two verifier notes both cite `sox.concerns` being corrected).

**Artifact says:** the verifiers were right about `package.json` — its `sox.concerns` block is honest ("EmbedRole param … currently ignored (not yet applied)", `dist/package.json:47`). But the **README shipped inside the tarball** — the artifact a consumer reads on the npm registry page — is unchanged and still markets *"asymmetric + symmetric encoding via role param"*, *"deterministic hash provider as first-class alternative"*, and *"warmUp cache for hot/topic texts"*. All three are false against `dist/`.

**Evidence:** `dist/README.md:1-9` (identical to source `libs/data/embed/embedding-provider/README.md`); contradicted by `dist/index.js:60-67` (switch handles only `'fastembed'`/`'remote'`), `dist/fastembed.js:113,129-130` + `dist/remote.js:24-25,38-39` (role discarded), `dist/fastembed.js:151-156` + `dist/remote.js:66-68` (`warmUp` is a literal no-op).

**Why it matters:** `AMA-001` and `SOX-DOC-003` are both closed. The underlying **doc/reality gap is still live in the published artifact**, in the exact document a new reader opens first. Closing the plan-side item did not close the upstream one.

### C-6 · The `~2048 chars / 512 tokens` chunking threshold is **per-model**, not fixed

**Recorded in:** `AMA-021` ("`maxTokens = 512` → content over ~2048 chars is split"), `DEBT-SOX-001`.

**Artifact says:** the threshold is `MODEL_CONFIGS[model].maxTokens` — **512** for `bge-small-en-v1.5` / `bge-base-en-v1.5` (the default) / `multilingual-e5-large`, but **8192** for `bge-m3` and `codexembed-400m`. For the default model the recorded number is right; for the two large-context models the threshold is ~32,768 chars. `codexembed-400m` is code-focused and 1024-dim (~1.6GB RAM).

**Evidence:** `dist/fastembed.js:3-39` (MODEL_CONFIGS), `:113-124` (chunk branch), `:161-186` (`estimateTokens`, `chunkText`). Byte-identical to 0.1.0 — this was always true.

**Why it matters:** any fixture, budget, or design that treats 512 as a property of the *package* rather than of the *selected model* is under-specified. A code-corpus use case has a real 8192-token option (`codexembed-400m`) that no item in this repo mentions.

### C-7 · `warmupTimeoutMs()` changed signature — a silent wrong-budget hazard for JS callers

`0.1.0` exported `warmupTimeoutMs()` with zero parameters. `0.2.0` requires `warmupTimeoutMs(cacheHit: boolean)`. A JS consumer calling it with no argument gets `cacheHit === undefined` (falsy) and silently takes the **180s cold-download budget** even on a warm cache. TypeScript consumers get a compile error; JS consumers do not. **Evidence:** `dist/index.js:131-147`; `diff` vs packed 0.1.0.

### C-8 · `sox-store-adapter@0.3.0` shipped an **undocumented runtime narrowing** its own CHANGELOG denies

`SqliteVecDialect.topKQuery()` now **throws** for any `VectorMetric` other than `'cosine'`, and `createTableDDL()` bakes `distance_metric=cosine` into the vec0 DDL (BL-392). At 0.2.0 a caller requesting `metric:'l2'` or `'dot'` got silently-wrong L2 rankings; at 0.3.0 they get a hard throw. The package's own `CHANGELOG.md` 0.3.0 entry states *"No removed or narrowed export … minor"* — true for type signatures, **false for runtime behaviour**. **Evidence:** `diff pkg-0.2.0/dist/vector-dialect.js pkg-0.3.0/dist/vector-dialect.js`. The sole in-repo consumer of store-adapter across the sox tree is `@adhd/sox-memory-core`.

### C-9 · Version premises in closed backlog notes are now stale

`AMA-004`'s closing verifier note (2026-08-05) and `AMA-009` both enumerate versions. Seven of nine have moved (§0). `AMA-009` additionally records `memory-core` HEAD as `0.3.0`; it is now `0.6.0`. `RAG-SPEC.md`'s §2 verification table (`:119-128`) records graph-store `0.3.0`, vector-store `0.1.0`, hybrid-search `0.2.0`, memory-core `0.3.0`, analysis `0.1.0` — every one of those line/symbol citations must be re-resolved before the spec is implemented.

### C-10 · `RAG-SPEC.md` §2.1's "upstream change required" has **already landed** — that section is obsolete

`RAG-SPEC.md` §2.1 (lines 130-325) specifies a filtered-KNN upgrade as a prerequisite that "must land in `~/dev/ai/sox-ecosystem` … **before** `@adhd/backlog`'s Phase 1 implementation can use `nodeFilter`-scoped `knn` calls," and instructs the implementer to assume option (b). It shipped: vector-store 0.2.0 onward, and `sox-hybrid-search@0.3.0` went further and replaced its own two-step `queryNodes()→ids` workaround with a direct `{nodeFilter}` pass-through. Roughly 200 lines of that spec are now describing work that exists. **Evidence:** `dist/index.js:99-131` (vector-store); `dist/index.js:397-427` + source `CHANGELOG.md` 0.3.0 entry (hybrid-search).

### C-11 · `sox-ingest` was dismissed as "Not used" — it ships a full tree-sitter chunking subsystem

`RAG-SPEC.md:127` records `@adhd/sox-ingest` as **Not used**, on the reasoning that its chunkers "target long documents" and a backlog item is a short single-chunk unit. That reasoning is sound for *item bodies* — but the package also ships a real `AstChunker` (web-tree-sitter WASM, typescript/python/java/csharp) that never split a declaration across a chunk, a `HeadingChunker`, a `MixedFormatChunker`, and a 12-entry `ChunkerRegistry`. Directly relevant to outcome **(d)** in §4 (relating items by the FILES they touch), which did not exist as a goal when that line was written. **Evidence:** `dist/ast-chunker.js` (297 lines, read in full); live-executed against real TS producing 3 correctly line-bounded chunks.

---

## §2 · Per-package catalogs

### §2.1 · `@adhd/sox-embedding-provider@0.2.0` *(was 0.1.0)*

**What it is:** the embedding substrate — a factory resolving a config into a live `EmbeddingProvider`, backed by a fastembed ONNX model running in a dedicated child process.

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `createEmbeddingProvider(config)` | PREEXISTING | Async factory. `type` **MUST** be exactly `'fastembed'` or `'remote'`; anything else throws `ResolutionError` **at factory time**, never mid-call. Loud-fail by design — no silent downgrade. | `dist/index.js:56-68`; byte-identical switch in 0.1.0 |
| **No `'hash'` provider** — `AMA-001` re-verified FALSE | PREEXISTING | There is no deterministic hash-based provider anywhere in `dist/`. Only two switch branches. | `dist/index.js:60-67`; grepped `fastembed.js`/`remote.js`/`index.js` |
| `EmbedRole ('document'\|'query')` — accepted, **fully ignored** — `SOX-DOC-003` re-verified FALSE | PREEXISTING | Both providers discard it: `embedSingle(text, _role)`, `void opts?.role`, `void role`. No asymmetric encoding anywhere. | `dist/fastembed.js:113,129-130`; `dist/remote.js:24-25,38-39`; self-documented at `dist/package.json:55` |
| `warmUp(texts)` — **always a no-op** | PREEXISTING | Both providers implement it as `void texts`, justified in-code by `isDeterministic === false`. Every shipped provider hard-codes `isDeterministic:false`, so it never does anything. **Not** the same thing as the internal construction-time warmup below. | `dist/fastembed.js:151-156`; `dist/remote.js:66-68` |
| Cache-hit-aware warmup timeout split (BL-376) | **CHANGED** | `createFastembedProvider()` calls `embedSingle('warmup')` at construction, bounded by `warmupTimeoutMs(cacheHit)` — **8s** (`SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS`) when the model binary is already on disk vs **180s** (`SOX_EMBED_WARMUP_TIMEOUT_MS`) on a cold download. New exported `isModelCached(cacheDir, hfRepoId)` decides which, by probing `<cacheDir>/<hfRepoId>/model_optimized.onnx`. **Breaking for direct callers** — see §1 C-7. | `dist/index.js:131-147`; `dist/fastembed.js:230-234`; `diff` vs 0.1.0 (zero-param in 0.1.0) |
| `execution_provider` in `EmbeddingHealth` | **CHANGED** | Now populated from the real child-process init response, not a hardcoded literal. | `dist/fastembed.js:70,238,110`; absent in 0.1.0 |
| Test-only `sharedClient` injection | **NEW** | `FastembedProvider`'s constructor gained an optional 4th `sharedClient` param (default: the real singleton) so tests can inject a fake IPC client with an artificial init delay without forking a real child or downloading a model. Production never passes it. | `dist/fastembed.d.ts:37`; `dist/fastembed.js:77-81`; 0.1.0 had a 3-arg constructor |
| Fastembed runs in a **child PROCESS**, not a worker thread | PREEXISTING | See §1 C-1. Deliberate and load-bearing: two `onnxruntime-node` major versions crash even when strictly serialized on one thread. | `dist/fastembedProcessHost.d.ts:1-58`; `dist/sharedFastembedProcess.d.ts:1-17`; `dist/sharedOnnxWorker.d.ts:1-87` |
| Advisory single-host lock + competing-host telemetry (BL-331/432/471) | **NEW** | Host startup calls `checkAndClaimFastembedLock()` writing `{pid, startedAt}` to an advisory lock file (path/shape centralized in the new `fastembedLock.ts`). The client reads it on every request and attaches `competing_host_pid` to telemetry if a *different* live pid is found — a second live host changes embed latency **25–50x** via cross-process CoreML/ANE contention. | `dist/fastembedLock.d.ts:1-33` (file absent from 0.1.0); `diff` of `sharedFastembedProcess.js`; `dist/fastembedProcessHost.d.ts:67` |
| IPC channel ref/unref lifecycle (BL-370, BL-410) | **NEW** | See §1 C-2. | `diff` of `sharedFastembedProcess.js`; `dist/sharedFastembedProcess.d.ts:38-54` |
| Graceful shutdown over IPC (BL-405) | **NEW** | `terminate()` now prefers sending `{__shutdown:true}` (answered with a clean `process.exit(0)`) over a raw `kill()` — a signal landing mid-`process.send()` previously produced an uncaught EPIPE crash. Bounded by `TERMINATE_GRACE_MS` with `kill()` as fallback. | `dist/sharedFastembedProcess.d.ts:86-96`; `dist/fastembedProcessHost.d.ts:57` |
| `@adhd/sox-telemetry` integration | **NEW** | New runtime dependency `@adhd/sox-telemetry@0.2.0`. Every fastembed request emits `fastembed_process.request.*` carrying `queue_depth` (the direct head-of-line-blocking signal), `response_ms`, and `competing_host_pid`. | `dist/package.json:26-29` (absent in 0.1.0); `dist/sharedFastembedProcess.d.ts:60-79` |
| L2-normalized vectors, cosine ≡ dot | PREEXISTING | `toFloat32Normalised()` and `meanPool()` both L2-normalize (with a `\|\| 1` div-by-zero guard). | `dist/fastembed.js:255-267, 191-217` |
| Chunk-then-mean-pool, threshold **per-model** | PREEXISTING | See §1 C-6. | `dist/fastembed.js:3-39, 113-124, 161-186` |
| Model roster: 5 fastembed models | PREEXISTING | `bge-small-en-v1.5` (384), `bge-base-en-v1.5` (768, **default**), `multilingual-e5-large` (1024), `bge-m3` (1024, 8192-token, 100+ langs), `codexembed-400m` (1024, 8192-token, **code-focused**, ~1.6GB RAM). All five already in 0.1.0. | `dist/fastembed.js:3-39`; `diff` byte-identical |
| `RemoteProvider` is a **non-wired stub** | PREEXISTING | `type:'remote'` returns a provider whose `simulatedRemoteEmbed` calls **no HTTP endpoint** — it validates the endpoint string and API-key shape, then unconditionally returns a **zero-filled** `Float32Array`. Its own JSDoc says so. | `dist/remote.d.ts:2-7`; `dist/remote.js:77-89` |
| `FileSystemModelCache` / `ModelCache` — **dead API** — `AMA-018` re-verified | PREEXISTING | Still re-exported, still never constructed or accepted by the factory. fastembed resolves a plain `cacheDir` string itself (`config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models`). The published `.d.ts` now carries an explicit `@deprecated SOX-BUG-002: dead API … do not wire it into the factory`. | `dist/index.d.ts:80-112`; `dist/index.js:70-92`; `dist/cache.d.ts:12-69` |
| `EmbeddingCache` (in-memory LRU) — **unreachable** | PREEXISTING | Defined in `dist/cache.js` but not re-exported from `index.js`, and the exports map has only `.` and `./package.json`. No external consumer can import it. | `dist/cache.d.ts:1-11`; `dist/index.d.ts` (no such symbol); `dist/package.json:16-22` |
| Three-tier error taxonomy | PREEXISTING | `TransientEmbeddingError` (optional `retryAfterMs`, MAY retry) / `PermanentEmbeddingError` (must NOT retry) / `ResolutionError` (factory-time only). | `dist/index.js:6-26`; `dist/remote.js:24-89` |
| `getSharedOnnxWorker()` / `SharedOnnxWorkerClient` | PREEXISTING | The real `worker_threads.Worker` singleton — hosts the MS-MARCO cross-encoder (for `sox-hybrid-search`) **and** the DeBERTa NLI verifier (for `sox-claim-verification`). Documented trade-off: `sox-claim-verification`'s `workerCount` pool option no longer buys real parallelism, accepted to eliminate a process-crashing native hazard. | `dist/sharedOnnxWorker.d.ts:1-135`; `dist/embedWorker.d.ts:1-76` |

**Removed / changed:** no public symbol removed. `warmupTimeoutMs()` signature changed (C-7). `FastembedProvider` constructor gained a 4th optional param. New runtime dep `@adhd/sox-telemetry@0.2.0`.

**⚠ DOC-GAP:** README claims a hash provider, working role encoding, and a warmUp cache. None exist. See §1 C-5. `package.json`'s `sox` block is the honest surface; the README is not.

---

### §2.2 · `@adhd/sox-vector-store@0.4.0` *(was 0.3.3)*

**What it is:** two interchangeable `VectorBackend` implementations (SQLite/`sqlite-vec` and LanceDB) behind one synchronous interface, plus a cross-backend re-embedding migrator.

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `SqliteVectorBackend` — **brute-force** cosine KNN | PREEXISTING | One `vec0` virtual table per `(modelId, dim)` space. `knn()` is answered by an internal `BruteForceBackend.search()` that SELECTs **every** candidate row, computes cosine in JS, sorts, slices to k. Genuinely brute force — **not** `sqlite-vec`'s native ANN `MATCH`. | `dist/index.js:98-266`; byte-identical to 0.3.3 |
| Filtered-KNN via `VecFilter.nodeFilter` | PREEXISTING | Real SQL pushdown: `JOIN node n ON n.rowid = v.node_id` + a WHERE built by `buildNodeFilterClause()` imported from `@adhd/sox-graph-store` — the *same* predicate translator that package's own `queryNodes`/`countNodes`/`searchNodes` use. AND-ed with `ids` when both are given. Filters candidates **before** scoring, so results are the exact top-k among matching rows. | `dist/index.js:1-2, 99-131`; `src/vector-store.spec.ts:302-397` |
| ⚠ `nodeFilter` **silently ignored by LanceDB** | PREEXISTING | See §1 C-3. | `dist/lancedb-worker.d.ts:5-7`; `dist/lancedb-worker.js:210-241` |
| `LanceDbVectorBackend` — real on-disk LanceDB + HNSW/IVF-PQ | PREEXISTING | Genuine `@lancedb/lancedb` tables (one per space) + a persisted `_vector_spaces` metadata table so `listSpaces()` survives restart. Real ANN index construction (`Index.hnswSq()` / `Index.ivfPq()`, metric/M/efConstruction/numPartitions/numSubVectors/bitsPerSubVector all configurable), auto-triggered from `upsert()` past a row threshold (PQ enforces a `2^bitsPerSubVector` floor; HNSW has none). Because lancedb's client is async and `VectorBackend` must stay synchronous, calls run in a `worker_threads.Worker` and block via synckit's `Atomics.wait`. | `dist/lancedb.js`, `dist/lancedb-worker.js` — byte-identical to 0.3.3; package BACKLOG BL-114 (resolved 2026-07-08) records it replacing a prior in-memory stub |
| **BREAKING:** LanceDB now requires `StoreAdapter` | **CHANGED** | The only functional dist change in 0.4.0. `db: Database.Database` → required `adapter: StoreAdapter`. Old call sites fail to compile (excess property + missing required property). New `requireStoreAdapterShape()` duck-types on `.capabilities` and throws a named `TypeError` pointing at `createSqliteAdapter()`/`createTursoAdapter()`/`createStoreAdapter()`. | `diff` 0.3.3→0.4.0 `dist/lancedb.js:22-56`; `dist/lancedb.d.ts:20-22`; CHANGELOG 0.4.0 / BL-389 |
| `SpaceInvariantError` | PREEXISTING | Both backends reject `upsert()` when `vec.length !== space.dim`, carrying `nodeId`/`space`/`actualDim`. One fixed dimensionality per space — a model switch must go through `reembed()`, never a hot-swap. | `dist/index.js:5-16, 182-185`; `dist/lancedb.js:69-72` |
| `reembed()` — cross-space **and cross-backend** migration | PREEXISTING | Walks a source space via `iter()`, re-embeds each item's text in batches of 32, upserts into a target space on a (possibly different) backend. Because both backends implement the identical interface, SQLite↔LanceDB migration is a normal call. `dryRun:true` returns a count with no writes. Errors are collected per-id, not fatal; falsy `getText()` counts as `skipped`, not `errors`. | `dist/index.js:294-375`; byte-identical to 0.3.3 |
| ⚠ `reembed()` never forwards `role` or `batchSize` to the provider | PREEXISTING | Calls `provider.embedBatch(texts)` with **no options object**, despite `EmbedderLike` declaring `opts?:{role,batchSize}`. Its own `batchSize=32` is hardcoded in its chunking loop and never forwarded. Not flagged in CHANGELOG, BACKLOG, or comments — reads as an oversight. | `dist/index.js:294-307`; `src/index.ts:442-448` |

**Removed / changed:** `db` → `adapter` (breaking, above). Note also that `@lancedb/lancedb@0.31.0` and `apache-arrow@18.1.0` are **hard dependencies**, not optional/peer — depending on this package pulls the LanceDB native binary whether or not you ever construct a LanceDB backend.

**⚠ DOC-GAP:** README's closing "Interface spec" section still says `src/index.ts` is a *"compileable ambient-declaration skeleton; implementation is extracted from libs/memory-core / libs/memory-enrich by the memory-refactor plan."* Stale — `dist/index.js` is a complete implementation. (This exact stale paragraph is copy-pasted across at least four sox packages; see §3.)

---

### §2.3 · `@adhd/sox-graph-store@0.6.0` *(was 0.5.3)*

**What it is:** the bi-temporal graph store — nodes and typed edges over one SQLite file, with content-hash dedup, FTS5, and never-delete audit history. **This is the package `@adhd/backlog` already depends on.**

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `createGraphBackend(adapter, opts?)` / `SqliteGraphBackend` | **CHANGED** | The consumer entrypoint. Now takes a `StoreAdapter` + optional `GraphBackendOpts`, **not** a raw `better-sqlite3` handle. See §1 C-4. | `dist/index.d.ts:267-338`; live-tested end-to-end against real better-sqlite3 (exit 0) |
| **Open-schema vocabulary + injectable `TypePolicy`** (ADR-0010, BL-438/440/442/444/447/448) | **NEW** | A fresh store's `node.kind` / `edge.rel` are plain `TEXT` — the SQL `CHECK (… IN (…))` enums 0.5.3 baked into DDL are **gone from fresh-store DDL**. Enforcement moved to an application-level `TypePolicy` (`validateKind`/`validateRel`) called on every write. Absent a caller-supplied policy you get `DEFAULT_TYPE_POLICY`, which is **still the closed six-kind / ten-rel vocabulary** — so an out-of-repo consumer sees byte-identical rejection behaviour unless it opts in. | `dist/index.d.ts:90,243-261`; `dist/index.js:437-448,679-681,740-741,936-937`; live: bad kind threw `ConstraintError`, and `sqlite_master` confirmed no `CHECK…IN` on either column |
| `EdgeRel` widened to `(string & {})` | **CHANGED** | Source-breaking for any consumer that exhaustively `switch`es on `EdgeRecord.rel` with a `never`-typed default arm. Runtime acceptance is unchanged. | `dist/index.d.ts:74-90` (the package documents this itself) |
| `migrateToOpenSchema()` — **shipped but UNREACHABLE** | **NEW** | A fully-implemented, safety-engineered offline migration (exclusive lock, verified `VACUUM INTO` backup, single-transaction rebuild with pre/post content-hash + count snapshot comparison, auto-restore-from-backup on any disagreement, refuses Turso-formatted stores, zeroes `busy_timeout`). But the exports map declares only `.` and `./package.json` — **no consumer can import it.** | `package.json:16-22`; `dist/open-schema-migration.js` (290 lines, read in full; its own header documents the exclusion as deliberate); **empirically confirmed**: a real ESM import against a real npm install threw `ERR_PACKAGE_PATH_NOT_EXPORTED`, exit 1; `grep -rl migrateToOpenSchema` across the sox monorepo finds only its own `.d.ts` and spec — no CLI, script, or doc wires it up |
| `hasEnumCheckConstraint()` structural DDL probe (BL-447) | **CHANGED** | `ensureCheckConstraints()` now decides whether to rebuild by **structurally regex-matching** the live `sqlite_master` DDL for a `CHECK (col IN …)` clause, instead of 0.5.3's literal-substring test for the newest enum member. 0.5.3's logic could not distinguish "never had this enum member" from "deliberately has no CHECK" — so it would have rebuilt on *every open* of a fresh 0.6.0 store. Load-bearing for 0.6.0 not self-DoS-ing. | `dist/index.js:649-669, 697-706` vs 0.5.3's `dist/index.js:575-583` |
| `json_valid` CHECK on `tags`/`meta` (BL-430/342/343) | PREEXISTING | Every JSON-bearing column on a **fresh** store carries `CHECK (col IS NULL OR json_valid(col))`. `GRAPH_DDL_PRE_BL430` is exported so tests can build a genuine pre-fix store. New-stores-only by construction. | `dist/index.js:11-38, 115-133`; present verbatim in 0.5.3 |
| `rebuildTable()` | PREEXISTING | Generic column-preserving SQLite table-rebuild helper (rename/create/insert-select/drop), with column-rename map, extra-column preservation, and `skipDrop` for multi-table transactions. | `dist/rebuild-table.js`; byte-identical in 0.5.3 |
| Bi-temporal audit model: `writeNode`/`supersede`/`invalidate`/`touch` | PREEXISTING | Never physically deletes. `invalidate(id, reason?)` sets `t_invalid` + stamps meta, row stays queryable. `supersede(oldId, newContent, meta)` writes a NEW node, flags the old `is_superseded=1` (**t_invalid left null — not the same as invalidate**), links old←new via `SUPERSEDES`, one transaction. `touch()` mutates in place without minting a node/edge; throws `NodeNotFoundError` if missing or invalidated. | `dist/index.js:767-844`; live: `countNodes()` 2→3 across a supersede, old row still fetchable with `isSuperseded:true` |
| FTS5 `searchNodes()` | PREEXISTING | Real FTS5 `MATCH` over content/name/summary (unicode61), joined back to `node`, filtered to live rows + any caller `NodeFilter`, scored `-fts_node.rank`. Kept in sync by AFTER INSERT/DELETE/UPDATE triggers — no reindex step. | `dist/index.js:134-153, 893-906`; live-verified |
| `writeEdge()` upsert idempotency + traversal | PREEXISTING | `ON CONFLICT(src,dst,rel) DO UPDATE` — safe to call repeatedly during re-projection. `getNeighbors`/`getNeighborsWithEdges`/`isReachable`/`getSubgraph` do depth-bounded or unbounded (`depth:-1`) recursive-CTE walks, deduped when `direction:'both'`. | `dist/index.js:933-954, 973-1171`; live: second `writeEdge` with a new weight left `getEdges` at length 1, weight updated |

**Removed / changed:** SQL `CHECK` enums removed from **fresh-store DDL only** (existing pre-0.6.0 stores keep theirs). `EdgeRel` widened (source-breaking). `createGraphBackend`/constructor gained a second `opts?` param (additive in JS). `ensureCheckConstraints()` probe logic changed.

**⚠ DOC-GAP — inverted from the usual pattern:** the `sox` metadata block here is *accurate* for everything it claims (every concern/invariant was verified true against a live SQLite run). Its failure is **omission**: neither it nor the README mentions the open-schema change, `TypePolicy`, the widened `EdgeRel`, or the migration. The README additionally links `../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md` as "the authoritative interface contract" — a monorepo-relative path that is meaningless in a published tarball. So the risk here is the reverse of AMA-001: a large, carefully-engineered capability that exists in `dist/` and is **invisible from every consumer-facing surface**.

---

### §2.4 · `@adhd/sox-store-adapter@0.3.0` *(was 0.2.0)*

**What it is:** one async CRUD/transaction API over either `better-sqlite3` or `@tursodatabase/database`, plus a large integrity/repair, migration, and per-backend dialect subsystem. **Full publish history:** 0.1.0 (07-27), 0.1.1, 0.1.2 (08-05), 0.2.0 (08-05), 0.3.0 (08-07).

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `createStoreAdapter` / `createSqliteAdapter` / `createTursoAdapter` | PREEXISTING | Auto-selects by `STORE_ADAPTER` env (default turso per README); SQLite wraps a path or a caller-owned handle; Turso opens a local file or `libsql://` remote. | `dist/factory.{d.ts,js}`; present at 0.1.0 |
| Dual backend `SqliteAdapterImpl` / `TursoAdapterImpl` | PREEXISTING | SQLite = sync, single-writer, back-compat. Turso = async, native vectors, multi-process write (`multiprocessWal` defaults true). Both expose `executeGet/All/Run/exec/transaction/executeMany/pragmaGet/pragmaSet/unwrap/close`. | `dist/sqlite-adapter.js:120-127`; `dist/turso-adapter.js:232-239` |
| `AdapterCapabilities` flags | PREEXISTING | Callers branch on `.capabilities`, not on `config.type`. **Measured:** SQLite `{multiprocessWrite:false, nativeVectors:false, concurrentTransactions:false, fts5:true, fts:true, needsWriteSerialization:true}`; Turso `{multiprocessWrite: opts.experimental?.multiprocessWal ?? true, nativeVectors:true, concurrentTransactions:true, fts5:false, fts:true, needsWriteSerialization:false}`. | same lines as above |
| Transaction modes `deferred/immediate/exclusive/concurrent` | PREEXISTING | Maps to raw `BEGIN …`. `concurrent` (MVCC) is **Turso-only**; SQLite throws if requested. Gives portable CAS (`immediate`) and portable migration locking (`exclusive`). | `dist/types.d.ts` `TransactionMode`/`TransactionOptions` |
| Portable duck-typed error helpers | PREEXISTING | `isBusyError`/`isConcurrentConflict`/`isUniqueConstraintError`/`isForeignKeyError`/`dbErrorCode`/`isDatabaseError` inspect `.code`/message shape rather than requiring `instanceof`. Plus `ETursoNativeStore` + `isTursoNativeStoreSchemaError`: SQLite adapter probes `sqlite_master` at open and converts the opaque `malformed database schema (__turso_internal_fts_dir…)` message into a typed error. | `dist/errors.d.ts`; `dist/sqlite-adapter.js:100-118` |
| `withRetry()` | PREEXISTING | Exponential backoff on busy/conflict (default `maxRetries:3`, `baseDelayMs:10`, doubling). Since BL-401 it is `sox-telemetry`'s first in-package consumer: each retry/exhaustion emits a log record with `trace_id` auto-joined from ambient AsyncLocalStorage, with **zero** signature change. | `dist/retry.d.ts:1-19` |
| `VectorDialect` (`SqliteVecDialect` / `TursoVectorDialect`) | PREEXISTING | Abstracts vector-column DDL, index DDL, and top-K KNN query construction per backend. | `dist/vector-dialect.d.ts` (added between 0.1.0 and 0.2.0) |
| ⚠ BL-392: cosine pinned in DDL, **`topKQuery` throws** for other metrics | **CHANGED** | See §1 C-8 — an undocumented runtime narrowing. | `diff pkg-0.2.0/dist/vector-dialect.js pkg-0.3.0/dist/vector-dialect.js` |
| `FTSDialect` (`SqliteFTS5Dialect` / `TursoFTSDialect`) | PREEXISTING | One place that knows FTS mechanics per backend: FTS5 external-content vtable + 4 shadow tables + 3 sync triggers (DDL supplied by caller, since store-adapter can't depend on graph-store) vs Turso Tantivy `CREATE INDEX … USING fts` + `fts_match`/`fts_score`. Plus `legacyResidueNames`/`dropLegacyDDL` for cleaning the *other* backend's leftovers after a cross-backend migration, and **`buildMatchQuery` (BL-367)** which normalizes both dialects to identical **any-term-matches OR** semantics — FTS5 bareword AND vs Tantivy bareword OR previously diverged, making 4/5 test queries return zero SQLite hits for a corpus that returned real Turso hits. | `dist/fts-dialect.d.ts` |
| `canonicalFtsIndexName()` / `resolveExistingFtsIndexName()` | **NEW** | Turso has no `ALTER INDEX … RENAME`, so a repaired index must live under a new name (`idx_fts_<table>__r1`). These let callers ask "does this table already have a healthy FTS index, under **whatever** name" instead of hardcoding the canonical one — avoiding a silent second full index (permanently doubled write/storage cost) after a repair. Returns `null` for SQLite FTS5. | `diff` 0.2.0→0.3.0 `dist/fts-dialect.d.ts:58-88` |
| `fts-orphan-guard.ts` (BL-461) | **NEW** | Wired **unconditionally** into `TursoAdapterImpl.connect()`. A Turso store whose `sqlite_master` carries an FTS index row while its Tantivy backing object is missing does not error on connect — it **panics in Rust and SIGABRTs the whole host process** the moment any `fts_match` runs (and the existing open-time integrity probe issues one on every open). The guard scans `sqlite_master` before that probe can fire; on repair it builds a replacement index under a shadow name **first**, verifies it, **then** drops the orphan (never drop-first). Measured 288ms rebuild against a 108MB / 10,272-node store. If the build fails, the orphan is still dropped and the outcome is reported `repair_failed` — never a silent repair. | `dist/fts-orphan-guard.d.ts` (absent from 0.2.0); `diff` of `turso-adapter.js` showing the call inserted above `runOpenTimeIntegrity` |
| `preflight.ts` (BL-361) | PREEXISTING | A **narrower, separate** defense: writes a marker file beside the DB on open, clears it on orderly close. Only if a previous session's marker survives (crash) does the next open run a `better-sqlite3` `sqlite_master` scan (needs both `unsafeMode(true)` **and** `PRAGMA writable_schema=ON`) *before* Turso's `connect()` runs. Complements, does not replace, the always-on orphan guard. | `dist/preflight.d.ts` (in 0.2.0) |
| `integrity.ts` — verify/repair with 7 named probes | PREEXISTING | `wal_identity`, `adapter_meta_unique`, `btree_index_populated`, `fts_index_live`, `json_column_valid`, `json_empty_array_null`, `pragma_integrity_check`. Runs automatically at init/connect (BL-352); `resolveVerifyDepth()` escalates to `'deep'` on an unclean-shutdown flag; pluggable `IntegrityReportSink`. | `dist/integrity.d.ts` (39.4KB, in 0.2.0; byte-identical at 0.3.0) |
| `integrity-status.ts` | PREEXISTING | Renders a pass into a status surface under a strict **"health must be earned"** rule: `healthy:true` only when a pass ran, completed, found no damage, **and** every probe that ran demonstrably exercised its artifact. Explicitly guards the trap where an *aborted* pass records `{ok:false, findings:[], damaged:[]}` and a naive `damaged.length===0` check reports healthy — the actual root cause of a live incident (BL-347) where `memory_ping` reported healthy for a day with a dead FTS index. | `dist/integrity-status.d.ts` (in 0.2.0) |
| `migrateStore()` | PREEXISTING | Copies all tables between two open adapters — including `vec_node` cross-backend vector-format conversion, FTS vtable recreation, UNIQUE index recreation, per-table DDL overrides/column transforms, batched inserts, and an `_adapter_meta` provenance stamp. This is the mechanism behind `createStoreAdapter`'s `migrateOnAdapterChange:true` atomic-temp-file-swap. | `dist/migration.d.ts` (in 0.2.0) |
| `adapter-meta.ts` | PREEXISTING | Stamps `adapter_type`/`adapter_version`/`created_at` on first open (idempotent, `BEGIN IMMEDIATE`-serialized). `consumeUncleanShutdownFlag()`/`markCleanShutdown()` are the crash-detection primitive that escalates verify depth on the next open. | `dist/adapter-meta.d.ts` (in 0.2.0) |
| `backupTo()` / `VACUUM INTO` + `BackupIntegrityReport` | PREEXISTING | Compacted single-file copy (SQLite loads sqlite-vec first so vec0 shadow tables copy correctly; Turso runs on the existing connection since `VACUUM INTO`, unlike in-place VACUUM, is multiprocess-WAL-compatible). Returns a structured report (`verified\|damaged\|unverified`, `capped`, `unknownCount`, `damagedCount`, `probesRun`, `findings`) — fixing a prior bug where post-backup reverification ran only `pragma_integrity_check` and a backup with a dead FTS index came back falsely "ok". | `dist/types.d.ts` + `dist/integrity.d.ts` (in 0.2.0) |
| `MockAdapter` | PREEXISTING | In-memory `Map<table,row[]>` with a regex-based mini SQL parser; `unwrap()` exposes the raw Map. No `backupTo`, no `_adapter_meta`/integrity machinery (`init()` is a no-op). | `dist/mock-adapter.d.ts` (at 0.1.0) |

**Removed / changed:** no public export removed across 0.1.0→0.3.0. `@tursodatabase/database` moved from an **optional peerDependency (0.1.0) to a hard `dependencies` entry (0.2.0)** — every consumer now installs the Turso native binding even if it only ever calls `createSqliteAdapter()`. Plus the undocumented BL-392 narrowing (C-8).

**⚠ DOC-GAP:** npm's `sox` metadata block lists only 5 "concerns" (unified interface, capability-flagged factory, transaction modes, portable errors, retry) and never mentions integrity/repair, migration, vector-dialect, fts-dialect, adapter-meta, preflight, or fts-orphan-guard — i.e. the **bulk of the package**. It still literally describes the 35-file 0.1.0 footprint while the shipped package is 67 files / 560KB unpacked. Treat that block as stale marketing copy, not an inventory.

---

### §2.5 · `@adhd/sox-hybrid-search@0.3.4` *(was 0.3.3)*

**What it is:** BM25 + vector fusion over a `VectorBackend` + `GraphBackend`, plus a real cross-encoder reranker. **This is the most directly relevant package to backlog semantic search.**

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `SearchBackend` / `SearchQuery` / `SearchResult` contract | PREEXISTING | Mechanism-agnostic: backends report `textScore`/`vecScore` (never `bm25`/`cosine` in the type surface), degrade to text-only or vec-only when a signal is absent, never error on a missing signal. | `dist/index.d.ts:8-48`; byte-identical back to 0.2.0 |
| `SqliteSearchBackend` | PREEXISTING | DI-constructed over `(VectorBackend, GraphBackend)`. BM25 text via `graph.searchNodes()`, vector KNN via `vec.knn()`, merged into one candidate map keyed by node id. | `dist/index.js:360-441` |
| `normalize()` + `fuse()` | PREEXISTING | Pure, storage-free. Normalize via `min_max`/`L2`/`z_score`, then combine `textScore`+`vecScore` with **multiplicative** (never additive / scale-blind) weights, normalized **before** combining. | `dist/index.js:24-120` |
| `fuseWithBreakdown()` + `FusionBreakdown` | PREEXISTING | Same math, returns per-channel (`bm25`/`vec`/`total`) contributions per result — additive and byte-identical to `fuse()`'s score. **Not gated behind a flag**; a separate exported function. Already shipped at 0.2.0 despite being absent from the prior snapshot's behaviour list. | `dist/index.d.ts:70-118`; `dist/index.js:138-197` |
| Vector-channel filter parity (BL-294) via direct pushdown | **CHANGED** | `query.filters` (namespace/kind/topic/project_path/agent_id/tags/importance_min/ids/confidence) resolve to a `NodeFilter` passed **straight into** `vec.knn(query.vec, space, limit*2, {nodeFilter})` — a single JOIN pushed into vector-store. The vector channel is scoped identically to the text channel; no unfiltered vector hits leak. This **replaced** an earlier two-step `queryNodes()→ids` mechanism. | `dist/index.js:397-427`; source CHANGELOG 0.3.0 entry |
| Degrade signal (`SearchDegradeInfo`) | PREEXISTING | Any `query.filters` key with no `NodeFilter` mapping is recorded in `unsupportedFilters` and surfaced **unconditionally** (not behind `explain:true`) as `result.degraded`. Query-level, not per-candidate. | `dist/index.js:428-441`; `dist/filter-utils.js:58-66`; propagated at `dist/index.js:238-357` |
| `buildFilterClause()` | PREEXISTING | Exported utility mapping a raw filter object to a `NodeFilter` + an `unsupportedFilters` list. **This is the function `@adhd/sox-memory-core` imports** rather than reaching into vector-store directly. | `dist/filter-utils.js:1-78` |
| `topicBoost()` | **CHANGED** | Post-fusion multiplicative boost: exact `fields.topic === query` → **2x**, substring → **1.5x**. | `dist/index.js:199-341` |
| **BL-437: `TOPIC_BOOST_FLOOR`** | **NEW** | Under `min_max` normalization the lowest-scoring candidate in **any** result set normalizes to exactly 0, and `0 * boost === 0` — so the last-place candidate could *structurally never* be re-ranked up (in a 2-candidate set the loser could never be reordered at all). Fixed by flooring a **literal-zero** fused score to `0.1` before the boost. Deliberately a `=== 0` check, not `Math.max` — a near-zero score like 0.0333 is left alone. `0.1` chosen via a documented synthetic epsilon sweep (0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2). | `diff` v0.3.3 → 0.3.4 `dist/index.js:~209-237, ~332-339` — the **only** code delta between the two versions |
| `createCrossEncoder()` / `CrossEncoder` | PREEXISTING | A **real ONNX sequence-classification cross-encoder** (`Xenova/ms-marco-MiniLM-L-6-v2`, quantized q8) — **not** a lexical/token-overlap heuristic. Inference proxies through the one process-wide shared ONNX worker in `sox-embedding-provider` (`getSharedOnnxWorker()`) rather than spawning its own, deliberately: two concurrent `onnxruntime-node` native instances in one process was proven (BL-238) to crash it with a V8 HandleScope fatal error. `rerank()`/`rerankBatch()` race against a configurable `timeoutMs` (default 30000). | `dist/cross-encoder.js:1-147` (zero diff across 0.2.0/0.3.0/0.3.3/0.3.4); model wiring at `sox-embedding-provider/src/embedWorker.ts:140-209` |

**Removed / changed:** `search()` and `SqliteSearchBackend.search()` are **async** (`Promise<SearchResult[]>`) — the sync→async change landed between 0.3.0 and 0.3.1, i.e. it was already true at the snapshot baseline but is recorded nowhere in this repo. Any caller written against a synchronous `search()` is broken. `topicBoost()`'s floor behaviour changed in 0.3.4, which changes ranking output for any result set whose min_max floor lands exactly on 0.

**Caveats worth knowing before designing:**
- `createCrossEncoder` is exported but **not called anywhere inside this package's own `search()` pipeline** — it is a standalone opt-in reranker the caller wires in.
- `CrossEncoderRerankerConfig` (`mode: always-on | threshold-gated | skip`, `maxCandidates`, `gateThreshold`) is exported as a **type with zero runtime references** in any `.js` in the package — a policy shape with no implementation here.

**⚠ DOC-GAP (three, all live):**
1. `package.json`'s `sox` block — mirrored into the npm registry JSON, i.e. what `npm view` shows — still describes the **old pre-0.3.0 two-step mechanism**: *"SqliteSearchBackend resolves query.filters through graph.queryNodes() and constrains vec.knn() to the matching id set."* The code has passed `{nodeFilter}` directly since 0.3.0.
2. The published README ends with the same stale *"ambient-declaration skeleton … extracted from libs/memory-core / libs/memory-enrich"* paragraph. The dist is a complete implementation.
3. The README's "concerns" bullet list is **missing** the BL-294 vector-filter-parity and unconditional-degrade-signal concerns that ARE in the `package.json` `sox` block shipped in the same tarball — the two in-package descriptions of the same package have drifted apart from each other, not just from the code.
4. The package-local source `BACKLOG.md` carries **BL-116** ("HIGH: cross-encoder worker uses a token-overlap heuristic, not a real ONNX model") citing `src/crossEncoderWorker.ts`, a file that **no longer exists**, and **BL-166** describing a hardcoded `resolveWorkerPath()` that also no longer appears. Both are obsolete and must not be built upon.

---

### §2.6 · `@adhd/sox-ingest@0.1.0` *(unchanged — sole published version, 2026-07-09)*

**What it is:** advertised as a pure write-path document transform. **Actually** that plus a full pluggable multi-language chunking subsystem.

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `ingest()` | PREEXISTING | Returns `{contentHash, summary, tags, chunks?}`. `contentHash` = SHA-256 of trim + collapse-whitespace-normalized content. `summary` = **extractive lead-N sentences (default 3), zero scoring, document order only**; content under 100 chars returns verbatim. `tags` = frequency-ranked, stopword-filtered (len>3), capped at `tagMaxCount` (default 10) — noun-phrase-ish word extraction, **not** real NLP. Optional `chunk:{maxChars,overlapChars}` = sliding window with a per-chunk SHA-256. | `dist/core.js:33-185`; **live-executed against the real dist**: a 99-char 4-sentence string returned the whole string (the <100 passthrough); a 241-char 5-sentence string returned exactly the first 3 (lead-N, no scoring); a 5000-char string with `maxChars=2000, overlapChars=200` produced 3 chunks at offsets [0,1800,3600] |
| `hexSha256()` | PREEXISTING | ⚠ **Raw** hasher with **no normalization** — callers wanting dedup parity with the legacy `write.ts` behaviour must pre-normalize (`content.trim().toLowerCase()`) themselves. | `dist/core.d.ts:21-32` |
| `splitIntoChunksSentence()` | PREEXISTING | Separate byte-parity reimplementation of the legacy memory-server sentence chunker: splits at `chunkTokens*4` chars, prefers sentence boundaries, **no overlap** — contrast with `ingest()`'s own sliding-window chunker, which does overlap. | `dist/core.js:108-144` |
| `ChunkerRegistry` / `globalChunkerRegistry` | PREEXISTING | Sealable named-chunker registry (register/seal/get/getForLanguage/list), auto-populated with **12** built-ins the moment the ESM root is imported: `ast:treesitter:{ts,python,java,csharp}`, `heading:{markdown,mdx,rst,asciidoc}`, `mixed:{markdown,mdx,rst,asciidoc}`. | `dist/chunker-registry.js:1-52`; `dist/index.js:23-43`; **live**: `list()` returned exactly those 12 IDs |
| `AstChunker` — **real tree-sitter** | PREEXISTING | cAST algorithm over a genuine `web-tree-sitter` WASM parser (grammars via `tree-sitter-wasms`) for typescript/python/java/csharp. Declaration spans (function/class/interface/type-alias/enum, plus arrow-function-valued `const` and export-wrapped declarations for TS) are **never split across chunks**; declarations shorter than `minFunctionLines` (default 3) merge into the preceding chunk; C# `namespace` is a transparent recursion container; the document is **losslessly partitioned** — preamble, inter-declaration gaps, and trailing code all become chunks. `chunk()`/`estimate()` are synchronous because all 4 grammars are eagerly preloaded via a real top-level `await` at module evaluation. | `dist/ast-chunker.js` (297 lines, read in full); **live**: a 9-line real TS snippet produced 3 correctly line-bounded chunks |
| `HeadingChunker` | PREEXISTING | Heading-bounded sections with a heading stack producing an `"H1 > H2"` path per section. RST underline-heading detection (`===`/`---`) is scoped strictly to `syntax==='rst'` so it doesn't misfire on Markdown horizontal rules/frontmatter or AsciiDoc's `----` fence. | `dist/heading-chunker.js` (187 lines); **live**: produced `"Title"`, `"Title > Section A"`, `"Title > Section B"` |
| `MixedFormatChunker` | PREEXISTING | Heading chunker first (parent sections), then the AST chunker on any fenced code block inside each section (```` ```lang ```` for md/mdx, `.. code-block::` for rst, `[source,lang]`+`----` for asciidoc), via a fence-language alias table (ts/tsx/js/jsx/mjs/cjs→typescript, py/python3→python, cs/c#→csharp). AST child chunks are **nested** — sharing the parent heading path, immediately following the parent — with line numbers remapped snippet-relative → document-absolute and `chunkIndex` renumbered. | `dist/mixed-format-chunker.js` (269 lines); **live**: markdown + one ```` ```typescript ```` fence produced a `heading:markdown` parent followed by an `ast:treesitter:typescript` child sharing `metadata.heading:"Doc"` |
| ESM-only root / CJS-safe `./core` split | PREEXISTING | The root (`.`) re-exports `AstChunker`, which carries a real module-scope top-level `await` — `require()`-ing it throws `ERR_REQUIRE_ASYNC_MODULE`. `./core` exports only `hexSha256`/`splitIntoChunksSentence`/`ingest` (zero chunkers, zero top-level await) and is genuinely CJS-safe. This is what lets CommonJS `@adhd/sox-memory-core` consume `ingest()` without crashing at load. | **Live-verified in both directions** against the unpacked tarball: `require('./dist/core.js')` succeeded and produced a correct digest; `require('./dist/index.js')` threw `ERR_REQUIRE_ASYNC_MODULE` |
| `./package.json` subpath export | **CHANGED (source only)** | Current source declares it (commit 14586637, 2026-07-11). The **published tarball does not** — it predates that commit and was never republished. A consumer of the real npm package **cannot** resolve `@adhd/sox-ingest/package.json` today. | `diff` of tarball vs source `package.json` — that one line is the only difference |

**Removed / changed:** the package's own source `BACKLOG.md` **BL-117** describes a `lateChunking.enabled` flag as "parsed but not implemented" — but `grep 'lateChunking'` across `src/` and `dist/` returns **zero hits**. Nothing named `lateChunking` exists here to build on or remove.

**⚠ DOC-GAP (three):**
1. The npm `sox.concerns`/`sox.entrypoints` block describes **only** the pure `ingest()` core — never `ChunkerRegistry`, `AstChunker`, `HeadingChunker`, or `MixedFormatChunker`, which are 6 of 8 dist modules and most of what the root export surfaces.
2. Source README says *"Private: only the memory domain composer calls these / PRIVATE — not published to npm"* — **false** since commit f4897aa (2026-07-08); it has been on the public registry since 2026-07-09.
3. Source README describes the summary as *"sentence-scoring"* — the implementation does **no scoring** whatsoever (pure lead-N), confirmed by reading `extractiveSummary()` and by live execution.

*Correct claim worth recording:* the `sox` block's assertion that `ingest()` never touches the AST/WASM path ("reaches no chunker") **was verified true** — `ingest`/`hexSha256`/`splitIntoChunksSentence` never reference `ast-chunker.js`.

---

### §2.7 · `@adhd/sox-analysis@0.1.5` *(was 0.1.4 — dependency bumps only)*

**What it is:** pure algorithms (clustering, near-dup, importance, DAG scheduling) plus DB-integrated wrappers that write results back into a graph store.

**The whole 0.1.4→0.1.5 delta:** `dist/index.js`, `dist/index.d.ts`, and `README.md` are **0-line diffs**. Only `package.json` changed (`sox-vector-store` 0.3.3→0.4.0, `sox-graph-store` 0.5.3→0.6.0, devDep `sox-store-adapter` 0.2.0→0.3.0). Any behaviour drift a consumer sees comes from those two packages, not this one.

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `cluster(vecs, opts?)` — pure | PREEXISTING | DBSCAN from the real npm `density-clustering@1.3.0` over cosine distance. `threshold` (default 0.75) → epsilon `1-threshold`; `minClusterSize` (default 2) → minPts. | `dist/index.js:1-2, 31-59` |
| `detectNearDupPairs(vecs, opts?)` — pure | PREEXISTING | O(n²) pairwise cosine with **tri-state** classification: `≥ nearDupThreshold` (0.95) → `near_dup`; `< distinctThreshold` (0.70) → `distinct`; else → **`candidate`**. Sorted descending for determinism, optional `limit`. | `dist/index.js:60-87` |
| `scoreImportance(node)` — pure | PREEXISTING | Deterministic 1–10 from `{inDegree, outDegree, recencyMs, nearDupCount}`: centrality `min((in+out)/10,1)*4` + recency (1-day half-life, ×3) + near-dup penalty (−0.2/dup, floored via ×2) + base 1.0, clamped. | `dist/index.js:88-95` |
| `topoSort(nodeIds, getEdges)` — pure | PREEXISTING | Kahn's algorithm with **wave/level numbers**, over any caller-supplied adjacency (`getEdges`) — **not tied to sox-graph-store**. On a blocking cycle it returns the offending cycle instead of throwing. | `dist/index.js:97-185` |
| `criticalPath(nodeIds, getEdges, getWeight)` — pure | PREEXISTING | Longest-path DP over the topo order. | `dist/index.js:186-203` |
| `detectCycles(nodeIds, getEdges)` — pure | PREEXISTING | DFS returning **all** cycles (unlike `topoSort`'s internal first-cycle finder). | `dist/index.js:204-235` |
| `detectDAGStructure(nodeIds, getEdges)` — pure | PREEXISTING | Classifies `forest` (every node ≤1 parent) / `general` (has a cycle) / `series-parallel` — the last via a **real** Valdes-Tarjan-Lawler-style series/parallel reduction, not a stub. | `dist/index.js:236-343` |
| `packBatches(items, opts)` — pure | PREEXISTING | Bin-packs weighted items with dependency + resource constraints into cost-bounded batches (`opts.B` base cost, `opts.W` max weight). `algorithm:'auto'` selects by size/structure: N≤20 → **exact bitmask-DP** (2^N, real optimum, falls back to HLFET if infeasible); N≤50 forest/series-parallel → tree-dp; N≤50 general → **simulated annealing** (T0=100, α=0.95, ≥200 iters, real Metropolis) seeded from HLFET; N>50 → HLFET greedy. Batch cost is **submodular** — shared `resourceCost(key)` values are deduplicated by resource key before summing. All four algorithm bodies are real. | `dist/index.js:353-717` |
| `setOverlapMatrix(items, valueFn?)` — pure | PREEXISTING | Pairwise Set intersection over items' string-key arrays; per pair, the intersecting keys plus a `bytes` sum via `valueFn` (default 1/key). **Directly applicable to §4(d).** | `dist/index.js:726-745` |
| `clusterStore(vec, graph, opts?)` — DB | PREEXISTING | Resolves a `modelId`, reads all vectors for the space, filters to nodes still live in the graph, runs `cluster()`, then **writes back**: one `community-<id>` node per cluster (label from the first member's topic/name) + a `MEMBER_OF` edge per member, each tagged with `metadata.modelId`. | `dist/index.js:747-793` |
| `clusterSubset(vec, graph, filter, opts?)` — DB | PREEXISTING | Same, scoped to a `NodeFilter` subset; writes `subset-community-<id>` nodes carrying the filter in metadata; returns `totalInSubset`. | `dist/index.js:794-837` |
| `detectNearDup(vec, graph, opts?)` — DB | PREEXISTING | ⚠ Writes a `SAME_AS` edge (weight = cosine) for every pair with status `near_dup` **OR `candidate`** — the write side is more permissive than the name suggests. | `dist/index.js:838-870` (writeEdge fires on both branches, `:855-868`) |
| `computeImportance(_vec, graph, opts?)` — DB | PREEXISTING | Writes back via `graph.touch(id,{importance})` unless `dryRun`. **Genuinely incremental only when no `opts.filter` is supplied** — it skips any node whose `importance` is already >0. Passing a filter forces a full recompute of every matched node. | `dist/index.js:871-901`, skip check at `:878` |
| `buildAutoLinks(vec, graph, opts?)` — DB | **⚠ not incremental** | Pairwise cosine across live vectors matching an optional filter; for every pair `≥ similarityThreshold` (0.80), sorted descending, writes a `RELATES_TO` edge until each node hits `maxLinksPerNode` (5) **new links from this call**. It **never queries pre-existing edges** — the per-node counter starts at 0 every invocation, so repeated calls keep adding up to 5 more edges per node on top of whatever exists. Not idempotent. | `dist/index.js:902-947`; counter init at `:929-932` |
| `runBatchEnrich(vec, graph, opts?)` — DB | PREEXISTING | Sequences `computeImportance → detectNearDup → buildAutoLinks → clusterStore`, each skippable via `opts.skip`, with a `dryRun` that counts candidates without writing. Returns `{nodesProcessed, nearDupPairsFound, autoLinksCreated, communitiesUpdated, durationMs}`. | `dist/index.js:948-1014` |

**⚠ DOC-GAP (five, all standing since the package's origin commit 6b71d5f1, 2026-06-29 — none are regressions):**
1. `sox.concerns`: *"setOverlapMatrix (pairwise intersection; **MinHash for |S| > 500**)"* — **the MinHash optimization does not exist.** Plain nested-loop full Set intersection for every pair, no size threshold, no sketch, no import. Zero code hits for `minhash` in `src/` or `dist/`.
2. invariants: *"clustering uses an existing JS lib (density-clustering / **hdbscanjs**)"* — `density-clustering` is real and used; **`hdbscanjs` is not a dependency** and appears nowhere. The broader claim ("NOT hand-rolled DBSCAN") is true.
3. invariants: *"computeImportance / **buildAutoLinks** are incremental by default … processes only un-scored nodes"* — true for `computeImportance` only. `buildAutoLinks` has **no** skip check at all.
4. `sox.concerns`: *"batch enrichment orchestration (runBatchEnrich — **incremental**, skip-list)"* — the skip-list half is accurate; "incremental" holds for **1 of 4** orchestrated steps.
5. README "Interface spec": *"src/index.ts is a compileable ambient-declaration skeleton; implementation is extracted from libs/memory-core / libs/memory-enrich"* — false. `src/index.ts` is a complete 1313-line implementation, and **`libs/memory-enrich` does not exist anywhere in the sox tree.**

---

### §2.8 · `@adhd/sox-memory-core@0.6.0` *(was 0.5.0)*

**What it is:** the composed memory system — the largest package in the family (53 dist modules, ~1.3MB unpacked, dist-only publish). Mostly interesting here as a **worked reference implementation** of everything the other packages provide.

| Capability | Status | What it actually does | Evidence |
|---|---|---|---|
| `embed()` / `EMBED_DIM` | **CHANGED** | 768-dim L2-normalized embedding by delegating to `sox-embedding-provider`'s fastembed (`bge-base-en-v1.5`). **No chunking/mean-pooling lives here** — that is entirely in embedding-provider. `embedText()` (the old sync shim) now always throws. | `src/embed.ts:1-330`; `EMBED_DIM=768` at `:28`; L2 claim at `:221`; throw at `:326-330` |
| `SOX_EMBED_BACKEND` closed union | **CHANGED** | `'auto' \| 'real'` only. Any other value — **including a stale `'hash'`** — fails **loudly** at call time (BL-250 fixed a prior silent passthrough where `SOX_EMBED_BACKEND=hash` flowed through unchecked and was reported as if real). | `src/embed.ts:47-73`; `dist/embed.js:56` |
| `getEmbedHealth()` / `getEmbedState()` / `getLastEmbedError()` | PREEXISTING | Truthful health (state `'real'\|'uninitialized'`, active model, backend, last error, `execution_provider`) — designed (BL-54) never to report warm/healthy without a resolved provider. | `src/embed.ts:127-158` |
| `terminateEmbedWorkers()` | **NEW** | Calls `.terminate()` on **both** the shared fastembed child process and the shared ONNX worker thread before the parent exits (BL-405) — previously a SIGTERM'd parent left orphans that crashed on EPIPE. Reproduced live: `libc++abi: terminating due to uncaught exception` on every SIGTERM tested. | `src/embed.ts:401-430` |
| `openDb()` → `Promise<StoreAdapter>` | **CHANGED** | No longer better-sqlite3-only. sqlite-vec loading, DDL, and pragmas all go through the adapter, with backend-specific `dialect.ts` helpers (`vectorDialectFor`/`ftsDialectFor`, BL-381) replacing ad-hoc backend-guessing. Callers needing raw better-sqlite3 must cast to `SqliteAdapter` and `unwrap()`. | `src/db.ts:1-90`; `dialect.ts:1-28` |
| Store identity stamping | PREEXISTING | Stamps `schema_version`/`writer_artifact`/`embed_model`/`embed_dimensions` on first write; raises `EStoreMismatch` naming expected vs actual on reopen. ⚠ **Known caveat BL-252:** the `embed_model` stamp can be written before any real provider has loaded, because `_activeModel` is pre-initialised to the same string a real load would set — making the stamp **unfalsifiable** in that case. | `src/db.ts:25-91` |
| Two-phase write pipeline | PREEXISTING | **Phase A** is fully synchronous (dedup, node insert, FTS trigger, tags/entities, sync enrichment, outbox row, commit — **no embedding**) and holds the serial WriteQueue slot; **Phase B** computes the vector off-queue and inserts `vec_node` in a short follow-up. Built after a 2026-07-04 production incident (6-item batch timeout at queue depth 29) where ONNX inference blocking the write queue caused MCP client timeouts. **This is the pattern `RAG-SPEC.md` §3.1 reuses.** | `src/write.ts` header; `src/embed-pipeline.ts:1-50` |
| `healMissingVectors` / `healStaleVectors` / `embedBacklogStats` | PREEXISTING | Detects nodes left without a vector after a Phase A/B crash gap, or with a stale one, and re-embeds; backlog depth exposed via `memory_ping`. | `src/embed-pipeline.ts:22-28` |
| `memoryRecall` | **CHANGED** | Deterministic <50ms hot path: 1 query embed, **parallel** vec0 KNN + FTS5 BM25 + temporal-recency channels, **RRF (k=60)** fusion with per-channel weights vec=1.0 / fts=0.8 / temporal=0.4, per-query min-max normalization, recency×importance rerank (0.995/hour decay), depth-1 graph expansion, assembled within a token budget (default **32000**, raised from 4000 which was too small for doc-scale nodes). | `src/recall.ts:1-49, 297-309`; `DEFAULT_TOKEN_BUDGET` at `:299` |
| Read-path embed timeout (`SOX_RECALL_EMBED_TIMEOUT_MS`) | **NEW** | Races the mandatory query-embed against a 3s default so a saturated shared fastembed process (**live-observed p50 embed duration ~25 minutes** during an incident) can never hang recall; on timeout the vec channel degrades to BM25/temporal-only. | `src/recall.ts:59-119` |
| ⚠ `agent_id` means two different things | PREEXISTING | In single-store `memoryRecall` it is a **hard filter** across all three channels — a non-match cannot appear. In `federatedRecall` it is only a **×1.25 boost** — a non-match still ranks, lower. Explicitly documented as a trap (BL-230) for anyone tuning ranking off one path. | `src/recall.ts:27-43` |
| `parentContext` expansion | unknown (0.5.0 not itemized) | Walks `DERIVED_FROM` edges (falling back to `parentDocId`/`session_id`) up to `maxDepth`, accumulating parent/grandparent text under `maxContextTokens` with 4 join strategies (contiguous/separator/structured/truncate-tail); throws `ExpansionOverflowError` unless `truncate-tail`, which truncates and sets `expansionTruncated:true`. | `src/recall.ts:228-236, 900-1029, 286-295` |
| ⚠ `lateChunking` — accepted, **always reported not-applied** | **CHANGED** | A prior version accepted `lateChunking:{enabled:true}` and reported `applied:true` **while doing nothing**. Now `evaluateLateChunking()` unconditionally returns `applied:false` plus a machine-readable `lateChunkingSkipReason` explaining that the schema stores one mean-pooled vector per node (no token-level matrix to pool from) and recall's zero-provider-call invariant forbids computing one at query time. **Same failure pattern as AMA-001/SOX-DOC-003 — caught and disclosed rather than left silent.** | `src/recall.ts:238-282` (BL-117) |
| `federatedRecall` / `SCOPE_WEIGHTS` / `degradations` | **CHANGED** | Cross-scope RRF union across discovered stores. Weights unchanged: project=1.0, user=0.6, org=0.4, local=1.0. Content-hash dedup across stores, SUPERSEDES suppression. Always returns `degradations: string[]` (empty when nothing failed) so a per-store failure is never silently invisible (BL-391). | `src/recall.ts:1133-1164` |
| Consumes `buildFilterClause` from **hybrid-search** | PREEXISTING | memory-core imports the pushdown builder from `@adhd/sox-hybrid-search`, **not** vector-store directly — and `@adhd/sox-vector-store` is **not a direct dependency** of memory-core in either the published or workspace `package.json`. | `src/recall.ts:56, 383-463`; dependency grep |
| `buildFiltersClause` (memory-core's own `MemoryFilter`) | PREEXISTING | A **second**, memory-core-owned filter vocabulary (project_path exact/prefix, topic, tags any/all, importance_min, t_created_after/before) with its own clause builder, shared between recall and `clusterSubset` so cluster subsetting uses the same vocabulary as recall. All values are bind params — no injection surface. | `src/memory-filters.ts:1-138` |
| Scope Promotion | PREEXISTING | Config-typo-safe (unknown-key detection) pipeline for graduating memories between scopes, gated by `min_occurrences`/`min_age_days`/`approver_scope`, with a propose/apply/reject lifecycle. | `src/extensions.ts:21-400` |
| `graphifyImport` / `SUPPORTED_GRAPHIFY_SHAPES` | PREEXISTING | Version-defensive bulk import: fingerprints a payload against exactly two known shapes, validates every field, and **refuses the whole import (no partial write)** on any unknown shape or field. | `src/extensions.ts:402-560` |
| `cluster.ts` — byte-reproducible clustering | PREEXISTING | Cosine-threshold connected components. Rowids sorted ascending; community UID = `sha256(sorted member rowids joined by ',').slice(0,32)`; label from centroid-nearest member; singletons suppressed; episodes with `content.length<50` excluded; degenerate-cluster guard (max_cluster/total > 0.5 → threshold +0.05, retry ≤3×). **No LLM, no network.** | `src/cluster.ts:1-14` |
| `community-gc.ts` | **NEW** | When an episode is invalidated, its `MEMBER_OF` edge **and** any community left with zero live members are invalidated in the **same transaction** — closing a leak where invalidation churn silently decayed `total_clustered` toward 0 while `cluster_count` stayed fixed (previously required a full re-cluster to repair; now O(1) self-cleaning). | `src/community-gc.ts:1-20` |
| `quota.ts` | PREEXISTING | Soft 512MB → structured non-blocking warning; hard 1GB → `E_IO` refusal **before** any write is attempted. Ships a documented **negative-control test** that removes the guard and proves the over-quota write then succeeds. | `src/quota.ts:1-19, 70-73` |
| `backupStore` / `autoBackup` | PREEXISTING | `VACUUM INTO` delegated to the adapter; `destPath` must resolve inside a `~/.memory/**` allowlist, refused with `E_ALLOWLIST` before any file is created. | `src/backup.ts:1-20` |
| `runCompactionPass` / `startCompactionTick` | PREEXISTING | 5-minute `PRAGMA optimize` + `ANALYZE` + `wal_checkpoint(TRUNCATE)`, coordinated with WriteQueue's faster 2s idle checkpoint so they don't double-fire. | `src/compaction.ts:1-16, 64` |
| `runEnrichIsolated` / `enrich-process-host.ts` | PREEXISTING | Batch enrichment (clustering, importance, auto-links, decay) runs in its **own forked OS process per pass** — because better-sqlite3 is fully synchronous and a clustering bug could block the event loop or crash the parent via an unhandled rejection, silently dropping in-flight embeddings. `runEnrichIsolated()` **never throws or rejects**; every outcome is a typed `{ok:true\|false}`. | `src/enrich-process-host.ts:1-40`; `src/enrich-isolation.ts` |
| `checkAndEscalateEnrichStall` | **NEW** | Durable corrective-action recording on a genuine enrichment stall — built after BL-413 (2026-08-03) where `queue_depth=46`, `queue_last_done_at` 22.5h stale, stall true for ~90 consecutive 15-min windows produced only a bare `console.error` that reached no durable telemetry. | `src/enrich-stall.ts:1-20` |
| `write-queue.ts` | PREEXISTING | One in-process, per-store-path serial FIFO queue (single connection, group-commit permitted). Overflow → `E_BUSY {retryable:true, retry_after_ms:250}`. Read connections set `query_only=ON`. Adds **time-based** backpressure beyond the size bound, after a 2026-07-04 incident where CPU contention stretched latency past MCP client timeouts while the queue stayed under its size limit. | `src/write-queue.ts:1-20` |
| `store-registry.ts` | PREEXISTING | Resolves a logical store name to a physical `db_path` via `~/.memory/registry.json`, echoing a size+mtime fingerprint. Raw `db_path` still accepted with a deprecation warning. **An unknown store name never creates a file** — returns structured `E_UNKNOWN_STORE`. | `src/store-registry.ts:1-16` |
| `ontology.ts` | PREEXISTING | 6 node kinds (episode, entity, claim, community, session, generic) and 10 edge rels (MENTIONS, SUPPORTS, RELATES_TO, SUPERSEDES, DERIVED_FROM, MEMBER_OF, PART_OF, SAME_AS, ASSIGNED_TO, DEPENDS_ON) — byte-identical to graph-store's defaults. Extensible via `registerOntologyExtension`, last-registration-wins, process-wide at startup only. | `src/ontology.ts:4-10`; `src/graph-backend.ts` (BL-441) |
| Read-only domain query surface | PREEXISTING | A family of small single-purpose functions, each marked `[inv:no-mcp]` (returns a plain object, never an MCP ToolResult): session state, topics with community-backing status, projects, entities ranked by MENTIONS count, depth-1 neighbors, entity episodes, `SAME_AS` near-dup pairs, bidirectional SUPERSEDES chain walk, a curation dispatcher (retag/set-topic/set-importance/merge/recluster/drop-lens/drop-episodes/list-lenses), aggregate stats, and a markdown export mirror. | `src/{session,topics,projects,list-entities,related,entity-episodes,near-duplicates,supersession-chain,curate,stats,export}.ts` headers |
| `memoryLinkNode` / `autolink.ts` | PREEXISTING | Manual edges via `NOT EXISTS`-guarded raw SQL (graph-store's `writeEdge` needs a UNIQUE index memory-core's schema lacks), plus an automatic `RELATES_TO` linker connecting episodes that share entity mentions above a frequency threshold. | `src/link.ts`; `src/autolink.ts` |
| `reembedStore` | PREEXISTING | Idempotent re-embedding workflow (library replacement for a deleted script): `--dry-run` writes nothing; skips a node whose per-record `embed_model` already matches (override via `force`); backs up DB+WAL/SHM before any write unless disabled; canonical model id is always `bge-base-en-v1.5`, not the cache-dir name. | `src/reembed.ts:1-25` |
| Re-exports `hexSha256` / `splitIntoChunksSentence` | PREEXISTING | Straight from `@adhd/sox-ingest/core` through memory-core's own barrel. | `dist/index.d.ts:125` |

**Removed / changed:** the **`'hash'` embedding backend** (`EmbedBackend` is now a closed `'auto'|'real'` union that fail-louds). The standalone **memory-daemon** (Unix-socket writer daemon) and its `OutboxQueue` consumer / `memoryFlush` poller / dead-letter migration — all deleted per BL-183 as built-but-never-wired scaffolding with zero consumers; batch enrichment is now in-process in memory-server's writer backend per ADR-0007. `openDb()` returns a `StoreAdapter` promise. Dependency bumps: graph-store 0.5.3→0.6.0, hybrid-search 0.3.3→0.3.4, embedding-provider 0.1.0→0.2.0, store-adapter 0.2.0→0.3.0, analysis 0.1.4→0.1.5; ingest and telemetry unchanged.

**⚠ Note on doc quality:** `recall.ts`'s own header (`:1-49`) **retracts** a prior in-file claim that its admit/work timing split was "the direct measurement of BL-331's head-of-line-blocking question" — a proper n=570 sample showed near-zero admit-phase contention. Anyone citing that claim from an older copy of the file is citing retracted content. The `sox.sidecars: ["src/enrich-process-host.ts"]` metadata **is** a real, verified mechanism, not aspirational.

---

### §2.9 · `@adhd/sox-telemetry@0.2.0` *(first and only publish — 2026-08-05)*

**What it is:** the durable structured-logging / stage-instrumentation substrate. **There is no prior npm baseline** — the package's own CHANGELOG records `npm view` returning a hard E404 before this release, so `DEBT-SOX-001`'s "0.2.0" snapshot entry describes this same release, not an earlier one that changed. A never-published internal 0.1.0 manifest briefly described an incompatible surface; that version is permanently unclaimed.

| Capability | What it actually does | Evidence |
|---|---|---|
| `initTelemetry(opts)` / `TelemetryHandle` | Composition-root entry, called **once** at startup with `{service, role, logSink?, logDir?, maxBytes?, maxFiles?, durable?, otel?, snapshotEveryRecords?}`. `role` is a **required** closed union `'live-service'\|'test'\|'cli'\|'harness'` — what keeps a live service's telemetry from being indistinguishable from a test run sharing the same disk (BL-353). | `dist/runtime.d.ts:26-91`; `dist/runtime.js:125-210` |
| Fail-open, uninitialised-safe emission + one-shot stderr warning | Every emitter is safe to call with no `initTelemetry()` — falls back to `service:'unlabeled'`, `logSink:'none'`, drops records rather than crashing. The **first** such emission prints exactly one stderr warning, so a forgotten composition root self-reports instead of silently no-op-ing forever (the fix for BL-404, where a live memory-server process reported `role:'test'`). The fallback role is genuinely detected: `'test'` under `NODE_ENV=test` or a live `VITEST_WORKER_ID`, `'harness'` otherwise. | `dist/runtime.js:84-90, 239-280`; asserted by `src/bl404-default-role-and-warning.spec.ts:44-102` |
| `log.debug/info/warn/error(event, fields)` | Stable envelope (`ts, level, event, service, role, trace_id, pid`) + caller fields → JSONL. `trace_id` resolves from an explicit field, else ambient AsyncLocalStorage, else null. Wrapped in try/catch so a logging fault never breaks the caller. | `dist/runtime.js:249-286` |
| `DurableJsonlSink` | `writeSync` per record by default (measured **0-of-10,000 lost on SIGKILL** vs fire-and-forget). Rotates on date change and 20MB; retains 7 files per component. Its retention-prune regex is anchored on the **full** `<component>-<ISO-date>.jsonl` shape rather than a bare prefix — closing a bug where component `memory-core` deleted `memory-core-live`'s files. `plannedPath()` answers "where will the next write land" **distinctly in the type system** from a null "no sink configured" — collapsing those two was the BL-433/319/347 absent-field ambiguity. | `dist/sink.js:80-291`, regex at `:267`, `:118-130` |
| `declareStages` / `StageCatalog.withContendedStage` | A package declares its named stages and entering code paths **once**. `withContendedStage(stage, path, admit, work)` is the **only** way to instrument a contended resource: `admit()` measures wait, `work()` measures compute, and **both** `sox.stage.wait_ms` and `sox.stage.work_ms` are always emitted as a pair — there is no function that records only one. `stage`/`path` are typed against the catalog, so an undeclared stage name at a call site is a **compile error** — closing the defect class where an instrument silently wired to only one of two sibling paths reads identically to no instrument. | `dist/stages.js:25-131` |
| `telemetrySelfCheck()` | Per stage: `wait_ms`/`work_ms` `{count,mean,min,max}`, plus **`unaccounted`** (started − finished − error) per code path — an explicit **upper bound** on hung operations, not a verdict (a killed process is indistinguishable from a hang by this method). Also `stages_with_zero_samples`/`paths_with_zero_samples` so an unwired sibling path is a machine-readable finding rather than a silent zero, plus `otel.state` and `metric_persistence`. | `dist/runtime.d.ts:125-176`; `dist/runtime.js:343-398` |
| `withSpan()` / opt-in real OpenTelemetry | `withSpan(name, attrs, fn)` is a real OTel span if the SDK is up, else `fn` plus one no-op allocation — the **facade-only dependency shape** means merely importing this package never pays the SDK cost. The SDK is reached only via a dynamic `import()` inside `initTelemetry()`, defaults ON for `live-service`/`cli` and OFF for `test`/`harness` because bring-up measured **91.5ms / 23.6MB RSS** against SDK 2.10.0 (the docstring flags this as 5× slower / 1.7× heavier than an earlier measurement — the facade rule got *more* load-bearing, not less). Uses a custom `JsonlSpanProcessor` whose `onStart` fires **before** the span body runs — structurally impossible for a plain `SpanExporter` — plus a pull-only `MeterProvider` with zero timers/handles. `otelReady()` reports pending/ready/failed rather than leaving a caller to infer status from silence. | `dist/otel-types.d.ts`; `dist/otel.js:44-97, 182-286`; `dist/runtime.js:120-190` |
| `snapshotMetrics()` | One durable `metrics.snapshot` JSONL record (own rotation component, `.metrics-snapshot` suffix, so pruning it cannot collide with the event stream it must outlive). Triggered every N records (default 1000, `SOX_TRACE_SNAPSHOT_EVERY`) — **bounded by work done, not wall clock**, so an idle process snapshots nothing and holds no handle — plus opportunistically on each self-check pull and on `close()`. An unref'd interval fires **only** if `SOX_TRACE_SNAPSHOT_MS` is explicitly set. | `dist/runtime.js:399-545` |
| `withTimedEvent()` / `instrumentBoundary()` | `withTimedEvent` logs `${event}.start` **synchronously before** `fn()` runs (so a hang is durably visible with zero extra code), then `.finish`+`duration_ms` or `.error`+`duration_ms`+message (rethrown unchanged). `instrumentBoundary(obj,{component,methods})` Proxy-wraps named methods — **including ones added later by someone who never heard of telemetry** — with every other property a transparent pass-through correctly bound so `this` is never the proxy. | `dist/index.js:82-121` |
| `trace.ts` | ulid-based `newTraceId()` (sortable, monotonic within process), `currentTraceId()`/`traceIdOrNew()`, `withTrace(id, fn)`/`runWithNewTrace(fn)` propagating across awaits. **Exactly one AsyncLocalStorage for the whole process** (migrated out of memory-core) so two per-package ALS instances cannot silently fail to see each other's context. | `dist/trace.{d.ts,js}` |
| `truncateForLog(s, maxLen=500)` | Bounds a value for safe logging, returning a `…[+Nb truncated]` marker stating exactly how much was cut. | `dist/index.js:72-75` |

**⚠ DOC-GAP — none found, and one notable absence:** the registry `package.json` carries **no `sox` metadata block at all** (recorded explicitly so nobody reads its absence as a fetch error). Everything else checked — exports, deps, `InitTelemetryOptions`/`TelemetrySelfCheck` shapes, sink rotation/pruning, OTel cost figures — matched between source docstrings, compiled dist, and the packed tarball with no discrepancy. **Real in-repo consumers already exist:** `sox-store-adapter` and `sox-memory-core` both depend on it, with a dedicated migration commit (`c81c0b75`).

---

## §3 · Cross-package doc-vs-artifact index

The single most reusable finding of this survey: **the `sox` metadata block in `package.json` and the shipped `README.md` are two different documents with two different failure modes, and neither is reliable alone.**

| Package | `sox` metadata block | Shipped README |
|---|---|---|
| embedding-provider | ✅ **honest** — explicitly flags role-ignored and warmUp-is-a-no-op | ❌ claims hash provider, working role encoding, warmUp cache |
| vector-store | ⚠ unversioned prose, identical across 0.3.3 and 0.4.0 — **cannot** be used to infer what changed | ❌ stale "ambient-declaration skeleton" paragraph |
| graph-store | ⚠ accurate for what it claims, but **omits the entire 0.6.0 open-schema/TypePolicy change** | ❌ omits the same; links a monorepo-relative path meaningless in a tarball |
| store-adapter | ❌ still describes the 5-concern 0.1.0 package; omits integrity, migration, dialects, guards — the **bulk** of it | (not surveyed for this) |
| hybrid-search | ❌ describes the **superseded pre-0.3.0 two-step** filter mechanism | ❌ stale skeleton paragraph; concerns list has drifted out of sync with the `sox` block in the same tarball |
| ingest | ❌ omits the entire chunking subsystem (6 of 8 dist modules) | ❌ "private, never published"; "sentence-scoring" summary |
| analysis | ❌ MinHash, hdbscanjs, "buildAutoLinks incremental", "runBatchEnrich incremental" — 4 false claims | ❌ stale skeleton paragraph, cites a `libs/memory-enrich` that does not exist |
| memory-core | ✅ `sox.sidecars` verified real | (dist-only publish; header docstrings verified accurate, incl. a self-retraction) |
| telemetry | ⚪ **absent entirely** | ✅ no discrepancy found |

**The stale "Interface spec" paragraph** — *"src/index.ts is a compileable ambient-declaration skeleton; implementation is extracted from libs/memory-core / libs/memory-enrich by the memory-refactor plan"* — appears verbatim in **at least four** published READMEs (vector-store, hybrid-search, analysis, embedding-provider). It is false in all four; every one ships a complete implementation. `libs/memory-enrich` does not exist anywhere in the sox tree. Treat that sentence as a reliable marker of an un-maintained README.

**Two false claims are still live in artifacts a consumer reads first** and correspond to backlog items already closed in this repo: `AMA-001` (hash provider) and `SOX-DOC-003` (role encoding). See §1 C-5.

---

## §4 · Raw material for the four backlog-intelligence outcomes

**This section points at what exists. It designs nothing.** Where nothing covers an outcome, the gap is named rather than filled.

### (a) Semantic / natural-language search over a task corpus

**Directly applicable, already shipped:**
- `@adhd/sox-hybrid-search` — `SqliteSearchBackend(vec, graph).search()` is a complete BM25+vector hybrid, already composed over exactly the two backends `@adhd/backlog` would have. Normalize-before-fuse with multiplicative weights (`dist/index.js:24-120`); `fuseWithBreakdown()` for per-channel explainability (`:138-197`); unconditional `degraded.unsupportedFilters` so an unmappable filter is visible rather than silent (`:428-441`).
- **Filtered semantic search** — `buildFilterClause()` → `VecFilter.nodeFilter` → SQL JOIN pushdown in `SqliteVectorBackend` (`vector-store dist/index.js:99-131`). Filters candidates *before* scoring, so top-k is exact among matching rows, with no `SQLITE_LIMIT_VARIABLE_NUMBER` ceiling. **SQLite backend only** — see §1 C-3.
- **Reranking** — `createCrossEncoder()` is a real MS-MARCO MiniLM ONNX cross-encoder (`hybrid-search dist/cross-encoder.js`), routed through the shared ONNX worker thread. Exported and working, but **not wired into `search()`** — a caller composes it.
- **Embeddings** — `createEmbeddingProvider({type:'fastembed'})`, default `bge-base-en-v1.5` 768-dim, L2-normalized (cosine ≡ dot). Note `codexembed-400m` (1024-dim, 8192-token, code-focused) exists for a code corpus.
- **A working reference implementation of the whole pipeline** — `sox-memory-core`'s `memoryRecall` (`src/recall.ts:1-49, 297-309`): RRF k=60 with per-channel weights, three parallel channels, per-query min-max, recency×importance rerank, depth-1 graph expansion, token-budget assembly, and a 3s read-path embed timeout that degrades to BM25-only instead of hanging.

**Gaps / hazards:**
- `CrossEncoderRerankerConfig` (`mode`/`maxCandidates`/`gateThreshold`) is an **exported type with zero runtime references** — the reranking *policy* is unimplemented in every sox package. A consumer must implement gating itself.
- `search()` became **async** between 0.3.0 and 0.3.1; `SqliteVectorBackend.knn()` remains **sync**. Mixed sync/async seams across the same "search" surface.
- `SqliteVectorBackend.knn()` is **genuine brute force** (SELECT every row, score in JS) — not `sqlite-vec`'s ANN `MATCH`. Fine at backlog scale, but it is not what "vector index" implies. `LanceDbVectorBackend` has real HNSW/IVF-PQ, but drops `nodeFilter` (C-3), so **ANN and filtering are mutually exclusive today**.
- `embedSingle(text, 'query')` — the role argument is **discarded**. There is no asymmetric query-vs-document encoding anywhere in the family.

### (b) Proactive duplicate detection at filing time

**Directly applicable, already shipped:**
- `@adhd/sox-analysis`'s `detectNearDupPairs(vecs, opts?)` (`dist/index.js:60-87`) — pairwise cosine with a **tri-state** result (`near_dup ≥0.95` / `candidate` / `distinct <0.70`). The middle `candidate` band is exactly a "worth showing the filer, not worth blocking on" tier.
- `detectNearDup(vec, graph, opts?)` (`:838-870`) — the DB-integrated form, writing a `SAME_AS` edge weighted by cosine. ⚠ It writes for **both** `near_dup` and `candidate`, so the persisted edge set is more permissive than the name implies.
- `@adhd/sox-graph-store`'s **content-hash dedup** on `writeNode` (exact-match tier) and `searchNodes()` FTS5 (lexical tier) — the two tiers `@adhd/backlog` already uses.
- `@adhd/sox-ingest`'s `ingest().contentHash` — SHA-256 over **trim + collapse-whitespace** normalized content, i.e. a whitespace-insensitive exact-dup key. ⚠ The separately-exported `hexSha256()` does **no** normalization (`dist/core.d.ts:21-32`); using the wrong one silently changes dedup semantics.
- `sox-memory-core`'s `near-duplicates.ts` + `supersession-chain.ts` — a shipped read surface for surfacing `SAME_AS` pairs and walking a bidirectional SUPERSEDES chain.
- `sox-store-adapter`'s `buildMatchQuery` (BL-367) — normalizes FTS5's bareword-AND vs Tantivy's bareword-OR to identical **any-term-OR** semantics.

**Directly relevant local evidence:** `BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001` — the current FTS deduper false-positive-*blocked* creation on weak token overlap with an unrelated long document, with no relevance threshold. `FEAT-BACKLOG-011` itself had to be filed with `force:true` for this reason. Note that hybrid-search's fusion produces a *normalized, thresholdable* score, which the raw FTS path does not.

**Gaps:**
- **Nothing in the family scores "is this a duplicate" as a decision** — `detectNearDupPairs` gives a cosine band, and hybrid-search gives a fused rank. A blocking/advisory policy (and the false-positive tolerance that item demands) exists nowhere upstream.
- Near-dup detection is **O(n²) over the whole vector set** (`dist/index.js:60-87`). There is no "compare one new item against the corpus" entry point — a filing-time check would call `knn()` instead, which is a different code path with no near-dup thresholds attached.
- `@adhd/sox-claim-verification` (NLI entailment) exists in the family but was **not surveyed**; `RAG-SPEC.md:126` already argues it does not fit backlog citations. Unverified either way.

### (c) Grouping or clustering related items

**Directly applicable, already shipped:**
- `@adhd/sox-analysis`'s `cluster(vecs, opts?)` — DBSCAN via real `density-clustering@1.3.0` over cosine (`threshold` 0.75 → epsilon, `minClusterSize` 2 → minPts).
- `clusterStore()` / `clusterSubset(filter)` (`dist/index.js:747-837`) — the persisting forms: writes a `community-<id>` / `subset-community-<id>` node plus `MEMBER_OF` edges per member, tagged with `modelId`. `clusterSubset` takes a `NodeFilter`, so "cluster only this repo / this tag" is a first-class call.
- `buildAutoLinks()` — pairwise-cosine `RELATES_TO` writer, threshold 0.80, `maxLinksPerNode` 5. ⚠ **Not incremental and not idempotent** — see §2.7; repeated calls keep adding edges.
- `sox-memory-core`'s `cluster.ts` — a **byte-reproducible** variant: sorted rowids, community UID = `sha256(sorted rowids).slice(0,32)`, label from centroid-nearest member, singletons suppressed, and a degenerate-cluster guard (if the largest cluster exceeds 50% of the corpus, retry at threshold+0.05, ≤3×). Deterministic, no LLM, no network.
- `community-gc.ts` (**NEW in memory-core 0.6.0**) — invalidating a member also invalidates its `MEMBER_OF` edge and any now-empty community, in the same transaction. Directly answers "what happens to a cluster when items get resolved," which otherwise silently decays.
- **DAG/scheduling primitives** for turning clusters into work packages: `topoSort` (Kahn's, with wave numbers, over any caller adjacency), `criticalPath`, `detectCycles` (returns **all** cycles), `detectDAGStructure`, and `packBatches` — a genuinely complete bin-packer (exact bitmask-DP ≤20 items, tree-DP / simulated annealing ≤50, HLFET beyond) with a **submodular** batch cost that de-duplicates shared resource keys before summing.

**Gaps:**
- **No graph-topology community detection** — `cluster()` is DBSCAN over *embeddings*, not Louvain/Leiden over the *edge graph*. Clustering by "these items cite each other" is not covered.
- **No PageRank / eigenvector centrality.** `scoreImportance` is a bounded degree-centrality + recency + near-dup-penalty heuristic. (`RAG-SPEC.md:89` already flagged this; re-confirmed.)
- `buildAutoLinks`'s `dryRun` suppresses the write but the function still surfaces **no candidate list** to the caller (`RAG-SPEC.md` §5.5 — re-confirmed against 0.1.5's unchanged dist). "Show me what would be linked" is not answerable today.
- Clustering **requires embeddings for every item**, so (c) is gated on (a)'s substrate being populated and back-filled.

### (d) Relating items by the FILES they touch

**Directly applicable, already shipped:**
- `@adhd/sox-analysis`'s **`setOverlapMatrix(items, valueFn?)`** (`dist/index.js:726-745`) — pairwise Set intersection over items' string-key arrays, returning the intersecting keys plus a `bytes` sum per pair. A `filesTouched` array **is** exactly the string-key array this takes. This is the closest thing in the family to a purpose-built answer. ⚠ **The advertised MinHash optimization for |S|>500 does not exist** — it is a plain O(items² × |keys|) nested loop with no size switch (§1 / §2.7 doc-gap 1). At backlog scale that is likely fine; at repo-history scale it is not, and the doc will mislead whoever assumes otherwise.
- `packBatches`'s **submodular** batch cost — shared `resourceCost(key)` values are deduplicated by resource key before summing. If `key` is a file path, "two items touching the same file cost less together than apart" is already the model. This is the mechanism for the write-collision problem `FEAT-BACKLOG-011` describes (intersecting `filesTouched` across 27 work packages by hand).
- `@adhd/sox-graph-store`'s open-schema `TypePolicy` (**NEW in 0.6.0**) — a file could now be modelled as a first-class node kind with `TOUCHES` edges, without patching upstream SQL `CHECK` constraints. At 0.5.3 that required an upstream change (this is exactly the `BL-295` "extensible node.kind" precondition `AMA-D6-FLIP` item 4 asked for — it has landed). ⚠ `DEFAULT_TYPE_POLICY` is still the closed 6-kind/10-rel vocabulary, so a custom policy must be **injected explicitly**; it is not open by default.
- `@adhd/sox-ingest`'s **`AstChunker`** (`dist/ast-chunker.js`) — real tree-sitter (ts/python/java/csharp), declaration-boundary-respecting, losslessly partitioning, with per-chunk line spans. If "which items touch this *function*" is ever wanted rather than "this *file*", this is the only symbol-aware chunker in the family. (`RAG-SPEC.md:127` dismissed ingest as "Not used" before this outcome was a goal — see §1 C-11.)
- Graph traversal for transitive relation: `getNeighbors`/`getNeighborsWithEdges`/`isReachable`/`getSubgraph`, depth-bounded or unbounded (`depth:-1`), deduped for `direction:'both'` (`graph-store dist/index.js:973-1171`).

**Gaps — this is the thinnest of the four:**
- **Nothing in the family extracts `filesTouched` from anything.** Every capability above assumes the file list already exists as data on the item. Neither `sox-ingest` nor any other package parses a diff, a citation block, or a git log into a file set. That extraction is entirely unbuilt.
- **No file/path-aware similarity** — `setOverlapMatrix` treats keys as opaque strings, so `src/store/query.ts` and `src/store/mutate.ts` share nothing. Directory-prefix, path-distance, or module-level affinity is not modelled anywhere.
- **No git integration of any kind** in any sox package — no blame, no co-change history, no churn. "These two items touch files that historically change together" has no upstream support.
- `setOverlapMatrix` is a **pure function with no persistence and no graph integration** — unlike `detectNearDup`/`clusterStore`, there is no `…Store()` variant that writes overlap back as edges. Persisting file-overlap relations is caller work.

### Cross-cutting operational notes for any of the four

- **Embedding is not free and not synchronous.** `sox-memory-core`'s two-phase write (`src/write.ts`, `src/embed-pipeline.ts:1-50`) exists because ONNX inference on the write-queue thread caused real MCP client timeouts at queue depth 29. Any filing-time embed must land **after** commit, never inside a `BEGIN IMMEDIATE` callback.
- **A second live fastembed host changes embed latency 25–50×** (cross-process ANE contention) — the `competing_host_pid` telemetry signal (**NEW**, embedding-provider 0.2.0) exists specifically to make that visible. A backlog server and an agent-mcp server both embedding is exactly that scenario.
- **Live-observed p50 embed duration of ~25 minutes** during a saturation incident is what motivated memory-core's 3s read-path timeout (`src/recall.ts:59-119`). Any synchronous filing-time dedup check needs an equivalent bound.
- **Coordinated shutdown is now available** — `terminateEmbedWorkers()` (memory-core) and the graceful IPC `__shutdown` path (embedding-provider BL-405). Short-lived CLI processes are covered by `refForPending()`/`unrefIfIdle()` (BL-410).
- **Telemetry is available and already load-bearing upstream** — `@adhd/sox-telemetry`'s `withContendedStage` makes wait-vs-work separable, and its typed stage catalog makes an unwired sibling path a **compile error**, not a silent zero.

---

## §5 · Coverage limits of this catalog

- **Three family packages were not surveyed:** `@adhd/sox-task-queue`, `@adhd/sox-blob-store`, `@adhd/sox-claim-verification`. All three are named in `RAG-SPEC.md` §2 and/or `AMA-009`; `sox-claim-verification` is additionally a live consumer of embedding-provider's shared ONNX worker (per `dist/sharedOnnxWorker.d.ts`), so it is **not** dormant. `FEAT-BACKLOG-011`'s instruction was to "enumerate what is actually published" — that enumeration is incomplete until these three are packed and read.
- **Per-package scope was strict.** Each package was catalogued from its own artifact; cross-package claims were verified only at the call site. E.g. vector-store's `reembed()` was confirmed never to forward `role`, independently of what embedding-provider does with `role` once received.
- **`sox-analysis`'s two runtime deps moved (vector-store 0.4.0, graph-store 0.6.0) while its own dist did not change at all.** Any behaviour drift its consumers see comes from those packages' internals, not from analysis.
- **`sox-memory-core` was catalogued at export-surface depth**, going deep only on the areas the survey flagged as previously-wrong plus everything new since 0.5.0. It has 53 dist modules; this is not an exhaustive read.
- **Process note for future parallel surveys:** the shared session scratchpad showed concurrent writes between sibling subagents doing `npm pack` into the same path (one agent's extracted directory disappeared mid-run). Scratchpad directories are **not** safely shareable across concurrent agents doing tarball extraction — use a uniquely-named subdirectory per agent.

---

## §6 · Provenance

Read-only throughout. No repo file was modified, nothing was installed into the `adhd` workspace, and no destructive command was run. Verification methods used, in descending order of strength:

1. **Live execution against the unpacked published dist** (sox-ingest: all 4 chunkers + `ingest()` with real inputs and both `require()` directions; sox-graph-store: a full write/read/supersede/invalidate/search smoke test against real `better-sqlite3` via real `@adhd/sox-store-adapter@0.3.0`, exit 0, plus a real ESM import attempt that returned `ERR_PACKAGE_PATH_NOT_EXPORTED`).
2. **A/B `diff` of the current published tarball against the prior published tarball** — the basis for every `NEW` / `CHANGED` / `PREEXISTING` determination in this document. Byte-level, per file.
3. **Full reads of `dist/*.js` and `dist/*.d.ts`** from `npm pack`-ed tarballs.
4. **Cross-check against the workspace source** at `/Users/nix/dev/ai/sox-ecosystem` (clean tree), confirming no source↔published drift for every package where it was checked.
5. `npm view <pkg> --json` for versions, publish timestamps, dependency sets, and the `sox` metadata block — **the metadata block always treated as a claim to verify, never as evidence.**

Backlog items read for §1: `AMA-001`, `AMA-004`, `AMA-009`, `AMA-010`, `AMA-018`, `AMA-021`, `AMA-D6-FLIP`, `SOX-DOC-003`, `DEBT-SOX-001`, `FEAT-BACKLOG-011`, `FEAT-BACKLOG-RAG-ADOPT-FILTERED-KNN-001`, `BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001`. Repo files read for §1: `entrypoint/backlog/package.json`, `entrypoint/backlog/src/store/graph-backlog-store.ts`, `entrypoint/backlog/RAG-SPEC.md`, `node_modules/@adhd/sox-graph-store/dist/index.d.ts`.
