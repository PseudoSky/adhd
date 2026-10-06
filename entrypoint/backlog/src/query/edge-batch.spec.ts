/**
 * edge-batch.spec.ts — regression pin for backlog item **2267eaf9**
 * ("`backlog query` with relationship/edge fields is pathologically slow —
 * per-item (N+1) edge traversal").
 *
 * `query` used to resolve every edge pseudo-field (`blockers`/`partOf`/
 * `related`/`blocksOut`, plus `dependents`/`obligations`/`similar`) one item at
 * a time: for each card, an outgoing `getEdges({src})`, one or more incoming
 * `getEdges({dst,...})`, several `getNodesByIds`, and a `resolveStatusesFor`
 * per status-bearing resolver. Wall time therefore scaled with page size ×
 * items. The fix batches the page's edge reads into a bounded number of store
 * round trips (one `getEdges({rel})` per needed relation, keyed by the page's
 * node-id set) in `assembleIssueCards`.
 *
 * ## Teeth (deterministic — no wall-clock assertion)
 *
 * The count test asserts the number of `GraphBackend.getEdges` +
 * `getNodesByIds` calls is EQUAL for a 1-item page and a 50-item page. With the
 * N+1 shape restored it grows ~linearly with page size and goes red. Proven:
 * temporarily making `assembleIssueCard` ignore the page batch (so every
 * resolver falls back to per-item graph reads) turned this test RED
 * (`getEdges+getNodesByIds` 6 → 300+); restoring the batch turned it green.
 *
 * A second, differential test drives the SAME store through the batched page
 * path and the single-item `getIssue` path and asserts the cards are
 * deep-equal — so the batching cannot silently change results or ordering.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NodeRecord } from '@adhd/sox-graph-store';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { relate } from '../write/relate.js';
import { getIssue } from './get.js';
import { assembleIssueCards } from './card.js';
import { resolveIssueByUid } from './resolve.js';
import type { IIssueField } from './types.js';

const POOL = 60;
const EDGE_FIELDS: readonly IIssueField[] = [
  'uid',
  'blockers',
  'partOf',
  'related',
  'blocksOut',
];

describe('2267eaf9 — batched edge pseudo-field reads (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let uids: string[];
  let records: NodeRecord[];

  beforeAll(async () => {
    dir = freshTmpDir('edge-batch');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'edge-batch-project')).projectUid;

    uids = [];
    records = [];
    for (let i = 0; i < POOL; i++) {
      const created = await createIssue(store, {
        project: projectUid,
        title: `issue ${i}`,
        body: `issue ${i} body`,
        by: 'filer',
        status: i % 2 === 0 ? 'open' : 'in-progress',
      });
      if (created.uid === undefined)
        throw new Error(`createIssue returned no uid for issue ${i}`);
      uids.push(created.uid);
      records.push(await resolveIssueByUid(store.graph, created.uid));
    }
    // Uniform relation pattern over the pool: every issue has an outgoing
    // `relates_to` + `blocks`, an incoming `relates_to` + `blocks`, and a
    // single `part_of` parent — so both a 1-item and a 50-item page exercise
    // every requested edge resolver with non-empty data.
    for (let i = 0; i < POOL; i++) {
      await relate(store, {
        sourceUid: uids[i],
        targetUid: uids[(i + 1) % POOL],
        rel: 'relates_to',
        action: 'add',
        by: 'filer',
      });
      await relate(store, {
        sourceUid: uids[i],
        targetUid: uids[(i + 2) % POOL],
        rel: 'blocks',
        action: 'add',
        by: 'filer',
      });
      await relate(store, {
        sourceUid: uids[i],
        targetUid: uids[(i + 3) % POOL],
        rel: 'part_of',
        action: 'add',
        by: 'filer',
      });
    }
  });

  afterAll(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** `getEdges` + `getNodesByIds` calls issued while assembling a page. */
  async function countRoundTrips(pageSize: number): Promise<number> {
    const getEdgesSpy = vi.spyOn(store.graph, 'getEdges');
    const getNodesSpy = vi.spyOn(store.graph, 'getNodesByIds');
    try {
      await assembleIssueCards(
        store.graph,
        records.slice(0, pageSize),
        EDGE_FIELDS
      );
      return getEdgesSpy.mock.calls.length + getNodesSpy.mock.calls.length;
    } finally {
      getEdgesSpy.mockRestore();
      getNodesSpy.mockRestore();
    }
  }

  it('issues a bounded number of store round trips, independent of page size', async () => {
    const one = await countRoundTrips(1);
    const fifty = await countRoundTrips(50);

    // The batch fetches one `getEdges({rel})` per needed relation (blocks,
    // part_of, relates_to), the `has_status` relation once, and a constant
    // number of node batches — the same whether the page holds 1 issue or 50.
    expect(fifty).toBe(one);
    // Hard upper bound: an N+1 regression makes this ~O(page size) (300+ here).
    expect(fifty).toBeLessThanOrEqual(12);
  });

  it('batched page cards are deep-equal to the single-item get path (no semantics change)', async () => {
    // `dependents` is deliberately excluded: the page path bounds the walk to
    // the page's own ids (`scope`) while a single `get` walks unbounded — a
    // pre-existing, intended difference, not a batching effect.
    const fields: readonly IIssueField[] = [
      'uid',
      'title',
      'status',
      'blockers',
      'partOf',
      'related',
      'blocksOut',
      'obligations',
    ];
    const page = await assembleIssueCards(store.graph, records.slice(0, 12), fields);
    for (const card of page) {
      const single = await getIssue(store.graph, { uid: card.uid, fields });
      expect(card).toEqual(single);
    }
  });
});
