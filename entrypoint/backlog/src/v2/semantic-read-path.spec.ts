/**
 * semantic-read-path.spec.ts — RAG-SPEC §3, the semantic READ path
 * (`filter.semantic`, `filter.anchor`, `view:"similar"`, `sort:"relevance"`,
 * `fields:["_score"|"_vector"]`) driven through `backlogQuery`/`backlogGet`
 * against a REAL Turso-backed store, with a FAKE deterministic
 * `SemanticBackend` injected via `configureSemanticBackend` — no model
 * download, no network, no `optionalDependencies` required to run this
 * suite.
 *
 * The fake backend is not a stub of the code under test: it is a genuine
 * `SemanticBackend` implementation (cosine-similarity KNN over vectors the
 * test sets explicitly, real `NodeFilter` predicate evaluation against the
 * REAL store's `NodeRecord`s). What is faked is only the embedding MODEL —
 * `embedQuery`/`embedDocument` return vectors the test pins by exact input
 * string, rather than running fastembed. Every other seam (the store, the
 * v2 query/get layers, `NodeFilter` pushdown) is the real, shipped code.
 *
 * §7 discipline: every test opens a real store under `tmp/backlog/` and
 * removes it in `afterEach` (which vitest runs even when the test body
 * throws), and `afterEach` ALSO clears the injected backend
 * (`configureSemanticBackend(null)`) — a leaked backend would break every
 * OTHER suite in this file (and beyond) that assumes the default,
 * unconfigured build.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeFilter } from '@adhd/sox-graph-store';
import { isOutcomeError, isOutcomeOk, type IBacklogCard, type IOutcomeEnvelope } from '../model.js';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode, softDeleteItemNode } from '../store/crud.js';
import {
  configureSemanticBackend,
  type SemanticBackend,
  type SemanticHealth,
  type SemanticMatch,
} from '../store/semantic-search.js';
import { backlogQuery, type IBacklogQueryResult } from './query.js';
import { backlogGet } from './get.js';

const REPO_A = 'semrag-repo-a';
const REPO_B = 'semrag-repo-b';

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('semantic-read-path');
});

afterEach(async () => {
  // Cleared UNCONDITIONALLY, even if a test above threw — a leaked fake
  // backend would silently turn every other suite's "unconfigured" fixtures
  // into "configured" ones, which is exactly the cross-test contamination
  // AGENTS.md's teardown discipline exists to prevent.
  configureSemanticBackend(null);
  await tmp.cleanup();
});

// ----------------------------------------------------------------------------
// The fake backend — a real SemanticBackend, a fake embedding model.
// ----------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A deterministic, in-memory `SemanticBackend`. `knn`/`iterVectors` evaluate
 * `NodeFilter` for REAL against the store's own `NodeRecord`s (namespace,
 * metadata, tags) — this is what gives the pushdown test below actual teeth:
 * a `query.ts` that swapped pushdown for a post-`k` filter is
 * distinguishable from one that pushes the filter into `knn` itself, because
 * THIS backend enforces the filter before slicing to `k`, exactly as the
 * real Turso vector store's `knn` primitive is contracted to (RAG-SPEC §3.1).
 */
class FakeSemanticBackend implements SemanticBackend {
  readonly modelId = 'fake:semantic-read-path-v1';
  readonly dim = 3;
  readonly vectors = new Map<number, Float32Array>();
  readonly queryVectors = new Map<string, Float32Array>();
  readonly knnCalls: Array<{ k: number; filter?: NodeFilter; ids?: number[] }> = [];
  readonly embedQueryCalls: string[] = [];

  constructor(private readonly store: TmpStore['store']) {}

  /** Test setup: pins the vector a real `SemanticBackend.embedQuery(text)` would have produced. */
  setQueryVector(text: string, vec: number[]): void {
    this.queryVectors.set(text, Float32Array.from(vec));
  }

  /** Test setup: pins an item's indexed vector directly — the read path never re-derives it, it reads `vectorFor`/`knn`. */
  setVector(nodeId: number, vec: number[]): void {
    this.vectors.set(nodeId, Float32Array.from(vec));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.embedQueryCalls.push(text);
    const v = this.queryVectors.get(text);
    if (!v) {
      throw new Error(`FakeSemanticBackend.embedQuery: no vector registered for ${JSON.stringify(text)} — call setQueryVector() first`);
    }
    return v;
  }

  async embedDocument(text: string): Promise<Float32Array> {
    // Not exercised by the READ path this suite covers (write-path embedding
    // is RAG-SPEC §2, another agent's scope) — delegates for interface
    // completeness only.
    return this.embedQuery(text);
  }

  async vectorFor(nodeId: number): Promise<Float32Array | null> {
    return this.vectors.get(nodeId) ?? null;
  }

  async upsertVector(nodeId: number, vec: Float32Array): Promise<void> {
    this.vectors.set(nodeId, vec);
  }

  async deleteVector(nodeId: number): Promise<void> {
    this.vectors.delete(nodeId);
  }

  async knn(query: Float32Array, k: number, opts?: { filter?: NodeFilter; ids?: number[] }): Promise<SemanticMatch[]> {
    this.knnCalls.push({ k, filter: opts?.filter, ids: opts?.ids });
    const scored: SemanticMatch[] = [];
    for (const [nodeId, vec] of this.vectors) {
      if (opts?.ids !== undefined && !opts.ids.includes(nodeId)) continue;
      if (opts?.filter !== undefined && !(await this.matchesFilter(nodeId, opts.filter))) continue;
      scored.push({ nodeId, score: cosineSimilarity(query, vec) });
    }
    // HIGHER-IS-BETTER, per the SemanticBackend contract — the filter above
    // has ALREADY run, so slicing to `k` here is the exact "pushdown before
    // the limit" the real Turso backend is contracted to do.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async *iterVectors(opts?: { filter?: NodeFilter }): AsyncIterable<{ nodeId: number; vec: Float32Array }> {
    for (const [nodeId, vec] of this.vectors) {
      if (opts?.filter !== undefined && !(await this.matchesFilter(nodeId, opts.filter))) continue;
      yield { nodeId, vec };
    }
  }

  async health(): Promise<SemanticHealth> {
    return { configured: 'fake:test', active: this.modelId, state: 'real', dimensions: this.dim, last_error: null, indexedCount: this.vectors.size };
  }

  private async matchesFilter(nodeId: number, filter: NodeFilter): Promise<boolean> {
    const node = await this.store.graph.getNode(nodeId);
    if (!node) return false;
    if (filter.namespace !== undefined && node.namespace !== filter.namespace) return false;
    if (filter.projectPath !== undefined && node.projectPath !== filter.projectPath) return false;
    if (filter.metadata !== undefined) {
      const meta = (node.metadata ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (meta[key] !== value) return false;
      }
    }
    if (filter.tags !== undefined && filter.tags.length > 0) {
      const tagSet = new Set(node.tags);
      const matchAll = filter.tagsMatchAll !== false;
      const matched = matchAll ? filter.tags.every((t) => tagSet.has(t)) : filter.tags.some((t) => tagSet.has(t));
      if (!matched) return false;
    }
    return true;
  }
}

// ----------------------------------------------------------------------------
// Fixture helpers.
// ----------------------------------------------------------------------------

async function seed(repo: string, family: string, title: string, body = 'seeded body'): Promise<{ humanId: string; nodeId: number }> {
  const result = await createItemNode(tmp.store, { family, title, body, repo, force: true });
  if (!result.created) throw new Error(`fixture: create suppressed for ${JSON.stringify(title)}`);
  return { humanId: result.item.humanId, nodeId: result.item.nodeId };
}

function ok(env: IOutcomeEnvelope<IBacklogQueryResult>): IBacklogQueryResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

function ids(cards: readonly IBacklogCard[] | undefined): string[] {
  return (cards ?? []).map((c) => c.humanId);
}

// ----------------------------------------------------------------------------
// DoD #7 (RAG-SPEC §8) — the unconfigured regression guard.
// ----------------------------------------------------------------------------

describe('unconfigured: RAG-SPEC §8 DoD #7 preserved byte-for-byte', () => {
  it('every semantic input still throws rag_not_configured, with the SAME message shape as before this change', async () => {
    const cases: Array<Record<string, unknown>> = [
      { filter: { semantic: 'sign-in button unresponsive' } },
      { filter: { anchor: 'BUG-SEMRAG-001' } },
      { view: 'similar', filter: { semantic: 'x' } },
      { sort: 'relevance' },
      { fields: ['_score'] },
      { fields: ['_vector'] },
    ];
    for (const input of cases) {
      const env = await backlogQuery(tmp.store, input as never);
      expect(isOutcomeError(env) && env.error.code).toBe('rag_not_configured');
      expect(isOutcomeError(env) && env.error.message).toMatch(/needs a configured embedding backend and none is available/);
    }

    const getEnv = await backlogGet(tmp.store, { humanId: 'BUG-SEMRAG-001', fields: ['_vector'] });
    expect(isOutcomeError(getEnv) && getEnv.error.code).toBe('rag_not_configured');
  });

  it('listItems({grep}) keeps returning real FTS results while the semantic channel is unavailable', async () => {
    await seed(REPO_A, 'BUG-SEMRAG-FTS', 'sign in button unresponsive');
    await seed(REPO_A, 'BUG-SEMRAG-FTS', 'totally unrelated item');
    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO_A, grep: 'unresponsive' } }));
    expect(data.items).toHaveLength(1);
    expect((data.items ?? [])[0]?.title).toContain('unresponsive');
  });
});

// ----------------------------------------------------------------------------
// Configured — the vector channel is served for real.
// ----------------------------------------------------------------------------

describe('configured: view:"similar" nearest-neighbour', () => {
  it('filter.semantic returns neighbours ranked by score, descending', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const near = await seed(REPO_A, 'BUG-SEMRAG-SIM', 'closest neighbour');
    const mid = await seed(REPO_A, 'BUG-SEMRAG-SIM', 'middling neighbour');
    const far = await seed(REPO_A, 'BUG-SEMRAG-SIM', 'distant neighbour');
    backend.setVector(near.nodeId, [1, 0, 0]);
    backend.setVector(mid.nodeId, [0.7, 0.7, 0]);
    backend.setVector(far.nodeId, [0, 1, 0]);
    backend.setQueryVector('seed query', [1, 0, 0]);

    const data = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { semantic: 'seed query', repo: REPO_A } }));
    expect(ids(data.items)).toEqual([near.humanId, mid.humanId, far.humanId]);
  });

  it('filter.anchor uses the anchor item\'s OWN indexed vector and excludes the anchor from its own results', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const anchor = await seed(REPO_A, 'BUG-SEMRAG-ANCHOR', 'anchor item');
    const neighbour = await seed(REPO_A, 'BUG-SEMRAG-ANCHOR', 'a close neighbour');
    backend.setVector(anchor.nodeId, [1, 0, 0]);
    backend.setVector(neighbour.nodeId, [0.99, 0.01, 0]);

    const data = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { anchor: anchor.humanId, repo: REPO_A } }));
    expect(ids(data.items)).toEqual([neighbour.humanId]);
    expect(ids(data.items)).not.toContain(anchor.humanId);
  });

  it('a soft-deleted item never appears as a neighbour, even if its vector is still indexed', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const alive = await seed(REPO_A, 'BUG-SEMRAG-DEL', 'still alive item');
    const deleted = await seed(REPO_A, 'BUG-SEMRAG-DEL', 'soon to be deleted item');
    backend.setVector(alive.nodeId, [1, 0, 0]);
    backend.setVector(deleted.nodeId, [1, 0, 0]);
    backend.setQueryVector('find items', [1, 0, 0]);

    // `softDeleteItemNode` already calls `deleteVector` (crud.ts) — re-insert
    // the vector afterward so THIS test proves query.ts's own liveness guard
    // (node.tInvalid / isLiveBacklogItemNode), not crud.ts's cleanup.
    await softDeleteItemNode(tmp.store, REPO_A, deleted.humanId, 'test: proving neighbours exclude tombstones');
    backend.setVector(deleted.nodeId, [1, 0, 0]);

    const data = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { semantic: 'find items', repo: REPO_A } }));
    expect(ids(data.items)).toEqual([alive.humanId]);
  });
});

describe('configured: dimensional pushdown (RAG-SPEC §3.1, load-bearing)', () => {
  it('a repo-scoped semantic search with a small k returns exactly k in-repo rows and ZERO out-of-repo rows', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const K = 3;
    // MORE matching (in-repo) items than k, PLUS non-matching (other-repo)
    // items that are STRICTLY BETTER cosine matches to the query, and at
    // least K of them. This is deliberate: with an all-tied vector set, a
    // stable sort resolves ties by Map insertion order, and if REPO_A happens
    // to be seeded first a broken post-filter implementation (fetch top-k
    // across BOTH repos, THEN filter to REPO_A) would still accidentally
    // return K in-repo/0 out-of-repo rows — the assertion below would pass
    // for the WRONG reason and the test would have no teeth. Making REPO_B
    // the closer match means an unfiltered top-K is entirely REPO_B: a
    // post-filter implementation yields ZERO rows here, a real `NodeFilter`
    // pushdown (which excludes REPO_B from candidacy before `k` is ever
    // applied) yields exactly K REPO_A rows. Only pushdown can pass this.
    const inRepo: string[] = [];
    for (let i = 0; i < K + 4; i += 1) {
      const item = await seed(REPO_A, 'BUG-SEMRAG-PUSHDOWN', `in-repo candidate ${i}`);
      backend.setVector(item.nodeId, [0.9, 0.1, 0]);
      inRepo.push(item.humanId);
    }
    for (let i = 0; i < K + 4; i += 1) {
      const item = await seed(REPO_B, 'BUG-SEMRAG-PUSHDOWN', `other-repo candidate ${i}`);
      backend.setVector(item.nodeId, [1, 0, 0]);
    }
    backend.setQueryVector('pushdown probe', [1, 0, 0]);

    const data = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { semantic: 'pushdown probe', repo: REPO_A }, limit: K }));
    expect(data.items).toHaveLength(K);
    for (const card of data.items ?? []) {
      expect(inRepo).toContain(card.humanId);
    }

    // The pushdown itself, made visible: the NodeFilter the backend actually
    // received names REPO_A — proving the restriction travelled INTO `knn`,
    // never applied after the fact.
    const lastCall = backend.knnCalls.at(-1);
    expect(lastCall?.filter?.namespace).toBe(REPO_A);
  });
});

describe('configured: grep stays pure FTS (RAG-SPEC §3.1 guard)', () => {
  it('a pure filter.grep query never touches the vector channel', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    await seed(REPO_A, 'BUG-SEMRAG-GREPONLY', 'keyword matched item unresponsive');
    await seed(REPO_A, 'BUG-SEMRAG-GREPONLY', 'unrelated other item');

    // `createItemNode` (RAG-SPEC §2, another agent's write-path scope) already
    // schedules an async best-effort embed on creation when a backend is
    // configured — that's real, correct write-path behavior and orthogonal to
    // this test. Snapshot AFTER seeding so the assertion below is scoped to
    // exactly what `backlogQuery`'s READ path itself did, not fixture setup.
    const embedCallsBeforeQuery = backend.embedQueryCalls.length;
    const knnCallsBeforeQuery = backend.knnCalls.length;

    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO_A, grep: 'unresponsive' } }));
    expect(data.items).toHaveLength(1);

    expect(backend.embedQueryCalls.length - embedCallsBeforeQuery).toBe(0);
    expect(backend.knnCalls.length - knnCallsBeforeQuery).toBe(0);
  });

  it('grep and semantic compose additively (AC-11) — a grep-only hit is never dropped when semantic also runs', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const grepOnly = await seed(REPO_A, 'BUG-SEMRAG-ADDITIVE', 'unresponsive keyword hit');
    const semanticOnly = await seed(REPO_A, 'BUG-SEMRAG-ADDITIVE', 'semantically close item');
    backend.setVector(semanticOnly.nodeId, [1, 0, 0]);
    backend.setQueryVector('vector probe', [1, 0, 0]);

    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO_A, grep: 'unresponsive', semantic: 'vector probe' } }));
    expect(new Set(ids(data.items))).toEqual(new Set([grepOnly.humanId, semanticOnly.humanId]));
  });
});

describe('configured: fields:["_score"] / fields:["_vector"] projection (AC-20)', () => {
  it('populate ONLY when named, and _score reflects the vector channel score', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const item = await seed(REPO_A, 'BUG-SEMRAG-FIELDS', 'scored item');
    backend.setVector(item.nodeId, [1, 0, 0]);
    backend.setQueryVector('score probe', [1, 0, 0]);

    const withFields = ok(
      await backlogQuery(tmp.store, { filter: { repo: REPO_A, semantic: 'score probe' }, fields: ['_score', '_vector'] })
    );
    const card = (withFields.items ?? []).find((c) => c.humanId === item.humanId);
    expect(card?._score).toBeCloseTo(1, 5);
    expect(card?._vector).toEqual([1, 0, 0]);

    const withoutFields = ok(await backlogQuery(tmp.store, { filter: { repo: REPO_A, semantic: 'score probe' } }));
    const plainCard = (withoutFields.items ?? []).find((c) => c.humanId === item.humanId);
    expect(plainCard?._score).toBeUndefined();
    expect(plainCard?._vector).toBeUndefined();
  });

  it('backlog_get also serves fields:["_vector"] once configured', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const item = await seed(REPO_A, 'BUG-SEMRAG-GETVEC', 'gettable item');
    // Exactly representable in float32 (unlike 0.1/0.2/0.3, whose
    // `Float32Array` round-trip is `0.10000000149011612` etc.) — the read
    // path stores/returns `Float32Array`s (`vectorFor`'s real contract), so
    // this test must use values that survive that round-trip exactly rather
    // than accidentally depending on float32/float64 rounding matching.
    backend.setVector(item.nodeId, [0.25, 0.5, -0.75]);

    const env = await backlogGet(tmp.store, { humanId: item.humanId, repo: REPO_A, fields: ['_vector'] });
    if (!isOutcomeOk(env)) throw new Error(`expected ok, got ${env.error.code}: ${env.error.message}`);
    expect(env.data._vector).toEqual([0.25, 0.5, -0.75]);
  });
});

describe('configured: sort:"relevance" orders by the vector channel score', () => {
  it('descending by default', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const best = await seed(REPO_A, 'BUG-SEMRAG-SORT', 'best match');
    const worst = await seed(REPO_A, 'BUG-SEMRAG-SORT', 'worst match');
    const mid = await seed(REPO_A, 'BUG-SEMRAG-SORT', 'mid match');
    backend.setVector(best.nodeId, [1, 0, 0]);
    backend.setVector(mid.nodeId, [0.5, 0.5, 0]);
    backend.setVector(worst.nodeId, [0, 1, 0]);
    backend.setQueryVector('rank probe', [1, 0, 0]);

    const data = ok(await backlogQuery(tmp.store, { filter: { repo: REPO_A, semantic: 'rank probe' }, sort: 'relevance' }));
    expect(ids(data.items)).toEqual([best.humanId, mid.humanId, worst.humanId]);
  });
});
