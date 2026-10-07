/**
 * timeline.spec.ts — 91a8c640 B-AC7 (S11.S3/S4): `timeline S1` returns the
 * agent, the session and the ORDERED ops including those of child session S1.1;
 * an unknown session is `item_not_found`. The "unknown verb on the pre-change
 * build" negative control is in `timeline.e2e.ts` (drives the built bin).
 *
 * Real store + real api verbs.
 *
 * Negative control (run once, restored): dropping the descendant walk makes the
 * child's ops absent, so the "includes S1.1" row goes red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import type { ITimelineResult } from './views/timeline.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('91a8c640 B-AC7 — timeline', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let project: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    tmp = await openTmpStore('timeline');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    project = data(await api.upsertProject(ctx, { name: 'p', by: 's' })).uid;
    // S1 (agent-1): create a, claim a. S1.1 (agent-2, child of S1): create b, transition b.
    a = data(await api.create(ctx, { project, title: 'a', body: 'ab', by: 'agent-1', sessionId: 'S1' } as never)).uid as string;
    data(await api.claim(ctx, { uid: a, by: 'agent-1', action: 'claim', sessionId: 'S1' } as never));
    b = data(await api.create(ctx, { project, title: 'b', body: 'bb', by: 'agent-2', sessionId: 'S1.1', parentSessionId: 'S1' } as never)).uid as string;
    data(await api.transition(ctx, { uid: b, by: 'agent-2', toStatus: 'in_progress', note: 'child works', sessionId: 'S1.1' } as never));
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  const tl = async (input: Record<string, unknown>): Promise<ITimelineResult> =>
    data(await api.timeline(ctx, input as never));

  it('91a8c640 B-AC7 returns agent, session and the ordered ops including the child session S1.1', async () => {
    const r = await tl({ sessionId: 'S1' });
    expect(r.session).toMatchObject({ sessionId: 'S1', agent: 'agent-1' });
    expect(r.session.parentSessionId).toBeUndefined();
    expect(r.children).toEqual(['S1.1']);
    expect(r.ops.map((o) => `${o.sessionId}:${o.op}:${o.agent}`)).toEqual([
      'S1:created:agent-1',
      'S1:claimed:agent-1',
      'S1.1:created:agent-2',
      'S1.1:transitioned:agent-2',
    ]);
    const times = r.ops.map((o) => o.t);
    expect([...times].sort()).toEqual(times); // ordered
    expect(r.touched).toEqual([a, b].sort());
    expect(r.ops[3]!.delta).toMatchObject({ to: 'in_progress', note: 'child works' });
    expect(r.hasMore).toBe(false);
  });

  it('91a8c640 B-AC7 includeChildren:false returns only the session’s own ops; the child reports its parent', async () => {
    const own = await tl({ sessionId: 'S1', includeChildren: false });
    expect(own.children).toEqual([]);
    expect(own.ops.every((o) => o.sessionId === 'S1')).toBe(true);
    expect(own.ops).toHaveLength(2);
    const child = await tl({ sessionId: 'S1.1' });
    expect(child.session.parentSessionId).toBe('S1');
    expect(child.ops).toHaveLength(2);
  });

  it('91a8c640 B-AC7 pages with limit/after cursors and never repeats or drops an op', async () => {
    const p1 = await tl({ sessionId: 'S1', limit: 3 });
    expect(p1.ops).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const p2 = await tl({ sessionId: 'S1', limit: 3, after: p1.nextCursor });
    expect(p2.ops).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    const full = await tl({ sessionId: 'S1' });
    expect([...p1.ops, ...p2.ops]).toEqual(full.ops);
    const bad = await api.timeline(ctx, { sessionId: 'S1', after: 'garbage' } as never);
    expect(bad.ok).toBe(false);
  });

  it('91a8c640 B-AC7 an unknown session is item_not_found and a blank id is a validation error', async () => {
    const r = await api.timeline(ctx, { sessionId: 'S-nope' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('item_not_found');
    const blank = await api.timeline(ctx, { sessionId: '' } as never);
    expect(blank.ok).toBe(false);
  });
});
