/**
 * orphaned-parent.spec.ts — 7a78312c + 0b0df8f3 A-AC9 (S02 AC14 tail): a
 * terminal parent with open `part_of` children is flagged as an
 * `orphaned-parent` condition by BOTH the per-root rollup read and the
 * store-wide `view:"orphaned-parents"` enumeration (no uid needed).
 *
 * Seeded fixture: terminal parent + 2 open children -> flagged; both children
 * resolved -> not flagged; a NON-terminal parent with open children -> not
 * flagged. A live check of eda36770 is NOT run (Q4 left nothing open under it).
 *
 * Negative control (run once, restored): computing the parent's terminality as
 * always-false turns the first assertion red.
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

describe('7a78312c/0b0df8f3 A-AC9 — orphaned-parent condition', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;
  let parent: string;
  let c1: string;
  let c2: string;

  const mk = async (title: string): Promise<string> =>
    data(await api.create(ctx, { project, title, body: `${title} b`, by: 'f' } as never)).uid as string;
  const close = async (uid: string): Promise<void> => {
    data(await api.transition(ctx, { uid, by: 'o', toStatus: 'closed', note: 'done' }));
  };
  const rollup = async (uid: string) => data(await api.partOfRollup(ctx, { uid }));
  const orphans = async () =>
    data(await api.query(ctx, { view: 'orphaned-parents' } as never)) as unknown as {
      view: string;
      items: Array<{ uid: string; status: string; openChildren: number; openChildUids: string[] }>;
      total: number;
    };

  beforeEach(async () => {
    tmp = await openTmpStore('orphaned-parent');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
    parent = await mk('parent');
    c1 = await mk('child one');
    c2 = await mk('child two');
    for (const c of [c1, c2]) {
      data(await api.relate(ctx, { sourceUid: c, targetUid: parent, rel: 'part_of', action: 'add', by: 'o' }));
    }
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('7a78312c A-AC9 a terminal parent with 2 open children is flagged by the rollup and the view', async () => {
    await close(parent);
    const r = await rollup(parent);
    expect(r.childrenOpen).toBe(2);
    expect(r.orphanedParent).toMatchObject({ parentStatus: 'closed', openChildren: 2 });
    expect([...(r.orphanedParent?.sampleOpenUids ?? [])].sort()).toEqual([c1, c2].sort());

    const o = await orphans();
    expect(o.view).toBe('orphaned-parents');
    expect(o.total).toBe(1);
    expect(o.items[0]).toMatchObject({ uid: parent, status: 'closed', openChildren: 2 });
  });

  it('7a78312c A-AC9 resolving the children clears the condition', async () => {
    await close(parent);
    await close(c1);
    expect((await rollup(parent)).orphanedParent).toBeDefined(); // one child still open
    await close(c2);
    const r = await rollup(parent);
    expect(r.childrenOpen).toBe(0);
    expect(r.orphanedParent).toBeUndefined();
    expect((await orphans()).items).toEqual([]);
  });

  it('7a78312c A-AC9 a NON-terminal parent with open children is not flagged', async () => {
    const r = await rollup(parent);
    expect(r.childrenOpen).toBe(2);
    expect(r.orphanedParent).toBeUndefined();
    expect((await orphans()).items).toEqual([]);
  });

  it('0b0df8f3 A-AC9 an open grandchild under a closed child still flags the terminal root (transitive)', async () => {
    const g = await mk('grandchild');
    data(await api.relate(ctx, { sourceUid: g, targetUid: c1, rel: 'part_of', action: 'add', by: 'o' }));
    await close(parent);
    await close(c1);
    await close(c2);
    const r = await rollup(parent);
    expect(r.orphanedParent).toMatchObject({ openChildren: 1, sampleOpenUids: [g] });
    const items = (await orphans()).items.map((i) => i.uid);
    expect(items).toContain(parent);
    expect(items).toContain(c1); // c1 is itself a closed parent with an open child
  });

  it('0b0df8f3 A-AC9 view limit is validated', async () => {
    const r = await api.query(ctx, { view: 'orphaned-parents', limit: 0 } as never);
    expect(r.ok).toBe(false);
  });
});
