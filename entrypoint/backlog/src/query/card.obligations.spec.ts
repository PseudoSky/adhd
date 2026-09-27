/**
 * card.obligations.spec.ts — C4's read-projection proofs against a REAL store.
 *
 * The `obligations` pseudo field is a PURE PROJECTION of the stored
 * `obligation` nodes onto the card: it returns each obligation's declared
 * `applies_to`/`requirement`/`on_fail`/`override` VERBATIM and never evaluates
 * the predicate (evaluation is C5's gate at transition time and C6's verdict on
 * read). These proofs drive the real `assembleIssueCard` via `getIssue` and
 * the batched `assembleIssueCards` list path.
 *
 * Negative control (AC1/AC5): removing `'obligations'` from the projection (or
 * dropping `on_fail` from the view) makes the corresponding assertion RED —
 * demonstrated by a temporary local revert, restored exactly.
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
import { obligate, unobligate } from '../write/obligation.js';
import { assembleIssueCards } from './card.js';
import { getIssue } from './get.js';
import { resolveIssueByUid } from './resolve.js';

describe('card.obligations — the obligations pseudo field is a pure projection', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let uid: string;

  beforeEach(async () => {
    dir = freshTmpDir('card-obligations-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'card-obligations-project')).projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'projection subject',
      body: 'body',
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue suppressed: ${JSON.stringify(created)}`);
    }
    uid = created.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('returns each declared obligation verbatim, in declaration order — and never evaluates the predicate', async () => {
    const first = await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact', min: 2 },
      on_fail: 'block',
      override: { actors: ['dispatcher:1'] },
      by: 'declarer:1',
    });
    const second = await obligate(store, {
      uid,
      applies_to: { from: 'open', to: '*' },
      requirement: {
        op: 'all_of',
        of: [
          { op: 'blockers_terminal' },
          { op: 'not', of: { op: 'relation', type: 'duplicate_of', direction: 'in' } },
        ],
      },
      on_fail: 'warn',
      by: 'declarer:1',
    });

    const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card.obligations).toHaveLength(2);
    // Declaration order preserved.
    expect(card.obligations!.map((o) => o.uid)).toEqual([
      first.obligationUid,
      second.obligationUid,
    ]);

    const [a, b] = card.obligations!;
    expect(a!.applies_to).toEqual({ to: 'RESOLVED' });
    expect(a!.requirement).toEqual({ op: 'evidence', kind: 'published-artifact', min: 2 });
    expect(a!.on_fail).toBe('block');
    expect(a!.override).toEqual({ actors: ['dispatcher:1'] });

    expect(b!.applies_to).toEqual({ from: 'open', to: '*' });
    expect(b!.requirement).toEqual({
      op: 'all_of',
      of: [
        { op: 'blockers_terminal' },
        { op: 'not', of: { op: 'relation', type: 'duplicate_of', direction: 'in' } },
      ],
    });
    expect(b!.on_fail).toBe('warn');
    // No override declared ⇒ absent, not a fabricated empty actors array.
    expect(b!.override).toBeUndefined();

    // A second read returns the identical projection (nothing was mutated).
    const again = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(again.obligations).toEqual(card.obligations);
  });

  it('the default card omits `obligations` entirely (byte-for-byte unchanged)', async () => {
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const card = await getIssue(store.graph, { uid });
    expect('obligations' in card).toBe(false);
    // A projection that requests OTHER pseudo fields still omits obligations.
    const withRelated = await getIssue(store.graph, { uid, fields: ['uid', 'related'] });
    expect('obligations' in withRelated).toBe(false);
  });

  it('a requested but empty projection is `[]`, and unobligate removes the retired one', async () => {
    const kept = await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const retired = await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'relation', type: 'relates_to', direction: 'in' },
      on_fail: 'warn',
      by: 'declarer:1',
    });

    await unobligate(store, { obligationUid: retired.obligationUid, by: 'declarer:1' });
    const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(card.obligations!.map((o) => o.uid)).toEqual([kept.obligationUid]);

    // Retire the last one → an empty (not absent) projection.
    await unobligate(store, { obligationUid: kept.obligationUid, by: 'declarer:1' });
    const empty = await getIssue(store.graph, { uid, fields: ['obligations'] });
    expect(empty.obligations).toEqual([]);
  });

  it('the batched list path (assembleIssueCards) includes obligations when requested', async () => {
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const issue = await resolveIssueByUid(store.graph, uid);
    const [card] = await assembleIssueCards(store.graph, [issue], ['uid', 'obligations']);
    expect(card!.obligations).toHaveLength(1);
    expect(card!.obligations![0]!.requirement.op).toBe('blockers_terminal');
  });
});
