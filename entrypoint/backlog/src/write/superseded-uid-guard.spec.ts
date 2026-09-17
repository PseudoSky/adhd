/**
 * superseded-uid-guard.spec.ts — every issue verb rejects a SUPERSEDED uid.
 *
 * ## The bug this pins
 *
 * A body edit does not mutate the issue in place: `update` mints a NEW node
 * with a NEW uid and marks the old row superseded, via a CAS that sets
 * `is_superseded = 1` and **never touches `t_invalid`**. So a superseded row
 * is still `t_invalid IS NULL`, and a guard that only checks `tInvalid` —
 * which is what `claim`, `relate`, `move` and `delete` each had — lets a
 * stale uid through as if it were the live issue.
 *
 * This repo is parallel-process enabled, so "a caller holding a uid from
 * before someone else's body edit" is an ordinary event, not a contrived one.
 * The failures were silent rather than loud:
 *
 *  - `claim` would take the lease on the dead node while the real issue
 *    stayed unclaimed — two agents each believing they hold the same issue.
 *  - `relate` would write a real edge onto the zombie. `card.ts` resolves
 *    edges only off the node it is given and never walks SUPERSEDES chains,
 *    so that edge is permanently invisible against the issue's live uid —
 *    data loss with no error.
 *  - `delete` would report `invalidated: true` while the live issue was
 *    untouched.
 *
 * ## Why it is one shared helper and not a convention
 *
 * Six verbs hand-duplicated the uid fetch; `update` and `transition` added
 * the `isSuperseded` half and the other four did not. The convention is
 * exactly what failed, so the guard now lives in ONE function
 * (`resolveLiveIssueTx`, tx.ts) that every verb calls. These tests are what
 * stop the gap reopening: they drive the REAL verbs against a REAL store
 * through a REAL supersede, and each one fails if its verb goes back to a
 * bare `getNodeByUidTx` + `tInvalid` check.
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
import { update } from './update.js';
import { transition } from './transition.js';
import { claim } from './claim.js';
import { relate } from './relate.js';
import { move } from './move.js';
import { deleteIssue } from './delete.js';
import { StaleSupersedeError } from './errors.js';
import { getNodeByUidTx } from './tx.js';

describe('every issue verb rejects a superseded uid (real store, real supersede)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  /** The uid the caller is still holding — valid until the body edit below. */
  let staleUid: string;
  /** The uid the supersede minted; the issue's real current identity. */
  let liveUid: string;
  /** A second, never-superseded issue, so `relate` has a valid counterparty. */
  let otherUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('superseded-uid-guard');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'superseded-guard-project'))
      .projectUid;

    const created = await createIssue(store, {
      project: projectUid,
      title: 'supersede target',
      body: 'the original body',
      by: 'filer',
    });
    staleUid = created.uid;

    const other = await createIssue(store, {
      project: projectUid,
      title: 'relate counterparty',
      body: 'never superseded',
      by: 'filer',
    });
    otherUid = other.uid;

    // A real body edit — the only thing that supersedes.
    const updated = await update(store, {
      uid: staleUid,
      body: 'an edited body, which mints a new node',
      by: 'editor',
    });
    liveUid = updated.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('the supersede really happened: new uid, old row still live-looking (t_invalid IS NULL)', async () => {
    // This is the precondition that makes every test below meaningful. If the
    // old row were t_invalid-stamped, a tInvalid-only guard would have caught
    // it and there would be no bug to fix — so assert the actual shape.
    expect(liveUid).not.toBe(staleUid);
    const old = await store.adapter.transaction(async (tx) =>
      getNodeByUidTx(tx, staleUid)
    );
    expect(old).not.toBeNull();
    expect(old?.isSuperseded).toBe(true);
    expect(old?.tInvalid).toBeNull();
  });

  it('claim rejects it — otherwise two agents hold the lease on one issue', async () => {
    await expect(
      claim(store, { uid: staleUid, by: 'agent-a', action: 'claim' })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('relate rejects it as the source — otherwise the edge is invisible forever', async () => {
    await expect(
      relate(store, {
        sourceUid: staleUid,
        targetUid: otherUid,
        rel: 'blocks',
        action: 'add',
        by: 'agent-a',
      })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('relate rejects it as the target too', async () => {
    await expect(
      relate(store, {
        sourceUid: otherUid,
        targetUid: staleUid,
        rel: 'blocks',
        action: 'add',
        by: 'agent-a',
      })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('delete rejects it — otherwise it reports success while the live issue survives', async () => {
    await expect(
      deleteIssue(store, {
        uid: staleUid,
        by: 'agent-a',
        reason: 'no longer needed',
      })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('move rejects it', async () => {
    await expect(
      move(store, { uid: staleUid, by: 'agent-a', project: projectUid })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('update and transition still reject it (they always did — kept so a refactor cannot regress them)', async () => {
    await expect(
      update(store, { uid: staleUid, body: 'another edit', by: 'agent-a' })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
    await expect(
      transition(store, { uid: staleUid, toStatus: 'OPEN', by: 'agent-a' })
    ).rejects.toBeInstanceOf(StaleSupersedeError);
  });

  it('the LIVE uid still works — the guard rejects staleness, not the issue', async () => {
    // Without this, every test above would pass just as well if the verbs
    // were simply broken for all inputs.
    const claimed = await claim(store, {
      uid: liveUid,
      by: 'agent-a',
      action: 'claim',
    });
    expect(claimed.uid).toBe(liveUid);
  });
});
