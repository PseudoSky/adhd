/**
 * superseded-fields.spec.ts — 7ef53d55 A-AC8 (S02.T3 read side): `query
 * {filter:{status:"SUPERSEDED"}, fields:["supersedeReason","supersededBy"]}`
 * returns, for every SUPERSEDED node, a reason and a successor-or-null, so
 * "0 SUPERSEDED nodes without a reason" is a single checkable query.
 *
 * Real store + real api verbs. Negative control (run once, restored): seed one
 * reasonless SUPERSEDED node -> the "none reasonless" assertion goes red.
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
interface IRow { uid: string; supersedeReason: string | null; supersededBy: string | null }

describe('7ef53d55 A-AC8 — SUPERSEDED nodes carry reason + successor-or-none', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;
  const mk = async (title: string): Promise<string> =>
    data(await api.create(ctx, { project, title, body: `${title} b`, by: 'f' } as never)).uid as string;
  const superseded = async (): Promise<IRow[]> =>
    (data(
      await api.query(ctx, {
        filter: { status: 'SUPERSEDED' },
        fields: ['uid', 'supersedeReason', 'supersededBy'],
        limit: 100,
      } as never)
    ) as { items: IRow[] }).items;

  beforeEach(async () => {
    tmp = await openTmpStore('superseded-fields');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('7ef53d55 A-AC8 returns reason and successor-or-null for each SUPERSEDED node', async () => {
    const a = await mk('a');
    const b = await mk('b');
    const c = await mk('c');
    await api.transition(ctx, { uid: a, by: 'o', toStatus: 'SUPERSEDED', note: 'n', reason: 'prior-model-premise-deletion', supersededBy: c });
    await api.transition(ctx, { uid: b, by: 'o', toStatus: 'SUPERSEDED', note: 'n', reason: 'imported-never-transitioned' });
    const rows = await superseded();
    const byUid = new Map(rows.map((r) => [r.uid, r]));
    expect(byUid.get(a)).toMatchObject({ supersedeReason: 'prior-model-premise-deletion', supersededBy: c });
    expect(byUid.get(b)).toMatchObject({ supersedeReason: 'imported-never-transitioned', supersededBy: null });
    expect(rows.filter((r) => r.supersedeReason === null)).toEqual([]);
  });

  it('7ef53d55 A-AC8 a reasonless node is surfaced (residual list) rather than invented', async () => {
    const a = await mk('a');
    await api.transition(ctx, { uid: a, by: 'o', toStatus: 'SUPERSEDED', note: 'n' });
    const rows = await superseded();
    expect(rows.filter((r) => r.supersedeReason === null).map((r) => r.uid)).toEqual([a]);
  });

  it('7ef53d55 A-AC8 a later same-status transition adds the reason (backfill path)', async () => {
    const a = await mk('a');
    await api.transition(ctx, { uid: a, by: 'o', toStatus: 'SUPERSEDED', note: 'n' });
    data(await api.transition(ctx, { uid: a, by: 'o', toStatus: 'SUPERSEDED', note: 'S02.T3 backfill', reason: 'status-token-correction' }));
    const rows = await superseded();
    expect(rows.find((r) => r.uid === a)?.supersedeReason).toBe('status-token-correction');
  });
});
