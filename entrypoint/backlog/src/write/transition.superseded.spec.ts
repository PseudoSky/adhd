/**
 * transition.superseded.spec.ts — 7ef53d55 A-AC6 (S02.T2) and A-AC7 (S02.T1,
 * additive form).
 *
 * A-AC6: `transition {toStatus:"SUPERSEDED", supersededBy, reason}` writes the
 * `supersedes` edge retired -> successor IN THE SAME TRANSACTION (an
 * unresolvable successor leaves the status unchanged) and a graph walk from the
 * retired uid reaches the successor.
 * A-AC7: `reason` is an optional closed enum; out-of-enum is `invalid_argument`;
 * a reasonless SUPERSEDED succeeds with `warnings:["superseded-without-reason"]`;
 * reason/supersededBy on a non-SUPERSEDED transition is `invalid_argument`.
 *
 * Real store + real api verbs. Negative controls (run once, restored):
 * - A-AC6: write the edge after the commit (outside the tx) -> the rollback
 *   row goes red.
 * - A-AC7: accept a free-text reason -> the bogus-reason row goes red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import { SUPERSEDE_REASONS } from './transition.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('7ef53d55 SUPERSEDED reason + successor edge', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;
  let a: string;
  let b: string;

  async function mk(title: string): Promise<string> {
    return data(
      await api.create(ctx, { project, title, body: `${title} body`, by: 'filer' } as never)
    ).uid as string;
  }
  async function statusOf(uid: string): Promise<string> {
    const card = data(await api.get(ctx, { uid, fields: ['status'] })) as { status: string };
    return card.status;
  }
  async function supersededBy(uid: string): Promise<string | null> {
    const card = data(await api.get(ctx, { uid, fields: ['supersededBy'] })) as { supersededBy: string | null };
    return card.supersededBy;
  }

  beforeEach(async () => {
    tmp = await openTmpStore('superseded');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 'seed' })).uid;
    a = await mk('retired');
    b = await mk('successor');
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('7ef53d55 A-AC6 writes the supersedes edge retired -> successor with the status change', async () => {
    const r = data(
      await api.transition(ctx, {
        uid: a,
        by: 'op',
        toStatus: 'SUPERSEDED',
        note: 'replaced',
        supersededBy: b,
        reason: 'deliberate-plan-retirement',
      })
    );
    expect(r.toStatus).toBe('SUPERSEDED');
    expect(r.warnings).toBeUndefined();
    expect(await statusOf(a)).toBe('SUPERSEDED');
    expect(await supersededBy(a)).toBe(b);
    const rs = data(await api.get(ctx, { uid: a, fields: ['supersedeReason'] })) as { supersedeReason: string | null };
    expect(rs.supersedeReason).toBe('deliberate-plan-retirement');
  });

  it('7ef53d55 A-AC6 cascade-scan from the retired uid reaches the successor', async () => {
    data(
      await api.transition(ctx, { uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n', supersededBy: b })
    );
    const g = data(
      await api.query(ctx, { view: 'graph', filter: { anchor: a }, limit: 50 } as never)
    ) as unknown;
    expect(JSON.stringify(g)).toContain(b);
  });

  it('7ef53d55 A-AC6 an unresolvable successor rolls the status change back', async () => {
    const r = await api.transition(ctx, {
      uid: a,
      by: 'op',
      toStatus: 'SUPERSEDED',
      note: 'n',
      supersededBy: 'deadbeef-no-such-issue',
    });
    expect(r.ok).toBe(false);
    expect(await statusOf(a)).not.toBe('SUPERSEDED');
    expect(await supersededBy(a)).toBeNull();
  });

  it('7ef53d55 A-AC6 a self successor is invalid_argument and changes nothing', async () => {
    const r = await api.transition(ctx, {
      uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n', supersededBy: a,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_argument');
    expect(await statusOf(a)).not.toBe('SUPERSEDED');
  });

  it.each([...SUPERSEDE_REASONS])('7ef53d55 A-AC7 accepts reason %s', async (reason) => {
    const r = data(
      await api.transition(ctx, { uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n', reason })
    );
    expect(r.warnings).toBeUndefined();
    const rs = data(await api.get(ctx, { uid: a, fields: ['supersedeReason'] })) as { supersedeReason: string | null };
    expect(rs.supersedeReason).toBe(reason);
  });

  it('7ef53d55 A-AC7 an out-of-enum reason is invalid_argument', async () => {
    const r = await api.transition(ctx, {
      uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n', reason: 'bogus' as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_argument');
    expect(await statusOf(a)).not.toBe('SUPERSEDED');
  });

  it('7ef53d55 A-AC7 a reasonless SUPERSEDED succeeds with the warning', async () => {
    const r = await api.transition(ctx, { uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual(['superseded-without-reason']);
      expect(r.data.warnings).toEqual(['superseded-without-reason']);
    }
    expect(await statusOf(a)).toBe('SUPERSEDED');
  });

  it('7ef53d55 A-AC7 reason or supersededBy on a non-SUPERSEDED transition is invalid_argument', async () => {
    const r1 = await api.transition(ctx, {
      uid: a, by: 'op', toStatus: 'in_progress', note: 'n', reason: 'status-token-correction',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('invalid_argument');
    const r2 = await api.transition(ctx, {
      uid: a, by: 'op', toStatus: 'in_progress', note: 'n', supersededBy: b,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('invalid_argument');
  });

  it('7ef53d55 A-AC6 a different second successor is a conflict (n:1)', async () => {
    const c = await mk('other');
    data(await api.transition(ctx, { uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'n', supersededBy: b }));
    const r = await api.transition(ctx, { uid: a, by: 'op', toStatus: 'SUPERSEDED', note: 'again', supersededBy: c });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('conflict');
    expect(await supersededBy(a)).toBe(b);
  });
});
