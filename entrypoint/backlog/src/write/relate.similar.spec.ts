/**
 * relate.similar.spec.ts — C9 AC4: the reviewed similarity link is the
 * EXISTING `relate` verb with relation `similar_to` (no `link-duplicate`
 * verb), and the reserved `duplicate_of` relation keeps its `n:1` multiplicity.
 *
 * Real store, real `createIssue`/`relate`, real edge/audit reads.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIssue } from './create-issue.js';
import { InvalidArgumentError, SingleValuedRelationConflictError } from './errors.js';
import { relate } from './relate.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

type WriteStore = Pick<TestIssueStore, 'adapter' | 'graph' | 'typePolicy'>;

async function file(
  store: TestIssueStore,
  projectUid: string,
  title: string
): Promise<string> {
  const result = await createIssue(store as unknown as WriteStore, {
    project: projectUid,
    title,
    body: `${title} body`,
    by: 'filer',
  });
  if (!result.created || !result.uid)
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  return result.uid;
}

async function countAuditNodes(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    "SELECT COUNT(*) AS n FROM node WHERE kind = 'audit'",
    []
  );
  return rows[0]?.n ?? 0;
}

async function liveEdgeCount(
  store: TestIssueStore,
  srcUid: string,
  rel: string
): Promise<number> {
  const src = await store.graph.getNodeByUid(srcUid);
  if (!src) return 0;
  const edges = await store.graph.getEdges({ src: src.id, rel });
  return edges.length;
}

let dir: string;
let store: TestIssueStore;
let issueA: string;
let issueB: string;

beforeEach(async () => {
  dir = freshTmpDir('relate-similar-spec');
  store = await openTestIssueStore(join(dir, 'backlog.db'));
  const a = await seedProject(store, 'relate-similar-a');
  const b = await seedProject(store, 'relate-similar-b');
  issueA = await file(store, a.projectUid, 'issue A');
  issueB = await file(store, b.projectUid, 'issue B');
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('C9 AC4 — reviewed link via relate {rel:"similar_to"}', () => {
  it('adds one cross-project similar_to edge and one audit row; re-add is an idempotent noop', async () => {
    const auditBefore = await countAuditNodes(store);

    const outcome = await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueB,
      rel: 'similar_to',
      action: 'add',
      by: 'reviewer',
    });
    expect(outcome).toEqual({
      sourceUid: issueA,
      targetUid: issueB,
      rel: 'similar_to',
      action: 'add',
      noop: false,
    });
    expect(await liveEdgeCount(store, issueA, 'similar_to')).toBe(1);
    expect(await countAuditNodes(store)).toBe(auditBefore + 1);

    // Idempotent re-add: stated noop, no second edge, no second audit.
    const again = await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueB,
      rel: 'similar_to',
      action: 'add',
      by: 'reviewer',
    });
    expect(again.noop).toBe(true);
    expect(await liveEdgeCount(store, issueA, 'similar_to')).toBe(1);
    expect(await countAuditNodes(store)).toBe(auditBefore + 1);
  });

  it('n:m: one source may carry similar_to links to MANY targets (both succeed)', async () => {
    const c = await seedProject(store, 'relate-similar-c');
    const issueC = await file(store, c.projectUid, 'issue C');

    await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueB,
      rel: 'similar_to',
      action: 'add',
      by: 'reviewer',
    });
    await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueC,
      rel: 'similar_to',
      action: 'add',
      by: 'reviewer',
    });
    expect(await liveEdgeCount(store, issueA, 'similar_to')).toBe(2);
  });

  it('a self-link is refused and writes nothing', async () => {
    const auditBefore = await countAuditNodes(store);
    await expect(
      relate(store as unknown as WriteStore, {
        sourceUid: issueA,
        targetUid: issueA,
        rel: 'similar_to',
        action: 'add',
        by: 'reviewer',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await liveEdgeCount(store, issueA, 'similar_to')).toBe(0);
    expect(await countAuditNodes(store)).toBe(auditBefore);
  });

  it('the reserved duplicate_of relation is untouched: still n:1, a second target conflicts', async () => {
    const c = await seedProject(store, 'relate-similar-d');
    const issueC = await file(store, c.projectUid, 'issue C2');
    await relate(store as unknown as WriteStore, {
      sourceUid: issueA,
      targetUid: issueB,
      rel: 'duplicate_of',
      action: 'add',
      by: 'reviewer',
    });
    await expect(
      relate(store as unknown as WriteStore, {
        sourceUid: issueA,
        targetUid: issueC,
        rel: 'duplicate_of',
        action: 'add',
        by: 'reviewer',
      })
    ).rejects.toBeInstanceOf(SingleValuedRelationConflictError);
    expect(await liveEdgeCount(store, issueA, 'duplicate_of')).toBe(1);
  });
});
