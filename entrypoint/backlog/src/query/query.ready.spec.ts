/**
 * query.ready.spec.ts — `view:'ready'` honors `limit`, and the batched
 * traversal that replaced its per-issue round trips still answers exactly
 * the same question.
 *
 * ## What these tests hold in place
 *
 * `queryReady` used to be the one view that never called
 * `assertQueryLimit`. Its siblings — `queryList`, `queryGraph`, `queryOrder`
 * — all validate and apply the caller's `limit`; this one ignored it and
 * materialized every open issue in the store on every call. That is the
 * default "what should I work on" query, so the cost of the most-run query
 * in the package scaled with how big the backlog had grown rather than with
 * anything the caller asked for.
 *
 * Fixing it meant two things that can each regress independently, so each
 * gets its own test:
 *
 *  - **The cap exists and is validated.** A rejected limit must be rejected
 *    here exactly as it is on `view:'list'`; there is no reading under which
 *    `limit: 0` is meaningful on one view and silently ignored on another.
 *  - **The cap is applied AFTER the readiness filter.** Taking the first
 *    `limit` candidates and then filtering would return fewer ready issues
 *    than exist — the caller asks for 2 ready issues, two claimed issues
 *    happen to sort first, and they get nothing back. That failure is silent
 *    and looks exactly like an empty backlog, so it is pinned deliberately.
 *
 * The readiness semantics themselves are pinned too, because the round trips
 * were collapsed into whole-relation fetches grouped in memory. Every case
 * that distinguishes ready from not-ready — unclaimed, no blockers, blockers
 * all terminal, blockers not all terminal — has to survive that rewrite
 * unchanged, and each is asserted against a real store rather than a mock.
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
import { relate } from '../write/relate.js';
import { claim } from '../write/claim.js';
import { transition } from '../write/transition.js';
import { writeNodeTx, nowISO } from '../write/tx.js';
import { queryIssues } from './query.js';
import { BacklogValidationError } from '../write/errors.js';

/**
 * Mints a status row with `terminal: true`. `transition` mints an unresolved
 * status NAME with `terminal: false` (§6.1), so a terminal status cannot be
 * created through a verb — it has to be seeded, exactly as a real project's
 * catalog seeding would.
 */
async function seedTerminalStatus(store: TestIssueStore, name: string): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, { kind: 'status', name, metadata: { terminal: true }, at: nowISO() });
    },
    { mode: 'immediate' },
  );
}

async function readyUids(store: TestIssueStore, limit?: number): Promise<string[]> {
  const result = await queryIssues(store, limit === undefined ? { view: 'ready' } : { view: 'ready', limit });
  if (result.view !== 'ready') throw new Error(`expected view 'ready', got '${result.view}'`);
  return result.items.map((card) => card.uid);
}

describe("view:'ready' — limit is validated and applied (real store)", () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-ready');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'ready-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string): Promise<string> {
    const created = await createIssue(store, { project: projectUid, title, body: `${title} body`, by: 'filer' });
    return created.uid;
  }

  it('returns at most `limit` ready issues', async () => {
    await mkIssue('ready one');
    await mkIssue('ready two');
    await mkIssue('ready three');

    expect(await readyUids(store, 2)).toHaveLength(2);
    expect(await readyUids(store, 3)).toHaveLength(3);
  });

  it('rejects an invalid limit exactly as the other views do', async () => {
    await mkIssue('any open issue');

    await expect(readyUids(store, 0)).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(readyUids(store, -1)).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(readyUids(store, 1.5)).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(readyUids(store, 1001)).rejects.toBeInstanceOf(BacklogValidationError);
  });

  it('applies the cap AFTER the readiness filter, not before it', async () => {
    // Two not-ready issues are created FIRST, so any implementation that
    // truncates candidates before filtering sees only these two and returns
    // nothing at all.
    const claimedA = await mkIssue('claimed a');
    const claimedB = await mkIssue('claimed b');
    await claim(store, { uid: claimedA, by: 'someone', action: 'claim' });
    await claim(store, { uid: claimedB, by: 'someone', action: 'claim' });

    const readyA = await mkIssue('genuinely ready a');
    const readyB = await mkIssue('genuinely ready b');

    expect(new Set(await readyUids(store, 2))).toEqual(new Set([readyA, readyB]));
  });
});

describe("view:'ready' — readiness semantics survive the batched traversal (real store)", () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-ready-semantics');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'ready-semantics-project')).projectUid;
    await seedTerminalStatus(store, 'done');
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string): Promise<string> {
    const created = await createIssue(store, { project: projectUid, title, body: `${title} body`, by: 'filer' });
    return created.uid;
  }

  it('an unblocked, unclaimed, open issue is ready', async () => {
    const uid = await mkIssue('nothing in its way');
    expect(await readyUids(store)).toContain(uid);
  });

  it('a claimed issue is not ready', async () => {
    const uid = await mkIssue('taken');
    expect(await readyUids(store)).toContain(uid);

    await claim(store, { uid, by: 'someone-else', action: 'claim' });
    expect(await readyUids(store)).not.toContain(uid);
  });

  it('an issue with a non-terminal blocker is not ready', async () => {
    const blocked = await mkIssue('waiting on work');
    const blocker = await mkIssue('the work');
    await relate(store, { sourceUid: blocker, targetUid: blocked, rel: 'blocks', action: 'add', by: 'filer' });

    expect(await readyUids(store)).not.toContain(blocked);
    expect(await readyUids(store)).toContain(blocker);
  });

  it('an issue becomes ready once every blocker reaches a terminal status', async () => {
    const blocked = await mkIssue('waiting on two things');
    const first = await mkIssue('first blocker');
    const second = await mkIssue('second blocker');
    await relate(store, { sourceUid: first, targetUid: blocked, rel: 'blocks', action: 'add', by: 'filer' });
    await relate(store, { sourceUid: second, targetUid: blocked, rel: 'blocks', action: 'add', by: 'filer' });

    expect(await readyUids(store)).not.toContain(blocked);

    // One down, one to go — still blocked. This is the half that a naive
    // "any blocker terminal" rewrite would get wrong.
    await transition(store, { uid: first, by: 'worker', toStatus: 'done', note: 'finished the first' });
    expect(await readyUids(store)).not.toContain(blocked);

    await transition(store, { uid: second, by: 'worker', toStatus: 'done', note: 'finished the second' });
    expect(await readyUids(store)).toContain(blocked);
  });
});
