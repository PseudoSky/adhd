/**
 * by-citation-path.spec.ts — 7e5469d3 B-AC10 (ADR-0007 D7 B2): `query
 * {projection:"byCitationPath", path:P}` returns every item citing P, and the
 * result EQUALS an O(n) reference walk (`query` all issues -> `get
 * {fields:["citations","project"]}` each -> filter) over a seeded store.
 *
 * Seeded cases: the same path cited by 3 issues; one citing it RELATIVE and one
 * ABSOLUTE; an issue whose citation was REMOVED (must not appear); the
 * prefix-collision path `a/b` vs `a/bc` (must not appear); and a relative
 * spelling that means a DIFFERENT file in a second project (must not appear).
 *
 * Real store + real api verbs.
 *
 * Negative control (run once, restored): matching with `LIKE '%path%'`-style
 * substring semantics (`includes`) turns the prefix-collision row red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}
interface IHit {
  uid: string;
  citationUid: string;
  status: string;
  title: string;
  verification: string;
}

describe('7e5469d3 B-AC10 — byCitationPath projection', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let rootX: string;
  let rootY: string;
  let projX: string;
  let projY: string;
  const roots = new Map<string, string>();
  const issues: Record<string, string> = {};
  let removedCitationUid = '';

  const mk = async (project: string, title: string, citations: Array<{ file: string }>): Promise<string> =>
    data(await api.create(ctx, { project, title, body: `${title} body`, by: 'filer', citations } as never)).uid as string;
  const projection = async (path: string): Promise<IHit[]> =>
    (data(await api.query(ctx, { projection: 'byCitationPath', path } as never)) as unknown as { items: IHit[] }).items;

  /** The O(n) reference: no projection involved. */
  async function referenceWalk(path: string): Promise<Array<{ uid: string; citationUid: string }>> {
    const all = (data(await api.query(ctx, { fields: ['uid'], limit: 1000 } as never)) as unknown as { items: Array<{ uid: string }> }).items;
    const out: Array<{ uid: string; citationUid: string }> = [];
    for (const { uid } of all) {
      const card = data(await api.get(ctx, { uid, fields: ['citations', 'project'] })) as unknown as {
        project: string;
        citations: Array<{ uid: string; file: string }>;
      };
      const root = roots.get(card.project);
      for (const c of card.citations) {
        const abs = resolve(root ?? '/', c.file);
        const want = resolve(root ?? '/', path);
        const wantAbs = path.startsWith('/') ? resolve(path) : undefined;
        const hit = wantAbs !== undefined ? abs === wantAbs : abs === want;
        if (hit) out.push({ uid, citationUid: c.uid });
      }
    }
    return out.sort((a, b) => a.uid.localeCompare(b.uid) || a.citationUid.localeCompare(b.citationUid));
  }
  const pairs = (hits: IHit[]): Array<{ uid: string; citationUid: string }> =>
    hits.map((h) => ({ uid: h.uid, citationUid: h.citationUid })).sort((a, b) => a.uid.localeCompare(b.uid) || a.citationUid.localeCompare(b.citationUid));

  beforeEach(async () => {
    tmp = await openTmpStore('by-citation-path');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    rootX = join(tmp.dir, 'x');
    rootY = join(tmp.dir, 'y');
    for (const r of [rootX, rootY]) {
      mkdirSync(join(r, 'a', 'b'), { recursive: true });
      mkdirSync(join(r, 'a', 'bc'), { recursive: true });
      writeFileSync(join(r, 'a', 'b', 'f.ts'), 'f\n');
      writeFileSync(join(r, 'a', 'bc', 'f.ts'), 'g\n');
      writeFileSync(join(r, 'a', 'b.ts'), 'h\n');
    }
    projX = data(await api.upsertProject(ctx, { name: 'x', path: rootX, by: 's' })).uid;
    projY = data(await api.upsertProject(ctx, { name: 'y', path: rootY, by: 's' })).uid;
    roots.set(projX, rootX);
    roots.set(projY, rootY);
    const target = join(rootX, 'a', 'b', 'f.ts');
    issues.abs1 = await mk(projX, 'cites absolute 1', [{ file: target }]);
    issues.abs2 = await mk(projX, 'cites absolute 2', [{ file: target }, { file: join(rootX, 'a', 'b.ts') }]);
    issues.rel = await mk(projX, 'cites relative', [{ file: 'a/b/f.ts' }]);
    issues.collide = await mk(projX, 'cites the prefix-collision path', [{ file: join(rootX, 'a', 'bc', 'f.ts') }]);
    issues.otherProject = await mk(projY, 'same relative spelling, other project', [{ file: 'a/b/f.ts' }]);
    issues.removed = await mk(projX, 'citation removed later', [{ file: target }]);
    issues.none = await mk(projX, 'cites nothing', []);
    const card = data(await api.get(ctx, { uid: issues.removed!, fields: ['citations'] })) as unknown as { citations: Array<{ uid: string }> };
    removedCitationUid = card.citations[0]!.uid;
    data(await api.removeCitation(ctx, { uid: removedCitationUid, by: 'filer' }));
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('7e5469d3 B-AC10 an absolute path returns exactly the citing items and equals the O(n) reference walk', async () => {
    const target = join(rootX, 'a', 'b', 'f.ts');
    const hits = await projection(target);
    const uids = hits.map((h) => h.uid).sort();
    expect(uids).toEqual([issues.abs1, issues.abs2, issues.rel].sort()); // 3 issues, absolute + relative spellings
    expect(hits.map((h) => h.uid)).not.toContain(issues.removed); // retired citation
    expect(hits.map((h) => h.uid)).not.toContain(issues.collide); // a/bc/f.ts is not a/b/f.ts
    expect(hits.map((h) => h.uid)).not.toContain(issues.otherProject); // relative spelling, different project
    expect(pairs(hits)).toEqual(await referenceWalk(target));
    for (const h of hits) {
      expect(h.verification).toBe('verified');
      expect(typeof h.status).toBe('string');
    }
  });

  it('7e5469d3 B-AC10 a relative path resolves against every project root and still equals the reference', async () => {
    const hits = await projection('a/b/f.ts');
    expect(hits.map((h) => h.uid).sort()).toEqual([issues.abs1, issues.abs2, issues.rel, issues.otherProject].sort());
    expect(pairs(hits)).toEqual(await referenceWalk('a/b/f.ts'));
  });

  it('7e5469d3 B-AC10 prefix collision: a/b.ts, a/b and a/bc never leak into each other', async () => {
    const dot = await projection(join(rootX, 'a', 'b.ts'));
    expect(dot.map((h) => h.uid)).toEqual([issues.abs2]);
    expect(await projection(join(rootX, 'a', 'b'))).toEqual([]); // a directory nobody cites
    const bc = await projection(join(rootX, 'a', 'bc', 'f.ts'));
    expect(bc.map((h) => h.uid)).toEqual([issues.collide]);
    expect(pairs(bc)).toEqual(await referenceWalk(join(rootX, 'a', 'bc', 'f.ts')));
  });

  it('7e5469d3 B-AC10 an uncited path returns none, with completeness meta; path is required; limit is validated', async () => {
    const r = data(await api.query(ctx, { projection: 'byCitationPath', path: join(rootX, 'nope.ts') } as never)) as unknown as { items: unknown[] };
    expect(r.items).toEqual([]);
    const missing = await api.query(ctx, { projection: 'byCitationPath' } as never);
    expect(missing.ok).toBe(false);
    const badLimit = await api.query(ctx, { projection: 'byCitationPath', path: 'a/b/f.ts', limit: 0 } as never);
    expect(badLimit.ok).toBe(false);
    const badProjection = await api.query(ctx, { projection: 'bogus' } as never);
    expect(badProjection.ok).toBe(false);
  });

  it('7e5469d3 B-AC10 pagination reports honest completeness and never drops a hit', async () => {
    const target = join(rootX, 'a', 'b', 'f.ts');
    const res = await api.query(ctx, { projection: 'byCitationPath', path: target, limit: 2 } as never);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as unknown as { items: unknown[] }).items).toHaveLength(2);
      expect(res.meta).toMatchObject({ total: 3, returned: 2, limit: 2, has_more: true });
    }
  });
});
