/**
 * spec-staleness.spec.ts — C10's staleness proofs (AC2, AC3, AC7) driven
 * against a REAL store and the real verbs.
 *
 * **AC3's negative control is the head-line proof:** an absent token must read
 * `stale` / `method:'none'` / `reason:'no-token-supplied'`, never `fresh`. The
 * `ADHD_BACKLOG_UNSAFE_SPEC_STALENESS=default-fresh` switch reinstates the
 * wrong "token ?? current → fresh" behavior, and the test proves the assertion
 * goes RED under it.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { upsertProject } from '../write/catalog.js';
import { appendSpecRevision } from '../write/spec-revision.js';
import { checkSpecStaleness } from './spec-staleness.js';
import { getIssue } from './get.js';

describe('spec-staleness — the token → content-hash → ancestry ladder (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('spec-staleness-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (
      await upsertProject(store, { name: 'spec-staleness-project', by: 'filer' })
    ).uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function issue(title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue suppressed`);
    }
    return created.uid;
  }

  it("AC2 — `get` exposes the token; an OLDER token reads 'stale'", async () => {
    const uid = await issue('token subject');
    const rev1 = await appendSpecRevision(store, { uid, fragment: 'revA\n', base_revision: '', by: 'author:1' });

    const card = await getIssue(store.graph, { uid, fields: ['spec'] });
    expect(card.spec?.spec_revision_token).toBe(rev1.spec_revision_token);
    expect(card.spec?.spec_revision_token).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Current token → fresh.
    const fresh = await checkSpecStaleness(store.graph, { uid, token: rev1.spec_revision_token });
    expect(fresh.state).toBe('fresh');
    expect(fresh.method).toBe('token');

    // A newer revision mints a new token; the OLD token is now stale.
    await appendSpecRevision(store, { uid, fragment: 'revB\n', base_revision: rev1.spec_revision, by: 'author:1' });
    const stale = await checkSpecStaleness(store.graph, { uid, token: rev1.spec_revision_token });
    expect(stale.state).toBe('stale');
    expect(stale.method).toBe('token');
    expect(stale.reason).toBe('older-token');

    // NEGATIVE CONTROL: a build that returned `fresh` for a differing token
    // would make the assertion above red (it is not `fresh`).
    expect(stale.state).not.toBe('fresh');
  });

  it("AC3 — an ABSENT token is stale/none/no-token-supplied — never fresh (head-line control)", async () => {
    const uid = await issue('absent token subject');
    await appendSpecRevision(store, { uid, fragment: 'only\n', base_revision: '', by: 'author:1' });

    const out = await checkSpecStaleness(store.graph, { uid });
    expect(out.state).toBe('stale');
    expect(out.method).toBe('none');
    expect(out.reason).toBe('no-token-supplied');

    // HEAD-LINE NEGATIVE CONTROL: flip in the wrong "default-to-fresh"
    // implementation and prove the assertion above goes red.
    const prior = process.env['ADHD_BACKLOG_UNSAFE_SPEC_STALENESS'];
    process.env['ADHD_BACKLOG_UNSAFE_SPEC_STALENESS'] = 'default-fresh';
    try {
      const wrong = await checkSpecStaleness(store.graph, { uid });
      expect(wrong.state).toBe('fresh'); // the anti-pattern, caught
      expect(wrong.state).not.toBe('stale');
    } finally {
      if (prior === undefined) delete process.env['ADHD_BACKLOG_UNSAFE_SPEC_STALENESS'];
      else process.env['ADHD_BACKLOG_UNSAFE_SPEC_STALENESS'] = prior;
    }

    // …and back to GREEN with the switch off.
    const green = await checkSpecStaleness(store.graph, { uid });
    expect(green.state).toBe('stale');
    expect(green.method).toBe('none');
    expect(green.reason).toBe('no-token-supplied');
  });

  it("AC7 — a pointer/chain divergence reads 'stale'/'revision-drift' for every caller (never trusted)", async () => {
    const uid = await issue('drift subject');
    const rev1 = await appendSpecRevision(store, { uid, fragment: 'revA\n', base_revision: '', by: 'author:1' });
    const rev2 = await appendSpecRevision(store, { uid, fragment: 'revB\n', base_revision: rev1.spec_revision, by: 'author:1' });

    // Sanity: pointer and chain head agree, and the current token is fresh.
    const fresh = await checkSpecStaleness(store.graph, { uid, token: rev2.spec_revision_token });
    expect(fresh.state).toBe('fresh');

    // Inject a pointer that points at a NON-HEAD revision (bypassing the CAS
    // helper, as a concurrent/forged writer would).
    const node = (await store.graph.getNodeByUid(uid))!;
    const meta = { ...(node.metadata ?? {}) };
    meta['spec_revision'] = rev1.spec_revision;
    meta['spec_revision_token'] = rev1.spec_revision_token;
    meta['spec_revision_seq'] = 1;
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify(meta),
      uid,
    ]);

    // Every caller now sees stale/revision-drift — even with the CURRENT token.
    const drifted = await checkSpecStaleness(store.graph, { uid, token: rev2.spec_revision_token });
    expect(drifted.state).toBe('stale');
    expect(drifted.reason).toBe('revision-drift');

    // NEGATIVE CONTROL: a build that trusted the pointer without the chain
    // cross-check would return `fresh` here (the pointer token matches the
    // caller's). It must not.
    expect(drifted.state).not.toBe('fresh');
  });
});
