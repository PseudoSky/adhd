/**
 * relate.spec.ts — behavioral proof for `relate` (SPEC.md §6.3.6, §8 AC-17).
 *
 * Every test drives `relate` against a REAL store (`openTestIssueStore` —
 * never a mock of `relate` itself, never a mock of the store) through real
 * `createIssue`-minted issues, then verifies both the returned outcome AND
 * the raw underlying `edge`/`node` rows directly — so a bug that returns the
 * right-looking outcome while mutating (or failing to mutate) the wrong row
 * cannot pass silently.
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
import { relate, type IRelateInput } from './relate.js';
import { InvalidArgumentError, IssueNotFoundError, SingleValuedRelationConflictError } from './errors.js';

interface RawEdgeRow {
  rowid: number;
  t_valid: string;
  t_invalid: string | null;
  meta: string | null;
}

interface RawAuditRow {
  action: string;
  to: string | null;
  note: string | null;
}

async function readLiveEdge(store: TestIssueStore, srcUid: string, dstUid: string, rel: string): Promise<RawEdgeRow | null> {
  const { rows } = await store.adapter.executeAll<RawEdgeRow>(
    `SELECT e.rowid as rowid, e.t_valid as t_valid, e.t_invalid as t_invalid, e.meta as meta
     FROM edge e JOIN node s ON s.rowid = e.src JOIN node d ON d.rowid = e.dst
     WHERE s.uid = ? AND d.uid = ? AND e.rel = ? AND e.t_invalid IS NULL`,
    [srcUid, dstUid, rel],
  );
  return rows[0] ?? null;
}

/** Every `audit` node linked to `subjectUid` via a live `audits` edge, oldest first — a direct real SQL read, never a mock. */
async function readAuditTrail(store: TestIssueStore, subjectUid: string): Promise<RawAuditRow[]> {
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
    `SELECT a.meta as meta FROM edge e
     JOIN node s ON s.rowid = e.src
     JOIN node a ON a.rowid = e.dst
     WHERE s.uid = ? AND e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
     ORDER BY a.rowid ASC`,
    [subjectUid],
  );
  return rows.map((row) => {
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    return {
      action: String(meta['action'] ?? ''),
      to: (meta['to'] as string | null) ?? null,
      note: (meta['note'] as string | null) ?? null,
    };
  });
}

describe('relate — §6.3.6 / §8 AC-17 (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueA: string;
  let issueB: string;
  let issueC: string;

  beforeEach(async () => {
    dir = freshTmpDir('relate-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'relate-spec-project');
    projectUid = seeded.projectUid;

    const a = await createIssue(store, { project: projectUid, title: 'issue A', body: 'source', by: 'filer' });
    const b = await createIssue(store, { project: projectUid, title: 'issue B', body: 'target', by: 'filer' });
    const c = await createIssue(store, { project: projectUid, title: 'issue C', body: 'other target', by: 'filer' });
    issueA = a.uid;
    issueB = b.uid;
    issueC = c.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('add on an n:m rel (relates_to): writes a live edge + one NEW audit row, noop:false', async () => {
    const baseline = (await readAuditTrail(store, issueA)).length; // createIssue itself already wrote a "created" audit against issueA
    const outcome = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-a' });
    expect(outcome).toEqual({ sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', noop: false });

    const edge = await readLiveEdge(store, issueA, issueB, 'relates_to');
    expect(edge).not.toBeNull();

    const trail = await readAuditTrail(store, issueA);
    expect(trail).toHaveLength(baseline + 1);
    expect(trail[trail.length - 1]).toEqual({ action: 'related', to: issueB, note: 'relates_to' });
  });

  it('add TEETH: a second identical add is a true no-op — the edge row and audit trail are BYTE-IDENTICAL, not merely noop:true in the outcome', async () => {
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-a' });
    const before = await readLiveEdge(store, issueA, issueB, 'relates_to');
    if (!before) throw new Error('setup: expected a live edge after the first add');
    const baseline = (await readAuditTrail(store, issueA)).length;

    const outcome = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-b' });
    expect(outcome.noop).toBe(true);

    const after = await readLiveEdge(store, issueA, issueB, 'relates_to');
    // Same rowid, same t_valid, same meta — writeEdgeTx's own upsert (which
    // would bump t_valid/meta on a re-run) was never even called. A bug that
    // deletes this file's own noop pre-check and always calls writeEdgeTx
    // would still return semantically-right-looking output in many cases,
    // but WOULD perturb t_valid here — this assertion catches that class of
    // regression, not just the boolean.
    expect(after).toEqual(before);

    // And no second audit row was produced by the "already related" no-op.
    expect((await readAuditTrail(store, issueA)).length).toBe(baseline);
  });

  it('remove on a live edge: invalidates it + writes one NEW audit row, noop:false', async () => {
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-a' });
    const baseline = (await readAuditTrail(store, issueA)).length;
    const outcome = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'remove', by: 'agent-a' });
    expect(outcome).toEqual({ sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'remove', noop: false });

    const edge = await readLiveEdge(store, issueA, issueB, 'relates_to');
    expect(edge).toBeNull();

    const trail = await readAuditTrail(store, issueA);
    expect(trail).toHaveLength(baseline + 1);
    expect(trail[trail.length - 1]).toEqual({ action: 'unrelated', to: issueB, note: 'relates_to' });
  });

  it('remove TEETH: removing an edge that was never added (or already removed) is noop:true, writes NO audit row', async () => {
    const baseline = (await readAuditTrail(store, issueA)).length;
    const outcome = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'remove', by: 'agent-a' });
    expect(outcome.noop).toBe(true);
    expect((await readAuditTrail(store, issueA)).length).toBe(baseline);

    // Add then remove then remove again — the second remove must ALSO be a noop.
    await relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'relates_to', action: 'add', by: 'agent-a' });
    await relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'relates_to', action: 'remove', by: 'agent-a' });
    const afterAddRemove = (await readAuditTrail(store, issueA)).length;
    const secondRemove = await relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'relates_to', action: 'remove', by: 'agent-a' });
    expect(secondRemove.noop).toBe(true);
    // The noop remove must add NO further audit row beyond the real add+remove pair above.
    expect((await readAuditTrail(store, issueA)).length).toBe(afterAddRemove);
  });

  it('re-adding a REMOVED single-valued edge to the SAME target re-livens it (noop:false, not noop:true) — distinct from the still-live case', async () => {
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'supersedes', action: 'add', by: 'agent-a' });
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'supersedes', action: 'remove', by: 'agent-a' });
    const relivened = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'supersedes', action: 'add', by: 'agent-a' });
    expect(relivened.noop).toBe(false);
    expect(await readLiveEdge(store, issueA, issueB, 'supersedes')).not.toBeNull();
  });

  it('AC-17: single-valued rel (supersedes), SAME target twice → noop:true; DIFFERENT target → SingleValuedRelationConflictError, and the original edge is untouched', async () => {
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'supersedes', action: 'add', by: 'agent-a' });

    const sameTarget = await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'supersedes', action: 'add', by: 'agent-b' });
    expect(sameTarget.noop).toBe(true);

    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'supersedes', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(SingleValuedRelationConflictError);

    try {
      await relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'supersedes', action: 'add', by: 'agent-a' });
      expect.unreachable('expected SingleValuedRelationConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(SingleValuedRelationConflictError);
      const conflict = err as SingleValuedRelationConflictError;
      expect(conflict.side).toBe('source');
      expect(conflict.cappedUid).toBe(issueA);
      expect(conflict.rel).toBe('supersedes');
      expect(conflict.conflictingUid).toBe(issueB);
    }

    // The rejected attempt must NEVER have written a "supersedes" edge toward C,
    // nor disturbed the original A->B edge.
    expect(await readLiveEdge(store, issueA, issueC, 'supersedes')).toBeNull();
    expect(await readLiveEdge(store, issueA, issueB, 'supersedes')).not.toBeNull();
  });

  it('the OTHER two single-valued rels (duplicate_of, part_of) are covered by the SAME generic multiplicity gate — no rel-specific code path', async () => {
    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'duplicate_of', action: 'add', by: 'agent-a' });
    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'duplicate_of', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(SingleValuedRelationConflictError);

    await relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'part_of', action: 'add', by: 'agent-a' });
    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueC, rel: 'part_of', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(SingleValuedRelationConflictError);
  });

  it('cross-project relate "just works" — no repo/project parameter, no restriction (resolves the currently shipped tool\'s known gap)', async () => {
    const otherProject = await seedProject(store, 'relate-spec-other-project');
    const issueD = (await createIssue(store, { project: otherProject.projectUid, title: 'issue D (other project)', body: 'x', by: 'filer' })).uid;

    const outcome = await relate(store, { sourceUid: issueA, targetUid: issueD, rel: 'blocks', action: 'add', by: 'agent-a' });
    expect(outcome).toEqual({ sourceUid: issueA, targetUid: issueD, rel: 'blocks', action: 'add', noop: false });
    expect(await readLiveEdge(store, issueA, issueD, 'blocks')).not.toBeNull();
  });

  it('self-relation (sourceUid === targetUid) throws InvalidArgumentError, never written', async () => {
    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueA, rel: 'relates_to', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(InvalidArgumentError);
    expect(await readLiveEdge(store, issueA, issueA, 'relates_to')).toBeNull();
  });

  it('IssueNotFoundError for a missing source or target endpoint', async () => {
    await expect(
      relate(store, { sourceUid: 'not-a-real-uid', targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(IssueNotFoundError);
    await expect(
      relate(store, { sourceUid: issueA, targetUid: 'not-a-real-uid', rel: 'relates_to', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('an invalidated (deleted) endpoint is treated identically to a missing one', async () => {
    await store.adapter.executeRun('UPDATE node SET t_invalid = ? WHERE uid = ?', ['2020-01-01T00:00:00.000Z', issueB]);
    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: 'agent-a' }),
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('rejects a rel outside the closed 5-value set, and an action outside add/remove — a transport boundary can send an arbitrary string past the TS type', async () => {
    const badRel = { sourceUid: issueA, targetUid: issueB, rel: 'owns_component', action: 'add', by: 'agent-a' } as unknown as IRelateInput;
    await expect(relate(store, badRel)).rejects.toThrow(InvalidArgumentError);

    const badAction = { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'archive', by: 'agent-a' } as unknown as IRelateInput;
    await expect(relate(store, badAction)).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects a missing/blank "by"', async () => {
    await expect(
      relate(store, { sourceUid: issueA, targetUid: issueB, rel: 'relates_to', action: 'add', by: '' }),
    ).rejects.toThrow(InvalidArgumentError);
  });
});
