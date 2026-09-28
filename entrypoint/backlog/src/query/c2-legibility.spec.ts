/**
 * c2-legibility.spec.ts — C2 "Structural legibility" (DESIGN §5 AC2/AC4;
 * ticket ac911229). Real store, real write verbs, real read verbs throughout —
 * no mocks. Covers the Wave-1 KIND-SCOPE half (AC1–AC3, AC5, AC6) and the
 * Wave-3 DEPENDENT-WEIGHT half (AC4).
 *
 * The acceptance criteria this file pins:
 *
 *  - **AC1** — `get {fields:["related"]}` exposes EVERY live relation type
 *    touching the item (`relates_to`, `part_of`, `blocks` incoming+outbound),
 *    each ref tagged with the `rel` that produced it.
 *  - **AC2** — `view:"order"` scopes to every member kind the filter selects,
 *    not only `kind:'issue'`; each scoped member appears exactly once.
 *  - **AC3** — the card exposes outbound `blocks` (`blocksOut`), a transitive
 *    dependent count (`dependents`), and the single `part_of` parent
 *    (`partOf`).
 *  - **AC4** — the Kahn order's deterministic tiebreak: within equal in-degree,
 *    higher transitive outbound dependent count sorts FIRST; the weights are
 *    swapped and the order flips; two sequential runs are byte-identical. This
 *    reuses the AC3 `resolveDependents` walk; see `queryOrder`'s doc comment.
 *  - **AC5** — a cyclic `blocks` set still returns `{ok:false, cycle:[...]}`
 *    naming all members (regression pin).
 *  - **AC6** — a second `part_of` write throws
 *    `SingleValuedRelationConflictError` naming the existing parent, and
 *    `CONTRACT.md` documents the `n:1` cardinality.
 *
 * ## Negative controls (each proven RED, then restored)
 *
 * Every behavioural test below has teeth. Three were demonstrated by a temporary
 * local revert of the production change (see the dispatch report for the exact
 * lines reverted):
 *
 *  - AC1: re-narrowing `resolveRelated` to `relates_to` only → the
 *    `related` list loses the `part_of`/`blocks` rows → the AC1 test goes RED.
 *  - AC2: re-inserting the unconditional `nodeFilter.kind = 'issue'` in
 *    `queryOrder` → the non-`issue` member vanishes from `order` → the AC2
 *    test goes RED.
 *  - AC4: restoring the plain FIFO `queue.shift()` in `queryOrder` (dropping the
 *    dependents/priority/uid comparator) → both weighted-pair stores fall back
 *    to fixed insertion order, so the swapped-weight store returns `a` before
 *    `b` → the AC4 swap assertion goes RED.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { update } from '../write/update.js';
import { resolveEdgeKindTx } from '../write/catalog.js';
import { nowISO, writeEdgeTx, writeNodeTx } from '../write/tx.js';
import { SingleValuedRelationConflictError } from '../write/errors.js';
import { getIssue } from './get.js';
import { queryIssues } from './query.js';
import { resolveIssueByUid } from './resolve.js';

describe('C2 — structural legibility (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('c2-legibility');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'c2-legibility-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string, kind?: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      by: 'filer',
      ...(kind ? { kind } : {}),
    });
    if (created.uid === undefined)
      throw new Error(
        `createIssue returned no uid (reason: ${created.reason ?? 'unknown'})`
      );
    return created.uid;
  }

  /**
   * Seed a NON-`issue`-kind member attached to `planUid` via a live `part_of`
   * edge — the "plan/bucket rows" CONCEPTUAL_TEST §C names as the members the
   * `kind:'issue'` hard-scope silently drops. The DECLARED catalog pins
   * `part_of` to `issue → issue`, but this store genuinely carries non-issue
   * plan members (written before the catalog row existed / by an import), so
   * the seed uses the same edge-kind row with the member's actual source kind —
   * exactly the on-disk shape the read layer must tolerate.
   */
  async function seedNonIssueMember(
    kind: string,
    name: string,
    planUid: string
  ): Promise<{ uid: string; id: number }> {
    const plan = await resolveIssueByUid(store.graph, planUid);
    const now = nowISO();
    return store.adapter.transaction(
      async (tx) => {
        const node = await writeNodeTx(tx, {
          kind,
          name,
          metadata: {},
          at: now,
        });
        const rule = await resolveEdgeKindTx(tx, 'part_of');
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: node.rowid,
          srcUid: node.uid,
          srcKind: kind,
          dstRowid: plan.id,
          dstUid: plan.uid,
          dstKind: 'issue',
          rel: 'part_of',
          rule: { ...rule, sourceKind: kind },
          typePolicy: store.typePolicy,
        });
        return { uid: node.uid, id: node.rowid };
      },
      { mode: 'immediate' }
    );
  }

  // -------------------------------------------------------------------
  // AC1 — `related` exposes every live relation type
  // -------------------------------------------------------------------

  it('AC1: get {fields:["related"]} exposes part_of + blocks (in+out) + relates_to, each tagged', async () => {
    const anchor = await mkIssue('anchor');
    const parent = await mkIssue('anchor parent');
    const blockedOut = await mkIssue('blocked-by-anchor');
    const blockedIn = await mkIssue('blocks-anchor');
    const relatedR = await mkIssue('related-peer');

    await relate(store, {
      sourceUid: anchor,
      targetUid: parent,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
    // anchor BLOCKS blockedOut (outbound)
    await relate(store, {
      sourceUid: anchor,
      targetUid: blockedOut,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    // blockedIn BLOCKS anchor (inbound)
    await relate(store, {
      sourceUid: blockedIn,
      targetUid: anchor,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: anchor,
      targetUid: relatedR,
      rel: 'relates_to',
      action: 'add',
      by: 'filer',
    });

    const card = await getIssue(store.graph, {
      uid: anchor,
      fields: ['related'],
    });
    const relByUid = new Map((card.related ?? []).map((r) => [r.uid, r.rel]));

    expect(card.related).toHaveLength(4);
    expect(relByUid.get(parent)).toBe('part_of');
    expect(relByUid.get(blockedOut)).toBe('blocks');
    expect(relByUid.get(blockedIn)).toBe('blocked_by');
    expect(relByUid.get(relatedR)).toBe('relates_to');
  });

  // -------------------------------------------------------------------
  // AC2 — order spans every member kind the filter selects
  // -------------------------------------------------------------------

  it('AC2: view:"order" {filter:{plan}} includes every scoped member kind, each exactly once', async () => {
    const plan = await mkIssue('the plan', 'plan');
    const member = await mkIssue('issue member');
    const outsider = await mkIssue('not a member');
    await relate(store, {
      sourceUid: member,
      targetUid: plan,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
    const bucket = await seedNonIssueMember('bucket', 'bucket member', plan);

    const result = await queryIssues(store, {
      view: 'order',
      filter: { plan },
      limit: 100,
    });
    if (result.view !== 'order')
      throw new Error(`expected view 'order', got '${result.view}'`);
    expect(result.order.ok).toBe(true);
    if (!result.order.ok) return;

    // Both the issue-kind member AND the non-issue bucket member are present.
    expect(new Set(result.order.order)).toEqual(new Set([member, bucket.uid]));
    // Exactly once each — no duplicate.
    expect(result.order.order).toHaveLength(2);
    // The plan itself is not a member; the outsider is out of scope.
    expect(result.order.order).not.toContain(plan);
    expect(result.order.order).not.toContain(outsider);
  });

  // -------------------------------------------------------------------
  // AC3 — blocksOut + dependents + partOf
  // -------------------------------------------------------------------

  it('AC3: a card exposes blocksOut, a transitive dependents count, and partOf', async () => {
    const anchor = await mkIssue('a');
    const mid = await mkIssue('m');
    const leaf = await mkIssue('l');
    const parentOfMid = await mkIssue('parent of m');

    await relate(store, {
      sourceUid: anchor,
      targetUid: mid,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: mid,
      targetUid: leaf,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: mid,
      targetUid: parentOfMid,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });

    const anchorCard = await getIssue(store.graph, {
      uid: anchor,
      fields: ['blocksOut', 'dependents', 'partOf'],
    });
    // Direct outbound only — mid (not the transitive leaf).
    expect(anchorCard.blocksOut).toHaveLength(1);
    expect(anchorCard.blocksOut?.[0]?.uid).toBe(mid);
    expect(anchorCard.blocksOut?.[0]?.rel).toBe('blocks');
    // Transitive: mid AND leaf reach anchor.
    expect(anchorCard.dependents).toBe(2);
    // anchor has no parent.
    expect(anchorCard.partOf).toBeNull();

    const midCard = await getIssue(store.graph, {
      uid: mid,
      fields: ['blocksOut', 'dependents', 'partOf'],
    });
    expect(midCard.blocksOut?.map((r) => r.uid)).toEqual([leaf]);
    expect(midCard.dependents).toBe(1);
    expect(midCard.partOf?.uid).toBe(parentOfMid);
    expect(midCard.partOf?.rel).toBe('part_of');

    // A node with no outbound blocks has an empty list and a zero count.
    const leafCard = await getIssue(store.graph, {
      uid: leaf,
      fields: ['blocksOut', 'dependents'],
    });
    expect(leafCard.blocksOut).toEqual([]);
    expect(leafCard.dependents).toBe(0);
  });

  // -------------------------------------------------------------------
  // AC4 — deterministic dependent-weight tiebreak inside the Kahn order
  // -------------------------------------------------------------------

  /** Drive the REAL `view:'order'` verb and return its sequence (never the cycle arm). */
  async function topoOrderOver(s: TestIssueStore): Promise<string[]> {
    const result = await queryIssues(s, { view: 'order', limit: 100 });
    if (result.view !== 'order')
      throw new Error(`expected view 'order', got '${result.view}'`);
    if (!result.order.ok)
      throw new Error(
        `unexpected cycle in AC4 fixture: ${result.order.cycle.join(', ')}`
      );
    return result.order.order;
  }

  async function mkIssueIn(
    s: TestIssueStore,
    project: string,
    title: string
  ): Promise<string> {
    const created = await createIssue(s, {
      project,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (created.uid === undefined)
      throw new Error(
        `createIssue returned no uid (reason: ${created.reason ?? 'unknown'})`
      );
    return created.uid;
  }

  /**
   * Seed a fresh store with two in-degree-0 nodes `a` and `b` (a inserted
   * FIRST, so a pure FIFO queue returns `a` before `b`), then give exactly ONE
   * of them a two-node outbound `blocks` chain — that node has transitive
   * dependents 2, the other 0. Insertion order is FIXED (a before b) across both
   * `heavy` values, so only the dependent-weight tiebreak can flip the winner.
   */
  async function seedWeightedPair(heavy: 'a' | 'b'): Promise<{
    store: TestIssueStore;
    dir: string;
    a: string;
    b: string;
  }> {
    const dir = freshTmpDir('c2-ac4-swap');
    const store = await openTestIssueStore(join(dir, 'backlog.db'));
    const project = (await seedProject(store, `c2-ac4-${heavy}`)).projectUid;
    const a = await mkIssueIn(store, project, 'ac4 a');
    const b = await mkIssueIn(store, project, 'ac4 b');
    const heavyId = heavy === 'a' ? a : b;
    const mid = await mkIssueIn(store, project, 'ac4 mid');
    const leaf = await mkIssueIn(store, project, 'ac4 leaf');
    await relate(store, {
      sourceUid: heavyId,
      targetUid: mid,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: mid,
      targetUid: leaf,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    return { store, dir, a, b };
  }

  it('AC4: equal in-degree ⇒ heavier transitive dependents first; swapping the weights flips the order', async () => {
    const aHeavy = await seedWeightedPair('a');
    const bHeavy = await seedWeightedPair('b');
    try {
      const orderA = await topoOrderOver(aHeavy.store);
      const orderB = await topoOrderOver(bHeavy.store);

      // Identical insertion order in both stores (a then b). The heavier node
      // wins in each: `a` first when `a` is heavy, `b` first when `b` is heavy.
      expect(orderA.indexOf(aHeavy.a)).toBeLessThan(orderA.indexOf(aHeavy.b));
      expect(orderB.indexOf(bHeavy.b)).toBeLessThan(orderB.indexOf(bHeavy.a));
      // The swap genuinely flips the outcome (both stores share a's-first
      // insertion order, so "a first" and "b first" are opposite).
      expect(orderA.indexOf(aHeavy.a)).toBe(0);
      expect(orderB.indexOf(bHeavy.b)).toBe(0);
    } finally {
      await aHeavy.store.close();
      removeTestIssueStoreDir(aHeavy.dir);
      await bHeavy.store.close();
      removeTestIssueStoreDir(bHeavy.dir);
    }
  });

  it('AC4: two sequential runs over one store yield the identical sequence (determinism, no timing)', async () => {
    const { store: s, dir: d, a, b } = await seedWeightedPair('a');
    try {
      const first = await topoOrderOver(s);
      const second = await topoOrderOver(s);
      expect(second).toEqual(first);
      // Fixture sanity: both tied nodes are present and the order is non-trivial.
      expect(first).toContain(a);
      expect(first).toContain(b);
      expect(first.length).toBe(4);
    } finally {
      await s.close();
      removeTestIssueStoreDir(d);
    }
  });

  it('AC4: equal dependents + no priority ⇒ uid ascending is the final deterministic key', async () => {
    const d = freshTmpDir('c2-ac4-uid');
    const s = await openTestIssueStore(join(d, 'backlog.db'));
    try {
      const project = (await seedProject(s, 'c2-ac4-uid')).projectUid;
      const uids: string[] = [];
      for (const title of ['u1', 'u2', 'u3']) {
        uids.push(await mkIssueIn(s, project, title));
      }
      const order = await topoOrderOver(s);
      expect(order).toEqual([...uids].sort());
    } finally {
      await s.close();
      removeTestIssueStoreDir(d);
    }
  });

  it('AC4: equal dependents ⇒ lower priority rank first, beating insertion order', async () => {
    const d = freshTmpDir('c2-ac4-prio');
    const s = await openTestIssueStore(join(d, 'backlog.db'));
    try {
      const project = (await seedProject(s, 'c2-ac4-prio')).projectUid;
      // Insertion order: `y` first, `x` second — a FIFO queue returns y before x.
      const y = await mkIssueIn(s, project, 'prio y');
      const x = await mkIssueIn(s, project, 'prio x');
      // Mint in rank order (P0 rank 0, then P1 rank 1) and give the LATER-
      // inserted node the better rank, so only the tiebreak can put x first.
      await update(s, { uid: x, priority: 'P0', by: 'filer' });
      await update(s, { uid: y, priority: 'P1', by: 'filer' });
      const order = await topoOrderOver(s);
      expect(order.indexOf(x)).toBeLessThan(order.indexOf(y));
    } finally {
      await s.close();
      removeTestIssueStoreDir(d);
    }
  });

  // -------------------------------------------------------------------
  // AC5 — cycle regression pin
  // -------------------------------------------------------------------

  it('AC5: a cyclic blocks set returns {ok:false, cycle:[...]} naming all members', async () => {
    const a = await mkIssue('cycle a');
    const b = await mkIssue('cycle b');
    const c = await mkIssue('cycle c');
    await relate(store, {
      sourceUid: a,
      targetUid: b,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: b,
      targetUid: c,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });
    await relate(store, {
      sourceUid: c,
      targetUid: a,
      rel: 'blocks',
      action: 'add',
      by: 'filer',
    });

    const result = await queryIssues(store, { view: 'order' });
    if (result.view !== 'order')
      throw new Error(`expected view 'order', got '${result.view}'`);
    expect(result.order.ok).toBe(false);
    if (result.order.ok) return;
    expect(new Set(result.order.cycle)).toEqual(new Set([a, b, c]));
  });

  // -------------------------------------------------------------------
  // AC6 — part_of cardinality
  // -------------------------------------------------------------------

  it('AC6: a second part_of write throws SingleValuedRelationConflictError naming the existing parent', async () => {
    const child = await mkIssue('child');
    const parentA = await mkIssue('parent A');
    const parentB = await mkIssue('parent B');

    await relate(store, {
      sourceUid: child,
      targetUid: parentA,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });

    // Re-adding the SAME parent is a no-op, never an error.
    const again = await relate(store, {
      sourceUid: child,
      targetUid: parentA,
      rel: 'part_of',
      action: 'add',
      by: 'filer',
    });
    expect(again.noop).toBe(true);

    // A DIFFERENT parent is a typed conflict naming the pre-existing parent.
    try {
      await relate(store, {
        sourceUid: child,
        targetUid: parentB,
        rel: 'part_of',
        action: 'add',
        by: 'filer',
      });
      expect.unreachable('expected SingleValuedRelationConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(SingleValuedRelationConflictError);
      const conflict = err as SingleValuedRelationConflictError;
      expect(conflict.side).toBe('source');
      expect(conflict.rel).toBe('part_of');
      expect(conflict.cappedUid).toBe(child);
      expect(conflict.conflictingUid).toBe(parentA);
    }
  });

  it('AC6: CONTRACT.md documents the part_of n:1 cardinality and the typed error', () => {
    const contract = readFileSync(
      fileURLToPath(new URL('../write/CONTRACT.md', import.meta.url)),
      'utf8'
    );
    expect(contract).toMatch(/`part_of` is `n:1`/);
    expect(contract).toContain('SingleValuedRelationConflictError');
    expect(contract).toContain('conflictingUid');
  });
});
