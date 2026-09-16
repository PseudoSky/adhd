/**
 * card.spec.ts — `resolveStatusesFor` (the private `has_status` batcher
 * shared by `resolveBlockers`/`resolveRelated`) really does cost a constant
 * number of `getEdges` round trips regardless of how many issues it is
 * asked to resolve statuses for, and the statuses it returns are correct.
 *
 * ## Why this test exists
 *
 * A blind performance review flagged `resolveStatusesFor`'s own doc comment
 * ("one `getEdges` + one `getNodesByIds`, never N round trips") as
 * contradicted by its body, which fired `graph.getEdges({src, rel})` once
 * PER issue via `Promise.all` — concurrent, but still N round trips, not the
 * one the comment promised. This file pins the fix (a single
 * `getEdges({rel:'has_status'})` covering the whole relation, filtered in
 * memory) with a call-count assertion that goes red the moment the N-round-trip
 * shape comes back, plus correctness assertions carried over unchanged from
 * before the rewrite.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { relate } from '../write/relate.js';
import { resolveIssueByUid } from './resolve.js';
import { resolveBlockers, resolveRelated } from './card.js';

describe('resolveStatusesFor (via resolveBlockers/resolveRelated) — constant round trips, real store', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('card-resolve-statuses');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'card-statuses-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string, status?: string): Promise<{ uid: string; id: number }> {
    const created = await createIssue(store, { project: projectUid, title, body: `${title} body`, by: 'filer', status });
    const record = await resolveIssueByUid(store.graph, created.uid);
    return { uid: created.uid, id: record.id };
  }

  it('resolveBlockers issues a constant number of getEdges calls no matter how many blockers exist', async () => {
    const blocked = await mkIssue('blocked by many');
    const blockerCount = 6;
    const blockers: { uid: string; id: number }[] = [];
    for (let i = 0; i < blockerCount; i++) {
      const b = await mkIssue(`blocker ${i}`, 'in-progress');
      await relate(store, { sourceUid: b.uid, targetUid: blocked.uid, rel: 'blocks', action: 'add', by: 'filer' });
      blockers.push(b);
    }

    const getEdgesSpy = vi.spyOn(store.graph, 'getEdges');
    const result = await resolveBlockers(store.graph, blocked.id);
    // Exactly two calls belong to `resolveBlockers` itself + `resolveStatusesFor`:
    // one `getEdges({dst, rel:'blocks'})` for the incoming blockers, and one
    // `getEdges({rel:'has_status'})` for the whole has_status relation — NOT
    // one-per-blocker. If `resolveStatusesFor` regresses to a per-issue round
    // trip, this call count grows with `blockerCount` and the assertion below
    // goes red.
    expect(getEdgesSpy).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.uid).sort()).toEqual(blockers.map((b) => b.uid).sort());
    for (const r of result) {
      expect(r.status).toBe('in-progress');
    }
    getEdgesSpy.mockRestore();
  });

  it('resolveRelated issues a constant number of getEdges calls no matter how many related issues exist', async () => {
    const anchor = await mkIssue('anchor');
    const relatedCount = 6;
    const related: { uid: string; id: number }[] = [];
    for (let i = 0; i < relatedCount; i++) {
      const r = await mkIssue(`related ${i}`, 'open');
      await relate(store, { sourceUid: anchor.uid, targetUid: r.uid, rel: 'relates_to', action: 'add', by: 'filer' });
      related.push(r);
    }

    const getEdgesSpy = vi.spyOn(store.graph, 'getEdges');
    const result = await resolveRelated(store.graph, anchor.id);
    // `resolveRelated` itself issues two getEdges calls (outgoing + incoming
    // `relates_to`) plus `resolveStatusesFor`'s one whole-relation
    // `has_status` fetch — three total, never growing with `relatedCount`.
    expect(getEdgesSpy).toHaveBeenCalledTimes(3);
    expect(result.map((r) => r.uid).sort()).toEqual(related.map((r) => r.uid).sort());
    for (const r of result) {
      expect(r.status).toBe('open');
    }
    getEdgesSpy.mockRestore();
  });
});
