/**
 * reservation.spec.ts — 46cf1086 B-AC1 (S11.R1): every claim / renew / release
 * persists `{issueUid, paths[], holder, sessionId, claimedAt, leaseExpiry}` and
 * the record survives close and reopen of the store; ended reservations remain
 * (interval history).
 *
 * Real store + real api verbs; persistence is read back with direct SQL, never
 * a returned object, and again after a REOPEN.
 *
 * Negative control (run once, restored): persisting only `meta.claimedBy`
 * (today's pre-change behaviour — i.e. not calling `recordReservationTx`) turns
 * every row red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

interface IRes {
  issueUid: string;
  paths: string[];
  holder: string;
  sessionId?: string;
  claimedAt: string;
  leaseExpiry: string;
  endedAt?: string;
  endReason?: string;
}

describe('46cf1086 B-AC1 — claim reservations persist', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let issue: string;
  let fileA: string;
  let fileB: string;
  let extra: string;

  async function reservations(store = tmp.store): Promise<IRes[]> {
    const { rows } = await store.adapter.executeAll<{ meta: string }>(
      "SELECT meta FROM node WHERE kind = 'reservation' AND t_invalid IS NULL ORDER BY rowid ASC"
    );
    return rows.map((r) => JSON.parse(r.meta) as IRes);
  }

  beforeEach(async () => {
    tmp = await openTmpStore('reservation');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const root = join(tmp.dir, 'proj');
    mkdirSync(join(root, 'src'), { recursive: true });
    fileA = join(root, 'src', 'a.ts');
    fileB = join(root, 'src', 'b.ts');
    extra = join(root, 'src', 'extra.ts');
    writeFileSync(fileA, 'a\n');
    writeFileSync(fileB, 'b\n');
    const project = data(await api.upsertProject(ctx, { name: 'proj', path: root, by: 's' })).uid;
    issue = data(
      await api.create(ctx, {
        project,
        title: 't',
        body: 'b',
        by: 'filer',
        citations: [{ file: fileA }, { file: 'src/b.ts' }, { file: 'url:https://example.com/x' }],
      } as never)
    ).uid as string;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('46cf1086 B-AC1 claim persists holder, paths (path citations + explicit), sessionId, claimedAt and leaseExpiry', async () => {
    const r = data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', paths: [extra], sessionId: 'S1' } as never));
    const rows = await reservations();
    expect(rows).toHaveLength(1);
    const res = rows[0]!;
    expect(res.issueUid).toBe(issue);
    expect(res.holder).toBe('agent-a');
    expect(res.sessionId).toBe('S1');
    expect(res.claimedAt).toBe(r.claimedAt);
    expect(res.paths).toEqual([fileA, fileB, extra].sort()); // abstract url: anchor is not a path
    // leaseExpiry = claimedAt + claim_stale_after_min (default policy), strictly after claimedAt.
    expect(Date.parse(res.leaseExpiry)).toBeGreaterThan(Date.parse(res.claimedAt));
    expect(res.endedAt).toBeUndefined();
  });

  it('46cf1086 B-AC1 renew refreshes the live reservation in place; release ends it and keeps the history', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim' }));
    const first = (await reservations())[0]!;
    const renewed = data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'renew' }));
    let rows = await reservations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimedAt).toBe(renewed.claimedAt);
    expect(Date.parse(rows[0]!.leaseExpiry)).toBeGreaterThanOrEqual(Date.parse(first.leaseExpiry));
    expect(rows[0]!.leaseExpiry).toBe(new Date(Date.parse(renewed.claimedAt!) + (Date.parse(first.leaseExpiry) - Date.parse(first.claimedAt))).toISOString());

    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'release' }));
    rows = await reservations();
    expect(rows).toHaveLength(1); // history kept
    expect(rows[0]!.endReason).toBe('released');
    expect(rows[0]!.endedAt).toBeDefined();
  });

  it('46cf1086 B-AC1 a force reclaim by another agent ends the old reservation and starts a new one', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim' }));
    data(await api.claim(ctx, { uid: issue, by: 'agent-b', action: 'claim', force: true }));
    const rows = await reservations();
    expect(rows.map((r) => [r.holder, r.endReason ?? null])).toEqual([
      ['agent-a', 'reclaimed-stale'],
      ['agent-b', null],
    ]);
  });

  it('46cf1086 B-AC1 the records survive close and reopen of the store', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', sessionId: 'S1' } as never));
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'release' }));
    data(await api.claim(ctx, { uid: issue, by: 'agent-b', action: 'claim' }));
    const before = await reservations();
    await closeGraphBacklogStore(tmp.store);
    tmp.store = await openGraphBacklogStore(tmp.dbPath);
    const after = await reservations(tmp.store);
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    expect(after[0]!.endReason).toBe('released');
    expect(after[1]!.holder).toBe('agent-b');
    expect(after[1]!.endedAt).toBeUndefined();
  });

  it('46cf1086 B-AC1 a release by a non-holder is a no-op and writes no reservation change', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim' }));
    const before = await reservations();
    const r = data(await api.claim(ctx, { uid: issue, by: 'agent-b', action: 'release' }));
    expect(r.status).toBe('release-noop');
    expect(await reservations()).toEqual(before);
  });
});
