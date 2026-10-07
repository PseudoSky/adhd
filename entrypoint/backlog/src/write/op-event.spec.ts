/**
 * op-event.spec.ts — 91a8c640 B-AC6 (S11.S2): each of
 * create/update/transition/claim/renew/release/relate/remove/restore appends
 * exactly ONE op-event `{sessionId, agent, op, targetUid, delta, t}` to an
 * append-only log that is NOT derived from `auditTrail`; an un-sessioned call
 * writes none; the log survives close and reopen.
 *
 * Real store + real api verbs; the log is read back with direct SQL.
 *
 * Negative control (run once, restored): skipping `appendOpEventTx` in
 * `writeAudit` turns every sessioned row red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

interface IOp {
  sessionId: string;
  agent: string;
  op: string;
  targetUid: string;
  delta: Record<string, unknown>;
  t: string;
}

describe('91a8c640 B-AC6 — append-only op-event log', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;

  async function ops(store = tmp.store): Promise<IOp[]> {
    const { rows } = await store.adapter.executeAll<{ meta: string }>(
      "SELECT meta FROM node WHERE kind = 'op_event' AND t_invalid IS NULL ORDER BY rowid ASC"
    );
    return rows.map((r) => JSON.parse(r.meta) as IOp);
  }

  beforeEach(async () => {
    tmp = await openTmpStore('op-event');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('91a8c640 B-AC6 every mutating verb in the table appends exactly one op-event, in order, with the full shape', async () => {
    const S = { sessionId: 'S1' };
    const a = data(await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1', ...S } as never)).uid as string;
    const b = data(await api.create(ctx, { project, title: 'b', body: 'bb', by: 'agent-1', ...S } as never)).uid as string;
    expect((await ops()).map((o) => o.op)).toEqual(['created', 'created']);

    type Step = { name: string; expectOp: string; run: () => Promise<unknown> };
    let cur = a;
    const steps: Step[] = [
      { name: 'update', expectOp: 'updated', run: async () => { const env = await api.update(ctx, { uid: cur, by: 'agent-1', title: 'a2', ...S } as never); cur = data(env).uid; return env; } },
      { name: 'transition', expectOp: 'transitioned', run: () => api.transition(ctx, { uid: cur, by: 'agent-1', toStatus: 'in_progress', note: 'go', ...S } as never) },
      { name: 'claim', expectOp: 'claimed', run: () => api.claim(ctx, { uid: cur, by: 'agent-1', action: 'claim', ...S } as never) },
      { name: 'renew', expectOp: 'renewed', run: () => api.claim(ctx, { uid: cur, by: 'agent-1', action: 'renew', ...S } as never) },
      { name: 'release', expectOp: 'released', run: () => api.claim(ctx, { uid: cur, by: 'agent-1', action: 'release', ...S } as never) },
      { name: 'relate', expectOp: 'related', run: () => api.relate(ctx, { sourceUid: cur, targetUid: b, rel: 'relates_to', action: 'add', by: 'agent-1', ...S } as never) },
      { name: 'remove', expectOp: 'deleted', run: () => api.delete(ctx, { uid: b, by: 'agent-1', reason: 'x', ...S } as never) },
      { name: 'restore', expectOp: 'restored', run: () => api.restore(ctx, { uid: b, by: 'agent-1', ...S } as never) },
    ];
    for (const step of steps) {
      const before = (await ops()).length;
      data(await (step.run() as Promise<IOutcomeEnvelope<unknown>>));
      const after = await ops();
      expect(after.length, step.name).toBe(before + 1);
      const last = after[after.length - 1]!;
      expect(last, step.name).toMatchObject({ sessionId: 'S1', agent: 'agent-1', op: step.expectOp });
      expect(typeof last.t).toBe('string');
      expect(last.delta).toBeTypeOf('object');
      expect(typeof last.targetUid).toBe('string');
      expect(last.targetUid.length).toBeGreaterThan(0);
    }
    // `remove` (hard, confirmed) on a third item.
    const c = data(await api.create(ctx, { project, title: 'c', body: 'cb', by: 'agent-1', ...S } as never)).uid as string;
    const beforeRemove = (await ops()).length;
    data(await api.remove(ctx, { uid: c, confirm: true, by: 'agent-1', reason: 'cleanup', ...S } as never));
    const afterRemove = await ops();
    expect(afterRemove.length).toBe(beforeRemove + 1);
    expect(afterRemove[afterRemove.length - 1]).toMatchObject({ sessionId: 'S1', agent: 'agent-1', targetUid: c });

    const transitioned = (await ops()).find((o) => o.op === 'transitioned')!;
    expect(transitioned.delta).toMatchObject({ to: 'in_progress', note: 'go' });
  });

  it('91a8c640 B-AC6 the log is independent of auditTrail: separate node kind + edge, auditTrail shape unchanged', async () => {
    const a = data(await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1', sessionId: 'S1' } as never)).uid as string;
    const kinds = await tmp.store.adapter.executeAll<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM node WHERE kind IN ('audit','op_event') GROUP BY kind"
    );
    const count = new Map(kinds.rows.map((r) => [r.kind, Number(r.n)]));
    expect(count.get('op_event')).toBe(1);
    expect(count.get('audit')).toBeGreaterThanOrEqual(1);
    const edge = await tmp.store.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM edge WHERE rel = 'in_session' AND t_invalid IS NULL");
    expect(Number(edge.rows[0]!.n)).toBe(1);
    const card = data(await api.get(ctx, { uid: a, fields: ['auditTrail'] })) as { auditTrail: Array<Record<string, unknown>> };
    for (const entry of card.auditTrail) {
      expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['uid', 'actor', 'action', 'sha', 'at']));
      expect(entry).not.toHaveProperty('sessionId');
    }
  });

  it('91a8c640 B-AC6 an un-sessioned call writes no session node and no op-event', async () => {
    data(await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1' } as never));
    expect(await ops()).toEqual([]);
    const s = await tmp.store.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'session'");
    expect(Number(s.rows[0]!.n)).toBe(0);
  });

  it('91a8c640 B-AC6 a refused call (blank sessionId) is invalid_argument and writes nothing', async () => {
    const r = await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1', sessionId: '  ' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_argument');
    expect(await ops()).toEqual([]);
  });

  it('91a8c640 B-AC6 the log survives close and reopen', async () => {
    data(await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1', sessionId: 'S1' } as never));
    const before = await ops();
    await closeGraphBacklogStore(tmp.store);
    tmp.store = await openGraphBacklogStore(tmp.dbPath);
    expect(await ops(tmp.store)).toEqual(before);
    expect(before).toHaveLength(1);
  });
});
