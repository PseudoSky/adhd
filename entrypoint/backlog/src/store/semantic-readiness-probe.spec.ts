/**
 * semantic-readiness-probe.spec.ts — behavioral proof that the semantic
 * readiness probe is BOUNDED end-to-end (BUG e19bc9d0).
 *
 * `bootstrapSemanticBackend` decides `vectorSpacePopulated` by asking the
 * backend's additive `hasVectors` capability — a `SELECT 1 … LIMIT 1` — never
 * by advancing the full-corpus `iter`. The old implementation advanced
 * `iter(...)` one step and called that a "one-row" probe; on the Turso backend
 * `iter` is a full corpus scan whose `db.all`-backed query materializes every
 * row *and every embedding BLOB* before the first yield, so that "probe" read
 * the entire vector table on every host boot.
 *
 * This file drives the REAL `bootstrapSemanticBackend` against a REAL store
 * and mocks ONLY the two optional packages (the embedding provider — cost
 * only, per STATE.md's scoped authorization — and the vector store, whose
 * `hasVectors`/`iter` calls are the whole observable). The vector store double
 * has an `iter()` that THROWS, so this suite is RED if the probe ever
 * regresses to the `iter`-first-row scan it replaced — the negative control
 * for the bounded-probe contract.
 *
 * Embeddings mocked here: `vi.mock('@adhd/sox-embedding-provider')` installs
 * `createFakeEmbeddingModule` — the deterministic in-process stand-in from
 * `test/helpers/fake-embedding-provider.ts` (cost only, per STATE.md's scoped
 * authorization) — so no real ONNX model is ever loaded by this suite. The
 * vector store is mocked too (its `hasVectors`/`iter` calls are the whole
 * observable); neither mock is ever replaced by a real load.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';
import { openTmpStore } from '../test/helpers/tmp-store.js';
import { bootstrapSemanticBackend, enableSemanticSearchFromConfig, isSemanticSearchReadable } from './semantic-search.js';

/**
 * The vector-store double's controllable state. Hoisted so the `vi.mock`
 * factory below (which vitest hoists above the imports) can reference it.
 */
const probeState = vi.hoisted(() => ({
  populated: false,
  /** When false, the double omits `hasVectors` entirely — a backend that predates the additive capability. */
  hasHasVectors: true,
  hasVectorsCalls: 0,
  iterCalls: 0,
}));

vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());

vi.mock('@adhd/sox-vector-store', () => ({
  openTursoVectorStore: async () => {
    const backend: Record<string, unknown> = {
      ensureSpace: async () => undefined,
      upsert: async () => undefined,
      delete: async () => undefined,
      get: async () => null,
      knn: async () => [],
      // The unbounded corpus scan this probe must NEVER touch. It throws, so
      // any regression back to `for await (… iter …)` fails loudly.
      iter: () => {
        probeState.iterCalls += 1;
        throw new Error('the readiness probe must not scan the corpus');
      },
    };
    if (probeState.hasHasVectors) {
      backend.hasVectors = async () => {
        probeState.hasVectorsCalls += 1;
        return probeState.populated;
      };
    }
    return backend;
  },
}));

beforeEach(() => {
  probeState.populated = false;
  probeState.hasHasVectors = true;
  probeState.hasVectorsCalls = 0;
  probeState.iterCalls = 0;
});

async function bootstrap(): Promise<{
  ok: boolean;
  vectorSpacePopulated?: boolean;
  vectorSpaceProbeReason?: string;
}> {
  const tmp = await openTmpStore('semantic-readiness-probe');
  try {
    const result = await bootstrapSemanticBackend(tmp.store, {
      embedding: { type: 'fastembed', model: 'bge-base-en-v1.5' },
    });
    return result.ok
      ? {
          ok: true,
          vectorSpacePopulated: result.vectorSpacePopulated,
          vectorSpaceProbeReason: result.vectorSpaceProbeReason,
        }
      : { ok: false };
  } finally {
    await tmp.cleanup();
  }
}

describe('bootstrapSemanticBackend — readiness probe is bounded (BUG e19bc9d0)', () => {
  it('answers via hasVectors (never iter): a populated space ⇒ vectorSpacePopulated:true', async () => {
    probeState.populated = true;
    const result = await bootstrap();
    expect(result.ok).toBe(true);
    expect(result.vectorSpacePopulated).toBe(true);
    expect(probeState.hasVectorsCalls).toBe(1);
    expect(probeState.iterCalls).toBe(0);
  });

  it('an empty space ⇒ vectorSpacePopulated:false, still via hasVectors (never iter)', async () => {
    probeState.populated = false;
    const result = await bootstrap();
    expect(result.ok).toBe(true);
    expect(result.vectorSpacePopulated).toBe(false);
    expect(probeState.hasVectorsCalls).toBe(1);
    expect(probeState.iterCalls).toBe(0);
  });

  it('a backend predating hasVectors yields UNDEFINED (cannot determine — never "empty") — never falls back to the unbounded iter scan (negative control)', async () => {
    // No `hasVectors` on the double, and its `iter()` throws. If the probe
    // regressed to the iter-first-row scan, `iter` would throw and the
    // bootstrap would return `ok:false` (vector_store_failed) — so BOTH
    // `result.ok` and `iterCalls === 0` have teeth here. The value is
    // UNDEFINED, not `false`: the probe could not ask, which is a different
    // fact from "provably empty".
    probeState.hasHasVectors = false;
    const result = await bootstrap();
    expect(result.ok).toBe(true);
    expect(result.vectorSpacePopulated).toBeUndefined();
    expect(result.vectorSpaceProbeReason).toBe(
      'vector_store_probe_unsupported'
    );
    expect(probeState.iterCalls).toBe(0);
  });

  it('the host names the distinct vector_store_probe_unsupported reason, never claims the space is EMPTY, and keeps reads CLOSED (fail-safe)', async () => {
    // The bug this pins: `isVectorSpacePopulated` used to answer `false` for
    // a backend that merely lacked `hasVectors`, so the host logged "its
    // vector space … is EMPTY — zero items have been embedded". Indeterminate
    // must be reported as indeterminate. The read gate must still be shut —
    // the safety direction is unchanged.
    probeState.hasHasVectors = false;
    const tmp = await openTmpStore('semantic-readiness-probe');
    const logs: string[] = [];
    try {
      await enableSemanticSearchFromConfig(
        tmp.store,
        { enabled: true, provider: 'fastembed', model: 'bge-base-en-v1.5' },
        (m) => logs.push(m)
      );
    } finally {
      await tmp.cleanup();
    }
    const joined = logs.join('\n');
    expect(joined).toContain('vector_store_probe_unsupported');
    expect(joined).not.toContain('is EMPTY');
    // Fail-safe: an indeterminate space does NOT open the read gates.
    expect(isSemanticSearchReadable()).toBe(false);
  });
});
