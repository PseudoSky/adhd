/**
 * transition.deferred-reconcile.spec.ts — a4585973 (membership reconcile is
 * deferred to ONE call after the citation loop in `transition`; the update
 * citation-REMOVAL path is not yet linear).
 *
 *   a4585973 AC1  a transition carrying N>=3 citations performs exactly ONE
 *                 membership reconcile and ONE component-root-index scan.
 *   a4585973 AC2  the resulting membership edges equal those the per-citation
 *                 (non-deferred) `addCitation` sequence produces.
 *   a4585973 AC3  a transition with no citations triggers no reconcile.
 *   a4585973 AC4  characterisation: `update` removing M citations reconciles
 *                 once per removal (+1 when it also adds) — items
 *                 642e9bbe / a4585973.
 *
 * UNIT tests only: real tmp store, no subprocess, no network. Reconcile calls
 * are counted by wrapping `reconcileMembershipTx` (the real implementation
 * still runs); root-index scans by counting `kind = 'project'` SQL, as in
 * membership.scan-count.spec.ts.
 *
 * Negative control (run once, restored): delete `deferMembershipReconcile:
 * true` from the citation loop in transition.ts -> AC1 and AC2 go red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

const reconcileSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./membership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./membership.js')>();
  return {
    ...actual,
    reconcileMembershipTx: (...args: Parameters<typeof actual.reconcileMembershipTx>) => {
      reconcileSpy.calls += 1;
      return actual.reconcileMembershipTx(...args);
    },
  };
});

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

interface IMembership {
  componentUid: string;
  via: string;
}

describe('a4585973 — deferred membership reconcile (transition) and update citation removal', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let scans: { project: number };
  let projectUid: string;
  let compA: string;
  let compB: string;
  let dir: string;
  const filesA: string[] = [];
  const filesB: string[] = [];

  /** `ctx` over the same store whose adapter counts `kind = 'project'` scans issued inside transactions. */
  function countingCtx(): api.BacklogCtx {
    const adapter = new Proxy(tmp.store.adapter, {
      get(target, key) {
        if (key === 'transaction') {
          return (fn: (tx: unknown) => unknown, opts: unknown) =>
            (target.transaction as (f: unknown, o: unknown) => unknown)(
              (tx: Record<PropertyKey, unknown>) =>
                fn(
                  new Proxy(tx, {
                    get(t, k) {
                      if (k === 'executeAll') {
                        return (sql: string, args?: unknown[]) => {
                          if (sql.includes("kind = 'project'")) scans.project += 1;
                          return (t['executeAll'] as (s: string, a?: unknown[]) => unknown)(sql, args);
                        };
                      }
                      const v = t[k];
                      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                    },
                  })
                ),
              opts
            );
        }
        const v = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { store: { ...tmp.store, adapter }, env: ctx.env } as api.BacklogCtx;
  }

  beforeEach(async () => {
    tmp = await openTmpStore('deferred-reconcile');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    dir = join(tmp.dir, 'proj');
    filesA.length = 0;
    filesB.length = 0;
    for (const [sub, bucket] of [
      ['pkga', filesA],
      ['pkgb', filesB],
    ] as const) {
      mkdirSync(join(dir, sub), { recursive: true });
      for (let i = 0; i < 4; i += 1) {
        const f = join(dir, sub, `f${i}.ts`);
        writeFileSync(f, `${sub}${i}\n`);
        bucket.push(f);
      }
    }
    projectUid = data(await api.upsertProject(ctx, { name: 'proj', path: dir, by: 'seed' })).uid;
    compA = data(await api.upsertComponent(ctx, { project: projectUid, name: 'pkga', by: 'seed' })).uid;
    compB = data(await api.upsertComponent(ctx, { project: projectUid, name: 'pkgb', by: 'seed' })).uid;
    data(await api.upsertLocation(ctx, { component: compA, locType: 'path', value: join(dir, 'pkga'), by: 'seed' }));
    data(await api.upsertLocation(ctx, { component: compB, locType: 'path', value: join(dir, 'pkgb'), by: 'seed' }));
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  async function newIssue(title: string, citations?: string[]): Promise<string> {
    return data(
      await api.create(ctx, {
        project: projectUid,
        component: compA,
        title,
        body: 'b',
        by: 'filer',
        ...(citations ? { citations: citations.map((file) => ({ file })) } : {}),
      } as never)
    ).uid as string;
  }

  async function memberships(uid: string): Promise<IMembership[]> {
    const card = data(await api.get(ctx, { uid, fields: ['memberships'] })) as { memberships: IMembership[] };
    return card.memberships
      .map((m) => ({ componentUid: m.componentUid, via: m.via }))
      .sort((x, y) => (x.componentUid + x.via).localeCompare(y.componentUid + y.via));
  }

  const mixed = (): string[] => [filesA[0]!, filesB[0]!, filesB[1]!, filesA[1]!];

  it('a4585973 AC1 — transition with 4 citations: exactly one reconcile and one root-index scan', async () => {
    const issue = await newIssue('ac1');
    const c = countingCtx();
    reconcileSpy.calls = 0;
    scans = { project: 0 };
    data(
      await api.transition(c, {
        uid: issue,
        by: 'filer',
        toStatus: 'in-progress',
        note: 'go',
        citations: mixed().map((file) => ({ file })),
      } as never)
    );
    expect(reconcileSpy.calls).toBe(1);
    expect(scans.project).toBe(1);
  });

  it('a4585973 AC2 — deferred transition membership equals the per-citation (non-deferred) addCitation sequence', async () => {
    const viaTransition = await newIssue('ac2-transition');
    reconcileSpy.calls = 0;
    data(
      await api.transition(ctx, {
        uid: viaTransition,
        by: 'filer',
        toStatus: 'in-progress',
        note: 'go',
        citations: mixed().map((file) => ({ file })),
      } as never)
    );
    const transitionReconciles = reconcileSpy.calls;

    const viaSequence = await newIssue('ac2-sequence');
    reconcileSpy.calls = 0;
    for (const file of mixed()) {
      data(await api.addCitation(ctx, { uid: viaSequence, citation: { file }, by: 'filer' } as never));
    }
    const sequenceReconciles = reconcileSpy.calls;

    const got = await memberships(viaTransition);
    expect(got).toEqual(await memberships(viaSequence));
    expect(got.map((m) => m.componentUid).sort()).toEqual([compA, compB].sort());
    // The equivalent sequence reconciles once per citation; the transition once in total.
    expect(sequenceReconciles).toBe(4);
    expect(transitionReconciles).toBe(1);
  });

  it('a4585973 AC3 — transition with zero citation changes triggers no reconcile', async () => {
    const issue = await newIssue('ac3', [filesB[0]!]);
    const before = await memberships(issue);
    reconcileSpy.calls = 0;
    scans = { project: 0 };
    data(await api.transition(countingCtx(), { uid: issue, by: 'filer', toStatus: 'in-progress', note: 'go' } as never));
    expect(reconcileSpy.calls).toBe(0);
    expect(scans.project).toBe(0);
    expect(await memberships(issue)).toEqual(before);
  });

  // 642e9bbe / a4585973: removal is NOT linearised — removeCitationTx reconciles once
  // per removed citation, and update.ts adds one more reconcile when it also adds
  // citations (M+1). When removal is made linear, flip these expectations deliberately.
  it('a4585973 AC4 — characterisation: update removing M=3 citations while adding 1 reconciles M+1=4 times', async () => {
    const m = 3;
    const issue = await newIssue('ac4', [filesA[0]!, filesB[0]!, filesB[1]!, filesB[2]!]);
    reconcileSpy.calls = 0;
    data(await api.update(ctx, { uid: issue, by: 'filer', citations: [{ file: filesA[0]! }, { file: filesA[1]! }] } as never));
    expect(reconcileSpy.calls).toBe(m + 1);
  });

  it('a4585973 AC4 — characterisation: update removing M=3 citations with no additions reconciles M=3 times', async () => {
    const m = 3;
    const issue = await newIssue('ac4-removal-only', [filesA[0]!, filesB[0]!, filesB[1]!, filesB[2]!]);
    reconcileSpy.calls = 0;
    data(await api.update(ctx, { uid: issue, by: 'filer', citations: [{ file: filesA[0]! }] } as never));
    expect(reconcileSpy.calls).toBe(m);
  });
});
