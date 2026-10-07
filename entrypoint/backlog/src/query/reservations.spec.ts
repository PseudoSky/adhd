/**
 * reservations.spec.ts — 46cf1086 B-AC2/B-AC3/B-AC4 (S11.R2-R4): the
 * store-wide `query {view:"reservations"}`.
 *
 * - B-AC2: `filter.pathPrefix` (and the `project`/`component` filters)
 *   enumerate active claims with NO uids supplied; the prefix is segment-aware.
 * - B-AC3: `filter.sessionId:S` returns exactly the paths S holds.
 * - B-AC4: a claim whose `leaseExpiry` has passed is absent — proven by
 *   injecting `now`, never by sleeping.
 *
 * Real store + real api verbs.
 *
 * Negative controls (run once, restored): a substring `pathPrefix` match turns
 * the `/a/b` vs `/a/bc` row red (B-AC2); ignoring `filter.sessionId` turns the
 * B-AC3 row red; ignoring `leaseExpiry` turns the B-AC4 row red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import { pathUnderPrefix } from './views/reservations.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}
interface IRow {
  path: string;
  uid: string;
  holder: string;
  sessionId: string | null;
  claimedAt: string;
  leaseExpiry: string;
}

describe('46cf1086 S11.R2-R4 — reservations view', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let p1: string;
  let p2: string;
  let root: string;
  let issueA: string;
  let issueB: string;
  let issueC: string;
  let fileAB: string;
  let fileABC: string;
  let fileOther: string;

  const reservations = async (filter: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<IRow[]> =>
    (data(await api.query(ctx, { view: 'reservations', filter, ...extra } as never)) as unknown as { items: IRow[] }).items;

  beforeEach(async () => {
    tmp = await openTmpStore('reservations');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    root = join(tmp.dir, 'repo');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    mkdirSync(join(root, 'a', 'bc'), { recursive: true });
    mkdirSync(join(root, 'other'), { recursive: true });
    fileAB = join(root, 'a', 'b', 'x.ts');
    fileABC = join(root, 'a', 'bc', 'y.ts');
    fileOther = join(root, 'other', 'z.ts');
    for (const f of [fileAB, fileABC, fileOther]) writeFileSync(f, 'x\n');
    p1 = data(await api.upsertProject(ctx, { name: 'one', path: root, by: 's' })).uid;
    p2 = data(await api.upsertProject(ctx, { name: 'two', path: join(tmp.dir, 'repo2'), by: 's' })).uid;
    const mk = async (project: string, title: string, file?: string): Promise<string> =>
      data(
        await api.create(ctx, {
          project,
          title,
          body: `${title} b`,
          by: 'filer',
          ...(file !== undefined ? { citations: [{ file }] } : {}),
        } as never)
      ).uid as string;
    issueA = await mk(p1, 'a', fileAB);
    issueB = await mk(p1, 'b', fileABC);
    issueC = await mk(p2, 'c', fileOther);
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('46cf1086 B-AC2 pathUnderPrefix is segment-aware (the collision case)', () => {
    expect(pathUnderPrefix('/a/b', '/a/b')).toBe(true);
    expect(pathUnderPrefix('/a/b/x.ts', '/a/b')).toBe(true);
    expect(pathUnderPrefix('/a/b/x.ts', '/a/b/')).toBe(true);
    expect(pathUnderPrefix('/a/bc/y.ts', '/a/b')).toBe(false);
    expect(pathUnderPrefix('/a/bc', '/a/b')).toBe(false);
  });

  it('46cf1086 B-AC2 enumerates active claims store-wide with no uids supplied; pathPrefix is segment-aware', async () => {
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'claim' }));
    data(await api.claim(ctx, { uid: issueB, by: 'agent-b', action: 'claim' }));
    data(await api.claim(ctx, { uid: issueC, by: 'agent-c', action: 'claim' }));

    const all = await reservations();
    expect(all.map((r) => r.path).sort()).toEqual([fileAB, fileABC, fileOther].sort());

    const underAB = await reservations({ pathPrefix: join(root, 'a', 'b') });
    expect(underAB.map((r) => r.path)).toEqual([fileAB]); // NOT /a/bc/y.ts
    expect(underAB[0]).toMatchObject({ uid: issueA, holder: 'agent-a', sessionId: null });

    expect((await reservations({ pathPrefix: join(root, 'a') })).map((r) => r.path).sort()).toEqual([fileAB, fileABC].sort());
  });

  it('46cf1086 B-AC2 the project and component filters narrow to the owning primary placement', async () => {
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'claim' }));
    data(await api.claim(ctx, { uid: issueC, by: 'agent-c', action: 'claim' }));
    expect((await reservations({ project: p1 })).map((r) => r.uid)).toEqual([issueA]);
    expect((await reservations({ project: p2 })).map((r) => r.uid)).toEqual([issueC]);
    expect(await reservations({ project: 'no-such-project' })).toEqual([]);
  });

  it('46cf1086 B-AC3 filtering by sessionId returns exactly the paths that session holds', async () => {
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'claim', sessionId: 'S1' } as never));
    data(await api.claim(ctx, { uid: issueB, by: 'agent-b', action: 'claim', sessionId: 'S2' } as never));
    data(await api.claim(ctx, { uid: issueC, by: 'agent-c', action: 'claim' }));
    expect((await reservations({ sessionId: 'S1' })).map((r) => r.path)).toEqual([fileAB]);
    expect((await reservations({ sessionId: 'S2' })).map((r) => r.path)).toEqual([fileABC]);
    expect(await reservations({ sessionId: 'S3' })).toEqual([]);
    expect((await reservations({ holder: 'agent-c' })).map((r) => r.uid)).toEqual([issueC]);
  });

  it('46cf1086 B-AC4 a claim whose leaseExpiry has passed is absent: injected clock, no sleeping', async () => {
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'claim' }));
    const [row] = await reservations();
    expect(row).toBeDefined();
    const expiry = Date.parse(row!.leaseExpiry);
    const justBefore = new Date(expiry - 1000).toISOString();
    const atExpiry = new Date(expiry).toISOString();
    const wellAfter = new Date(expiry + 3_600_000).toISOString();
    expect((await reservations({}, { now: justBefore })).length).toBe(1);
    expect(await reservations({}, { now: atExpiry })).toEqual([]);
    expect(await reservations({}, { now: wellAfter })).toEqual([]);
  });

  it('46cf1086 B-AC4 a released claim is absent; a bad now / limit is invalid_argument', async () => {
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'claim' }));
    data(await api.claim(ctx, { uid: issueA, by: 'agent-a', action: 'release' }));
    expect(await reservations()).toEqual([]);
    const bad = await api.query(ctx, { view: 'reservations', now: 'not-a-date' } as never);
    expect(bad.ok).toBe(false);
    const badLimit = await api.query(ctx, { view: 'reservations', limit: 0 } as never);
    expect(badLimit.ok).toBe(false);
  });
});
