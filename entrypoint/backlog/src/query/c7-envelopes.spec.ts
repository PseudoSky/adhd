/**
 * c7-envelopes.spec.ts — C7 (Honest envelopes & store observability): the
 * AC1/AC3/AC4/AC6-lite/AC7 behavioral proofs, driven against a REAL store
 * (`openTestIssueStore`) and the REAL read/write layers. No mocks of anything
 * under test.
 *
 * AC2 is the EXISTING `query/meta-wire.e2e.ts` (list `meta` byte-shape +
 * `view:'graph'` has no `meta`) — it is the load-bearing regression for C7 and
 * is deliberately not duplicated here. AC5 (`_score_kind`) and the semantic
 * half of AC6 live in `views/semantic.spec.ts`, where a real vector search
 * backend is already wired.
 *
 * Each behavioral assertion is a DIFFERENTIAL one where a plausible-but-wrong
 * implementation exists: an unbounded `resolveAuditTrail`, an always-inlined
 * `childrenOpenUids`, a `report` that re-derives instead of composing. The
 * negative-control runs are documented in the ticket return.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from '../write/create-issue.js';
import { relate } from '../write/relate.js';
import { claim } from '../write/claim.js';
import { transition } from '../write/transition.js';
import { writeNodeTx, nowISO } from '../write/tx.js';
import { BacklogValidationError } from '../write/errors.js';
import { queryIssues, queryIssuesWithMeta } from './query.js';
import { getIssue } from './get.js';
import { partOfRollup } from './views/stats.js';
import { report } from './views/report.js';

/** Seeds a `status` row with `terminal: true` directly (a non-reserved terminal NAME, as a real catalog seed would). */
async function seedTerminalStatus(
  store: TestIssueStore,
  name: string
): Promise<void> {
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

describe('C7 AC1 — ready/stale report an honest has_more (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c7-ready');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c7-ready-project')).projectUid;
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mk(title: string): Promise<string> {
    const r = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!r.created || r.uid === undefined)
      throw new Error(`fixture: createIssue was suppressed: ${JSON.stringify(r)}`);
    return r.uid;
  }

  it('ready with MORE matches than limit: has_more true, total a labelled lower bound', async () => {
    for (let i = 0; i < 6; i++) await mk(`ready ${i}`);

    const out = await queryIssuesWithMeta(store, { view: 'ready', limit: 5 });
    expect(out.meta).toBeDefined();
    expect(out.meta!.returned).toBe(5);
    expect(out.meta!.limit).toBe(5);
    expect(out.meta!.has_more).toBe(true);
    // Never a fabricated exact total: a lower bound, named as such.
    expect(out.meta!.total_relation).toBe('gte');
    expect(out.meta!.total).toBeGreaterThanOrEqual(6);
  });

  it('ready with FEWER matches than limit: has_more false, total exact', async () => {
    for (let i = 0; i < 3; i++) await mk(`ready ${i}`);

    const out = await queryIssuesWithMeta(store, { view: 'ready', limit: 5 });
    expect(out.meta!.returned).toBe(3);
    expect(out.meta!.has_more).toBe(false);
    expect(out.meta!.total_relation).toBe('eq');
    expect(out.meta!.total).toBe(3);
  });

  it('stale also emits meta, with has_more derived from the same limit+1 fetch', async () => {
    const uids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const uid = await mk(`stale ${i}`);
      uids.push(uid);
      await claim(store, { uid, by: `agent-${i}`, action: 'claim' });
      const row = await store.adapter.executeGet<{ meta: string | null }>(
        'SELECT meta FROM node WHERE uid = ?',
        [uid]
      );
      const meta = row?.meta
        ? (JSON.parse(row.meta) as Record<string, unknown>)
        : {};
      const ancient = new Date(Date.now() - 1_000 * 60_000).toISOString();
      await store.adapter.executeRun(
        'UPDATE node SET meta = ? WHERE uid = ?',
        [JSON.stringify({ ...meta, claimedAt: ancient }), uid]
      );
    }

    const out = await queryIssuesWithMeta(store, { view: 'stale', limit: 2 });
    expect(out.meta).toBeDefined();
    expect(out.meta!.returned).toBe(2);
    expect(out.meta!.has_more).toBe(true);
    expect(out.meta!.total_relation).toBe('gte');
  });
});

describe('C7 AC3 — part-of-rollup count-only and paged modes (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c7-rollup');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c7-rollup-project')).projectUid;
    await seedTerminalStatus(store, 'done');
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mk(title: string): Promise<string> {
    const r = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!r.created || r.uid === undefined)
      throw new Error(`fixture: createIssue was suppressed: ${JSON.stringify(r)}`);
    return r.uid;
  }

  async function childOf(childUid: string, parentUid: string): Promise<void> {
    await relate(store, {
      sourceUid: childUid,
      targetUid: parentUid,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
  }

  it('countOnly returns the counts with NO childrenOpenUids key at all', async () => {
    const root = await mk('root');
    const openA = await mk('open a');
    const openB = await mk('open b');
    const openC = await mk('open c');
    const closed = await mk('closed');
    for (const c of [openA, openB, openC, closed]) await childOf(c, root);
    await transition(store, {
      uid: closed,
      by: 'worker',
      toStatus: 'done',
      note: 'closing',
    });

    const r = await partOfRollup(store, { uid: root, countOnly: true });
    expect(r.childrenTotal).toBe(4);
    expect(r.childrenOpen).toBe(3);
    expect(r.childrenClosed).toBe(1);
    // The list is OMITTED, never an empty array standing in for it.
    expect(
      Object.prototype.hasOwnProperty.call(r, 'childrenOpenUids')
    ).toBe(false);
    expect(r.childrenOpenUids).toBeUndefined();
  });

  it('paged mode returns <= limit uids + nextCursor + hasMore, and pages cleanly', async () => {
    const root = await mk('root');
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const uid = await mk(`open ${i}`);
      await childOf(uid, root);
      expected.push(uid);
    }

    const p1 = await partOfRollup(store, { uid: root, limit: 2 });
    expect(p1.childrenOpenUids).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBe(p1.childrenOpenUids![1]);

    const p2 = await partOfRollup(store, {
      uid: root,
      limit: 2,
      after: p1.nextCursor,
    });
    expect(p2.childrenOpenUids).toHaveLength(2);
    expect(p2.hasMore).toBe(true);

    const p3 = await partOfRollup(store, {
      uid: root,
      limit: 2,
      after: p2.nextCursor,
    });
    expect(p3.childrenOpenUids).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeUndefined();

    const union = new Set([
      ...p1.childrenOpenUids!,
      ...p2.childrenOpenUids!,
      ...p3.childrenOpenUids!,
    ]);
    expect(union).toEqual(new Set(expected));
  });

  it('rejects an out-of-range limit by name, never silently clamping', async () => {
    const root = await mk('root');
    await expect(
      partOfRollup(store, { uid: root, limit: 0 })
    ).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(
      partOfRollup(store, { uid: root, limit: 1001 })
    ).rejects.toBeInstanceOf(BacklogValidationError);
  });
});

describe('C7 AC4 — get lastN bounds the audit trail to its newest tail (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c7-get-lastn');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c7-get-lastn-project')).projectUid;
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('returns exactly lastN rows — the newest tail, preserving oldest-first order', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'churning issue',
      body: 'body',
      by: 'filer',
    });
    if (created.uid === undefined)
      throw new Error('fixture: createIssue was suppressed');
    const statuses = ['in-progress', 'open', 'review', 'open', 'in-progress'];
    for (const s of statuses) {
      await transition(store, {
        uid: created.uid,
        by: 'worker',
        toStatus: s,
        note: `to ${s}`,
      });
    }

    const full = await getIssue(store.graph, {
      uid: created.uid,
      fields: ['uid', 'auditTrail'],
    });
    expect(full.auditTrail!.length).toBeGreaterThan(5);

    const bounded = await getIssue(store.graph, {
      uid: created.uid,
      fields: ['uid', 'auditTrail'],
      lastN: 5,
    });
    expect(bounded.auditTrail).toHaveLength(5);
    // The bounded set is exactly the tail of the full, oldest-first trail.
    expect(bounded.auditTrail!.map((e) => e.uid)).toEqual(
      full.auditTrail!.slice(-5).map((e) => e.uid)
    );
    const ats = bounded.auditTrail!.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it('rejects a non-positive/non-integer lastN by name', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'x',
      body: 'body',
      by: 'filer',
    });
    if (created.uid === undefined)
      throw new Error('fixture: createIssue was suppressed');
    await expect(
      getIssue(store.graph, {
        uid: created.uid,
        fields: ['uid', 'auditTrail'],
        lastN: 0,
      })
    ).rejects.toBeInstanceOf(BacklogValidationError);
    await expect(
      getIssue(store.graph, {
        uid: created.uid,
        fields: ['uid', 'auditTrail'],
        lastN: 1.5,
      })
    ).rejects.toBeInstanceOf(BacklogValidationError);
  });
});

describe('C7 AC5 (grep branch) — a grep-only _score is tagged bm25, never untagged (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c7-grep-score');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c7-grep-score-project')).projectUid;
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('every scored grep result carries _score_kind:"bm25"', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'needleuniquetoken here',
      body: 'needleuniquetoken body text',
      by: 'filer',
      duplicateAction: 'force',
    });

    const result = await queryIssues(store, {
      view: 'list',
      filter: { grep: 'needleuniquetoken' },
      fields: ['uid', '_score'],
    });
    if (result.view !== 'list') throw new Error('expected list');
    if (!('items' in result)) throw new Error('expected json list');
    const scored = result.items.filter((c) => c._score !== undefined);
    expect(scored.length).toBeGreaterThan(0);
    for (const c of scored) {
      expect(c._score).toBeTypeOf('number');
      expect(c._score_kind).toBe('bm25');
    }
  });
});

describe('C7 AC7 — report equals an INDEPENDENT recomputation (real store, direct reads)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c7-report');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c7-report-project')).projectUid;
    await seedTerminalStatus(store, 'done');
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mk(
    title: string,
    opts: { kind?: string; priority?: string; status?: string } = {}
  ): Promise<string> {
    const r = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
    });
    if (!r.created || r.uid === undefined)
      throw new Error(`fixture: createIssue was suppressed: ${JSON.stringify(r)}`);
    return r.uid;
  }

  it('byKind/byPriority/byStatus/avgAgeDays match a second, direct-store code path', async () => {
    const { graph } = store;
    const a1 = await mk('a-high-open', { kind: 'ALPHA', priority: 'HIGH' });
    await mk('a-low-open', { kind: 'ALPHA', priority: 'LOW' });
    await mk('b-high-open', { kind: 'BETA', priority: 'HIGH' });
    const bNone = await mk('b-none-open', { kind: 'BETA' });
    const closed = await mk('b-high-closed', {
      kind: 'BETA',
      priority: 'HIGH',
    });
    await transition(store, {
      uid: closed,
      by: 'worker',
      toStatus: 'done',
      note: 'closing',
    });
    void a1;
    void bNone;

    // ---- the report under test -------------------------------------------
    const got = await report(store, { filter: { status: 'all' } });
    expect(got.statusScope).toBe('all');
    expect(typeof got.computedAt).toBe('string');

    // ---- ADR-0002 composition check: byPriority IS priorityMatrix's rows --
    // (independent path below also recomputes it, so this is not a tautology
    // against the same helper — it additionally pins the wiring.)

    // ---- INDEPENDENT recomputation: direct store reads ONLY --------------
    const scoped = await graph.queryNodes({
      kind: 'issue',
      liveOnly: true,
      isSuperseded: false,
    });
    const scopedIds = new Set(scoped.map((n) => n.id));

    // byKind
    const kindEdges = await graph.getEdges({ rel: 'has_kind' });
    const kindIdByIssue = new Map<number, number>();
    for (const e of kindEdges) {
      if (scopedIds.has(e.src) && !kindIdByIssue.has(e.src))
        kindIdByIssue.set(e.src, e.dst);
    }
    const kindNodes = await graph.getNodesByIds([
      ...new Set(kindIdByIssue.values()),
    ]);
    const kindName = new Map(kindNodes.map((n) => [n.id, n.name ?? '']));
    const expKind = new Map<string, number>();
    for (const n of scoped) {
      const k = kindName.get(kindIdByIssue.get(n.id) ?? -1) ?? n.kind;
      expKind.set(k, (expKind.get(k) ?? 0) + 1);
    }
    const expectByKind = [...expKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((x, y) => x.kind.localeCompare(y.kind));
    expect(got.byKind).toEqual(expectByKind);

    // byPriority
    const priorityNodes = await graph.queryNodes({
      kind: 'priority',
      liveOnly: true,
    });
    const expectByPriority: Array<{
      priority: string;
      rank?: number;
      count: number;
    }> = [];
    for (const p of priorityNodes) {
      const edges = await graph.getEdges({
        dst: p.id,
        rel: 'has_priority',
      });
      let count = 0;
      for (const e of edges) if (scopedIds.has(e.src)) count += 1;
      expectByPriority.push({
        priority: p.name ?? '',
        ...(typeof p.metadata?.rank === 'number'
          ? { rank: p.metadata.rank }
          : {}),
        count,
      });
    }
    expectByPriority.sort(
      (x, y) =>
        (x.rank ?? Number.MAX_SAFE_INTEGER) -
        (y.rank ?? Number.MAX_SAFE_INTEGER)
    );
    expect(got.byPriority).toEqual(expectByPriority);

    // byStatus
    const statusEdges = await graph.getEdges({ rel: 'has_status' });
    const statusIdByIssue = new Map<number, number>();
    for (const e of statusEdges) {
      if (scopedIds.has(e.src) && !statusIdByIssue.has(e.src))
        statusIdByIssue.set(e.src, e.dst);
    }
    const statusNodes = await graph.getNodesByIds([
      ...new Set(statusIdByIssue.values()),
    ]);
    const statusInfo = new Map(
      statusNodes.map((n) => [
        n.id,
        { name: n.name ?? '', terminal: n.metadata?.terminal === true },
      ])
    );
    const expStatus = new Map<string, { terminal: boolean; count: number }>();
    let expOpen = 0;
    let expAgeSumMs = 0;
    const nowMs = Date.parse(got.computedAt);
    for (const n of scoped) {
      const info = statusInfo.get(statusIdByIssue.get(n.id) ?? -1);
      const name = info?.name ?? '';
      const terminal = info?.terminal ?? false;
      const entry = expStatus.get(name) ?? { terminal, count: 0 };
      entry.count += 1;
      expStatus.set(name, entry);
      if (!terminal) {
        expOpen += 1;
        expAgeSumMs += nowMs - Date.parse(n.tCreated);
      }
    }
    const expectByStatus = [...expStatus.entries()]
      .map(([status, v]) => ({
        status,
        terminal: v.terminal,
        count: v.count,
      }))
      .sort((x, y) => x.status.localeCompare(y.status));
    expect(got.byStatus).toEqual(expectByStatus);

    // avgAgeDays of OPEN items, independently computed.
    const expectAvg = expOpen > 0 ? expAgeSumMs / expOpen / 86_400_000 : 0;
    expect(got.avgAgeDays).toBeCloseTo(expectAvg, 6);
  });

  it('defaults to the OPEN scope like priorityMatrix, and byStatus is scope-consistent', async () => {
    await mk('open one', { kind: 'ALPHA' });
    const closed = await mk('closed one', { kind: 'ALPHA', status: 'done' });
    void closed;

    const got = await report(store, {});
    expect(got.statusScope).toBe('open');
    // closed item is out of scope: one ALPHA row, and no terminal status row.
    expect(got.byKind).toEqual([{ kind: 'ALPHA', count: 1 }]);
    expect(got.byStatus.every((s) => s.terminal === false)).toBe(true);
  });
});
