/**
 * semantic-search.spec.ts — proves the RAG seam itself: the default
 * unconfigured degrade, the injectable configure/clear cycle, the
 * `requireSemanticBackend` accessor every §5a gate funnels through, and
 * `bootstrapSemanticBackend`'s DIAGNOSTIC failure reporting.
 *
 * All deterministic: a FAKE backend, no model download, no native module,
 * no network. The real-model end-to-end proofs (RAG-SPEC §8) live in their
 * own suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSemanticBackend,
  getSemanticBackend,
  isSemanticSearchConfigured,
  requireSemanticBackend,
  bootstrapSemanticBackend,
  type SemanticBackend,
  type SemanticMatch,
} from './semantic-search.js';
import { RagNotConfiguredError } from '../envelope.js';
import { openTmpStore } from '../test/helpers/tmp-store.js';

/** A deterministic stand-in: two indexed nodes, cosine-ish scoring, no I/O. */
function makeFake(overrides: Partial<SemanticBackend> = {}): SemanticBackend {
  const vectors = new Map<number, Float32Array>([
    [1, new Float32Array([1, 0])],
    [2, new Float32Array([0, 1])],
  ]);
  return {
    modelId: 'fake-cosine',
    dim: 2,
    async embedQuery(text: string) {
      return text === 'apples'
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]);
    },
    async embedDocument(text: string) {
      return text.includes('apple')
        ? new Float32Array([1, 0])
        : new Float32Array([0, 1]);
    },
    async vectorFor(nodeId: number) {
      return vectors.get(nodeId) ?? null;
    },
    async upsertVector(nodeId: number, vec: Float32Array) {
      vectors.set(nodeId, vec);
    },
    async deleteVector(nodeId: number) {
      vectors.delete(nodeId);
    },
    async knn(query: Float32Array, k: number): Promise<SemanticMatch[]> {
      return [...vectors.entries()]
        .map(([nodeId, vec]) => ({
          nodeId,
          score:
            (query[0] ?? 0) * (vec[0] ?? 0) + (query[1] ?? 0) * (vec[1] ?? 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async *iterVectors() {
      for (const [nodeId, vec] of vectors) yield { nodeId, vec };
    },
    async health() {
      return {
        configured: 'fake:fake-cosine',
        active: 'fake-cosine',
        state: 'real' as const,
        dimensions: 2,
        last_error: null,
      };
    },
    ...overrides,
  };
}

describe('the injectable seam', () => {
  afterEach(() => {
    configureSemanticBackend(null); // never leak a configured backend into another suite
  });

  it('defaults to unconfigured — the §5a default degrade', () => {
    expect(isSemanticSearchConfigured()).toBe(false);
    expect(getSemanticBackend()).toBeNull();
  });

  it('configure installs a backend; the same instance comes back', () => {
    const fake = makeFake();
    configureSemanticBackend(fake);
    expect(isSemanticSearchConfigured()).toBe(true);
    expect(getSemanticBackend()).toBe(fake);
  });

  it('configuring with null clears a previously-configured backend', () => {
    configureSemanticBackend(makeFake());
    expect(isSemanticSearchConfigured()).toBe(true);
    configureSemanticBackend(null);
    expect(isSemanticSearchConfigured()).toBe(false);
    expect(getSemanticBackend()).toBeNull();
  });

  it('requireSemanticBackend throws RagNotConfiguredError naming the feature when unconfigured', () => {
    expect(() => requireSemanticBackend('view:"similar"')).toThrow(
      RagNotConfiguredError
    );
    try {
      requireSemanticBackend('view:"similar"');
      expect.unreachable(
        'requireSemanticBackend must throw when no backend is configured'
      );
    } catch (err) {
      // The feature name must survive into the message — that is what makes
      // the §5a degrade actionable rather than a bare "not configured".
      expect((err as Error).message).toContain('view:"similar"');
    }
  });

  it('requireSemanticBackend returns the backend once configured', () => {
    const fake = makeFake();
    configureSemanticBackend(fake);
    expect(requireSemanticBackend('view:"similar"')).toBe(fake);
  });

  it('a fake backend ranks matches by score, deterministically, through the async surface', async () => {
    const fake = makeFake();
    const matches = await fake.knn(await fake.embedQuery('apples'), 2);
    expect(matches[0]?.nodeId).toBe(1);
    expect(matches[0]?.score).toBe(1);
    // Higher-is-better is part of the contract, not an accident of ordering.
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it('iterVectors yields every indexed vector — the dedup/cluster input', async () => {
    const seen: number[] = [];
    for await (const row of makeFake().iterVectors()) seen.push(row.nodeId);
    expect(seen.sort()).toEqual([1, 2]);
  });
});

describe('bootstrapSemanticBackend — diagnostics, not a silent null', () => {
  afterEach(() => {
    configureSemanticBackend(null);
  });

  it('reports not_installed (never throws) when the optional packages are absent — the default build', async () => {
    const tmp = await openTmpStore('semantic-bootstrap');
    try {
      const result = await bootstrapSemanticBackend(tmp.store, {
        embedding: { type: 'fastembed', model: 'bge-base-en-v1.5' },
      });
      // The default build has neither optional package installed. That is
      // NOT an error — but it MUST be distinguishable from a broken
      // configuration, which is the whole reason this returns a reason
      // rather than a bare null.
      if (result.ok) {
        // If a host HAS installed the optional packages, bootstrapping is
        // allowed to succeed — assert the resolved shape instead.
        expect(result.backend.dim).toBeGreaterThan(0);
        expect(result.backend.modelId).toBeTruthy();
      } else {
        expect(result.failure.reason).toBe('not_installed');
        expect(result.failure.detail).toContain('@adhd/sox-');
      }
    } finally {
      await tmp.cleanup();
    }
  });
});
