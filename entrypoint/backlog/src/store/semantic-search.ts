/**
 * semantic-search.ts — the RAG seam (EPIC-G / RAG-SPEC.md).
 *
 * `@adhd/backlog` has zero HARD dependency on an embedding/vector substrate
 * — the default, unconfigured build answers every semantic input
 * (`filter.semantic`, `filter.anchor`, `view:"similar"`, `sort:"relevance"`,
 * `fields:["_vector"]`, and the six EPIC-G admin actions) with
 * `RagNotConfiguredError` (§5a), never a silently-wrong keyword
 * substitute. This module is the SEAM that lets a host opt a real backend
 * IN without backlog ever requiring one:
 *
 * 1. {@link SemanticBackend} — the small interface the store and the read
 *    layer (`query/query.ts`, `query/get.ts`) consult. Fully injectable
 *    (`configureSemanticBackend`) so tests can prove the "configured" code
 *    paths deterministically with a FAKE backend — no model download, no
 *    native module, no network.
 * 2. {@link bootstrapSemanticBackend} — the REAL backend, built from
 *    `@adhd/sox-vector-store` + `@adhd/sox-embedding-provider`
 *    (`optionalDependencies` — never installed unless a host opts in).
 *
 * ## Why every method is async
 *
 * RAG-SPEC §0: backlog's store is opened through `@adhd/sox-store-adapter`,
 * whose default substrate is **Turso**, and "the entire API is async".
 * `@adhd/sox-vector-store`'s original `VectorBackend` is synchronous and
 * backed by a raw driver handle — it *throws* when handed a Turso adapter,
 * directing the caller elsewhere. The sync interface is bridged for LanceDB by running
 * the driver in a `synckit` worker, but that trick is WRONG here: a worker
 * thread would open a SECOND connection to backlog's own database file
 * rather than reuse the ONE adapter handle through which this process
 * reaches graph, vector, and escape-hatch SQL. That single HANDLE keeps this
 * process's vector writes on the same substrate as its graph writes — it is
 * NOT a one-file-one-writer lock; concurrent writer processes are safe
 * (ADR-0012). So the Turso path is async and in-process, reusing the store's
 * existing adapter
 * (`@adhd/sox-vector-store`'s additive `AsyncVectorBackend`), and this seam
 * — backlog's own interface, not a vendored one — is async to match.
 *
 * Nothing in this module runs at import time — `configureSemanticBackend`
 * is never called automatically, and `bootstrapSemanticBackend` is never
 * invoked implicitly. A host (`cli.ts`/`server.ts`) that wants the real
 * backend calls it explicitly during startup.
 */
import type { NodeFilter } from '@adhd/sox-graph-store';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { RagNotConfiguredError } from '../envelope.js';

/** One nearest-neighbour hit: a node id (the caller resolves it to a uid) plus a similarity score, HIGHER-IS-BETTER. */
export interface SemanticMatch {
  nodeId: number;
  score: number;
}

/**
 * Truthful provider health (RAG-SPEC §1.5: "a provider is never reported
 * healthy without a resolved backend"). Mirrors
 * `@adhd/sox-embedding-provider`'s `EmbeddingHealth`, restated locally so
 * this seam keeps zero compile-time dependency on that package.
 *
 * `active` is `null` until the model has actually resolved — NEVER a
 * placeholder or the configured name echoed back. That distinction is the
 * whole point: a stamp that can be written before a provider resolves is
 * unfalsifiable (§2.4).
 */
export interface SemanticHealth {
  /** What was ASKED for, e.g. `fastembed:bge-base-en-v1.5`. */
  configured: string;
  /** What actually RESOLVED, or `null` while uninitialized/warming/errored. */
  active: string | null;
  state: 'uninitialized' | 'warming' | 'real' | 'error';
  dimensions: number | null;
  last_error: string | null;
  /** Count of vectors currently indexed in this space, when the backend can report it cheaply. */
  indexedCount?: number;
}

/**
 * The surface backlog actually calls on a configured embedding backend.
 * Intentionally NOT the full `@adhd/sox-vector-store` /
 * `@adhd/sox-embedding-provider` APIs — this is the narrow slice, so a test
 * double only has to implement these methods to stand in for the real thing.
 *
 * Every method is async: see this file's header for why.
 */
export interface SemanticBackend {
  /** The RESOLVED model id (§2.4) — the value stamped as `embed_model` provenance. */
  readonly modelId: string;
  /** Vector dimensionality. Structural: a returned vector of any other length is a `PermanentEmbeddingError`, never silently truncated (§2.5). */
  readonly dim: number;
  /** Embeds free text as a QUERY (asymmetric models embed queries and documents differently — bge prefixes queries). */
  embedQuery(text: string): Promise<Float32Array>;
  /** Embeds item text as a DOCUMENT — the write path (§2.1 Phase B). */
  embedDocument(text: string): Promise<Float32Array>;
  /** The indexed vector for a live node, or `null` if it has never been embedded (backfill has not covered it). */
  vectorFor(nodeId: number): Promise<Float32Array | null>;
  /** Idempotent per `(nodeId, modelId)` — a plain overwrite, so re-embed on edit (§2.3) needs no delete-then-insert. */
  upsertVector(nodeId: number, vec: Float32Array): Promise<void>;
  /** Drops a node's vector (soft-delete / prune). Absent vector is a no-op, never an error. */
  deleteVector(nodeId: number): Promise<void>;
  /** Top-`k` nearest neighbours, scoped by `filter` (pushed into SQL BEFORE the limit — never a post-filter, §3.1) or an explicit candidate `ids` set. */
  knn(
    query: Float32Array,
    k: number,
    opts?: { filter?: NodeFilter; ids?: number[] }
  ): Promise<SemanticMatch[]>;
  /** Every indexed vector in this space — the input to `cluster_into_plans` (DBSCAN) and `run_dedup_sweep` (§4, §5). */
  iterVectors(opts?: {
    filter?: NodeFilter;
  }): AsyncIterable<{ nodeId: number; vec: Float32Array }>;
  /** §1.5 — truthful health, resolved from the provider, never echoed from config. */
  health(): Promise<SemanticHealth>;
}

/**
 * §2.5 — a returned vector whose dimension does not match the resolved
 * model. Permanent and non-retryable by construction: the dimensional
 * contract is structural (the vector column's type encodes it), so a
 * mismatch means the provider is not the model the space was built for.
 * Truncating or padding to fit would produce plausible-looking, permanently
 * wrong neighbours — so this throws instead.
 */
export class PermanentEmbeddingDimensionError extends Error {
  constructor(
    readonly operation: string,
    readonly modelId: string,
    readonly expected: number,
    readonly actual: number
  ) {
    super(
      `backlog embedding: ${operation} produced a ${actual}-dimensional vector but space "${modelId}" is ${expected}-dimensional. ` +
        `The dimensional contract is structural and is never silently truncated (RAG-SPEC §2.5) — the configured provider does not match this vector space.`
    );
    this.name = 'PermanentEmbeddingDimensionError';
  }
}

let injectedBackend: SemanticBackend | null = null;
let vectorSpacePopulated = false;

/**
 * Installs (or clears, with `null`) the backend every §5a gate consults.
 * Never called automatically — see this file's header.
 *
 * ## Why the second argument exists (BUG-045)
 *
 * "A backend is installed" and "this store can answer a similarity query"
 * are DIFFERENT facts, and conflating them produced a silent-wrong-answer
 * bug: with `embedding.enabled` on but zero items embedded, every
 * `filter.semantic` — including deliberate gibberish — returned the same
 * arbitrary page with `_score: null`, indistinguishable from a working
 * search. So the seam tracks both, and the READ gates check the second.
 *
 * `vectorSpacePopulated` defaults to `true` when a backend is supplied,
 * because the overwhelmingly common caller is a test installing a FAKE
 * backend whose space it has already stocked. The real host
 * ({@link enableSemanticSearchFromConfig}) probes the space and passes `true`
 * ONLY when the probe proved it populated — an empty (`false`) or
 * indeterminate (`undefined`) space both stay closed.
 */
export function configureSemanticBackend(
  backend: SemanticBackend | null,
  opts?: { vectorSpacePopulated?: boolean }
): void {
  injectedBackend = backend;
  vectorSpacePopulated =
    backend === null ? false : opts?.vectorSpacePopulated ?? true;
}

/** The currently-configured backend, or `null` if none is (the default, unconfigured build). */
export function getSemanticBackend(): SemanticBackend | null {
  return injectedBackend;
}

/**
 * `true` iff a backend is INSTALLED — the predicate the WRITE side checks
 * (`embedding_backfill`, `embedding_health`).
 *
 * Deliberately does NOT consider whether the vector space holds anything:
 * backfill is the operation that populates an empty space, so gating it on
 * a populated space would make an empty store permanently unfillable.
 */
export function isSemanticSearchConfigured(): boolean {
  return injectedBackend !== null;
}

/**
 * `true` iff a similarity query can actually be ANSWERED — a backend is
 * installed AND its vector space holds at least one vector. The predicate
 * every READ-side §5a gate checks (`filter.semantic`, `filter.anchor`,
 * `view:"similar"`, `sort:"relevance"`, `_score`, `_vector`, and the
 * neighbour-ranking admin actions).
 */
export function isSemanticSearchReadable(): boolean {
  return injectedBackend !== null && vectorSpacePopulated;
}

/**
 * Records that the vector space is no longer empty. Called at the end of a
 * backfill that actually wrote a vector, so the read gates open without a
 * process restart.
 *
 * Monotonic by design: the only transition is empty → populated. A stale
 * "populated" cannot arise from normal operation (vectors are deleted one
 * node at a time, and a store that drops to zero is a re-embed away), and a
 * stale "empty" costs a restart rather than a wrong answer — the correct
 * direction for this failure.
 */
export function markSemanticVectorSpacePopulated(): void {
  if (injectedBackend !== null) vectorSpacePopulated = true;
}

/**
 * The configured backend, or a thrown `RagNotConfiguredError` — the accessor
 * every WRITE-side semantic path uses, so "configured?" is asked exactly one
 * way and the §5a message always names the feature that needed it.
 */
export function requireSemanticBackend(feature: string): SemanticBackend {
  if (injectedBackend === null) throw new RagNotConfiguredError(feature);
  return injectedBackend;
}

/**
 * The backend, or a thrown `RagNotConfiguredError`, for a path that must
 * RANK against existing vectors. Distinguishes the two unavailable causes in
 * its message (`not_configured` vs `empty_vector_space`) while keeping the
 * single `rag_not_configured` outcome code the §5a contract promises.
 */
export function requireReadableSemanticBackend(
  feature: string
): SemanticBackend {
  if (injectedBackend === null)
    throw new RagNotConfiguredError(feature, 'not_configured');
  if (!vectorSpacePopulated)
    throw new RagNotConfiguredError(feature, 'empty_vector_space');
  return injectedBackend;
}

export interface SemanticBootstrapConfig {
  /** Embedding provider config, forwarded verbatim to `@adhd/sox-embedding-provider`'s `createEmbeddingProvider()` (e.g. `{ type: 'fastembed', model: 'bge-base-en-v1.5' }`). */
  embedding: { type: string; model: string; options?: Record<string, unknown> };
  /** Overrides the vector space's `{modelId, dim}` — defaults to the embedding provider's own resolved `metadata`. */
  space?: { modelId: string; dim: number };
}

/**
 * Why a bootstrap did not produce a backend. Returned rather than swallowed:
 * an opt-in feature that fails silently is indistinguishable from one that
 * was never asked for, and that ambiguity costs hours. `not_installed` is
 * the ordinary default-build case and is NOT an error; every other reason
 * means a host explicitly asked for RAG and did not get it, which a host
 * should surface (RAG-SPEC §1.6 — never a silent no-op).
 */
export type SemanticBootstrapFailure =
  | { reason: 'not_installed'; detail: string }
  | { reason: 'provider_failed'; detail: string }
  | { reason: 'vector_store_failed'; detail: string }
  | { reason: 'unsupported_adapter'; detail: string };

/**
 * Why a bootstrap could not DETERMINE whether the vector space holds vectors,
 * even though the backend itself started. This is not a failure — the backend
 * works; the bounded readiness probe is simply unavailable on it. Distinct
 * from `false` ("provably empty") so a host can report "cannot determine"
 * instead of a false "is EMPTY".
 */
export type SemanticVectorSpaceProbeReason = 'vector_store_probe_unsupported';

export type SemanticBootstrapResult =
  | {
      ok: true;
      backend: SemanticBackend;
      /**
       * Whether the vector space held at least one vector at bootstrap.
       * `false` means the backend works but has nothing to search; `undefined`
       * means it could NOT be determined — the backend lacks the bounded
       * `hasVectors` probe, so `vectorSpaceProbeReason` is set. BOTH `false`
       * and `undefined` leave the read gates CLOSED rather than serving
       * unranked results (BUG-045); see {@link configureSemanticBackend}.
       */
      vectorSpacePopulated: boolean | undefined;
      /**
       * Present iff `vectorSpacePopulated === undefined`: names why the
       * population could not be determined. `vector_store_probe_unsupported`
       * — the backend predates the additive `hasVectors` capability, and the
       * unbounded `iter` scan this probe exists to avoid is not a fallback.
       */
      vectorSpaceProbeReason?: SemanticVectorSpaceProbeReason;
    }
  | { ok: false; failure: SemanticBootstrapFailure };

// Structural mirrors of the slices of `@adhd/sox-vector-store` /
// `@adhd/sox-embedding-provider` this module calls. Declared locally, NOT
// imported as types, so this file has ZERO compile-time dependency on either
// package — see the module-loading comment on `loadOptional` for why.
interface OptEmbeddingProvider {
  readonly metadata: { modelId: string; dimensions: number };
  embedSingle(text: string, role?: 'document' | 'query'): Promise<Float32Array>;
  health?(): {
    configured: string;
    active: string | null;
    state: 'uninitialized' | 'warming' | 'real' | 'error';
    dimensions: number | null;
    last_error: string | null;
  };
}
/**
 * (BUG-BACKLOG-VECSTORE-NODEFILTER-IGNORED-001) `@adhd/sox-vector-store`'s
 * Turso backend's filter contract is pure `{ ids }` (see its own DEBT-011
 * doc comment: "the store knows nothing about the graph's node table") — a
 * `nodeFilter` field was never honoured, silently. There is no `nodeFilter`
 * here BY DESIGN; a `NodeFilter` is resolved to concrete ids in THIS module
 * (`resolveVecFilter`, below) before ever reaching the vector store.
 */
interface OptVecFilter {
  ids?: number[];
}
interface OptVectorSpace {
  modelId: string;
  dim: number;
}
/** The ASYNC backend (`TursoVectorBackend`) — the Turso path, in-process on the store's own adapter. */
interface OptAsyncVectorBackend {
  ensureSpace(space: OptVectorSpace): Promise<void>;
  upsert(id: number, vec: Float32Array, space: OptVectorSpace): Promise<void>;
  delete(id: number, modelId: string): Promise<void>;
  get(id: number, modelId: string): Promise<Float32Array | null>;
  knn(
    query: Float32Array,
    space: OptVectorSpace,
    k: number,
    filter?: OptVecFilter
  ): Promise<Array<{ id: number; score: number }>>;
  iter(
    modelId: string,
    opts?: { filter?: OptVecFilter }
  ): AsyncIterable<{ id: number; vec: Float32Array }>;
  /**
   * Additive bounded existence probe (`@adhd/sox-vector-store` ≥0.7.0's
   * `AsyncVectorExistenceProbe`): `true` iff at least one vector exists in
   * `modelId`'s space, answered by a `SELECT 1 … LIMIT 1` that projects no
   * embedding column. OPTIONAL and declared structurally (never imported) so
   * this file keeps its zero compile-time dependency on that package — a
   * backend predating the capability narrows to `undefined`, and
   * {@link isVectorSpacePopulated} degrades to `false` rather than falling
   * back to the unbounded `iter` corpus scan it exists to avoid (BUG
   * e19bc9d0).
   */
  hasVectors?(modelId: string): Promise<boolean>;
}
interface OptVectorStoreModule {
  openTursoVectorStore(
    adapter: unknown,
    opts: { dim: number; modelId: string }
  ): Promise<OptAsyncVectorBackend>;
}
interface OptEmbeddingModule {
  createEmbeddingProvider(config: {
    type: string;
    model: string;
    options?: Record<string, unknown>;
  }): Promise<OptEmbeddingProvider>;
}

/**
 * Loads an optional package by name via a NON-LITERAL specifier.
 *
 * `@adhd/sox-vector-store`/`@adhd/sox-embedding-provider` are
 * `optionalDependencies` — a `backlog` install may not have either one, and
 * this package must still build and run correctly without them (the default,
 * unconfigured path). A literal `import('@adhd/sox-vector-store')` would
 * defeat that: TypeScript resolves a literal dynamic-import specifier at
 * compile time (failing the build when the types are absent) AND the bundler
 * (vite/rollup) tries to statically resolve and inline it at BUILD time too.
 * Routing the specifier through a `const` defeats both static analyses, so
 * resolution happens only at RUNTIME, inside this function's try/catch.
 */
async function loadOptional<T>(
  specifier: string
): Promise<{ mod: T } | { err: unknown }> {
  try {
    const dynamicSpecifier = specifier;
    return { mod: (await import(/* @vite-ignore */ dynamicSpecifier)) as T };
  } catch (err) {
    return { err };
  }
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * (BUG-BACKLOG-VECSTORE-NODEFILTER-IGNORED-001) Resolves a `NodeFilter`
 * (e.g. namespace/repo scoping) into a concrete candidate `ids` set through
 * the graph store's OWN `queryNodes` — the same primitive the read layer
 * uses for identical scoped reads — BEFORE it ever reaches
 * `@adhd/sox-vector-store`. That package's
 * Turso backend's filter contract is pure `{ ids }` (its own DEBT-011 doc
 * comment: "the store knows nothing about the graph's node table"); passing
 * it a `nodeFilter` field was a silent no-op that let cross-namespace items
 * leak into KNN results (`filter.namespace` never reached the SQL). Doing
 * the resolution here keeps `SemanticBackend.knn`'s documented invariant
 * true: filtered "pushed into SQL BEFORE the limit — never a post-filter".
 *
 * Returns:
 *  - `undefined` — neither `filter` nor `ids` requested; no scoping at all.
 *  - `{ ids }` — the resolved set (intersected with an explicit `ids`, if
 *    both were given).
 *  - `null` — a `filter`/`ids` WAS requested but resolved to zero
 *    candidates. Callers must treat this as "zero results", never pass an
 *    empty `ids: []` through to the vector store: its own `ids.length > 0`
 *    guard treats an empty array as "no filter" and falls through to an
 *    UNFILTERED scan — the exact bug this function exists to prevent.
 */
async function resolveVecFilter(
  store: GraphBacklogStore,
  opts: { filter?: NodeFilter; ids?: number[] } | undefined
): Promise<OptVecFilter | undefined | null> {
  if (opts?.filter === undefined && opts?.ids === undefined) return undefined;
  let ids = opts?.ids;
  if (opts?.filter !== undefined) {
    const matches = await store.graph.queryNodes(opts.filter);
    const filterIds = new Set(matches.map((n) => n.id));
    ids =
      ids !== undefined
        ? ids.filter((id) => filterIds.has(id))
        : [...filterIds];
  }
  // `ids` is always defined by this point: either passed in directly, or
  // just populated from `filter` above — the early return handles "neither".
  if (ids === undefined || ids.length === 0) return null;
  return { ids };
}

/**
 * Bounded existence probe over a vector space. Returns:
 *
 * - `true` — `modelId`'s space provably holds at least one vector;
 * - `false` — it is provably EMPTY (the backend answered, and the answer was
 *   "none");
 * - `undefined` — it CANNOT BE DETERMINED: the backend does not expose the
 *   additive `hasVectors` capability, so there is no bounded way to ask.
 *
 * `undefined` is deliberately DISTINCT from `false`. Reporting "cannot
 * determine" as "empty" is a false claim — the caller would otherwise log
 * "its vector space … is EMPTY — zero items have been embedded" for a backend
 * that simply could not answer. The caller keeps the read gates CLOSED on
 * `undefined` (the same fail-safe direction as an empty space) but names the
 * distinct `vector_store_probe_unsupported` reason.
 *
 * Delegates to the backend's additive `hasVectors` capability
 * (`@adhd/sox-vector-store` ≥0.7.0) — a `SELECT 1 … LIMIT 1` that projects no
 * embedding column and stops at the first row, so it is O(1) in the size of
 * the space. This replaced an `iter`-first-row probe (BUG e19bc9d0):
 * `AsyncVectorBackend.iter` is a FULL corpus scan on the Turso backend — its
 * `db.all`-backed query materializes every row *and every embedding BLOB*
 * before the first yield — so the old "probe" read the entire vector table on
 * every host boot.
 *
 * The capability is additive, NOT on the pinned backend contract, so a
 * backend that predates it (or a structural test double) yields `undefined`.
 * A backend that cannot answer cheaply must NOT fall back to the unbounded
 * scan this probe exists to avoid.
 *
 * Typed against a structural shape (not the internal `OptAsyncVectorBackend`
 * mirror) so it is directly unit-testable without exporting that interface;
 * `OptAsyncVectorBackend` satisfies it.
 */
export async function isVectorSpacePopulated(
  vectorBackend: { hasVectors?(modelId: string): Promise<boolean> },
  modelId: string
): Promise<boolean | undefined> {
  return typeof vectorBackend.hasVectors === 'function'
    ? vectorBackend.hasVectors(modelId)
    : undefined;
}

/**
 * Builds a REAL {@link SemanticBackend} from `@adhd/sox-vector-store`
 * (vectors, stored in the store's OWN adapter — the single HANDLE through
 * which this process reaches graph, vector, and escape-hatch SQL, safe under
 * concurrent writer processes per ADR-0012) +
 * `@adhd/sox-embedding-provider` (text→vector).
 *
 * Unlike a bare `null` return, every failure is REPORTED with a reason (see
 * {@link SemanticBootstrapFailure}), so a host that explicitly asked for RAG
 * can tell "the optional packages are not installed" (the ordinary default
 * build) from "they are installed and something is broken". Silently
 * conflating those is how an opt-in feature becomes undebuggable.
 *
 * Never called automatically — a host calls this explicitly and then
 * `configureSemanticBackend(result.backend)`.
 */
export async function bootstrapSemanticBackend(
  store: GraphBacklogStore,
  config: SemanticBootstrapConfig
): Promise<SemanticBootstrapResult> {
  // RAG-SPEC §0: the vector table lives in backlog's own database, reached
  // through the SAME adapter the graph uses. `nativeVectors` is the blessed
  // capability probe (never `config.type`): true => Turso, whose vector
  // support is async; false => a substrate this async seam does not serve
  // (its backend is synchronous and lives behind `openVectorStore`).
  // Refuse loudly rather than half-work.
  const adapter = store.adapter as unknown as {
    capabilities?: { nativeVectors?: boolean };
  };
  if (adapter?.capabilities?.nativeVectors !== true) {
    return {
      ok: false,
      failure: {
        reason: 'unsupported_adapter',
        detail:
          `backlog's RAG layer requires a Turso-backed store (capabilities.nativeVectors === true); ` +
          `this store's adapter reports ${JSON.stringify(
            adapter?.capabilities?.nativeVectors
          )}. ` +
          `Turso is @adhd/sox-store-adapter's default; a store on any other substrate cannot serve embeddings.`,
      },
    };
  }

  const [vectorStoreLoad, embeddingLoad] = await Promise.all([
    loadOptional<OptVectorStoreModule>('@adhd/sox-vector-store'),
    loadOptional<OptEmbeddingModule>('@adhd/sox-embedding-provider'),
  ]);
  if ('err' in vectorStoreLoad || 'err' in embeddingLoad) {
    const missing = [
      ...('err' in vectorStoreLoad
        ? [`@adhd/sox-vector-store (${errText(vectorStoreLoad.err)})`]
        : []),
      ...('err' in embeddingLoad
        ? [`@adhd/sox-embedding-provider (${errText(embeddingLoad.err)})`]
        : []),
    ];
    // NOT an error: this is the default build. `RagNotConfiguredError` on
    // every semantic input is exactly the correct behaviour from here on.
    return {
      ok: false,
      failure: {
        reason: 'not_installed',
        detail: `optional embedding packages unavailable: ${missing.join(
          '; '
        )}`,
      },
    };
  }

  // ── Lazy provider (SPEC-EMBEDDING-FUNNEL.md §E) ──────────────────────────
  // The provider is constructed on FIRST SEMANTIC USE, not at bootstrap, so a
  // read-only verb (`query --input '{"view":"projects"}'`) never loads the
  // model — and, under the embedding funnel, never spawns a shared host. When
  // `config.space` is absent the vector space's dim is unknown without the
  // provider's metadata, so the provider is constructed once here to read it.
  // That construction is where a CONFIG error surfaces, so `provider_failed`
  // IS still reported at bootstrap for this space-probe case (an unknown
  // model/type fails at factory time). A MODEL-LOAD failure, by contrast, is
  // deferred to first use: under the shared funnel the fastembed factory no
  // longer warms up, so construction is INERT — it resolves static metadata,
  // loads no ONNX model, and spawns no host — and the model only resolves on
  // the first real embed, where a failure is thrown, never silent. When
  // `config.space` IS supplied even construction is deferred, so both kinds of
  // failure surface on first semantic use.
  let providerPromise: Promise<OptEmbeddingProvider> | null = null;
  const getProvider = (): Promise<OptEmbeddingProvider> => {
    if (!providerPromise) {
      providerPromise = embeddingLoad.mod
        .createEmbeddingProvider(config.embedding)
        .catch((err) => {
          // A REJECTED promise must never stay memoized for the process
          // lifetime (BUG 8168bc41): in a long-lived `serve`, one transient
          // failure — a momentary model-load error, a mid-flight host
          // restart — would otherwise permanently disable RAG with no
          // recovery path short of a process restart. Clearing the memo here
          // lets the NEXT semantic use retry construction from scratch. The
          // rejection is re-thrown so every caller still observes it:
          // `health()` reports it as an error state, and the first-use embed
          // path propagates it.
          providerPromise = null;
          throw err;
        });
    }
    return providerPromise;
  };

  // §2.4 — provenance comes from the provider's RESOLVED metadata, never from
  // `config`. An explicit `config.space` override is honoured, but it is the
  // caller's deliberate act, not a default.
  let space: OptVectorSpace;
  if (config.space) {
    space = config.space;
  } else {
    let probe: OptEmbeddingProvider;
    try {
      probe = await getProvider();
    } catch (err) {
      return {
        ok: false,
        failure: {
          reason: 'provider_failed',
          detail: `createEmbeddingProvider(${config.embedding.type}:${
            config.embedding.model
          }) failed: ${errText(err)}`,
        },
      };
    }
    space = { modelId: probe.metadata.modelId, dim: probe.metadata.dimensions };
  }

  let vectorBackend: OptAsyncVectorBackend;
  try {
    vectorBackend = await vectorStoreLoad.mod.openTursoVectorStore(
      store.adapter,
      { dim: space.dim, modelId: space.modelId }
    );
    await vectorBackend.ensureSpace(space);
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: 'vector_store_failed',
        detail: `openTursoVectorStore(dim=${space.dim}, modelId=${
          space.modelId
        }) failed: ${errText(err)}`,
      },
    };
  }

  /**
   * §2.5 — the dimensional contract is STRUCTURAL. A provider that returns
   * a vector of the wrong length is a permanent, non-retryable fault; it is
   * never truncated or zero-padded to fit, because a silently-reshaped
   * vector produces plausible, wrong neighbours forever after.
   */
  const checkDim = (vec: Float32Array, what: string): Float32Array => {
    if (vec.length !== space.dim) {
      throw new PermanentEmbeddingDimensionError(
        what,
        space.modelId,
        space.dim,
        vec.length
      );
    }
    return vec;
  };

  const backend: SemanticBackend = {
    modelId: space.modelId,
    dim: space.dim,
    async embedQuery(text: string): Promise<Float32Array> {
      return checkDim(
        await (await getProvider()).embedSingle(text, 'query'),
        'embedQuery'
      );
    },
    async embedDocument(text: string): Promise<Float32Array> {
      return checkDim(
        await (await getProvider()).embedSingle(text, 'document'),
        'embedDocument'
      );
    },
    async vectorFor(nodeId: number): Promise<Float32Array | null> {
      return vectorBackend.get(nodeId, space.modelId);
    },
    async upsertVector(nodeId: number, vec: Float32Array): Promise<void> {
      await vectorBackend.upsert(nodeId, checkDim(vec, 'upsertVector'), space);
    },
    async deleteVector(nodeId: number): Promise<void> {
      await vectorBackend.delete(nodeId, space.modelId);
    },
    async knn(
      query: Float32Array,
      k: number,
      opts?: { filter?: NodeFilter; ids?: number[] }
    ): Promise<SemanticMatch[]> {
      const vecFilter = await resolveVecFilter(store, opts);
      // (BUG-BACKLOG-VECSTORE-NODEFILTER-IGNORED-001) `vecFilter === null` means
      // a `filter`/`ids` was requested but resolved to ZERO candidate node ids —
      // NOT "no filter". Calling `vectorBackend.knn()` with an empty `ids` array
      // would be silently treated as unfiltered by the installed
      // `@adhd/sox-vector-store` (its `ids.length > 0` guard falls through to
      // `1=1` on empty), so this short-circuits to "no results" here instead.
      if (vecFilter === null) return [];
      const hits = await vectorBackend.knn(
        checkDim(query, 'knn'),
        space,
        k,
        vecFilter
      );
      return hits.map((m) => ({ nodeId: m.id, score: m.score }));
    },
    async *iterVectors(opts?: {
      filter?: NodeFilter;
    }): AsyncIterable<{ nodeId: number; vec: Float32Array }> {
      const vecFilter = await resolveVecFilter(store, opts);
      if (vecFilter === null) return;
      const inner = vectorBackend.iter(
        space.modelId,
        vecFilter !== undefined ? { filter: vecFilter } : undefined
      );
      for await (const row of inner) yield { nodeId: row.id, vec: row.vec };
    },
    async health(): Promise<SemanticHealth> {
      // §1.5 — a provider is never reported healthy without a RESOLVED
      // backend. When the provider exposes its own health, that is the
      // truth and it is passed through verbatim. When it does not, `active`
      // stays null rather than being invented from config.
      let provider: OptEmbeddingProvider;
      try {
        provider = await getProvider();
      } catch (err) {
        // A deferred (space-supplied) provider that failed to construct is
        // reported as an error state, never thrown from `health()`.
        return {
          configured: `${config.embedding.type}:${config.embedding.model}`,
          active: null,
          state: 'error',
          dimensions: space.dim,
          last_error: errText(err),
        };
      }
      const raw = provider.health?.();
      if (raw) return { ...raw };
      return {
        configured: `${config.embedding.type}:${config.embedding.model}`,
        active: null,
        state: 'uninitialized',
        dimensions: space.dim,
        last_error: null,
      };
    },
  };
  // BUG-045 — is there anything to search? An installed backend over an
  // EMPTY space answers every query with the same arbitrary page and a null
  // score, which is indistinguishable from a working search and wrong for
  // every input. A bounded existence probe settles it.
  //
  // This used to advance `vectorBackend.iter(...)` one step and call that a
  // "one-row" probe — it was not: `AsyncVectorBackend.iter` is a FULL corpus
  // scan on the Turso backend (its `db.all`-backed query materializes every
  // row *and every embedding BLOB* before the first yield), so the probe read
  // the entire vector table on every host boot (BUG e19bc9d0). The bounded
  // `hasVectors` capability (`@adhd/sox-vector-store` ≥0.7.0) issues a
  // `SELECT 1 … LIMIT 1` instead — see {@link isVectorSpacePopulated}.
  let vectorSpacePopulated: boolean | undefined;
  try {
    vectorSpacePopulated = await isVectorSpacePopulated(
      vectorBackend,
      space.modelId
    );
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: 'vector_store_failed',
        detail: `probing vector space "${
          space.modelId
        }" for existing vectors failed: ${errText(err)}`,
      },
    };
  }

  return {
    ok: true,
    backend,
    vectorSpacePopulated,
    // `undefined` is not a failure — the backend started fine; the bounded
    // probe is simply unavailable on it. Name that distinctly so a host
    // reports "cannot determine", never the false "is EMPTY".
    ...(vectorSpacePopulated === undefined
      ? { vectorSpaceProbeReason: 'vector_store_probe_unsupported' as const }
      : {}),
  };
}

/**
 * RAG-SPEC.md §1.6 — the ONE host-side opt-in path, shared by `cli.ts` and
 * `server.ts` so the two entrypoints can never drift into configuring RAG
 * differently.
 *
 * Contract, in order of importance:
 *
 * 1. **Disabled is the default and is completely silent.** With
 *    `cfg.enabled === false` this returns `null` without loading a package,
 *    touching the store, or logging anything — a build that never opts in
 *    behaves exactly as it did before RAG existed, and every semantic input
 *    keeps answering `RagNotConfiguredError` (§5a).
 * 2. **Enabling is best-effort and NEVER fatal.** If the optional packages
 *    are missing, the adapter has no native vectors, or the provider fails
 *    to construct, this logs the TYPED reason from
 *    {@link bootstrapSemanticBackend} and returns `null`. Backlog works
 *    perfectly well without RAG, so a broken embedding stack must never take
 *    down the CLI or the server — but it must also never fail SILENTLY,
 *    which is why the reason is surfaced rather than swallowed. (An earlier
 *    revision returned a bare `null` here; that made a misconfigured stack
 *    indistinguishable from an unconfigured one and was undebuggable.)
 * 3. **It installs the backend itself** via `configureSemanticBackend`, so
 *    callers get the seam wired as a side effect and cannot forget the
 *    second half of the handshake.
 *
 * @param log where to report a failed opt-in. Defaults to `console.error`.
 *            A host with a structured logger should pass its own sink.
 * @returns the live backend, or `null` when RAG is off or unavailable.
 */
export async function enableSemanticSearchFromConfig(
  store: GraphBacklogStore,
  cfg: { enabled: boolean; provider: string; model: string },
  log: (message: string) => void = (m) => console.error(m)
): Promise<SemanticBackend | null> {
  if (!cfg.enabled) return null;

  const result = await bootstrapSemanticBackend(store, {
    embedding: { type: cfg.provider, model: cfg.model },
  });

  if (!result.ok) {
    log(
      `backlog: embedding.enabled is set but the semantic backend could not start ` +
        `(${result.failure.reason}): ${result.failure.detail}. ` +
        `Continuing WITHOUT semantic search — every semantic input will answer rag_not_configured.`
    );
    return null;
  }

  if (result.vectorSpacePopulated === false) {
    // Provably empty. Loud, not fatal, and NOT silently degraded to keyword:
    // the read gates report `rag_not_configured` for this store until it is
    // backfilled.
    log(
      `backlog: embedding.enabled is set and the semantic backend started, but its vector space ` +
        `("${result.backend.modelId}", ${result.backend.dim}d) is EMPTY — zero items have been embedded. ` +
        `Semantic reads will answer rag_not_configured rather than returning unranked results; ` +
        `run \`backlog_admin(embedding_backfill)\` to populate it.`
    );
  } else if (result.vectorSpacePopulated === undefined) {
    // INDETERMINATE, not empty. The backend lacks the bounded `hasVectors`
    // probe, so we cannot tell whether it holds vectors — and scanning the
    // whole table to find out is exactly the cost this probe exists to
    // avoid. Reads stay CLOSED (fail-safe, the same direction as an empty
    // space) but the message must never claim the space is empty.
    log(
      `backlog: embedding.enabled is set and the semantic backend started, but whether its vector ` +
        `space ("${result.backend.modelId}", ${result.backend.dim}d) holds any vectors could not be ` +
        `determined (vector_store_probe_unsupported): this vector backend does not expose the bounded ` +
        `\`hasVectors\` probe. Semantic reads will answer rag_not_configured rather than returning ` +
        `unranked results; run \`backlog_admin(embedding_backfill)\` to (re)confirm and open them.`
    );
  }

  configureSemanticBackend(result.backend, {
    // Only a PROVABLY populated space opens the read gates: `false` (empty)
    // and `undefined` (indeterminate) both stay closed.
    vectorSpacePopulated: result.vectorSpacePopulated === true,
  });
  return result.backend;
}
