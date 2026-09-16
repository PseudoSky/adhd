/**
 * create-duplicate-gate.spec.ts — behavioral proof for `createIssue`'s
 * duplicate gate (SPEC.md §6.4, §9 AC-19) and its live-path sibling
 * criterion (§9 AC-2).
 *
 * **Real components, one intentionally-empty seam.** Every store here is
 * genuine: a real `GraphBackend` (`@adhd/sox-graph-store`, via
 * `openTestIssueStore`), a real `TursoVectorBackend`
 * (`@adhd/sox-vector-store`) wired into a real, unmodified
 * `StoreSearchBackend` (`@adhd/sox-hybrid-search`), and real issues written
 * through the real `createIssue` write verb — never a mock of the scan, the
 * store, or `createIssue` itself. The vector backend is real but
 * deliberately left EMPTY (no vectors ever indexed, no `embedQuery`
 * supplied on the test handle's `search`): SPEC.md §6.4 point 1 scopes the
 * scan to `{title, body}` FTS+vec fusion, and `scanForDuplicates`'s own
 * degraded-mode branch (§6.4 point 4, "searchRanked unavailable... degrades
 * to FTS-only") is exactly what fires when no `embedQuery` is configured —
 * so exercising these tests through the TEXT channel alone is exercising a
 * real, spec'd code path, not a shortcut around one. (`semantic.spec.ts`
 * exercises the vec channel; that machinery is proven there, not
 * re-proven here.)
 *
 * **The "writes nothing" proof has teeth.** `countIssueNodes`/`countAuditRows`
 * read the real `node`/`edge` tables directly (never trust the return value
 * alone) before and after every suppressed/commented call.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTursoVectorStore, type TursoVectorBackend } from '@adhd/sox-vector-store';
import { StoreSearchBackend } from '@adhd/sox-hybrid-search';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue, type ICreateIssueResult, type IDuplicateScanHandle } from './create-issue.js';
import { InvalidArgumentError } from './errors.js';

/** The real store PLUS a real (empty) `StoreSearchBackend` — no `embedQuery`, so every scan here runs the §6.4 point 4 degraded (text-only) path. */
type DupGateHandle = TestIssueStore & IDuplicateScanHandle;

async function openDupGateStore(dir: string): Promise<{ handle: DupGateHandle; store: TestIssueStore; vec: TursoVectorBackend }> {
  const store = await openTestIssueStore(join(dir, 'backlog.db'));
  const vec = await openTursoVectorStore(store.adapter, { dim: 3, modelId: 'dedupe-gate-spec-test-model' });
  const handle: DupGateHandle = {
    ...store,
    search: { backend: new StoreSearchBackend(vec, store.graph) },
  };
  return { handle, store, vec };
}

async function countIssueNodes(store: TestIssueStore, projectUid: string): Promise<number> {
  // Every issue this suite creates is owned by exactly one project (via
  // component ownership) — scope the count to THIS test's project so a
  // leftover row from a previous suite/run can never inflate it.
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node n
     JOIN edge oc ON oc.dst = n.rowid AND oc.rel = 'owns_component' AND oc.t_invalid IS NULL
     JOIN edge op ON op.dst = oc.src AND op.rel = 'owns_project' AND op.t_invalid IS NULL
     JOIN node p ON p.rowid = op.src AND p.uid = ?
     WHERE n.kind = 'issue' AND n.t_invalid IS NULL`,
    [projectUid],
  );
  return rows[0]?.n ?? 0;
}

async function countAuditRows(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node WHERE kind = 'audit'`,
    [],
  );
  return rows[0]?.n ?? 0;
}

async function countNoteNodes(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node WHERE kind = 'note' AND t_invalid IS NULL`,
    [],
  );
  return rows[0]?.n ?? 0;
}

async function readNoteContent(store: TestIssueStore, uid: string): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { rows } = await store.adapter.executeAll<{ content: string; meta: string | null }>(
    `SELECT content, meta FROM node WHERE uid = ?`,
    [uid],
  );
  const row = rows[0];
  if (!row) throw new Error(`readNoteContent: no node for uid ${uid}`);
  return { content: row.content, metadata: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {} };
}

function assertCreated(result: ICreateIssueResult): asserts result is ICreateIssueResult & { created: true; uid: string; item: NonNullable<ICreateIssueResult['item']> } {
  if (!result.created) throw new Error(`expected created:true, got ${JSON.stringify(result)}`);
}

let dir: string;
let store: TestIssueStore;
let handle: DupGateHandle;
let projectUid: string;

beforeEach(async () => {
  dir = freshTmpDir('create-duplicate-gate-spec');
  const opened = await openDupGateStore(dir);
  handle = opened.handle;
  store = opened.store;
  const seeded = await seedProject(store, 'dup-gate-spec-project');
  projectUid = seeded.projectUid;
});

afterEach(async () => {
  await store.close();
  removeTestIssueStoreDir(dir);
});

describe('createIssue — duplicate gate (SPEC.md §6.4, §9 AC-19)', () => {
  it('zero candidates: proceeds to a normal create with NO `duplicateCandidates` field at all, regardless of `duplicateAction`', async () => {
    const result = await createIssue(handle, {
      project: projectUid,
      title: 'a wholly unique title, first of its kind',
      body: 'a wholly unique body, sharing no tokens with anything else in this store',
      by: 'filer',
    });
    assertCreated(result);
    expect(result.duplicateCandidates).toBeUndefined();
  });

  it('`dedupeScanEnabled:false` skips the scan entirely — an exact re-file with the SAME title/body still creates, no `duplicateCandidates`', async () => {
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ policy: { dedupeScanEnabled: false } }),
      projectUid,
    ]);
    const title = 'scan disabled duplicate title';
    const body = 'scan disabled duplicate body';
    const first = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(first);
    const second = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(second);
    expect(second.duplicateCandidates).toBeUndefined();
    expect(second.uid).not.toBe(first.uid);
  });

  it('default (`abort`): an exact title/body re-file returns {created:false, reason:"duplicate-suppressed"} and WRITES NOTHING — no issue node, no audit row', async () => {
    const title = 'abort-path duplicate title, exact match';
    const body = 'abort-path duplicate body, exact match, long enough to fts-match strongly';
    const first = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(first);

    const issuesBefore = await countIssueNodes(store, projectUid);
    const auditsBefore = await countAuditRows(store);

    const second = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });

    expect(second.created).toBe(false);
    expect(second.reason).toBe('duplicate-suppressed');
    expect(second.duplicateCandidates).toBeDefined();
    expect(second.duplicateCandidates!.length).toBeGreaterThan(0);
    expect(second.duplicateCandidates![0].uid).toBe(first.uid);
    expect(second.uid).toBeUndefined();
    expect(second.item).toBeUndefined();

    const issuesAfter = await countIssueNodes(store, projectUid);
    const auditsAfter = await countAuditRows(store);
    expect(issuesAfter, 'issue node count must be unchanged by a suppressed create').toBe(issuesBefore);
    expect(auditsAfter, 'audit row count must be unchanged by a suppressed create').toBe(auditsBefore);
  });

  it('`force`: writes a genuinely NEW, distinct uid despite the match, and still reports `duplicateCandidates`', async () => {
    const title = 'force-path duplicate title, exact match';
    const body = 'force-path duplicate body, exact match, long enough to fts-match strongly';
    const first = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(first);

    const issuesBefore = await countIssueNodes(store, projectUid);

    const second = await createIssue(handle, { project: projectUid, title, body, by: 'filer', duplicateAction: 'force' });

    assertCreated(second);
    expect(second.uid).not.toBe(first.uid);
    expect(second.duplicateCandidates).toBeDefined();
    expect(second.duplicateCandidates!.length).toBeGreaterThan(0);
    expect(second.duplicateCandidates![0].uid).toBe(first.uid);

    const issuesAfter = await countIssueNodes(store, projectUid);
    expect(issuesAfter).toBe(issuesBefore + 1);
  });

  it('`comment`: writes ZERO issue rows and attaches a `note` (has_note) to the top-scoring candidate, carrying the would-be title+body verbatim', async () => {
    const title = 'comment-path duplicate title, exact match';
    const body = 'comment-path duplicate body, exact match, long enough to fts-match strongly';
    const first = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(first);

    const issuesBefore = await countIssueNodes(store, projectUid);
    const notesBefore = await countNoteNodes(store);

    const secondBody = 'comment-path duplicate body, exact match, long enough to fts-match strongly (refiled)';
    const second = await createIssue(handle, {
      project: projectUid, title, body: secondBody, by: 'commenter', duplicateAction: 'comment',
    });

    expect(second.created).toBe(false);
    expect(second.uid).toBeUndefined();
    expect(second.item).toBeUndefined();
    expect(second.commentedOn).toBeDefined();
    expect(second.commentedOn!.uid).toBe(first.uid);
    expect(second.duplicateCandidates).toBeDefined();
    expect(second.duplicateCandidates![0].uid).toBe(first.uid);

    const issuesAfter = await countIssueNodes(store, projectUid);
    expect(issuesAfter, 'a comment must never write an issue row').toBe(issuesBefore);

    const notesAfter = await countNoteNodes(store);
    expect(notesAfter).toBe(notesBefore + 1);

    const note = await readNoteContent(store, second.commentedOn!.noteId);
    expect(note.content).toContain(title);
    expect(note.content).toContain(secondBody);
    expect(note.metadata.author).toBe('commenter');

    const { rows: edgeRows } = await store.adapter.executeAll<{ n: number }>(
      `SELECT COUNT(*) as n FROM edge e
       JOIN node src ON src.rowid = e.src AND src.uid = ?
       JOIN node dst ON dst.rowid = e.dst AND dst.uid = ?
       WHERE e.rel = 'has_note' AND e.t_invalid IS NULL`,
      [first.uid, second.commentedOn!.noteId],
    );
    expect(edgeRows[0]?.n).toBe(1);
  });

  it('an unrecognized `duplicateAction` throws `InvalidArgumentError` before any write runs', async () => {
    const issuesBefore = await countIssueNodes(store, projectUid);
    await expect(
      createIssue(handle, {
        project: projectUid,
        title: 'bad duplicateAction',
        body: 'body',
        by: 'filer',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately off-contract input, proving the runtime guard (not just the TS type) rejects it
        duplicateAction: 'bogus' as any,
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore);
  });

  it('scoping: an identical title/body in a DIFFERENT project is never a duplicate candidate', async () => {
    const other = await seedProject(store, 'dup-gate-other-project');
    const title = 'cross-project title, exact match';
    const body = 'cross-project body, exact match, long enough to fts-match strongly';
    const first = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    assertCreated(first);

    const second = await createIssue(handle, { project: other.projectUid, title, body, by: 'filer' });
    assertCreated(second);
    expect(second.duplicateCandidates).toBeUndefined();
  });
});

describe('createIssue — live-path identical-content, force produces distinct uids (SPEC.md §9 AC-2)', () => {
  it('two createIssue calls with identical {title, body} in the same project, second with duplicateAction:"force", produce two distinct uids', async () => {
    const title = 'AC-2 identical title';
    const body = 'AC-2 identical body, byte for byte';
    const a = await createIssue(handle, { project: projectUid, title, body, by: 'filer' });
    const b = await createIssue(handle, { project: projectUid, title, body, by: 'filer', duplicateAction: 'force' });
    assertCreated(a);
    assertCreated(b);
    expect(a.uid).not.toBe(b.uid);
  });
});
