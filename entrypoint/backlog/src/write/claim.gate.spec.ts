/**
 * claim.gate.spec.ts — C6's behavioral proofs for `claim`'s verdict
 * precondition, driven through the REAL `claim` verb against a REAL store.
 * Nothing is mocked: the thing under test is `claim.ts` wired to
 * `write/gate.ts`'s `evaluateVerdictTx` (rungs 1–2).
 *
 * - **AC1** claim refuses a live blocker, naming it; the item stays unclaimed.
 * - **AC2** claim on an unblocked item succeeds.
 * - **AC3** `force:true` succeeds and records the named blocker on the audit note.
 * - the mounted `api` maps the refusal to `precondition_failed` + `details.refusal`.
 *
 * ## Negative controls
 *
 * Each AC's negative control is a one-line local revert run live during
 * development (remove the gate call in `claim.ts`; make the gate always throw;
 * drop the blocker from the audit note) — revert → red → restore → green. The
 * assertions below are written so each of those reverts turns the matching test
 * red (see the per-test comments for the exact revert).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir, openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { claim } from './claim.js';
import { relate } from './relate.js';
import { PreconditionRefusedError } from './errors.js';
import { getIssue } from '../query/get.js';
import { buildBacklogEnv } from '../env.js';
import {
  claim as apiClaim,
  create,
  obligate as apiObligate,
  relate as apiRelate,
  transition as apiTransition,
  upsertProject,
  type BacklogCtx,
} from '../api.js';

describe('C6 claim gate — a live blocker refuses the claim (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('claim-gate-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    mkdirSync(join(dir, 'repo'), { recursive: true });
    projectUid = (await seedProject(store, 'claim-gate-project')).projectUid;
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

  /** `blocker` blocks `dependent` (edge blocker --blocks--> dependent). */
  async function block(blocker: string, dependent: string): Promise<void> {
    await relate(store, {
      sourceUid: blocker,
      targetUid: dependent,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });
  }

  async function claimedByOf(uid: string): Promise<string | undefined> {
    const card = await getIssue(store.graph, { uid, fields: ['auditTrail'] });
    void card;
    const row = await store.adapter.executeGet<{ meta: string | null }>(
      'SELECT meta FROM node WHERE uid = ?',
      [uid]
    );
    const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    return typeof meta['claimedBy'] === 'string' ? meta['claimedBy'] : undefined;
  }

  // -------------------------------------------------------------------------
  // AC1
  // -------------------------------------------------------------------------
  it('AC1 — claim on a blocked item throws PreconditionRefusedError naming the blocker; item stays unclaimed', async () => {
    const blocker = await issue('ac1 blocker');
    const dependent = await issue('ac1 dependent');
    await block(blocker, dependent);

    let refusal: PreconditionRefusedError | undefined;
    try {
      await claim(store, { uid: dependent, by: 'claimer:1', action: 'claim' });
    } catch (err) {
      if (err instanceof PreconditionRefusedError) refusal = err;
      else throw err;
    }
    expect(refusal).toBeDefined();
    expect(refusal!.refusal.code).toBe('BlockedBy');
    expect(refusal!.refusal.subject).toBe(blocker);
    expect(await claimedByOf(dependent)).toBeUndefined();

    // NEGATIVE CONTROL: removing the `namedBlocker !== undefined && !force`
    // throw in `claim.ts` lets this claim succeed → `refusal` stays undefined
    // and `claimedByOf` becomes 'claimer:1' → both assertions above go red.
  });

  // -------------------------------------------------------------------------
  // AC2
  // -------------------------------------------------------------------------
  it('AC2 — claim on an unblocked item succeeds', async () => {
    const uid = await issue('ac2 unblocked');
    const outcome = await claim(store, { uid, by: 'claimer:2', action: 'claim' });
    expect(outcome.status).toBe('claimed');
    expect(await claimedByOf(uid)).toBe('claimer:2');

    // NEGATIVE CONTROL: making the gate throw unconditionally (ignore
    // `blocking.length`) turns this claim into a PreconditionRefusedError → red.
  });

  // -------------------------------------------------------------------------
  // AC3
  // -------------------------------------------------------------------------
  it('AC3 — force:true claims a blocked item and records the named blocker on the audit note', async () => {
    const blocker = await issue('ac3 blocker');
    const dependent = await issue('ac3 dependent');
    await block(blocker, dependent);

    const outcome = await claim(store, {
      uid: dependent,
      by: 'forcer:1',
      action: 'claim',
      force: true,
    });
    expect(outcome.status).toBe('claimed');
    expect(await claimedByOf(dependent)).toBe('forcer:1');

    const card = await getIssue(store.graph, {
      uid: dependent,
      fields: ['auditTrail'],
    });
    const notes = (card.auditTrail ?? []).map((a) => a.note ?? '');
    expect(
      notes.some(
        (n) => n.includes('force-claimed despite BlockedBy') && n.includes(blocker)
      )
    ).toBe(true);

    // NEGATIVE CONTROL: dropping `forceNote` from the branch's `writeAudit`
    // note (passing `note: undefined`) leaves the audit trail without the
    // named blocker → the `notes.some(...)` assertion goes red.
  });

  it('release/renew stay ungated (cleanup on a blocked item still succeeds)', async () => {
    const blocker = await issue('cleanup blocker');
    const dependent = await issue('cleanup dependent');
    // Claim while unblocked, THEN a blocker appears — release is cleanup and
    // must still succeed on the now-blocked item.
    await claim(store, { uid: dependent, by: 'holder:1', action: 'claim' });
    await block(blocker, dependent);
    const released = await claim(store, { uid: dependent, by: 'holder:1', action: 'release' });
    expect(released.status).toBe('released');
  });
});

describe('C6 claim gate — the mounted api maps the refusal to precondition_failed + details.refusal', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;

  beforeEach(async () => {
    tmp = await openTmpStore('c6-claim-api');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('a blocked claim yields {code:precondition_failed, details.refusal:{code:BlockedBy,subject}}', async () => {
    const project = await upsertProject(ctx, { name: 'c6-claim-api-project', by: 'filer' });
    if (!project.ok) throw new Error('fixture: upsertProject failed');
    const projectUid = project.data.uid;
    const blocker = await create(ctx, {
      project: projectUid,
      title: 'api blocker',
      body: 'b',
      by: 'filer',
    });
    const dependent = await create(ctx, {
      project: projectUid,
      title: 'api dependent',
      body: 'b',
      by: 'filer',
    });
    if (
      !blocker.ok ||
      blocker.data?.uid === undefined ||
      !dependent.ok ||
      dependent.data?.uid === undefined
    ) {
      throw new Error('fixture: create failed');
    }
    const blockerUid = blocker.data.uid;
    const dependentUid = dependent.data.uid;
    const rel = await apiRelate(ctx, {
      sourceUid: blockerUid,
      targetUid: dependentUid,
      rel: 'blocks',
      action: 'add',
      by: 'relater:1',
    });
    expect(rel.ok).toBe(true);

    const out = await apiClaim(ctx, {
      uid: dependentUid,
      by: 'claimer:1',
      action: 'claim',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('precondition_failed');
    const refusal = out.error.details?.refusal as
      | { code: string; subject?: string }
      | undefined;
    expect(refusal?.code).toBe('BlockedBy');
    expect(refusal?.subject).toBe(blockerUid);
  });

  // Demo beat 3.3 — a block obligation that only fires at the terminal
  // transition must not refuse the claim; it still refuses the close.
  it('a terminal-scoped block obligation does NOT refuse `claim`, yet the close is precondition_failed (demo beat 3.3)', async () => {
    const project = await upsertProject(ctx, {
      name: 'c6-terminal-obligation-project',
      by: 'filer',
    });
    if (!project.ok) throw new Error('fixture: upsertProject failed');
    const created = await create(ctx, {
      project: project.data.uid,
      title: 'proof due at close',
      body: 'b',
      by: 'filer',
    });
    if (!created.ok || created.data.uid === undefined) {
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

    // (a) The obligation is not due at the claim rung — `claim` takes the work.
    const claimed = await apiClaim(ctx, { uid, by: 'claimer:1', action: 'claim' });
    expect(claimed.ok).toBe(true);

    // (b) The close is still refused by the SAME obligation, as the typed
    // `precondition_failed` + `details.refusal`.
    const out = await apiTransition(ctx, {
      uid,
      by: 'claimer:1',
      toStatus: 'closed',
      note: 'close it',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a failure envelope');
    expect(out.error.code).toBe('precondition_failed');
    const refusal = out.error.details?.refusal as { code: string } | undefined;
    expect(refusal?.code).toBe('EvidenceUnverified');
  });
});
