/**
 * superseded-views.spec.ts — SPEC.md §8 AC-6's read half: teeth for the five
 * `isSuperseded: false` read
 * sites `superseded-listing.spec.ts` does not cover, plus a pin on the one
 * site that deliberately omits the filter.
 *
 * ## The defect (shared context — see `superseded-listing.spec.ts` for the
 * full account)
 *
 * `update`'s body path supersedes the old graph node (`is_superseded = 1`)
 * and deliberately leaves `t_invalid` NULL. Any read that filters only on
 * liveness (`t_invalid`) therefore keeps BOTH the old and the new row live —
 * one body edit turns one logical issue into two rows, forever. The fix adds
 * `isSuperseded: false` to the `NodeFilter` at six read sites; this file
 * proves five of them (`query.ts`'s `queryStale`/`queryGraph`/`queryOrder`,
 * `views/semantic.ts`'s `resolveSimilarFilterIds`, `views/stats.ts`'s
 * `priorityMatrix`) and pins the one deliberate exclusion
 * (`views/stats.ts`'s `openCurve`).
 *
 * ## What has teeth
 *
 * Every case below was proven against a NEGATIVE CONTROL: the corresponding
 * `isSuperseded: false` line was temporarily removed (or, for the `openCurve`
 * pin, temporarily ADDED) from source, the test was confirmed to go RED, and
 * the source was restored verbatim. See the dispatch report for the exact
 * line removed/added per case.
 *
 * ## Three defects, one root cause
 *
 * A supersede mints a NEW node and carries forward only the five edges
 * `card.ts` reads — the CARD's set, not the ISSUE's. So beyond the duplicate
 * listing, a body edit also:
 *
 *  - SILENTLY DROPPED every user-asserted relation, note, citation, and the
 *    entire transition/audit trail, all of which stayed bound to the
 *    superseded node. `update` now sweeps every remaining live edge, in BOTH
 *    directions (an issue is the SOURCE of `has_note` but the TARGET of
 *    `blocks`), excluding only the uppercase `SUPERSEDES` chain edge itself.
 *  - double-counted the issue in `openCurve` at every instant at or after the
 *    edit — `validAt`'s SQL carries no `is_superseded` term and supersede
 *    never sets the old row's `t_invalid`. `openCurve` now resolves the chain
 *    HEAD per instant off the `SUPERSEDES` edge's own `tCreated`, which is
 *    the only fix that keeps pre-edit instants readable.
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
import { createIssue } from '../write/create-issue.js';
import { update } from '../write/update.js';
import { claim } from '../write/claim.js';
import { relate } from '../write/relate.js';
import { queryIssuesWithMeta } from './query.js';
import { resolveSimilarFilterIds } from './views/semantic.js';
import { priorityMatrix } from './views/stats.js';
import { openCurve } from './views/stats.js';

describe('a body edit does not duplicate the issue across every other view', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('superseded-views');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'superseded-views-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function seed(title: string, body: string): Promise<string> {
    return (await createIssue(store, { project: projectUid, title, body, by: 'filer' })).uid;
  }

  // ---------------------------------------------------------------------
  // 1. queryStale — query.ts's queryStale, ~line 509
  // ---------------------------------------------------------------------

  it('a claimed issue edited once is ONE stale row, not two', async () => {
    // EMPIRICAL FINDING (verified by reading `write/update.ts`'s body-change
    // branch, line ~591): the supersede path copies `{ ...(issueRow.metadata
    // ?? {}) }` onto the freshly-minted node's own metadata — claim metadata
    // (`claimedBy`/`claimedAt`) is NOT reset by a body edit, and the OLD row's
    // metadata is untouched by the CAS (only `is_superseded` flips). So BOTH
    // rows carry matching `claimedBy`/`claimedAt` metadata after the edit, and
    // an unfiltered `queryNodes({metadata:{claimedBy:{exists:true},
    // claimedAt:{lt:threshold}}})` would return BOTH — the filtered
    // `queryStale` must return exactly the CURRENT one.
    const uid = await seed('claimed then edited', 'the original body');
    await claim(store, { uid, by: 'claimant', action: 'claim' });
    const { uid: liveUid } = await update(store, { uid, body: 'the edited body', by: 'editor' });

    // staleAfterMin: 0 makes every existing claim immediately stale — no
    // sleep, no wall-clock race: `threshold = Date.now() - 0`, and the claim
    // was written strictly before this call started.
    const { result } = await queryIssuesWithMeta(store, { view: 'stale', staleAfterMin: 0 });
    if (result.view !== 'stale') throw new Error(`expected view:'stale', got ${result.view}`);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uid).toBe(liveUid);
  });

  // ---------------------------------------------------------------------
  // 2. queryGraph — query.ts's queryGraph, ~line 537
  // ---------------------------------------------------------------------

  it('a graph view shows the edited issue once, and the relation survives the edit', async () => {
    // Two distinct guarantees, both with teeth.
    //
    // NODE dedup: `queryGraph`'s `isSuperseded: false` keeps the superseded
    // row out of the node set — without it this returns 3 nodes, not 2.
    //
    // EDGE survival: `relate` writes `blocks` onto whichever node was live at
    // call time, and it arrives at the target (`blocker → blocked`). A
    // supersede that carried forward only the five card edges left this one
    // bound to a node the view now — correctly — excludes, so the relation
    // vanished with no error. `update` now sweeps every residual edge in both
    // directions; without that sweep this returns ZERO `blocks` edges.
    const blockerUid = await seed('the blocker', 'blocker body');
    const blockedUid = await seed('the blocked issue', 'blocked body');
    await relate(store, { sourceUid: blockerUid, targetUid: blockedUid, rel: 'blocks', action: 'add', by: 'editor' });
    const { uid: liveBlockedUid } = await update(store, { uid: blockedUid, body: 'edited blocked body', by: 'editor' });

    const { result } = await queryIssuesWithMeta(store, { view: 'graph' });
    if (result.view !== 'graph') throw new Error(`expected view:'graph', got ${result.view}`);

    expect(result.graph.nodes).toHaveLength(2);
    expect(result.graph.nodes.map((n) => n.uid).sort()).toEqual([blockerUid, liveBlockedUid].sort());

    const blocksEdges = result.graph.edges.filter((e) => e.rel === 'blocks');
    expect(blocksEdges).toHaveLength(1);
    expect(blocksEdges[0]?.from).toBe(blockerUid);
    // The edge follows the issue's identity onto its successor uid.
    expect(blocksEdges[0]?.to).toBe(liveBlockedUid);
  });

  // ---------------------------------------------------------------------
  // 3. queryOrder — query.ts's queryOrder, ~line 578
  // ---------------------------------------------------------------------

  it('a topo order lists the edited issue exactly once', async () => {
    const blockerUid = await seed('order blocker', 'blocker body');
    const blockedUid = await seed('order blocked', 'blocked body');
    await relate(store, { sourceUid: blockerUid, targetUid: blockedUid, rel: 'blocks', action: 'add', by: 'editor' });
    const { uid: liveBlockerUid } = await update(store, { uid: blockerUid, body: 'edited blocker body', by: 'editor' });

    const { result } = await queryIssuesWithMeta(store, { view: 'order' });
    if (result.view !== 'order') throw new Error(`expected view:'order', got ${result.view}`);
    if (!result.order.ok) throw new Error(`expected a resolvable order, got a cycle: ${result.order.cycle.join(', ')}`);

    expect(result.order.order).toHaveLength(2);
    expect(new Set(result.order.order).size).toBe(2);
    expect(result.order.order).toContain(liveBlockerUid);
    expect(result.order.order).toContain(blockedUid);
    expect(result.order.order).not.toContain(blockerUid);
  });

  // ---------------------------------------------------------------------
  // 4. resolveSimilarFilterIds — views/semantic.ts, ~line 305
  // ---------------------------------------------------------------------

  it('resolveSimilarFilterIds resolves the edited issue to exactly one candidate id', async () => {
    const uid = await seed('similar candidate', 'the original body');
    const { uid: liveUid } = await update(store, { uid, body: 'the edited body', by: 'editor' });

    // A scalar (non-embedding) filter dimension is enough to exercise the
    // `scalarFilter` branch — `createdAt.since` far in the past matches
    // every issue in this store without touching `filter.semantic`/`grep`.
    const ids = await resolveSimilarFilterIds(store.graph, { createdAt: { since: '2000-01-01T00:00:00.000Z' } });
    if (!ids) throw new Error('expected a concrete candidate id set, got undefined');

    const liveNode = (await store.graph.getNodesByIds([...ids])).find((n) => n.uid === liveUid);
    expect(ids.size).toBe(1);
    expect(liveNode).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // 5. priorityMatrix — views/stats.ts, ~line 246
  // ---------------------------------------------------------------------

  it('the priority matrix counts an edited issue once, under its own priority', async () => {
    const uid = await seed('prioritized issue', 'the original body');
    await update(store, { uid, priority: 'urgent', by: 'editor' });
    await update(store, { uid, body: 'the edited body', by: 'editor' });

    const { rows, unassigned } = await priorityMatrix(store, { filter: { status: 'all' } });
    const urgentRow = rows.find((r) => r.priority === 'urgent');
    if (!urgentRow) throw new Error(`expected an "urgent" row, got: ${rows.map((r) => r.priority).join(', ')}`);

    expect(urgentRow.count).toBe(1);
    const totalCounted = rows.reduce((sum, r) => sum + r.count, 0) + unassigned;
    expect(totalCounted).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 6. openCurve — views/stats.ts — one row per identity CHAIN per instant.
  // ---------------------------------------------------------------------

  it('openCurve reports one row per identity chain at every instant — an as-of instant before the edit still sees the issue', async () => {
    // This view is the inverse of every other case in this file, and it has to
    // satisfy BOTH halves at once.
    //
    // It must NOT filter `is_superseded`: `openCurve` is a point-in-time
    // (`validAt`) view, and an instant BEFORE a body edit must still report the
    // issue exactly as it existed then — which is only possible by reading the
    // at-that-instant live row, a row that has SINCE been superseded. Adding
    // `isSuperseded: false` to this view's `nodeFilter` would make every
    // pre-edit instant silently stop seeing the issue. `points[1]` pins that.
    //
    // But `validAt`'s SQL (`t_valid <= at AND (t_invalid IS NULL OR t_invalid >
    // at)`) carries no `is_superseded` term, and a supersede deliberately leaves
    // the old row's `t_invalid` NULL (SPEC §4c). So from the edit instant to the
    // end of time, the old row AND its successor both satisfy `validAt`, and a
    // node-level count reports one issue as two — N edits as N+1. The fix is
    // neither filter: `openCurve` resolves the chain HEAD at each instant, via
    // the `SUPERSEDES` edge's own `tCreated`. `points[2]` pins that.
    //
    // Both halves have teeth. Dropping the chain-head resolution turns
    // `points[2]` red (2 ≠ 1); adding `isSuperseded: false` to the nodeFilter
    // turns `points[1]` red (0 ≠ 1).
    const beforeEdit = new Date(Date.now() - 60_000).toISOString();
    const uid = await seed('curve issue', 'the original body');
    const created = await store.graph.getNodeByUid(uid);
    if (!created) throw new Error('created node not found');
    const { uid: liveUid } = await update(store, { uid, body: 'the edited body', by: 'editor' });
    const edited = await store.graph.getNodeByUid(liveUid);
    if (!edited) throw new Error('edited node not found');

    const { points } = await openCurve(store, { at: [beforeEdit, created.tValid, edited.tValid] });

    expect(points[0]?.existed).toBe(0); // strictly before the issue was created
    expect(points[1]?.existed).toBe(1); // after creation, before the edit — the issue, as it existed then (the deliberate design this test pins)
    expect(points[2]?.existed).toBe(1); // at and after the edit — the chain HEAD only, never the issue twice
  });
});
