/**
 * plan-graph-intelligence.spec.ts — RAG-SPEC §5's plan-graph intelligence:
 * `blockerImpact` (`view:"order"` + `filter.humanId`), `recommendNextWork`
 * (`view:"ready"` + `sort:"impact"`), and `suggestRelated`/
 * `suggestDependencies` (`view:"similar"` + `filter.anchor`'s
 * `suggestedRelated`/`suggestedDependencies` payload fields).
 *
 * `blockerImpact`/`recommendNextWork` are PURE `DEPENDS_ON` graph traversal
 * (RAG-SPEC §5: "no embedding dependency") — every test in their two
 * `describe` blocks below runs with NO semantic backend configured, proving
 * that statement rather than assuming it. `suggestRelated`/
 * `suggestDependencies` are the opposite: they need a real KNN, so those
 * tests inject the SAME kind of fake, deterministic `SemanticBackend`
 * `semantic-read-path.spec.ts` uses (a real backend, a faked embedding
 * model) — no model download, no network.
 *
 * §7 discipline: every test opens a real Turso-backed store under
 * `tmp/backlog/` via `openTmpStore` and cleans up in `afterEach`, which runs
 * even when the test body throws; `afterEach` also unconditionally clears
 * any injected semantic backend so a leaked fake never contaminates another
 * suite's "unconfigured by default" assumption.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeFilter } from '@adhd/sox-graph-store';
import { isOutcomeError, isOutcomeOk, type IBacklogCard, type IOutcomeEnvelope } from '../model.js';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from '../store/crud.js';
import { addDependencyNode, linkRelatedNode } from '../store/structure.js';
import { claimItemNode } from '../store/claim.js';
import { configureSemanticBackend, type SemanticBackend, type SemanticHealth, type SemanticMatch } from '../store/semantic-search.js';
import { backlogQuery, computeBlockerImpact, type IBacklogQueryResult } from './query.js';

const REPO = 'plan-graph-repo';

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('plan-graph-intelligence');
});

afterEach(async () => {
  configureSemanticBackend(null);
  await tmp.cleanup();
});

// ----------------------------------------------------------------------------
// Fixture helpers.
// ----------------------------------------------------------------------------

async function seed(title: string, opts: { priority?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' } = {}): Promise<{ humanId: string; nodeId: number }> {
  const result = await createItemNode(tmp.store, { family: 'BUG-PG', title, body: `body for ${title}`, repo: REPO, force: true, ...opts });
  if (!result.created) throw new Error(`fixture: create suppressed for ${JSON.stringify(title)}`);
  return { humanId: result.item.humanId, nodeId: result.item.nodeId };
}

/** `dependsOnHumanId` is `humanId`'s DEPENDS_ON target, i.e. `humanId` depends on `dependsOnHumanId` (the direction `addDependencyNode` itself uses). */
async function dependsOn(humanId: string, dependsOnHumanId: string): Promise<void> {
  await addDependencyNode(tmp.store, REPO, humanId, dependsOnHumanId);
}

function ok(env: IOutcomeEnvelope<IBacklogQueryResult>): IBacklogQueryResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

/** Whole-`edge`-table fingerprint — DoD #4's "byte-identical before/after" snapshot, over EVERY edge in the store, not just a fixture subset. */
async function edgeTableSnapshot(store: TmpStore['store']): Promise<string> {
  const { rows } = await store.adapter.executeAll(
    `SELECT rowid, src, dst, rel, weight, origin, meta, t_created, t_valid, t_invalid FROM edge ORDER BY rowid`
  );
  return JSON.stringify(rows);
}

// ----------------------------------------------------------------------------
// DoD #5 — `blockerImpact`: a real transitive cone, chain A→B→C→D.
// ----------------------------------------------------------------------------

describe('blockerImpact (view:"order" + filter.humanId) — RAG-SPEC §5 / AC-30', () => {
  it('reports the exact transitive backward-reachable cone on a real DEPENDS_ON chain, with no semantic backend configured', async () => {
    const a = await seed('A');
    const b = await seed('B');
    const c = await seed('C');
    const d = await seed('D');
    // A depends on B depends on C depends on D — resolving D unblocks C, then B, then A.
    await dependsOn(a.humanId, b.humanId);
    await dependsOn(b.humanId, c.humanId);
    await dependsOn(c.humanId, d.humanId);

    const env = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO, humanId: d.humanId } }));
    expect(env.blockerImpact).toBeDefined();
    expect(env.blockerImpact?.humanId).toBe(d.humanId);
    expect(env.blockerImpact?.impactedCount).toBe(3);
    expect(env.blockerImpact?.impactedOpenCount).toBe(3);
    // Sorted membership, not just the count — a direction flip on a
    // symmetric fixture can still produce the right NUMBER by accident.
    expect([...(env.blockerImpact?.impactedHumanIds ?? [])].sort()).toEqual([a.humanId, b.humanId, c.humanId].sort());

    // The other end of the same chain: nothing depends ON A, so resolving A
    // unblocks nothing. Pins the traversal direction unambiguously — a
    // reversed adjacency map would report A's cone as non-empty too.
    const reverseEnv = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO, humanId: a.humanId } }));
    expect(reverseEnv.blockerImpact?.impactedCount).toBe(0);
    expect(reverseEnv.blockerImpact?.impactedHumanIds).toEqual([]);
  });

  it('NEGATIVE CONTROL: capping traversal depth at 1 drops the same chain\'s count from 3 to 1, proving transitivity is genuinely exercised', async () => {
    const a = await seed('A2');
    const b = await seed('B2');
    const c = await seed('C2');
    const d = await seed('D2');
    await dependsOn(a.humanId, b.humanId);
    await dependsOn(b.humanId, c.humanId);
    await dependsOn(c.humanId, d.humanId);

    // Build the same reverse adjacency `view:"order"` builds internally, and
    // call the traversal directly with maxDepth to prove the depth cap
    // (there is no public query-surface knob for it — the cap exists so
    // THIS negative control is a real call with a different argument, not a
    // code edit).
    const dependents = new Map<string, string[]>([
      [d.humanId, [c.humanId]],
      [c.humanId, [b.humanId]],
      [b.humanId, [a.humanId]],
      [a.humanId, []],
    ]);
    const statusByHumanId = new Map([
      [a.humanId, 'OPEN' as const],
      [b.humanId, 'OPEN' as const],
      [c.humanId, 'OPEN' as const],
      [d.humanId, 'OPEN' as const],
    ]);

    const unbounded = computeBlockerImpact(dependents, statusByHumanId, d.humanId);
    expect(unbounded.impactedCount).toBe(3);

    const capped = computeBlockerImpact(dependents, statusByHumanId, d.humanId, 1);
    expect(capped.impactedCount).toBe(1);
    expect(capped.impactedHumanIds).toEqual([c.humanId]);
  });

  it('terminates and returns a sane count on a CYCLIC graph (A depends on B, B depends on A) — never hangs', async () => {
    const a = await seed('CYCLE-A');
    const b = await seed('CYCLE-B');
    await dependsOn(a.humanId, b.humanId);
    await dependsOn(b.humanId, a.humanId);

    const env = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO, humanId: a.humanId } }));
    // A's dependents-cone: B depends on A (direct), and A depends on B — so
    // the reverse walk from A reaches B once and stops (B's own dependents
    // set contains A, already seen). The exact count that matters here is
    // that the call returns AT ALL with a finite, non-negative answer.
    expect(env.blockerImpact).toBeDefined();
    expect(env.blockerImpact?.impactedCount).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(env.blockerImpact?.impactedCount)).toBe(true);
    expect(env.blockerImpact?.impactedHumanIds.length).toBe(env.blockerImpact?.impactedCount);
  });

  it('item_not_found for a humanId outside the scope', async () => {
    const env = await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO, humanId: 'BUG-PG-DOES-NOT-EXIST' } });
    expect(isOutcomeError(env) && env.error.code).toBe('item_not_found');
  });
});

// ----------------------------------------------------------------------------
// `recommendNextWork` — view:"ready" + sort:"impact".
// ----------------------------------------------------------------------------

describe('recommendNextWork (view:"ready" + sort:"impact") — RAG-SPEC §5, no semantic backend configured', () => {
  it('ranks a critical-path item ahead of an off-path item of EQUAL priority', async () => {
    // Chain: A depends on B depends on C depends on D (D is the leaf, so D
    // is claimable NOW). E is an isolated item, also claimable now, same
    // priority as D — the only distinguishing signal is critical-path
    // position + impact cone.
    const a = await seed('RANK-A', { priority: 'MEDIUM' });
    const b = await seed('RANK-B', { priority: 'MEDIUM' });
    const c = await seed('RANK-C', { priority: 'MEDIUM' });
    const d = await seed('RANK-D', { priority: 'MEDIUM' });
    const e = await seed('RANK-E', { priority: 'MEDIUM' });
    await dependsOn(a.humanId, b.humanId);
    await dependsOn(b.humanId, c.humanId);
    await dependsOn(c.humanId, d.humanId);

    const env = ok(await backlogQuery(tmp.store, { view: 'ready', sort: 'impact', filter: { repo: REPO, family: 'BUG-PG' } }));
    const humanIds = (env.items ?? []).map((it) => it.humanId);
    expect(humanIds).toContain(d.humanId);
    expect(humanIds).toContain(e.humanId);
    expect(humanIds.indexOf(d.humanId)).toBeLessThan(humanIds.indexOf(e.humanId));
  });

  it('excludes claimed items from the ranking', async () => {
    const claimed = await seed('CLAIM-1', { priority: 'HIGH' });
    const free = await seed('CLAIM-2', { priority: 'LOW' });
    await claimItemNode(tmp.store, claimed.nodeId, 'agent-x');

    const env = ok(await backlogQuery(tmp.store, { view: 'ready', sort: 'impact', filter: { repo: REPO, family: 'BUG-PG' } }));
    const humanIds = (env.items ?? []).map((it) => it.humanId);
    expect(humanIds).not.toContain(claimed.humanId);
    expect(humanIds).toContain(free.humanId);
  });

  it('sort:"impact" is rejected with invalid_argument on any view other than "ready"', async () => {
    const env = await backlogQuery(tmp.store, { view: 'list', sort: 'impact' });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

// ----------------------------------------------------------------------------
// The fake semantic backend — a real SemanticBackend, a fake embedding model
// (lifted from semantic-read-path.spec.ts's own pattern).
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

class FakeSemanticBackend implements SemanticBackend {
  readonly modelId = 'fake:plan-graph-intelligence-v1';
  readonly dim = 3;
  readonly vectors = new Map<number, Float32Array>();

  constructor(private readonly store: TmpStore['store']) {}

  setVector(nodeId: number, vec: number[]): void {
    this.vectors.set(nodeId, Float32Array.from(vec));
  }

  async embedQuery(): Promise<Float32Array> {
    throw new Error('FakeSemanticBackend.embedQuery: this suite seeds every candidate via filter.anchor, never free-text semantic');
  }

  async embedDocument(): Promise<Float32Array> {
    return this.embedQuery();
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
    const scored: SemanticMatch[] = [];
    for (const [nodeId, vec] of this.vectors) {
      if (opts?.ids !== undefined && !opts.ids.includes(nodeId)) continue;
      if (opts?.filter !== undefined && !(await this.matchesFilter(nodeId, opts.filter))) continue;
      scored.push({ nodeId, score: cosineSimilarity(query, vec) });
    }
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
    return true;
  }
}

function ids(cards: readonly IBacklogCard[] | undefined): string[] {
  return (cards ?? []).map((c) => c.humanId);
}

// ----------------------------------------------------------------------------
// `suggestRelated` / `suggestDependencies` — view:"similar" + filter.anchor.
// ----------------------------------------------------------------------------

describe('suggestRelated / suggestDependencies (view:"similar" + filter.anchor) — RAG-SPEC §5', () => {
  it('DoD #4: returns correct candidates AND the edge table is byte-identical before and after the call', async () => {
    const anchor = await seed('SUGGEST-ANCHOR');
    const near = await seed('SUGGEST-NEAR');
    const far = await seed('SUGGEST-FAR');

    const backend = new FakeSemanticBackend(tmp.store);
    backend.setVector(anchor.nodeId, [1, 0, 0]);
    backend.setVector(near.nodeId, [0.99, 0.01, 0]); // nearly identical — a real candidate
    backend.setVector(far.nodeId, [0, 0, 1]); // orthogonal — should rank last / be excludable by k
    configureSemanticBackend(backend);

    const before = await edgeTableSnapshot(tmp.store);
    const env = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { repo: REPO, anchor: anchor.humanId } }));
    const after = await edgeTableSnapshot(tmp.store);

    // The candidates are correct: `near` shows up as a suggestion, ranked
    // above `far`, and the anchor itself never appears (it is the seed, not
    // a candidate for itself).
    expect(ids(env.suggestedRelated?.map((h) => h.item))).toContain(near.humanId);
    expect(ids(env.suggestedRelated?.map((h) => h.item))).not.toContain(anchor.humanId);
    const dependencyIds = env.suggestedDependencies?.map((s) => s.hit.item.humanId) ?? [];
    expect(dependencyIds).toContain(near.humanId);
    expect(dependencyIds).toContain(far.humanId);

    // DoD #4's teeth: the snapshot helper must actually DETECT a real
    // mutation, or an "unchanged" assertion is vacuous. Write one genuine
    // RELATES_TO edge and prove the snapshot differs.
    const mutatedSnapshot = async (): Promise<string> => {
      await linkRelatedNode(tmp.store, REPO, anchor.humanId, far.humanId);
      return edgeTableSnapshot(tmp.store);
    };
    const afterRealWrite = await mutatedSnapshot();
    expect(afterRealWrite).not.toBe(after);

    // Now the actual assertion this DoD exists for: `suggestDependencies`
    // itself performed NO write. `before` and `after` (both captured around
    // the read-only call, before the real-write control above) must be
    // byte-identical.
    expect(after).toBe(before);
  });

  it('never returns a directional DEPENDS_ON suggestion — only non-directional RELATES_TO', async () => {
    const anchor = await seed('DIR-ANCHOR');
    const near = await seed('DIR-NEAR');
    const backend = new FakeSemanticBackend(tmp.store);
    backend.setVector(anchor.nodeId, [1, 0, 0]);
    backend.setVector(near.nodeId, [0.9, 0.1, 0]);
    configureSemanticBackend(backend);

    const env = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { repo: REPO, anchor: anchor.humanId } }));
    expect(env.suggestedDependencies?.length ?? 0).toBeGreaterThan(0);
    for (const suggestion of env.suggestedDependencies ?? []) {
      expect(suggestion.rel).toBe('RELATES_TO');
    }
  });

  it('excludes a candidate already connected to the anchor by a live edge (either direction)', async () => {
    const anchor = await seed('EXCL-ANCHOR');
    const alreadyLinked = await seed('EXCL-LINKED');
    const fresh = await seed('EXCL-FRESH');
    await linkRelatedNode(tmp.store, REPO, anchor.humanId, alreadyLinked.humanId);

    const backend = new FakeSemanticBackend(tmp.store);
    backend.setVector(anchor.nodeId, [1, 0, 0]);
    backend.setVector(alreadyLinked.nodeId, [0.99, 0.01, 0]);
    backend.setVector(fresh.nodeId, [0.9, 0.1, 0]);
    configureSemanticBackend(backend);

    const env = ok(await backlogQuery(tmp.store, { view: 'similar', filter: { repo: REPO, anchor: anchor.humanId } }));
    const dependencyIds = env.suggestedDependencies?.map((s) => s.hit.item.humanId) ?? [];
    expect(dependencyIds).not.toContain(alreadyLinked.humanId);
    expect(dependencyIds).toContain(fresh.humanId);
    // suggestedRelated is NOT filtered by existing edges — it is the plain
    // similarity read, unlike suggestedDependencies's "is this NEW" filter.
    expect(ids(env.suggestedRelated?.map((h) => h.item))).toContain(alreadyLinked.humanId);
  });
});

// ----------------------------------------------------------------------------
// DoD #7 — degrade cleanly when unconfigured.
// ----------------------------------------------------------------------------

describe('unconfigured store — RAG-SPEC §5 degrade contract', () => {
  it('suggestRelated / suggestDependencies (view:"similar") throw rag_not_configured', async () => {
    const env = await backlogQuery(tmp.store, { view: 'similar', filter: { repo: REPO, semantic: 'anything' } });
    expect(isOutcomeError(env) && env.error.code).toBe('rag_not_configured');
  });

  it('blockerImpact (view:"order") is pure traversal — works with NO backend configured', async () => {
    const a = await seed('UNCFG-A');
    const b = await seed('UNCFG-B');
    await dependsOn(a.humanId, b.humanId);
    const env = ok(await backlogQuery(tmp.store, { view: 'order', filter: { repo: REPO, humanId: b.humanId } }));
    expect(env.blockerImpact?.impactedCount).toBe(1);
    expect(env.blockerImpact?.impactedHumanIds).toEqual([a.humanId]);
  });

  it('recommendNextWork (view:"ready" + sort:"impact") is pure traversal — works with NO backend configured', async () => {
    await seed('UNCFG-READY');
    const env = ok(await backlogQuery(tmp.store, { view: 'ready', sort: 'impact', filter: { repo: REPO, family: 'BUG-PG' } }));
    expect(env.items).toBeDefined();
  });
});
