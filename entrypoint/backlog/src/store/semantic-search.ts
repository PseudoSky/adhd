/**
 * semantic-search.ts — P4 opt-in RAG scaffolding (AC-12).
 *
 * `@adhd/backlog` has zero HARD dependency on an embedding/vector substrate
 * — the default, unconfigured build answers every semantic input
 * (`filter.semantic`, `filter.anchor`, `view:"similar"`, `sort:"relevance"`,
 * `fields:["_vector"]`) with `RagNotConfiguredError` (AC-12), never a
 * silently-wrong keyword substitute. This module is the SEAM that lets a
 * host opt a real backend IN without backlog ever requiring one:
 *
 * 1. {@link SemanticBackend} — the small interface `v2/query.ts`/`v2/get.ts`
 *    consult. Fully injectable (`configureSemanticBackend`) so tests can
 *    prove the "configured" code paths deterministically with a FAKE
 *    backend — no model download, no native module, no network.
 * 2. {@link bootstrapSemanticBackend} — the REAL backend, built from
 *    `@adhd/sox-vector-store` + `@adhd/sox-embedding-provider`
 *    (`optionalDependencies` in package.json — never installed unless a host
 *    opts in). Both are loaded via `await import()` inside try/catch: a
 *    build with neither package installed (the default) degrades to `null`
 *    rather than crashing at import time, exactly like an unconfigured
 *    build today.
 *
 * Nothing in this module runs at import time — `configureSemanticBackend`
 * is never called automatically, and `bootstrapSemanticBackend` is never
 * invoked implicitly. A host (`cli.ts`/`server.ts`) that wants the real
 * backend calls it explicitly during startup, exactly like it explicitly
 * builds `BacklogCtx` today. This is the "scaffolding" P4 asks for, not a
 * production ranking pipeline: it is deliberately the smallest seam that
 * makes the configured path real, injectable, and testable, and the
 * unconfigured default (`RagNotConfiguredError`) is untouched.
 */
import type { NodeFilter } from '@adhd/sox-graph-store';
import type { GraphBacklogStore } from './graph-backlog-store.js';

/** One nearest-neighbour hit: a node id (never a humanId — the caller resolves that) plus a similarity score, higher-is-better. */
export interface SemanticMatch {
  nodeId: number;
  score: number;
}

/**
 * The minimal surface `v2/query.ts` (`view:"similar"`, `sort:"relevance"`)
 * and `v2/get.ts` (`fields:["_vector"]`) need from a configured embedding
 * backend. Intentionally NOT the full `@adhd/sox-vector-store`/
 * `@adhd/sox-embedding-provider` APIs — this is the narrow slice backlog
 * actually calls, so a test double only has to implement four methods to
 * stand in for the real thing.
 */
export interface SemanticBackend {
  readonly modelId: string;
  readonly dim: number;
  /** Embeds free text (a `filter.semantic`/text query) for a KNN lookup. */
  embedQuery(text: string): Promise<Float32Array>;
  /** The already-indexed vector for a live node, or `null` if this node has never been embedded (`admin(embedding_backfill)` has not covered it yet). */
  vectorFor(nodeId: number): Float32Array | null;
  /** Top-`k` nearest neighbours to `query`, optionally scoped by `filter` (repo/family/etc — the same `NodeFilter` shape the rest of the store uses) or restricted to an explicit candidate `ids` set. */
  knn(query: Float32Array, k: number, opts?: { filter?: NodeFilter; ids?: number[] }): SemanticMatch[];
}

let injectedBackend: SemanticBackend | null = null;

/** Installs (or clears, with `null`) the backend `v2/query.ts`/`v2/get.ts` consult. Never called automatically — see this file's header. */
export function configureSemanticBackend(backend: SemanticBackend | null): void {
  injectedBackend = backend;
}

/** The currently-configured backend, or `null` if none is (the default, unconfigured build). */
export function getSemanticBackend(): SemanticBackend | null {
  return injectedBackend;
}

/** `true` iff a backend is configured — the single predicate every AC-12 gate in `v2/query.ts`/`v2/get.ts` checks before falling back to `RagNotConfiguredError`. */
export function isSemanticSearchConfigured(): boolean {
  return injectedBackend !== null;
}

export interface SemanticBootstrapConfig {
  /** Embedding provider config, forwarded verbatim to `@adhd/sox-embedding-provider`'s `createEmbeddingProvider()` (e.g. `{ type: 'fastembed', model: 'bge-small-en-v1.5' }`). */
  embedding: { type: string; model: string; options?: Record<string, unknown> };
  /** Overrides the vector space's `{modelId, dim}` — defaults to the embedding provider's own `metadata` once it is constructed. */
  space?: { modelId: string; dim: number };
}

// Structural mirrors of the slices of `@adhd/sox-vector-store` /
// `@adhd/sox-embedding-provider`'s real published APIs this module calls
// (verified against their real `.d.ts` — `openVectorStore`,
// `VectorBackend.ensureSpace/knn/get`, `createEmbeddingProvider`,
// `EmbeddingProvider.metadata/embedSingle`). Declared locally, NOT imported
// as types, so this file has ZERO compile-time dependency on either package
// — see the module-loading comment below for why that matters.
interface OptEmbeddingProvider {
  readonly metadata: { modelId: string; dimensions: number };
  embedSingle(text: string, role?: 'document' | 'query'): Promise<Float32Array>;
}
interface OptVecFilter {
  ids?: number[];
  nodeFilter?: NodeFilter;
}
interface OptVectorBackend {
  ensureSpace(space: { modelId: string; dim: number }): void;
  get(id: number, modelId: string): Float32Array | null;
  knn(query: Float32Array, space: { modelId: string; dim: number }, k: number, filter?: OptVecFilter): Array<{ id: number; score: number }>;
}
interface OptVectorStoreModule {
  openVectorStore(adapterOrPath: unknown, opts: { dim: number; modelId: string }): OptVectorBackend;
}
interface OptEmbeddingModule {
  createEmbeddingProvider(config: { type: string; model: string; options?: Record<string, unknown> }): Promise<OptEmbeddingProvider>;
}

/**
 * Loads an optional package by name via a NON-LITERAL specifier.
 *
 * `@adhd/sox-vector-store`/`@adhd/sox-embedding-provider` are
 * `optionalDependencies` (package.json) — a `backlog` install may not have
 * either one present, and this package must still build and run correctly
 * without them (the default, unconfigured path). A literal
 * `import('@adhd/sox-vector-store')` would defeat that: TypeScript resolves
 * a literal dynamic-import specifier at compile time (fails the build if the
 * package's types are not installed) AND the bundler (vite/rollup) tries to
 * statically resolve and inline it at BUILD time too — both would break a
 * `backlog` build in an environment that never installed the optional
 * packages. Routing the specifier through a `const` defeats both static
 * analyses (a long-standing, deliberate technique for a genuinely optional
 * `require`/`import` in bundled code) — resolution happens only at RUNTIME,
 * inside this function's own try/catch.
 */
async function loadOptional<T>(specifier: string): Promise<T | null> {
  try {
    const dynamicSpecifier = specifier;
    return (await import(/* @vite-ignore */ dynamicSpecifier)) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort construction of a REAL {@link SemanticBackend} from
 * `@adhd/sox-vector-store` (vectors, stored in `store`'s own adapter) +
 * `@adhd/sox-embedding-provider` (text→vector). Both are
 * `optionalDependencies` — loaded via {@link loadOptional}, so a build with
 * neither installed returns `null` rather than throwing (the caller's
 * `RagNotConfiguredError` default degrade stays intact). A failure to
 * actually CONSTRUCT the provider (bad config, model resolution failure)
 * also returns `null` rather than crashing startup — the whole point of
 * "opt-in" is that a broken/absent embedding stack can never take down the
 * rest of `backlog`, which works perfectly well without it.
 *
 * Never called automatically (see this file's header) — a host that wants
 * the real backend calls this explicitly and then
 * `configureSemanticBackend(await bootstrapSemanticBackend(...))`.
 */
export async function bootstrapSemanticBackend(store: GraphBacklogStore, config: SemanticBootstrapConfig): Promise<SemanticBackend | null> {
  const [vectorStoreMod, embeddingMod] = await Promise.all([
    loadOptional<OptVectorStoreModule>('@adhd/sox-vector-store'),
    loadOptional<OptEmbeddingModule>('@adhd/sox-embedding-provider'),
  ]);
  if (vectorStoreMod === null || embeddingMod === null) {
    // Neither (or one) of the optional deps is installed — the default,
    // unconfigured build. Not an error: `RagNotConfiguredError` is exactly
    // the correct behaviour for every semantic input from here on.
    return null;
  }

  try {
    const provider = await embeddingMod.createEmbeddingProvider(config.embedding);
    const space = config.space ?? { modelId: provider.metadata.modelId, dim: provider.metadata.dimensions };
    const vectorBackend = vectorStoreMod.openVectorStore(store.adapter, { dim: space.dim, modelId: space.modelId });
    vectorBackend.ensureSpace(space);

    const backend: SemanticBackend = {
      modelId: space.modelId,
      dim: space.dim,
      async embedQuery(text: string): Promise<Float32Array> {
        return provider.embedSingle(text, 'query');
      },
      vectorFor(nodeId: number): Float32Array | null {
        return vectorBackend.get(nodeId, space.modelId);
      },
      knn(query: Float32Array, k: number, opts?: { filter?: NodeFilter; ids?: number[] }): SemanticMatch[] {
        const vecFilter: OptVecFilter | undefined =
          opts?.filter !== undefined || opts?.ids !== undefined
            ? { ...(opts.ids !== undefined ? { ids: opts.ids } : {}), ...(opts.filter !== undefined ? { nodeFilter: opts.filter } : {}) }
            : undefined;
        return vectorBackend.knn(query, space, k, vecFilter).map((m) => ({ nodeId: m.id, score: m.score }));
      },
    };
    return backend;
  } catch {
    // Provider/vector-store construction failed (bad config, model
    // resolution, etc.) — degrade to "not configured" rather than crash.
    return null;
  }
}
