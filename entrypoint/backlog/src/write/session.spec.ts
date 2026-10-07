/**
 * session.spec.ts — 91a8c640 B-AC5 (S11.S1): after the first mutating verb
 * carrying `sessionId`, a session node `{id, agent, startedAt, endedAt,
 * parentSessionId}` exists and can be queried (`query {view:"sessions"}`); a
 * child session links `child_of_session`; a conflicting second parent is
 * `invalid_argument`.
 *
 * Real store + real api verbs.
 *
 * Negative control (run once, restored): never calling `ensureSessionTx`
 * (no session node is created) turns every row red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}
interface ISess {
  sessionId: string;
  agent: string;
  startedAt: string;
  endedAt: string | null;
  parentSessionId: string | null;
}

describe('91a8c640 B-AC5 — session nodes', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;

  const sessions = async (filter: Record<string, unknown> = {}): Promise<ISess[]> =>
    (data(await api.query(ctx, { view: 'sessions', filter } as never)) as unknown as { items: ISess[] }).items;
  const mk = async (extra: Record<string, unknown>): Promise<IOutcomeEnvelope<{ uid: string }>> =>
    (await api.create(ctx, { project, title: 't', body: 'b', by: 'agent-1', ...extra } as never)) as never;

  beforeEach(async () => {
    tmp = await openTmpStore('session');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('91a8c640 B-AC5 the first sessioned mutation creates the session node, listed with id/agent/startedAt/endedAt/parentSessionId', async () => {
    expect(await sessions()).toEqual([]);
    data(await mk({ sessionId: 'S1' }));
    const list = await sessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'S1', agent: 'agent-1', parentSessionId: null });
    expect(typeof list[0]!.startedAt).toBe('string');
    expect(list[0]!.endedAt).not.toBeNull(); // the latest op's time (no explicit end verb)
  });

  it('91a8c640 B-AC5 the session node is created once, not per call', async () => {
    data(await mk({ sessionId: 'S1' }));
    data(await mk({ sessionId: 'S1' }));
    expect(await sessions()).toHaveLength(1);
    const n = await tmp.store.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'session'");
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('91a8c640 B-AC5 a child session links child_of_session to its parent (stub parent created when unknown)', async () => {
    data(await mk({ sessionId: 'S1.1', parentSessionId: 'S1' }));
    const list = await sessions();
    const byId = new Map(list.map((s) => [s.sessionId, s]));
    expect(byId.get('S1.1')?.parentSessionId).toBe('S1');
    expect(byId.has('S1')).toBe(true);
    expect(await sessions({ parentSessionId: 'S1' })).toHaveLength(1);
    expect((await sessions({ agent: 'agent-1' })).length).toBe(2);
    expect(await sessions({ sessionId: 'nope' })).toEqual([]);
  });

  it('91a8c640 B-AC5 a conflicting second parent is invalid_argument and writes nothing', async () => {
    data(await mk({ sessionId: 'S1.1', parentSessionId: 'S1' }));
    const before = await tmp.store.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'op_event'");
    const r = await mk({ sessionId: 'S1.1', parentSessionId: 'S2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_argument');
    const after = await tmp.store.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'op_event'");
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    expect((await sessions()).find((s) => s.sessionId === 'S1.1')?.parentSessionId).toBe('S1');
  });

  it('91a8c640 B-AC5 parentSessionId without sessionId, a self-parent, and a blank id are invalid_argument', async () => {
    for (const extra of [{ parentSessionId: 'S1' }, { sessionId: 'S1', parentSessionId: 'S1' }, { sessionId: '' }]) {
      const r = await mk(extra);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_argument');
    }
    expect(await sessions()).toEqual([]);
  });
});
