/**
 * get-superseded-uid.spec.ts — the READ path's half of the stale-uid contract.
 *
 * ## The gap this closes
 *
 * `superseded-uid-guard.spec.ts` pins the WRITE half: all six write verbs
 * reject a superseded uid through the shared `resolveLiveIssueTx`. The read
 * path had no such guard — `resolveIssueByUid` checked only `kind` and
 * `tInvalid`, and a superseded row is deliberately left `t_invalid IS NULL`.
 * So `get` on a stale uid returned the frozen PRE-EDIT card, with no signal
 * that the body had been edited or that the issue had moved. A caller acting
 * on a citation written before someone's edit would read stale content and
 * have no way to know.
 *
 * Read and write now agree: a uid that was valid once and names a real row is
 * `StaleSupersedeError` ("your reference is stale"), never
 * `IssueNotFoundError` ("your reference is wrong").
 *
 * ## Why the successor uid is part of the contract
 *
 * A body edit mints a NEW uid, so "re-get and retry" — the write path's
 * advice, where the caller lost a race but the uid is still current — is
 * useless here: re-getting the same uid fails identically, forever. The error
 * therefore carries the uid the issue lives under NOW, and for a chain of
 * edits that is the CURRENT head, not the next hop. That is what makes a
 * broken citation actionable rather than merely detected.
 *
 * ## What has teeth
 *
 * Every assertion below fails if the `isSuperseded` branch is removed from
 * `resolveIssueByUid`: `get` silently returns the stale card instead of
 * throwing. The multi-edit test additionally fails if the chain walk is
 * reduced to a single hop — it would report the intermediate corpse as the
 * successor. Real store, real `createIssue`/`update`, real `get` throughout.
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
import { update } from '../write/update.js';
import { IssueNotFoundError, StaleSupersedeError } from '../write/errors.js';
import { getIssue } from './get.js';

describe('get rejects a superseded uid and names the issue\'s current uid', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('get-superseded-uid');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'get-superseded-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function seedIssue(title: string, body: string): Promise<string> {
    const created = await createIssue(store, { project: projectUid, title, body, by: 'filer' });
    return created.uid;
  }

  it('throws StaleSupersedeError — not the frozen pre-edit card — and points at the new uid', async () => {
    const staleUid = await seedIssue('supersede target', 'the original body');
    const { uid: liveUid } = await update(store, {
      uid: staleUid,
      body: 'an edited body, which mints a new node',
      by: 'editor',
    });
    expect(liveUid).not.toBe(staleUid);

    // Before the fix this RESOLVED, returning the pre-edit card.
    const err = await getIssue(store.graph, { uid: staleUid }).then(
      (card) => {
        throw new Error(`expected a throw, but get returned a card: ${JSON.stringify(card)}`);
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StaleSupersedeError);
    const stale = err as StaleSupersedeError;
    expect(stale.uid).toBe(staleUid);
    expect(stale.successorUid).toBe(liveUid);
    // "stale", not "wrong" — the distinction the write path already draws.
    expect(stale).not.toBeInstanceOf(IssueNotFoundError);
    expect(stale.message).toContain(liveUid);
  });

  it('follows a multi-edit chain to the CURRENT head, not the next hop', async () => {
    const firstUid = await seedIssue('edited repeatedly', 'the original body');
    const secondUid = (await update(store, { uid: firstUid, body: 'the first revision', by: 'editor' })).uid;
    const thirdUid = (await update(store, { uid: secondUid, body: 'the second revision', by: 'editor' })).uid;
    expect(new Set([firstUid, secondUid, thirdUid]).size).toBe(3);

    // The oldest citation is two hops back. A single-hop walk would name
    // `secondUid` — itself superseded, and useless to the caller.
    const oldest = (await getIssue(store.graph, { uid: firstUid }).catch((e: unknown) => e)) as StaleSupersedeError;
    expect(oldest).toBeInstanceOf(StaleSupersedeError);
    expect(oldest.successorUid).toBe(thirdUid);

    // The middle link resolves to the same head.
    const middle = (await getIssue(store.graph, { uid: secondUid }).catch((e: unknown) => e)) as StaleSupersedeError;
    expect(middle).toBeInstanceOf(StaleSupersedeError);
    expect(middle.successorUid).toBe(thirdUid);
  });

  it('still serves the live uid, and the head carries the edited body', async () => {
    const staleUid = await seedIssue('supersede target', 'the original body');
    const { uid: liveUid } = await update(store, { uid: staleUid, body: 'the edited body', by: 'editor' });

    const card = await getIssue(store.graph, { uid: liveUid, fields: ['uid', 'title', 'body'] });
    expect(card.uid).toBe(liveUid);
    expect(card.body).toBe('the edited body');
  });

  it('a never-edited issue is untouched by the guard', async () => {
    const uid = await seedIssue('never edited', 'the only body');
    const card = await getIssue(store.graph, { uid, fields: ['uid', 'body'] });
    expect(card.uid).toBe(uid);
    expect(card.body).toBe('the only body');
  });

  it('a genuinely unknown uid is still IssueNotFoundError, not StaleSupersedeError', async () => {
    const err = await getIssue(store.graph, { uid: '00000000-0000-4000-8000-000000000000' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IssueNotFoundError);
    expect(err).not.toBeInstanceOf(StaleSupersedeError);
  });
});
