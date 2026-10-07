/**
 * registry-orphans.spec.ts — 39799f8e A-AC12 (S02 AC16 / C4): `view:"projects"`
 * lists each project once, and the identity detector (`view:"registry-orphans"`)
 * reports duplicate identities, then reports 0 for them after `merge-project`
 * records the Redirect.
 *
 * Real store + real verbs (`upsertProject`, `mergeProject`). Negative control
 * (run once, restored): skipping the merge keeps the `duplicate-identity`
 * finding, so the "0 after merge" assertion goes red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import { normalizeProjectIdentity } from './views/registry.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}
type Finding = { kind: string; [k: string]: unknown };

describe('39799f8e A-AC12 — project identity detector', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;

  const findings = async (): Promise<Finding[]> =>
    (data(await api.query(ctx, { view: 'registry-orphans' } as never)) as unknown as { findings: Finding[] }).findings;
  const duplicates = async (): Promise<Finding[]> => (await findings()).filter((f) => f.kind === 'duplicate-identity');
  const projectNames = async (): Promise<string[]> =>
    (data(await api.query(ctx, { view: 'projects' } as never)) as unknown as { items: Array<{ name: string }> }).items.map((p) => p.name);

  beforeEach(async () => {
    tmp = await openTmpStore('registry-orphans');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('39799f8e A-AC12 normalizeProjectIdentity folds scheme, user@, .git, trailing slash and scp form', () => {
    const n = (repoUrl: string): string | undefined => normalizeProjectIdentity({ name: 'x', repoUrl }, 'repoUrl');
    const want = 'github.com/pseudosky/adhd';
    expect(n('https://github.com/PseudoSky/adhd.git')).toBe(want);
    expect(n('git@github.com:PseudoSky/adhd.git')).toBe(want);
    expect(n('ssh://git@github.com/PseudoSky/adhd/')).toBe(want);
    expect(n('github.com/pseudosky/adhd')).toBe(want);
    expect(normalizeProjectIdentity({ name: 'PseudoSky/adhd' }, 'name-suffix')).toBe('adhd');
    expect(normalizeProjectIdentity({ name: 'x', path: '/a/b/' }, 'path')).toBe('/a/b');
    expect(normalizeProjectIdentity({ name: 'x' }, 'repoUrl')).toBeUndefined();
  });

  it('39799f8e A-AC12 a seeded duplicate is reported, then 0 after merge-project (Redirect recorded)', async () => {
    const keep = data(await api.upsertProject(ctx, { name: 'PseudoSky/adhd', repoUrl: 'https://github.com/PseudoSky/adhd.git', by: 's' })).uid;
    const dupe = data(await api.upsertProject(ctx, { name: 'adhd-copy', repoUrl: 'git@github.com:pseudosky/adhd', by: 's' })).uid;
    data(await api.upsertProject(ctx, { name: 'unrelated', repoUrl: 'https://example.com/other', by: 's' }));

    const before = await duplicates();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ evidence: 'repoUrl', normalized: 'github.com/pseudosky/adhd' });
    expect([...(before[0]!.projectUids as string[])].sort()).toEqual([keep, dupe].sort());
    // The duplicate is reported by the detector, NOT hidden from the projects view.
    expect((await projectNames()).sort()).toEqual(['PseudoSky/adhd', 'adhd-copy', 'unrelated']);

    data(await api.mergeProject(ctx, { fromUid: dupe, toUid: keep, by: 'op' }));
    expect(await duplicates()).toEqual([]);
    const names = await projectNames();
    expect(names.sort()).toEqual(['PseudoSky/adhd', 'unrelated']);
    expect(names.filter((n) => n === 'adhd-copy')).toEqual([]);
    // The retired project still resolves by name via its Redirect.
    const detail = data(await api.get(ctx, { registry: 'project', name: 'adhd-copy' } as never)) as unknown as { uid: string };
    expect(detail.uid).toBe(keep);
  });

  it('39799f8e A-AC12 name-suffix evidence is reported (reviewed merge), strongest evidence wins per uid set', async () => {
    const a = data(await api.upsertProject(ctx, { name: 'id8/dot', by: 's' })).uid;
    const b = data(await api.upsertProject(ctx, { name: 'dot', by: 's' })).uid;
    const d = await duplicates();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ evidence: 'name-suffix', normalized: 'dot' });
    expect([...(d[0]!.projectUids as string[])].sort()).toEqual([a, b].sort());

    const c = data(await api.upsertProject(ctx, { name: 'dot-fork', repoUrl: 'https://x.io/r', by: 's' })).uid;
    const e = data(await api.upsertProject(ctx, { name: 'dot-fork2', repoUrl: 'https://X.io/r.git', by: 's' })).uid;
    const strong = (await duplicates()).filter((f) => f.evidence === 'repoUrl');
    expect(strong).toHaveLength(1);
    expect([...(strong[0]!.projectUids as string[])].sort()).toEqual([c, e].sort());
  });

  it('39799f8e A-AC12 a component whose meta.projectUid disagrees with its owns_project edge is flagged', async () => {
    const p = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
    const comp = data(await api.upsertComponent(ctx, { project: p, name: 'c', by: 's' })).uid;
    expect((await findings()).filter((f) => f.kind === 'component-project-mismatch')).toEqual([]);
    await tmp.store.adapter.executeRun(
      "UPDATE node SET meta = json_set(meta, '$.projectUid', 'stale-project-uid') WHERE uid = ?",
      [comp]
    );
    const mm = (await findings()).filter((f) => f.kind === 'component-project-mismatch');
    expect(mm).toEqual([{ kind: 'component-project-mismatch', componentUid: comp, metaProjectUid: 'stale-project-uid', edgeProjectUid: p }]);
  });

  it('39799f8e A-AC12 an empty project (no issues, no locations) is flagged; one with an issue is not', async () => {
    const empty = data(await api.upsertProject(ctx, { name: 'empty', by: 's' })).uid;
    const used = data(await api.upsertProject(ctx, { name: 'used', by: 's' })).uid;
    data(await api.create(ctx, { project: used, title: 't', body: 'b', by: 'f' } as never));
    const flagged = (await findings()).filter((f) => f.kind === 'empty-project').map((f) => f.projectUid);
    expect(flagged).toContain(empty);
    expect(flagged).not.toContain(used);
  });
});
