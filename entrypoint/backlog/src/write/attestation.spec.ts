/**
 * attestation.spec.ts — C3's behavioral proofs (AC1, AC2, AC5, AC6) driven
 * against a REAL store, a REAL git work tree, and the real `attest`/`recheck`
 * verbs. Nothing under test is mocked.
 *
 * The load-bearing invariant is IDENTITY: `attest` writes a SEPARATE
 * `attestation` node and never mutates the subject — asserted by comparing the
 * subject's persisted `meta`/`t_valid` byte-for-byte before and after, not by
 * trusting the verb's own outcome object. AC2 proves the `attests` edge
 * follows a body-edit supersession onto the new head. AC5 proves an absent
 * anchor is an EXPLICIT `stale` check with a reason, never an absent field.
 * AC6 proves `recheck` APPENDS (earlier checks copied forward verbatim).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { update } from './update.js';
import { upsertProject } from './catalog.js';
import { attest, recheck } from './attestation.js';
import {
  AnchorLocatorInvalidError,
  AttestationNotFoundError,
  InvalidArgumentError,
} from './errors.js';
import { getNodeByUidTx, type ITxNodeRow } from './tx.js';
import { resolveLogicalIssueId } from '../query/resolve.js';
import { getIssue } from '../query/get.js';
import { openGraphBacklogStore, type GraphBacklogStore } from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import {
  attest as apiAttest,
  recheck as apiRecheck,
  type BacklogCtx,
} from '../api.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Backdate every commit to 2020 so "filed now, untouched since filing"
    // is genuinely true: git's `--since` is second-granular, and a commit in
    // the same second as the attestation would otherwise count as "changed".
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('attestation — attest/recheck (real store, real git repo)', () => {
  let dir: string;
  let repo: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('attestation-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'attestation test']);
    projectUid = (
      await upsertProject(store, {
        name: 'attestation-project',
        path: repo,
        by: 'filer',
      })
    ).uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  function commit(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
  }

  /**
   * Commit `rel` in `root` with an EXPLICIT committer/author date. The suite's
   * own `git()` helper backdates everything to 2020 so "untouched since
   * filing" is genuinely true — but that also hides a real post-filing edit
   * from `git log --since`. The changed-content proof needs a commit dated
   * AFTER the recheck instant, so this helper takes the date as a parameter.
   */
  function commitAt(
    root: string,
    rel: string,
    content: string,
    iso: string
  ): void {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
    execFileSync('git', ['add', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['commit', '-qm', `set ${rel} @ ${iso}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
  }

  /** A SECOND, independently-registered git work tree — a sibling project root. */
  async function siblingProject(dirName: string): Promise<string> {
    const root = join(dir, dirName);
    mkdirSync(root, { recursive: true });
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'attestation test']);
    await upsertProject(store, { name: dirName, path: root, by: 'filer' });
    return root;
  }

  async function issue(title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!created.created || created.uid === undefined) {
      throw new Error(`fixture: createIssue was suppressed: ${JSON.stringify(created)}`);
    }
    return created.uid;
  }

  async function readRow(uid: string): Promise<ITxNodeRow | null> {
    return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
  }

  async function countLive(kind: string): Promise<number> {
    const row = await store.adapter.executeGet<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node WHERE kind = ? AND t_invalid IS NULL',
      [kind]
    );
    return row?.n ?? 0;
  }

  it('AC1 — attest creates a separate attestation node and leaves the subject uid, meta and updatedAt untouched', async () => {
    const uid = await issue('attested subject');
    commit('evidence.txt', 'c-one');
    const before = await store.adapter.executeGet<{
      rowid: number;
      meta: string | null;
      t_valid: string | null;
    }>('SELECT rowid, meta, t_valid FROM node WHERE uid = ?', [uid]);
    expect(before).not.toBeNull();
    const attestationsBefore = await countLive('attestation');

    const out = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact', body: 'ships the artifact' },
      anchor: { locator: 'path:evidence.txt', digest: sha256('c-one') },
      by: 'attester:1',
    });

    expect(out.check.state).toBe('verified');
    expect(out.subject.id).toBe(uid);

    // The subject row is byte-for-byte unchanged — uid, meta, revision
    // (inside meta) and updatedAt (t_valid) all identical.
    const after = await store.adapter.executeGet<{
      rowid: number;
      meta: string | null;
      t_valid: string | null;
    }>('SELECT rowid, meta, t_valid FROM node WHERE uid = ?', [uid]);
    expect(after!.rowid).toBe(before!.rowid);
    expect(after!.meta).toBe(before!.meta);
    expect(after!.t_valid).toBe(before!.t_valid);

    // The consumer-visible card still reports the same uid.
    const card = await getIssue(store.graph, { uid });
    expect(card.uid).toBe(uid);

    // A NEW attestation node exists, and the `attests` edge points from the
    // subject to it.
    expect(await countLive('attestation')).toBe(attestationsBefore + 1);
    const att = await readRow(out.attestationUid);
    expect(att?.kind).toBe('attestation');
    expect(att?.name).toBe('published-artifact');
    const edge = await store.adapter.executeGet<{ src: number }>(
      "SELECT src FROM edge WHERE dst = ? AND rel = 'attests' AND t_invalid IS NULL",
      [att!.rowid]
    );
    expect(edge?.src).toBe(before!.rowid);
  });

  it('AC2 — an attestation survives a body-edit supersession; the attests edge follows the new head', async () => {
    const staleUid = await issue('supersession subject');
    commit('e.txt', 'c-one');
    const { attestationUid } = await attest(store, {
      subject: { id: staleUid, revision: 0 },
      claim: { kind: 'live-system' },
      anchor: { locator: 'path:e.txt', digest: sha256('c-one') },
      by: 'attester:1',
    });

    const { uid: liveUid } = await update(store, {
      uid: staleUid,
      body: 'an edited body, which mints a new node',
      by: 'editor:1',
    });
    expect(liveUid).not.toBe(staleUid);

    // The logical resolver maps the stale uid forward to the head…
    expect(await resolveLogicalIssueId(store.graph, staleUid)).toBe(liveUid);

    // …and update's carry-forward sweep re-pointed the `attests` edge onto B.
    const att = await readRow(attestationUid);
    const edge = await store.adapter.executeGet<{ src: number }>(
      "SELECT src FROM edge WHERE dst = ? AND rel = 'attests' AND t_invalid IS NULL",
      [att!.rowid]
    );
    const live = await readRow(liveUid);
    expect(edge?.src).toBe(live!.rowid);
  });

  it('AC5 — an absent anchor is an explicit `stale` check (present field) with a reason, never a silent absence', async () => {
    const uid = await issue('missing anchor subject');
    const out = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'live-system' },
      anchor: { locator: 'path:does/not/exist.ts', digest: sha256('x') },
      by: 'attester:1',
    });

    expect(out.check.state).toBe('stale');
    expect(out.check.method).toBe('exists_at_head');
    expect(typeof out.check.reason).toBe('string');
    expect(out.check.reason!.length).toBeGreaterThan(0);

    const att = await readRow(out.attestationUid);
    const meta = att!.metadata!;
    expect(meta['check']).toBeDefined();
    expect(Array.isArray(meta['checks'])).toBe(true);
    expect((meta['checks'] as unknown[]).length).toBe(1);
  });

  it('AC6 — recheck APPENDS checks (never overwrites) and copies earlier entries forward verbatim', async () => {
    const uid = await issue('recheck subject');
    commit('r.txt', 'c-one');
    const { attestationUid, check: first } = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:r.txt', digest: sha256('c-one') },
      by: 'attester:1',
    });
    expect(first.state).toBe('verified');

    const r1 = await recheck(store, { attestationUid, by: 'rechecker:1' });
    expect(r1.checks.length).toBe(2);
    expect(r1.checks[0]).toEqual(first);

    // A second recheck with a DIFFERENT outcome: delete the file, commit.
    git(repo, ['rm', '-q', 'r.txt']);
    git(repo, ['commit', '-qm', 'remove r.txt']);
    const r2 = await recheck(store, { attestationUid, by: 'rechecker:1' });
    expect(r2.checks.length).toBe(3);
    // Earlier entries copied forward verbatim.
    expect(r2.checks[0]).toEqual(first);
    expect(r2.checks[1]).toEqual(r1.checks[1]);
    expect(r2.checks[2]!.state).toBe('stale');

    // Persisted history is the full three, not a truncated replacement.
    const att = await readRow(attestationUid);
    expect((att!.metadata!['checks'] as unknown[]).length).toBe(3);
  });

  it('CROSS-REPO — recheck resolves an ABSOLUTE sibling-project anchor against the sibling project root (unchanged → verified, changed → stale), never a false refutation', async () => {
    const sibling = await siblingProject('sibling-repo');
    const content = 'sibling evidence v1\n';
    commitAt(sibling, 'evidence.txt', content, '2020-01-01T00:00:00Z');

    // The subject issue lives in project A (`repo`); the anchor names a file
    // in project B. A resolver that only knows A can never see B's file.
    const uid = await issue('cross-repo citation subject');
    const { attestationUid, check } = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: {
        kind: 'source-reading',
        body: 'cites a file owned by a sibling project',
      },
      anchor: {
        locator: `path:${join(sibling, 'evidence.txt')}`,
        digest: sha256(content),
      },
      by: 'attester:1',
    });

    // (b) unchanged sibling file → verified, never a false `stale`/`unknown`.
    expect(check.state).toBe('verified');

    const r1 = await recheck(store, { attestationUid, by: 'rechecker:1' });
    expect(r1.checks[r1.checks.length - 1]!.state).toBe('verified');

    // (c) the sibling file genuinely changes → the check reports stale, and it
    // reports it from the sibling root (full_resolve), not a subject-root miss.
    commitAt(
      sibling,
      'evidence.txt',
      'sibling evidence v2\n',
      '2030-01-01T00:00:00Z'
    );
    const r2 = await recheck(store, { attestationUid, by: 'rechecker:1' });
    const last = r2.checks[r2.checks.length - 1]!;
    expect(last.state).toBe('stale');
    expect(last.method).toBe('full_resolve');
  });

  it('CROSS-REPO — recheck disambiguates a RELATIVE sibling-project anchor by the root that OWNS the file', async () => {
    const sibling = await siblingProject('sibling-relative');
    const content = 'relative evidence\n';
    commitAt(sibling, 'only-here.txt', content, '2020-01-01T00:00:00Z');

    const uid = await issue('relative cross-repo subject');
    const { attestationUid } = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'source-reading' },
      anchor: { locator: 'path:only-here.txt', digest: sha256(content) },
      by: 'attester:1',
    });

    // `only-here.txt` resolves under the subject root too, but only exists in
    // the sibling — the resolver must pick the root that owns the file.
    const r = await recheck(store, { attestationUid, by: 'rechecker:1' });
    expect(r.checks[r.checks.length - 1]!.state).toBe('verified');
  });

  it('a caller-observed revision that differs from the node is an explicit unknown/revision-drift, never `verified`', async () => {
    const uid = await issue('drift subject');
    commit('d.txt', 'c-one');
    const out = await attest(store, {
      subject: { id: uid, revision: 5 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:d.txt', digest: sha256('c-one') },
      by: 'attester:1',
    });
    expect(out.check.state).toBe('unknown');
    expect(out.check.reason).toBe('revision-drift');
  });

  it('rejects a locator outside the closed grammar and a digest-less anchor with AnchorLocatorInvalidError (nothing written)', async () => {
    const uid = await issue('invalid anchor subject');
    const before = await countLive('attestation');
    await expect(
      attest(store, {
        subject: { id: uid, revision: 0 },
        claim: { kind: 'x' },
        anchor: { locator: 'not-a-scheme', digest: sha256('x') },
        by: 'attester:1',
      })
    ).rejects.toThrow(AnchorLocatorInvalidError);
    await expect(
      attest(store, {
        subject: { id: uid, revision: 0 },
        claim: { kind: 'x' },
        anchor: { locator: 'path:a.txt', digest: '   ' },
        by: 'attester:1',
      })
    ).rejects.toThrow(AnchorLocatorInvalidError);
    expect(await countLive('attestation')).toBe(before);
  });

  it('recheck on an unknown uid throws AttestationNotFoundError', async () => {
    await expect(
      recheck(store, {
        attestationUid: '00000000-0000-4000-8000-000000000000',
        by: 'rechecker:1',
      })
    ).rejects.toThrow(AttestationNotFoundError);
  });

  it('rejects a blank `by` with InvalidArgumentError', async () => {
    const uid = await issue('blank by subject');
    await expect(
      attest(store, {
        subject: { id: uid, revision: 0 },
        claim: { kind: 'x' },
        anchor: { locator: 'path:a.txt', digest: sha256('x') },
        by: '   ',
      })
    ).rejects.toThrow(InvalidArgumentError);
  });
});

describe('C3 Segment F — the mounted api surface maps the new error classes', () => {
  let dir: string;
  let store: GraphBacklogStore;
  let ctx: BacklogCtx;

  beforeEach(async () => {
    dir = freshTmpDir('c3-api-surface');
    store = await openGraphBacklogStore(join(dir, 'backlog.db'));
    ctx = { store, env: buildBacklogEnv({ adhdRoot: dir }) };
  });

  afterEach(async () => {
    await store.adapter.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('AnchorLocatorInvalidError maps to invalid_argument — NOT the validation fallback', async () => {
    const out = await apiAttest(ctx, {
      subject: { id: 'whatever', revision: 0 },
      claim: { kind: 'x' },
      anchor: { locator: 'not-a-scheme', digest: sha256('x') },
      by: 'attester:1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('invalid_argument');
  });

  it('AttestationNotFoundError maps to item_not_found (distinct from the validation fallback)', async () => {
    const out = await apiRecheck(ctx, {
      attestationUid: '00000000-0000-4000-8000-000000000000',
      by: 'rechecker:1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('item_not_found');
  });
});
