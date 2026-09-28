/**
 * transition.gate.spec.ts — C5's behavioral proofs for the closure gate, driven
 * through the REAL `transition` verb against a REAL store and git work tree.
 * Nothing is mocked; the thing under test is `transition.ts` wired to
 * `write/gate.ts`.
 *
 * - **AC1** an unsatisfied obligation refuses the terminal transition; the
 *   status is UNCHANGED on re-read and NO transition was written.
 * - **AC2** a verified attestation of the required kind lets the retry
 *   succeed; a `satisfies` edge obligation→attestation exists and
 *   `transition.meta.satisfied_by` names both uids.
 * - **AC3** a `commit` ref does NOT satisfy a `published-artifact` obligation.
 * - **AC6** override: non-listed actor refused; listed actor + reason succeeds
 *   and the reason is recorded on the audit row.
 * - the mounted api maps the refusal to `precondition_failed` with
 *   `details.refusal` (the UX acceptance shape).
 *
 * ## Negative controls
 *
 * Every AC's negative control is a one-line local revert of the enforcing code
 * (the gate call in `transition.ts`, the `satisfies` edge write, the
 * `claim.kind` filter in the resolver), run live: revert → red → restore →
 * green. `transition.ts`'s gate call is guarded so the revert is a single
 * deletion.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir, openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { transition } from './transition.js';
import { attest } from './attestation.js';
import { obligate } from './obligation.js';
import { ObligationUnsatisfiedError, OverrideNotPermittedError } from './errors.js';
import { nowISO, writeNodeTx } from './tx.js';
import { getIssue } from '../query/get.js';
import { buildBacklogEnv } from '../env.js';
import {
  create,
  obligate as apiObligate,
  transition as apiTransition,
  upsertProject,
  type BacklogCtx,
} from '../api.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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

describe('C5 closure gate — transition is fail-closed on terminal statuses (real store, real git)', () => {
  let dir: string;
  let repo: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('transition-gate-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'transition gate test']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    projectUid = (await seedProject(store, 'transition-gate-project')).projectUid;
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo }),
      projectUid,
    ]);
    await seedTerminalStatus(store, 'RESOLVED');
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
      throw new Error(`fixture: createIssue suppressed: ${JSON.stringify(created)}`);
    }
    return created.uid;
  }

  async function statusOf(uid: string): Promise<string | undefined> {
    const card = await getIssue(store.graph, { uid, fields: ['status'] });
    return card.status;
  }

  async function rowidOf(uid: string): Promise<number> {
    const row = await store.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE uid = ?',
      [uid]
    );
    if (!row) throw new Error(`fixture: no node for uid ${uid}`);
    return row.rowid;
  }

  async function countLiveTransitions(uid: string): Promise<number> {
    const rowid = await rowidOf(uid);
    const r = await store.adapter.executeGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM edge WHERE src = ? AND rel = 'has_transition' AND t_invalid IS NULL",
      [rowid]
    );
    return r?.n ?? 0;
  }

  async function satisfiesEdges(): Promise<Array<{ src: number; dst: number }>> {
    const r = await store.adapter.executeAll<{ src: number; dst: number }>(
      "SELECT src, dst FROM edge WHERE rel = 'satisfies' AND t_invalid IS NULL"
    );
    return r.rows;
  }

  async function latestTransitionMeta(uid: string): Promise<Record<string, unknown>> {
    const rowid = await rowidOf(uid);
    const row = await store.adapter.executeGet<{ meta: string | null }>(
      `SELECT t.meta AS meta FROM edge e JOIN node t ON t.rowid = e.dst
        WHERE e.src = ? AND e.rel = 'has_transition' AND e.t_invalid IS NULL
        ORDER BY t.rowid DESC LIMIT 1`,
      [rowid]
    );
    return row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  }

  function commit(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
  }

  // -------------------------------------------------------------------------
  // AC1
  // -------------------------------------------------------------------------
  it('AC1 — an unsatisfied obligation refuses the terminal transition; status unchanged on re-read; no transition written', async () => {
    const uid = await issue('ac1 subject');
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });

    await expect(
      transition(store, {
        uid,
        by: 'closer:1',
        toStatus: 'RESOLVED',
        note: 'closing without the artifact',
      })
    ).rejects.toThrow(ObligationUnsatisfiedError);

    // The throw rolled the transaction back: the issue's status is UNCHANGED,
    // no `has_transition` edge exists, and no `closedAt` was stamped.
    expect(await statusOf(uid)).toBe('open');
    expect(await countLiveTransitions(uid)).toBe(0);
    const row = await store.adapter.executeGet<{ meta: string | null }>(
      'SELECT meta FROM node WHERE uid = ?',
      [uid]
    );
    const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    expect('closedAt' in meta).toBe(false);

    // NEGATIVE CONTROL: deleting the gate call in `transition.ts` lets this
    // same transition succeed (status → RESOLVED, one has_transition) and the
    // `rejects.toThrow` above turns red.
  });

  // -------------------------------------------------------------------------
  // AC2
  // -------------------------------------------------------------------------
  it('AC2 — a verified attestation allows the retry; the closure names the obligation→attestation pairing', async () => {
    const uid = await issue('ac2 subject');
    const obligation = await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    commit('artifact.txt', 'artifact-alpha');
    const att = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact.txt', digest: sha256('artifact-alpha') },
      by: 'attester:1',
    });

    const outcome = await transition(store, {
      uid,
      by: 'closer:1',
      toStatus: 'RESOLVED',
      note: 'artifact attached',
    });
    expect(outcome.toStatus).toBe('RESOLVED');
    expect(outcome.closedAt).toBeDefined();

    // A live `satisfies` edge obligation → attestation.
    const obRowid = await rowidOf(obligation.obligationUid);
    const attRowid = await rowidOf(att.attestationUid);
    const edges = await satisfiesEdges();
    expect(
      edges.some((e) => e.src === obRowid && e.dst === attRowid)
    ).toBe(true);

    // The closure names both uids on the transition node's own meta.
    const tmeta = await latestTransitionMeta(uid);
    expect(tmeta['satisfied_by']).toEqual([
      { obligationUid: obligation.obligationUid, attestationUid: att.attestationUid },
    ]);

    // NEGATIVE CONTROL: writing `satisfies` only in memory (never persisting —
    // drop the edge-write block in `transition.ts`) makes the edge assertion
    // above fail → red.
  });

  // -------------------------------------------------------------------------
  // AC3
  // -------------------------------------------------------------------------
  it('AC3 — a commit ref does NOT satisfy a published-artifact obligation', async () => {
    const uid = await issue('ac3 subject');
    commit('c.txt', 'c');
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'commit' },
      anchor: { locator: `commit:${sha}`, digest: 'deadbeef' },
      by: 'attester:1',
    });

    let refusal: ObligationUnsatisfiedError | undefined;
    try {
      await transition(store, {
        uid,
        by: 'closer:1',
        toStatus: 'RESOLVED',
        note: 'commit only',
      });
    } catch (err) {
      if (err instanceof ObligationUnsatisfiedError) refusal = err;
      else throw err;
    }
    expect(refusal).toBeDefined();
    expect(refusal!.refusal.code).toBe('EvidenceUnverified');
    expect(refusal!.refusal.required_kind).toBe('published-artifact');
    expect(await statusOf(uid)).toBe('open');

    // NEGATIVE CONTROL: making the evidence leaf ignore `claim.kind` (dropping
    // the `json_extract(...,'$.claim.kind') = ?` clause in gate.ts's resolver)
    // lets the commit attestation satisfy the obligation → this refusal is
    // never thrown → red.
  });

  // -------------------------------------------------------------------------
  // AC4 (through the transition) — off-branch sha names performed_check.
  // -------------------------------------------------------------------------
  it('AC4 — a side-branch commit names performed_check:default_branch_ancestor in the refusal', async () => {
    const uid = await issue('ac4 subject');
    const defaultBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    commit('base.txt', 'base');
    git(repo, ['checkout', '-q', '-b', 'feature']);
    commit('feature.txt', 'feature');
    const sideSha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', defaultBranch]);

    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'commit' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'commit' },
      anchor: { locator: `commit:${sideSha}`, digest: 'deadbeef' },
      by: 'attester:1',
    });

    let refusal: ObligationUnsatisfiedError | undefined;
    try {
      await transition(store, {
        uid,
        by: 'closer:1',
        toStatus: 'RESOLVED',
        note: 'side-branch commit',
      });
    } catch (err) {
      if (err instanceof ObligationUnsatisfiedError) refusal = err;
      else throw err;
    }
    expect(refusal).toBeDefined();
    expect(refusal!.refusal.performed_check).toBe('default_branch_ancestor');
    expect(await statusOf(uid)).toBe('open');

    // NEGATIVE CONTROL: calling `isShaOnDefaultBranch` with a fail-OPEN
    // fallback when the branch cannot be resolved (returning
    // `{onDefaultBranch:true}`) would mark the side-branch commit as on-branch,
    // but the ref is still a `commit` kind and does not satisfy an
    // `evidence{kind:'commit'}` obligation unless its check.state is verified —
    // the AC4 negative control is proven directly in gate.spec.ts (a non-repo
    // root must return false, never a silent pass).
  });

  // -------------------------------------------------------------------------
  // AC6
  // -------------------------------------------------------------------------
  it('AC6 — override: non-listed actor refused; blank reason refused; listed actor + reason succeeds and is audited', async () => {
    const uid = await issue('ac6 subject');
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      override: { actors: ['dispatcher:1'] },
      by: 'declarer:1',
    });

    await expect(
      transition(store, {
        uid,
        by: 'someone:1',
        toStatus: 'RESOLVED',
        note: 'try an override',
        override: { reason: 'because' },
      })
    ).rejects.toThrow(OverrideNotPermittedError);

    await expect(
      transition(store, {
        uid,
        by: 'dispatcher:1',
        toStatus: 'RESOLVED',
        note: 'blank reason',
        override: { reason: '  ' },
      })
    ).rejects.toThrow(OverrideNotPermittedError);

    // Listed actor with a reason → succeeds.
    const outcome = await transition(store, {
      uid,
      by: 'dispatcher:1',
      toStatus: 'RESOLVED',
      note: 'owner signed off',
      override: { reason: 'owner-approved-2026-09' },
    });
    expect(outcome.toStatus).toBe('RESOLVED');

    // The reason is recorded on the audit row.
    const audit = await store.adapter.executeGet<{ meta: string | null; content: string | null }>(
      `SELECT a.content AS content, a.meta AS meta FROM edge e JOIN node a ON a.rowid = e.dst
        WHERE e.rel = 'audits' AND e.t_invalid IS NULL AND a.kind = 'audit'
        ORDER BY a.rowid DESC LIMIT 1`
    );
    const blob = `${audit?.content ?? ''} ${audit?.meta ?? ''}`;
    expect(blob).toContain('override: owner-approved-2026-09');

    // NEGATIVE CONTROL: honouring the override for ANY actor (dropping the
    // `override.actors.includes(effectiveActor)` guard in gate.ts) makes the
    // non-listed-actor case above succeed → red.
  });
});

/** Seeds a `status` catalog row with `terminal:true`. */
async function seedTerminalStatus(store: TestIssueStore, name: string): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, {
        kind: 'status',
        name,
        metadata: { terminal: true },
        at: nowISO(),
      });
    },
    { mode: 'immediate' }
  );
}

describe('C5 — the mounted api maps the closure refusal to precondition_failed + details.refusal', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;
  let issueUid: string;

  beforeEach(async () => {
    tmp = await openTmpStore('c5-api-surface');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const project = await upsertProject(ctx, { name: 'c5-api-surface-project', by: 'filer' });
    if (!project.ok) throw new Error('fixture: upsertProject failed');
    const created = await create(ctx, {
      project: project.data.uid,
      title: 'c5 api surface issue',
      body: 'b',
      by: 'filer',
    });
    if (!created.ok || created.data.uid === undefined) {
      throw new Error('fixture: create failed');
    }
    issueUid = created.data.uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('an unsatisfied obligation yields {code:precondition_failed, details.refusal}', async () => {
    const ob = await apiObligate(ctx, {
      uid: issueUid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    expect(ob.ok).toBe(true);

    const out = await apiTransition(ctx, {
      uid: issueUid,
      by: 'closer:1',
      toStatus: 'RESOLVED',
      note: 'close it',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('precondition_failed');
    const refusal = out.error.details?.refusal as
      | { code: string; required_kind?: string }
      | undefined;
    expect(refusal?.code).toBe('EvidenceUnverified');
    expect(refusal?.required_kind).toBe('published-artifact');

    // The status is unchanged on re-read.
    const after = await getIssue(tmp.store.graph, { uid: issueUid, fields: ['status'] });
    expect(after.status).toBe('open');
  });

  it('a non-listed override maps to precondition_failed (OverrideNotPermittedError)', async () => {
    await apiObligate(ctx, {
      uid: issueUid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      override: { actors: ['dispatcher:1'] },
      by: 'declarer:1',
    });
    const out = await apiTransition(ctx, {
      uid: issueUid,
      by: 'someone:1',
      toStatus: 'RESOLVED',
      note: 'override',
      override: { reason: 'because' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('precondition_failed');
  });
});
