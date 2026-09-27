/**
 * uid-prefix.spec.ts — the uid REFERENCE contract: an exact uid resolves (the
 * fast path, unchanged), a UNIQUE uid prefix resolves to the same item, an
 * AMBIGUOUS prefix is REFUSED naming every candidate, a too-short uid attempt
 * is refused as too short, and an unmatched prefix reports "no item matches" —
 * applied consistently across every verb that takes a uid.
 *
 * Real components throughout (AGENTS.md §7): a real store opened via
 * `openTestIssueStore`/`seedProject`, real `createIssue` writes, and each verb
 * called exactly as `api.ts`'s mounted operation calls it. The only shortcut
 * is `setUid`, which rewrites a freshly-minted uid to a KNOWN
 * prefix-sharing value so the ambiguity and uniqueness cases are DETERMINISTIC
 * rather than relying on two random v4 uids happening to collide.
 *
 * NEGATIVE CONTROL (run and reverted for this task's report): temporarily
 * changing `selectUniqueUidCandidate` (`write/uid-prefix.ts`) to return
 * `candidates[0]` instead of throwing turns the ambiguous-prefix tests below
 * RED — the resolver then silently returns one of the two items, which is the
 * exact failure this contract forbids.
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
import { transition } from '../write/transition.js';
import { update } from '../write/update.js';
import { claim } from '../write/claim.js';
import { move } from '../write/move.js';
import { relate } from '../write/relate.js';
import { deleteIssue } from '../write/delete.js';
import { rmLocation, upsertLocation } from '../write/catalog.js';
import {
  AmbiguousReferenceError,
  InvalidArgumentError,
  IssueNotFoundError,
} from '../write/errors.js';
import { getIssue } from './get.js';
import { resolveUidPrefix } from './resolve.js';

const UID_UNIQUE = 'a1b2c3d4-1111-4111-8111-111111111111';
const PREFIX_UNIQUE = 'a1b2c3d4';

const UID_AMB_A = 'c0ffee00-1111-4111-8111-111111111111';
const UID_AMB_B = 'c0ffee00-2222-4222-8222-222222222222';
const PREFIX_AMB = 'c0ffee00';

/**
 * Rewrite a node's uid to a KNOWN value inside one `immediate` transaction.
 * A uid is opaque/random from `randomUUID()`, so controlling it is the only
 * way to make a shared-prefix fixture deterministic. Edges reference rowids,
 * never uids, so this is identity-only and safe.
 */
async function setUid(
  store: TestIssueStore,
  from: string,
  to: string
): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      const { rowsAffected } = await tx.executeRun(
        'UPDATE node SET uid = ? WHERE uid = ?',
        [to, from]
      );
      if (rowsAffected !== 1) {
        throw new Error(
          `setUid fixture: expected 1 row for uid "${from}", updated ${rowsAffected}`
        );
      }
    },
    { mode: 'immediate' }
  );
}

describe('uid resolution by exact match or UNIQUE prefix (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let rootComponentUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('uid-prefix');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'uid-prefix-project')).projectUid;
    const components = await store.graph.queryNodes({
      kind: 'component',
      liveOnly: true,
    });
    rootComponentUid = components.find(
      (c) => c.metadata?.['projectUid'] === projectUid
    )!.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function makeIssue(
    title: string,
    body = 'body'
  ): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body,
      by: 'filer',
    });
    return created.uid;
  }

  it('a unique prefix resolves to the same item as the full uid, and the full uid still resolves', async () => {
    const minted = await makeIssue('unique-prefix item');
    await setUid(store, minted, UID_UNIQUE);

    const byFull = await getIssue(store.graph, {
      uid: UID_UNIQUE,
      fields: ['uid', 'title', 'body'],
    });
    const byPrefix = await getIssue(store.graph, {
      uid: PREFIX_UNIQUE,
      fields: ['uid', 'title', 'body'],
    });

    expect(byPrefix).toEqual(byFull);
    expect(byPrefix.uid).toBe(UID_UNIQUE);
    expect(byPrefix.title).toBe('unique-prefix item');

    // A hyphenated longer prefix resolves identically.
    const byLonger = await getIssue(store.graph, { uid: 'a1b2c3d4-1111' });
    expect(byLonger.uid).toBe(UID_UNIQUE);

    // The resolver directly returns the full record.
    const record = await resolveUidPrefix(store.graph, PREFIX_UNIQUE, {
      expectedKind: 'issue',
    });
    expect(record.uid).toBe(UID_UNIQUE);
  });

  it('an AMBIGUOUS prefix is refused, naming every candidate uid and title — never an arbitrary pick', async () => {
    const first = await makeIssue('first ambiguous candidate');
    const second = await makeIssue('second ambiguous candidate');
    await setUid(store, first, UID_AMB_A);
    await setUid(store, second, UID_AMB_B);

    const err = await getIssue(store.graph, { uid: PREFIX_AMB }).then(
      () => {
        throw new Error('expected an AmbiguousReferenceError, but get resolved');
      },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AmbiguousReferenceError);
    const ambiguous = err as AmbiguousReferenceError;
    expect(ambiguous.ref).toBe(PREFIX_AMB);
    expect(new Set(ambiguous.candidates.map((c) => c.uid))).toEqual(
      new Set([UID_AMB_A, UID_AMB_B])
    );

    // The message names BOTH candidate uids and BOTH titles.
    expect(ambiguous.message).toContain(UID_AMB_A);
    expect(ambiguous.message).toContain(UID_AMB_B);
    expect(ambiguous.message).toContain('first ambiguous candidate');
    expect(ambiguous.message).toContain('second ambiguous candidate');
  });

  it('an exact full uid WINS even when its prefix is ambiguous — the fast path is unchanged', async () => {
    const first = await makeIssue('first ambiguous candidate');
    const second = await makeIssue('second ambiguous candidate');
    await setUid(store, first, UID_AMB_A);
    await setUid(store, second, UID_AMB_B);

    const card = await getIssue(store.graph, { uid: UID_AMB_A });
    expect(card.uid).toBe(UID_AMB_A);
    expect(card.title).toBe('first ambiguous candidate');
  });

  it('a uid attempt shorter than the minimum prefix length is refused as too short', async () => {
    const err = await getIssue(store.graph, { uid: 'a1b2c' }).then(
      () => {
        throw new Error('expected a too-short refusal');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(InvalidArgumentError);
    expect((err as Error).message).toContain('too short');
    expect((err as Error).message).toContain('at least 8');
  });

  it('a prefix that matches nothing reports "no item matches" rather than a generic validation error', async () => {
    await makeIssue('the only issue, with a controlled uid');
    // No live issue uid starts with `ffffffff` in this fixture.
    const err = await getIssue(store.graph, { uid: 'ffffffff' }).then(
      () => {
        throw new Error('expected a not-found refusal');
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(IssueNotFoundError);
    expect((err as Error).message).toContain('no item matches');
    expect((err as Error).message).toContain('ffffffff');
  });

  it('resolution is applied across `transition` via a prefix', async () => {
    const minted = await makeIssue('to transition');
    const uid = '0badf00d-1111-4111-8111-111111111111';
    await setUid(store, minted, uid);

    const outcome = await transition(store, {
      uid: '0badf00d',
      by: 'mover',
      toStatus: 'in-progress',
      note: 'starting work via a prefix',
    });
    expect(outcome.uid).toBe(uid);
    expect(outcome.toStatus).toBe('in-progress');
  });

  it('resolution is applied across `update` via a prefix', async () => {
    const minted = await makeIssue('to update', 'original body');
    const uid = '0ddba11c-1111-4111-8111-111111111111';
    await setUid(store, minted, uid);

    const outcome = await update(store, {
      uid: '0ddba11c',
      body: 'the edited body, via a prefix',
      by: 'editor',
    });
    expect(typeof outcome.uid).toBe('string');
    // The body edit supersedes: the returned (live) uid differs from the input.
    expect(outcome.uid).not.toBe(uid);
  });

  it('resolution is applied across `claim` via a prefix', async () => {
    const minted = await makeIssue('to claim');
    const uid = 'c1a1d000-1111-4111-8111-111111111111';
    await setUid(store, minted, uid);

    const outcome = await claim(store, {
      uid: 'c1a1d000',
      by: 'agent-a',
      action: 'claim',
    });
    expect(outcome.uid).toBe(uid);
    expect(outcome.status).toBe('claimed');
  });

  it('resolution is applied across `relate` (both endpoints) via prefixes', async () => {
    const sourceMinted = await makeIssue('relate source');
    const targetMinted = await makeIssue('relate target');
    const sourceUid = '5e1a7e01-1111-4111-8111-111111111111';
    const targetUid = '5e1a7e02-2222-4222-8222-222222222222';
    await setUid(store, sourceMinted, sourceUid);
    await setUid(store, targetMinted, targetUid);

    const outcome = await relate(store, {
      sourceUid: '5e1a7e01',
      targetUid: '5e1a7e02',
      rel: 'relates_to',
      action: 'add',
      by: 'agent-a',
    });
    expect(outcome.sourceUid).toBe(sourceUid);
    expect(outcome.targetUid).toBe(targetUid);
    expect(outcome.noop).toBe(false);
  });

  it('resolution is applied across `move` via a prefix', async () => {
    const minted = await makeIssue('to move');
    const uid = '0b1e5e00-1111-4111-8111-111111111111';
    await setUid(store, minted, uid);

    const outcome = await move(store, {
      uid: '0b1e5e00',
      toComponent: rootComponentUid,
      by: 'agent-a',
    });
    expect(outcome.uid).toBe(uid);
  });

  it('resolution is applied across `delete` via a prefix', async () => {
    const minted = await makeIssue('to delete');
    const uid = 'de1e7e00-1111-4111-8111-111111111111';
    await setUid(store, minted, uid);

    const outcome = await deleteIssue(store, {
      uid: 'de1e7e00',
      reason: 'no longer needed',
      by: 'closer',
    });
    expect(outcome).toEqual({ uid, invalidated: true });
  });

  it('resolution is applied across `rm-location` via a prefix', async () => {
    const location = await upsertLocation(store, {
      component: rootComponentUid,
      locType: 'tool',
      value: 'eslint',
      by: 'filer',
    });
    const uid = '10ca7100-1111-4111-8111-111111111111';
    await setUid(store, location.uid, uid);

    const outcome = await rmLocation(store, {
      uid: '10ca7100',
      by: 'remover',
      reason: 'no longer valid',
    });
    expect(outcome).toEqual({ uid, invalidated: true });
  });
});
