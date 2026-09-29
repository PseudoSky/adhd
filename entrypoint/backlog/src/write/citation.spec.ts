/**
 * citation.spec.ts — the first-class citation verbs (`addCitation` /
 * `removeCitation`) and `update`'s citations DIFF-EMITTER.
 *
 * Every assertion drives the REAL verbs against a REAL store opened via
 * `openTestIssueStore`, and reads state back through direct SQL — never a
 * verb's own outcome object (a self-report a bug could keep consistent). The
 * load-bearing invariant is §1's "uid is the only identity": adding or removing
 * a citation, or diffing a citation set, must NEVER mint a new issue uid or
 * supersede the issue. The negative control at the bottom proves the teeth of
 * that claim by showing the ONE path that legitimately DOES mint a new uid (a
 * body edit) and contrasting it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { upsertProject } from './catalog.js';
import { createIssue } from './create-issue.js';
import { addCitation, removeCitation } from './citation.js';
import { update } from './update.js';
import {
  CitationNotFoundError,
  CitationUnverifiableError,
  InvalidArgumentError,
  IssueNotFoundError,
} from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';
import { queryIssues } from '../query/query.js';
import type { IIssueCitation } from '../query/types.js';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

/** The LIVE `has_citation` edges' targets for `issueRowid`, as their persisted `target` values — direct SQL, never a verb outcome. */
async function liveCitationTargets(
  store: TestIssueStore,
  issueRowid: number
): Promise<string[]> {
  const { rows } = await store.adapter.executeAll<{ target: string | null }>(
    `SELECT json_extract(n.meta, '$.target') AS target
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.src = ? AND e.rel = 'has_citation' AND e.t_invalid IS NULL
        AND n.t_invalid IS NULL`,
    [issueRowid]
  );
  return rows.map((r) => r.target ?? '');
}

/** Count of LIVE `has_citation` edges from `issueRowid` to `citationRowid`. */
async function liveCitationEdgeCount(
  store: TestIssueStore,
  issueRowid: number,
  citationRowid: number
): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) AS n FROM edge
      WHERE src = ? AND dst = ? AND rel = 'has_citation' AND t_invalid IS NULL`,
    [issueRowid, citationRowid]
  );
  return rows[0]?.n ?? 0;
}

/** The `action` of every live audit row attached to `subjectRowid`. */
async function auditActions(
  store: TestIssueStore,
  subjectRowid: number
): Promise<string[]> {
  const { rows } = await store.adapter.executeAll<{ action: string | null }>(
    `SELECT json_extract(n.meta, '$.action') AS action
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.src = ? AND e.rel = 'audits' AND e.t_invalid IS NULL
      ORDER BY n.rowid`,
    [subjectRowid]
  );
  return rows.map((r) => r.action ?? '');
}

async function countLiveIssues(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    "SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NULL"
  );
  return rows[0]?.n ?? 0;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('citation verbs + update diff (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('citation-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const project = await upsertProject(store, {
      name: 'citation-spec-project',
      path: dir,
      by: 'filer',
    });
    projectUid = project.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** The citations of `issueUid` (in `project`), read through the REAL read path (`queryIssues` → `card.ts` → `citationFromNode`) so the round-trip is exercised, not just the write side. */
  async function readCitations(
    project: string,
    issueUid: string
  ): Promise<IIssueCitation[]> {
    const result = await queryIssues(store, {
      filter: { project },
      fields: ['uid', 'citations'],
      limit: 10,
    });
    if (result.view !== 'list' || !('items' in result)) {
      throw new Error(`expected an item-list result, got view:${result.view}`);
    }
    return result.items.find((i) => i.uid === issueUid)?.citations ?? [];
  }

  async function createIssueWith(
    title: string,
    citations: { file: string }[] = []
  ): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
      citations,
    });
    if (!created.created || created.uid === undefined) {
      throw new Error('setup: createIssue did not create');
    }
    return created.uid;
  }

  it('addCitation mints a live citation node + has_citation edge + audit; the issue uid is unchanged', async () => {
    writeFileSync(join(dir, 'evidence.ts'), 'export const evidence = 1;\n');
    const issueUid = await createIssueWith('addCitation subject');
    const issueBefore = await readNode(store, issueUid);
    if (!issueBefore) throw new Error('setup: issue missing');

    const outcome = await addCitation(store, {
      uid: issueUid,
      citation: { file: 'evidence.ts', lines: '1-1', symbol: 'evidence' },
      by: 'filer',
    });

    expect(outcome.issueUid).toBe(issueUid);
    expect(outcome.uid).toMatch(/^[0-9a-f-]{36}$/);

    const citationRow = await readNode(store, outcome.uid);
    if (!citationRow) throw new Error('setup: citation node missing');
    expect(citationRow.kind).toBe('citation');
    expect(citationRow.tInvalid).toBeNull();
    expect(citationRow.metadata?.['target']).toBe('evidence.ts');
    expect(citationRow.metadata?.['line']).toBe('1-1');
    expect(citationRow.metadata?.['symbol']).toBe('evidence');
    expect(citationRow.metadata?.['sha']).toBe(
      sha256('export const evidence = 1;\n')
    );

    expect(
      await liveCitationEdgeCount(store, issueBefore.rowid, citationRow.rowid)
    ).toBe(1);
    expect(await liveCitationTargets(store, issueBefore.rowid)).toEqual([
      'evidence.ts',
    ]);
    expect(await auditActions(store, issueBefore.rowid)).toContain(
      'citation-added'
    );

    // The issue identity is UNTOUCHED — same row, not superseded, one issue.
    const issueAfter = await readNode(store, issueUid);
    expect(issueAfter?.rowid).toBe(issueBefore.rowid);
    expect(issueAfter?.isSuperseded).toBe(false);
    expect(await countLiveIssues(store)).toBe(1);
  });

  it('removeCitation invalidates the citation node AND its has_citation edge by the citation uid; the issue uid is untouched', async () => {
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    writeFileSync(join(dir, 'b.ts'), 'b\n');
    const issueUid = await createIssueWith('removeCitation subject', [
      { file: 'a.ts' },
      { file: 'b.ts' },
    ]);
    const issueBefore = await readNode(store, issueUid);
    if (!issueBefore) throw new Error('setup: issue missing');

    const target = (await readCitations(projectUid, issueUid)).find(
      (c) => c.file === 'a.ts'
    );
    if (!target) throw new Error('setup: citation a.ts missing');
    const citationRow = await readNode(store, target.uid);
    if (!citationRow) throw new Error('setup: citation node missing');

    const outcome = await removeCitation(store, {
      uid: target.uid,
      by: 'remover',
      reason: 'no longer valid',
    });
    expect(outcome).toEqual({ uid: target.uid, invalidated: true });

    const removed = await readNode(store, target.uid);
    expect(removed?.tInvalid).not.toBeNull();
    expect(removed?.metadata?.['invalidatedReason']).toBe('no longer valid');
    expect(
      await liveCitationEdgeCount(store, issueBefore.rowid, citationRow.rowid)
    ).toBe(0);

    // Only a.ts is gone; b.ts survives.
    expect(await liveCitationTargets(store, issueBefore.rowid)).toEqual([
      'b.ts',
    ]);
    expect(await auditActions(store, issueBefore.rowid)).toContain(
      'citation-removed'
    );

    // The ISSUE is untouched.
    const issueAfter = await readNode(store, issueUid);
    expect(issueAfter?.rowid).toBe(issueBefore.rowid);
    expect(issueAfter?.tInvalid).toBeNull();
    expect(issueAfter?.isSuperseded).toBe(false);
  });

  it('removeCitation refuses a non-existent, foreign-kind, or already-removed uid (CitationNotFoundError)', async () => {
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    const issueUid = await createIssueWith('removal refusals', [
      { file: 'a.ts' },
    ]);
    const issueRow = await readNode(store, issueUid);
    if (!issueRow) throw new Error('setup: issue missing');

    // (1) a uid that never resolved to a live citation
    await expect(
      removeCitation(store, {
        uid: '00000000-0000-4000-8000-000000000000',
        by: 'remover',
      })
    ).rejects.toThrow(CitationNotFoundError);

    // (2) a FOREIGN uid — the issue's own uid is not a citation
    await expect(
      removeCitation(store, { uid: issueUid, by: 'remover' })
    ).rejects.toThrow(CitationNotFoundError);

    // (3) an already-removed uid (non-resurrection)
    const citeUid = (await readCitations(projectUid, issueUid)).find(
      (c) => c.file === 'a.ts'
    )?.uid;
    if (!citeUid) throw new Error('setup: citation missing');
    await removeCitation(store, { uid: citeUid, by: 'remover' });
    await expect(
      removeCitation(store, { uid: citeUid, by: 'remover' })
    ).rejects.toThrow(CitationNotFoundError);

    // (4) blank args
    await expect(
      removeCitation(store, { uid: '', by: 'remover' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      removeCitation(store, { uid: citeUid, by: ' ' })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('addCitation refuses a missing issue and blank args', async () => {
    await expect(
      addCitation(store, {
        uid: '00000000-0000-4000-8000-000000000000',
        citation: { file: 'x.ts' },
        by: 'filer',
      })
    ).rejects.toThrow(IssueNotFoundError);

    const issueUid = await createIssueWith('addCitation refusals');
    await expect(
      addCitation(store, { uid: issueUid, citation: { file: '  ' }, by: 'f' })
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      addCitation(store, { uid: issueUid, citation: { file: 'x.ts' }, by: ' ' })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("update's citations DIFF-EMITTER adds and removes against the live set — and does NOT mint a new issue uid", async () => {
    writeFileSync(join(dir, 'A.ts'), 'A\n');
    writeFileSync(join(dir, 'B.ts'), 'B\n');
    writeFileSync(join(dir, 'C.ts'), 'C\n');
    const issueUid = await createIssueWith('diff subject', [
      { file: 'A.ts' },
      { file: 'B.ts' },
    ]);
    const before = await readNode(store, issueUid);
    if (!before) throw new Error('setup: issue missing');
    const issuesBefore = await countLiveIssues(store);

    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      citations: [{ file: 'B.ts' }, { file: 'C.ts' }],
    });

    // THE invariant: no new uid, no supersession.
    expect(outcome.uid).toBe(issueUid);
    expect(outcome.changed).toContain('citations');

    const after = await readNode(store, issueUid);
    expect(after?.rowid).toBe(before.rowid);
    expect(after?.isSuperseded).toBe(false);
    expect(await countLiveIssues(store)).toBe(issuesBefore);

    // A removed, C added, B kept.
    expect((await liveCitationTargets(store, before.rowid)).sort()).toEqual([
      'B.ts',
      'C.ts',
    ]);
    expect(await auditActions(store, before.rowid)).toContain('updated');
  });

  it('update with citations:[] clears every live citation (still no new uid)', async () => {
    writeFileSync(join(dir, 'A.ts'), 'A\n');
    const issueUid = await createIssueWith('clear subject', [{ file: 'A.ts' }]);
    const before = await readNode(store, issueUid);
    if (!before) throw new Error('setup: issue missing');

    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      citations: [],
    });
    expect(outcome.uid).toBe(issueUid);
    expect(await liveCitationTargets(store, before.rowid)).toEqual([]);
  });

  it("update's diff gates only ADDED citations: an issue holding a citation whose file has since vanished is still updatable", async () => {
    const gone = join(dir, 'gone.ts');
    writeFileSync(gone, 'gone\n');
    const issueUid = await createIssueWith('vanished citation subject', [
      { file: 'gone.ts' },
    ]);
    const before = await readNode(store, issueUid);
    if (!before) throw new Error('setup: issue missing');

    // The cited file vanishes after filing.
    rmSync(gone);
    writeFileSync(join(dir, 'new.ts'), 'new\n');

    // Re-stating the now-unverifiable live citation AND adding a new one must
    // SUCCEED — only the newly-added citation is gated.
    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      citations: [{ file: 'gone.ts' }, { file: 'new.ts' }],
    });
    expect(outcome.uid).toBe(issueUid);
    expect((await liveCitationTargets(store, before.rowid)).sort()).toEqual([
      'gone.ts',
      'new.ts',
    ]);

    // But a genuinely NEW unverifiable citation IS refused, and nothing is
    // written (the diff runs inside the transaction, so the refusal rolls back).
    await expect(
      update(store, {
        uid: issueUid,
        by: 'editor',
        citations: [{ file: 'gone.ts' }, { file: 'never-existed.ts' }],
      })
    ).rejects.toThrow(CitationUnverifiableError);
    expect((await liveCitationTargets(store, before.rowid)).sort()).toEqual([
      'gone.ts',
      'new.ts',
    ]);
  });

  it('NEGATIVE CONTROL: a body edit DOES mint a new uid via supersede — proving the citations-only diff is the no-new-uid path', async () => {
    const issueUid = await createIssueWith('negative control subject');
    const before = await readNode(store, issueUid);
    if (!before) throw new Error('setup: issue missing');

    const outcome = await update(store, {
      uid: issueUid,
      by: 'editor',
      body: 'a brand new body',
    });

    // The body path supersedes: a DIFFERENT uid, and the old row is flagged.
    expect(outcome.uid).not.toBe(issueUid);
    const old = await readNode(store, issueUid);
    expect(old?.isSuperseded).toBe(true);
    expect(await countLiveIssues(store)).toBe(2);
  });

  it('cites a file that exists only on an unmerged branch, via citation.revision (the working-tree read still refuses)', async () => {
    const repoDir = freshTmpDir('citation-revision-repo');
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ]);
    git(repoDir, ['checkout', '-b', 'feat']);
    const branchOnly = 'export const branchOnly = 1;\n';
    writeFileSync(join(repoDir, 'only-on-branch.ts'), branchOnly);
    git(repoDir, ['add', 'only-on-branch.ts']);
    git(repoDir, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'branch-only file',
    ]);
    // Back on main: the file is absent from the working tree but exists at `feat`.
    git(repoDir, ['checkout', 'main']);

    try {
      const project = await upsertProject(store, {
        name: 'citation-revision-project',
        path: repoDir,
        by: 'filer',
      });
      const issueUid = await createIssueWith2(project.uid, 'revision subject');

      // The working-tree read genuinely cannot see the branch-only file.
      await expect(
        addCitation(store, {
          uid: issueUid,
          citation: { file: 'only-on-branch.ts' },
          by: 'filer',
        })
      ).rejects.toThrow(CitationUnverifiableError);

      // Pinned to the branch, it resolves.
      const outcome = await addCitation(store, {
        uid: issueUid,
        citation: { file: 'only-on-branch.ts', revision: 'feat' },
        by: 'filer',
      });
      expect(outcome.citation.sha).toBe(sha256(branchOnly));
      expect(outcome.citation.revision).toBe('feat');

      const citationRow = await readNode(store, outcome.uid);
      expect(citationRow?.metadata?.['sha']).toBe(sha256(branchOnly));
      expect(citationRow?.metadata?.['revision']).toBe('feat');

      // And the REVISION surfaces through the read projection (card.ts ->
      // citationFromNode): the round-trip the unified contract guarantees.
      const cits = await readCitations(project.uid, issueUid);
      expect(cits[0]?.revision).toBe('feat');
      expect(cits[0]?.sha).toBe(sha256(branchOnly));
    } finally {
      removeTestIssueStoreDir(repoDir);
    }
  });

  /** Local createIssue helper for the revision test's own project. */
  async function createIssueWith2(
    project: string,
    title: string
  ): Promise<string> {
    const created = await createIssue(store, {
      project,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error('setup: createIssue did not create');
    }
    return created.uid;
  }
});
