/**
 * catalog-merge.spec.ts — proof for `write/catalog-merge.ts`, the D3 collapse
 * of the status/priority catalog's case-fragment duplicates, and the RED
 * reproduction of that defect.
 *
 * THE DEFECT. A catalog token can exist as two LIVE rows that differ only in
 * case (`HIGH`/`high`, `OPEN`/`open`). The read layer groups by NAME, never by
 * `catalogNameFold`, so `priorityMatrix` splits one priority across two rows
 * and a name-keyed consumer double-counts.
 *
 * THE REPAIR. `applyCaseFragmentMerge` groups LIVE rows by fold and picks the
 * canonical PER KIND — the spelling the write path emits: lowercase for
 * `status` (`create-issue.ts`'s default `'open'`), uppercase for `priority`
 * (`HIGH`/`MEDIUM`, every product sample). It re-points every incoming catalog
 * edge onto the canonical, records the merged-away spellings as `meta.aliases`
 * on the survivor, and invalidates each fragment (`t_invalid`, reversible). A
 * status name is NEVER rewritten; a priority group with no uppercase member is
 * renamed to uppercase (journaled). A status group with no lowercase member
 * cannot be merged — it would regenerate — and is surfaced in `unmergeable`.
 * The repair is idempotent (a folded-clean store plans nothing) and reversible
 * (the journal restores fragments, edges, and any rename).
 *
 * THE SELF-REGENERATION DEFECT (why the canonical is per-kind): the status
 * write path emits lowercase `'open'`. A merge that canonicalized `open`→`OPEN`
 * would leave the next ordinary `createIssue` — which emits `'open'` — to
 * exact-match miss and mint a FRESH `open` row, regenerating the twin the merge
 * just removed. The regression below proves it: RED against the old uppercase
 * directive, GREEN after the per-kind fix.
 *
 * Every assertion drives the REAL verbs (`seedProject`/`createIssue`/
 * `priorityMatrix`/`openCurve`/`queryIssues`) against a REAL store opened via
 * `openTestIssueStore` — never a mock of any verb, never a mock of the store.
 * Load-bearing persistence claims are read back with a direct store read,
 * never trusted from a returned object.
 *
 * The RED fixture is what gives the green assertions teeth: the case twin is
 * genuinely two live rows BEFORE the apply, and one AFTER.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { writeAudit } from './audit.js';
import { resolveEdgeKindTx } from './catalog.js';
import {
  executeWriteTransaction,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';
import { catalogNameFold } from './catalog-repair.js';
import {
  applyCaseFragmentMerge,
  planCaseFragmentMerge,
  reverseCaseFragmentMerge,
  type IMergePlan,
} from './catalog-merge.js';
import { priorityMatrix, openCurve } from '../query/views/stats.js';
import { queryIssues } from '../query/query.js';

/** `createIssue`'s `uid` is optional (a duplicate reports `commentedOn` instead) — assert it and narrow to `string`. */
function createdUid(result: { created: boolean; uid?: string }): string {
  if (result.uid === undefined) {
    throw new Error('test setup: createIssue returned no uid (treated as a duplicate?)');
  }
  return result.uid;
}

interface ILiveCatalogRow {
  rowid: number;
  uid: string;
  name: string;
  meta: Record<string, unknown>;
}

/** Direct store read: every LIVE row of `kind` (never a returned object). */
async function liveCatalogRows(
  store: TestIssueStore,
  kind: 'status' | 'priority'
): Promise<ILiveCatalogRow[]> {
  const { rows } = await store.adapter.executeAll<{
    rowid: number;
    uid: string;
    name: string | null;
    meta: string | null;
  }>(
    'SELECT rowid, uid, name, meta FROM node WHERE kind = ? AND t_invalid IS NULL ORDER BY rowid ASC',
    [kind]
  );
  return rows.map((r) => ({
    rowid: r.rowid,
    uid: r.uid,
    name: r.name ?? '',
    meta: (r.meta ? JSON.parse(r.meta) : {}) as Record<string, unknown>,
  }));
}

/** One row by uid, LIVE or not — reverse must be able to read the re-livened fragment. */
async function rowByUidAny(
  store: TestIssueStore,
  uid: string
): Promise<{ name: string | null; t_invalid: string | null } | undefined> {
  const { rows } = await store.adapter.executeAll<{
    name: string | null;
    t_invalid: string | null;
  }>('SELECT name, t_invalid FROM node WHERE uid = ?', [uid]);
  return rows[0];
}

/** The number of fold groups of `kind` holding two or more LIVE rows — the case-twin count the repair drives to zero. */
async function caseTwinCount(
  store: TestIssueStore,
  kind: 'status' | 'priority'
): Promise<number> {
  const byFold = new Map<string, number>();
  for (const row of await liveCatalogRows(store, kind)) {
    const fold = catalogNameFold(row.name);
    byFold.set(fold, (byFold.get(fold) ?? 0) + 1);
  }
  return [...byFold.values()].filter((n) => n > 1).length;
}

/** How many LIVE rows of `kind` fold to `fold` — the direct "exactly one open-folding row" count. */
async function liveRowsFolding(
  store: TestIssueStore,
  kind: 'status' | 'priority',
  fold: string
): Promise<number> {
  return (await liveCatalogRows(store, kind)).filter(
    (r) => catalogNameFold(r.name) === fold
  ).length;
}

/** Mint a bare catalog row with caller-chosen metadata — the same `writeNodeTx` primitive every verb uses. */
async function mintCatalog(
  store: TestIssueStore,
  kind: 'status' | 'priority',
  name: string,
  metadata: Record<string, unknown>
): Promise<{ rowid: number; uid: string }> {
  return executeWriteTransaction(store, (tx) =>
    writeNodeTx(tx, { kind, name, metadata })
  );
}

/** Re-point an issue's `n:1` catalog edge onto `dst` — the exact invalidate-then-write sequencing the verbs use. */
async function repointIssueEdge(
  store: TestIssueStore,
  issueUid: string,
  rel: 'has_status' | 'has_priority',
  dst: { rowid: number; uid: string; kind: 'status' | 'priority' }
): Promise<void> {
  await executeWriteTransaction(store, async (tx) => {
    const issue = await getNodeByUidTx(tx, issueUid);
    if (!issue) throw new Error(`test setup: no issue ${issueUid}`);
    const existing = await tx.executeGet<{ dst: number }>(
      'SELECT dst FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL',
      [issue.rowid, rel]
    );
    const at = nowISO();
    if (existing) {
      await invalidateEdgeTx(tx, {
        srcRowid: issue.rowid,
        dstRowid: existing.dst,
        rel,
        at,
      });
    }
    const rule = await resolveEdgeKindTx(tx, rel);
    await writeEdgeTx(tx, {
      at,
      srcRowid: issue.rowid,
      srcUid: issue.uid,
      srcKind: 'issue',
      dstRowid: dst.rowid,
      dstUid: dst.uid,
      dstKind: dst.kind,
      rel,
      rule,
      typePolicy: store.typePolicy,
    });
  });
}

async function planNow(store: TestIssueStore): Promise<IMergePlan> {
  const statuses = await store.graph.queryNodes({ kind: 'status', liveOnly: true });
  const priorities = await store.graph.queryNodes({ kind: 'priority', liveOnly: true });
  return planCaseFragmentMerge(statuses, priorities);
}

describe('catalog-merge — status/priority case-fragment collapse', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('catalog-merge-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('CANONICAL SPELLING per kind: status collapses to lowercase (write path), priority to uppercase', async () => {
    await seedProject(store, 'case-merge-canonical');
    const openLower = await mintCatalog(store, 'status', 'open', { terminal: false });
    const openUpper = await mintCatalog(store, 'status', 'OPEN', { terminal: false });
    const highLower = await mintCatalog(store, 'priority', 'high', { rank: 2 });
    const highUpper = await mintCatalog(store, 'priority', 'HIGH', { rank: 1 });
    const medLower = await mintCatalog(store, 'priority', 'medium', { rank: 4 });
    const medUpper = await mintCatalog(store, 'priority', 'MEDIUM', { rank: 3 });

    const plan = await planNow(store);
    expect(plan.unmergeable).toEqual([]);

    // status: the LOWERCASE member is canonical.
    const openGroup = plan.groups.find((g) => g.canonicalUid === openLower.uid);
    expect(openGroup?.fragmentUids).toEqual([openUpper.uid]);
    // priority: the UPPERCASE member is canonical.
    const highGroup = plan.groups.find((g) => g.canonicalUid === highUpper.uid);
    expect(highGroup?.fragmentUids).toEqual([highLower.uid]);
    const medGroup = plan.groups.find((g) => g.canonicalUid === medUpper.uid);
    expect(medGroup?.fragmentUids).toEqual([medLower.uid]);

    await applyCaseFragmentMerge(store, plan);

    expect((await liveCatalogRows(store, 'status')).map((r) => r.name)).toEqual([
      'open',
    ]);
    expect(
      (await liveCatalogRows(store, 'priority')).map((r) => r.name).sort()
    ).toEqual(['HIGH', 'MEDIUM']);
  });

  it('RED then GREEN: a HIGH/high case twin is two rows before, one after — uppercase survives, both issues resolve to it, rank wins', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-priority');
    // Canonical `HIGH` rank 1 with ONE issue; fragment `high` rank 7 with TWO
    // issues. The fragment has MORE incoming edges, yet must still lose — the
    // spelling decides, not the edge count.
    const highUpper = await mintCatalog(store, 'priority', 'HIGH', { rank: 1 });
    const highLower = await mintCatalog(store, 'priority', 'high', { rank: 7 });

    const issueA = await createIssue(store, {
      project: projectUid,
      title: 'issue on HIGH',
      body: 'a',
      priority: 'HIGH',
      by: 'agent:t',
    });
    const issueB = await createIssue(store, {
      project: projectUid,
      title: 'issue on high (1)',
      body: 'b',
      priority: 'HIGH',
      by: 'agent:t',
    });
    const issueC = await createIssue(store, {
      project: projectUid,
      title: 'issue on high (2)',
      body: 'c',
      priority: 'HIGH',
      by: 'agent:t',
    });
    // createIssue resolved the existing `HIGH`; move B and C onto the fragment.
    await repointIssueEdge(store, createdUid(issueB), 'has_priority', {
      rowid: highLower.rowid,
      uid: highLower.uid,
      kind: 'priority',
    });
    await repointIssueEdge(store, createdUid(issueC), 'has_priority', {
      rowid: highLower.rowid,
      uid: highLower.uid,
      kind: 'priority',
    });
    void issueA;

    // BEFORE: genuinely two live rows, split across the consumer.
    expect(await caseTwinCount(store, 'priority')).toBe(1);
    const before = await priorityMatrix(store, { filter: { status: 'all' } });
    const highBefore = before.rows.filter(
      (r) => catalogNameFold(r.priority) === 'high'
    );
    expect(highBefore.length).toBe(2);
    expect(highBefore.map((r) => r.priority).sort()).toEqual(['HIGH', 'high']);
    // Split across the two spellings: the canonical holds 1, the fragment 2.
    expect(highBefore.map((r) => r.count).sort()).toEqual([1, 2]);

    const journal = await applyCaseFragmentMerge(store, await planNow(store));

    // AFTER: one live row, uppercase, rank 1 (survivor's), count 3.
    expect(await caseTwinCount(store, 'priority')).toBe(0);
    const after = await priorityMatrix(store, { filter: { status: 'all' } });
    const highAfter = after.rows.filter(
      (r) => catalogNameFold(r.priority) === 'high'
    );
    expect(highAfter.length).toBe(1);
    expect(highAfter[0]!.priority).toBe('HIGH');
    expect(highAfter[0]!.rank).toBe(1);
    expect(highAfter[0]!.count).toBe(3);

    // The fragment is invalidated, never renamed away, never deleted.
    const fragment = await rowByUidAny(store, highLower.uid);
    expect(fragment?.t_invalid).not.toBeNull();
    expect(fragment?.name).toBe('high');

    // The survivor carries the merged-away spelling as a data alias.
    const survivor = (await liveCatalogRows(store, 'priority')).find(
      (r) => r.uid === highUpper.uid
    );
    expect(survivor?.name).toBe('HIGH');
    expect(survivor?.meta.rank).toBe(1);
    expect(survivor?.meta.aliases).toContain('high');

    // Journal: the fragment's rank is preserved, and BOTH re-pointed edges recorded.
    expect(journal.entries.length).toBe(1);
    expect(journal.entries[0]!.canonicalUid).toBe(highUpper.uid);
    expect(journal.entries[0]!.fragmentUid).toBe(highLower.uid);
    expect(journal.entries[0]!.retainedRank).toBe(7);
    expect(journal.entries[0]!.repointedEdges.length).toBe(2);
  });

  it('STATUS canonical is lowercase: a non-lowercase member is merged away, NEVER renamed, and reverse restores both spellings', async () => {
    await seedProject(store, 'case-merge-status-canon');
    const openLower = await mintCatalog(store, 'status', 'open', { terminal: false });
    const openMixed = await mintCatalog(store, 'status', 'Open', { terminal: false });

    const plan = await planNow(store);
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0]!.canonicalUid).toBe(openLower.uid);

    const journal = await applyCaseFragmentMerge(store, plan);

    const live = await liveCatalogRows(store, 'status');
    expect(live.map((r) => r.name)).toEqual(['open']);
    // A status name is NEVER rewritten — no rename was journaled.
    expect(journal.entries[0]!.renamed).toBeUndefined();
    // The merged-away spelling is recorded as a data alias instead.
    expect(live[0]!.meta.aliases).toContain('Open');
    // The fragment keeps its own spelling, invalidated not renamed.
    const fragment = await rowByUidAny(store, openMixed.uid);
    expect(fragment?.name).toBe('Open');
    expect(fragment?.t_invalid).not.toBeNull();

    await reverseCaseFragmentMerge(store, journal);
    expect(
      (await liveCatalogRows(store, 'status')).map((r) => r.name).sort()
    ).toEqual(['Open', 'open']);
  });

  it('PRIORITY canonical is uppercase: a group with no uppercase member is renamed, and the rename is journaled', async () => {
    await seedProject(store, 'case-merge-priority-rename');
    await mintCatalog(store, 'priority', 'Low', { rank: 1 });
    await mintCatalog(store, 'priority', 'low', { rank: 2 });

    const plan = await planNow(store);
    expect(plan.groups.length).toBe(1);

    const journal = await applyCaseFragmentMerge(store, plan);

    const live = await liveCatalogRows(store, 'priority');
    expect(live.map((r) => r.name)).toEqual(['LOW']);
    // A priority rename is journaled so it can be reversed.
    expect(journal.entries[0]!.renamed).toBeDefined();
    expect(journal.entries[0]!.renamed!.from).toBe('Low');
    expect(journal.entries[0]!.renamed!.to).toBe('LOW');
    // The renamed-FROM spelling is also recorded as an alias.
    expect(live[0]!.meta.aliases).toContain('Low');
  });

  it('REFUSED: a status group with no lowercase (write-spelling) member is NOT merged and is surfaced', async () => {
    await seedProject(store, 'case-merge-unmergeable');
    const openUpper = await mintCatalog(store, 'status', 'OPEN', { terminal: false });
    const openMixed = await mintCatalog(store, 'status', 'Open', { terminal: false });

    const plan = await planNow(store);
    // Neither spelling is what the write path emits, so there is no safe
    // canonical: the group is surfaced, not merged, not renamed.
    expect(plan.groups.length).toBe(0);
    expect(plan.unmergeable.length).toBe(1);
    expect(plan.unmergeable[0]!.kind).toBe('status');
    expect([...plan.unmergeable[0]!.names].sort()).toEqual(['OPEN', 'Open']);

    const journal = await applyCaseFragmentMerge(store, plan);
    expect(journal.entries).toEqual([]);
    expect(
      (await liveCatalogRows(store, 'status')).map((r) => r.name).sort()
    ).toEqual(['OPEN', 'Open']);

    // A hand-built plan that WOULD merge into the divergent `OPEN` canonical is
    // refused by the status-spelling guard, changing nothing.
    const badPlan: IMergePlan = {
      groups: [{ canonicalUid: openUpper.uid, fragmentUids: [openMixed.uid] }],
      unmergeable: [],
      at: nowISO(),
    };
    await expect(applyCaseFragmentMerge(store, badPlan)).rejects.toThrow(
      /lowercase spelling/i
    );
  });

  it('HISTORICAL resolution: an audit naming a merged-away spelling still classifies because the survivor carries the alias', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-alias');
    const doneUpper = await mintCatalog(store, 'status', 'DONE', { terminal: true });
    const doneLower = await mintCatalog(store, 'status', 'done', { terminal: true });

    const issue = await createIssue(store, {
      project: projectUid,
      title: 'historical item',
      body: 'transitioned to an uppercase spelling',
      by: 'agent:t',
    });
    // Point the issue at the UPPERCASE fragment — the spelling the merge will
    // merge away and alias, so only the alias can resolve the audit below.
    await repointIssueEdge(store, createdUid(issue), 'has_status', {
      rowid: doneUpper.rowid,
      uid: doneUpper.uid,
      kind: 'status',
    });

    const t1 = new Date(Date.now() + 60_000).toISOString();
    await executeWriteTransaction(store, async (tx) => {
      const issueNode = await getNodeByUidTx(tx, createdUid(issue));
      if (!issueNode) throw new Error('test setup: issue vanished');
      await writeAudit({
        tx,
        typePolicy: store.typePolicy,
        subjectRowid: issueNode.rowid,
        subjectUid: issueNode.uid,
        subjectKind: 'issue',
        actor: 'agent:t',
        action: 'transitioned',
        from: 'open',
        to: 'DONE',
        at: t1,
      });
    });

    await applyCaseFragmentMerge(store, await planNow(store));

    // The canonical is the LOWERCASE member; the alias is the merged-away
    // uppercase spelling, and it lives in DATA on the survivor.
    const survivor = (await liveCatalogRows(store, 'status')).find(
      (r) => r.uid === doneLower.uid
    );
    expect(survivor?.name).toBe('done');
    expect(survivor?.meta.aliases).toContain('DONE');
    // ...and the merged-away row is no longer live.
    expect((await rowByUidAny(store, doneUpper.uid))?.t_invalid).not.toBeNull();

    // The real `openCurve` view classifies the historical `to:'DONE'` as
    // CLOSED via the alias. Without the alias this reads OPEN — which is the
    // teeth: `DONE` is not a live status name, so only the survivor's
    // `meta.aliases` can resolve it.
    const t2 = new Date(Date.now() + 120_000).toISOString();
    const curve = await openCurve(store, { filter: { project: projectUid }, at: [t2] });
    expect(curve.points[0]!.existed).toBe(1);
    expect(curve.points[0]!.closed).toBe(1);
    expect(curve.points[0]!.open).toBe(0);
  });

  it('IDEMPOTENT: a re-run after apply plans nothing and writes nothing', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-idem');
    await mintCatalog(store, 'priority', 'MEDIUM', { rank: 1 });
    await mintCatalog(store, 'priority', 'medium', { rank: 2 });
    const issue = await createIssue(store, {
      project: projectUid,
      title: 'idempotency item',
      body: 'b',
      priority: 'MEDIUM',
      by: 'agent:t',
    });
    const lower = (await liveCatalogRows(store, 'priority')).find(
      (r) => r.name === 'medium'
    )!;
    await repointIssueEdge(store, createdUid(issue), 'has_priority', {
      rowid: lower.rowid,
      uid: lower.uid,
      kind: 'priority',
    });

    await applyCaseFragmentMerge(store, await planNow(store));
    expect(await caseTwinCount(store, 'priority')).toBe(0);

    const secondPlan = await planNow(store);
    expect(secondPlan.groups).toEqual([]);
    expect(secondPlan.unmergeable).toEqual([]);
    const secondJournal = await applyCaseFragmentMerge(store, secondPlan);
    expect(secondJournal.entries).toEqual([]);
  });

  it('REVERSIBLE: reverse restores both rows, the original edges, the survivor aliases, and the ranks', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-reverse');
    const highUpper = await mintCatalog(store, 'priority', 'HIGH', { rank: 1 });
    const highLower = await mintCatalog(store, 'priority', 'high', { rank: 7 });
    const issueA = await createIssue(store, {
      project: projectUid,
      title: 'reverse A',
      body: 'a',
      priority: 'HIGH',
      by: 'agent:t',
    });
    const issueB = await createIssue(store, {
      project: projectUid,
      title: 'reverse B',
      body: 'b',
      priority: 'HIGH',
      by: 'agent:t',
    });
    await repointIssueEdge(store, createdUid(issueB), 'has_priority', {
      rowid: highLower.rowid,
      uid: highLower.uid,
      kind: 'priority',
    });
    void issueA;

    const journal = await applyCaseFragmentMerge(store, await planNow(store));
    expect(await caseTwinCount(store, 'priority')).toBe(0);

    await reverseCaseFragmentMerge(store, journal);

    // Both rows live again with their original names + ranks.
    expect(await caseTwinCount(store, 'priority')).toBe(1);
    const rows = await liveCatalogRows(store, 'priority');
    const upper = rows.find((r) => r.uid === highUpper.uid);
    const lower = rows.find((r) => r.uid === highLower.uid);
    expect(upper?.name).toBe('HIGH');
    expect(upper?.meta.rank).toBe(1);
    expect(upper?.meta.aliases ?? []).not.toContain('high');
    expect(lower?.name).toBe('high');
    expect(lower?.meta.rank).toBe(7);

    // The original edge is back on the fragment.
    const issueBNode = await store.graph.getNodeByUid(createdUid(issueB));
    const bEdges = await store.graph.getEdges({
      src: issueBNode!.id,
      rel: 'has_priority',
    });
    expect(bEdges.length).toBe(1);
    expect(bEdges[0]!.dst).toBe(highLower.rowid);
  });

  it('REVERSIBLE (rename): reverse restores the exact original spelling of a renamed PRIORITY survivor', async () => {
    await seedProject(store, 'case-merge-reverse-rename');
    await mintCatalog(store, 'priority', 'Low', { rank: 1 });
    await mintCatalog(store, 'priority', 'low', { rank: 2 });

    const journal = await applyCaseFragmentMerge(store, await planNow(store));
    expect((await liveCatalogRows(store, 'priority')).map((r) => r.name)).toEqual([
      'LOW',
    ]);

    await reverseCaseFragmentMerge(store, journal);
    expect(
      (await liveCatalogRows(store, 'priority')).map((r) => r.name).sort()
    ).toEqual(['Low', 'low']);
  });

  it('RANK: a fragment rank is adopted ONLY when the survivor has none', async () => {
    await seedProject(store, 'case-merge-rank');
    const upper = await mintCatalog(store, 'priority', 'LOW', {}); // no rank
    const lower = await mintCatalog(store, 'priority', 'low', { rank: 9 });

    const journal = await applyCaseFragmentMerge(store, await planNow(store));

    const survivor = (await liveCatalogRows(store, 'priority')).find(
      (r) => r.uid === upper.uid
    );
    expect(survivor?.meta.rank).toBe(9);
    expect(journal.entries[0]!.retainedRank).toBe(9);

    await reverseCaseFragmentMerge(store, journal);
    const restored = (await liveCatalogRows(store, 'priority')).find(
      (r) => r.uid === upper.uid
    );
    expect(restored?.meta.rank).toBeUndefined();
    void lower;
  });

  it('NEGATIVE CONTROL: a `closed`/`DONE` pair is NOT a case-variant — the planner never groups it, and a plan that would collapse it is refused', async () => {
    const closed = await mintCatalog(store, 'status', 'closed', { terminal: true });
    const done = await mintCatalog(store, 'status', 'DONE', { terminal: true });

    // The planner groups by fold alone: `closed` folds to `closed`, `DONE` to
    // `done` — different tokens, so zero groups.
    const plan = await planNow(store);
    expect(plan.groups.length).toBe(0);

    // A malformed plan that WOULD collapse them (as a fold-blind planner might
    // emit) is REFUSED by apply, changing nothing. THIS is the guard: remove
    // the fold check in `applyCaseFragmentMerge` and this `rejects` fails.
    const badPlan: IMergePlan = {
      groups: [{ canonicalUid: closed.uid, fragmentUids: [done.uid] }],
      unmergeable: [],
      at: nowISO(),
    };
    await expect(applyCaseFragmentMerge(store, badPlan)).rejects.toThrow(
      /not a case-variant/i
    );

    // Both rows are untouched: live, original names.
    const rows = await liveCatalogRows(store, 'status');
    expect(rows.find((r) => r.uid === closed.uid)?.name).toBe('closed');
    expect(rows.find((r) => r.uid === done.uid)?.name).toBe('DONE');
  });

  it('consumer-visible: the open list is unchanged in COUNT, but no terminal-named issue is ever returned under status:open', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-consumer');
    const issue = await createIssue(store, {
      project: projectUid,
      title: 'consumer item',
      body: 'b',
      by: 'agent:t',
    });
    expect(issue.created).toBe(true);
    const open = await queryIssues(store, { filter: { status: 'open' }, limit: 100 });
    expect(open.view).toBe('list');
    if (!('items' in open)) throw new Error('expected a list-shaped result');
    expect(open.items.map((i) => i.uid)).toContain(createdUid(issue));
  });

  it('SELF-REGENERATION REGRESSION: after merging an open/OPEN pair, an ordinary create must NOT mint a fresh open', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-selfregen');
    // The write path emits lowercase 'open' (create-issue.ts), so 'open' is the
    // canonical and 'OPEN' the fragment.
    await mintCatalog(store, 'status', 'open', { terminal: false });
    await mintCatalog(store, 'status', 'OPEN', { terminal: false });

    await applyCaseFragmentMerge(store, await planNow(store));
    expect(await liveRowsFolding(store, 'status', 'open')).toBe(1);

    // An ordinary create with NO explicit status — the exact path that emits
    // lowercase 'open'. If the merge canonicalized to 'OPEN', this exact lookup
    // misses and mints a fresh 'open' row, regenerating the twin.
    await createIssue(store, {
      project: projectUid,
      title: 'post-merge create',
      body: 'b',
      by: 'agent:t',
    });

    // THE ASSERTION: still exactly ONE open-folding row after the ordinary write.
    expect(await liveRowsFolding(store, 'status', 'open')).toBe(1);
    expect(await caseTwinCount(store, 'status')).toBe(0);
  });

  it('NEGATIVE CONTROL: forcing the canonical to the divergent spelling makes the regression fail', async () => {
    const { projectUid } = await seedProject(store, 'case-merge-negctl');
    await mintCatalog(store, 'status', 'open', { terminal: false });
    await mintCatalog(store, 'status', 'OPEN', { terminal: false });

    const journal = await applyCaseFragmentMerge(store, await planNow(store));
    expect(await liveRowsFolding(store, 'status', 'open')).toBe(1);

    // Force the survivor back to the write-path-divergent spelling — exactly
    // what the pre-fix canonical selection did.
    await executeWriteTransaction(store, async (tx) => {
      const survivor = await getNodeByUidTx(tx, journal.entries[0]!.canonicalUid);
      if (!survivor) throw new Error('test setup: canonical vanished');
      await tx.executeRun(
        'UPDATE node SET name = ? WHERE rowid = ? AND t_invalid IS NULL',
        ['OPEN', survivor.rowid]
      );
    });
    await createIssue(store, {
      project: projectUid,
      title: 'post-merge create',
      body: 'b',
      by: 'agent:t',
    });
    // The regression assertion (exactly one open-folding row) now FAILS: the
    // create re-minted the lowercase twin, so the count is 2 — not 1. This is
    // the teeth of the regression above: a divergent canonical DOES regenerate,
    // so `toBe(1)` there is a real, breakable assertion.
    expect(await liveRowsFolding(store, 'status', 'open')).toBe(2);
  });
});
