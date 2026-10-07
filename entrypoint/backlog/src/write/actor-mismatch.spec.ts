/**
 * actor-mismatch.spec.ts — 65029970 A-AC11 (S02 AC15): a write verb whose
 * actor mismatches the claim holder returns a typed `validation` error with
 * `details.reason === 'actor_mismatch'`, never a bare `conflict` /
 * `ClaimHeldError`.
 *
 * Real components: a real store + the real `api.ts` verbs. Negative control
 * (run once, restored): revert `transition.ts`/`claim.ts` to `ClaimHeldError` —
 * the transition/renew rows go red (`conflict`, no `reason`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

describe('65029970 A-AC11 — actor mismatch is a typed validation error', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let uid: string;
  let project: string;

  beforeEach(async () => {
    tmp = await openTmpStore('actor-mismatch');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const p = await api.upsertProject(ctx, { name: 'actor-mismatch', by: 'seed' });
    if (!p.ok) throw new Error(JSON.stringify(p));
    project = (p.data as { uid: string }).uid;
    const c = await api.create(ctx, { project, title: 't', body: 'b', by: 'seed' });
    if (!c.ok) throw new Error(JSON.stringify(c));
    uid = (c.data as { uid: string }).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('65029970 A-AC11 — transition by a non-holder of a live claim: validation + actor_mismatch details', async () => {
    expect((await api.claim(ctx, { uid, by: 'agent-a', action: 'claim' })).ok).toBe(true);
    const out = await api.transition(ctx, { uid, by: 'agent-b', toStatus: 'IN_PROGRESS', note: 'n' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
    expect(out.error.details).toMatchObject({
      reason: 'actor_mismatch',
      verb: 'transition',
      actor: 'agent-b',
      heldBy: 'agent-a',
    });
    expect(out.error.details?.['heldSince']).toEqual(expect.any(String));
  });

  it('65029970 A-AC11 — renew by a non-holder: validation + actor_mismatch, claim unchanged', async () => {
    await api.claim(ctx, { uid, by: 'agent-a', action: 'claim' });
    const out = await api.claim(ctx, { uid, by: 'agent-b', action: 'renew' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
    expect(out.error.details).toMatchObject({ reason: 'actor_mismatch', verb: 'renew', heldBy: 'agent-a' });
    const again = await api.claim(ctx, { uid, by: 'agent-a', action: 'renew' });
    expect(again.ok).toBe(true);
  });

  it('65029970 A-AC11 — renew on an unclaimed item: validation with no heldBy (no empty-holder sentinel)', async () => {
    const out = await api.claim(ctx, { uid, by: 'agent-a', action: 'renew' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
    expect(out.error.details).toMatchObject({ reason: 'actor_mismatch', verb: 'renew' });
    expect(out.error.details).not.toHaveProperty('heldBy');
  });

  it('65029970 A-AC11 — claim-verb contention stays `conflict` (a lease race with a remedy, not an identity error)', async () => {
    await api.claim(ctx, { uid, by: 'agent-a', action: 'claim' });
    const out = await api.claim(ctx, { uid, by: 'agent-b', action: 'claim' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('conflict');
    expect(out.error.details).not.toHaveProperty('reason', 'actor_mismatch');
  });

  it('65029970 A-AC11 — a STALE claim does not block another actor transitioning', async () => {
    await tmp.store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ policy: { claimStaleAfterMin: 0 } }),
      project,
    ]);
    await api.claim(ctx, { uid, by: 'agent-a', action: 'claim' });
    const out = await api.transition(ctx, { uid, by: 'agent-b', toStatus: 'IN_PROGRESS', note: 'n' });
    expect(out.ok).toBe(true);
  });
});
