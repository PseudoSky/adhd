/**
 * uid-verbs.ambiguity.spec.ts — 3a4a0405 A-AC10 (S02 AC1/AC4): an ambiguous
 * uid prefix returns typed `ambiguous_reference` carrying the CANDIDATE SET on
 * EVERY uid-taking verb; no verb takes the first match silently; chain
 * resolution follows for reads and refuses (naming the successor) for writes.
 *
 * The uid-verb list is DERIVED from `BACKLOG_VERBS` minus `NON_UID_VERBS`; a
 * newly mounted verb that is in neither set fails the drift guard, forcing a
 * decision. Real store + real `api.ts` verbs; nothing is mocked.
 *
 * Negative control (run once, restored): swapping one verb's resolver for
 * `getNodeByUidTx` (exact-match only) makes that verb return `item_not_found`
 * instead of `ambiguous_reference`, turning its row red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from './test/helpers/tmp-store.js';
import { buildBacklogEnv } from './env.js';
import * as api from './api.js';
import { BACKLOG_VERBS } from './vocabulary.js';

/** Verbs that take no uid reference (names, filters, or no input). */
const NON_UID_VERBS = new Set([
  'query',
  'priority-matrix',
  'open-curve',
  'report',
  'lookup',
  'upsert-project',
  'upsert-component',
  'upsert-location',
  'embedding-status',
  'create', // project is a uid-or-name registry ref, resolved by name first; covered by registry specs
]);

/** The exact (renamed) uid of the first seeded issue — a valid, unambiguous relate target. */
const PROJECT_EXACT_ISSUE = 'c0ffee01-1111-4111-8111-111111111111';

const P = {
  issue: 'c0ffee01',
  project: 'c0ffee02',
  attestation: 'c0ffee03',
  obligation: 'c0ffee04',
  citation: 'c0ffee05',
  location: 'c0ffee06',
  deleted: 'c0ffee07',
} as const;

type Env = { ok: boolean; error?: { code: string; details?: Record<string, unknown> } };
type Call = (ctx: api.BacklogCtx) => Promise<Env>;

const AMBIGUOUS_CALLS: Record<string, Call> = {
  get: (c) => api.get(c, { uid: P.issue }),
  'part-of-rollup': (c) => api.partOfRollup(c, { uid: P.issue }),
  'spec-check': (c) => api.specCheck(c, { uid: P.issue }),
  update: (c) => api.update(c, { uid: P.issue, by: 'x', title: 'z' }),
  'add-citation': (c) => api.addCitation(c, { uid: P.issue, by: 'x', citation: { file: 'q.ts' } }),
  'remove-citation': (c) => api.removeCitation(c, { uid: P.citation, by: 'x' }),
  transition: (c) => api.transition(c, { uid: P.issue, by: 'x', toStatus: 'IN_PROGRESS', note: 'n' }),
  attest: (c) =>
    api.attest(c, { subject: { id: P.issue, revision: 1 }, claim: { kind: 'k' }, anchor: { locator: 'path:a', digest: 'd' }, by: 'x' }),
  recheck: (c) => api.recheck(c, { attestationUid: P.attestation, by: 'seed' }),
  obligate: (c) => api.obligate(c, { uid: P.issue, applies_to: { to: '*' }, requirement: { op: 'blockers_terminal' }, on_fail: 'block', by: 'x' }),
  unobligate: (c) => api.unobligate(c, { obligationUid: P.obligation, by: 'x' }),
  'spec-append': (c) => api.specAppend(c, { uid: P.issue, fragment: 'f', base_revision: 'sha256:0', by: 'x' }),
  claim: (c) => api.claim(c, { uid: P.issue, by: 'x', action: 'claim' }),
  relate: (c) => api.relate(c, { sourceUid: P.issue, targetUid: PROJECT_EXACT_ISSUE, rel: 'relates_to', action: 'add', by: 'x' }),
  move: (c) => api.move(c, { uid: P.issue, by: 'x', toComponent: 'c' }),
  delete: (c) => api.delete(c, { uid: P.issue, reason: 'r', by: 'x' }),
  remove: (c) => api.remove(c, { uid: P.issue, confirm: true, by: 'x' }),
  restore: (c) => api.restore(c, { uid: P.deleted, by: 'x' }),
  'rm-location': (c) => api.rmLocation(c, { uid: P.location, by: 'x' }),
  'merge-project': (c) => api.mergeProject(c, { fromUid: P.project, toUid: P.project, by: 'x' }),
  'rm-project': (c) => api.rmProject(c, { uid: P.project, reason: 'r', by: 'x' }),
};

describe('3a4a0405 A-AC10 — ambiguous uid prefix on every uid-taking verb', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;

  async function rename(kind: string, prefix: string): Promise<string[]> {
    return renameWhere(`kind = '${kind}' AND t_invalid IS NULL`, prefix);
  }

  async function renameWhere(where: string, prefix: string): Promise<string[]> {
    const { rows } = await tmp.store.adapter.executeAll<{ uid: string }>(
      `SELECT uid FROM node WHERE ${where} ORDER BY rowid ASC LIMIT 2`
    );
    expect(rows).toHaveLength(2);
    const out: string[] = [];
    let i = 1;
    for (const r of rows) {
      const to = `${prefix}-${i}111-4111-8111-11111111111${i}`;
      await tmp.store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [to, r.uid]);
      out.push(to);
      i += 1;
    }
    return out;
  }

  async function counts(): Promise<{ nodes: number; edges: number }> {
    const n = await tmp.store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    const e = await tmp.store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
    return { nodes: Number(n?.c), edges: Number(e?.c) };
  }

  const must = <T extends { ok: boolean }>(r: T): T => {
    if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r)}`);
    return r;
  };

  beforeEach(async () => {
    tmp = await openTmpStore('uid-verbs-ambiguity');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const p1 = must(await api.upsertProject(ctx, { name: 'amb-one', by: 'seed' }));
    const p1uid = (p1.data as { uid: string }).uid;
    must(await api.upsertProject(ctx, { name: 'amb-two', by: 'seed' }));
    const comp = must(await api.upsertComponent(ctx, { project: p1uid, name: 'comp', by: 'seed' }));
    const compUid = (comp.data as { uid: string }).uid;
    must(await api.upsertLocation(ctx, { component: compUid, locType: 'path', value: '/amb/one', by: 'seed' }));
    must(await api.upsertLocation(ctx, { component: compUid, locType: 'path', value: '/amb/two', by: 'seed' }));
    const i1 = must(await api.create(ctx, { project: p1uid, title: 'one', body: 'body one', by: 'seed' }));
    const i1uid = (i1.data as { uid: string }).uid;
    must(await api.create(ctx, { project: p1uid, title: 'two', body: 'body two', by: 'seed' }));
    const d1 = must(await api.create(ctx, { project: p1uid, title: 'del one', body: 'body del one', by: 'seed' }));
    const d2 = must(await api.create(ctx, { project: p1uid, title: 'del two', body: 'body del two', by: 'seed' }));
    must(await api.delete(ctx, { uid: (d1.data as { uid: string }).uid, reason: 'fixture', by: 'seed' }));
    must(await api.delete(ctx, { uid: (d2.data as { uid: string }).uid, reason: 'fixture', by: 'seed' }));
    must(await api.attest(ctx, { subject: { id: i1uid, revision: 1 }, claim: { kind: 'k1' }, anchor: { locator: 'path:a', digest: 'd' }, by: 'seed' }));
    must(await api.attest(ctx, { subject: { id: i1uid, revision: 1 }, claim: { kind: 'k2' }, anchor: { locator: 'path:b', digest: 'd' }, by: 'seed' }));
    must(await api.obligate(ctx, { uid: i1uid, applies_to: { to: 'CLOSED' }, requirement: { op: 'blockers_terminal' }, on_fail: 'block', by: 'seed' }));
    must(await api.obligate(ctx, { uid: i1uid, applies_to: { to: 'DONE' }, requirement: { op: 'blockers_terminal' }, on_fail: 'warn', by: 'seed' }));
    must(await api.addCitation(ctx, { uid: i1uid, by: 'seed', citation: { file: 'a.ts' } }));
    must(await api.addCitation(ctx, { uid: i1uid, by: 'seed', citation: { file: 'b.ts' } }));
    await renameWhere("kind = 'issue' AND t_invalid IS NOT NULL", P.deleted);
    await rename('issue', P.issue);
    await rename('project', P.project);
    await rename('attestation', P.attestation);
    await rename('obligation', P.obligation);
    await rename('citation', P.citation);
    await rename('location', P.location);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('3a4a0405 A-AC10 — drift guard: every mounted verb is either uid-taking (covered below) or declared non-uid', () => {
    const covered = new Set([...Object.keys(AMBIGUOUS_CALLS), ...NON_UID_VERBS]);
    expect([...BACKLOG_VERBS].filter((v) => !covered.has(v))).toEqual([]);
    expect([...covered].filter((v) => !BACKLOG_VERBS.includes(v))).toEqual([]);
  });

  for (const verb of Object.keys(AMBIGUOUS_CALLS)) {
    it(`3a4a0405 A-AC10 — "${verb}" on an ambiguous prefix: ambiguous_reference + 2 candidates, nothing written`, async () => {
      const before = await counts();
      const out = await AMBIGUOUS_CALLS[verb]!(ctx);
      expect(out.ok).toBe(false);
      expect(out.error?.code, JSON.stringify(out.error)).toBe('ambiguous_reference');
      const candidates = out.error?.details?.['candidates'] as Array<{ uid: string }> | undefined;
      expect(candidates).toHaveLength(2);
      expect(out.error?.details?.['ref']).toEqual(expect.any(String));
      expect(await counts()).toEqual(before);
    });
  }

  describe('chain resolution (S02 AC4): reads and writes on a superseded uid name the head', () => {
    async function supersede(): Promise<{ oldUid: string; headUid: string }> {
      const oldUid = PROJECT_EXACT_ISSUE;
      const out = await api.update(ctx, { uid: oldUid, by: 'seed', body: 'a brand new body that supersedes the old node' });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const headUid = (out.data as { uid: string }).uid;
      expect(headUid).not.toBe(oldUid);
      return { oldUid, headUid };
    }

    it('3a4a0405 A-AC10 — READ (get) on a superseded uid is a typed conflict naming the chain head', async () => {
      const { oldUid, headUid } = await supersede();
      const out = await api.get(ctx, { uid: oldUid });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.code).toBe('conflict');
      expect(out.error.message).toContain(headUid);
      const ok = await api.get(ctx, { uid: headUid });
      expect(ok.ok).toBe(true);
    });

    it('3a4a0405 A-AC10 — WRITE (transition) on a superseded uid is refused naming the head, nothing retargeted', async () => {
      const { oldUid, headUid } = await supersede();
      const before = await counts();
      const out = await api.transition(ctx, { uid: oldUid, by: 'x', toStatus: 'IN_PROGRESS', note: 'n' });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.code).toBe('conflict');
      expect(out.error.message).toContain(headUid);
      expect(await counts()).toEqual(before);
    });

    it('3a4a0405 A-AC10 — an attestation filed before a body edit is still found on the chain head (edge carried by the supersede sweep)', async () => {
      const { headUid } = await supersede();
      const row = await tmp.store.adapter.executeGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM edge e JOIN node n ON n.rowid = e.src
         WHERE n.uid = ? AND e.rel = 'attests' AND e.t_invalid IS NULL`,
        [headUid]
      );
      expect(Number(row?.c)).toBe(2);
    });
  });
});
