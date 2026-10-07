/**
 * membership.scan-count.spec.ts — 3ef33aaf (the ticket states no numbered ACs;
 * AC1..AC3 below map to its stated expectations):
 *   AC1  filing/updating/transitioning with N citations scans the project
 *        table a number of times that does NOT grow with N (was O(N^2) full
 *        scans inside the immediate write transaction);
 *   AC2  the root index matches exactly what the one-shot finder returns
 *        (behaviour identical), including longest-prefix-per-project;
 *   AC3  the resulting membership rows are unchanged by the batching.
 *
 * UNIT tests only (real store, no subprocess). Negative controls (run once,
 * restored): (a) drop `deferMembershipReconcile` in create-issue.ts -> AC1 red;
 * (b) call `loadComponentRootIndexTx` inside the citation loop of
 * `reconcileMembershipTx` -> AC1 red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import { canonicalMembershipPath, findComponentsForPathTx, loadComponentRootIndexTx, matchComponentsForPath } from './membership.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('3ef33aaf — membership reconcile is linear in citation count', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let counts: { project: number };
  let projectUid: string;
  let componentUid: string;
  let dir: string;
  const files: string[] = [];

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
                          if (sql.includes("kind = 'project'")) counts.project += 1;
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
    tmp = await openTmpStore('membership-scan');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    dir = join(tmp.dir, 'proj');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    files.length = 0;
    for (let i = 0; i < 12; i += 1) {
      const f = join(dir, 'pkg', `f${i}.ts`);
      writeFileSync(f, `${i}\n`);
      files.push(f);
    }
    projectUid = data(await api.upsertProject(ctx, { name: 'proj', path: dir, by: 'seed' })).uid;
    componentUid = data(await api.upsertComponent(ctx, { project: projectUid, name: 'pkg', by: 'seed' })).uid;
    data(await api.upsertLocation(ctx, { component: componentUid, locType: 'path', value: join(dir, 'pkg'), by: 'seed' }));
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  async function projectScansForCreate(n: number): Promise<number> {
    const c = countingCtx();
    counts = { project: 0 };
    data(
      await api.create(c, {
        project: projectUid,
        component: componentUid,
        title: `cites ${n}`,
        body: 'b',
        by: 'filer',
        citations: files.slice(0, n).map((file) => ({ file })),
      } as never)
    );
    return counts.project;
  }

  it('3ef33aaf AC1 — create with N citations: project-table scans do not grow with N', async () => {
    const few = await projectScansForCreate(2);
    const many = await projectScansForCreate(10);
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
  });

  it('3ef33aaf AC1 — update adding N citations: project-table scans do not grow with N', async () => {
    const issue = data(
      await api.create(ctx, { project: projectUid, component: componentUid, title: 't', body: 'b', by: 'filer' } as never)
    ).uid as string;
    async function scansForUpdate(uid: string, upto: number): Promise<{ scans: number; uid: string }> {
      const c = countingCtx();
      counts = { project: 0 };
      const out = data(
        await api.update(c, { uid, by: 'filer', citations: files.slice(0, upto).map((file) => ({ file })) } as never)
      ) as { uid: string };
      return { scans: counts.project, uid: out.uid };
    }
    const a = await scansForUpdate(issue, 2);
    const b = await scansForUpdate(a.uid, 10);
    expect(b.scans).toBeLessThanOrEqual(a.scans);
  });

  it('3ef33aaf AC2 — the preloaded root index returns exactly what the one-shot finder returns', async () => {
    const index = await loadComponentRootIndexTx(tmp.store.adapter);
    for (const f of [...files, join(dir, 'outside.ts'), '/nowhere/x.ts']) {
      expect(matchComponentsForPath(index, await canonicalMembershipPath(f))).toEqual(await findComponentsForPathTx(tmp.store.adapter, f));
    }
    expect(matchComponentsForPath(index, await canonicalMembershipPath(files[0]!)).map((h) => h.componentUid)).toEqual([componentUid]);
  });

  it('3ef33aaf AC3 — N citations in one file still yield one primary plus one citation membership row per reachable component', async () => {
    const issue = data(
      await api.create(ctx, {
        project: projectUid,
        component: componentUid,
        title: 'm',
        body: 'b',
        by: 'filer',
        citations: files.slice(0, 5).map((file) => ({ file })),
      } as never)
    ).uid as string;
    const card = data(await api.get(ctx, { uid: issue, fields: ['memberships'] })) as {
      memberships: Array<{ componentUid: string; via: string }>;
    };
    expect(card.memberships).toEqual([expect.objectContaining({ componentUid, via: 'primary' })]);
  });
});
