/**
 * semantic-search.spec.ts — proves the injectable seam (P4 opt-in RAG
 * scaffolding): default-unconfigured, configure/clear, and a FAKE backend
 * exercising every method the real one would need to support — all
 * deterministic, no model download, no native module, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSemanticBackend,
  getSemanticBackend,
  isSemanticSearchConfigured,
  bootstrapSemanticBackend,
  type SemanticBackend,
  type SemanticMatch,
} from './semantic-search.js';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';

describe('configureSemanticBackend / getSemanticBackend / isSemanticSearchConfigured', () => {
  afterEach(() => {
    configureSemanticBackend(null); // never leak a configured backend into another test
  });

  it('defaults to unconfigured — the AC-12 default degrade', () => {
    expect(isSemanticSearchConfigured()).toBe(false);
    expect(getSemanticBackend()).toBeNull();
  });

  it('configure installs a backend; the same instance comes back from getSemanticBackend', () => {
    const fake: SemanticBackend = {
      modelId: 'fake-model',
      dim: 3,
      async embedQuery() {
        return new Float32Array([1, 0, 0]);
      },
      vectorFor() {
        return null;
      },
      knn(): SemanticMatch[] {
        return [];
      },
    };
    configureSemanticBackend(fake);
    expect(isSemanticSearchConfigured()).toBe(true);
    expect(getSemanticBackend()).toBe(fake);
  });

  it('configuring with null clears a previously-configured backend', () => {
    const fake: SemanticBackend = { modelId: 'x', dim: 1, async embedQuery() { return new Float32Array([1]); }, vectorFor() { return null; }, knn() { return []; } };
    configureSemanticBackend(fake);
    expect(isSemanticSearchConfigured()).toBe(true);
    configureSemanticBackend(null);
    expect(isSemanticSearchConfigured()).toBe(false);
    expect(getSemanticBackend()).toBeNull();
  });

  it('a fake backend can rank matches by score, deterministically', async () => {
    const fake: SemanticBackend = {
      modelId: 'fake-cosine',
      dim: 2,
      async embedQuery(text: string) {
        return text === 'apples' ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
      },
      vectorFor(nodeId: number) {
        if (nodeId === 1) return new Float32Array([1, 0]);
        if (nodeId === 2) return new Float32Array([0, 1]);
        return null;
      },
      knn(query: Float32Array): SemanticMatch[] {
        // Deterministic fake cosine-ish scoring for the two indexed nodes.
        const scores: SemanticMatch[] = [
          { nodeId: 1, score: query[0] ?? 0 },
          { nodeId: 2, score: query[1] ?? 0 },
        ];
        return scores.sort((a, b) => b.score - a.score);
      },
    };
    configureSemanticBackend(fake);
    const q = await fake.embedQuery('apples');
    const matches = fake.knn(q, 2);
    expect(matches[0]?.nodeId).toBe(1);
    expect(matches[0]?.score).toBe(1);
  });
});

describe('bootstrapSemanticBackend', () => {
  let tmp: TmpStore | undefined;

  afterEach(async () => {
    if (tmp) await tmp.cleanup();
    tmp = undefined;
    configureSemanticBackend(null);
  });

  it('returns null (not a thrown error) when the optional packages are not installed — the default build', async () => {
    tmp = await openTmpStore('semantic-bootstrap-unconfigured');
    const backend = await bootstrapSemanticBackend(tmp.store, { embedding: { type: 'fastembed', model: 'does-not-matter-here' } });
    // This test suite deliberately does NOT install
    // @adhd/sox-vector-store / @adhd/sox-embedding-provider (they are
    // optionalDependencies) — bootstrap must degrade to null, never throw,
    // never crash the caller.
    expect(backend).toBeNull();
  });
});
