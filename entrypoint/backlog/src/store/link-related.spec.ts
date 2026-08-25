/**
 * link-related.spec.ts — BUG-025 (CRITICAL): `linkRelatedNode` used to return
 * `Promise<void>`, which apigen renders as `{"result": null}` for BOTH a
 * successful link and a failure — a caller had no way to tell whether either
 * write persisted (confirmed live: called it twice, could not distinguish
 * the outcomes). This drives the FIXED store function through a real store
 * (real turso-substrate SQLite file, real `writeEdge`/`getEdges`, no mocks)
 * and asserts the consumer-visible outcome: the returned envelope names both
 * ids and truthfully reports `alreadyLinked`, and the edge is still there
 * after the store is closed and reopened from disk — not merely "the
 * function resolved".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode } from './crud.js';
import { linkRelatedNode, listRelatedNode } from './structure.js';

const REPO = 'PseudoSky/link-related-test';

describe('linkRelatedNode (BUG-025) — the write becomes verifiable', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('link-related-spec');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('a fresh link names both ids and reports alreadyLinked=false; re-linking the SAME pair reports alreadyLinked=true; the edge survives a store reopen', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'b', body: 'x', repo: REPO });

    const first = await linkRelatedNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    expect(first).toEqual({
      linked: true,
      repo: REPO,
      humanIdA: a.item.humanId,
      humanIdB: b.item.humanId,
      alreadyLinked: false,
    });

    const second = await linkRelatedNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    expect(second.alreadyLinked).toBe(true);
    expect(second.humanIdA).toBe(a.item.humanId);
    expect(second.humanIdB).toBe(b.item.humanId);

    // The two payloads must actually differ — `{"result": null}` could not
    // express this distinction at all; the fixed return value must.
    expect(JSON.stringify(first)).not.toEqual(JSON.stringify(second));

    // Persistence proof: close the store and reopen it FROM DISK (a fresh
    // GraphBackend instance, fresh connection) rather than trusting the
    // in-memory object graph — this is the only way to prove the edge was
    // actually written to the SQLite file and not just held in a JS closure.
    await closeGraphBacklogStore(tmp.store);
    const reopened = await openGraphBacklogStore(tmp.dbPath);
    try {
      const related = await listRelatedNode(reopened, REPO, a.item.humanId);
      expect(related).toEqual([b.item.humanId]);
    } finally {
      await closeGraphBacklogStore(reopened);
    }
  });

  it('linking B->A after A->B was already linked also reports alreadyLinked=true — RELATES_TO is symmetric even though it is stored as one directed edge', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'b', body: 'x', repo: REPO });

    const forward = await linkRelatedNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    expect(forward.alreadyLinked).toBe(false);

    // Same pair, reversed argument order — the relation is the same one to
    // any caller, so this must be recognized as the pre-existing link, not
    // treated as a brand-new one that happens to write a second edge.
    const reversed = await linkRelatedNode(tmp.store, REPO, b.item.humanId, a.item.humanId);
    expect(reversed.alreadyLinked).toBe(true);
  });

  it('two unrelated items report alreadyLinked=false and listRelatedNode reports nothing for either', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'b', body: 'x', repo: REPO });

    expect(await listRelatedNode(tmp.store, REPO, a.item.humanId)).toEqual([]);
    expect(await listRelatedNode(tmp.store, REPO, b.item.humanId)).toEqual([]);
  });

  it('listRelatedNode is the read side: it reports the link from BOTH endpoints even though the edge is written in one direction only', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'b', body: 'x', repo: REPO });
    const c = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'c', body: 'x', repo: REPO });

    await linkRelatedNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    await linkRelatedNode(tmp.store, REPO, c.item.humanId, a.item.humanId);

    expect(await listRelatedNode(tmp.store, REPO, a.item.humanId)).toEqual([b.item.humanId, c.item.humanId].sort());
    expect(await listRelatedNode(tmp.store, REPO, b.item.humanId)).toEqual([a.item.humanId]);
    expect(await listRelatedNode(tmp.store, REPO, c.item.humanId)).toEqual([a.item.humanId]);
  });

  it('throws when either humanId does not resolve to a live item in the repo, rather than silently linking nothing', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-LINK', title: 'a', body: 'x', repo: REPO });
    await expect(linkRelatedNode(tmp.store, REPO, a.item.humanId, 'BUG-LINK-404')).rejects.toThrow();
  });
});
