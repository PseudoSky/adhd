/**
 * gate.spec.ts — C5 unit proofs for the closure gate's mechanical pieces,
 * driven against a REAL store and a REAL git work tree. Nothing is mocked:
 * the thing under test is `evaluateTransitionGateTx` (over the tx-scoped
 * resolver it builds) and `anchor-check.ts`'s `commit:` / default-branch
 * check.
 *
 * AC4 (a sha not on the default branch is denied) is proven here directly:
 * `isShaOnDefaultBranch` returns false for a side-branch commit and its
 * `performed` names `default_branch_ancestor`, and the gate's refusal for a
 * `commit:`-anchored attestation carries that same `performed_check`.
 * The end-to-end AC1/AC2/AC3/AC6 transitions live in `transition.gate.spec.ts`;
 * the two-process concurrency proof in `cross-process-gate-safety.e2e.ts`.
 *
 * ## Negative controls
 *
 * Each mechanical assertion's negative control is a one-line inversion of the
 * property under test, demonstrated live (revert → red → restore → green):
 * `isShaOnDefaultBranch`'s fail-closed return (a non-repo root must be false),
 * and the gate's `performed_check` derivation.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir, osTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { attest } from './attestation.js';
import { obligate } from './obligation.js';
import { relate } from './relate.js';
import { transition } from './transition.js';
import {
  checkAnchor,
  isShaOnDefaultBranch,
  parseAnchor,
} from './anchor-check.js';
import { evaluateTransitionGateTx } from './gate.js';
import { OverrideNotPermittedError } from './errors.js';
import { nowISO, writeNodeTx } from './tx.js';

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

describe('C5 closure gate — evaluateTransitionGateTx + the default-branch check (real store, real git)', () => {
  let dir: string;
  let repo: string;
  let defaultBranch: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('gate-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'gate test']);
    // An initial commit so HEAD (and thus the default branch name) is born.
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    defaultBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    projectUid = (await seedProject(store, 'gate-project')).projectUid;
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo }),
      projectUid,
    ]);
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

  async function rowidOf(uid: string): Promise<number> {
    const row = await store.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE uid = ?',
      [uid]
    );
    if (!row) throw new Error(`fixture: no node for uid ${uid}`);
    return row.rowid;
  }

  function commit(rel: string, content: string): string {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
    return git(repo, ['rev-parse', 'HEAD']).trim();
  }

  async function seedTerminalStatus(name: string): Promise<void> {
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

  /** Run the gate inside a REAL immediate transaction, exactly as `transition` does. */
  async function runGate(
    issueUid: string,
    fromStatus: string,
    toStatus: string,
    effectiveActor: string,
    override?: { reason: string }
  ) {
    const rowid = await rowidOf(issueUid);
    return store.adapter.transaction(
      (tx: AdapterTransaction) =>
        evaluateTransitionGateTx(tx, {
          issueRowid: rowid,
          fromStatus,
          toStatus,
          effectiveActor,
          at: nowISO(),
          ...(override !== undefined ? { override } : {}),
        }),
      { mode: 'immediate' }
    );
  }

  // -------------------------------------------------------------------------
  // AC4 (mechanical half) — the default-branch check.
  // -------------------------------------------------------------------------
  it('AC4 — isShaOnDefaultBranch: true for a default-branch commit, false for a side branch, fail-closed off-repo', async () => {
    const mainSha = commit('main.txt', 'on-main');

    // A side branch with its own commit, then back to the default branch.
    git(repo, ['checkout', '-q', '-b', 'side']);
    const sideSha = commit('side.txt', 'on-side');
    git(repo, ['checkout', '-q', defaultBranch]);

    const onMain = await isShaOnDefaultBranch(repo, mainSha);
    expect(onMain.onDefaultBranch).toBe(true);
    expect(onMain.performed).toBe('default_branch_ancestor');

    const onSide = await isShaOnDefaultBranch(repo, sideSha);
    expect(onSide.onDefaultBranch).toBe(false);
    expect(onSide.performed).toBe('default_branch_ancestor');

    // Fail-closed: a non-repo root, or an explicit-but-unresolvable branch,
    // returns false — never a silent pass. NOTE: the tmp dir under the repo
    // (`freshTmpDir`) is itself inside this work tree, so a genuine non-repo
    // root must be outside it (`os.tmpdir()`).
    const nonRepo = osTmpDir('gate-spec-non-repo');
    try {
      expect((await isShaOnDefaultBranch(nonRepo, mainSha)).onDefaultBranch).toBe(false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
    expect(
      (await isShaOnDefaultBranch(repo, mainSha, 'no-such-branch')).onDefaultBranch
    ).toBe(false);

    // The negative control inverts the fail-closed property: if a non-repo root
    // returned `true` (fail-OPEN) the assertion above would be red. Proven live
    // by temporarily returning `{onDefaultBranch:true}` for the non-repo branch.
  });

  it('AC4 — the `commit:` scheme parses and checkAnchor verifies an on-branch sha / stales an off-branch one', () => {
    const mainSha = commit('a.txt', 'a');
    git(repo, ['checkout', '-q', '-b', 'side2']);
    const sideSha = commit('b.txt', 'b');
    git(repo, ['checkout', '-q', defaultBranch]);

    expect(parseAnchor(`commit:${mainSha}`)).toEqual({
      scheme: 'commit',
      target: mainSha,
    });

    const ok = checkAnchor(
      { locator: `commit:${mainSha}`, digest: 'deadbeef' },
      { root: repo, now: nowISO(), by: 'checker:1' }
    );
    expect(ok.state).toBe('verified');
    expect(ok.method).toBe('default_branch_ancestor');

    const off = checkAnchor(
      { locator: `commit:${sideSha}`, digest: 'deadbeef' },
      { root: repo, now: nowISO(), by: 'checker:1' }
    );
    expect(off.state).toBe('stale');
    expect(off.method).toBe('default_branch_ancestor');
  });

  // -------------------------------------------------------------------------
  // Scope + reason derivation + severity + override (direct gate proofs).
  // -------------------------------------------------------------------------
  it('scopes obligations by applies_to.to and applies_to.from', async () => {
    const uid = await issue('scope subject');
    await obligate(store, {
      uid,
      applies_to: { from: 'open', to: 'done' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });

    // to mismatch → out of scope → no refusal.
    expect((await runGate(uid, 'open', 'cancelled', 'closer:1')).satisfied).toBe(true);
    // from mismatch → out of scope.
    expect((await runGate(uid, 'new', 'done', 'closer:1')).satisfied).toBe(true);
    // both match → refused.
    const refused = await runGate(uid, 'open', 'done', 'closer:1');
    expect(refused.satisfied).toBe(false);
    expect(refused.refusals[0]!.code).toBe('EvidenceUnverified');
    expect(refused.refusals[0]!.required_kind).toBe('published-artifact');
  });

  it('maps each failing leaf to its reason code (evidence/blockers_terminal/relation)', async () => {
    const uid = await issue('reason subject');
    await obligate(store, {
      uid,
      applies_to: { to: '*' },
      requirement: { op: 'blockers_terminal' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    // A non-terminal blocker.
    const blocker = await issue('reason blocker');
    await relate(store, {
      sourceUid: blocker,
      targetUid: uid,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });
    const blocked = await runGate(uid, 'open', 'RESOLVED', 'closer:1');
    expect(blocked.refusals[0]!.code).toBe('BlockedBy');

    // relation leaf absent.
    const uid2 = await issue('relation subject');
    await obligate(store, {
      uid: uid2,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'relation', type: 'relates_to', direction: 'in' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const unrel = await runGate(uid2, 'open', 'RESOLVED', 'closer:1');
    expect(unrel.refusals[0]!.code).toBe('ReferenceUnresolved');
  });

  it('on_fail:warn records a warning but never refuses', async () => {
    const uid = await issue('warn subject');
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'warn',
      by: 'declarer:1',
    });
    const evaluation = await runGate(uid, 'open', 'RESOLVED', 'closer:1');
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.refusals).toHaveLength(0);
    expect(evaluation.warnings).toHaveLength(1);
    expect(evaluation.warnings[0]!.code).toBe('EvidenceUnverified');
  });

  it('a satisfied obligation returns its satisfies pair and yields consent', async () => {
    const uid = await issue('satisfied subject');
    const sha = commit('artifact.txt', 'artifact-body');
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    const att = await attest(store, {
      subject: { id: uid, revision: 0 },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact.txt', digest: sha },
      by: 'attester:1',
    });
    const evaluation = await runGate(uid, 'open', 'RESOLVED', 'closer:1');
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.satisfiedBy).toHaveLength(1);
    expect(evaluation.satisfiedBy[0]!.attestationUid).toBe(att.attestationUid);
  });

  it('AC3 — a commit-kind attestation does NOT satisfy a published-artifact obligation, and carries performed_check', async () => {
    const uid = await issue('commit-ref subject');
    const sha = commit('c.txt', 'c');
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
    const evaluation = await runGate(uid, 'open', 'RESOLVED', 'closer:1');
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.refusals[0]!.code).toBe('EvidenceUnverified');
    expect(evaluation.refusals[0]!.required_kind).toBe('published-artifact');
    expect(evaluation.refusals[0]!.performed_check).toBe('default_branch_ancestor');
  });

  // -------------------------------------------------------------------------
  // AC6 (gate half) — override.
  // -------------------------------------------------------------------------
  it('AC6 — override: non-listed actor throws; listed actor + reason is honoured; blank reason throws', async () => {
    const uid = await issue('override subject');
    await obligate(store, {
      uid,
      applies_to: { to: 'RESOLVED' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      override: { actors: ['dispatcher:1'] },
      by: 'declarer:1',
    });

    // Non-listed actor claiming an override → OverrideNotPermittedError.
    await expect(
      runGate(uid, 'open', 'RESOLVED', 'someone:1', { reason: 'because' })
    ).rejects.toThrow(OverrideNotPermittedError);

    // Listed actor, blank reason → OverrideNotPermittedError (an override always
    // requires a recorded reason).
    await expect(
      runGate(uid, 'open', 'RESOLVED', 'dispatcher:1', { reason: '   ' })
    ).rejects.toThrow(OverrideNotPermittedError);

    // Listed actor, no override claimed → refused (the obligation still holds).
    expect((await runGate(uid, 'open', 'RESOLVED', 'dispatcher:1')).satisfied).toBe(false);

    // Listed actor + non-blank reason → honoured.
    const overridden = await runGate(uid, 'open', 'RESOLVED', 'dispatcher:1', {
      reason: 'owner-approved',
    });
    expect(overridden.satisfied).toBe(true);
    expect(overridden.refusals).toHaveLength(0);
  });

  it('a malformed obligation is refused MissingObligation (fail-closed)', async () => {
    const uid = await issue('malformed subject');
    const rowid = await rowidOf(uid);
    await store.adapter.transaction(
      async (tx) => {
        const now = nowISO();
        const ob = await writeNodeTx(tx, {
          kind: 'obligation',
          name: 'evidence',
          content: '{}',
          // Deliberately missing applies_to.to / on_fail.
          metadata: { requirement: { op: 'evidence', kind: 'x' } },
          at: now,
        });
        await tx.executeRun(
          `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
           VALUES (?, ?, 'has_obligation', 1.0, 'user_asserted', NULL, ?, ?)`,
          [rowid, ob.rowid, now, now]
        );
      },
      { mode: 'immediate' }
    );
    const evaluation = await runGate(uid, 'open', 'RESOLVED', 'closer:1');
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.refusals[0]!.code).toBe('MissingObligation');
  });

  it('a non-terminal transition is out of the gate entirely (no obligation matches a "*" scope? it does — so guard at the caller)', async () => {
    // The gate itself is scope-driven; `transition` only calls it for terminal
    // targets. Here we prove an obligation scoped to the terminal name is NOT
    // evaluated when the target differs.
    const uid = await issue('nonterminal subject');
    await seedTerminalStatus('done');
    await obligate(store, {
      uid,
      applies_to: { to: 'done' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    // A real non-terminal transition never invokes the gate — the obligation
    // does not block it (this is `transition`, not a raw gate call).
    const outcome = await transition(store, {
      uid,
      by: 'mover:1',
      toStatus: 'in_progress',
      note: 'start work',
    });
    expect(outcome.toStatus).toBe('in_progress');
  });
});
