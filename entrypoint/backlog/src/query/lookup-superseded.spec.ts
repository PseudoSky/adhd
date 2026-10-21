/**
 * lookup-superseded.spec.ts — 68175e51-9eda-459c-bc23-6bba2b4c7707
 *
 * Failure mode: `lookup` on a uid (or unique prefix) of a SUPERSEDED issue
 * (replaced by a body edit) redirects to the stale uid, so the follow-up `get`
 * answers `conflict`. Product decision (option b): `lookup` is the one verb
 * that heals a rotted uid — it returns the live chain head and an additive
 * `forwardedFrom`; `get` and every write verb keep refusing, naming the head.
 *
 * Tier: S (real store + real api.ts verbs, no mocks, no subprocess).
 * Gap statement: none above S — the behavior is observable in-process; the
 * built-CLI wire shape is covered separately in cli.e2e.ts.
 *
 * Red run (against the unfixed lookup, quoted before the fix landed):
 *   AC1/AC2/AC3 fail on `expect(redirect.uid).toBe(U1/U2)` — received U0;
 *   shared-prefix fails with `ambiguous_reference`; AC4 guards stay green.
 *
 * Risk map (Light): lookup/redirect resolution only; write path untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

const ITEM = '68175e51-9eda-459c-bc23-6bba2b4c7707';

describe(`${ITEM} — lookup heals a superseded uid; get/writes still refuse`, () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let u0: string;

  const ok = <T>(r: { ok: boolean; data?: T }): T => {
    if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r)}`);
    return r.data as T;
  };

  const edit = async (uid: string, body: string): Promise<string> =>
    ok<{ uid: string }>(await api.update(ctx, { uid, by: 'seed', body })).uid;

  const lookupOk = async (q: string) => {
    const out = await api.lookup(ctx, { q });
    if (!out.ok) throw new Error(`lookup(${q}): ${JSON.stringify(out.error)}`);
    return out.data as {
      redirect?: { verb: string; uid?: string };
      forwardedFrom?: string;
    };
  };

  async function counts(): Promise<{ nodes: number; edges: number }> {
    const n = await tmp.store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    const e = await tmp.store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    return { nodes: Number(n?.c), edges: Number(e?.c) };
  }

  beforeEach(async () => {
    tmp = await openTmpStore('lookup-superseded');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const p = ok<{ uid: string }>(await api.upsertProject(ctx, { name: 'ls-proj', by: 'seed' }));
    const c = ok<{ uid: string }>(await api.upsertComponent(ctx, { project: p.uid, name: 'comp', by: 'seed' }));
    void c;
    u0 = ok<{ uid: string }>(
      await api.create(ctx, { project: p.uid, title: 'lookup superseded', body: 'original body', by: 'seed' })
    ).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it(`${ITEM} AC1 — lookup of a superseded full uid redirects to the live head U1`, async () => {
    const u1 = await edit(u0, 'second body');
    expect(u1).not.toBe(u0);
    const res = await lookupOk(u0);
    expect(res.redirect).toEqual({ verb: 'get', uid: u1 });
  });

  it(`${ITEM} AC2 — a unique 8-char prefix of U0 resolves to U1, and to U2 after two edits`, async () => {
    const u1 = await edit(u0, 'second body');
    expect((await lookupOk(u0.slice(0, 8))).redirect?.uid).toBe(u1);
    const u2 = await edit(u1, 'third body');
    expect((await lookupOk(u0.slice(0, 8))).redirect?.uid).toBe(u2);
    expect((await lookupOk(u0)).redirect?.uid).toBe(u2);
  });

  it(`${ITEM} AC3 — forwardedFrom names the supplied uid when forwarded; absent on a live uid`, async () => {
    const u1 = await edit(u0, 'second body');
    const forwarded = await lookupOk(u0);
    expect(forwarded.forwardedFrom).toBe(u0);
    const live = await lookupOk(u1);
    expect(live.redirect?.uid).toBe(u1);
    expect(live).not.toHaveProperty('forwardedFrom');
  });

  it(`${ITEM} AC5 — get on lookup's answer succeeds in one hop`, async () => {
    await edit(u0, 'second body');
    const res = await lookupOk(u0);
    const got = await api.get(ctx, { uid: res.redirect?.uid ?? '' });
    expect(got.ok).toBe(true);
  });

  it(`${ITEM} AC4 — get and transition on U0 still refuse with conflict naming U1; counts unchanged`, async () => {
    const u1 = await edit(u0, 'second body');
    const before = await counts();
    const got = await api.get(ctx, { uid: u0 });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('conflict');
    expect(got.error.message).toContain(u1);
    const tr = await api.transition(ctx, { uid: u0, by: 'x', toStatus: 'IN_PROGRESS', note: 'n' });
    expect(tr.ok).toBe(false);
    if (tr.ok) return;
    expect(tr.error.code).toBe('conflict');
    expect(tr.error.message).toContain(u1);
    expect(await counts()).toEqual(before);
  });

  it(`${ITEM} shared prefix — a prefix matching a superseded node AND its live head resolves to the head, not ambiguous`, async () => {
    const u1 = await edit(u0, 'second body');
    // Force U0 and U1 to share a 12-char prefix so one prefix matches both.
    const shared = 'abcdef01-aaaa';
    const nu0 = `${shared}-4111-8111-111111111111`;
    const nu1 = `${shared}-4222-8222-222222222222`;
    await tmp.store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [nu0, u0]);
    await tmp.store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [nu1, u1]);
    const res = await lookupOk(shared);
    expect(res.redirect?.uid).toBe(nu1);
    expect(res.forwardedFrom).toBe(shared);
  });

  it(`${ITEM} shared prefix — a prefix matching two UNRELATED live issues is still ambiguous`, async () => {
    const p = ok<{ uid: string }>(await api.upsertProject(ctx, { name: 'ls-proj2', by: 'seed' }));
    const other = ok<{ uid: string }>(
      await api.create(ctx, { project: p.uid, title: 'unrelated issue', body: 'other body', by: 'seed' })
    ).uid;
    const shared = 'abcdef02-aaaa';
    await tmp.store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [`${shared}-4111-8111-111111111111`, u0]);
    await tmp.store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [`${shared}-4222-8222-222222222222`, other]);
    const out = await api.lookup(ctx, { q: shared });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('ambiguous_reference');
  });
});
