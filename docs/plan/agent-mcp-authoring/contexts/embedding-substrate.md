# embedding-substrate — real embeddings via @adhd/sox-embedding-provider + seeded use-case anchors

**Phase:** enrichment · **Kind:** work · **Depends on:** authoring-design · **Guard:** `npx --yes nx test agent-store-prompts --testFile=packages/agent/agent-store-prompts/src/__tests__/embedding-substrate.test.ts`

---

## Goal

`@adhd/agent-store-prompts` configures and exposes the embedding substrate by
consuming `@adhd/sox-embedding-provider` and `@adhd/sox-vector-store` (FEAT-008
consumable). The default `EmbeddingProvider` is **`type: 'fastembed'` with model
`bge-base-en-v1.5` (768-dim, real ONNX local embedding)** — resolved through the
published `createEmbeddingProvider(config)` factory with **no in-package embedding
code**. A `cosine(a,b)` helper and a seeded use-case anchor set
(`enrich/usecase-anchors.ts`) give `component_search` and the enrichment pipeline a
target to resolve against. The substrate is exported from `src/index.ts` for the
agent-mcp discovery/authoring lanes to consume.

**This replaces the original plan of building a custom hashed-n-gram embedding
in-package.** The sox-ecosystem already ships the real provider
(`type:'fastembed'`, ONNX in a worker thread) and a remote API adapter
(`type:'remote'`). No new embedding code is written in `@adhd/agent-store-prompts` —
only a thin async `EmbeddingProvider` wrapper, a `cosine` util, and the use-case
anchor seed data.

> **No `type:'hash'` provider exists (AMA-001, D-hash).** `createEmbeddingProvider`'s
> `switch (config.type)` handles `'fastembed'` and `'remote'` ONLY; the `default:`
> branch throws `ResolutionError` ("Unknown embedding provider type", `index.ts:162`).
> The `type:'hash'` / `hash-768` /
> "deterministic hash provider" story in the original plan was written against
> stale `sox.concerns` metadata and is **deleted**. Determinism is provided by
> **content-hash gating** (below), not by the embedder.

---

## Interface design

```
┌───────────────────────────────────────────────────────────┐
│  @adhd/sox-embedding-provider   (published dep)            │
│  createEmbeddingProvider(config): Promise<Provider>        │  ← async
│    embedSingle(text, role?) → Promise<Float32Array>        │  role IGNORED by fastembed
│    embedBatch(texts, {batchSize}) → AsyncIterable<…>       │  DEFAULT_BATCH_SIZE = 256
│    warmUp(texts) → Promise<void>                           │  NO-OP on fastembed
│    health() → {configured,active,state,dimensions,…}       │  active===null until warm
│    metadata: { modelId, dimensions, maxTokens,             │
│                isRemote, isDeterministic }                 │  fastembed: isDeterministic=FALSE
├───────────────────────────────────────────────────────────┤
│  type: 'fastembed' → FastembedProvider (ONNX worker)       │  ← DEFAULT
│  type: 'remote'    → RemoteProvider (requires endpoint)    │
│  (no 'hash' branch — throws ResolutionError)               │
└──────────────────────┬────────────────────────────────────┘
                       │ consumed by
┌──────────────────────▼───────────────────────────────┐
│  @adhd/agent-store-prompts  src/enrich/embedding.ts   │
│  createRegistryEmbedder(cfg?): Promise<Provider>      │  ← async
│    awaits createEmbeddingProvider with registry cfg   │
│                                                       │
│  src/enrich/usecase-anchors.ts                        │
│    seed anchor set (name+description → vector)         │
│    seeded once at bootstrap                            │
│                                                       │
│  cosine(a, b) → number  (pure util)                   │
└──────────────────────────────────────────────────────┘
```

### Module: `@adhd/agent-store-prompts/src/enrich/embedding.ts`

```ts
import { createEmbeddingProvider,
         type EmbeddingProvider,
         type EmbeddingProviderConfig } from '@adhd/sox-embedding-provider';

// ASYNC — createEmbeddingProvider returns a Promise.
export async function createRegistryEmbedder(
  config?: Partial<EmbeddingProviderConfig>,
): Promise<EmbeddingProvider>;
```

- **Default config: `{ type: 'fastembed', model: 'bge-base-en-v1.5' }` → 768-dim.**
  Other fastembed models available: `bge-small-en-v1.5` (384), `multilingual-e5-large`
  (1024), `bge-m3` (1024), `codexembed-400m` (1024). This plan pins `bge-base-en-v1.5`.
  An unknown model id throws `ResolutionError` listing the supported set
  ("Unknown fastembed model", `index.ts:178`).
- Optional override via env `ADHD_EMBED_PROVIDER` (JSON string) or explicit call.
  If overriding to `type:'remote'`, `options.endpoint` is **required** — otherwise
  the factory throws `ResolutionError` ("Remote provider requires an endpoint URL",
  `index.ts:215`). Remote defaults: `model` → `remote-768`, dim → `options.dimensions ?? 768`.
- **CI cost control — there is NO `ModelCache` parameter.** `ModelCache` (`index.ts:125`)
  / `FileSystemModelCache` (`index.ts:144`) are exported but **never used by
  `createEmbeddingProvider` or `FastembedProvider`** (verified by grep) — now marked
  `@deprecated` upstream (SOX-BUG-002). The fastembed factory instead resolves a
  **`cacheDir` string** in this order (cacheDir resolution at `index.ts:184`):
  `config.options.cacheDir` → `process.env.SOX_EMBED_CACHE_DIR` →
  `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models`.
  The worker then calls `FlagEmbedding.init({ model, cacheDir, showDownloadProgress:false })`
  after `fs.mkdirSync(cacheDir, {recursive:true})` (in `embedWorker.ts`), which
  **downloads the ONNX binary on first use**. Pin `SOX_EMBED_CACHE_DIR` (outside the
  repo tree — the default `~/.cache/sox/models` already satisfies the repo's
  "no runtime artifacts in the tree" rule) and pre-warm it in CI.

### Module: `@adhd/agent-store-prompts/src/enrich/usecase-anchors.ts`

```ts
export interface UseCaseAnchor {
  name: string;
  description: string;
  embedding: Float32Array;
}

export function seedAnchors(embedder: EmbeddingProvider): Promise<UseCaseAnchor[]>;
```

- Ships a small fixed SEED set (~10-20 use-cases) at seed time.
- Each anchor embeds `name + " — " + description` once via `embedder.embedSingle()`.
- Seeds are idempotent: re-running on an already-seeded store is a no-op
  (additive insert, skip on name collision).
- The seed set is clearly marked as seed (not corpus) so Plan 7's corpus-derived
  anchor backfill is additive.

### Module: `@adhd/agent-store-prompts/src/enrich/cosine.ts`

```ts
export function cosine(a: Float32Array, b: Float32Array): number;
```

- Pure function, exported for the enrichment pipeline and discovery tools.

### Vector storage via `@adhd/sox-vector-store`

Use-case anchors and component embeddings are persisted via `@adhd/sox-vector-store`:

```ts
import { openVectorStore, reembed, type VectorBackend } from '@adhd/sox-vector-store';

// openVectorStore calls ensureSpace({modelId, dim}) INTERNALLY — no separate call needed.
const vecDb = openVectorStore('path/to/vectors.db', { dim: 768, modelId: 'bge-base-en-v1.5' });
vecDb.upsert(componentRowId, embedding, space);      // method on the backend
const results = vecDb.knn(queryEmbedding, space, k); // method → { id, score }[]
```

- **One `VectorSpace`: `{ modelId: 'bge-base-en-v1.5', dim: 768 }`.** (No second
  `hash-768` space — the two-space story is deleted with `type:'hash'`.)
- `knn`, `upsert`, `ensureSpace`, `iter`, `get`, `delete` are **methods** on the
  `VectorBackend`. `openVectorStore` already calls `ensureSpace` for the space you
  pass, so you do not call it again.
- `reembed(backend, provider, opts)` is a **top-level async export** (not a backend
  method) — for a future cross-model migration if the pinned model ever changes.

---

## Real-provider behaviour (read the source, not the `sox.concerns` metadata)

These are verified against `libs/data/embed/embedding-provider/src/`. They are
load-bearing for how the executor writes the test and the wrapper.

| Behaviour | Fact | Consequence for this state |
|---|---|---|
| **Not deterministic** | `FastembedProvider.metadata.isDeterministic = false`, hard-coded (`fastembed.ts:135`) | Never assert vector equality across runs. Idempotence rides on `ingest().contentHash`, not the vector. |
| **Eager warmup on construct** | `createFastembedProvider` `await`s `provider.embedSingle('warmup')` before returning (warmup wrapper, `index.ts:189-190`) | Constructing the embedder **downloads the model and runs an inference**. Build it ONCE (module scope / `beforeAll`), never per-test. |
| **Single warmup timeout (SOX-BUG-001 fixed)** | One `SOX_EMBED_WARMUP_TIMEOUT_MS` budget, default **180 000 ms**, governs BOTH the factory warmup wrapper and worker-init: `warmupTimeoutMs()` is defined once and exported from `index.ts:235`, imported by `fastembed.ts`. The former inner 60 s limit (`fastembed.ts:102-105`) is **deleted upstream**. | A cold ONNX download must finish inside that single 180 s budget — there is no longer a hidden lower ceiling. Pre-warm the cache; raising `SOX_EMBED_WARMUP_TIMEOUT_MS` raises the one effective limit. |
| **`warmUp()` is a no-op (contract, not a bug)** | Body is `void texts;` — *"No-op: isDeterministic is false, cache would be unreliable"* (`fastembed.ts:224`); **spec-pinned** — `embedding-provider.spec.ts:86` asserts it. | Do not call it expecting a cache to fill. Warming happens implicitly on first embed. Treat the no-op as intended behaviour, not a defect. |
| **`role` is ignored** | `embedSingle(text, _role?)` — parameter unused (`fastembed.ts:158`) | No asymmetric document/query encoding, despite the interface exposing `EmbedRole`. Do not design ranking around it. |
| **Vectors are L2-normalised** | `toFloat32Normalised()` on every path (`fastembed.ts:413`); `meanPool()` re-normalises (`fastembed.ts:266`) | `cosine(a,b)` ≡ dot product. `knn` scores are directly comparable. `cosine.ts` stays a plain dot product but must still guard zero-norm. |
| **Chunk-then-mean-pool, no truncation** | `estimateTokens = ceil(len/4)`; `bge-base-en-v1.5` `maxTokens = 512` → texts over **~2048 chars** are split on whitespace, embedded per chunk (`embedSingle`, `fastembed.ts:158`), mean-pooled (`meanPool`, `fastembed.ts:266`), re-normalised | Real component bodies routinely exceed 2048 chars, so this is the **normal** path, not an edge case. `[embedding-substrate.1]`'s ranking fixture must use realistic-length content, or it proves nothing about production behaviour. |
| **ONNX runs in a worker thread** | `new Worker(workerPath, …)` (`fastembed.ts:296`), then `worker.unref()`. The BL-11 boundary exists so `onnxruntime-node` never shares a thread with `better-sqlite3` + `sqlite-vec`. | `@adhd/agent-store-prompts` uses `better-sqlite3` and is adding `sqlite-vec` — this isolation is exactly why. Never run the model inline. The worker is `unref()`'d and rejects pending promises on non-zero exit: **gate the test on the runner's exit code, never on stdout** (repo rule §6.4). |

**Provider metadata note (SOX-DOC-001..004 fixed upstream).** The provider's
`sox.concerns` metadata no longer advertises a nonexistent hash provider, asymmetric
`role` encoding, or a "warmUp cache", and now documents `DEFAULT_BATCH_SIZE = 256`
(`fastembed.ts:100`). The rule stands regardless: **read the source, not the metadata** —
the facts above are verified against `src/`.

**Network dependency (new, and it is not optional).** With `type:'hash'` gone, the
`embedding-substrate` guard now downloads a ~110M-parameter ONNX model on a cold
cache. Per the repo's *"live testing is mandatory — no silent gating"* rule, this
does **not** qualify for an env-flag gate (it is neither paid nor a third-party
service this system cannot run). It must run by default and **fail loudly** if the
model cannot be fetched — never self-skip. Pre-warm `SOX_EMBED_CACHE_DIR` in CI.

---

## Acceptance criteria

- [embedding-substrate.1] `createRegistryEmbedder()` (async) resolves a provider matching config; `embedSingle` returns a 768-dim vector; cosine ranks a use-case anchor match above an unrelated one
- [embedding-substrate.2] seedAnchors produces N anchors from seed data; re-running on a seeded store is a no-op; anchors survive a store reopen (proven by reopening, not in-memory state)
- [embedding-substrate.3] vector-store integration: seeded anchor embeddings stored via @adhd/sox-vector-store into the single `{modelId:'bge-base-en-v1.5',dim:768}` space; a knn query returns the seeded anchors ranked by cosine similarity (matching anchor first)

---

## Reservations

```text
read_only:  []
mutates:    [
  "packages/agent/agent-store-prompts/package.json",
  "packages/agent/agent-store-prompts/src/enrich/embedding.ts",
  "packages/agent/agent-store-prompts/src/enrich/usecase-anchors.ts",
  "packages/agent/agent-store-prompts/src/enrich/cosine.ts",
  "packages/agent/agent-store-prompts/src/index.ts",
  "packages/agent/agent-store-prompts/src/__tests__/embedding-substrate.test.ts"
]
```

---

## Notes for executor

- **Consume, don't build.** Do NOT write any embedding math. `await` the
  `@adhd/sox-embedding-provider` factory and configure it. The only new code is the
  registry wrapper (config resolution + `cacheDir` selection) and the seed data.
  There is **no cache object to construct** — see the `cacheDir` string resolution
  above; `FileSystemModelCache` is a red herring (exported, never wired in).
- **`createRegistryEmbedder` is async** — it returns `Promise<EmbeddingProvider>`,
  because `createEmbeddingProvider` is async. `seedAnchors` and every call site must
  `await` it. A synchronous wrapper signature is unimplementable.
- **Construct the embedder exactly once.** The factory downloads + warms the model
  before it resolves. A `beforeEach` that builds a provider will re-run warmup per
  test and can exceed the single `SOX_EMBED_WARMUP_TIMEOUT_MS` budget (default 180 s,
  governs both wrapper and worker-init — SOX-BUG-001's inner 60 s limit is gone).
  Build once; share.
- **Publishing prerequisite.** `@adhd/sox-embedding-provider` and
  `@adhd/sox-vector-store` are NOT on npm yet — see `_shared.md` § sox-ecosystem and
  decisions.md §D5 (publish-via-changesets; `pnpm` rewrites `workspace:*` at pack
  time). The `sox-package-publish` human-blocker gates this state.
- **The `.tooth` audit checks are grep-based — a green grep is NOT proof (AMA-017).**
  `embedding-substrate.2.tooth` / `.3.tooth` (in both `criteria.json` and
  `audit_authoring.py`) only assert the test file *mentions* `reopen`/`seedAnchors`/
  `idempotent` and `openVectorStore`/`knn`/`bge-base-en-v1.5`. A vacuous test that names
  those tokens but asserts nothing passes both the shared `nx test` command AND the grep.
  **Per repo rule §6.2 you MUST prove each behavioural assertion FAILS when the fix is
  reverted (negative control):** revert the seed-idempotence short-circuit and confirm the
  reopen assertion goes red; break the knn ranking and confirm the cosine-order assertion
  goes red. Do not treat the passing grep as evidence — it is a declaration mirror, not a
  behaviour proof.
- **Determinism is load-bearing downstream, and it rests on a content hash, not on
  the embedder.** The provider itself **declares** `metadata.isDeterministic === false`
  (`fastembed.ts:135`) — this is not a hedge, it is the provider's own contract.
  `inv:enrichment-deterministic` therefore reduces to: identical content →
  short-circuit **before** any embed/insert/delete → identical use-case links +
  summary → no index churn. Gate on `ingest().contentHash` (see
  `enrichment-pipeline`). A test that asserts two `embedSingle` calls return
  bit-identical vectors is asserting something the provider does not promise; assert
  the *no-churn* observable instead (re-open the store, compare link rows + summary).
- **Anchors are seeded once at bootstrap**, from each use-case's name+description —
  not recomputed per query. The query side embeds at call time and compares against
  these fixed anchors via `knn()`.
- **Cross-plan anchor provenance (linkage to Plan 7).** This plan ships a small fixed
  SEED set of use-case anchors — enough for the discovery/composition proofs to run
  on fixtures. **Plan 7 (`agent-registry-migration`) BACKFILLS the real
  corpus-derived anchors** through THIS substrate. Keep the seed set minimal and
  clearly marked as seed so Plan 7's backfill is additive, not a conflicting rewrite.
- **Additive only** (`inv:additive-registry`): new files under `src/enrich/` + an
  index export. Do not disturb the Plans 1–5 store vocabulary or their green audits.
- **Dependency-weight honesty (AMA-010, D-platform).** `@adhd/agent-store-prompts` is
  **already `platform:node`** (`project.json` → `tags: ["layer:ai","platform:node"]`)
  — do NOT change its tag. But adding `@adhd/sox-embedding-provider` +
  `@adhd/sox-vector-store` is **not** the no-op the old note claimed: the package
  currently declares exactly two deps (`better-sqlite3@12.10.0`,
  `drizzle-orm@0.45.2`) — `sqlite-vec` is NOT already present. Consuming these two
  sox packages introduces **six new native transitive deps**:
  `@huggingface/transformers`, `fastembed`, `@lancedb/lancedb`, `apache-arrow`,
  `synckit`, `sqlite-vec`. That is a real build-time/weight delta (consistent with
  the existing `platform:node` tag, not a purity violation). If that weight is
  unacceptable, isolating the embed substrate behind its own package is the
  alternative — recorded as a rejected-with-reason option in decisions.md §D-platform,
  not silently assumed away.
