/**
 * verdict.spec.ts — C6's behavioral proofs for the derived verdict, driven
 * against a REAL store (and a REAL git work tree for the anchor rungs).
 *
 * - **AC4** the verdict is DERIVED, not stored: unblocking the blocker flips
 *   `actionable` with no write to the dependent, and the dependent's content
 *   revision is unchanged across both derivations.
 * - **AC5** every condition carries a stable `code`; `Blocked/True` ⇔
 *   `actionable:false`; `Unknown` ⇒ `actionable:'unknown'` (never `true`).
 * - **AC7** `ClaimStale` is a warn; the honest floor (no obligation, no
 *   blocker) is `actionable:true`; `MissingObligation` is warn-only.
 *
 * ## Negative controls
 *
 * Run live during development (revert → red → restore → green); the assertions
 * below are written so each revert turns the matching test red — see the
 * per-test comments.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeRecord } from '@adhd/sox-graph-store';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir, openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import {
  claim as apiClaim,
  create,
  get as apiGet,
  obligate as apiObligate,
  transition as apiTransition,
  upsertProject,
  type BacklogCtx,
} from '../api.js';
import { createIssue } from '../write/create-issue.js';
import { transition } from '../write/transition.js';
import { relate } from '../write/relate.js';
import { attest } from '../write/attestation.js';
import { obligate } from '../write/obligation.js';
import { claim } from '../write/claim.js';
import { PreconditionRefusedError } from '../write/errors.js';
import { nowISO, writeNodeTx } from '../write/tx.js';
import { readRevision } from '../write/revision.js';
import { computeActionable, orderConditions } from './verdict-core.js';
import { deriveVerdict } from './verdict.js';
import type { ICondition, IIssueCard } from './types.js';

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

describe('C6 verdict — derived actionability with reasons (real store)', () => {
  let dir: string;
  let repo: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('verdict-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'verdict test']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    projectUid = (await seedProject(store, 'verdict-project')).projectUid;
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ path: repo }),
      projectUid,
    ]);
    // A known TERMINAL and a known NON-terminal status, so the read/write
    // agreement test below can exercise every `applies_to.to` shape against a
    // real catalog.
    await seedStatus(store, 'RESOLVED', true);
    await seedStatus(store, 'IN_PROGRESS', false);
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

  async function nodeOf(uid: string): Promise<NodeRecord> {
    const node = await store.graph.getNodeByUid(uid);
    if (node === null) throw new Error(`fixture: no node for uid ${uid}`);
    return node;
  }

  async function block(blocker: string, dependent: string): Promise<void> {
    await relate(store, {
      sourceUid: blocker,
      targetUid: dependent,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });
  }

  function commit(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git(repo, ['add', rel]);
    git(repo, ['commit', '-qm', `add ${rel}`]);
  }

  // -------------------------------------------------------------------------
  // AC4
  // -------------------------------------------------------------------------
  it('AC4 — the verdict is derived, not stored: unblocking flips actionability with the dependent revision unchanged', async () => {
    const blocker = await issue('ac4 blocker');
    const dependent = await issue('ac4 dependent');
    await block(blocker, dependent);

    const before = await deriveVerdict(store.graph, await nodeOf(dependent));
    expect(before.actionable).toBe(false);
    const blocked = before.conditions.find((c) => c.code === 'BlockedBy');
    expect(blocked?.status).toBe('True');
    expect(blocked?.subject).toBe(blocker);
    const revBefore = before.revision;

    // Transition the BLOCKER to terminal. The dependent is not written at all.
    await transition(store, {
      uid: blocker,
      by: 'closer:1',
      toStatus: 'RESOLVED',
      note: 'blocker done',
    });

    const after = await deriveVerdict(store.graph, await nodeOf(dependent));
    expect(after.actionable).toBe(true);
    expect(after.conditions.some((c) => c.code === 'BlockedBy')).toBe(false);
    // The dependent's monotonic content revision did NOT move.
    expect(after.revision).toBe(revBefore);
    expect(readRevision((await nodeOf(dependent)).metadata)).toBe(revBefore);

    // NEGATIVE CONTROL: caching the verdict on the DEPENDENT (writing
    // `meta.revision`) would move `after.revision` past `revBefore` → the two
    // revision assertions above go red.
  });

  it('AC4 (control) — a stored write DOES move the revision, so the unchanged-revision assertion above has teeth', async () => {
    const uid = await issue('ac4 control');
    const node = await nodeOf(uid);
    const rev0 = readRevision(node.metadata);
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ ...(node.metadata ?? {}), revision: rev0 + 1 }),
      uid,
    ]);
    expect(readRevision((await nodeOf(uid)).metadata)).toBe(rev0 + 1);
  });

  // -------------------------------------------------------------------------
  // AC5
  // -------------------------------------------------------------------------
  it('AC5 — computeActionable: block/True ⇒ false, block/Unknown ⇒ unknown (never true)', () => {
    const block = (status: ICondition['status']): ICondition => ({
      type: 'Blocked',
      status,
      severity: 'block',
      code: 'BlockedBy',
    });
    expect(computeActionable([block('True')])).toBe(false);
    expect(computeActionable([block('Unknown')])).toBe('unknown');
    expect(computeActionable([block('Unknown')])).not.toBe(true);
    expect(computeActionable([block('False')])).toBe(true);
    expect(computeActionable([])).toBe(true);
    // A definite block beats an uncertain one.
    expect(computeActionable([block('Unknown'), block('True')])).toBe(false);
    // warn never affects actionability.
    expect(
      computeActionable([
        { type: 'Claim', status: 'True', severity: 'warn', code: 'ClaimStale' },
      ])
    ).toBe(true);

    // NEGATIVE CONTROL: defaulting `'unknown'` to `true` in `computeActionable`
    // makes the two `toBe('unknown')` assertions above go red.
  });

  it('AC5 — orderConditions puts every block before every warn', () => {
    const ordered = orderConditions([
      { type: 'Claim', status: 'True', severity: 'warn', code: 'ClaimStale' },
      { type: 'Blocked', status: 'True', severity: 'block', code: 'BlockedBy' },
      { type: 'Obligation', status: 'True', severity: 'warn', code: 'MissingObligation' },
    ]);
    expect(ordered.map((c) => c.severity)).toEqual(['block', 'warn', 'warn']);
  });

  it('AC5 — a real Blocked/True verdict is actionable:false; every condition carries a stable code + subject', async () => {
    const blocker = await issue('ac5 blocker');
    const dependent = await issue('ac5 dependent');
    await block(blocker, dependent);
    const verdict = await deriveVerdict(store.graph, await nodeOf(dependent));

    const blocked = verdict.conditions.filter(
      (c) => c.severity === 'block' && c.status === 'True'
    );
    expect(blocked.length).toBeGreaterThan(0);
    expect(verdict.actionable).toBe(false);
    for (const c of verdict.conditions) {
      expect(typeof c.code).toBe('string');
      expect(c.code.length).toBeGreaterThan(0);
    }
    expect(blocked[0]!.subject).toBe(blocker);
    // block/True ⇔ actionable:false correlation holds in BOTH directions.
    expect(verdict.actionable === false).toBe(blocked.length > 0);
  });

  it('AC5 — a rung-budget stop yields unknown, never a green light', async () => {
    const uid = await issue('ac5 budget');
    // Rung 2 (obligations) was never run at maxRung:1 — the honest answer is unknown.
    const stopped = await deriveVerdict(store.graph, await nodeOf(uid), {
      maxRung: 1,
    });
    expect(stopped.actionable).toBe('unknown');
    expect(stopped.actionable).not.toBe(true);
    expect(
      stopped.conditions.some(
        (c) => c.severity === 'block' && c.status === 'Unknown'
      )
    ).toBe(true);

    // NEGATIVE CONTROL: if `computeActionable` rendered a block/Unknown as
    // `true`, the `toBe('unknown')` assertion above goes red.
  });

  it('AC5 — a satisfied evidence obligation is NOT certified true below rung 3 (list cannot afford the rung)', async () => {
    const blockerless = await issue('ac5 evidence');
    // Scoped to a KNOWN NON-terminal status: rung 2 evaluates ONLY the
    // obligations that do NOT predict a close (the write gate's own skip, which
    // the read verdict now mirrors), so a close-scoped obligation would be
    // skipped entirely and never reach the evidence ladder.
    await obligate(store, {
      uid: blockerless,
      applies_to: { to: 'IN_PROGRESS' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    commit('artifact.txt', 'artifact-alpha');
    // `obligate` bumped the issue's revision — attest against the CURRENT one.
    const rev = readRevision((await nodeOf(blockerless)).metadata);
    await attest(store, {
      subject: { id: blockerless, revision: rev },
      claim: { kind: 'published-artifact' },
      anchor: { locator: 'path:artifact.txt', digest: sha256('artifact-alpha') },
      by: 'attester:1',
    });

    // Rung 2 (list bound): predicate is satisfied from stored state, but the
    // anchor has not been re-resolved — genuinely unknown, never true.
    const rung2 = await deriveVerdict(store.graph, await nodeOf(blockerless), {
      maxRung: 2,
    });
    expect(rung2.actionable).toBe('unknown');
    expect(rung2.actionable).not.toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC7
  // -------------------------------------------------------------------------
  it('AC7 — ClaimStale is a warn (reported, never blocking); the honest floor is actionable:true', async () => {
    // Honest floor: no obligation, no blocker.
    const floorUid = await issue('ac7 floor');
    const floor = await deriveVerdict(store.graph, await nodeOf(floorUid));
    expect(floor.actionable).toBe(true);
    const missing = floor.conditions.find((c) => c.code === 'MissingObligation');
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('warn');
    expect(missing!.status).toBe('True');

    // ClaimStale: a fresh claim with a zero threshold is immediately stale.
    await claim(store, { uid: floorUid, by: 'holder:1', action: 'claim' });
    const stale = await deriveVerdict(store.graph, await nodeOf(floorUid), {
      claimStaleAfterMin: 0,
    });
    const staleCond = stale.conditions.find((c) => c.code === 'ClaimStale');
    expect(staleCond).toBeDefined();
    expect(staleCond!.severity).toBe('warn');
    expect(staleCond!.subject).toBe('holder:1');
    // A warn never flips actionability.
    expect(stale.actionable).toBe(true);

    // NEGATIVE CONTROL: making `MissingObligation` `severity:'block'` (with
    // status 'True') turns the floor item's `actionable` into `false` → the
    // two `toBe(true)` assertions above go red.
  });

  // -------------------------------------------------------------------------
  // Read/write verdict agreement (BUG bfc185f4) — the read verdict must apply
  // the SAME close-predictor skip the write gate's `evaluateVerdictTx` does.
  // -------------------------------------------------------------------------
  it('READ/WRITE AGREEMENT — the read verdict and the write gate skip EXACTLY the same obligations (close-predictor matrix)', async () => {
    // `evaluateVerdictTx` (write/gate.ts) skips an obligation whose
    // `applies_to.to` predicts a close — `to === '*' || terminal.has(to) ||
    // !all.has(to)` — and evaluates every other one. The read verdict must
    // answer identically for EVERY shape; a drift on either side turns one of
    // these rows red.
    const unknown = `NOPE_${Date.now()}`;
    const shapes: Array<{ to: string; rung2Block: boolean }> = [
      { to: '*', rung2Block: false }, // any-terminal wildcard ⇒ predicts close
      { to: 'RESOLVED', rung2Block: false }, // known TERMINAL status
      { to: unknown, rung2Block: false }, // unknown status name ⇒ close-predictor
      { to: 'IN_PROGRESS', rung2Block: true }, // known NON-terminal status
    ];
    for (const { to, rung2Block } of shapes) {
      const uid = await issue(`agreement ${to}`);
      const ob = await obligate(store, {
        uid,
        applies_to: { to },
        requirement: { op: 'evidence', kind: 'published-artifact' },
        on_fail: 'block',
        by: 'declarer:1',
      });

      // READ path — `get`'s graph-backed verdict at rung 2.
      const verdict = await deriveVerdict(store.graph, await nodeOf(uid), {
        maxRung: 2,
      });
      const readBlocked = verdict.conditions.some(
        (c) => c.severity === 'block' && c.status === 'True'
      );
      expect(readBlocked, `read verdict block for to="${to}"`).toBe(rung2Block);
      expect(verdict.actionable, `read actionability for to="${to}"`).toBe(
        !rung2Block
      );

      // WRITE path — `claim` runs `evaluateVerdictTx` (rungs 1–2); a block/True
      // condition refuses the claim.
      let writeRefused = false;
      try {
        await claim(store, { uid, by: 'claimer:1', action: 'claim' });
      } catch (err) {
        if (err instanceof PreconditionRefusedError) writeRefused = true;
        else throw err;
      }
      expect(writeRefused, `write gate refusal for to="${to}"`).toBe(rung2Block);
      // The two paths answer the SAME question identically — this is the
      // drift guard: it fails the moment either path's predicate changes.
      expect(readBlocked).toBe(writeRefused);

      // A close-predicting shape produced NO condition naming the obligation;
      // the non-terminal shape produced exactly that obligation's condition.
      expect(
        verdict.conditions.some((c) => c.subject === ob.obligationUid),
        `obligation named in verdict for to="${to}"`
      ).toBe(rung2Block);
    }
  });
});

describe('C6 verdict — the READ verdict agrees with the WRITE gate over the mounted api', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;

  beforeEach(async () => {
    tmp = await openTmpStore('c6-verdict-agreement');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('a terminal-scoped unsatisfied `block` obligation does NOT block `get fields:["verdict"]` (matching `claim`), yet the close refuses `precondition_failed`', async () => {
    const project = await upsertProject(ctx, {
      name: 'c6-verdict-agreement-project',
      by: 'filer',
    });
    if (!project.ok) throw new Error('fixture: upsertProject failed');
    const created = await create(ctx, {
      project: project.data.uid,
      title: 'proof due at close',
      body: 'b',
      by: 'filer',
    });
    if (!created.ok || created.data?.uid === undefined) {
      throw new Error('fixture: create failed');
    }
    const uid = created.data.uid;

    const ob = await apiObligate(ctx, {
      uid,
      applies_to: { to: 'closed' },
      requirement: { op: 'evidence', kind: 'published-artifact' },
      on_fail: 'block',
      by: 'declarer:1',
    });
    expect(ob.ok).toBe(true);

    // (a) READ path: `get fields:["verdict"]` reports the item actionable — the
    // close-predicting obligation contributes NO rung-2 block condition.
    const card = await apiGet(ctx, { uid, fields: ['verdict'] });
    expect(card.ok).toBe(true);
    if (!card.ok) throw new Error('expected an ok envelope');
    const verdict = (card.data as IIssueCard).verdict;
    expect(verdict).toBeDefined();
    if (verdict === undefined) throw new Error('expected a derived verdict');
    expect(verdict.actionable).toBe(true);
    expect(
      verdict.conditions.some(
        (c) => c.severity === 'block' && c.status === 'True'
      )
    ).toBe(false);

    // (b) WRITE path: the SAME obligation does not refuse `claim` — the two
    // paths give one answer.
    const claimed = await apiClaim(ctx, {
      uid,
      by: 'claimer:1',
      action: 'claim',
    });
    expect(claimed.ok).toBe(true);

    // (c) The close is STILL refused by that same obligation, as the typed
    // `precondition_failed` carrying the gate's structured refusal.
    const closed = await apiTransition(ctx, {
      uid,
      by: 'claimer:1',
      toStatus: 'closed',
      note: 'close it',
    });
    expect(closed.ok).toBe(false);
    if (closed.ok) throw new Error('expected a failure envelope');
    expect(closed.error.code).toBe('precondition_failed');
    const refusal = closed.error.details?.refusal as
      | { code?: string }
      | undefined;
    expect(refusal?.code).toBe('EvidenceUnverified');
  });
});

/** Seeds a `status` catalog row carrying the given `terminal` flag. */
async function seedStatus(
  store: TestIssueStore,
  name: string,
  terminal: boolean
): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      await writeNodeTx(tx, {
        kind: 'status',
        name,
        metadata: { terminal },
        at: nowISO(),
      });
    },
    { mode: 'immediate' }
  );
}
