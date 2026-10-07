/**
 * transition.claim-held.spec.ts — 46d5873b (the ticket states no numbered ACs;
 * AC1..AC2 map to its stated expectations). Decision (coordinator, option A):
 * the code conforms to SPEC-SET S02 AC15, so a transition against another
 * actor's live claim is a typed `validation` error (`details.reason:
 * 'actor_mismatch'`), while a competing `claim` keeps `conflict`; the CHANGELOG
 * and error docs record that split.
 *   AC1  transition by a non-holder: `validation`, never `conflict`, nothing written;
 *   AC2  the contrasting lease race, `claim` by a non-holder, stays `conflict`.
 *
 * UNIT tests (real store + real verbs). Negative control (run once, restored):
 * throw `ClaimHeldError` from transition.ts -> AC1 red (`conflict`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

describe('46d5873b — transition vs held claim is validation; claim vs held claim is conflict', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let uid: string;

  beforeEach(async () => {
    tmp = await openTmpStore('transition-claim-held');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const p = await api.upsertProject(ctx, { name: 'claim-held', by: 'seed' });
    if (!p.ok) throw new Error(JSON.stringify(p));
    const c = await api.create(ctx, { project: (p.data as { uid: string }).uid, title: 't', body: 'b', by: 'seed' });
    if (!c.ok) throw new Error(JSON.stringify(c));
    uid = (c.data as { uid: string }).uid;
    expect((await api.claim(ctx, { uid, by: 'agent-a', action: 'claim' })).ok).toBe(true);
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('46d5873b AC1 — transition by a non-holder is validation/actor_mismatch (not conflict) and leaves the status unchanged', async () => {
    const out = await api.transition(ctx, { uid, by: 'agent-b', toStatus: 'IN_PROGRESS', note: 'n' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
    expect(out.error.code).not.toBe('conflict');
    expect(out.error.details).toMatchObject({ reason: 'actor_mismatch', verb: 'transition', heldBy: 'agent-a' });
    const got = await api.get(ctx, { uid, fields: ['status'] });
    expect(got.ok && (got.data as unknown as { status: string }).status).not.toBe('IN_PROGRESS');
  });

  it('46d5873b AC2 — claim by a non-holder of a live claim stays conflict', async () => {
    const out = await api.claim(ctx, { uid, by: 'agent-b', action: 'claim' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('conflict');
  });
});
