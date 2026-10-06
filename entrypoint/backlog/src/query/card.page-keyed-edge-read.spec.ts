/**
 * card.page-keyed-edge-read.spec.ts — acceptance tests for backlog item
 * **e54afd3f** (consumer half of spec 89cc3a30, "buildPageReadBatch fetches
 * each needed relation WHOLE-STORE via getEdges({rel})").
 *
 * `buildPageReadBatch` used to issue one `getEdges({ rel })` per needed
 * relation and filter the rows by the page's node ids in memory, so a `query`
 * page cost O(relation cardinality) rows, not O(page). It now issues a
 * page-keyed `getEdges({ srcs, rels })` (outgoing) + `getEdges({ dsts, rels })`
 * (incoming), placement via `getEdges({ dsts, rel: 'owns_component' |
 * 'owns_project' })`, and `resolveStatusesFor` via `getEdges({ srcs, rels })`
 * (sox-graph-store >= 0.12.4).
 *
 * ## Teeth
 *
 * - AC-C1 asserts the exact call shapes and that NO `getEdges` call is keyed
 *   by a relation alone. Negative control (run, recorded in the commit
 *   message): restoring the pre-change `getEdges({ rel })` loop turns it RED.
 * - AC-C3 asserts the ROWS the store returned through the real `queryIssues`
 *   path on a >= 10 000-edge relation, for pages of 1 and 20. Negative control:
 *   the same pre-change loop turns it RED (rows == relation cardinality).
 * - AC-C2 is a differential: the batched page path and the single-item
 *   `getIssue` path deep-equal for every field, including placement.
 *
 * No wall-clock assertion anywhere; every bound is a row or call count.
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
import { assembleIssueCards } from './card.js';
import { getIssue } from './get.js';
import { queryIssues } from './query.js';
import { resolveIssueByUid } from './resolve.js';
import type { IIssueField } from './types.js';

const POOL = 30;
const FILLER = 10_000;
const ALL_EDGE_FIELDS: readonly IIssueField[] = [
  'uid',
  'title',
  'kind',
  'status',
  'priority',
  'author',
  'project',
  'component',
  'blockers',
  'partOf',
  'related',
  'blocksOut',
  'dependents',
  'auditTrail',
];

describe('e54afd3f — page-keyed edge reads in buildPageReadBatch (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let uids: string[];
  let records: NodeRecord[];
  let pageNodeIds: number[];
  /** Live `has_status` edges in the store (pool + filler). */
  let hasStatusCardinality = 0;

  beforeAll(async () => {
    dir = freshTmpDir('page-keyed-edge-read');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const { projectUid } = await seedProject(store, 'page-keyed-project');

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
      if (created.uid === undefined) throw new Error(`no uid for issue ${i}`);
      uids.push(created.uid);
      records.push(await resolveIssueByUid(store.graph, created.uid));
    }
    pageNodeIds = records.map((r) => r.id);
    for (let i = 0; i < POOL; i++) {
      for (const [off, rel] of [
        [1, 'relates_to'],
        [2, 'blocks'],
        [3, 'part_of'],
      ] as const) {
        await relate(store, {
          sourceUid: uids[i],
          targetUid: uids[(i + off) % POOL],
          rel,
          action: 'add',
          by: 'filer',
        });
      }
    }

    // Filler: FILLER unrelated nodes, each with a live `has_status` edge to the
    // SAME status node the pool uses. Multi-row INSERT statements (500 rows
    // each) instead of 10 000 per-row graph writes — the per-row path
    // (writeNode + FTS trigger + uniqueness probe per row) timed out at 300 s.
    // Raw inserts are legitimate here because the rows are fixture ballast,
    // never read back as issues. This pushes `has_status` to >= 10 000 live
    // edges: the large-store / small-page shape 89cc3a30 AC-1 / e54afd3f
    // describe. (Turso does not support recursive CTEs, hence JS-built VALUES.)
    const statusEdges = await store.graph.getEdges({ src: records[0].id, rel: 'has_status' });
    const statusNodeId = statusEdges[0].dst;
    const now = new Date().toISOString();
    const CHUNK = 500;
    for (let start = 0; start < FILLER; start += CHUNK) {
      const n = Math.min(CHUNK, FILLER - start);
      const rows = Array.from({ length: n }, () => '(?, ?, ?, ?)').join(', ');
      const args: unknown[] = [];
      for (let i = start; i < start + n; i++) args.push(`filler-${i}`, 'filler', `filler ${i}`, now);
      await store.adapter.executeRun(
        `INSERT INTO node (uid, kind, content, t_created) VALUES ${rows}`,
        args
      );
    }
    await store.adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, t_created)
       SELECT rowid, ?, 'has_status', ? FROM node WHERE kind = 'filler'`,
      [statusNodeId, now]
    );
    hasStatusCardinality = (await store.graph.getEdges({ rel: 'has_status' })).length;
  }, 300_000);

  afterAll(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** Runs `fn` with `getEdges` spied; returns the call args and every returned row count. */
  async function spyEdges<T>(
    fn: () => Promise<T>
  ): Promise<{ value: T; calls: Array<Record<string, unknown>>; rows: number[] }> {
    const spy = vi.spyOn(store.graph, 'getEdges');
    try {
      const value = await fn();
      const calls = spy.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const rows = await Promise.all(
        spy.mock.results.map(async (r) => (await r.value).length as number)
      );
      return { value, calls, rows };
    } finally {
      spy.mockRestore();
    }
  }

  it('e54afd3f AC-C1: issues srcs + dsts reads and zero getEdges({rel}) on the hot path', async () => {
    const page = records.slice(0, 5);
    const ids = page.map((r) => r.id);
    const { calls } = await spyEdges(() =>
      assembleIssueCards(store.graph, page, ALL_EDGE_FIELDS)
    );

    // Outgoing: one page-keyed `srcs` read covering exactly the page.
    const outgoing = calls.filter((c) => c.srcs !== undefined && c.rel === undefined);
    expect(outgoing.length).toBeGreaterThanOrEqual(1);
    expect(outgoing[0].srcs).toEqual(ids);
    // Incoming: one page-keyed `dsts` read narrowed by `rels`.
    const incoming = calls.filter((c) => c.dsts !== undefined && c.rels !== undefined);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].dsts).toEqual(ids);
    // Placement: keyed by `dsts` with a single owning relation.
    const placement = calls.filter(
      (c) => c.rel === 'owns_component' || c.rel === 'owns_project'
    );
    expect(placement.length).toBeGreaterThanOrEqual(1);
    for (const c of placement) {
      expect(c.dsts).toBeDefined();
      expect(c.src).toBeUndefined();
    }
    // The defect: a `rel`-only (relation-wide) read — no src/srcs/dst/dsts key.
    const wholeRelation = calls.filter(
      (c) =>
        c.src === undefined &&
        c.srcs === undefined &&
        c.dst === undefined &&
        c.dsts === undefined
    );
    expect(wholeRelation).toEqual([]);
  });

  it('e54afd3f AC-C1: the default five-field card needs only one srcs read and no whole-relation read', async () => {
    const page = records.slice(0, 5);
    const { calls } = await spyEdges(() =>
      assembleIssueCards(store.graph, page, ['uid', 'kind', 'title', 'status', 'priority'])
    );
    expect(calls.filter((c) => c.rel !== undefined && c.src === undefined && c.srcs === undefined && c.dst === undefined && c.dsts === undefined)).toEqual([]);
    expect(calls.some((c) => c.srcs !== undefined)).toBe(true);
  });

  it('e54afd3f AC-C2: the batched page path deep-equals the single-item getIssue path for every field', async () => {
    const batched = await assembleIssueCards(store.graph, records, ALL_EDGE_FIELDS);
    expect(batched).toHaveLength(POOL);
    for (let i = 0; i < POOL; i++) {
      const single = await getIssue(store.graph, {
        uid: uids[i],
        fields: [...ALL_EDGE_FIELDS],
      });
      expect(batched[i]).toEqual(single);
    }
    // The corpus must actually exercise the edge resolvers (not vacuous).
    const withRelated = batched.filter(
      (c) => Array.isArray((c as { related?: unknown[] }).related) && (c as { related: unknown[] }).related.length > 0
    );
    expect(withRelated.length).toBe(POOL);
  });

  it.each([1, 20])(
    'e54afd3f AC-C3: a %i-item query page on a >=10000-edge relation fetches O(page) rows through the real query path',
    async (limit) => {
      expect(hasStatusCardinality).toBeGreaterThanOrEqual(FILLER);

      const { value, calls, rows } = await spyEdges(() =>
        queryIssues(store, {
          view: 'list',
          limit,
          fields: ['uid', 'kind', 'title', 'status', 'priority', 'blockers', 'related', 'project'],
        })
      );
      const items = (value as { items: unknown[] }).items;
      expect(items).toHaveLength(limit);

      // No relation-wide read reached the store.
      const wholeRelation = calls.filter(
        (c) =>
          c.src === undefined &&
          c.srcs === undefined &&
          c.dst === undefined &&
          c.dsts === undefined &&
          c.rel !== undefined
      );
      // `query` itself may issue unrelated relation-wide reads outside the
      // card path (e.g. list scoping); the card path must add none that scan
      // the 10k-edge `has_status` relation.
      expect(wholeRelation.filter((c) => c.rel === 'has_status')).toEqual([]);

      // Headline row bound: total rows returned across every getEdges call is
      // a small fraction of the has_status relation alone (>= 10 000).
      const totalRows = rows.reduce((a, b) => a + b, 0);
      expect(totalRows).toBeLessThan(hasStatusCardinality / 20);
      void pageNodeIds;
    },
    60_000
  );
});
