# `@adhd/backlog` — Plugin Architecture & Embedding Service

**Date:** 2026-08-08
**Status:** The shipped design of the plugin host, the `embedding-remote` plugin, and the sox embedding bundle. Targets `@adhd/sox-graph-store` 0.6.0 / `@adhd/sox-store-adapter` (Turso) / `@adhd/sox-embedding-provider` 0.2.0 / `@adhd/sox-service-proxy`.

---

## 1. Why a plugin host

`@adhd/backlog` is a host that mounts plugin-provided capabilities. The pattern is taken from apigen, which already runs as a host mounting plugin-provided capabilities: a plugin is a plain capability object registered in a static registry and/or loaded dynamically; config flows as a validated opts bag; the host injects runtime context explicitly. This keeps backlog's store code transport-agnostic — the store only ever sees an interface, never the transport.

The first plugin is the embedding capability: backlog hooks into a **sox-owned embedding service** over UDS JSON-RPC. Sox owns the embedding daemon; backlog is a client.

## 2. The plugin seam — `src/plugins/`

### 2.1 `types.ts`

```typescript
import type { EmbeddingProvider, EmbeddingHealth } from '@adhd/sox-embedding-provider';
import type { Environment } from '@adhd/environment';
import type { BacklogConfig } from '../env.js';
import type { Logger } from 'pino';

export interface BacklogPluginContext {
  logger?: Logger; // pino, stderr-only — never stdout (MCP channel stays clean)
  env: Environment<BacklogConfig>;
}

export interface EmbeddingCapability<Opts = Record<string, unknown>> {
  /** Build the provider. Host has already validated opts against optionsSchema. */
  createProvider(opts: Opts, ctx: BacklogPluginContext): Promise<EmbeddingProvider>;
  /** Truthful backend health — surfaced by backlog_admin({ action: 'embedding_health' }). */
  health?(opts: Opts, ctx: BacklogPluginContext): Promise<EmbeddingHealth>;
}

export interface BacklogPlugin<Opts = Record<string, unknown>> {
  id: string; // 'embedding-remote' | package specifier
  description?: string;
  optionsSchema?: Record<string, unknown>; // host-validated before createProvider
  capabilities: {
    embedding?: EmbeddingCapability<Opts>;
    // Future capability slots are added when a real consumer exists.
  };
}
```

### 2.2 Registry + loader — `registry.ts`

Built-in plugins are statically imported into a registry map keyed by id. Dynamic discovery loads a plugin from a package specifier or local path via `import()`, accepting a module whose default/named export is a `BacklogPlugin` (a module with no plugin export throws). The host validates `options` against `optionsSchema` before calling any capability.

Backlog does **not** adopt a general hook-registry loop — one `embedding` capability slot exists today; future capabilities get slots when a real second consumer exists. Third-party plugin packaging/versioning is out of scope (first-party only).

## 3. The embedding-remote plugin

### 3.1 Provider — `src/plugins/embedding-remote/provider.ts`

`RemoteEmbeddingProvider` implements `@adhd/sox-embedding-provider`'s `EmbeddingProvider` interface (`embedSingle`, `embedBatch`, `warmUp`, `health`, `metadata`). Zero coupling to backlog business logic.

```typescript
export interface RemoteEmbeddingConfig {
  socketPath: string; // UDS path (backendSocketPath(socketDir, singletonKey))
  singletonKey: string; // '(embedding-server, model)' — shared with the service
  model?: string; // default 'bge-base-en-v1.5'
  dim?: number; // default 768 — must equal modelInfo().dimensions
  spawn?: { command: string; args: string[]; env?: NodeJS.ProcessEnv; stderrLogPath?: string };
  backoff?: BackoffOptions; // dialBackend re-dial bounds
}
export function createRemoteEmbeddingProvider(cfg: RemoteEmbeddingConfig, ctx?: BacklogPluginContext): Promise<EmbeddingProvider>;
```

Construction: `ensureBackend` (probe-then-spawn, O_EXCL singleton spawn-lock — many consumer processes collapse to ONE daemon) then `dialBackend` (re-dial + fast-fail on backend-down). If the backend cannot be resolved, construction throws `ResolutionError` — **a healthy provider is never reported without a resolved backend**.

- `embedSingle` / `embedBatch`: RPC `embed` / `embedBatch` → `Float32Array`. A backend-down error response maps to `TransientEmbeddingError` (the embed pipeline defers to backfill). A returned vector whose length ≠ `metadata.dimensions` (768) throws `PermanentEmbeddingError` — the dimensional contract is structural, never silently truncated.
- `metadata`: resolved from the service's `modelInfo` RPC — **never from config**. Before the first successful `modelInfo`, `metadata` is unavailable and `health()` reports `uninitialized` / `error` — never `real`.
- `health()`: maps the service's `health` RPC; an unreachable backend → `{ active: null, state: 'error', last_error }`. Truthful at all times: never `real` with `active: null`.

### 3.2 The plugin object — `src/plugins/embedding-remote/index.ts`

Exports the `BacklogPlugin` with `id: 'embedding-remote'`, `optionsSchema`, and `capabilities.embedding = { createProvider, health }`.

## 4. Store wiring — `openGraphBacklogStore`

```typescript
export async function openGraphBacklogStore(dbPath: string, opts?: { embedding?: { plugin: string; options?: Record<string, unknown> } }): Promise<GraphBacklogStore>;
```

- Substrate: `createStoreAdapter({ dbPath })` (defaults to `turso`), `createGraphBackend(adapter)` (0.6.0), vector via `createVectorDialect(adapter.config.type)` → `TursoVectorDialect` — `F32_BLOB(dim)` columns, index via `CREATE INDEX` (DiskANN inferred), `vector_distance_cos/l2/dot`, and a `topKQuery` that emits a `WHERE` filter seam for predicate pushdown.
- `opts.embedding`: host resolves the plugin id via the registry, validates `options`, calls `capabilities.embedding.createProvider(options, ctx)`. Backlog never owns an in-process embedding provider — the embedding capability is always a plugin.
- Absent `opts.embedding`: `store.embedding` stays `undefined`; semantic operations throw `RagNotConfiguredError`; `listItems({ grep })` stays FTS-only — keyword retrieval never regresses.
- `GraphBacklogStore` gains `flushEmbeds(): Promise<void>` and the embed pipeline (`src/store/embed-pipeline.ts`) keeps a per-store tracked in-flight set (drain-until-empty), plus `closeGraphBacklogStore` becoming async and draining before close.

## 5. Embed pipeline — `src/store/embed-pipeline.ts`

`scheduleEmbed(store, nodeId, content)`, `flushEmbeds()`, tracked in-flight `Set<Promise>`. Shape copied from `sox-memory-core`'s embed pipeline.

- **Phase A**: the item CAS commits (never an embed inside the write transaction).
- **Phase B**: after commit, embed via `store.embedding.provider.embedSingle(content, 'document')` and upsert into the vector table — its own small transaction, not the CAS primitive.
- **Ordering rule**: `scheduleEmbed` is never called from inside the mutation updater — always after the transaction committed.
- **Provenance**: the `embed_model` stamp is written in the same transaction as the vector upsert, using **`provider.metadata.modelId` resolved from the service's `modelInfo`** — never a config default, never a pre-initialised value (a stamp that can be written before a provider resolves is unfalsifiable and is not accepted).
- **Re-embed on edit**: `updateItem` schedules a re-embed on title/body change; the vector upsert is idempotent per `(nodeId, modelId)`.
- **Failures**: never throw into the caller; a failed embed degrades that item's semantic results and is repaired by the backfill sweep. A backend-down (`TransientEmbeddingError`) defers to backfill.
- **Durability for short-lived processes**: `CreateItemInput` / `UpdateItemInput` gain `awaitEmbed?: boolean` (default false); a one-shot process must pass `awaitEmbed: true` or call `flushEmbeds()` / await `closeGraphBacklogStore` before exit — the drain is what guarantees the vector landed.

## 6. The sox embedding service (bundle member)

- **Location:** `extensions/bundles/sox-embedding-bundle/members/embedding-server/` (mirrors the memory-server bundle layout).
- **Manifest:** `extension.json` — `type: "service"`, `lifecycle: { background: true, singleton: true, health: { type: "uds-ping" }, serve_mode: "proxy", schema_path: "dist/schema.json" }`. `config_schema`: `model` (default `bge-base-en-v1.5`), `socket_path` (data-root-derived), `permissions.socket.paths`.
- **Backend:** `serveBackend({ socketPath, handler })` wrapping `createEmbeddingProvider({ type: 'fastembed', model })`. The service owns the shared fastembed child singleton — the daemon, not each consumer, supervises the ONNX child.
- **Singleton key:** `(embedding-server, model)` — all consumers collapse to ONE ONNX process per model per host.
- **JSON-RPC contract** (published to `dist/schema.json`):
  - `embed { text, role? }` → `{ vector, model, dim }`
  - `embedBatch { texts, role?, batchSize? }` → `{ vectors, model, dim }`
  - `health` → `EmbeddingHealth`
  - `modelInfo` → `{ modelId, dimensions, maxTokens, isRemote, providerUri }` — the provenance source
  - `warmup { texts? }` → `{}` (resolves when warm; cache-hit/cache-miss budgets)
- Vectors travel as compact blobs in the RPC payloads, not verbose number arrays — the payload stays ~4 KB per 768-dim vector.

## 7. memory-server

The embedding service is a sox-owned shared daemon. memory-server may adopt it as a client via the same UDS dial path, behind an opt-in configuration flag; the in-process fastembed path remains the default until adoption is proven. The shared implementation lives in `@adhd/sox-embedding-provider` itself as a provider type routing through the UDS client, so backlog's plugin and memory-server share one implementation through the existing factory. Consequence: `terminateEmbedWorkers()` becomes a no-op for the shared child (the service owns it); per-record `embed_model` stamps keep mixed-model stores correct; the stamp site is fixed to stamp from `modelInfo`.

## 8. Interface surface

The RAG operations land inside the existing 6-tool surface, not beside it:

- Read side → `backlog_query` views: `semanticSearch` → `view: "similar"` + `sort: "relevance"` (+ `filter.semantic`); plan-graph ops are compositions of `view: "plan"` / `view: "order"` (`criticalPath`, `blockerImpact`, `planReadiness`, `recommendNextWork`).
- Write/ops side → `backlog_admin` actions: `run_dedup_sweep`, `cluster_into_plans` / `promote_cluster_to_plan`, `backfill_embeddings`, `list_near_duplicates`. Plus `embedding_health`. (snake_case throughout — the admin action union is one documented vocabulary, SPEC.md §6.6.)
- The `backlog_admin.action` union is versioned and documented; the growth rule — if the union approaches ~25 actions, split a `backlog_system` tool — keeps the "6 tools" claim honest.

## 9. Test cases (real Turso adapter + real fastembed, default-running, negative controls)

1. **Plugin registry/discovery** — builtin `embedding-remote` resolves by slug; a fixture plugin at a local path loads via dynamic `import()`; a module with no plugin export throws.
2. **RemoteEmbeddingProvider against a REAL backend process** — spawn a test backend (`serveBackend` + real fastembed provider), `ensureBackend` + `dialBackend`, `embedSingle` → `Float32Array` length 768 with non-zero values; `modelInfo` dims match. Negative control: 384-dim config → `PermanentEmbeddingError` (dimensional contract enforced).
3. **Degrade** — no backend on the socket: `embedSingle` → `TransientEmbeddingError`; `health()` → `state: 'error'`; store without `opts.embedding` → `semanticSearch` throws `RagNotConfiguredError` while `listItems({ grep })` still returns FTS hits.
4. **Health truthfulness** — `uninitialized` / `error` until first successful `modelInfo`; never `real` with `active: null`. Negative control: a backend reporting `real` with `active: null` is rejected by the client.
5. **Integration: createItem → embed → durability** — `createItem({ awaitEmbed: true })`; reopen a fresh store on the same file; assert the vector is non-null AND the `embed_model` stamp equals the resolved `modelInfo` modelId. Negative control: bypass the drain, vector is null.
6. **Semantic recall** — 5 items; paraphrased query ranks the match top-3. Negative control: zero the vector weight, the match drops out.
7. **`nx build backlog` + `nx run backlog:verify-dist-load`** green (native deps actually load).

## 10. Boundaries

- No in-process embedding path for backlog (the embedding capability is always a plugin — the service owns the model).
- No general plugin framework, no third-party plugin packaging/versioning.
- memory-server adopting the shared embedding service is opt-in and non-breaking; its implementation is a separate sox-ecosystem item.
- The service's OS-unit supervision / doctor integration is the sox team's implementation surface; this spec defines the bundle shape and RPC contract.
