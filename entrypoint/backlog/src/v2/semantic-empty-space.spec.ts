/**
 * semantic-empty-space.spec.ts — BUG-045: a configured backend over an EMPTY
 * vector space is reported as DISABLED, not served as an empty result.
 *
 * ## The bug this pins
 *
 * `embedding.enabled` and "this store can answer a similarity query" are
 * different facts. With the flag on and zero items embedded, every semantic
 * read used to succeed: `"host contract ownership"`, `"javascript bundler
 * tree shaking"` and `"zzzz nonsense qqqq"` all returned the SAME arbitrary
 * page in the SAME order with `_score: null`. That reads as a working search
 * and is wrong for every input — strictly worse than the honest AC-12
 * refusal the unconfigured build already gives.
 *
 * So the inversion: an unbackfilled space presents as disabled and falls into
 * the existing `rag_not_configured` outcome, distinguished only by its
 * message (`empty_vector_space` vs `not_configured`).
 *
 * ## Why these assertions have teeth
 *
 * The negative control is built in. `two different semantic queries` below is
 * the exact discriminator the old code failed: before the fix both queries
 * returned an identical `ok` page, so an equality assertion PASSED on broken
 * code. Asserting that both now THROW is the assertion that goes red the
 * moment the readable-gate is removed from `assertNoSemanticInputs` — proven
 * by `git stash`-free negative control: revert `isSemanticSearchReadable()`
 * to `isSemanticSearchConfigured()` in `v2/query.ts` and this suite fails.
 *
 * The deadlock guard is equally load-bearing: an over-broad fix that widened
 * `isSemanticSearchConfigured()` itself would make an empty store permanently
 * unfillable, because `embedding_backfill` — the operation that populates it —
 * checks that same predicate. `write path still works` pins that open.
 *
 * §7 discipline: real Turso store under `tmp/`, removed in `afterEach`; the
 * injected backend is cleared unconditionally so no other suite inherits it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeFilter } from '@adhd/sox-graph-store';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import type { BacklogCtx } from '../client.js';
import { createItemNode } from '../store/crud.js';
import {
  configureSemanticBackend,
  isSemanticSearchConfigured,
  isSemanticSearchReadable,
  requireReadableSemanticBackend,
  requireSemanticBackend,
  type SemanticBackend,
  type SemanticHealth,
  type SemanticMatch,
} from '../store/semantic-search.js';
import { RagNotConfiguredError, isOutcomeError, isOutcomeOk, type IOutcomeEnvelope } from '../model.js';
import { backlogQuery, type IBacklogQueryResult } from './query.js';
import { backlogGet } from './get.js';
import { backlogAdmin } from './admin.js';

const REPO = 'emptyspace-repo';
const AGENT = 'semantic-empty-space-spec-agent';

let tmp: TmpStore;
let ctx: BacklogCtx;
let adhdRoot: string;
let backend: CountingFakeBackend;

/**
 * A real `SemanticBackend` whose vector map starts EMPTY — exactly the state
 * a freshly-enabled, never-backfilled store is in. `embedDocument` is a
 * deterministic hash rather than a lookup table, so the REAL write path
 * (`createItemNode` → `scheduleEmbed` → `upsertVector`) can populate it.
 */
class CountingFakeBackend implements SemanticBackend {
  readonly modelId = 'fake:empty-space-v1';
  readonly dim = 3;
  readonly vectors = new Map<number, Float32Array>();
  knnCalls = 0;

  private hashVec(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (let i = 0; i < text.length; i += 1) {
      const idx = i % this.dim;
      v[idx] = (v[idx] ?? 0) + text.charCodeAt(i);
    }
    return v;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.hashVec(text);
  }
  async embedDocument(text: string): Promise<Float32Array> {
    return this.hashVec(text);
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
  async knn(_query: Float32Array, k: number, _opts?: { filter?: NodeFilter; ids?: number[] }): Promise<SemanticMatch[]> {
    this.knnCalls += 1;
    return [...this.vectors.keys()].slice(0, k).map((nodeId) => ({ nodeId, score: 0.5 }));
  }
  async *iterVectors(): AsyncIterable<{ nodeId: number; vec: Float32Array }> {
    for (const [nodeId, vec] of this.vectors) yield { nodeId, vec };
  }
  async health(): Promise<SemanticHealth> {
    return { configured: 'fake:test', active: this.modelId, state: 'real', dimensions: this.dim, last_error: null };
  }
}

beforeEach(async () => {
  tmp = await openTmpStore('semantic-empty-space');
  adhdRoot = mkdtempSync(join(tmpdir(), 'empty-space-env-'));
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'global', adhdRoot }), adhdRoot };
  backend = new CountingFakeBackend();
  // Exactly what the real host does after `bootstrapSemanticBackend` probes
  // a space and finds it empty (`enableSemanticSearchFromConfig`).
  configureSemanticBackend(backend, { vectorSpacePopulated: false });
});

afterEach(async () => {
  configureSemanticBackend(null);
  try {
    await tmp.cleanup();
  } finally {
    rmSync(adhdRoot, { recursive: true, force: true });
  }
});

function ok(env: IOutcomeEnvelope<IBacklogQueryResult>): IBacklogQueryResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

async function seed(title: string, family = 'BUG-EMPTYSPACE'): Promise<{ humanId: string; nodeId: number }> {
  const result = await createItemNode(tmp.store, { family, title, body: `${title} body`, repo: REPO, force: true });
  if (!result.created) throw new Error(`fixture: create suppressed for ${JSON.stringify(title)}`);
  return { humanId: result.item.humanId, nodeId: result.item.nodeId };
}

/**
 * The ACTUAL BUG-045 shape: items that predate the backend. RAG was switched
 * on over a store of 1420 items written before embeddings existed, so they
 * carry no vectors and nothing has backfilled them.
 *
 * Seeding with the backend detached is not a shortcut around the write path —
 * it IS the write path, exercised in the configuration those items were
 * actually created under (`scheduleEmbed` no-ops when no backend is
 * installed). Re-attaching afterwards with `vectorSpacePopulated: false`
 * reproduces the enable-without-backfill step exactly.
 */
async function seedPredatingTheBackend(title: string, family = 'BUG-EMPTYSPACE'): Promise<{ humanId: string; nodeId: number }> {
  configureSemanticBackend(null);
  try {
    return await seed(title, family);
  } finally {
    configureSemanticBackend(backend, { vectorSpacePopulated: false });
  }
}

// ----------------------------------------------------------------------------
// The predicates themselves.
// ----------------------------------------------------------------------------

describe('the two predicates mean different things', () => {
  it('an empty space is CONFIGURED (writes allowed) but not READABLE (ranking refused)', () => {
    expect(isSemanticSearchConfigured()).toBe(true);
    expect(isSemanticSearchReadable()).toBe(false);
    expect(() => requireSemanticBackend('write')).not.toThrow();
    expect(() => requireReadableSemanticBackend('read')).toThrow(RagNotConfiguredError);
  });

  it('names the empty space as the cause, and the backfill as the remedy', () => {
    try {
      requireReadableSemanticBackend('filter.semantic');
      throw new Error('expected requireReadableSemanticBackend to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagNotConfiguredError);
      const e = err as RagNotConfiguredError;
      expect(e.reason).toBe('empty_vector_space');
      expect(e.message).toContain('zero items have been embedded');
      expect(e.message).toContain('embedding_backfill');
      // NOT the unconfigured message — the two causes are distinguishable.
      expect(e.message).not.toContain('none is available');
    }
  });

  it('clearing the backend resets readability (no leaked "populated" across configures)', () => {
    configureSemanticBackend(null);
    expect(isSemanticSearchConfigured()).toBe(false);
    expect(isSemanticSearchReadable()).toBe(false);
    configureSemanticBackend(backend, { vectorSpacePopulated: false });
    expect(isSemanticSearchReadable()).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// THE negative control — the assertion the old code could not pass.
// ----------------------------------------------------------------------------

describe('read path: an empty space refuses instead of ranking nothing', () => {
  it('two different semantic queries both refuse — they no longer return the same arbitrary page', async () => {
    await seedPredatingTheBackend('sign in button unresponsive');
    await seedPredatingTheBackend('database connection pool exhausted');
    await seedPredatingTheBackend('flaky snapshot test in CI');

    expect(backend.vectors.size, 'fixture: the space must be EMPTY for this test to mean anything').toBe(0);

    const meaningful = await backlogQuery(tmp.store, { filter: { repo: REPO, semantic: 'authentication is broken' } } as never);
    const gibberish = await backlogQuery(tmp.store, { filter: { repo: REPO, semantic: 'zzzz nonsense qqqq' } } as never);

    // Before the fix BOTH of these were `ok` with identical items and
    // `_score: null` — indistinguishable from a working search.
    for (const env of [meaningful, gibberish]) {
      expect(isOutcomeError(env)).toBe(true);
      expect(isOutcomeError(env) && env.error.code).toBe('rag_not_configured');
      expect(isOutcomeError(env) && env.error.message).toContain('zero items have been embedded');
    }

    // And it refused BEFORE reaching the backend — no wasted embed, no
    // scoreless page assembled and then thrown away.
    expect(backend.knnCalls).toBe(0);
  });

  it('every semantic input refuses: semantic, anchor, view:similar, sort:relevance, _score, _vector', async () => {
    const { humanId } = await seedPredatingTheBackend('anchor target item');
    const cases: Array<Record<string, unknown>> = [
      { filter: { semantic: 'sign-in button unresponsive' } },
      { filter: { anchor: humanId } },
      { view: 'similar', filter: { semantic: 'x' } },
      { sort: 'relevance' },
      { fields: ['_score'] },
      { fields: ['_vector'] },
    ];
    for (const input of cases) {
      const env = await backlogQuery(tmp.store, input as never);
      expect(isOutcomeError(env) && env.error.code, JSON.stringify(input)).toBe('rag_not_configured');
    }

    const getEnv = await backlogGet(tmp.store, { humanId, repo: REPO, fields: ['_vector'] } as never);
    expect(isOutcomeError(getEnv) && getEnv.error.code).toBe('rag_not_configured');
  });

  it('the keyword channel is untouched — grep still discriminates', async () => {
    await seedPredatingTheBackend('sign in button unresponsive');
    await seedPredatingTheBackend('totally unrelated item');
    const hit = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, grep: 'unresponsive' } } as never));
    expect(hit.items).toHaveLength(1);
    const miss = ok(await backlogQuery(tmp.store, { filter: { repo: REPO, grep: 'zzzzqqqq' } } as never));
    expect(miss.items ?? []).toHaveLength(0);
  });

  it('a natural-language `text` query compiles into grep rather than throwing', async () => {
    await seedPredatingTheBackend('sign in button unresponsive');
    // With a READABLE space this routes into `filter.semantic`; with an empty
    // one it must behave exactly as the unconfigured build does.
    const data = ok(await backlogQuery(tmp.store, { text: 'unresponsive', filter: { repo: REPO } } as never));
    expect((data.items ?? []).length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// The deadlock guard — the fix must not lock the store out of being filled.
// ----------------------------------------------------------------------------

describe('write path stays open on an empty space (no chicken-and-egg)', () => {
  it('embedding_health answers instead of refusing', async () => {
    const env = await backlogAdmin(ctx, { action: 'embedding_health' } as never);
    expect(isOutcomeOk(env)).toBe(true);
  });

  it('embedding_backfill runs — it is the operation that ENDS the empty state', async () => {
    await seedPredatingTheBackend('an item that needs embedding');
    const env = await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: true } } as never);
    expect(isOutcomeOk(env), isOutcomeError(env) ? env.error.message : '').toBe(true);
  });

  it('the neighbour-RANKING admin actions still refuse — they have nothing to rank', async () => {
    for (const action of ['list_near_duplicates', 'run_dedup_sweep', 'cluster_into_plans']) {
      const env = await backlogAdmin(ctx, { action: action as never, by: AGENT } as never);
      expect(isOutcomeError(env) && env.error.code, `action=${action}`).toBe('rag_not_configured');
      expect(isOutcomeError(env) && env.error.message, `action=${action}`).toContain('zero items have been embedded');
    }
  });
});

// ----------------------------------------------------------------------------
// empty -> populated, through the REAL write path, with no restart.
// ----------------------------------------------------------------------------

describe('the space opens the moment a real vector lands', () => {
  it('createItem embeds through scheduleEmbed and semantic reads start answering', async () => {
    expect(isSemanticSearchReadable()).toBe(false);

    await seed('the first embedded item');
    // `scheduleEmbed` is fire-and-track; drain it the way the store's own
    // shutdown path does rather than sleeping.
    await tmp.store.flushEmbeds?.();

    expect(backend.vectors.size).toBeGreaterThan(0);
    expect(isSemanticSearchReadable()).toBe(true);

    const env = await backlogQuery(tmp.store, { filter: { repo: REPO, semantic: 'first embedded' } } as never);
    expect(isOutcomeOk(env), isOutcomeError(env) ? env.error.message : '').toBe(true);
    expect(backend.knnCalls).toBeGreaterThan(0);
  });
});
