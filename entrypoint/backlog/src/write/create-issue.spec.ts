/**
 * create-issue.spec.ts — `createIssue`'s no-`component` default (SPEC.md §8
 * AC-23; the verb itself lives at `write/create-issue.ts`, §4/§6.3.2).
 *
 * AC-23's literal text: omitting `component` entirely resolves to `project`'s
 * reserved default component `(root)` — already guaranteed live by
 * `upsertProject` — and never throws `CatalogNotFoundError('component', ...)`.
 * The point with teeth: the fallback is a RESOLVE of an already-guaranteed
 * row, never a per-call mint, so two independent no-`component` `createIssue`
 * calls against the SAME project land on the exact same `(root)` component
 * row, never a second one.
 *
 * Every assertion here drives the REAL verbs (`upsertProject`, `createIssue`,
 * `queryIssues`) against a REAL store opened via `openTestIssueStore` — never
 * a mock of any verb, never a mock of the store. The `owns_component` edge
 * and the `(root)` row count are read back via direct SQL, never trusted from
 * either verb's own returned outcome object (mirrors `move.spec.ts`'s
 * `countLiveOwnsComponentEdges` discipline for the same edge kind).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestIssueStore, removeTestIssueStoreDir, type TestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { upsertProject } from './catalog.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';
import { queryIssues } from '../query/query.js';

async function readNode(store: TestIssueStore, uid: string): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

/** Direct SQL: the rowid of the LIVE `owns_component` edge's source (the component) targeting `issueRowid` — never the outcome object, which is a self-report. Throws if the invariant "exactly one" is violated, so a caller never silently reads a wrong/ambiguous row. */
async function ownsComponentSrcRowid(store: TestIssueStore, issueRowid: number): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ src: number }>(
    `SELECT src FROM edge WHERE dst = ? AND rel = 'owns_component' AND t_invalid IS NULL`,
    [issueRowid],
  );
  if (rows.length !== 1) throw new Error(`expected exactly one live owns_component edge for issue rowid ${issueRowid}, found ${rows.length}`);
  return rows[0]!.src;
}

/** Direct SQL count of LIVE `(root)` component rows scoped to `projectUid` — proves the fallback never mints a second row, never just "the outcome says one uid" (which a per-call-mint bug could still self-report consistently if it always returned the newest uid). */
async function countLiveRootComponents(store: TestIssueStore, projectUid: string): Promise<number> {
  const { rows } = await store.adapter.executeAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM node
     WHERE kind = 'component' AND name = '(root)' AND t_invalid IS NULL
       AND json_extract(meta, '$.projectUid') = ?`,
    [projectUid],
  );
  return rows[0]?.n ?? 0;
}

describe('createIssue — component-omitted defaults to (root), never orphaned (SPEC.md §8 AC-23)', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('create-issue-root-default-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it(
    'two independent no-component createIssue calls resolve the SAME (root) target, exactly one (root) row ever exists, never throw CatalogNotFoundError, and both issues are reachable through filter.project — never orphaned',
    async () => {
      // (1) upsertProject a fresh project — the REAL registry verb, not the
      // hand-composed seedProject test helper, per AC-23's own wording.
      const project = await upsertProject(store, { name: 'ac23-root-default-project', by: 'filer' });
      expect(project.created).toBe(true);

      // Exactly one (root) row exists the moment the project is minted —
      // this is the "already-guaranteed row" AC-23's fallback is defined to
      // resolve, never mint.
      expect(await countLiveRootComponents(store, project.uid)).toBe(1);

      // (2) Two SEPARATE createIssue calls, `component` omitted entirely on
      // both — distinct title/body per call so neither the duplicate-gate
      // (§6.4, default duplicateAction:'abort') nor content-hash dedupe can
      // suppress either write for an unrelated reason.
      const first = await createIssue(store, {
        project: project.uid,
        title: 'ac23 first no-component issue',
        body: 'first issue filed with component omitted entirely',
        by: 'filer',
      });
      const second = await createIssue(store, {
        project: project.uid,
        title: 'ac23 second no-component issue',
        body: 'second issue filed with component omitted entirely',
        by: 'filer',
      });

      // (6) Never throws CatalogNotFoundError('component', ...) on the
      // omitted-component path — both calls above already had to complete
      // without throwing for this line to be reached at all; asserted
      // explicitly here as the criterion's own stated invariant.
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(first.uid).toBeTruthy();
      expect(second.uid).toBeTruthy();
      expect(first.uid).not.toBe(second.uid);

      const firstIssueRow = await readNode(store, first.uid);
      const secondIssueRow = await readNode(store, second.uid);
      expect(firstIssueRow).not.toBeNull();
      expect(secondIssueRow).not.toBeNull();

      // (3) Both calls resolve the SAME owns_component target uid — the
      // criterion's own named verification method (direct SQL against the
      // edge table), never the outcome object.
      const firstComponentRowid = await ownsComponentSrcRowid(store, firstIssueRow!.rowid);
      const secondComponentRowid = await ownsComponentSrcRowid(store, secondIssueRow!.rowid);
      expect(secondComponentRowid).toBe(firstComponentRowid);

      // That shared rowid IS the project's (root) component, by uid — not
      // merely "the same rowid as each other" but the SAME row minted at
      // upsertProject time.
      const { rows: componentRows } = await store.adapter.executeAll<{ uid: string; name: string | null }>(
        `SELECT uid, name FROM node WHERE rowid = ? AND t_invalid IS NULL`,
        [firstComponentRowid],
      );
      expect(componentRows).toHaveLength(1);
      expect(componentRows[0]!.name).toBe('(root)');

      // (4) Exactly ONE live (root) component row exists for the project
      // throughout — proves the fallback is a RESOLVE, never a per-call
      // mint. If either createIssue call had minted its own (root) row
      // (even one that happened to share a uid by coincidence — impossible,
      // but the point is this check does not rely on uid equality alone),
      // this count would be 2, not 1.
      expect(await countLiveRootComponents(store, project.uid)).toBe(1);

      // (5) A subsequent query({filter:{project}}) returns BOTH new uids —
      // proving the issues are reachable through the project filter rather
      // than orphaned, never merely "createIssue's own outcome object claims
      // success."
      const result = await queryIssues(store, { filter: { project: project.uid }, limit: 100 });
      if (result.view !== 'list') throw new Error(`expected view:'list', got ${result.view}`);
      const uids = result.items.map((item) => item.uid);
      expect(uids).toContain(first.uid);
      expect(uids).toContain(second.uid);
    },
  );
});
