/**
 * create-item-citations.spec.ts — BUG-BACKLOG-CREATE-ITEM-DROPS-CITATIONS-001.
 *
 * `createItemNode`'s `CreateItemInput` did not carry a `citations` field at
 * all — the TS interface had no such property, so `crud.ts` unconditionally
 * wrote `citations: []` into the new node's metadata regardless of what the
 * caller passed. A caller supplying `citations` at create time got a
 * success payload back with the item created, but the citations silently
 * discarded — no error, no warning. `supersedeItemNode` (structure.ts) has
 * the identical `newInput: CreateItemInput` shape and the identical
 * unconditional `citations: []`, so it is covered here too.
 *
 * RED→GREEN: before the fix, `createItemNode`/`supersedeItemNode` accepting
 * `input.citations` and both "created item has the citations" assertions
 * below fail (the item's citations array is `[]`). After the fix they pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { supersedeItemNode } from './structure.js';
import { InvalidArgumentError } from '../model.js';

const REPO = 'PseudoSky/create-item-citations-test';

describe('createItem persists citations supplied at creation time', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('create-item-citations-spec-create');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('a citation passed on createItem input is persisted on the created item', async () => {
    const result = await createItemNode(tmp.store, {
      family: 'BUG-CIC',
      title: 'citations should persist',
      body: 'body',
      repo: REPO,
      citations: [{ file: 'src/x.ts', lines: '1-2', context: 'test' }],
    });
    expect(result.created).toBe(true);
    expect(result.item.citations).toHaveLength(1);
    expect(result.item.citations[0]?.file).toBe('src/x.ts');
    expect(result.item.citations[0]?.lines).toBe('1-2');
    expect(result.item.citations[0]?.context).toBe('test');
  });

  it('a follow-up getItem shows the persisted citation (not an empty array)', async () => {
    const created = await createItemNode(tmp.store, {
      family: 'BUG-CIC',
      title: 'get-item confirms persistence',
      body: 'body',
      repo: REPO,
      citations: [{ file: 'src/y.ts' }],
    });
    const node = await tmp.store.graph.getNode(created.item.nodeId);
    const citations = (node?.metadata as { citations?: unknown[] } | undefined)?.citations;
    expect(citations).toHaveLength(1);
  });

  it('multiple citations on one create are all persisted, in order', async () => {
    const result = await createItemNode(tmp.store, {
      family: 'BUG-CIC',
      title: 'multi citation create',
      body: 'body',
      repo: REPO,
      citations: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }],
    });
    expect(result.item.citations.map((c) => c.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('omitting citations still creates successfully with an empty array — unaffected by the fix', async () => {
    const result = await createItemNode(tmp.store, { family: 'BUG-CIC', title: 'no citations', body: 'body', repo: REPO });
    expect(result.created).toBe(true);
    expect(result.item.citations).toEqual([]);
  });

  it('a citation with an empty-string file is rejected up front, same as addCitation/transitionStatus (defense in depth)', async () => {
    await expect(
      createItemNode(tmp.store, {
        family: 'BUG-CIC',
        title: 'bad citation',
        body: 'body',
        repo: REPO,
        citations: [{ file: '' }],
      })
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('a rejected citation never partially creates the item', async () => {
    await expect(
      createItemNode(tmp.store, {
        family: 'BUG-CIC',
        title: 'bad citation no partial write',
        body: 'body',
        repo: REPO,
        citations: [{ file: '   ' }],
      })
    ).rejects.toThrow(InvalidArgumentError);
    const items = await tmp.store.graph.searchNodes('bad', { limit: 10, filter: { namespace: REPO } });
    expect(items.find((n) => (n.metadata as { title?: string } | null)?.title === 'bad citation no partial write')).toBeUndefined();
  });
});

describe('supersedeItem persists citations supplied on the replacement input (same bug, same shape)', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('create-item-citations-spec-supersede');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('a citation passed on supersedeItem input is persisted on the replacement item', async () => {
    const original = await createItemNode(tmp.store, { family: 'BUG-CIC', title: 'original', body: 'body', repo: REPO });
    const superseded = await supersedeItemNode(
      tmp.store,
      REPO,
      original.item.humanId,
      {
        family: 'BUG-CIC',
        title: 'replacement',
        body: 'replacement body',
        repo: REPO,
        citations: [{ file: 'replacement.ts' }],
      },
      'original was wrong'
    );
    expect(superseded.citations).toHaveLength(1);
    expect(superseded.citations[0]?.file).toBe('replacement.ts');
  });
});
