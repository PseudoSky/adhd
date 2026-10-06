/**
 * Edge-case / boundary suite for `@adhd/data-core-structures` index structures.
 *
 * Focus: the degenerate and boundary inputs the existing suites never assert —
 * empty structures, out-of-range rank/select, `lo > hi` ranges, duplicate keys,
 * the `keyOf` type-distinctness the query engine's index soundness rests on,
 * RoaringBitmap word/container boundaries, and reader-view isolation. These are
 * the inputs a real consumer reaches when an index is empty or a page is empty.
 */
import { describe, it, expect } from 'vitest';
import {
  BPlusTree,
  Fenwick,
  HashIndex,
  LsmTree,
  PostingIndex,
  RadixTree,
  RoaringBitmap,
  SkipList,
  keyOf,
} from './index';

// ── keyOf: the canonicalisation the equality indexes depend on ──────────────
describe('keyOf — type-distinctness (the foundation of index soundness)', () => {
  it('does not conflate a value with its string form, nor null with undefined', () => {
    expect(keyOf(1)).not.toBe(keyOf('1'));
    expect(keyOf(0)).not.toBe(keyOf('0'));
    expect(keyOf(true)).not.toBe(keyOf('true'));
    expect(keyOf(null)).not.toBe(keyOf(undefined));
    expect(keyOf(null)).not.toBe(keyOf('null'));
  });

  it('canonicalises two equal Dates to one key, and keeps a Date distinct from a number', () => {
    expect(keyOf(new Date(0))).toBe(keyOf(new Date(0)));
    expect(keyOf(new Date(0))).not.toBe(keyOf(0));
  });

  it('NEGATIVE CONTROL: a HashIndex separates 1 from "1"', () => {
    const h = new HashIndex();
    h.add(1, 1);
    h.add('1', 2);
    expect(h.get(1)).toEqual([1]);
    expect(h.get('1')).toEqual([2]);
  });
});

// ── HashIndex / PostingIndex ────────────────────────────────────────────────
describe('HashIndex / PostingIndex — empty and isolation edges', () => {
  it('a lookup for an absent key is empty, and the returned collection is a copy', () => {
    const h = new HashIndex();
    expect(h.get('missing')).toEqual([]);
    h.add('a', 1);
    const viewed = h.get('a');
    viewed.push(99);
    expect(h.get('a')).toEqual([1]); // the store was not mutated through the view

    const p = new PostingIndex();
    expect([...p.get('missing')]).toEqual([]);
    p.add('x', 1);
    const pv = p.get('x');
    pv.add(99);
    expect([...p.get('x')]).toEqual([1]);
  });

  it('removing an absent value or an absent id is a no-op', () => {
    const p = new PostingIndex();
    p.add('x', 1);
    p.remove('y', 1); // value absent
    p.remove('x', 2); // id absent
    expect([...p.get('x')]).toEqual([1]);
  });

  it('intersect where one side is absent yields the empty set', () => {
    const p = new PostingIndex();
    p.add('x', 1);
    expect([...p.intersect('x', 'missing')]).toEqual([]);
  });
});

// ── BPlusTree ───────────────────────────────────────────────────────────────
describe('BPlusTree — empty, out-of-range, and range boundaries', () => {
  it('an empty tree answers every query without throwing', () => {
    const t = new BPlusTree();
    expect(t.size).toBe(0);
    expect(t.get(1)).toBeUndefined();
    expect(t.rank(1)).toBe(0);
    expect(t.select(0)).toBeUndefined();
    expect(t.range(0, 10)).toEqual([]);
  });

  it('rank/select are out-of-range safe and mutually inverse', () => {
    const t = new BPlusTree();
    const keys = [5, 1, 9, 3, 7, 2, 8, 0, 6, 4];
    for (const k of keys) t.insert(k, `v${k}`);
    expect(t.size).toBe(10);
    expect(t.select(-1)).toBeUndefined();
    expect(t.select(10)).toBeUndefined();
    for (let i = 0; i < 10; i++) {
      const entry = t.select(i);
      expect(entry).toEqual([i, `v${i}`]); // keys are 0..9 after sort
      expect(t.rank(i)).toBe(i);
    }
    // `rank` counts strictly-less, including for an absent key.
    expect(t.rank(3.5)).toBe(4);
    expect(t.rank(-1)).toBe(0);
    expect(t.rank(100)).toBe(10);
  });

  it('range is inclusive at both ends, and `lo > hi` is empty', () => {
    const t = new BPlusTree();
    for (const k of [1, 2, 3, 4, 5]) t.insert(k, `v${k}`);
    expect(t.range(2, 4).map((e) => e[0])).toEqual([2, 3, 4]);
    expect(t.range(2.5, 4.5).map((e) => e[0])).toEqual([3, 4]);
    expect(t.range(4, 2)).toEqual([]);
    expect(t.range(100, 200)).toEqual([]);
  });
});

// ── RoaringBitmap ───────────────────────────────────────────────────────────
describe('RoaringBitmap — empty, boundaries, and container promotion', () => {
  it('an empty bitmap reports zero everywhere; remove is a no-op', () => {
    const r = new RoaringBitmap();
    expect(r.cardinality).toBe(0);
    expect(r.toArray()).toEqual([]);
    expect(r.has(0)).toBe(false);
    r.remove(5);
    expect(r.cardinality).toBe(0);
  });

  it('add is idempotent and remove-to-empty clears the container', () => {
    const r = new RoaringBitmap();
    r.add(7);
    r.add(7);
    expect(r.cardinality).toBe(1);
    r.remove(7);
    expect(r.cardinality).toBe(0);
    expect(r.has(7)).toBe(false);
    expect(r.toArray()).toEqual([]);
  });

  it('handles the 16-bit boundaries and an unsigned high container', () => {
    const r = new RoaringBitmap();
    for (const v of [0, 65535, 65536, 65537]) r.add(v);
    expect(r.has(65535)).toBe(true);
    expect(r.has(65536)).toBe(true);
    expect(r.toArray()).toEqual([0, 65535, 65536, 65537]);

    // `add(-1)` is defined as `-1 >>> 0` = 4294967295, and `has` agrees — only the
    // materialising `toArray` is wrong for values whose high 16 bits are ≥ 32768.
    const w = new RoaringBitmap();
    w.add(-1);
    expect(w.has(4294967295)).toBe(true);
  });

  // CONFIRMED BUG (filed): `toArray` computes `base = hi << 16`, which overflows
  // int32 for hi ≥ 32768, so every value ≥ 2^31 is emitted NEGATIVE. `has` uses
  // `>>> 0` and is correct, so `toArray` is not the inverse of `add` at the top of
  // the range (and `union`/`intersect`, built on `toArray`, inherit it).
  it.fails('BUG: RoaringBitmap.toArray must round-trip values ≥ 2^31 as unsigned', () => {
    const r = new RoaringBitmap();
    r.add(2147483648); // 2^31
    r.add(4294967295);
    expect(r.toArray()).toEqual([2147483648, 4294967295]);
  });

  it('promotes exactly past the array-container threshold without dropping values', () => {
    const r = new RoaringBitmap();
    for (let i = 0; i < 4097; i++) r.add(i); // 4097 > ARRAY_MAX (4096)
    expect(r.cardinality).toBe(4097);
    expect(r.toArray()).toHaveLength(4097);
    expect(r.toArray()[4096]).toBe(4096);
  });

  it('union with self is idempotent; intersect with a disjoint set is empty', () => {
    const a = new RoaringBitmap();
    for (const v of [1, 2, 3]) a.add(v);
    expect(a.union(a).cardinality).toBe(3);
    const b = new RoaringBitmap();
    b.add(100);
    expect(a.intersect(b).cardinality).toBe(0);
  });
});

// ── Fenwick ─────────────────────────────────────────────────────────────────
describe('Fenwick — empty and out-of-range edges', () => {
  it('a size-0 tree answers queries as 0 and rejects an update', () => {
    const f = new Fenwick(0);
    expect(f.query(0)).toBe(0);
    expect(f.range(0, 0)).toBe(0);
    expect(() => f.update(0, 1)).toThrow(RangeError);
  });

  it('query clamps beyond the end; range(lo > hi) is 0; negative deltas subtract', () => {
    const f = Fenwick.from([1, 2, 3, 4, 5]);
    expect(f.query(100)).toBe(15); // clamped to the last index
    expect(f.range(3, 1)).toBe(0);
    f.update(0, -10);
    expect(f.query(0)).toBe(-9);
  });
});

// ── SkipList ────────────────────────────────────────────────────────────────
describe('SkipList — empty and duplicate-key edges', () => {
  it('an empty list answers queries without throwing', () => {
    const s = new SkipList();
    expect(s.size).toBe(0);
    expect(s.get(1)).toBeUndefined();
    expect(s.has(1)).toBe(false);
    expect(s.select(0)).toBeUndefined();
    expect(s.rank(1)).toBe(0);
    expect(s.range(0, 10)).toEqual([]);
  });

  it('a duplicate insert updates the value and does not grow the list', () => {
    const s = new SkipList();
    s.insert(3, 'a');
    s.insert(3, 'b');
    expect(s.size).toBe(1);
    expect(s.get(3)).toBe('b');
  });

  it('rank and select are mutually inverse over a set', () => {
    const s = new SkipList();
    const keys = [5, 1, 9, 3, 7, 0, 8, 2, 6, 4];
    for (const k of keys) s.insert(k, `v${k}`);
    expect(s.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(s.select(i)).toBe(`v${i}`);
      expect(s.rank(i)).toBe(i);
    }
    expect(s.select(10)).toBeUndefined();
    expect(s.select(-1)).toBeUndefined();
  });

  it('range is inclusive and `lo > hi` is empty', () => {
    const s = new SkipList();
    for (const k of [1, 2, 3, 4, 5]) s.insert(k, `v${k}`);
    expect(s.range(2, 4).map((e) => e[0])).toEqual([2, 3, 4]);
    expect(s.range(4, 2)).toEqual([]);
  });
});

// ── RadixTree ───────────────────────────────────────────────────────────────
describe('RadixTree — empty and prefix edges', () => {
  it('an empty tree answers every query', () => {
    const t = new RadixTree();
    expect(t.get('a')).toBeUndefined();
    expect(t.has('a')).toBe(false);
    expect(t.prefix('a')).toEqual([]);
  });

  it('prefix("") returns every key in order; upsert overwrites; a no-match prefix is empty', () => {
    const t = new RadixTree();
    t.insert('car', 1);
    t.insert('cart', 2);
    t.insert('cat', 3);
    t.insert('dog', 4);
    expect(t.prefix('')).toEqual([
      ['car', 1],
      ['cart', 2],
      ['cat', 3],
      ['dog', 4],
    ]);
    expect(t.prefix('cow')).toEqual([]);
    t.insert('cat', 99);
    expect(t.get('cat')).toBe(99);
    // A key that is only an internal node of a longer key is not a value.
    expect(t.get('ca')).toBeUndefined();
    expect(t.has('ca')).toBe(false);
  });
});

// ── LsmTree ─────────────────────────────────────────────────────────────────
describe('LsmTree — empty and newest-wins edges', () => {
  it('an empty tree returns undefined and an empty scan', () => {
    const l = new LsmTree(2, 2);
    expect(l.get(1)).toBeUndefined();
    expect(l.scan(0, 100)).toEqual([]);
    expect(l.runCount).toBe(0);
  });

  it('a newer write wins over an older run, across flush and scan', () => {
    const l = new LsmTree(1, 100); // flush on every put
    l.put(1, 'a');
    l.put(1, 'b');
    expect(l.get(1)).toBe('b');
    expect(l.scan(0, 10)).toEqual([[1, 'b']]);
  });

  it('scan is inclusive, `lo > hi` is empty, and a non-flushed memtable value is visible', () => {
    const l = new LsmTree(10, 10); // never auto-flush for this test
    l.put(1, 'a');
    l.put(3, 'c');
    l.put(2, 'b');
    expect(l.scan(2, 3)).toEqual([
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(l.scan(3, 1)).toEqual([]);
    expect(l.get(2)).toBe('b');
  });
});
