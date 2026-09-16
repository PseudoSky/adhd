/**
 * bootstrap.ts — the store-bootstrap module `write/tx.ts`'s own
 * `IWriteStoreHandle.embedding` doc comment ("Constructed once at store-open
 * time — out of scope for this slice — see the store-bootstrap file...") and
 * `test/helpers/open-test-issue-store.ts`'s header both anticipated and left
 * explicitly out of scope: deriving the `search`/`embedding` handle members
 * every write/query verb needs from an already-open store.
 *
 * Before this module existed, `api.ts`'s `writeHandle`/`queryHandle` returned
 * only `{adapter, typePolicy}`/`{graph}` — so `create-issue.ts`'s duplicate
 * gate (`scanForDuplicates`) always scanned zero candidates and
 * `embedding-observer.ts`'s `scheduleIssueEmbedding` was always a silent
 * no-op in production, even with `embedding.enabled: true`. Both features
 * were proven only in tests that hand-built their own handle. This module
 * closes that gap for real hosts (`cli.ts`/`server.ts` via `api.ts`).
 *
 * ## Deliberately NOT built on `store/semantic-search.ts`
 *
 * `store/semantic-search.ts` is on the deletion list for an imminent hard
 * cutover — it is coupled at the TYPE level to types outside this data model
 * and cannot survive it: `bootstrapSemanticBackend`'s own signature takes
 * `GraphBacklogStore`, and the module imports `RagNotConfiguredError` from
 * `../model.js` — neither type is part of this data model. So this module
 * takes its dependencies the SAME way `test/helpers/open-test-issue-store.ts` and this package's own
 * `IWriteStoreHandle`/`IQueryStoreHandle` already do — the bare
 * `StoreAdapter`/`GraphBackend` pair, never a store wrapper — and re-homes
 * the REAL embedding-model construction logic (`createEmbeddingProvider` +
 * `openTursoVectorStore`, the same two calls `bootstrapSemanticBackend` made)
 * directly here, rather than reimplementing it from scratch. Two things are
 * deliberately NOT carried over:
 *
 * 1. **The module-level singleton registry**
 *    (`configureSemanticBackend`/`getSemanticBackend`). This layer passes
 *    handles explicitly (`IWriteStoreHandle.embedding`,
 *    `IQueryStoreHandle.search`) — a hidden global is exactly what let the
 *    production/test divergence this module fixes go unnoticed.
 * 2. **`RagNotConfiguredError`** (`model.ts`, also on the deletion list).
 *    `deriveMembers` below never throws a "not configured" error — an
 *    unavailable model degrades to an ABSENT member (see
 *    {@link SemanticStoreMembers}'s own doc comment), which is how
 *    `create-issue.ts`/`query/query.ts` already report "unconfigured" today.
 *    The one error this module DOES throw —
 *    {@link PermanentEmbeddingDimensionError} — is a genuine structural fault
 *    (a resolved model whose vector length doesn't match the space it was
 *    built for), not an availability signal, so it is defined locally rather
 *    than imported from the dying module.
 */
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import { openTursoVectorStore, type AsyncVectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend } from '@adhd/sox-graph-store';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { BacklogConfig } from '../env.js';
import type { IEmbeddingBackend } from './tx.js';

/**
 * The two handle members `api.ts`'s `writeHandle`/`queryHandle` need, in the
 * exact shapes their consumers require:
 *  - `search` matches `query/query.ts`'s `IQueryStoreHandle['search']`
 *    (mandatory `embedQuery`) — a strict subset that also satisfies
 *    `write/create-issue.ts`'s `IDuplicateScanHandle['search']` (optional
 *    `embedQuery`), since a mandatory field trivially satisfies an optional
 *    one.
 *  - `embedding` matches `write/tx.ts`'s `IWriteStoreHandle['embedding']`
 *    (`IEmbeddingBackend`) exactly.
 *
 * Both are OPTIONAL and, per BUG-045's binding rule (quoted in `api.ts`'s
 * former `queryHandle` comment), absence is the only honest degrade: never a
 * stub whose methods run but return empty/wrong results. `deriveMembers`
 * below returns `{}` — both members absent — whenever the real embedding
 * model genuinely cannot be reached, so `scanForDuplicates` reports "scan
 * unavailable" (zero candidates, write proceeds) and `filter.semantic`/
 * `view:'similar'` throw `InvalidArgumentError('semantic', ...)` exactly as
 * they did before this module existed — never a silently-empty "search".
 */
export interface SemanticStoreMembers {
  readonly search?: {
    readonly backend: StoreSearchBackend;
    embedQuery(text: string): Promise<Float32Array>;
  };
  readonly embedding?: IEmbeddingBackend;
}

/**
 * §2.5 (RAG-SPEC.md, carried over from `store/semantic-search.ts`'s own
 * identically-named class) — a returned vector whose dimension does not
 * match the resolved model. Permanent and non-retryable by construction: the
 * dimensional contract is structural (the vector column's type encodes it),
 * so a mismatch means the provider is not the model the space was built for.
 * Truncating or padding to fit would produce plausible-looking, permanently
 * wrong neighbours — so this throws instead. Defined locally (not imported)
 * because the module it came from is on the deletion list — see this file's
 * header comment.
 */
export class PermanentEmbeddingDimensionError extends Error {
  constructor(
    readonly operation: string,
    readonly modelId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `backlog embedding: ${operation} produced a ${actual}-dimensional vector but space "${modelId}" is ${expected}-dimensional. ` +
        `The dimensional contract is structural and is never silently truncated — the configured provider does not match this vector space.`,
    );
    this.name = 'PermanentEmbeddingDimensionError';
  }
}

// Structural mirrors of the slices of `@adhd/sox-embedding-provider` this
// module calls. Declared locally, NOT imported as types, so this module has
// ZERO compile-time dependency on that optional package — see `loadOptional`'s
// own doc comment for why.
interface OptEmbeddingProvider {
  readonly metadata: { modelId: string; dimensions: number };
  embedSingle(text: string, role?: 'document' | 'query'): Promise<Float32Array>;
}
interface OptEmbeddingModule {
  createEmbeddingProvider(config: { type: string; model: string; options?: Record<string, unknown> }): Promise<OptEmbeddingProvider>;
}

/**
 * Loads an optional package by name via a NON-LITERAL specifier.
 *
 * `@adhd/sox-vector-store`/`@adhd/sox-embedding-provider` are
 * `optionalDependencies` — a `backlog` install may not have either one, and
 * this package must still build and run correctly without them (the default,
 * unconfigured path). A literal `import('@adhd/sox-embedding-provider')`
 * would defeat that: TypeScript resolves a literal dynamic-import specifier
 * at compile time (failing the build when the types are absent) AND the
 * bundler (vite/rollup) tries to statically resolve and inline it at BUILD
 * time too. Routing the specifier through a `const` defeats both static
 * analyses, so resolution happens only at RUNTIME, inside this function's
 * try/catch. (Carried over verbatim from `store/semantic-search.ts`'s own
 * `loadOptional`, which documents the same rationale.)
 */
async function loadOptional<T>(specifier: string): Promise<{ mod: T } | { err: unknown }> {
  try {
    const dynamicSpecifier = specifier;
    return { mod: (await import(/* @vite-ignore */ dynamicSpecifier)) as T };
  } catch (err) {
    return { err };
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Per-adapter memoization. `writeHandle`/`queryHandle` (`api.ts`) call this
 * function fresh on EVERY verb invocation — the bootstrap itself (resolving
 * the embedding provider, e.g. cold ONNX init for fastembed; opening the
 * Turso vector space) is expensive enough that repeating it per call would
 * be a severe, silent perf regression. `StoreAdapter` is a stable, long-lived
 * object for the life of an open store (one instance per process in
 * production, one per test) — the same object `IWriteStoreHandle.adapter`
 * already carries — so keying on it, rather than on `BacklogCtx` or
 * `BacklogConfig` (neither object-stable across calls), is the correct cache
 * key. A `WeakMap` never blocks a closed/discarded adapter (in tests) from
 * being garbage-collected.
 */
const membersCache = new WeakMap<StoreAdapter, Promise<SemanticStoreMembers>>();

/**
 * Derives the `search`/`embedding` members for a store's already-open
 * `adapter`/`graph` pair, memoized per `adapter` instance. `cfg` is
 * `BacklogConfig['embedding']` (`env.ts`) — the caller passes
 * `ctx.env.config.embedding` verbatim.
 *
 * @param log where a failed opt-in is reported (never thrown — mirrors
 *   `store/semantic-search.ts`'s own former `enableSemanticSearchFromConfig`
 *   "best-effort, never fatal" contract). Defaults to `console.error`; a host
 *   with a structured logger should pass its own sink.
 */
export async function bootstrapSemanticStoreMembers(
  adapter: StoreAdapter,
  graph: GraphBackend,
  cfg: BacklogConfig['embedding'],
  log: (message: string) => void = (m) => console.error(m),
): Promise<SemanticStoreMembers> {
  const cached = membersCache.get(adapter);
  if (cached) return cached;
  const pending = deriveMembers(adapter, graph, cfg, log);
  membersCache.set(adapter, pending);
  return pending;
}

async function deriveMembers(
  adapter: StoreAdapter,
  graph: GraphBackend,
  cfg: BacklogConfig['embedding'],
  log: (message: string) => void,
): Promise<SemanticStoreMembers> {
  // RAG-SPEC.md §1.6: disabled is the default and is completely silent — no
  // package load, no store touch, no log line. Mirrors
  // `enableSemanticSearchFromConfig`'s own point 1.
  // `cfg` itself is optional, not just `cfg.enabled`: a config with no
  // `embedding` block at all is the ZERO-CONFIG default, and it reaches here
  // as `undefined`. Dereferencing it threw a TypeError that `api.ts` could
  // only classify as `internal` -- so a perfectly valid store with no
  // embedding configured failed EVERY write and query verb with "the server
  // blew up". Absent config means the semantic members are absent, which is
  // exactly what an empty bag of members already expresses.
  if (!cfg?.enabled) return {};

  // The vector table lives in backlog's own database, reached through the
  // SAME adapter the graph uses. `nativeVectors` is the blessed capability
  // probe: true => Turso, whose vector support this async seam serves;
  // false => a substrate this seam does not serve. Refuse loudly (log,
  // absent members) rather than half-work.
  if (adapter.capabilities.nativeVectors !== true) {
    log(
      `backlog: embedding.enabled is set but this store's adapter does not report capabilities.nativeVectors ` +
        `(got ${JSON.stringify(adapter.capabilities.nativeVectors)}) — backlog's RAG layer requires a Turso-backed store. ` +
        `create()'s duplicate gate and query()'s/view:"similar"'s semantic filters will report as unconfigured.`,
    );
    return {};
  }

  const [vectorStoreLoad, embeddingLoad] = await Promise.all([
    loadOptional<{ openTursoVectorStore: typeof openTursoVectorStore }>('@adhd/sox-vector-store'),
    loadOptional<OptEmbeddingModule>('@adhd/sox-embedding-provider'),
  ]);
  if ('err' in vectorStoreLoad || 'err' in embeddingLoad) {
    const missing = [
      ...('err' in vectorStoreLoad ? [`@adhd/sox-vector-store (${errText(vectorStoreLoad.err)})`] : []),
      ...('err' in embeddingLoad ? [`@adhd/sox-embedding-provider (${errText(embeddingLoad.err)})`] : []),
    ];
    // NOT an error: this is the default build (both packages are
    // `optionalDependencies`). Absent members is exactly the correct
    // behaviour from here on.
    log(`backlog: embedding.enabled is set but optional embedding packages are unavailable: ${missing.join('; ')}. Continuing WITHOUT semantic search.`);
    return {};
  }

  let provider: OptEmbeddingProvider;
  try {
    provider = await embeddingLoad.mod.createEmbeddingProvider({ type: cfg.provider, model: cfg.model });
  } catch (err) {
    log(`backlog: embedding.enabled is set but createEmbeddingProvider(${cfg.provider}:${cfg.model}) failed: ${errText(err)}. Continuing WITHOUT semantic search.`);
    return {};
  }

  // §2.4 (RAG-SPEC.md) — provenance comes from the provider's RESOLVED
  // metadata, never from config.
  const space = { modelId: provider.metadata.modelId, dim: provider.metadata.dimensions };

  let vectorBackend: AsyncVectorBackend;
  try {
    vectorBackend = await vectorStoreLoad.mod.openTursoVectorStore(adapter, { dim: space.dim, modelId: space.modelId });
    await vectorBackend.ensureSpace(space);
  } catch (err) {
    log(`backlog: embedding.enabled is set but openTursoVectorStore(dim=${space.dim}, modelId=${space.modelId}) failed: ${errText(err)}. Continuing WITHOUT semantic search.`);
    return {};
  }

  // §2.5 — the dimensional contract is STRUCTURAL, never silently truncated.
  const checkDim = (vec: Float32Array, what: string): Float32Array => {
    if (vec.length !== space.dim) {
      throw new PermanentEmbeddingDimensionError(what, space.modelId, space.dim, vec.length);
    }
    return vec;
  };

  const embedding: IEmbeddingBackend = {
    modelId: space.modelId,
    async embedDocument(content: string): Promise<Float32Array> {
      return checkDim(await provider.embedSingle(content, 'document'), 'embedDocument');
    },
    async upsertVector(nodeRowid: number, vec: Float32Array): Promise<void> {
      await vectorBackend.upsert(nodeRowid, checkDim(vec, 'upsertVector'), space);
    },
    async deleteVector(nodeRowid: number): Promise<void> {
      await vectorBackend.delete(nodeRowid, space.modelId);
    },
  };

  // `StoreSearchBackend` (`@adhd/sox-hybrid-search`) shares the SAME
  // `vectorBackend`/`graph` the embedding member above uses — one vector
  // table, one open handle, never a second connection or a second provider.
  //
  // Deliberately NOT gated on "is the vector space populated yet" (BUG-045's
  // own gate was for the OLD `store/semantic-search.ts` singleton path,
  // whose `SemanticBackend.knn` returned an arbitrary page over an empty
  // space). `StoreSearchBackend.searchRanked`'s vec channel runs a REAL KNN
  // against the REAL (possibly-empty) vector table and truthfully returns
  // zero vector candidates when it holds nothing — never an arbitrary
  // substitute — so withholding `search` here would only break the "no
  // manual indexing step" guarantee: an issue embedded by THIS SAME store's
  // `create()` must be findable by a `query()` call issued moments later
  // against the same memoized members, with the vector space now non-empty.
  const search: SemanticStoreMembers['search'] = {
    backend: new StoreSearchBackend(vectorBackend, graph),
    async embedQuery(text: string): Promise<Float32Array> {
      return checkDim(await provider.embedSingle(text, 'query'), 'embedQuery');
    },
  };

  return { search, embedding };
}
