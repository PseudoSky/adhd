/**
 * fake-embedding-provider.ts — Embeddings mocked here — explicit, scoped
 * user authorization (see entrypoint/backlog/STATE.md), covers embedding
 * cost only.
 *
 * A deterministic, in-process stand-in for `@adhd/sox-embedding-provider`'s
 * REAL `fastembed`/onnxruntime `bge-base-en-v1.5` model, implementing the
 * exact structural shape `semantic-search.ts`'s `loadOptional` seam expects
 * (`OptEmbeddingModule`/`OptEmbeddingProvider` — see that file's header on
 * why the seam is a non-literal dynamic `import()`, deliberately decoupled
 * at compile time from the real optional package).
 *
 * **Why this exists.** Cold ONNX model init plus real inference dominates
 * this package's test wall-clock in a handful of files whose OWN assertions
 * never require genuine semantic understanding (they only need vectors that
 * are deterministic, dimension-correct, and internally consistent — e.g.
 * "the exact same text embeds to the exact same vector every time" for a
 * duplicate-detection gate). Swapping the real model for this fake in those
 * specific files removes real ONNX cost with zero loss of assertion teeth.
 * It is NOT used in every embedding-touching spec: any test whose fixtures
 * are deliberately constructed to require real cross-vocabulary semantic
 * similarity (e.g. finding a paraphrase that shares no token with the
 * query) stays on the real model — see `text-routing.spec.ts` and
 * `rag-e2e.spec.ts`, neither of which imports this file.
 *
 * **Determinism.** `embedTextDeterministic` hashes character trigrams of
 * the (lowercased) input text into a fixed-width vector via a seeded PRNG,
 * then L2-normalizes. Same text -> bit-identical vector, always. Distinct
 * texts that share vocabulary collide on more trigram buckets than texts
 * that share none, so texts sharing surface tokens still score higher by
 * cosine similarity than texts that share nothing — enough for tests that
 * only need "byte-identical text is a duplicate" or "some vector for every
 * distinct row, retrievable via KNN", but this is NOT a semantic model: it
 * has no notion of synonymy or paraphrase, so it must never stand in for a
 * test whose fixtures assert genuine meaning-based (not vocabulary-based)
 * similarity.
 *
 * Fast (no I/O, no model load, pure CPU, sub-millisecond per call) and has
 * zero dependency on `@adhd/sox-embedding-provider` ever being installed.
 */

/** Matches the real bge-base-en-v1.5 model's output width, so nothing downstream that assumes 768 needs to change. */
export const FAKE_EMBEDDING_DIMENSIONS = 768;

/** Distinguishable in any diagnostic/health output from a real resolved model id. */
export const FAKE_EMBEDDING_MODEL_ID = 'fake-deterministic-embedding-model';

/** FNV-1a — fast, well-distributed, and dependency-free. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A tiny seeded PRNG (mulberry32) — deterministic per seed, no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically embeds `text` into a `dims`-length unit vector.
 *
 * Character-trigram bag: each trigram hashes to a bucket in `[0, dims)`,
 * and its seeded-PRNG sign/magnitude accumulates into that bucket — the
 * same trigram in the same bucket always contributes the same value, so
 * two texts sharing trigrams partially align (higher cosine similarity)
 * while two texts sharing none are near-orthogonal. Exported (not just
 * used internally) so a spec file can compute an expected vector directly
 * for an assertion, or run a negative-control perturbation.
 */
export function embedTextDeterministic(
  text: string,
  dims: number = FAKE_EMBEDDING_DIMENSIONS
): Float32Array {
  const vec = new Float32Array(dims);
  const normalized = text.toLowerCase().trim();
  const padded = `  ${normalized}  `; // trigram-pad short inputs
  const n = Math.max(padded.length - 2, 1);
  for (let i = 0; i < n; i++) {
    const trigram = padded.slice(i, i + 3);
    const seed = fnv1a(trigram);
    const bucket = seed % dims;
    const rand = mulberry32(seed);
    const sign = rand() < 0.5 ? -1 : 1;
    vec[bucket] += sign * (0.5 + rand());
  }
  // L2-normalize so every vector is a unit vector, matching a real
  // embedding provider's typical output and keeping cosine-similarity
  // scoring meaningful.
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/** Mirrors `semantic-search.ts`'s locally-declared `OptEmbeddingProvider`. */
export interface FakeEmbeddingProvider {
  readonly metadata: { modelId: string; dimensions: number };
  embedSingle(text: string, role?: 'document' | 'query'): Promise<Float32Array>;
  health(): {
    configured: string;
    active: string | null;
    state: 'uninitialized' | 'warming' | 'real' | 'error';
    dimensions: number | null;
    last_error: string | null;
  };
}

/** Mirrors `semantic-search.ts`'s locally-declared `OptEmbeddingModule` — the shape `loadOptional('@adhd/sox-embedding-provider')` expects. */
export interface FakeEmbeddingModule {
  createEmbeddingProvider(config: {
    type: string;
    model: string;
    options?: Record<string, unknown>;
  }): Promise<FakeEmbeddingProvider>;
}

/**
 * Builds the fake `@adhd/sox-embedding-provider` module replacement for
 * `vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule())`.
 * `dims` defaults to the real model's width; pass an override only if a
 * test deliberately wants to prove a dimension mismatch is rejected.
 */
export function createFakeEmbeddingModule(
  dims: number = FAKE_EMBEDDING_DIMENSIONS
): FakeEmbeddingModule {
  return {
    async createEmbeddingProvider(config) {
      return {
        metadata: { modelId: FAKE_EMBEDDING_MODEL_ID, dimensions: dims },
        async embedSingle(text: string): Promise<Float32Array> {
          return embedTextDeterministic(text, dims);
        },
        health() {
          return {
            configured: `${config.type}:${config.model}`,
            active: FAKE_EMBEDDING_MODEL_ID,
            state: 'real' as const,
            dimensions: dims,
            last_error: null,
          };
        },
      };
    },
  };
}
