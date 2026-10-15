/**
 * note.spec.ts — `remove-note` (the `removeNote` verb, `write/note.ts`).
 *
 * Item 0f9b6132 (remove-note). Every assertion drives the REAL `api.removeNote`
 * envelope against a REAL store (`openTmpStore`), and reads state back through
 * direct SQL or the production read verbs (`api.get`), never through the
 * verb's own outcome object alone. Notes and the project's `policy.noteRemovers`
 * allow-list are seeded through `test/helpers/seed-note.ts` because no public
 * write path lets a test choose a note's recorded author or set the policy.
 *
 * Tier: S — in-process, real store, no subprocess and no mocked boundary.
 * Fidelity gap: none (the store is the production store class; only the seed
 * rows bypass the create-issue duplicate path, which needs an embedding).
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, freshTmpDir, type TmpStore } from '../test/helpers/tmp-store.js';
import { seedNote, setProjectNoteRemovers } from '../test/helpers/seed-note.js';
import {
  closeGraphBacklogStore,
  openGraphBacklogStore,
  type GraphBacklogStore,
} from '../store/graph-backlog-store.js';
import { buildBacklogEnv } from '../env.js';
import * as api from '../api.js';

interface IEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const AUTHOR = 'claude:1';
const MODERATOR = 'moderator:1';
const STRANGER = 'mallory:9';

/** Live note count, live has_note edge count, and total node/edge counts — read straight from SQL. */
async function snapshot(store: GraphBacklogStore): Promise<{
  nodes: number;
  edges: number;
  liveNotes: number;
  liveHasNote: number;
}> {
  const n = await store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
  const e = await store.adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM edge');
  const ln = await store.adapter.executeGet<{ c: number }>(
    "SELECT COUNT(*) AS c FROM node WHERE kind = 'note' AND t_invalid IS NULL"
  );
  const lh = await store.adapter.executeGet<{ c: number }>(
    "SELECT COUNT(*) AS c FROM edge WHERE rel = 'has_note' AND t_invalid IS NULL"
  );
  return {
    nodes: Number(n?.c),
    edges: Number(e?.c),
    liveNotes: Number(ln?.c),
    liveHasNote: Number(lh?.c),
  };
}

/** The note node's invalidation state and reason, read straight from SQL (never the verb's outcome). */
async function noteState(
  store: GraphBacklogStore,
  uid: string
): Promise<{ removed: boolean; reason: string | null }> {
  const row = await store.adapter.executeGet<{ removed: number; reason: string | null }>(
    `SELECT (t_invalid IS NOT NULL) AS removed, json_extract(meta, '$.invalidatedReason') AS reason
       FROM node WHERE uid = ?`,
    [uid]
  );
  return { removed: Number(row?.removed) === 1, reason: row?.reason ?? null };
}

/** Live `has_note` edge count from the issue to the note — direct SQL. */
async function liveHasNoteEdgesTo(store: GraphBacklogStore, noteUid: string): Promise<number> {
  const row = await store.adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE n.uid = ? AND e.rel = 'has_note' AND e.t_invalid IS NULL`,
    [noteUid]
  );
  return Number(row?.c);
}

/** Count of live `note-removed` audit rows attached to the issue. */
async function noteRemovedAuditCount(store: GraphBacklogStore, issueUid: string): Promise<number> {
  const row = await store.adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM edge e
       JOIN node issue ON issue.rowid = e.src
       JOIN node a ON a.rowid = e.dst
      WHERE issue.uid = ? AND e.rel = 'audits' AND e.t_invalid IS NULL
        AND json_extract(a.meta, '$.action') = 'note-removed'`,
    [issueUid]
  );
  return Number(row?.c);
}

/** Give two note nodes uids sharing one prefix, so that prefix is genuinely ambiguous (same technique as uid-verbs.ambiguity.spec.ts). */
async function renameNotesToSharedPrefix(
  store: GraphBacklogStore,
  uids: readonly string[],
  prefix: string
): Promise<string[]> {
  const out: string[] = [];
  let i = 1;
  for (const uid of uids) {
    const to = `${prefix}-${i}111-4111-8111-11111111111${i}`;
    await store.adapter.executeRun('UPDATE node SET uid = ? WHERE uid = ?', [to, uid]);
    out.push(to);
    i += 1;
  }
  return out;
}

const must = (r: IEnvelope, what: string): IEnvelope => {
  if (!r.ok) throw new Error(`fixture ${what}: ${JSON.stringify(r)}`);
  return r;
};

describe('0f9b6132 remove-note — removeNote verb (real store, envelope)', () => {
  let tmp: TmpStore;
  let ctx: api.BacklogCtx;
  let projectUid: string;
  let issueUid: string;

  beforeEach(async () => {
    tmp = await openTmpStore('note-removal');
    ctx = { store: tmp.store, env: buildBacklogEnv({ adhdRoot: tmp.dir }) };
    const p = must((await api.upsertProject(ctx, { name: 'note-removal-project', by: 'seed' })) as IEnvelope, 'project');
    projectUid = (p.data as { uid: string }).uid;
    const i = must((await api.create(ctx, { project: projectUid, title: 'host issue', body: 'host body', by: 'seed' })) as IEnvelope, 'issue');
    issueUid = (i.data as { uid: string }).uid;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // failure mode: an author cannot remove their own note, or the note stays visible on the card after removal
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC1
  it('0f9b6132 AC1 — the note\'s author removes their own note: the note and its has_note edge are invalidated, the reason is recorded, and the issue card omits the note', async () => {
    const note = await seedNote(tmp.store, { issueUid, text: 'duplicate of another item', author: AUTHOR });

    // Positive control: the note is visible on the card before removal, so the omission below is caused by the removal.
    const before = must((await api.get(ctx, { uid: issueUid, fields: ['notes'] })) as IEnvelope, 'get before');
    expect((before.data as { notes?: Array<{ uid: string }> }).notes?.map((n) => n.uid)).toEqual([note.uid]);

    const out = (await api.removeNote(ctx, { uid: note.uid, by: AUTHOR, reason: 'superseded by a newer item' })) as IEnvelope;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.data).toEqual({ uid: note.uid, issueUid, invalidated: true });

    expect(await noteState(tmp.store, note.uid)).toEqual({ removed: true, reason: 'superseded by a newer item' });
    expect(await liveHasNoteEdgesTo(tmp.store, note.uid)).toBe(0);

    const after = must((await api.get(ctx, { uid: issueUid, fields: ['notes'] })) as IEnvelope, 'get after');
    expect((after.data as { notes?: Array<{ uid: string }> }).notes ?? []).toEqual([]);
  });

  // failure mode: a listed moderator cannot remove a note they did not write (allow-list ignored, or author-only check too strict)
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC1
  it('0f9b6132 AC1 — an actor listed in project policy noteRemovers removes another actor\'s note, and the removal is accepted', async () => {
    await setProjectNoteRemovers(tmp.store, projectUid, [MODERATOR]);
    const note = await seedNote(tmp.store, { issueUid, text: 'spam to be cleaned up', author: AUTHOR });

    const out = (await api.removeNote(ctx, { uid: note.uid, by: MODERATOR, reason: 'spam' })) as IEnvelope;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(await noteState(tmp.store, note.uid)).toEqual({ removed: true, reason: 'spam' });
    expect(await liveHasNoteEdgesTo(tmp.store, note.uid)).toBe(0);
  });

  // failure mode: a removal with no reason is accepted, leaving the invalidation unexplained
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC1
  it('0f9b6132 AC1 — a blank reason is refused with invalid_argument and writes nothing', async () => {
    const note = await seedNote(tmp.store, { issueUid, text: 'needs a reason', author: AUTHOR });
    const before = await snapshot(tmp.store);

    const out = (await api.removeNote(ctx, { uid: note.uid, by: AUTHOR, reason: '   ' })) as IEnvelope;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('invalid_argument');

    expect(await snapshot(tmp.store)).toEqual(before);
    expect(await noteState(tmp.store, note.uid)).toEqual({ removed: false, reason: null });
  });

  // failure mode: a non-author, non-listed actor can remove someone else's note (authorization bypass)
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC2
  it('0f9b6132 AC2 — a non-author, non-listed actor gets precondition_failed, and the node, edge, and audit counts are unchanged', async () => {
    const note = await seedNote(tmp.store, { issueUid, text: 'not yours to remove', author: AUTHOR });
    const before = await snapshot(tmp.store);
    const auditBefore = await noteRemovedAuditCount(tmp.store, issueUid);

    const out = (await api.removeNote(ctx, { uid: note.uid, by: STRANGER, reason: 'trying anyway' })) as IEnvelope;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('precondition_failed');

    expect(await snapshot(tmp.store)).toEqual(before);
    expect(await noteRemovedAuditCount(tmp.store, issueUid)).toBe(auditBefore);
    expect(await noteState(tmp.store, note.uid)).toEqual({ removed: false, reason: null });
    expect(await liveHasNoteEdgesTo(tmp.store, note.uid)).toBe(1);
  });

  // failure mode: removing an already-removed note succeeds again (non-resurrection / double-removal not refused)
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC2
  it('0f9b6132 AC2 — a second removal of the same uid is refused with item_not_found, and the first removal\'s reason is preserved', async () => {
    const note = await seedNote(tmp.store, { issueUid, text: 'removed twice', author: AUTHOR });
    must((await api.removeNote(ctx, { uid: note.uid, by: AUTHOR, reason: 'first reason' })) as IEnvelope, 'first removal');
    const before = await snapshot(tmp.store);

    const again = (await api.removeNote(ctx, { uid: note.uid, by: AUTHOR, reason: 'second reason' })) as IEnvelope;
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe('item_not_found');

    expect(await snapshot(tmp.store)).toEqual(before);
    expect(await noteState(tmp.store, note.uid)).toEqual({ removed: true, reason: 'first reason' });
  });

  // failure mode: an ambiguous uid prefix resolves to one note silently and removes the wrong one
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC2
  it('0f9b6132 AC2 — an ambiguous uid prefix is refused with ambiguous_reference naming both candidates, and nothing is removed', async () => {
    const a = await seedNote(tmp.store, { issueUid, text: 'first ambiguous note', author: AUTHOR });
    const b = await seedNote(tmp.store, { issueUid, text: 'second ambiguous note', author: AUTHOR });
    const [uidA, uidB] = await renameNotesToSharedPrefix(tmp.store, [a.uid, b.uid], 'b1e7a001');
    const before = await snapshot(tmp.store);

    const out = (await api.removeNote(ctx, { uid: 'b1e7a001', by: AUTHOR, reason: 'which one' })) as IEnvelope;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('ambiguous_reference');
    const candidates = out.error?.details?.['candidates'] as Array<{ uid: string }> | undefined;
    expect(candidates?.map((c) => c.uid).sort()).toEqual([uidA, uidB].sort());

    expect(await snapshot(tmp.store)).toEqual(before);
    expect(await noteState(tmp.store, uidA!)).toEqual({ removed: false, reason: null });
    expect(await noteState(tmp.store, uidB!)).toEqual({ removed: false, reason: null });
  });

  // failure mode: a legacy note with no recorded author is removable by anyone (undefined author matches any actor) or by no one
  // tier: S (real store, envelope, no mocks)
  // item/criterion: 0f9b6132 AC2
  it('0f9b6132 AC2 — a legacy note with no metadata.author is refused to an unlisted actor, and removable only by a listed remover', async () => {
    const legacy = await seedNote(tmp.store, { issueUid, text: 'legacy note, no author recorded' });

    const refused = (await api.removeNote(ctx, { uid: legacy.uid, by: AUTHOR, reason: 'not the author' })) as IEnvelope;
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('precondition_failed');
    expect(await noteState(tmp.store, legacy.uid)).toEqual({ removed: false, reason: null });

    await setProjectNoteRemovers(tmp.store, projectUid, [MODERATOR]);
    const allowed = (await api.removeNote(ctx, { uid: legacy.uid, by: MODERATOR, reason: 'legacy cleanup' })) as IEnvelope;
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    expect(await noteState(tmp.store, legacy.uid)).toEqual({ removed: true, reason: 'legacy cleanup' });
  });
});

describe('0f9b6132 AC3 — the removal is durable and appears in the issue audit trail across a store reopen', () => {
  let dir: string;
  let store: GraphBacklogStore;

  beforeEach(async () => {
    dir = freshTmpDir('note-removal-reopen');
    store = await openGraphBacklogStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await closeGraphBacklogStore(store);
    rmSync(dir, { recursive: true, force: true });
  });

  // failure mode: the removal is not recorded in the issue's auditTrail, or is recorded without the reason and note uid, or is lost on reopen
  // tier: S (real store, reopened from disk; no mocks)
  // item/criterion: 0f9b6132 AC3
  it('0f9b6132 AC3 — after closing and reopening the store, auditTrail holds action note-removed with note === reason and from === the note uid', async () => {
    const ctx0: api.BacklogCtx = { store, env: buildBacklogEnv({ adhdRoot: dir }) };
    const p = must((await api.upsertProject(ctx0, { name: 'reopen-project', by: 'seed' })) as IEnvelope, 'project');
    const projectUid = (p.data as { uid: string }).uid;
    const i = must((await api.create(ctx0, { project: projectUid, title: 'audited host', body: 'audited body', by: 'seed' })) as IEnvelope, 'issue');
    const issueUid = (i.data as { uid: string }).uid;
    const note = await seedNote(store, { issueUid, text: 'to be audited', author: AUTHOR });
    const reason = 'duplicate of 0f9b6132';

    const out = (await api.removeNote(ctx0, { uid: note.uid, by: AUTHOR, reason })) as IEnvelope;
    expect(out.ok, JSON.stringify(out)).toBe(true);

    await closeGraphBacklogStore(store);
    store = await openGraphBacklogStore(join(dir, 'backlog.db'));
    const ctx1: api.BacklogCtx = { store, env: buildBacklogEnv({ adhdRoot: dir }) };

    expect(await noteState(store, note.uid)).toEqual({ removed: true, reason });
    const card = must((await api.get(ctx1, { uid: issueUid, fields: ['auditTrail'] })) as IEnvelope, 'get audit');
    const trail = (card.data as { auditTrail?: Array<{ action: string; note?: string; from?: string; actor: string }> }).auditTrail ?? [];
    const removed = trail.filter((a) => a.action === 'note-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.note).toBe(reason);
    expect(removed[0]?.from).toBe(note.uid);
    expect(removed[0]?.actor).toBe(AUTHOR);
  });
});
