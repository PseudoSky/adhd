import { describe, it, expect } from 'vitest';
import {
  HashIndex,
  PostingIndex,
  RoaringBitmap,
  Fenwick,
  SkipList,
  BPlusTree,
  RadixTree,
  LsmTree,
} from './index';

describe('HashIndex', () => {
  it('maps a value to its ids', () => {
    const h = new HashIndex();
    h.add('a', 1);
    h.add('a', 2);
    h.add('b', 3);
    expect(h.get('a')).toEqual([1, 2]);
    expect(h.has('b')).toBe(true);
    h.remove('a', 1);
    expect(h.get('a')).toEqual([2]);
  });
});

describe('PostingIndex', () => {
  it('stores value → id sets and intersects', () => {
    const p = new PostingIndex();
    p.add('x', 1);
    p.add('x', 2);
    p.add('y', 2);
    expect([...p.get('x')].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...p.intersect('x', 'y')]).toEqual([2]);
    p.remove('x', 1);
    expect([...p.get('x')]).toEqual([2]);
  });
});

describe('RoaringBitmap', () => {
  it('stores across high-16 containers and unions/intersects', () => {
    const r = new RoaringBitmap();
    for (const v of [1, 5, 70000, 70001]) r.add(v);
    expect(r.has(70000)).toBe(true);
    expect(r.has(2)).toBe(false);
    expect(r.cardinality).toBe(4);
    expect(r.toArray()).toEqual([1, 5, 70000, 70001]);
    const s = new RoaringBitmap();
    s.add(5);
    s.add(99999);
    expect(r.intersect(s).toArray()).toEqual([5]);
    expect(r.union(s).cardinality).toBe(5);
  });

  it('promotes a dense array container to a bitmap container', () => {
    const d = new RoaringBitmap();
    for (let i = 0; i < 5000; i++) d.add(i);
    expect(d.cardinality).toBe(5000);
    expect(d.has(4999)).toBe(true);
    d.remove(4999);
    expect(d.has(4999)).toBe(false);
    expect(d.cardinality).toBe(4999);
  });
});

describe('Fenwick', () => {
  it('answers prefix and range sums', () => {
    const f = Fenwick.from([1, 2, 3, 4, 5]);
    expect(f.query(2)).toBe(6);
    expect(f.range(1, 3)).toBe(9);
    f.update(0, 10);
    expect(f.query(0)).toBe(11);
    expect(f.range(0, 4)).toBe(25);
  });
});

describe('SkipList', () => {
  it('orders, ranks and selects', () => {
    const s = new SkipList();
    for (const v of [3, 1, 2, 5, 4]) s.insert(v, `v${v}`);
    expect(s.size).toBe(5);
    expect(s.get(3)).toBe('v3');
    expect(s.has(4)).toBe(true);
    expect(s.rank(3)).toBe(2);
    expect(s.select(0)).toBe('v1');
    expect(s.select(4)).toBe('v5');
    expect(s.range(2, 4)).toEqual([
      [2, 'v2'],
      [3, 'v3'],
      [4, 'v4'],
    ]);
  });
});

describe('BPlusTree', () => {
  it('splits, ranks, selects and ranges', () => {
    const t = new BPlusTree();
    for (let i = 0; i < 20; i++) t.insert(i, `v${i}`);
    expect(t.size).toBe(20);
    expect(t.get(7)).toBe('v7');
    expect(t.get(99)).toBeUndefined();
    expect(t.rank(7)).toBe(7);
    expect(t.select(3)).toEqual([3, 'v3']);
    expect(t.range(5, 8)).toEqual([
      [5, 'v5'],
      [6, 'v6'],
      [7, 'v7'],
      [8, 'v8'],
    ]);
    t.insert(7, 'V7');
    expect(t.get(7)).toBe('V7');
    expect(t.size).toBe(20);
  });
});

describe('RadixTree (ART)', () => {
  it('compresses shared prefixes and scans a prefix', () => {
    const t = new RadixTree();
    t.insert('car', 1);
    t.insert('cart', 2);
    t.insert('cat', 3);
    t.insert('dog', 4);
    expect(t.get('car')).toBe(1);
    expect(t.get('cart')).toBe(2);
    expect(t.get('ca')).toBeUndefined();
    expect(t.has('cat')).toBe(true);
    expect(t.has('do')).toBe(false);
    expect(t.prefix('car')).toEqual([
      ['car', 1],
      ['cart', 2],
    ]);
    expect(t.prefix('c')).toEqual([
      ['car', 1],
      ['cart', 2],
      ['cat', 3],
    ]);
  });
});

describe('LsmTree', () => {
  it('flushes, compacts, and reads newest-first', () => {
    const l = new LsmTree(2, 2);
    l.put(1, 'a');
    l.put(5, 'e'); // flush → run [1,5]
    l.put(3, 'c');
    l.put(2, 'b'); // flush → 2 runs → compact to 1
    expect(l.runCount).toBe(1);
    l.put(1, 'A'); // memtable
    expect(l.get(1)).toBe('A'); // memtable wins
    expect(l.get(5)).toBe('e'); // from the run
    expect(l.scan(1, 3)).toEqual([
      [1, 'A'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });
});
