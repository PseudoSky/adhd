/**
 * reservation.explicit-paths.spec.ts — 56f736c9 (the ticket states no numbered
 * ACs; AC1..AC3 map to its stated expectations):
 *   AC1  `renew` keeps the explicit `paths` named by the original claim;
 *   AC2  re-claim by the holder (`held`) keeps them too, and the
 *        "who holds file F" reservations query still sees them afterwards;
 *   AC3  a renew that names MORE paths unions them, and a different holder's
 *        claim never inherits another holder's explicit paths.
 *
 * UNIT tests (real store + real verbs). Negative control (run once, restored):
 * in claim.ts `reserve`, drop the `liveExplicitPathsTx` union -> AC1/AC2 red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('56f736c9 — renew / re-claim keep explicit reservation paths', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let issue: string;
  let fileA: string;
  let extra: string;
  let extra2: string;

  async function livePaths(): Promise<string[]> {
    const { rows } = await tmp.store.adapter.executeAll<{ meta: string }>(
      "SELECT meta FROM node WHERE kind = 'reservation' AND t_invalid IS NULL AND json_extract(meta, '$.endedAt') IS NULL ORDER BY rowid ASC"
    );
    expect(rows).toHaveLength(1);
    return (JSON.parse(rows[0]!.meta) as { paths: string[] }).paths;
  }
  async function holdersOf(path: string): Promise<string[]> {
    const out = data(
      await api.query(ctx, { view: 'reservations', filter: { pathPrefix: path } } as never)
    ) as unknown as { items: Array<{ holder: string }> };
    return out.items.map((i) => i.holder);
  }

  beforeEach(async () => {
    tmp = await openTmpStore('reservation-explicit');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const root = join(tmp.dir, 'proj');
    mkdirSync(join(root, 'src'), { recursive: true });
    fileA = join(root, 'src', 'a.ts');
    extra = join(root, 'src', 'extra.ts');
    extra2 = join(root, 'src', 'extra2.ts');
    writeFileSync(fileA, 'a\n');
    const project = data(await api.upsertProject(ctx, { name: 'proj', path: root, by: 's' })).uid;
    issue = data(
      await api.create(ctx, { project, title: 't', body: 'b', by: 'filer', citations: [{ file: fileA }] } as never)
    ).uid as string;
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('56f736c9 AC1 — a plain renew keeps the explicit claim paths', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', paths: [extra] } as never));
    expect(await livePaths()).toEqual([fileA, extra].sort());
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'renew' }));
    expect(await livePaths()).toEqual([fileA, extra].sort());
  });

  it('56f736c9 AC2 — re-claim by the holder keeps them and the who-holds-file query still sees the holder', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', paths: [extra] } as never));
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim' }));
    expect(await livePaths()).toEqual([fileA, extra].sort());
    expect(await holdersOf(extra)).toEqual(['agent-a']);
  });

  it('56f736c9 AC3 — a renew naming more paths unions them with the stored ones', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', paths: [extra] } as never));
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'renew', paths: [extra2] } as never));
    expect(await livePaths()).toEqual([fileA, extra, extra2].sort());
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'renew' }));
    expect(await livePaths()).toEqual([fileA, extra, extra2].sort());
  });

  it('56f736c9 AC3 — after release a new holder starts with only its own paths', async () => {
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'claim', paths: [extra] } as never));
    data(await api.claim(ctx, { uid: issue, by: 'agent-a', action: 'release' }));
    data(await api.claim(ctx, { uid: issue, by: 'agent-b', action: 'claim' }));
    expect(await livePaths()).toEqual([fileA]);
  });
});
