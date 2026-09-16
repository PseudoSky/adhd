/**
 * get.spec.ts — the `get` verb's default-fields contract (SPEC.md AC-13,
 * §6.3.1).
 *
 * `getIssue` has never had a dedicated spec: every existing call site
 * (`write/update.spec.ts`) passes an explicit `fields` array, so three
 * load-bearing claims about `src/query/get.ts` have zero test coverage:
 *
 *  - Calling `getIssue` with NO `fields` at all returns exactly the
 *    five-field card `DEFAULT_ISSUE_CARD_FIELDS` (`src/query/types.ts:76`) —
 *    `{uid, kind, title, status, priority}` — and nothing more (no `body`,
 *    no `project`, no stray keys).
 *  - The pseudo-field `'body'` resolves to `issue.content` via
 *    `card.ts`'s `if (want('body')) card.body = issue.content;`.
 *  - An unresolvable `uid` throws `IssueNotFoundError`, never returns a
 *    partial/undefined card.
 *
 * Real components throughout: a real store opened via
 * `openTestIssueStore`/`seedProject`, real `createIssue` writes, `getIssue`
 * called exactly as `api.ts`'s mounted `get` verb calls it
 * (`getIssue(store.graph, input)`, confirmed by reading `src/api.ts:215`).
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
import { createIssue } from '../write/create-issue.js';
import { IssueNotFoundError } from '../write/errors.js';
import { getIssue } from './get.js';
import { DEFAULT_ISSUE_CARD_FIELDS } from './types.js';

describe("the `get` verb — no-`fields` default and pseudo-field projection (real store)", () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('get-defaults');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'get-defaults-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('with no `fields`, returns exactly the five-field card {uid, kind, title, status, priority} and nothing more', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'a plain issue',
      body: 'the body text, which must NOT appear in the default card',
      by: 'filer',
      // priority is genuinely optional on createIssue (create-issue.ts:61) — an
      // omitted priority mints no `has_priority` edge at all, so the card would
      // never populate the `priority` key regardless of the default-fields
      // behavior under test. Set it explicitly so this test proves what it
      // claims: that the DEFAULT FIELD SET includes `priority`, not merely that
      // an unset priority happens to also be absent.
      priority: 'p1',
    });

    const card = await getIssue(store.graph, { uid: created.uid });

    // Positive half: every DEFAULT_ISSUE_CARD_FIELDS key is present and correct.
    expect(card.uid).toBe(created.uid);
    expect(card.kind).toBe('issue');
    expect(card.title).toBe('a plain issue');
    expect(typeof card.status).toBe('string');
    expect(typeof card.priority).toBe('string');

    // Negative half, with teeth: the returned key set is EXACTLY the five
    // default fields — no `body`, no `project`, no `component`, no
    // `createdAt`, nothing pseudo-field-shaped leaking through because a
    // future change widened the default projection.
    expect(new Set(Object.keys(card))).toEqual(new Set(DEFAULT_ISSUE_CARD_FIELDS));
    expect(card.body).toBeUndefined();
    expect(card.project).toBeUndefined();
    expect(card.component).toBeUndefined();
    expect(card.createdAt).toBeUndefined();
  });

  it("requesting the pseudo-field 'body' yields card.body === issue.content", async () => {
    const bodyText = 'the exact persisted content, checked verbatim';
    const created = await createIssue(store, {
      project: projectUid,
      title: 'an issue with a body',
      body: bodyText,
      by: 'filer',
    });

    const card = await getIssue(store.graph, { uid: created.uid, fields: ['uid', 'body'] });

    expect(card.body).toBe(bodyText);

    // Cross-check against the raw persisted node directly, never trusting
    // the card alone: `card.body` must equal `issue.content` verbatim
    // (card.ts:228's own contract), not a derived/truncated projection.
    const raw = await store.graph.getNodeByUid(created.uid);
    expect(raw).not.toBeNull();
    expect(card.body).toBe(raw!.content);
  });

  it('an unresolvable uid throws IssueNotFoundError, not a partial/undefined card', async () => {
    await expect(getIssue(store.graph, { uid: 'issue-does-not-exist-anywhere' })).rejects.toBeInstanceOf(
      IssueNotFoundError,
    );
  });

  it('an unresolvable uid throws IssueNotFoundError even when fields are explicitly requested', async () => {
    await expect(
      getIssue(store.graph, { uid: 'issue-does-not-exist-anywhere', fields: ['uid', 'body'] }),
    ).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  it('a soft-deleted (invalidated) uid is treated as unresolvable — IssueNotFoundError, not the stale card', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'will be deleted',
      body: 'irrelevant',
      by: 'filer',
    });
    const { deleteIssue } = await import('../write/delete.js');
    await deleteIssue(store, { uid: created.uid, by: 'filer', reason: 'no longer needed' });

    await expect(getIssue(store.graph, { uid: created.uid })).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});
