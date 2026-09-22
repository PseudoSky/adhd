/**
 * semantic-provider-retry.spec.ts — proves a REJECTED provider construction
 * does not permanently disable RAG in a long-lived process (BUG 8168bc41).
 *
 * `getProvider()` memoizes the provider promise so N semantic uses share ONE
 * construction. The bug: when that promise REJECTED — a transient model-load
 * failure, a mid-flight host restart — the rejected promise stayed memoized
 * for the process lifetime, so every later `embedQuery`/`embedDocument`/
 * `health()` replayed the SAME stale rejection and RAG never recovered short
 * of a process restart. A long-lived `serve` is exactly the process shape
 * that makes this fatal. The fix clears the memo inside a `.catch`, so the
 * NEXT semantic use retries construction from scratch.
 *
 * Teeth: this suite drives the REAL `bootstrapSemanticBackend` + the REAL
 * `backend.embedQuery`/`backend.health` seam. The fake provider below is
 * configured to FAIL its first construction and SUCCEED thereafter, so the
 * second use is the assertion. Revert the `.catch`-clears-memo fix and the
 * second `embedQuery` replays the first rejection — this test goes RED. That
 * is the negative control; it is not a shape check.
 *
 * Embeddings mocked here: `vi.mock('@adhd/sox-embedding-provider', ...)`
 * installs a controllable stand-in — no real ONNX model is ever loaded. The
 * vector store is mocked too (its `ensureSpace`/`hasVectors` are the only
 * calls bootstrap makes); neither mock is ever replaced by a real load.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTmpStore } from '../test/helpers/tmp-store.js';
import { bootstrapSemanticBackend } from './semantic-search.js';

/**
 * Hoisted so the `vi.mock` factory (hoisted above the imports) can read and
 * mutate it. `failuresRemaining` is the knob: >0 makes the next construction
 * reject; each construction consumes one failure.
 */
const providerState = vi.hoisted(() => ({
  constructCalls: 0,
  failuresRemaining: 0,
}));

vi.mock('@adhd/sox-embedding-provider', () => ({
  createEmbeddingProvider: async (config: { type: string; model: string }) => {
    providerState.constructCalls += 1;
    if (providerState.failuresRemaining > 0) {
      providerState.failuresRemaining -= 1;
      throw new Error(
        `transient model-load failure #${providerState.constructCalls}`
      );
    }
    return {
      metadata: { modelId: 'retry-fake', dimensions: 4 },
      async embedSingle(): Promise<Float32Array> {
        return Float32Array.from([1, 0, 0, 0]);
      },
      health() {
        return {
          configured: `${config.type}:${config.model}`,
          active: 'retry-fake',
          state: 'real' as const,
          dimensions: 4,
          last_error: null,
        };
      },
    };
  },
}));

vi.mock('@adhd/sox-vector-store', () => ({
  openTursoVectorStore: async () => ({
    ensureSpace: async () => undefined,
    upsert: async () => undefined,
    delete: async () => undefined,
    get: async () => null,
    knn: async () => [],
    // `iter` is deliberately ABSENT: bootstrap only calls `ensureSpace` and
    // `hasVectors`, and an unused mock field would only invite a cast.
    hasVectors: async () => true,
  }),
}));

beforeEach(() => {
  providerState.constructCalls = 0;
  providerState.failuresRemaining = 0;
});

/**
 * Bootstraps with an explicit `space`, which DEFERS provider construction to
 * first semantic use (the funnel's lazy-provider path). That is what makes
 * the transient failure land on `embedQuery` rather than at bootstrap.
 */
async function bootstrapDeferred() {
  const tmp = await openTmpStore('semantic-provider-retry');
  const result = await bootstrapSemanticBackend(tmp.store, {
    embedding: { type: 'fastembed', model: 'bge-base-en-v1.5' },
    space: { modelId: 'retry-fake', dim: 4 },
  });
  if (!result.ok) {
    await tmp.cleanup();
    throw new Error(`bootstrap unexpectedly failed: ${result.failure.reason}`);
  }
  return { tmp, backend: result.backend };
}

describe('provider memo clears on rejection (BUG 8168bc41)', () => {
  it('retries construction after a transient failure instead of replaying the stale rejection', async () => {
    providerState.failuresRemaining = 1;
    const { tmp, backend } = await bootstrapDeferred();
    try {
      // Deferred: bootstrap itself constructs nothing.
      expect(providerState.constructCalls).toBe(0);

      // First use: construction fails and the rejection propagates.
      await expect(backend.embedQuery('hello')).rejects.toThrow(
        /transient model-load failure/
      );
      expect(providerState.constructCalls).toBe(1);

      // Second use: the memo was cleared, so construction is RETRIED — and
      // now succeeds. Without the fix this replays the first rejection.
      const vec = await backend.embedQuery('hello');
      expect(vec).toHaveLength(4);
      expect(providerState.constructCalls).toBe(2);
    } finally {
      await tmp.cleanup();
    }
  });

  it('a successfully constructed provider is still memoized — exactly one construction for N uses', async () => {
    const { tmp, backend } = await bootstrapDeferred();
    try {
      await backend.embedQuery('a');
      await backend.embedQuery('b');
      await backend.embedDocument('c');
      expect(providerState.constructCalls).toBe(1);
    } finally {
      await tmp.cleanup();
    }
  });

  it('health() reports a failed provider as an error state, then recovers on the next use', async () => {
    providerState.failuresRemaining = 1;
    const { tmp, backend } = await bootstrapDeferred();
    try {
      const first = await backend.health();
      expect(first.state).toBe('error');
      expect(first.active).toBeNull();

      const second = await backend.health();
      expect(second.state).toBe('real');
      expect(second.active).toBe('retry-fake');
    } finally {
      await tmp.cleanup();
    }
  });
});
