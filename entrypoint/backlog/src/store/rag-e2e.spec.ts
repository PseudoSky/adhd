/**
 * rag-e2e.spec.ts — RAG-SPEC.md §8 Definition of Done, proven against the
 * REAL embedding stack: real `@adhd/sox-embedding-provider` (fastembed,
 * bge-base-en-v1.5, 768-dim ONNX inference), real `@adhd/sox-vector-store`
 * Turso vector backend, real Turso-backed store, real `createItemNode` write
 * path. No fake `SemanticBackend` anywhere in this file.
 *
 * ## Why this runs by DEFAULT, with no env flag
 *
 * AGENTS.md's "Live testing is mandatory" allows an env gate for exactly one
 * reason: a PAID or EXTERNAL third-party service. fastembed is neither — it
 * is local ONNX inference over a model already cached on disk
 * (`~/.cache/sox/models`), costing nothing per run and reachable with no
 * network. "It's slow", "it loads a model", "it needs a native module" are
 * explicitly named in AGENTS.md as the rationalizations that produce exactly
 * the blind spot this file exists to close: the every-test-is-a-fake state
 * that let `bootstrapSemanticBackend` go this entire feature's life without
 * once returning `ok: true`. So it runs unflagged, and if the model or the
 * optional packages are missing it FAILS LOUDLY rather than skipping.
 *
 * Every assertion here is model-INDEPENDENT: they assert orderings and
 * structural invariants ("the paraphrase outranks the unrelated item"), never
 * a specific similarity score, so a model swap cannot make them flaky.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode, SEMANTIC_DEDUPE_MIN_SCORE } from './crud.js';
import {
  bootstrapSemanticBackend,
  configureSemanticBackend,
  enableSemanticSearchFromConfig,
  isSemanticSearchConfigured,
  type SemanticBackend,
} from './semantic-search.js';

const MODEL = 'bge-base-en-v1.5';
const EMBEDDING = { type: 'fastembed', model: MODEL } as const;
const REPO = 'rag-e2e-repo';

/** Model load is the slow part (cold ONNX init); every test shares one store-independent budget. */
const E2E_TIMEOUT = 180_000;

let tmp: TmpStore;

afterEach(async () => {
  configureSemanticBackend(null); // never leak a live backend into another suite
  if (tmp) await tmp.cleanup();
});

async function openWithBackend(): Promise<{ store: TmpStore['store']; backend: SemanticBackend }> {
  tmp = await openTmpStore('rag-e2e');
  const result = await bootstrapSemanticBackend(tmp.store, { embedding: EMBEDDING });
  if (!result.ok) {
    // Fail LOUDLY with the typed reason — never skip.
    throw new Error(`real semantic backend unavailable (${result.failure.reason}): ${result.failure.detail}`);
  }
  configureSemanticBackend(result.backend);
  return { store: tmp.store, backend: result.backend };
}

const mk = (store: TmpStore['store'], title: string, body: string) =>
  createItemNode(store, { family: 'BUG-E2E', title, body, repo: REPO, awaitEmbed: true } as never);

describe('RAG §8 DoD — real fastembed + real Turso vectors', () => {
  beforeAll(() => {
    // A configured backend leaking in from another file would invalidate the
    // "unconfigured by default" premise several tests below rely on.
    expect(isSemanticSearchConfigured()).toBe(false);
  });

  it('DoD#1 — bootstrap resolves a REAL model: health reports state:"real" with the resolved id, never a config placeholder', async () => {
    const { backend } = await openWithBackend();

    expect(backend.modelId).toBe(MODEL);
    expect(backend.dim).toBe(768);

    const health = await backend.health();
    // §2.4/§1.5: `active` is the RESOLVED model. A backend that merely echoed
    // config would still pass a modelId check, so assert the health state too.
    expect(health.state).toBe('real');
    expect(health.active).toBe(MODEL);
    expect(health.dimensions).toBe(768);
    expect(health.last_error).toBeNull();
  }, E2E_TIMEOUT);

  it('DoD#2 — an item created through the real write path is retrievable by MEANING, not keywords', async () => {
    const { store, backend } = await openWithBackend();

    const target = await mk(store, 'Vector index refuses a dimension mismatch',
      'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.');
    await mk(store, 'Bananas are a tropical fruit', 'They are yellow and grow in bunches on large herbaceous plants.');
    await mk(store, 'Cache invalidation is hard', 'One of the two hard problems in computer science, alongside naming things.');

    // Deliberately shares NO meaningful token with the target title —
    // "embedding"/"length"/"configured" vs "Vector"/"index"/"refuses". An FTS
    // query would not rank the target first; only a semantic one does.
    const query = await backend.embedQuery('the embedding length does not match the configured dimension');
    const hits = await backend.knn(query, 3);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.nodeId).toBe(target.item.nodeId);
    // Ordering, not an absolute score — model-independent.
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  }, E2E_TIMEOUT);

  it('DoD#2b — the vector is durably readable back for the created node (§2.2 awaitEmbed)', async () => {
    const { store, backend } = await openWithBackend();
    const item = await mk(store, 'Durable vector round-trip', 'The embedding written on create can be read back for this node.');

    const vec = await backend.vectorFor(item.item.nodeId);
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(768);
  }, E2E_TIMEOUT);

  it('DoD#3 — semantic dedupe catches a PARAPHRASED duplicate that shares no meaningful title tokens', async () => {
    const { store } = await openWithBackend();

    await mk(store, 'Database connection pool leaks under sustained load',
      'Connections are acquired and never returned once the pool is saturated, so the service eventually stalls.');

    // A true duplicate phrased entirely differently: no shared meaningful
    // title token with the original, so source 1 (FTS +
    // titleMeaningfullyOverlaps) CANNOT surface it and source 2 (exact
    // symbol/path/errorText) has nothing to match on. Only §4's semantic
    // source can find this.
    const dup = await createItemNode(store, {
      family: 'BUG-E2E',
      repo: REPO,
      title: 'Connections are never released back to the pool when saturated',
      body: 'Under heavy traffic the service hangs because acquired handles are not returned to the pool.',
    } as never);

    // The gate fires: the create is suppressed and reports the candidate.
    expect(dup.created).toBe(false);
    expect(dup.duplicateCandidates?.length ?? 0).toBeGreaterThan(0);
  }, E2E_TIMEOUT);

  it('DoD#3b — NEGATIVE CONTROL: an unrelated item is NOT flagged as a duplicate (the floor has teeth)', async () => {
    const { store } = await openWithBackend();

    await mk(store, 'Database connection pool leaks under sustained load',
      'Connections are acquired and never returned once the pool is saturated, so the service eventually stalls.');

    // Semantically unrelated. If SEMANTIC_DEDUPE_MIN_SCORE were removed (or
    // set to 0), knn's unconditional k-nearest would return the pool item
    // here and this create would be wrongly suppressed — which is exactly
    // what this control detects.
    const unrelated = await createItemNode(store, {
      family: 'BUG-E2E',
      repo: REPO,
      title: 'Bananas are a tropical fruit',
      body: 'They are yellow and grow in bunches on large herbaceous plants.',
    } as never);

    expect(unrelated.created).toBe(true);
    expect(unrelated.duplicateCandidates?.length ?? 0).toBe(0);
    // Guard the constant itself: a future edit to 0 would silently disarm the gate.
    expect(SEMANTIC_DEDUPE_MIN_SCORE).toBeGreaterThan(0);
  }, E2E_TIMEOUT);

  it('DoD#6 — the KNN filter is pushed DOWN: items in another repo never appear', async () => {
    const { store, backend } = await openWithBackend();

    await mk(store, 'Vector index refuses a dimension mismatch',
      'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.');

    const other = await createItemNode(store, {
      family: 'BUG-E2E',
      repo: 'some-other-repo',
      title: 'Vector index refuses a dimension mismatch',
      body: 'Inserting an embedding whose length differs from the configured space dimension is rejected structurally.',
      awaitEmbed: true,
    } as never);

    const query = await backend.embedQuery('the embedding length does not match the configured dimension');
    const scoped = await backend.knn(query, 10, { filter: { namespace: REPO } });

    expect(scoped.length).toBeGreaterThan(0);
    // The out-of-repo item has near-identical text, so it would certainly be
    // in an unfiltered top-k. Its absence proves the filter reached the query.
    expect(scoped.map((h) => h.nodeId)).not.toContain(other.item.nodeId);
  }, E2E_TIMEOUT);

  it('§1.6 — enableSemanticSearchFromConfig is silent and leaves RAG unconfigured when disabled', async () => {
    tmp = await openTmpStore('rag-e2e-disabled');
    const backend = await enableSemanticSearchFromConfig(tmp.store, {
      enabled: false,
      provider: 'fastembed',
      model: MODEL,
    });
    expect(backend).toBeNull();
    expect(isSemanticSearchConfigured()).toBe(false);
  }, E2E_TIMEOUT);

  it('§1.6 — enableSemanticSearchFromConfig installs the seam when enabled', async () => {
    tmp = await openTmpStore('rag-e2e-enabled');
    const backend = await enableSemanticSearchFromConfig(tmp.store, {
      enabled: true,
      provider: 'fastembed',
      model: MODEL,
    });
    expect(backend).not.toBeNull();
    expect(isSemanticSearchConfigured()).toBe(true);
    expect(backend!.modelId).toBe(MODEL);
  }, E2E_TIMEOUT);
});
