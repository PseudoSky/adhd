/**
 * spec-revision.root-replace.spec.ts — backlog item f612389c: a `replace` on an
 * item with no spec revision (a root replace) is refused as invalid_argument
 * and writes nothing; an `amend` root is unchanged. Real store, real verbs.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { upsertProject } from './catalog.js';
import { appendSpecRevision, readSpecPointer } from './spec-revision.js';
import { InvalidArgumentError } from './errors.js';
import { getNodeByUidTx } from './tx.js';

describe('root replace (f612389c)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('spec-revision-root-replace');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await upsertProject(store, { name: 'rr-project', by: 'filer' })).uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function issue(title: string): Promise<string> {
    const created = await createIssue(store, { project: projectUid, title, body: `${title} body`, by: 'filer' });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue suppressed: ${JSON.stringify(created)}`);
    }
    return created.uid;
  }

  const specCount = async (): Promise<number> =>
    (await store.graph.queryNodes({ kind: 'SPEC', liveOnly: true })).length;

  it('f612389c AC1 — a replace on an item with no spec revision is invalid_argument and writes nothing', async () => {
    const uid = await issue('root-replace');
    const before = await specCount();
    const err = await appendSpecRevision(store, {
      uid, fragment: 'doc\n', base_revision: '', mode: 'replace', by: 'a:1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidArgumentError);
    expect((err as InvalidArgumentError).message).toMatch(/replace/);
    expect(await specCount()).toBe(before);
    expect(await readSpecPointer(store.graph, uid)).toBeUndefined();
  });

  it('f612389c AC2 — an amend on an item with no spec revision still creates the root revision: golden token, no mode key', async () => {
    const uid = await issue('root-amend');
    for (const mode of [undefined, 'amend' as const]) {
      const u = mode ? await issue('root-amend-explicit') : uid;
      const r = await appendSpecRevision(store, {
        uid: u, fragment: 'ALPHA', base_revision: '', ...(mode ? { mode } : {}), by: 'a:1',
      });
      expect(r.revision_seq).toBe(1);
      // golden: sha256("ALPHA")
      expect(r.spec_revision_token).toBe(
        'sha256:73ab66a033c267e00b7429bb256f6deb2734ebc4cd4ff5b564a8c9f9b2c8a719'
      );
      const n = await store.adapter.transaction((tx) => getNodeByUidTx(tx, r.spec_revision));
      expect(Object.keys(n!.metadata ?? {}).sort()).toEqual(
        ['anchor', 'appended_at', 'appended_by', 'prev_revision', 'revision_seq', 'revision_token', 'spec_of'].sort()
      );
      expect(n!.content).toBe('ALPHA');
    }
  });
});
