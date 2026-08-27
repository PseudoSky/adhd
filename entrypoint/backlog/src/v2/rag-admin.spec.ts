/**
 * rag-admin.spec.ts — RAG-SPEC.md §4, §5, §7: the six EPIC-G `backlog_admin`
 * actions (`embedding_health`, `embedding_backfill`, `list_near_duplicates`,
 * `run_dedup_sweep`, `cluster_into_plans`, `promote_cluster_to_plan`), driven
 * through the REAL `backlogAdmin` entry point against a REAL Turso-backed
 * store (`openTmpStore`), with a FAKE deterministic `SemanticBackend`
 * injected via `configureSemanticBackend` — no model download, no network,
 * no `optionalDependencies` required to run this suite.
 *
 * The fake backend is not a stub of the code under test: `iterVectors`/
 * `vectorFor`/`knn` evaluate real `NodeFilter` predicates against the REAL
 * store's `NodeRecord`s (mirroring `semantic-read-path.spec.ts`'s own
 * `FakeSemanticBackend`). What is faked is only the embedding MODEL —
 * `embedDocument` never runs fastembed, and every call is counted so a dry
 * run can be PROVEN to have called the provider zero times.
 *
 * §7 discipline: every test opens a real store under `tmp/backlog/` and
 * removes it in `afterEach` (which vitest runs even when the test body
 * throws), and `afterEach` ALSO clears the injected backend
 * (`configureSemanticBackend(null)`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeFilter } from '@adhd/sox-graph-store';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import type { BacklogCtx } from '../client.js';
import { createItemNode, getItemNode } from '../store/crud.js';
import { mutateMetadata } from '../store/mutate-metadata.js';
import { computeContentHash, type BacklogNodeMeta } from '../store/mapping.js';
import {
  configureSemanticBackend,
  type SemanticBackend,
  type SemanticHealth,
  type SemanticMatch,
} from '../store/semantic-search.js';
import { isOutcomeError, isOutcomeOk, type IOutcomeEnvelope } from '../model.js';
import { backlogAdmin, type IAdminResult } from './admin.js';

const REPO = 'ragadmin-repo';
const AGENT = 'rag-admin-spec-agent';

let tmp: TmpStore;
let ctx: BacklogCtx;
let adhdRoot: string;

beforeEach(async () => {
  tmp = await openTmpStore('rag-admin-spec');
  adhdRoot = mkdtempSync(join(tmpdir(), 'rag-admin-env-'));
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'global', adhdRoot }), adhdRoot };
});

afterEach(async () => {
  configureSemanticBackend(null);
  try {
    await tmp.cleanup();
  } finally {
    rmSync(adhdRoot, { recursive: true, force: true });
  }
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

class FakeSemanticBackend implements SemanticBackend {
  readonly modelId = 'fake:rag-admin-v1';
  readonly dim = 3;
  readonly vectors = new Map<number, Float32Array>();
  readonly embedDocumentCalls: number[] = [];
  /** When set, `health()` reports this as `active`/`state:'real'`; otherwise it reports an unresolved backend (`active: null`). */
  resolvedModelId: string | null = null;

  constructor(private readonly store: TmpStore['store']) {}

  setVector(nodeId: number, vec: number[]): void {
    this.vectors.set(nodeId, Float32Array.from(vec));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedDocument(text);
  }

  async embedDocument(_text: string): Promise<Float32Array> {
    // Not content-addressed: the tests that need a specific vector always
    // call `setVector` directly (mirroring `scheduleEmbed`'s real upsert
    // step) rather than relying on this to derive one — this only exists so
    // `embedDocumentCalls` can be counted.
    this.embedDocumentCalls.push(this.embedDocumentCalls.length);
    return Float32Array.from([1, 0, 0]);
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
    if (this.resolvedModelId === null) {
      return { configured: 'fake:rag-admin', active: null, state: 'uninitialized', dimensions: null, last_error: null };
    }
    return {
      configured: 'fake:rag-admin',
      active: this.resolvedModelId,
      state: 'real',
      dimensions: this.dim,
      last_error: null,
      indexedCount: this.vectors.size,
    };
  }

  private async matchesFilter(nodeId: number, filter: NodeFilter): Promise<boolean> {
    const node = await this.store.graph.getNode(nodeId);
    if (!node) return false;
    if (filter.namespace !== undefined && node.namespace !== filter.namespace) return false;
    return true;
  }
}

// ----------------------------------------------------------------------------
// Fixture helpers.
// ----------------------------------------------------------------------------

async function seed(family: string, title: string, repo = REPO): Promise<{ humanId: string; nodeId: number }> {
  const result = await createItemNode(tmp.store, { family, title, body: `body of ${title}`, repo, force: true });
  if (!result.created) throw new Error(`fixture: create suppressed for ${JSON.stringify(title)}`);
  return { humanId: result.item.humanId, nodeId: result.item.nodeId };
}

function ok(env: IOutcomeEnvelope<IAdminResult>): IAdminResult {
  if (!isOutcomeOk(env)) throw new Error(`expected ok envelope, got ${env.error.code}: ${env.error.message}`);
  return env.data;
}

async function snapshotEdges(): Promise<unknown[]> {
  const { rows } = await tmp.store.adapter.executeAll<Record<string, unknown>>(
    `SELECT rowid, src, dst, rel, t_invalid FROM edge ORDER BY rowid`,
    []
  );
  return rows;
}

// ----------------------------------------------------------------------------
// Unconfigured: RAG-SPEC §8 DoD #7 preserved byte-for-byte for all six actions.
// ----------------------------------------------------------------------------

describe('unconfigured: every EPIC-G action still refuses with rag_not_configured', () => {
  it('preserves the exact message shape for all six actions', async () => {
    const actions: Array<{ action: string; params?: Record<string, unknown> }> = [
      { action: 'embedding_health' },
      { action: 'embedding_backfill' },
      { action: 'list_near_duplicates' },
      { action: 'run_dedup_sweep' },
      { action: 'cluster_into_plans' },
      { action: 'promote_cluster_to_plan', params: { candidateId: 1, planSlug: 'x' } },
    ];
    for (const { action, params } of actions) {
      const env = await backlogAdmin(ctx, { action: action as never, params, by: AGENT });
      expect(isOutcomeError(env) && env.error.code, `action=${action}`).toBe('rag_not_configured');
      expect(isOutcomeError(env) && env.error.message, `action=${action}`).toMatch(
        /needs a configured embedding backend and none is available/
      );
      expect(isOutcomeError(env) && env.error.message, `action=${action}`).toContain(`backlog_admin(${action})`);
    }
  });
});

// ----------------------------------------------------------------------------
// `embedding_health`.
// ----------------------------------------------------------------------------

describe('configured: embedding_health', () => {
  it('reports active:null for an unresolved backend, and the resolved id once resolved', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const unresolved = ok(await backlogAdmin(ctx, { action: 'embedding_health' }));
    if (unresolved.action !== 'embedding_health') throw new Error('wrong action tag');
    expect(unresolved.health.active).toBeNull();
    expect(unresolved.health.state).toBe('uninitialized');

    backend.resolvedModelId = 'fake:rag-admin-v1-resolved';
    const resolved = ok(await backlogAdmin(ctx, { action: 'embedding_health' }));
    if (resolved.action !== 'embedding_health') throw new Error('wrong action tag');
    expect(resolved.health.active).toBe('fake:rag-admin-v1-resolved');
    expect(resolved.health.state).toBe('real');
  });
});

// ----------------------------------------------------------------------------
// `embedding_backfill`.
// ----------------------------------------------------------------------------

describe('configured: embedding_backfill', () => {
  it('dryRun reports a count and calls the provider ZERO times', async () => {
    // Seeded BEFORE the backend is configured — `createItemNode`'s own
    // write-path auto-embed (RAG-SPEC §2.1 Phase B) only fires when a
    // backend is already configured at creation time, so these fixtures
    // start genuinely vector-less rather than racing that fire-and-forget
    // embed for control of the assertion.
    const a = await seed('BUG-RAGBF', 'missing vector item a');
    const b = await seed('BUG-RAGBF', 'missing vector item b');
    void a;
    void b;

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const env = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: true } }));
    if (env.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(env.report.dryRun).toBe(true);
    expect(env.report.needingEmbed).toBe(2);
    expect(env.report.embedded).toBe(0);
    expect(backend.embedDocumentCalls.length).toBe(0);
  });

  it('dryRun is the default when the param is omitted', async () => {
    await seed('BUG-RAGBFDEF', 'default dry run item');
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const env = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO } }));
    if (env.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(env.report.dryRun).toBe(true);
    expect(backend.embedDocumentCalls.length).toBe(0);
  });

  it('embeds exactly the items missing vectors and leaves already-embedded items alone', async () => {
    const alreadyEmbedded = await seed('BUG-RAGBF2', 'already has a vector');
    const missing1 = await seed('BUG-RAGBF2', 'missing vector one');
    const missing2 = await seed('BUG-RAGBF2', 'missing vector two');

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    backend.setVector(alreadyEmbedded.nodeId, [0.1, 0.2, 0.3]);

    const env = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: false }, by: AGENT }));
    if (env.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(env.report.dryRun).toBe(false);
    expect(env.report.needingEmbed).toBe(2);
    expect(env.report.embedded).toBe(2);
    expect(env.report.failed).toBe(0);
    expect(backend.embedDocumentCalls.length).toBe(2);

    // The already-embedded item's vector is UNCHANGED — never re-derived.
    const untouchedVec = await backend.vectorFor(alreadyEmbedded.nodeId);
    expect(untouchedVec).toEqual(Float32Array.from([0.1, 0.2, 0.3]));
    // Both missing items now have a vector.
    expect(await backend.vectorFor(missing1.nodeId)).not.toBeNull();
    expect(await backend.vectorFor(missing2.nodeId)).not.toBeNull();
  });

  it('requires "by" once dryRun:false actually schedules embeds', async () => {
    await seed('BUG-RAGBFATTR', 'needs attribution');
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);

    const env = await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: false } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });

  it('the re-embed-on-content-change sweep DOES re-embed an item that already has a vector but a stale content stamp', async () => {
    const item = await seed('BUG-RAGBFSTALE', 'original content before edit');
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    backend.setVector(item.nodeId, [0.9, 0.1, 0]);
    // Simulate "this node was embedded by a PRIOR backfill sweep, but its
    // content has since changed" — stamp a hash that does NOT match the
    // node's CURRENT content. A predicate of merely `vectorFor(id) !== null`
    // ("only if null") would treat this node as fully current and skip it
    // forever; this is the exact case RAG-SPEC §7 requires to be repaired.
    await mutateMetadata<BacklogNodeMeta>(tmp.store, item.nodeId, (meta) => ({
      ...meta,
      embedContentHash: computeContentHash('some completely different stale content'),
    }));

    const dryRunEnv = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: true } }));
    if (dryRunEnv.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(dryRunEnv.report.needingEmbed).toBe(1);
    expect(dryRunEnv.report.reasons.staleContent).toBe(1);
    expect(dryRunEnv.report.reasons.missing).toBe(0);

    const env = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: false }, by: AGENT }));
    if (env.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(env.report.embedded).toBe(1);
    expect(backend.embedDocumentCalls.length).toBe(1);

    // The stamp is now current — a second sweep finds nothing left to do.
    const secondPass = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: true } }));
    if (secondPass.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(secondPass.report.needingEmbed).toBe(0);
  });

  it('an item with a vector and NO prior stamp is trusted as current (never re-embedded on the sweep\'s first pass)', async () => {
    const item = await seed('BUG-RAGBFTRUST', 'write-path embedded, no backfill stamp yet');
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    backend.setVector(item.nodeId, [1, 0, 0]);

    const env = ok(await backlogAdmin(ctx, { action: 'embedding_backfill', params: { repo: REPO, dryRun: true } }));
    if (env.action !== 'embedding_backfill') throw new Error('wrong action tag');
    expect(env.report.needingEmbed).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// `list_near_duplicates` — READ-ONLY, RAG-SPEC §8 DoD #4.
// ----------------------------------------------------------------------------

describe('configured: list_near_duplicates', () => {
  it('surfaces a near-dup pair above threshold and NEVER writes an edge (byte-identical edge table before/after)', async () => {
    // Seeded before the backend is configured (see `embedding_backfill`'s
    // fixtures above) — this suite controls every vector explicitly via
    // `setVector`, so the write-path's own fire-and-forget auto-embed must
    // never fire and race that explicit assignment.
    const a = await seed('BUG-RAGDUP', 'sign in button unresponsive on load');
    const b = await seed('BUG-RAGDUP', 'login button not responding after page load');
    const unrelated = await seed('BUG-RAGDUP', 'completely unrelated printer driver crash');

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    backend.setVector(a.nodeId, [1, 0, 0]);
    backend.setVector(b.nodeId, [0.99, 0.01, 0]);
    backend.setVector(unrelated.nodeId, [0, 1, 0]);

    const before = await snapshotEdges();
    const env = ok(await backlogAdmin(ctx, { action: 'list_near_duplicates', params: { repo: REPO, threshold: 0.9 } }));
    const after = await snapshotEdges();

    if (env.action !== 'list_near_duplicates') throw new Error('wrong action tag');
    expect(env.report.candidates.some((c) => new Set([c.a, c.b]).size === 2 && [c.a, c.b].includes(a.humanId) && [c.a, c.b].includes(b.humanId))).toBe(
      true
    );
    expect(env.report.candidates.some((c) => [c.a, c.b].includes(unrelated.humanId))).toBe(false);

    // Load-bearing (RAG-SPEC §8 DoD #4): a suggestion surface with a write
    // path is exactly the defect this guards. Byte-identical, not just
    // same-length — a write that replaced a row without changing the count
    // would still be caught.
    expect(after).toEqual(before);
  });
});

// ----------------------------------------------------------------------------
// `run_dedup_sweep` — writes SAME_AS, never merges/deletes.
// ----------------------------------------------------------------------------

describe('configured: run_dedup_sweep', () => {
  it('writes a SAME_AS edge for a near-dup pair and never merges or deletes either item', async () => {
    const a = await seed('BUG-RAGSWEEP', 'checkout page throws on submit');
    const b = await seed('BUG-RAGSWEEP', 'submit on checkout page throws an error');

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    backend.setVector(a.nodeId, [1, 0, 0]);
    backend.setVector(b.nodeId, [0.98, 0.02, 0]);

    const env = ok(await backlogAdmin(ctx, { action: 'run_dedup_sweep', params: { repo: REPO, threshold: 0.9 }, by: AGENT }));
    if (env.action !== 'run_dedup_sweep') throw new Error('wrong action tag');
    expect(env.report.linked).toBe(1);

    const edges = await tmp.store.graph.getEdges({ src: Math.min(a.nodeId, b.nodeId), rel: 'SAME_AS' });
    expect(edges.some((e) => e.dst === Math.max(a.nodeId, b.nodeId))).toBe(true);

    // Both items are STILL live and independently readable — never merged,
    // never deleted (RAG-SPEC §4: "review-then-merge, never auto-merge").
    const itemA = await getItemNode(tmp.store, REPO, a.humanId);
    const itemB = await getItemNode(tmp.store, REPO, b.humanId);
    expect(itemA).not.toBeNull();
    expect(itemB).not.toBeNull();
    expect(itemA?.status).not.toBe('DUPLICATE');
    expect(itemB?.status).not.toBe('DUPLICATE');

    // Idempotent: a second sweep does not re-link (or double-link) the same pair.
    const second = ok(await backlogAdmin(ctx, { action: 'run_dedup_sweep', params: { repo: REPO, threshold: 0.9 }, by: AGENT }));
    if (second.action !== 'run_dedup_sweep') throw new Error('wrong action tag');
    expect(second.report.linked).toBe(0);
    expect(second.report.alreadySkipped).toBe(1);
  });

  it('requires "by"', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const env = await backlogAdmin(ctx, { action: 'run_dedup_sweep', params: { repo: REPO } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

// ----------------------------------------------------------------------------
// `cluster_into_plans` / `promote_cluster_to_plan` — RAG-SPEC §8 DoD #6.
// ----------------------------------------------------------------------------

describe('configured: cluster_into_plans groups real embedded items via real DBSCAN', () => {
  it('4 semantically close OAuth items cluster together; 2 unrelated items stay out', async () => {
    const oauthVectors: number[][] = [
      [1, 0, 0],
      [0.97, 0.05, 0],
      [0.95, -0.05, 0.1],
      [0.98, 0.03, -0.05],
    ];
    // Seeded BEFORE the backend is configured — see the `embedding_backfill`
    // fixtures' comment above for why: this suite controls every vector
    // explicitly, so the write-path's fire-and-forget auto-embed must never
    // fire and race the explicit `setVector` calls below.
    const oauthNodes: Array<{ humanId: string; nodeId: number }> = [];
    for (let i = 0; i < oauthVectors.length; i += 1) {
      oauthNodes.push(await seed('FEAT-RAGCLUSTER', `oauth login flow variant ${i}`));
    }
    const unrelatedA = await seed('FEAT-RAGCLUSTER', 'printer firmware update');
    const unrelatedB = await seed('FEAT-RAGCLUSTER', 'invoice pdf export formatting');

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const oauthItems: string[] = [];
    oauthNodes.forEach((node, i) => {
      backend.setVector(node.nodeId, oauthVectors[i]!);
      oauthItems.push(node.humanId);
    });
    backend.setVector(unrelatedA.nodeId, [0, 1, 0]);
    backend.setVector(unrelatedB.nodeId, [0, 0, 1]);

    const env = ok(await backlogAdmin(ctx, { action: 'cluster_into_plans', params: { repo: REPO }, by: AGENT }));
    if (env.action !== 'cluster_into_plans') throw new Error('wrong action tag');

    expect(env.report.clusters).toHaveLength(1);
    const cluster = env.report.clusters[0]!;
    expect(new Set(cluster.members)).toEqual(new Set(oauthItems));
    expect(cluster.size).toBe(4);

    expect(new Set(env.report.noise)).toEqual(new Set([unrelatedA.humanId, unrelatedB.humanId]));

    // Clustering ALONE creates no plan membership on any item.
    for (const humanId of [...oauthItems, unrelatedA.humanId, unrelatedB.humanId]) {
      const stored = await getItemNode(tmp.store, REPO, humanId);
      expect(stored?.plan).toBeUndefined();
    }
  });

  it('requires "by"', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const env = await backlogAdmin(ctx, { action: 'cluster_into_plans', params: { repo: REPO } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});

describe('configured: promote_cluster_to_plan is what actually creates the plan', () => {
  it('attaches every cluster member to the given planSlug', async () => {
    const vectors: number[][] = [
      [1, 0, 0],
      [0.97, 0.05, 0],
      [0.95, -0.05, 0.1],
    ];
    const nodes: Array<{ humanId: string; nodeId: number }> = [];
    for (let i = 0; i < vectors.length; i += 1) {
      nodes.push(await seed('FEAT-RAGPROMOTE', `promotable candidate ${i}`));
    }

    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const members: string[] = [];
    nodes.forEach((node, i) => {
      backend.setVector(node.nodeId, vectors[i]!);
      members.push(node.humanId);
    });

    const clusterEnv = ok(await backlogAdmin(ctx, { action: 'cluster_into_plans', params: { repo: REPO }, by: AGENT }));
    if (clusterEnv.action !== 'cluster_into_plans') throw new Error('wrong action tag');
    expect(clusterEnv.report.clusters).toHaveLength(1);
    const candidateId = clusterEnv.report.clusters[0]!.candidateId;

    const promoteEnv = ok(
      await backlogAdmin(ctx, {
        action: 'promote_cluster_to_plan',
        params: { candidateId, planSlug: 'oauth-revamp' },
        by: AGENT,
      })
    );
    if (promoteEnv.action !== 'promote_cluster_to_plan') throw new Error('wrong action tag');
    expect(promoteEnv.report.itemCount).toBe(3);
    expect(new Set(promoteEnv.report.humanIds)).toEqual(new Set(members));

    for (const humanId of members) {
      const stored = await getItemNode(tmp.store, REPO, humanId);
      expect(stored?.plan).toBe('oauth-revamp');
    }

    // Promoting the SAME candidate twice is rejected, not silently repeated.
    const secondPromote = await backlogAdmin(ctx, {
      action: 'promote_cluster_to_plan',
      params: { candidateId, planSlug: 'oauth-revamp' },
      by: AGENT,
    });
    expect(isOutcomeError(secondPromote) && secondPromote.error.code).toBe('invalid_argument');
  });

  it('requires "by"', async () => {
    const backend = new FakeSemanticBackend(tmp.store);
    configureSemanticBackend(backend);
    const env = await backlogAdmin(ctx, { action: 'promote_cluster_to_plan', params: { candidateId: 999999, planSlug: 'x' } });
    expect(isOutcomeError(env) && env.error.code).toBe('invalid_argument');
  });
});
