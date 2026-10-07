/**
 * membership-backfill.spec.ts — e54bd58b A-AC5 (S02.S2) migration half: the
 * legacy 1:1 rows are migrated to `in_component` membership; on the REOPENED
 * store per-project issue counts keyed by primary owner equal the pre-migration
 * counts and every project's membership set is a SUPERSET of its pre-migration
 * set (n:m adds, never drops).
 *
 * Real store + real api verbs; the legacy shape is produced by deleting every
 * `in_component` edge with direct SQL (what a pre-n:m store looked like).
 *
 * Negative controls (each is a test that proves the check has teeth):
 * - dropping one issue's primary membership row turns I2 red;
 * - re-pointing one issue's `owns_component` changes the primary counts, so the
 *   counts-equal assertion would go red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import {
  applyMembershipBackfill,
  measureMembership,
  planMembershipBackfill,
  primaryMembershipByProject,
  reverseMembershipBackfill,
} from './membership-backfill.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('e54bd58b A-AC5 — membership-row migration', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let issues: string[];
  let p1: string;
  let p2: string;

  async function liveInComponent(): Promise<number> {
    const { rows } = await tmp.store.adapter.executeAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edge WHERE rel = 'in_component' AND t_invalid IS NULL"
    );
    return Number(rows[0]!.n);
  }
  async function makeLegacy(): Promise<void> {
    await tmp.store.adapter.executeRun("DELETE FROM edge WHERE rel = 'in_component'");
  }

  beforeEach(async () => {
    tmp = await openTmpStore('membership-backfill');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const d1 = join(tmp.dir, 'proj-one');
    const d2 = join(tmp.dir, 'proj-two');
    mkdirSync(join(d1, 'pkg-a'), { recursive: true });
    mkdirSync(join(d2, 'pkg-x'), { recursive: true });
    const f1 = join(d1, 'pkg-a', 'a.ts');
    const f2 = join(d2, 'pkg-x', 'x.ts');
    writeFileSync(f1, 'a\n');
    writeFileSync(f2, 'x\n');
    p1 = data(await api.upsertProject(ctx, { name: 'proj-one', path: d1, by: 's' })).uid;
    p2 = data(await api.upsertProject(ctx, { name: 'proj-two', path: d2, by: 's' })).uid;
    const c1 = data(await api.upsertComponent(ctx, { project: p1, name: 'pkg-a', by: 's' })).uid;
    const c2 = data(await api.upsertComponent(ctx, { project: p2, name: 'pkg-x', by: 's' })).uid;
    data(await api.upsertLocation(ctx, { component: c1, locType: 'path', value: join(d1, 'pkg-a'), by: 's' }));
    data(await api.upsertLocation(ctx, { component: c2, locType: 'path', value: join(d2, 'pkg-x'), by: 's' }));
    const mk = async (project: string, component: string, title: string, citations: Array<{ file: string }>): Promise<string> =>
      data(await api.create(ctx, { project, component, title, body: `${title} b`, by: 'f', citations } as never)).uid as string;
    issues = [
      await mk(p1, c1, 'spans two', [{ file: f1 }, { file: f2 }]),
      await mk(p1, c1, 'plain one', []),
      await mk(p2, c2, 'plain two', []),
    ];
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('e54bd58b A-AC5 migrates legacy rows: counts by primary unchanged, membership a superset, I1/I2 hold', async () => {
    await makeLegacy();
    expect(await liveInComponent()).toBe(0);
    const before = await measureMembership(tmp.store);
    const primaryBefore = await primaryMembershipByProject(tmp.store);
    expect(before.i2Violations.sort()).toEqual([...issues].sort());

    const plan = await planMembershipBackfill(tmp.store);
    expect(plan.issuesExamined).toBe(3);
    expect(plan.pendingIssueUids.sort()).toEqual([...issues].sort());
    expect(plan.pendingWrites).toBe(4); // 3 primary rows + 1 citation-derived
    expect(await liveInComponent()).toBe(0); // plan wrote nothing

    const journal = await applyMembershipBackfill(tmp.store, { batchSize: 2 });
    expect(journal.created).toHaveLength(4);

    // REOPEN the store and assert on what persisted.
    await closeGraphBacklogStore(tmp.store);
    tmp.store = await openGraphBacklogStore(tmp.dbPath);
    const after = await measureMembership(tmp.store);
    expect(after.countsByPrimaryProject).toEqual(before.countsByPrimaryProject);
    expect(after.countsByPrimaryProject).toEqual({ [p1]: 2, [p2]: 1 });
    for (const [project, set] of Object.entries(primaryBefore)) {
      expect(after.membershipByProject[project]).toEqual(expect.arrayContaining(set));
    }
    expect(after.membershipByProject[p2]).toContain(issues[0]); // the n:m addition
    expect(after.i1Violations).toEqual([]);
    expect(after.i2Violations).toEqual([]);

    const replan = await planMembershipBackfill(tmp.store);
    expect(replan.pendingIssueUids).toEqual([]);
    expect(replan.pendingWrites).toBe(0);
  });

  it('e54bd58b A-AC5 apply is idempotent and --reverse restores the pre-state edge count; re-apply works', async () => {
    await makeLegacy();
    const journal = await applyMembershipBackfill(tmp.store);
    expect(await liveInComponent()).toBe(4);
    const second = await applyMembershipBackfill(tmp.store);
    expect(second.created).toEqual([]);
    expect(await liveInComponent()).toBe(4);

    await reverseMembershipBackfill(tmp.store, journal);
    expect(await liveInComponent()).toBe(0);
    const owners = await measureMembership(tmp.store);
    expect(owners.countsByPrimaryProject).toEqual({ [p1]: 2, [p2]: 1 }); // owns_component untouched

    await applyMembershipBackfill(tmp.store);
    expect(await liveInComponent()).toBe(4);
  });

  it('e54bd58b A-AC5 NC: a dropped primary row is reported by the I2 check', async () => {
    await applyMembershipBackfill(tmp.store);
    expect((await measureMembership(tmp.store)).i2Violations).toEqual([]);
    await tmp.store.adapter.executeRun(
      `DELETE FROM edge WHERE rel = 'in_component' AND src = (SELECT rowid FROM node WHERE uid = ?) AND json_extract(meta, '$.via') = 'primary'`,
      [issues[1]]
    );
    expect((await measureMembership(tmp.store)).i2Violations).toEqual([issues[1]]);
  });

  it('e54bd58b A-AC5 NC: re-pointing an owner changes the primary counts (the equality has teeth)', async () => {
    const before = await measureMembership(tmp.store);
    await tmp.store.adapter.executeRun(
      `UPDATE edge SET src = (SELECT dst FROM edge WHERE rel = 'owns_project' AND src = (SELECT rowid FROM node WHERE uid = ?) LIMIT 1)
       WHERE rel = 'owns_component' AND dst = (SELECT rowid FROM node WHERE uid = ?)`,
      [p2, issues[1]]
    );
    const after = await measureMembership(tmp.store);
    expect(after.countsByPrimaryProject).not.toEqual(before.countsByPrimaryProject);
  });
});
