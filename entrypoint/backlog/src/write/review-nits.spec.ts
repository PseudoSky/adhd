/**
 * review-nits.spec.ts — abf5c108 (the ticket lists nits (a)..(g) and no numbered
 * ACs; each AC below is named for its nit letter):
 *   AC(e)  membership canonicalises paths like reservation.ts: a citation
 *          through a symlink reaches the component registered at the real path;
 *   AC(f)  re-labelling an `in_component` row (citation removed, another
 *          added) supersedes in place — exactly ONE live edge per component;
 *   AC(c)  the timeline descendant walk flags `truncated` instead of stopping
 *          silently at MAX_SESSION_DEPTH;
 *   AC(d)  op-event multiplicity: each verb call appends one op-event per
 *          `writeAudit` it performs — measured here for create/claim/transition
 *          (exactly one each), so the session.ts header holds for these verbs.
 * (a), (b) are comment/JSDoc placement only; (g) is left as a reserved-name check.
 *
 * UNIT tests (real store + real verbs). Negative controls (run once, restored):
 * (e) use `resolvePath` instead of `canonicalMembershipPath` for the root ->
 * AC(e) red; (c) drop the `truncated` computation -> AC(c) red.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';
import type { IOutcomeEnvelope } from '../envelope.js';
import { MAX_SESSION_DEPTH } from '../query/views/timeline.js';

function data<T>(r: IOutcomeEnvelope<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.data;
}

describe('abf5c108 — phase-6 A+B review nits', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let root: string;
  let p1: string;
  let c1: string;
  let c2: string;

  async function liveInComponent(issue: string, component: string): Promise<number> {
    const r = await tmp.store.adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edge e
         JOIN node i ON i.rowid = e.src AND i.uid = ?
         JOIN node k ON k.rowid = e.dst AND k.uid = ?
       WHERE e.rel = 'in_component' AND e.t_invalid IS NULL`,
      [issue, component]
    );
    return Number(r?.c);
  }

  beforeEach(async () => {
    tmp = await openTmpStore('review-nits');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    root = join(tmp.dir, 'proj');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'a.ts'), 'a\n');
    writeFileSync(join(root, 'b', 'b1.ts'), '1\n');
    writeFileSync(join(root, 'b', 'b2.ts'), '2\n');
    p1 = data(await api.upsertProject(ctx, { name: 'proj', path: root, by: 's' })).uid;
    c1 = data(await api.upsertComponent(ctx, { project: p1, name: 'a', by: 's' })).uid;
    c2 = data(await api.upsertComponent(ctx, { project: p1, name: 'b', by: 's' })).uid;
    data(await api.upsertLocation(ctx, { component: c1, locType: 'path', value: join(root, 'a'), by: 's' }));
    data(await api.upsertLocation(ctx, { component: c2, locType: 'path', value: join(root, 'b'), by: 's' }));
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('abf5c108 AC(e) — a citation through a symlink reaches the component registered at the real path', async () => {
    const link = join(tmp.dir, 'link-to-b');
    symlinkSync(join(root, 'b'), link);
    const issue = data(
      await api.create(ctx, {
        project: p1,
        component: c1,
        title: 'cites via symlink',
        body: 'b',
        by: 'filer',
        citations: [{ file: join(link, 'b1.ts') }],
      } as never)
    ).uid as string;
    const card = data(await api.get(ctx, { uid: issue, fields: ['memberships'] })) as unknown as {
      memberships: Array<{ componentUid: string; via: string }>;
    };
    expect(card.memberships.map((m) => `${m.via}:${m.componentUid}`).sort()).toEqual(
      [`primary:${c1}`, `citation:${c2}`].sort()
    );
  });

  it('abf5c108 AC(f) — re-labelling an in_component row supersedes, never duplicates', async () => {
    const issue = data(
      await api.create(ctx, {
        project: p1,
        component: c1,
        title: 'relabel',
        body: 'b',
        by: 'filer',
        citations: [{ file: join(root, 'b', 'b1.ts') }],
      } as never)
    ).uid as string;
    expect(await liveInComponent(issue, c2)).toBe(1);
    // Swap the evidence: drop the b1 citation, add b2 — the membership row is re-labelled onto the new citation.
    const out = data(
      await api.update(ctx, { uid: issue, by: 'filer', citations: [{ file: join(root, 'b', 'b2.ts') }] } as never)
    ) as { uid: string };
    expect(await liveInComponent(out.uid, c2)).toBe(1);
  });

  it('abf5c108 AC(c) — the timeline descendant walk flags truncated past MAX_SESSION_DEPTH, and is not truncated within it', async () => {
    const total = MAX_SESSION_DEPTH + 2; // S0 .. S(total-1): the deepest children lie beyond the cap
    for (let i = 0; i < total; i += 1) {
      data(
        await api.create(ctx, {
          project: p1,
          title: `s${i}`,
          body: 'b',
          by: 'agent-1',
          sessionId: `S${i}`,
          ...(i > 0 ? { parentSessionId: `S${i - 1}` } : {}),
        } as never)
      );
    }
    const deep = data(await api.timeline(ctx, { sessionId: 'S0' } as never)) as { children: string[]; truncated?: boolean };
    expect(deep.children).toHaveLength(MAX_SESSION_DEPTH);
    expect(deep.truncated).toBe(true);
    const shallow = data(await api.timeline(ctx, { sessionId: `S${total - 3}` } as never)) as { truncated?: boolean };
    expect(shallow.truncated).toBeUndefined();
  });

  it('abf5c108 AC(d) — create, claim and transition each append exactly one op-event for their session', async () => {
    const issue = data(
      await api.create(ctx, { project: p1, title: 'm', body: 'b', by: 'agent-1', sessionId: 'M1' } as never)
    ).uid as string;
    data(await api.claim(ctx, { uid: issue, by: 'agent-1', action: 'claim', sessionId: 'M2' } as never));
    data(await api.transition(ctx, { uid: issue, by: 'agent-1', toStatus: 'in_progress', note: 'n', sessionId: 'M3' } as never));
    for (const s of ['M1', 'M2', 'M3']) {
      const t = data(await api.timeline(ctx, { sessionId: s } as never)) as { ops: unknown[] };
      expect(t.ops, s).toHaveLength(1);
    }
  });
});
