# `@adhd/backlog` — The Embedding Seam

**Date:** 2026-09-22
**Status:** Describes the SHIPPED semantic seam.

> **Historical note (retired design).** An earlier revision of this document
> specified a general plugin host — `src/plugins/` (`types.ts`, `registry.ts`),
> an `embedding-remote` plugin, an `embed-pipeline.ts`, and a `flushEmbeds()`
> drain. **None of that shipped**: there is no `src/plugins/` tree in this
> package (never was, on any branch), no `embedding-remote` plugin, no
> `embed-pipeline.ts`, and no store-level embed drain. The shipped path is a
> single lazy, per-adapter bootstrap (`write/bootstrap.ts`). This document now
> describes what exists today.

---

## 1. What ships: one lazy, per-adapter bootstrap

`embedding.enabled` is off by default (`env.ts`, §3). When it is on, the ONLY
constructor of the real embedding stack is `write/bootstrap.ts`'s
`bootstrapSemanticStoreMembers(adapter, graph, cfg, log)`.

- It takes the store's already-open `StoreAdapter`/`GraphBackend` pair — never a
  store wrapper — and returns `{ search?, embedding? }`.
- It loads `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` through a
  **non-literal dynamic `import()`** (`loadOptional`), so neither
  `optionalDependency` is required at build time; a build without them still
  compiles and runs (the default, unconfigured path).
- It is **memoized per `StoreAdapter`** (`membersCache`, a `WeakMap`), and only
  a successful, member-ful result is retained — a member-less result or a
  rejected derive is evicted, so the next semantic verb retries instead of
  latching a transient failure for the adapter/process lifetime.

### 1.1 The two members

`embedding: IEmbeddingBackend` (write side):

- `modelId` — the resolved model id.
- `embedDocument(content)` → `Float32Array`.
- `upsertVector(rowid, vec)` — keyed on the graph node's **rowid**, not its uid.
- `deleteVector(rowid)`.

`search` (read side):

- `backend: StoreSearchBackend` (`@adhd/sox-hybrid-search`).
- `embedQuery(text)` → `Float32Array`.
- `spacePopulated()` → a **bounded** `hasVectors` probe (`SELECT 1 … LIMIT 1`),
  per-query truth read from the durable vector table — never a process-lifetime
  latch (BUG e19bc9d0).

Both members are OPTIONAL. Absence is the only honest degrade (BUG-045): never a
stub whose methods run but return empty/wrong results. `scanForDuplicates`
reports "scan unavailable" (zero candidates, the write proceeds) and
`filter.semantic` / `view:"similar"` report as unconfigured when a member is
absent.

### 1.2 The dimension contract is structural

`bootstrap.ts` checks every vector's length against the resolved space's
dimension and throws `PermanentEmbeddingDimensionError` on mismatch — a
permanent, non-retryable fault, never a silent truncate/pad.

## 2. Where the members are consumed

- **`api.ts` — `ensureSemanticReady`** is the sole call site of
  `bootstrapSemanticStoreMembers`. `writeHandle`/`queryHandle` call it only
  under their `needsSemantic` gate, so a plain `claim`/`transition`/`query`
  never pays the cold model load (SPEC.md §5b).
- **Write side — `write/embedding-observer.ts`'s `scheduleIssueEmbedding`** runs
  the post-commit embed/delete round-trip against `handle.embedding`, writes its
  own `embedding_upserted`/`embedding_deleted`/`embedding_failed` audit row in a
  follow-up `immediate` transaction, and never throws into the caller.
  `awaitEmbed: true` awaits the returned promise before the verb returns; the
  default is fire-and-forget.
- **Read side — `query/query.ts` / `query/views/semantic.ts`**: `filter.semantic`,
  `view:"similar"`, and `sort:"relevance"` consult `handle.search`. A bare
  `text:` query resolves `search.spacePopulated()` once per query and snapshots
  it onto the handle, because `resolveTextInput` is synchronous.

## 3. Configuration (`env.ts`)

| key                   | type    | default             | meaning                                                             |
| --------------------- | ------- | ------------------- | ------------------------------------------------------------------- |
| `embedding.enabled`   | boolean | `false`             | opt-in; off is completely silent (no package load, no store touch). |
| `embedding.provider`  | string  | `'fastembed'`       | the provider `type` passed to `createEmbeddingProvider`.            |
| `embedding.model`     | string  | `'bge-base-en-v1.5'`| the provider `model`.                                               |

`enabled: false` is the zero-config default: the semantic members are absent and
every semantic input answers a typed "not configured" error. An enabled-but-
unreachable provider logs and yields absent members — it never fails a write.

## 4. The provider (`@adhd/sox-embedding-provider`)

Backlog constructs the provider the config names, directly:
`createEmbeddingProvider({ type, model })` → `EmbeddingProvider` (an
`optionalDependency`). The provider's own `metadata` (`modelId`, `dimensions`,
`maxTokens`, `isRemote`, `providerUri`) is the provenance source — never config
(`embed_model` is stamped from `provider.metadata.modelId`). `isRemote`
distinguishes an in-process fastembed provider from one that routes to a shared
service; that transport is entirely the provider package's concern and invisible
to backlog. The provider's inference (in-process ONNX, or a remote round-trip)
runs strictly after the subject transaction commits, off the write lock.

## 5. Boundaries

- **No plugin host.** There is no `src/plugins/`, no plugin registry, no
  `embedding-remote` plugin. The seam is the bootstrap function.
- **No embedding daemon owned by backlog.** The default provider is in-process
  fastembed; a remote/service-backed provider type is a provider-package
  concern, selected by `embedding.provider`.
- **No store-level embed drain.** There is no `flushEmbeds()` and no
  `embed-pipeline.ts`; the durability guarantee is the per-write `awaitEmbed`.
- memory-server adopting a shared embedding service is an ecosystem concern,
  separate from backlog.
