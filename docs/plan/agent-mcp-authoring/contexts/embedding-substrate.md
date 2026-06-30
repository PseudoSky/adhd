# embedding-substrate — deterministic embedding via @adhd/sox-embedding-provider + seeded use-case anchors

**Phase:** enrichment · **Kind:** work · **Depends on:** authoring-design · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts`

---

## Goal

`@adhd/agent-registry` configures and exposes the embedding substrate by
consuming `@adhd/sox-embedding-provider` and `@adhd/sox-vector-store` (FEAT-008
consumable). A deterministic `EmbeddingProvider` (config `type: 'hash'`) is the
default for CI/reproducibility; `type: 'fastembed'` (ONNX local, bge-base-en-v1.5
768d) is available for real semantic ranking. Both are resolved through the
published `createEmbeddingProvider(config)` factory with no in-package embedding
code. A `cosine(a,b)` helper and a seeded use-case anchor set
(`enrich/usecase-anchors.ts`) give `component_search` and the enrichment pipeline
a target to resolve against. The substrate is exported from `src/index.ts` for
the agent-mcp discovery/authoring lanes to consume.

**This replaces the original plan of building a custom hashed-n-gram embedding
in-package.** The sox-ecosystem already ships a deterministic hash provider
(SHA-256 seeded Box-Muller, config `type:'hash'`) that produces L2-normalized
vectors at configurable dimensions, plus a real ONNX provider
(`type:'fastembed'`) isolated in a worker thread. No new embedding code is
written in `@adhd/agent-registry` — only a thin `EmbeddingProvider` wrapper and
the use-case anchor seed data.

---

## Interface design

```
┌──────────────────────────────────────────────────────┐
│  @adhd/sox-embedding-provider   (published dep)      │
│  createEmbeddingProvider(config) → EmbeddingProvider  │
│    embedSingle(text, role?) → Float32Array            │
│    embedBatch(texts) → AsyncIterable<Float32Array>    │
│    metadata: { modelId, dimensions, isDeterministic } │
├──────────────────────────────────────────────────────┤
│  type: 'hash'   → DeterministicProvider (CI default)  │
│  type: 'fastembed' → FastembedProvider (ONNX worker)  │
│  type: 'remote' → RemoteProvider (API adapter)        │
└──────────────────────┬───────────────────────────────┘
                       │ consumed by
┌──────────────────────▼───────────────────────────────┐
│  @adhd/agent-registry  src/enrich/embedding.ts        │
│  createRegistryEmbedder(dim?) → EmbeddingProvider     │
│    wraps createEmbeddingProvider with registry cfg    │
│    + cache layer for idempotent re-embed             │
│                                                       │
│  src/enrich/usecase-anchors.ts                        │
│    seed anchor set (name+description → vector)        │
│    seeded once at bootstrap                           │
│                                                       │
│  cosine(a, b) → number  (pure util)                   │
└──────────────────────────────────────────────────────┘
```

### Module: `@adhd/agent-registry/src/enrich/embedding.ts`

```ts
import { createEmbeddingProvider,
         type EmbeddingProvider,
         type EmbeddingProviderConfig } from '@adhd/sox-embedding-provider';

export function createRegistryEmbedder(
  config?: Partial<EmbeddingProviderConfig>,
): EmbeddingProvider;
```

- Default config: `{ type: 'hash', model: 'hash-768', options: { dimensions: 768 } }`
  — deterministic, zero deps at runtime, passes in CI.
- Optional override via env `ADHD_EMBED_PROVIDER` (JSON string) or explicit call.
- Wraps `createEmbeddingProvider` with a content-hash cache so identical input
  never recomputes (idempotent re-define support).

### Module: `@adhd/agent-registry/src/enrich/usecase-anchors.ts`

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

### Module: `@adhd/agent-registry/src/enrich/cosine.ts`

```ts
export function cosine(a: Float32Array, b: Float32Array): number;
```

- Pure function, exported for the enrichment pipeline and discovery tools.

### Vector storage via `@adhd/sox-vector-store`

Use-case anchors and component embeddings are persisted via `@adhd/sox-vector-store`:

```ts
import { openVectorStore, type VectorBackend } from '@adhd/sox-vector-store';

const vecDb = openVectorStore('path/to/vectors.db', { dim: 768, modelId: 'hash-768' });
vecDb.upsert(componentRowId, embedding, space);
const results = vecDb.knn(queryEmbedding, space, k);
```

- One `VectorSpace` per model (`hash-768`, `bge-base-en-v1.5`).
- `knn()` returns `{id, score}[]` with cosine similarity scores.
- `reembed()` for cross-model migration when upgrading from hash to real ONNX.

---

## Acceptance criteria

- [embedding-substrate.1] deterministic `createRegistryEmbedder()` returns a provider matching config; `embedSingle` is deterministic across process restarts; cosine ranks a use-case anchor match above an unrelated one
- [embedding-substrate.2] seedAnchors produces N anchors from seed data; re-running on seeded store is no-op; anchors survive store reopen
- [embedding-substrate.3] vector-store integration: seeded anchor embeddings stored via @adhd/sox-vector-store; knn query returns seeded anchors ranked by cosine similarity

---

## Reservations

```text
read_only:  []
mutates:    [
  "packages/ai/agent-registry/package.json",
  "packages/ai/agent-registry/src/enrich/embedding.ts",
  "packages/ai/agent-registry/src/enrich/usecase-anchors.ts",
  "packages/ai/agent-registry/src/enrich/cosine.ts",
  "packages/ai/agent-registry/src/index.ts",
  "packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts"
]
```

---

## Notes for executor

- **Consume, don't build.** Do NOT write any embedding math. Import
  `@adhd/sox-embedding-provider` and configure it. The only new code is the
  registry wrapper (config resolution + cache) and the seed data.
- **Publishing prerequisite.** `@adhd/sox-embedding-provider` and
  `@adhd/sox-vector-store` are NOT on npm — see `_shared.md` § sox-ecosystem
  dependency for the publish/link approach. Add them to
  `@adhd/agent-registry/package.json` as workspace or version deps.
- **Determinism is load-bearing downstream.** Idempotent re-define
  (`inv:enrichment-deterministic`) reduces to: same content → identical vector →
  identical use-case links → no index churn. Gate idempotence on a content hash
  so identical input never recomputes/rewrites.
- **Anchors are seeded once at bootstrap**, from each use-case's name+description
  — not recomputed per query. The query side embeds at call time and compares
  against these fixed anchors via `knn()`.
- **Cross-plan anchor provenance (explicit linkage to Plan 7).** This plan ships a
  small fixed SEED set of use-case anchors — enough for the discovery/composition
  proofs to run on fixtures. **Plan 7 (`agent-registry-migration`) BACKFILLS the
  real corpus-derived anchors**: its sonnet-consolidation state produces the
  canonical use-case vocabulary, and the dataset-build state writes those use-cases
  (with anchor embeddings via THIS substrate) into the registry. So the enrichment
  seam is identical; only the anchor SET grows from seed → corpus when Plan 7
  runs. Keep the seed set minimal and clearly marked as seed (not corpus) so Plan
  7's backfill is additive, not a conflicting rewrite.
- **Additive only** (`inv:additive-registry`): new files under `src/enrich/` + an
  index export. Do not disturb the Plans 1–5 store vocabulary or their green audits.
- **`sqlite-vec` is a transitive dep** through `@adhd/sox-vector-store`. This is
  acceptable — the vector store is already published and tested in the sox-ecosystem.
  The registry package remains `platform:shared` since `better-sqlite3` and
  `sqlite-vec` are already deps of the registry store.
