/**
 * delete.spec.ts — behavioral proof for `delete` (SPEC.md §6.3.7, §4c,
 * bi-temporal soft-delete).
 *
 * `delete` is a short soft-invalidate, not a CAS — its correctness bar is
 * "never a hard row deletion, and the audit trail stays intact," proven
 * here with a real store and real reads, never mocks: the content/name/kind
 * survive verbatim, `t_invalid` gets stamped, `meta.invalidatedReason`/
 * `invalidatedAt` merge into the EXISTING metadata (never a wholesale
 * replace, unlike `claim`'s `touch` calls), every prior audit/citation row
 * remains reachable, and a SECOND `delete` against the same (now dead) `uid`
 * is rejected rather than silently re-stamping over the first deletion's
 * record.
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
import { deleteIssue } from './delete.js';
import { InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

interface RawAuditRow {
  action: string;
  note: string | null;
}

async function readAuditTrail(
  store: TestIssueStore,
  subjectRowid: number
): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e JOIN node a ON a.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectRowid]
  );
  return rows.map((row) => {
    const meta = row.meta
      ? (JSON.parse(row.meta) as Record<string, unknown>)
      : {};
    return {
      action: String(meta['action'] ?? ''),
      note: (meta['note'] as string | null) ?? null,
    };
  });
}

describe('delete — bi-temporal soft-invalidate (SPEC.md §6.3.7, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueUid: string;
  let issueRowid: number;

  beforeEach(async () => {
    dir = freshTmpDir('delete-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'delete-spec-project');
    projectUid = seeded.projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'delete target',
      body: 'this body must survive a soft-delete verbatim',
      by: 'filer',
      assignee: 'someone-preexisting',
    });
    issueUid = created.uid;
    const row = await readNode(store, issueUid);
    if (!row)
      throw new Error('setup: issue not found immediately after createIssue');
    issueRowid = row.rowid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('invalidates the node (t_invalid stamped) without touching content/name/kind — never a hard delete', async () => {
    const before = await readNode(store, issueUid);
    expect(before?.tInvalid).toBeNull();

    const outcome = await deleteIssue(store, {
      uid: issueUid,
      reason: 'duplicate of ISSUE-123',
      by: 'closer',
    });
    expect(outcome).toEqual({ uid: issueUid, invalidated: true });

    const after = await readNode(store, issueUid);
    expect(after).not.toBeNull();
    expect(after?.tInvalid).not.toBeNull();
    expect(after?.kind).toBe('issue');
    expect(after?.name).toBe(before?.name);
    expect(after?.content).toBe(before?.content); // the body — verbatim, never rewritten (§8.3's "free text is not rewritten" applied live)
  });

  it('merges invalidatedReason/invalidatedAt into the EXISTING meta — never a wholesale replace (unlike touch)', async () => {
    await deleteIssue(store, {
      uid: issueUid,
      reason: 'stale duplicate',
      by: 'closer',
    });
    const row = await readNode(store, issueUid);
    expect(row?.metadata?.['invalidatedReason']).toBe('stale duplicate');
    expect(typeof row?.metadata?.['invalidatedAt']).toBe('string');
    // pre-existing, unrelated metadata (written by createIssue) must survive the merge.
    expect(row?.metadata?.['assignee']).toBe('someone-preexisting');
  });

  it('the row stops appearing among LIVE nodes (tInvalid !== null is the liveOnly exclusion signal every other verb checks)', async () => {
    await deleteIssue(store, {
      uid: issueUid,
      reason: 'no longer relevant',
      by: 'closer',
    });
    const row = await readNode(store, issueUid);
    expect(row?.tInvalid).not.toBeNull();
  });

  it('writes exactly one audit row (action:"deleted", note = reason) alongside the "created" row already there — the audit trail stays intact', async () => {
    await deleteIssue(store, {
      uid: issueUid,
      reason: 'superseded elsewhere',
      by: 'closer',
    });
    const trail = await readAuditTrail(store, issueRowid);
    expect(trail.map((r) => r.action)).toEqual(['created', 'deleted']);
    expect(trail[1].note).toBe('superseded elsewhere');
  });

  it('a SECOND delete against the same (now dead) uid throws IssueNotFoundError — never silently re-stamps over the first deletion', async () => {
    await deleteIssue(store, {
      uid: issueUid,
      reason: 'first reason',
      by: 'closer-1',
    });
    const firstStamp = await readNode(store, issueUid);

    await expect(
      deleteIssue(store, {
        uid: issueUid,
        reason: 'second reason',
        by: 'closer-2',
      })
    ).rejects.toThrow(IssueNotFoundError);

    const stillFirst = await readNode(store, issueUid);
    expect(stillFirst?.metadata?.['invalidatedReason']).toBe('first reason');
    expect(stillFirst?.tInvalid).toBe(firstStamp?.tInvalid);
    // Only ONE audit row from the delete path — the rejected second call wrote nothing.
    const trail = await readAuditTrail(store, issueRowid);
    expect(trail.filter((r) => r.action === 'deleted')).toHaveLength(1);
  });

  it('IssueNotFoundError for a uid that never resolved to a live issue at all', async () => {
    await expect(
      deleteIssue(store, {
        uid: 'not-a-real-uid',
        reason: 'whatever',
        by: 'closer',
      })
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('InvalidArgumentError on missing/blank uid, by, or reason — before any write runs', async () => {
    await expect(
      deleteIssue(store, { uid: '', reason: 'x', by: 'closer' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      deleteIssue(store, { uid: issueUid, reason: 'x', by: '   ' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      deleteIssue(store, { uid: issueUid, reason: '', by: 'closer' })
    ).rejects.toThrow(InvalidArgumentError);

    // None of the rejected calls above may have mutated the row.
    const row = await readNode(store, issueUid);
    expect(row?.tInvalid).toBeNull();
  });

  it('rejects a blank reason WITHOUT resolving the uid first, still a genuine E_VALIDATION-before-any-driver-call', async () => {
    // Even an otherwise-nonexistent uid must fail on the blank `reason` check, never on
    // IssueNotFoundError — validation runs before any driver call (§4c).
    await expect(
      deleteIssue(store, { uid: 'does-not-exist', reason: '  ', by: 'closer' })
    ).rejects.toThrow(InvalidArgumentError);
  });
});
