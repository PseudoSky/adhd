/**
 * membership.spec.ts — e54bd58b A-AC5 (S02.S2): an issue citing evidence in 2
 * components across 2 projects is returned by a spanning `query` for BOTH
 * projects while `get` reports EXACTLY ONE `primaryOwner`; the existing
 * `project`/`component` filters keep primary-owner semantics.
 *
 * Real store + real api verbs. Negative controls (run once, restored):
 * (a) drop the `in_component` write -> the spanning query row goes red;
 * (b) make `filter.project` use membership -> the primary-count row goes red;
 * (c) add `in_component` to `EDGES_NEVER_SWEPT` -> the update-carry row goes red.
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

describe('e54bd58b A-AC5 — n:m membership with one primary owner', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let p1: string;
  let p2: string;
  let c1: string;
  let c1b: string;
  let c2: string;
  let file1: string;
  let file2: string;
  let issue: string;

  async function ids(filter: Record<string, unknown>): Promise<string[]> {
    const out = data(await api.query(ctx, { filter, fields: ['uid'], limit: 50 } as never)) as { items: Array<{ uid: string }> };
    return out.items.map((i) => i.uid);
  }
  async function card(uid: string): Promise<{ primaryOwner: { projectUid: string; componentUid: string } | null; memberships: Array<{ componentUid: string; via: string }> }> {
    return data(await api.get(ctx, { uid, fields: ['primaryOwner', 'memberships'] })) as never;
  }

  beforeEach(async () => {
    tmp = await openTmpStore('membership');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const d1 = join(tmp.dir, 'proj-one');
    const d2 = join(tmp.dir, 'proj-two');
    mkdirSync(join(d1, 'pkg-a'), { recursive: true });
    mkdirSync(join(d1, 'pkg-b'), { recursive: true });
    mkdirSync(join(d2, 'pkg-x'), { recursive: true });
    file1 = join(d1, 'pkg-a', 'a.ts');
    file2 = join(d2, 'pkg-x', 'x.ts');
    writeFileSync(file1, 'a\n');
    writeFileSync(file2, 'x\n');
    p1 = data(await api.upsertProject(ctx, { name: 'proj-one', path: d1, by: 'seed' })).uid;
    p2 = data(await api.upsertProject(ctx, { name: 'proj-two', path: d2, by: 'seed' })).uid;
    c1 = data(await api.upsertComponent(ctx, { project: p1, name: 'pkg-a', by: 'seed' })).uid;
    c1b = data(await api.upsertComponent(ctx, { project: p1, name: 'pkg-b', by: 'seed' })).uid;
    c2 = data(await api.upsertComponent(ctx, { project: p2, name: 'pkg-x', by: 'seed' })).uid;
    data(await api.upsertLocation(ctx, { component: c1, locType: 'path', value: join(d1, 'pkg-a'), by: 'seed' }));
    data(await api.upsertLocation(ctx, { component: c1b, locType: 'path', value: join(d1, 'pkg-b'), by: 'seed' }));
    data(await api.upsertLocation(ctx, { component: c2, locType: 'path', value: join(d2, 'pkg-x'), by: 'seed' }));
    issue = data(
      await api.create(ctx, {
        project: p1,
        component: c1,
        title: 'spans two projects',
        body: 'cites evidence in pkg-a and pkg-x',
        by: 'filer',
        citations: [{ file: file1 }, { file: file2 }],
      } as never)
    ).uid as string;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('e54bd58b A-AC5 — get reports exactly ONE primaryOwner and both memberships', async () => {
    const c = await card(issue);
    expect(c.primaryOwner).toMatchObject({ projectUid: p1, componentUid: c1 });
    expect(c.memberships.map((m) => [m.componentUid, m.via]).sort()).toEqual(
      [[c1, 'primary'], [c2, 'citation']].sort()
    );
  });

  it('e54bd58b A-AC5 — a spanning query returns the issue for BOTH projects; project/component filters stay primary-owner', async () => {
    expect(await ids({ memberOfProject: [p1, p2] })).toEqual([issue]);
    expect(await ids({ memberOfProject: p2 })).toEqual([issue]);
    expect(await ids({ memberOfComponent: c2 })).toEqual([issue]);
    expect(await ids({ project: p1 })).toEqual([issue]);
    expect(await ids({ project: p2 })).toEqual([]);
    expect(await ids({ component: c2 })).toEqual([]);
  });

  it('e54bd58b A-AC5 — a body edit (supersede) carries the memberships onto the head', async () => {
    const head = data(await api.update(ctx, { uid: issue, by: 'x', body: 'a new body that supersedes the node' })).uid as string;
    expect(head).not.toBe(issue);
    const c = await card(head);
    expect(c.memberships.map((m) => m.componentUid).sort()).toEqual([c1, c2].sort());
    expect(c.primaryOwner?.componentUid).toBe(c1);
  });

  it('e54bd58b A-AC5 — move re-points the primary and its membership; the citation membership stays', async () => {
    data(await api.move(ctx, { uid: issue, by: 'x', toComponent: c1b }));
    const c = await card(issue);
    expect(c.primaryOwner?.componentUid).toBe(c1b);
    expect(c.memberships.map((m) => [m.componentUid, m.via]).sort()).toEqual(
      [[c1b, 'primary'], [c2, 'citation'], [c1, 'citation']].sort()
    );
  });

  it('e54bd58b A-AC5 — removing the citation drops ONLY that citation membership', async () => {
    const cits = (data(await api.get(ctx, { uid: issue, fields: ['citations'] })) as unknown as { citations: Array<{ uid: string; file: string }> }).citations;
    const x = cits.find((c) => c.file === file2)!;
    data(await api.removeCitation(ctx, { uid: x.uid, by: 'x' }));
    const c = await card(issue);
    expect(c.memberships.map((m) => m.componentUid)).toEqual([c1]);
    expect(await ids({ memberOfProject: p2 })).toEqual([]);
  });

  it('e54bd58b A-AC5 — a citation matching no registered component adds no membership (never a wrong one)', async () => {
    const stray = join(tmp.dir, 'unregistered.txt');
    writeFileSync(stray, 'z\n');
    data(await api.addCitation(ctx, { uid: issue, by: 'x', citation: { file: stray } }));
    expect((await card(issue)).memberships).toHaveLength(2);
  });
});
