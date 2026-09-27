/**
 * create-duplicate-gate.spec.ts — behavioral proof for `createIssue`'s
 * duplicate gate (SPEC.md §6.4, §8 AC-19) and its live-path sibling
 * criterion (§8 AC-2).
 *
 * **Real components throughout, except the embedding model.** Every store
 * here is genuine: a real `GraphBackend` (`@adhd/sox-graph-store`, via
 * `openTestIssueStore`), the real production embedding wiring
 * (`bootstrap.ts`'s `bootstrapSemanticStoreMembers`, the same function
 * `api.ts` calls for a live host), a real `@adhd/sox-vector-store` Turso
 * vector space, fused into a real, unmodified `StoreSearchBackend`
 * (`@adhd/sox-hybrid-search`) — and real issues written through the real
 * `createIssue` write verb — never a mock of the scan, the store, or
 * `createIssue` itself. Embeddings mocked here — explicit, scoped user
 * authorization (see entrypoint/backlog/STATE.md), covers embedding cost
 * only.
 *
 * **Why the fake preserves every assertion's teeth.** `create-issue.ts`'s
 * `scanForDuplicates` reads the vector channel's raw cosine
 * (`StoreSearchBackend.search`'s `vecScore`) against a project's
 * `dedupeThreshold` — but EVERY duplicate/near-duplicate case this suite
 * exercises re-files BYTE-IDENTICAL title/body text, so the exact model
 * used to embed it is irrelevant to whether it crosses the threshold: any
 * deterministic embedder maps identical text to an identical vector, whose
 * cosine similarity to itself is exactly 1.0 regardless of which model
 * produced it. No test in this file asserts a ranking or a similarity
 * SCORE between two genuinely DIFFERENT, non-identical texts. That
 * distinguishing-power proof — the duplicate gate CATCHING a paraphrase, and
 * NOT catching an unrelated item — belongs to the real-model suite
 * (`api.semantic-production-seam.spec.ts`), and cannot live here because the
 * fake has no notion of synonymy (see `test/helpers/fake-embedding-provider.ts`).
 * So a negative-control fake that collides every input onto
 * the same vector would not falsify any assertion here either, precisely
 * BECAUSE this file's assertions are equality-shaped (duplicate gate
 * outcome, write counts, audit rows), not ranking-shaped. What IS still
 * proven for real: the full production wiring path
 * (`bootstrapSemanticStoreMembers` → real Turso vector store →
 * `StoreSearchBackend` → `scanForDuplicates` → `createIssue`'s
 * abort/force/comment branches → real `node`/`edge` table writes).
 *
 * **The "writes nothing" proof has teeth.** `countIssueNodes`/`countAuditRows`
 * read the real `node`/`edge` tables directly (never trust the return value
 * alone) before and after every suppressed/commented call.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogConfig } from '../env.js';
import { bootstrapSemanticStoreMembers } from './bootstrap.js';
import { createFakeEmbeddingModule } from '../test/helpers/fake-embedding-provider.js';

// Embeddings mocked here — explicit, scoped user authorization (see
// entrypoint/backlog/STATE.md), covers embedding cost only. Intercepts the
// `import('@adhd/sox-embedding-provider')` specifier `bootstrap.ts`'s
// `loadOptional` seam resolves at runtime.
vi.mock('@adhd/sox-embedding-provider', () => createFakeEmbeddingModule());
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import {
  createIssue,
  type ICreateIssueResult,
  type IDuplicateScanHandle,
} from './create-issue.js';
import { InvalidArgumentError, IssueNotFoundError } from './errors.js';
import { relate } from './relate.js';
import type { IWriteStoreHandle } from './tx.js';

/** No cold ONNX model init anymore — the fake never touches disk/network — but the real Turso vector-store round-trip still needs headroom. */
const DUP_GATE_TIMEOUT = 30_000;

const EMBEDDING_CFG: BacklogConfig['embedding'] = {
  enabled: true,
  provider: 'fastembed',
  model: 'bge-base-en-v1.5',
};

/**
 * The real store, with `graph`/`search` derived through the exact same
 * `bootstrapSemanticStoreMembers` call a live host (`api.ts`) makes on every
 * verb invocation — a genuine `StoreSearchBackend` fused over a real,
 * resolved-model vector space, never an empty or hand-assembled stand-in.
 */
type DupGateHandle = TestIssueStore & IWriteStoreHandle & IDuplicateScanHandle;

async function openDupGateStore(
  dir: string
): Promise<{ handle: DupGateHandle; store: TestIssueStore }> {
  const store = await openTestIssueStore(join(dir, 'backlog.db'));
  const members = await bootstrapSemanticStoreMembers(
    store.adapter,
    store.graph,
    EMBEDDING_CFG
  );
  if (!members.search || !members.embedding) {
    // Fail LOUDLY with the concrete cause — never silently fall back to a degraded/empty scan.
    throw new Error(
      'create-duplicate-gate.spec: real embedding backend unavailable — bootstrapSemanticStoreMembers returned no search/embedding members. ' +
        'Check that @adhd/sox-embedding-provider and @adhd/sox-vector-store are installed and the fastembed model is reachable.'
    );
  }
  const handle: DupGateHandle = {
    ...store,
    graph: store.graph,
    search: members.search,
    embedding: members.embedding,
  };
  return { handle, store };
}

/**
 * Files one issue through the real write path, waiting for its embed/
 * vector-upsert round-trip (`awaitEmbed: true`) so later scans in the same
 * test see it in the real vector space.
 */
async function file(
  handle: DupGateHandle,
  projectUid: string,
  title: string,
  body: string,
  by: string,
  extra?: Partial<Parameters<typeof createIssue>[1]>
): Promise<ICreateIssueResult> {
  return createIssue(handle, {
    project: projectUid,
    title,
    body,
    by,
    awaitEmbed: true,
    ...extra,
  });
}

async function countIssueNodes(
  store: TestIssueStore,
  projectUid: string
): Promise<number> {
  // Every issue this suite creates is owned by exactly one project (via
  // component ownership) — scope the count to THIS test's project so a
  // leftover row from a previous suite/run can never inflate it.
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node n
     JOIN edge oc ON oc.dst = n.rowid AND oc.rel = 'owns_component' AND oc.t_invalid IS NULL
     JOIN edge op ON op.dst = oc.src AND op.rel = 'owns_project' AND op.t_invalid IS NULL
     JOIN node p ON p.rowid = op.src AND p.uid = ?
     WHERE n.kind = 'issue' AND n.t_invalid IS NULL`,
    [projectUid]
  );
  return rows[0]?.n ?? 0;
}

async function countAuditRows(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node WHERE kind = 'audit'`,
    []
  );
  return rows[0]?.n ?? 0;
}

async function countNoteNodes(store: TestIssueStore): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node WHERE kind = 'note' AND t_invalid IS NULL`,
    []
  );
  return rows[0]?.n ?? 0;
}

async function readNoteContent(
  store: TestIssueStore,
  uid: string
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const { rows } = await store.adapter.executeAll<{
    content: string;
    meta: string | null;
  }>(`SELECT content, meta FROM node WHERE uid = ?`, [uid]);
  const row = rows[0];
  if (!row) throw new Error(`readNoteContent: no node for uid ${uid}`);
  return {
    content: row.content,
    metadata: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {},
  };
}

/** The store-adapter `rowid` for a live uid — used to assert a fixture's liveness axes directly. */
async function rowidForUid(
  store: TestIssueStore,
  uid: string
): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ rowid: number }>(
    'SELECT rowid FROM node WHERE uid = ?',
    [uid]
  );
  const row = rows[0];
  if (!row) throw new Error(`rowidForUid: no node for uid ${uid}`);
  return row.rowid;
}

function assertCreated(
  result: ICreateIssueResult
): asserts result is ICreateIssueResult & {
  created: true;
  uid: string;
  item: NonNullable<ICreateIssueResult['item']>;
} {
  if (!result.created)
    throw new Error(`expected created:true, got ${JSON.stringify(result)}`);
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

describe('createIssue — duplicate gate (SPEC.md §6.4, §8 AC-19)', () => {
  it(
    'zero candidates: proceeds to a normal create with NO `duplicateCandidates` field at all, regardless of `duplicateAction`',
    async () => {
      const result = await file(
        handle,
        projectUid,
        'a wholly unique title, first of its kind',
        'a wholly unique body, sharing no tokens with anything else in this store',
        'filer'
      );
      assertCreated(result);
      expect(result.duplicateCandidates).toBeUndefined();
    },
    DUP_GATE_TIMEOUT
  );

  it(
    '`dedupeScanEnabled:false` skips the scan entirely — an exact re-file with the SAME title/body still creates, no `duplicateCandidates`',
    async () => {
      await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
        JSON.stringify({ policy: { dedupeScanEnabled: false } }),
        projectUid,
      ]);
      const title = 'scan disabled duplicate title';
      const body = 'scan disabled duplicate body';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);
      const second = await file(handle, projectUid, title, body, 'filer');
      assertCreated(second);
      expect(second.duplicateCandidates).toBeUndefined();
      expect(second.uid).not.toBe(first.uid);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'default (`abort`): an exact title/body re-file returns {created:false, reason:"duplicate-suppressed"} and WRITES NOTHING — no issue node, no audit row',
    async () => {
      const title = 'abort-path duplicate title, exact match';
      const body =
        'abort-path duplicate body, exact match, long enough to fts-match strongly';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);
      const auditsBefore = await countAuditRows(store);

      const second = await file(handle, projectUid, title, body, 'filer');

      expect(second.created).toBe(false);
      expect(second.reason).toBe('duplicate-suppressed');
      expect(second.duplicateCandidates).toBeDefined();
      expect(second.duplicateCandidates!.length).toBeGreaterThan(0);
      expect(second.duplicateCandidates![0].uid).toBe(first.uid);
      expect(second.uid).toBeUndefined();
      expect(second.item).toBeUndefined();

      const issuesAfter = await countIssueNodes(store, projectUid);
      const auditsAfter = await countAuditRows(store);
      expect(
        issuesAfter,
        'issue node count must be unchanged by a suppressed create'
      ).toBe(issuesBefore);
      expect(
        auditsAfter,
        'audit row count must be unchanged by a suppressed create'
      ).toBe(auditsBefore);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    '`force`: writes a genuinely NEW, distinct uid despite the match, and still reports `duplicateCandidates`',
    async () => {
      const title = 'force-path duplicate title, exact match';
      const body =
        'force-path duplicate body, exact match, long enough to fts-match strongly';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);

      const second = await file(handle, projectUid, title, body, 'filer', {
        duplicateAction: 'force',
      });

      assertCreated(second);
      expect(second.uid).not.toBe(first.uid);
      expect(second.duplicateCandidates).toBeDefined();
      expect(second.duplicateCandidates!.length).toBeGreaterThan(0);
      expect(second.duplicateCandidates![0].uid).toBe(first.uid);

      const issuesAfter = await countIssueNodes(store, projectUid);
      expect(issuesAfter).toBe(issuesBefore + 1);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    '`comment`: writes ZERO issue rows and attaches a `note` (has_note) to the top-scoring candidate, carrying the would-be title+body verbatim',
    async () => {
      const title = 'comment-path duplicate title, exact match';
      const body =
        'comment-path duplicate body, exact match, long enough to fts-match strongly';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);
      const notesBefore = await countNoteNodes(store);

      const secondBody =
        'comment-path duplicate body, exact match, long enough to fts-match strongly (refiled)';
      const second = await file(
        handle,
        projectUid,
        title,
        secondBody,
        'commenter',
        { duplicateAction: 'comment' }
      );

      expect(second.created).toBe(false);
      expect(second.uid).toBeUndefined();
      expect(second.item).toBeUndefined();
      expect(second.commentedOn).toBeDefined();
      expect(second.commentedOn!.uid).toBe(first.uid);
      expect(second.duplicateCandidates).toBeDefined();
      expect(second.duplicateCandidates![0].uid).toBe(first.uid);

      const issuesAfter = await countIssueNodes(store, projectUid);
      expect(issuesAfter, 'a comment must never write an issue row').toBe(
        issuesBefore
      );

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
        [first.uid, second.commentedOn!.noteId]
      );
      expect(edgeRows[0]?.n).toBe(1);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'an unrecognized `duplicateAction` throws `InvalidArgumentError` before any write runs',
    async () => {
      const issuesBefore = await countIssueNodes(store, projectUid);
      await expect(
        createIssue(handle, {
          project: projectUid,
          title: 'bad duplicateAction',
          body: 'body',
          by: 'filer',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately off-contract input, proving the runtime guard (not just the TS type) rejects it
          duplicateAction: 'bogus' as any,
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'a re-file is NOT suppressed by a SUPERSEDED original — non-live candidates are excluded (non-live over-match regression)',
    async () => {
      const title = 'non-live over-match superseded title, exact match';
      const body =
        'non-live over-match superseded body, exact match, long enough to fts-match strongly';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);

      // Put the original into the exact non-live-but-reachable state this
      // regression is about: `is_superseded` set (its content was edited) while
      // its `owns_component` edge and its vector both remain. A real
      // `updateIssue` body-change also invalidates the ownership edge and
      // schedules the old vector's deletion — but the scan must not TRUST that
      // a superseded row's vector is gone: the delete is fire-and-forget, and a
      // concurrent writer can supersede a row this process still holds a live
      // edge for. Marking the row superseded directly, leaving its vector in
      // place, is the faithful fixture.
      await store.adapter.executeRun(
        'UPDATE node SET is_superseded = 1 WHERE uid = ?',
        [first.uid]
      );

      // NEGATIVE CONTROL — the premise the fix must hold under. A superseded
      // row keeps `t_invalid IS NULL`, so a scan whose only liveness signal is
      // `getNodesByIds`'s default fetch (whose `liveOnly` omits only
      // `t_invalid` rows) STILL returns it, and would treat it as a candidate.
      // The fix that keeps it out is a PAIR, and the PAIR — not either half —
      // is the unit under test: `resolveSimilarFilterIds` (`semantic.ts`) now
      // applies the live filter on BOTH of its branches, so it never hands out
      // a superseded id, and `scanForDuplicates` (`create-issue.ts`) re-asserts
      // liveness per row. Each side independently drops this row, so reverting
      // either one ALONE stays GREEN; the `create-issue.ts` guard is the
      // defence-in-depth half (it survives a future `getNodesByIds` default
      // change), not the sole reason this test passes. Revert BOTH and the
      // re-file below is wrongly suppressed — the regression this test guards.
      const [supersededRow] = await store.graph.getNodesByIds([
        await rowidForUid(store, first.uid),
      ]);
      expect(
        supersededRow?.isSuperseded,
        'fixture must be a superseded row'
      ).toBe(true);
      expect(
        supersededRow?.tInvalid,
        'a superseded row keeps t_invalid NULL (so liveOnly alone does not drop it)'
      ).toBeUndefined();

      const issuesBefore = await countIssueNodes(store, projectUid);
      const second = await file(handle, projectUid, title, body, 'filer');

      assertCreated(second);
      expect(second.uid).not.toBe(first.uid);
      expect(second.duplicateCandidates).toBeUndefined();
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore + 1);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'scoping: an identical title/body in a DIFFERENT project is never a duplicate candidate',
    async () => {
      const other = await seedProject(store, 'dup-gate-other-project');
      const title = 'cross-project title, exact match';
      const body =
        'cross-project body, exact match, long enough to fts-match strongly';
      const first = await file(handle, projectUid, title, body, 'filer');
      assertCreated(first);

      const second = await file(handle, other.projectUid, title, body, 'filer');
      assertCreated(second);
      expect(second.duplicateCandidates).toBeUndefined();
    },
    DUP_GATE_TIMEOUT
  );
});

describe('createIssue — live-path identical-content, force produces distinct uids (SPEC.md §8 AC-2)', () => {
  it(
    'two createIssue calls with identical {title, body} in the same project, second with duplicateAction:"force", produce two distinct uids',
    async () => {
      const title = 'AC-2 identical title';
      const body = 'AC-2 identical body, byte for byte';
      const a = await file(handle, projectUid, title, body, 'filer');
      const b = await file(handle, projectUid, title, body, 'filer', {
        duplicateAction: 'force',
      });
      assertCreated(a);
      assertCreated(b);
      expect(a.uid).not.toBe(b.uid);
    },
    DUP_GATE_TIMEOUT
  );
});

/**
 * BUG 4e8fce2a — a DEGRADED candidate scan must never be silently treated as
 * "no candidates" when `duplicateAction:'abort'` was requested.
 *
 * The two degraded shapes are deliberately handled differently:
 *  - backend PRESENT but its calibrated channel dark (`no-vector-scores`) →
 *    `abort` fails CLOSED (nothing written, refusal surfaced);
 *  - backend wholly ABSENT (`no-search-backend`, the unconfigured install) →
 *    filing must not hard-fail, so it proceeds but CARRIES the
 *    `duplicateScanDegraded` signal.
 * Both are driven through the REAL `createIssue` path over a real store, and
 * the empty-store sibling proves the documented zero-candidate scan is
 * untouched.
 *
 * NEGATIVE CONTROL: neutering `scanForDuplicates`' `degraded` flag (the
 * pre-fix return of a bare candidate list) makes every `duplicateScanDegraded`
 * assertion here fail — proving these tests have teeth.
 */
describe('createIssue — degraded scan fails `abort` CLOSED (BUG 4e8fce2a)', () => {
  /** A handle that can WRITE and scope the scan but has no semantic backend at all — the `no-search-backend` degrade. */
  function withoutSearch(store: TestIssueStore): DupGateHandle {
    return { ...store, graph: store.graph } as DupGateHandle;
  }

  it(
    'genuinely empty store (no prior issues): a degraded backend still proceeds — the documented zero-candidate create is preserved',
    async () => {
      const noSearch = withoutSearch(store);
      const result = await createIssue(noSearch, {
        project: projectUid,
        title: 'first ever issue in a brand-new project',
        body: 'no prior issue exists to compare against, so this is a complete (empty) scan',
        by: 'filer',
      });
      assertCreated(result);
      // A complete scan of zero issues is NOT degraded — no marker at all.
      expect(result.duplicateScanDegraded).toBeUndefined();
      expect(result.duplicateScanDegradedReason).toBeUndefined();
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'no search backend (unconfigured) + prior issue exists: `abort` PROCEEDS (the documented unwired posture) but REPORTS the degradation — never silently',
    async () => {
      const noSearch = withoutSearch(store);
      const title = 'degraded-scan exact duplicate title';
      const body = 'degraded-scan exact duplicate body, byte for byte';

      const first = await createIssue(noSearch, {
        project: projectUid,
        title,
        body,
        by: 'filer',
      });
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);
      const second = await createIssue(noSearch, {
        project: projectUid,
        title,
        body,
        by: 'filer',
        // duplicateAction omitted → the default 'abort'.
      });

      // A wholly-unwired semantic backend must not hard-fail filing (§6.4
      // point 4 / `IDuplicateScanHandle`) — but the caller now LEARNS the scan
      // was blind instead of receiving an indistinguishable empty result.
      assertCreated(second);
      expect(second.duplicateScanDegraded).toBe(true);
      expect(second.duplicateScanDegradedReason).toBe('no-search-backend');
      expect(second.uid).not.toBe(first.uid);
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore + 1);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'no search backend + prior issue exists + `force`: proceeds (explicit write-anyway) but still REPORTS the degradation',
    async () => {
      const noSearch = withoutSearch(store);
      const title = 'degraded-scan force title';
      const body = 'degraded-scan force body, byte for byte';

      const first = await createIssue(noSearch, {
        project: projectUid,
        title,
        body,
        by: 'filer',
      });
      assertCreated(first);

      const second = await createIssue(noSearch, {
        project: projectUid,
        title,
        body,
        by: 'filer',
        duplicateAction: 'force',
      });
      assertCreated(second);
      expect(second.duplicateScanDegraded).toBe(true);
      expect(second.duplicateScanDegradedReason).toBe('no-search-backend');
      expect(await countIssueNodes(store, projectUid)).toBe(2);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'search backend mounted but the vector space is EMPTY: `abort` PROCEEDS (indistinguishable from on-write embedding lag) but REPORTS `no-vector-scores` — never silently',
    async () => {
      // `handle` (openDupGateStore) carries a real search+embedQuery over a
      // real Turso vector space. `handle.embedding` exists too, so an
      // `awaitEmbed` create would populate the space — deliberately DON'T use
      // it for the prior issue, leaving the space empty while an issue with a
      // live `owns_component` edge exists. That is the production incident's
      // shape: the gate can scope the project but the vector channel is dark.
      const noEmbed: DupGateHandle = {
        ...store,
        graph: store.graph,
        search: handle.search,
      } as DupGateHandle;
      const title = 'empty-vector-space exact duplicate title';
      const body = 'empty-vector-space exact duplicate body, byte for byte';

      const first = await createIssue(noEmbed, {
        project: projectUid,
        title,
        body,
        by: 'filer',
      });
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);
      // The vector space is empty because `noEmbed` skipped the on-write
      // embed — exactly the shape a RAPID second create sees while the
      // first's fire-and-forget embed is still in flight. That is
      // indistinguishable from benign embedding lag, so `abort` must NOT
      // refuse: the create proceeds and carries the degradation signal.
      // `awaitEmbed:true` here just drains the round-trip deterministically
      // (the scan runs BEFORE the write, so the space is still empty at scan
      // time and `no-vector-scores` still fires).
      const second = await createIssue(handle, {
        project: projectUid,
        title,
        body,
        by: 'filer',
        awaitEmbed: true,
        // default 'abort'
      });

      assertCreated(second);
      expect(second.uid).toBeDefined();
      expect(second.duplicateScanDegraded).toBe(true);
      expect(second.duplicateScanDegradedReason).toBe('no-vector-scores');
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore + 1);
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'search backend mounted but WITHOUT `embedQuery` (the calibrated channel can never run): `abort` FAILS CLOSED with `no-embed-query`',
    async () => {
      // A persistent CONFIGURATION absence — unlike the empty-vector-space
      // case above, this can never resolve on its own: the backend is present
      // but wired with no embedding model, so no calibrated comparison is
      // possible. `abort` must refuse rather than write a duplicate it could
      // not detect.
      const noEmbedQuery: DupGateHandle = {
        ...store,
        graph: store.graph,
        search: { backend: handle.search!.backend },
      } as DupGateHandle;
      const title = 'no-embed-query exact duplicate title';
      const body = 'no-embed-query exact duplicate body, byte for byte';

      const first = await createIssue(noEmbedQuery, {
        project: projectUid,
        title,
        body,
        by: 'filer',
      });
      assertCreated(first);

      const issuesBefore = await countIssueNodes(store, projectUid);
      const second = await createIssue(noEmbedQuery, {
        project: projectUid,
        title,
        body,
        by: 'filer',
        // default 'abort'
      });

      expect(second.created).toBe(false);
      expect(second.reason).toBe('duplicate-scan-degraded');
      expect(second.duplicateScanDegraded).toBe(true);
      expect(second.duplicateScanDegradedReason).toBe('no-embed-query');
      expect(second.uid).toBeUndefined();
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore);
    },
    DUP_GATE_TIMEOUT
  );
});

/**
 * Defect c5460239 — a child filed under a declared parent must not be
 * suppressed as a duplicate OF that parent. `ICreateIssueInput.dedupeExcludeUid` is a
 * read-side dedupe-scoping declaration only (it never writes a `part_of`
 * edge); the scan excludes the declared parent AND its `part_of` ancestor
 * chain from the candidate set.
 *
 * **The writer's negative control.** The whole point is that the exclusion is
 * what changes the outcome: the SAME byte-identical child text the parent
 * carries is SUPPRESSED with `dedupeExcludeUid` omitted, and CREATED with `dedupeExcludeUid`
 * naming the parent. Removing `resolveDedupeExcludeIds` from the scan (or
 * its call site) turns the `dedupeExcludeUid`-create assertions RED while leaving the
 * no-`dedupeExcludeUid` suppression green — which is why both are asserted here, in one
 * test, against the real store and the real scan.
 */
describe('createIssue — declared parent + ancestry excluded from the dedupe scan (c5460239)', () => {
  it(
    'a child restating its declared parent WITH `dedupeExcludeUid` creates; the SAME text WITHOUT `dedupeExcludeUid` is suppressed (the exclusion is what changed)',
    async () => {
      const title = 'parent intent, restated verbatim by its child';
      const body =
        'the exact parent body the child deliberately restates, long enough to fts-match strongly';
      const parent = await file(handle, projectUid, title, body, 'filer');
      assertCreated(parent);

      // WITHOUT `dedupeExcludeUid`: a genuine duplicate of the parent (cosine 1.0) — the
      // pre-fix behavior, and the premise the fix must beat.
      const suppressed = await file(handle, projectUid, title, body, 'filer');
      expect(suppressed.created).toBe(false);
      expect(suppressed.reason).toBe('duplicate-suppressed');
      expect(suppressed.duplicateCandidates?.[0]?.uid).toBe(parent.uid);
      const issuesAfterSuppression = await countIssueNodes(store, projectUid);

      // WITH `dedupeExcludeUid` = the parent: the parent is excluded from the candidate
      // set, so the child creates — and no `duplicateCandidates` are reported
      // (the project had no other issue to compare against).
      const child = await file(handle, projectUid, title, body, 'filer', {
        dedupeExcludeUid: parent.uid,
      });
      assertCreated(child);
      expect(child.uid).not.toBe(parent.uid);
      expect(child.duplicateCandidates).toBeUndefined();
      expect(await countIssueNodes(store, projectUid)).toBe(
        issuesAfterSuppression + 1
      );
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'the WHOLE `part_of` ancestor chain is excluded — a child restating its GRANDPARENT still creates',
    async () => {
      const gTitle = 'grandparent intent, restated by a grandchild';
      const gBody =
        'grandparent body the grandchild restates, long enough to fts-match strongly';
      const grandparent = await file(
        handle,
        projectUid,
        gTitle,
        gBody,
        'filer'
      );
      assertCreated(grandparent);

      // The parent carries DISTINCT text (so it is not itself a duplicate of
      // the grandparent) and is linked to it by a real `part_of` edge —
      // written by `relate`, never by `createIssue` (see the `dedupeExcludeUid` field's
      // own doc comment).
      const parent = await file(
        handle,
        projectUid,
        'parent intent, distinct from the grandparent',
        'parent body, distinct from the grandparent, long enough to fts-match strongly',
        'filer',
        { dedupeExcludeUid: grandparent.uid }
      );
      assertCreated(parent);
      const linked = await relate(handle, {
        sourceUid: parent.uid,
        targetUid: grandparent.uid,
        rel: 'part_of',
        action: 'add',
        by: 'filer',
      });
      expect(linked.noop).toBe(false);

      // The child restates its GRANDPARENT — reached only by walking the
      // parent's own `part_of` chain, never by the single-hop parent
      // exclusion. With the chain excluded the child creates; drop the
      // ancestor walk and the grandparent (cosine 1.0) suppresses it.
      const child = await file(handle, projectUid, gTitle, gBody, 'filer', {
        dedupeExcludeUid: parent.uid,
      });
      assertCreated(child);
      expect(child.duplicateCandidates).toBeUndefined();
    },
    DUP_GATE_TIMEOUT
  );

  it(
    'a `dedupeExcludeUid` that does not resolve to a live issue throws IssueNotFoundError and writes nothing — fail loud, never silently ignored',
    async () => {
      const issuesBefore = await countIssueNodes(store, projectUid);
      await expect(
        createIssue(handle, {
          project: projectUid,
          title: 'child of a parent that does not exist',
          body: 'body',
          by: 'filer',
          dedupeExcludeUid: randomUUID(),
        })
      ).rejects.toBeInstanceOf(IssueNotFoundError);
      expect(await countIssueNodes(store, projectUid)).toBe(issuesBefore);
    },
    DUP_GATE_TIMEOUT
  );
});
