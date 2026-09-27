/**
 * c2-legibility.spec.ts — C2 "Structural legibility", Wave-1 KIND-SCOPE half
 * (DESIGN §5 AC2 / §4; ticket ac911229). Real store, real write verbs, real
 * read verbs throughout — no mocks.
 *
 * The five acceptance criteria this file pins:
 *
 *  - **AC1** — `get {fields:["related"]}` exposes EVERY live relation type
 *    touching the item (`relates_to`, `part_of`, `blocks` incoming+outbound),
 *    each ref tagged with the `rel` that produced it. Today it shows
 *    `relates_to` only.
 *  - **AC2** — `view:"order"` scopes to every member kind the filter selects,
 *    not only `kind:'issue'`; each scoped member appears exactly once.
 *  - **AC3** — the card exposes outbound `blocks` (`blocksOut`), a transitive
 *    dependent count (`dependents`), and the single `part_of` parent
 *    (`partOf`).
 *  - **AC5** — a cyclic `blocks` set still returns `{ok:false, cycle:[...]}`
 *    naming all members (regression pin).
 *  - **AC6** — a second `part_of` write throws
 *    `SingleValuedRelationConflictError` naming the existing parent, and
 *    `CONTRACT.md` documents the `n:1` cardinality.
 *
 * **AC4 is deliberately absent** (deferred to Wave 3): the transitive
 * dependent-count tiebreak inside the Kahn order. The queue stays FIFO in
 * Wave 1; see `queryOrder`'s own doc comment.
 *
 * ## Negative controls (each proven RED, then restored)
 *
 * Every behavioural test below has teeth. Two were demonstrated by a temporary
 * local revert of the production change (see the dispatch report for the exact
 * lines reverted):
 *
 *  - AC1: re-narrowing `resolveRelated` to `relates_to` only → the
 *    `related` list loses the `part_of`/`blocks` rows → the AC1 test goes RED.
 *  - AC2: re-inserting the unconditional `nodeFilter.kind = 'issue'` in
 *    `queryOrder` → the non-`issue` member vanishes from `order` → the AC2
 *    test goes RED.
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
