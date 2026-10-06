/**
 * Big-O complexity specs for the §11 index structures.
 *
 * These tests assert ALGORITHMIC bounds through observable STRUCTURAL quantities
 * (backing-Map operations, integer-array cell reads, node visits, tree height) —
 * never wall-clock time. Each is deterministic, so it cannot flake, and each has
 * teeth: the deliberately-wrong (linear) variant of the implementation fails it.
 *
 * The white-box `as unknown as { ... }` casts read fields TypeScript marks
 * `private`; at runtime `private` is erased, and height / backing-container size
 * / node visits are exactly the structural observables a complexity proof needs.
 */
import { describe, it, expect, vi } from 'vitest';
import { HashIndex, PostingIndex, RoaringBitmap, Fenwick, SkipList, BPlusTree, RadixTree, LsmTree } from './index';

// ── deterministic instrumentation ───────────────────────────────────────────

const INDEX_PROP = /^(0|[1-9]\d*)$/;

interface IndexArrayMeter<T> {
  proxy: T[];
  reads: () => number;
  writes: () => number;
}
/** Wrap an array so numeric-index reads/writes are counted. */
function meterIndexArray<T>(arr: T[]): IndexArrayMeter<T> {
  let reads = 0;
  let writes = 0;
  const proxy = new Proxy(arr, {
    get(target, prop) {
      if (typeof prop === 'string' && INDEX_PROP.test(prop)) reads += 1;
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && INDEX_PROP.test(prop)) writes += 1;
      return Reflect.set(target, prop, value, target);
    },
  });
  return { proxy, reads: () => reads, writes: () => writes };
}

interface MapMeter<K, V> {
  proxy: Map<K, V>;
  get: () => number;
  set: () => number;
}
/** Wrap a Map so `get`/`set` calls are counted (method returns are bound to it). */
function meterMap<K, V>(map: Map<K, V>): MapMeter<K, V> {
  let gets = 0;
  let sets = 0;
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (prop === 'get') return (key: K): V | undefined => { gets += 1; return target.get(key); };
      if (prop === 'set') return (key: K, value: V): Map<K, V> => { sets += 1; return target.set(key, value); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, get: () => gets, set: () => sets };
}

interface PostingMeter {
  proxy: Map<string, Set<number>>;
  hasCalls: () => number;
}
/** Wrap a posting Map so a `has()` probe on any returned id-Set is counted. */
function meterPostingMap(map: Map<string, Set<number>>): PostingMeter {
  let hasCalls = 0;
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string): Set<number> | undefined => {
          const set = target.get(key);
          if (set === undefined) return undefined;
          return new Proxy(set, {
            get(st, sp) {
              if (sp === 'has') return (v: number): boolean => { hasCalls += 1; return st.has(v); };
              const value = Reflect.get(st, sp, st);
              return typeof value === 'function' ? value.bind(st) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, hasCalls: () => hasCalls };
}

/** A small seeded PRNG so skiplist level assignment is deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── structural views of otherwise-private internals ─────────────────────────

interface RawSkipNode { forward: Array<RawSkipNode | undefined>; }
interface RawBTreeNode { keys: number[]; size?: number; children?: RawBTreeNode[]; }
interface RawArtNode { children: Map<string, RawArtNode>; }

/** The number of levels in a B+ tree (root → leftmost leaf). */
function bPlusHeight(tree: BPlusTree): number {
  let node = (tree as unknown as { root: RawBTreeNode }).root;
  let height = 0;
  while (Array.isArray(node.children)) {
    height += 1;
    const only = node.children[0];
    if (only === undefined) break;
    node = only;
  }
  return height;
}

// ── HashIndex — O(1) expected lookup/insert ─────────────────────────────────

describe('HashIndex — O(1) lookup/insert (§11 row 1)', () => {
  it('a get touches the backing Map once for every n', () => {
    for (const n of [16, 1024, 65536]) {
      const h = new HashIndex();
      const meter = meterMap((h as unknown as { map: Map<string, number[]> }).map);
      (h as unknown as { map: Map<string, number[]> }).map = meter.proxy;
      const distinct = Math.max(1, Math.floor(Math.sqrt(n)));
      for (let i = 0; i < n; i++) h.add(i % distinct, i);
      const before = meter.get();
      h.get(0);
      expect(meter.get() - before).toBe(1);
    }
  });

  it('an insert is a constant number of Map operations', () => {
    const h = new HashIndex();
    const meter = meterMap((h as unknown as { map: Map<string, number[]> }).map);
    (h as unknown as { map: Map<string, number[]> }).map = meter.proxy;
    for (let i = 0; i < 1000; i++) h.add(i % 10, i);
    const beforeGet = meter.get();
    const beforeSet = meter.set();
    h.add(5, 9999);
    expect(meter.get() - beforeGet).toBe(1); // one lookup of the bucket
    expect(meter.set() - beforeSet).toBeLessThanOrEqual(1); // at most one store
  });
});

// ── PostingIndex — O(min(|A|,|B|)) intersection ─────────────────────────────

describe('PostingIndex — intersection is O(min(|A|,|B|))', () => {
  it('probes exactly the smaller posting list', () => {
    for (const [a, b] of [
      [10, 1000],
      [1000, 10],
      [500, 500],
    ]) {
      const p = new PostingIndex();
      const meter = meterPostingMap((p as unknown as { map: Map<string, Set<number>> }).map);
      (p as unknown as { map: Map<string, Set<number>> }).map = meter.proxy;
      for (let i = 0; i < a; i++) p.add('A', i);
      for (let i = 0; i < b; i++) p.add('B', i);
      const before = meter.hasCalls();
      const out = p.intersect('A', 'B');
      expect(meter.hasCalls() - before).toBe(Math.min(a, b)); // never scans the larger
      expect(out.size).toBe(Math.min(a, b));
    }
  });
});

// ── RoaringBitmap — O(k) set ops (k = smaller cardinality) ──────────────────

describe('RoaringBitmap — O(k) set operations', () => {
  it('intersect probes only the smaller bitmap', () => {
    const small = new RoaringBitmap();
    const large = new RoaringBitmap();
    for (let i = 0; i < 40; i++) small.add(i);
    for (let i = 0; i < 4000; i++) large.add(i * 2);
    const probe = vi.spyOn(RoaringBitmap.prototype, 'has');
    small.intersect(large);
    expect(probe).toHaveBeenCalledTimes(40); // k = |small|, independent of |large|
    expect(small.intersect(large).cardinality).toBe(20);
    probe.mockRestore();
  });

  it('union inserts each member exactly once', () => {
    const a = new RoaringBitmap();
    const b = new RoaringBitmap();
    for (let i = 0; i < 300; i++) a.add(i);
    for (let i = 150; i < 400; i++) b.add(i);
    const add = vi.spyOn(RoaringBitmap.prototype, 'add');
    const u = a.union(b);
    expect(add).toHaveBeenCalledTimes(300 + 250); // |a| + |b|, overlap included
    expect(u.cardinality).toBe(400);
    add.mockRestore();
  });

  it('REGRESSION: toArray is exact when a container word has bit 31 set', () => {
    // A 4100-member container promotes to a bitmap; its last word has bit 31 set.
    // The old `Math.log2(lsb)` returned NaN for the signed 0x80000000 low bit.
    const r = new RoaringBitmap();
    for (let i = 0; i < 4100; i++) r.add(i);
    const arr = r.toArray();
    expect(arr).toHaveLength(4100);
    expect(arr.some((v) => Number.isNaN(v))).toBe(false);
    expect(arr[arr.length - 1]).toBe(4099);
    expect(arr[4095]).toBe(4095); // the bit-31 value, previously NaN
    r.add(65535); // bit 31 of the final word of the container
    expect(r.has(65535)).toBe(true);
    expect(r.toArray()).toContain(65535);
  });
});

// ── Fenwick — O(log n) update/query ─────────────────────────────────────────

describe('Fenwick — O(log n) point-update and prefix-query', () => {
  it('touches at most 2·log2(n) cells per operation, for growing n', () => {
    for (const n of [1024, 65536, 1048576]) {
      const f = new Fenwick(n);
      const meter = meterIndexArray((f as unknown as { tree: number[] }).tree);
      (f as unknown as { tree: number[] }).tree = meter.proxy;
      const budget = 2 * (Math.ceil(Math.log2(n)) + 1) + 2;
      f.update(0, 1); // longest update path (1 → n)
      expect(meter.reads() + meter.writes()).toBeLessThanOrEqual(budget);
      const before = meter.reads() + meter.writes();
      f.query(n - 2); // n-1 = all-ones → popcount = log2(n) steps
      expect(meter.reads() + meter.writes() - before).toBeLessThanOrEqual(budget);
    }
  });

  it('op count grows by ~2 per 4x of n (logarithmic, not linear)', () => {
    const measure = (n: number): number => {
      const f = new Fenwick(n);
      const meter = meterIndexArray((f as unknown as { tree: number[] }).tree);
      (f as unknown as { tree: number[] }).tree = meter.proxy;
      f.update(0, 1);
      return meter.reads() + meter.writes();
    };
    const a = measure(1 << 14);
    const b = measure(1 << 20); // 64× the size
    // ~2 cells per level, log2(64)=6 new levels ⇒ a small constant; a linear scan adds ~1,000,000.
    expect(b - a).toBeLessThanOrEqual(2 * Math.log2(64) + 2);
    expect(b).toBeLessThanOrEqual(2 * (Math.log2(1 << 20) + 1) + 2);
  });
});

// ── SkipList — O(log n) expected search, logarithmic height ─────────────────

describe('SkipList — O(log n) expected search', () => {
  const measure = (n: number): { level: number; reads: number } => {
    const random = vi.spyOn(Math, 'random').mockImplementation(mulberry32(0x5eed + n));
    const sl = new SkipList();
    for (let i = 0; i < n; i++) sl.insert(i, i);
    random.mockRestore();
    const level = (sl as unknown as { level: number }).level;
    const head = (sl as unknown as { head: RawSkipNode }).head;
    const nodes: RawSkipNode[] = [];
    let cur = head.forward[0];
    while (cur !== undefined) {
      nodes.push(cur);
      cur = cur.forward[0];
    }
    let reads = 0;
    const wrap = (node: RawSkipNode): void => {
      const real = node.forward;
      node.forward = new Proxy(real, {
        get(target, prop) {
          if (typeof prop === 'string' && INDEX_PROP.test(prop)) reads += 1;
          return Reflect.get(target, prop, target);
        },
      });
    };
    wrap(head);
    for (const node of nodes) wrap(node);
    reads = 0;
    sl.get(Math.floor(n / 2)); // a mid-list search, the expected O(log n) case
    return { level, reads };
  };

  it('height stays logarithmic and search does not scan the list', () => {
    const a = measure(4096);
    const b = measure(16384); // 4× the entries
    expect(a.level).toBeLessThanOrEqual(Math.ceil(Math.log(4096) / Math.log(4)) + 6);
    expect(b.level).toBeLessThanOrEqual(Math.ceil(Math.log(16384) / Math.log(4)) + 6);
    // A linear list would read ~n forward pointers; a skip list reads ~height.
    expect(b.reads).toBeLessThan(a.reads + 64);
    expect(b.reads).toBeLessThan(16384 / 8);
  });
});

// ── BPlusTree — O(log n) order-statistic rank/select ────────────────────────

interface TreeVisitMeter {
  visits: () => number;
  reduces: () => number;
  reset: () => void;
}
/** Count node-child reads (numeric index) and child-array `reduce` calls. */
function meterTreeChildren(tree: BPlusTree): TreeVisitMeter {
  let visits = 0;
  let reduces = 0;
  const seen = new Set<RawBTreeNode>();
  const walk = (node: RawBTreeNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.children)) {
      const real = node.children;
      node.children = new Proxy(real, {
        get(target, prop) {
          if (typeof prop === 'string') {
            if (INDEX_PROP.test(prop)) visits += 1;
            else if (prop === 'reduce') { visits += 1; reduces += 1; }
          }
          return Reflect.get(target, prop, target);
        },
      });
      for (const child of real) walk(child);
    }
  };
  walk((tree as unknown as { root: RawBTreeNode }).root);
  return { visits: () => visits, reduces: () => reduces, reset: () => { visits = 0; reduces = 0; } };
}

describe('BPlusTree — O(log n) rank/select (§11 rows 5–6)', () => {
  const build = (n: number): BPlusTree => {
    const t = new BPlusTree();
    for (let i = 0; i < n; i++) t.insert(i, `v${i}`);
    return t;
  };

  it('rank/select/get visit O(log n) nodes and never recompute subtree sizes', () => {
    for (const n of [1024, 65536]) {
      const t = build(n);
      const height = bPlusHeight(t);
      expect(height).toBeLessThanOrEqual(Math.ceil(Math.log(n) / Math.log(4)) + 2);
      const meter = meterTreeChildren(t);
      meter.reset();
      expect(t.rank(n - 1)).toBe(n - 1);
      expect(t.select(n - 1)).toEqual([n - 1, `v${n - 1}`]);
      expect(t.get(n - 1)).toBe(`v${n - 1}`);
      // A recursive subtree-size recompute visits the whole subtree → O(n) reduces.
      expect(meter.reduces()).toBe(0);
      expect(meter.visits()).toBeLessThanOrEqual(12 * (height + 1));
    }
  });

  it('`size` is O(1) (no subtree recompute)', () => {
    const t = build(65536);
    const meter = meterTreeChildren(t);
    meter.reset();
    expect(t.size).toBe(65536);
    expect(meter.reduces()).toBe(0);
    expect(meter.visits()).toBe(0);
  });

  it('work grows sub-linearly across n', () => {
    const measure = (n: number): number => {
      const t = build(n);
      const meter = meterTreeChildren(t);
      meter.reset();
      t.rank(n - 1);
      t.select(0);
      return meter.visits();
    };
    const a = measure(1024);
    const b = measure(65536); // 64× the entries
    expect(b).toBeLessThanOrEqual(a + 8 * Math.ceil(Math.log2(64)));
  });
});

// ── RadixTree (ART) — O(key length) exact access ────────────────────────────

describe('RadixTree (ART) — O(key length) exact access', () => {
  const buildKeys = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `key-${i.toString(36).padStart(6, '0')}`);

  const measure = (n: number): number => {
    const t = new RadixTree();
    const keys = buildKeys(n);
    for (const k of keys) t.insert(k, k);
    const root = (t as unknown as { root: RawArtNode }).root;
    let gets = 0;
    const seen = new Set<RawArtNode>();
    const walk = (node: RawArtNode): void => {
      if (seen.has(node)) return;
      seen.add(node);
      const real = node.children;
      node.children = new Proxy(real, {
        get(target, prop) {
          if (prop === 'get') return (c: string): RawArtNode | undefined => { gets += 1; return target.get(c); };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      for (const child of real.values()) walk(child);
    };
    walk(root);
    gets = 0;
    t.get(keys[n >> 1]);
    return gets;
  };

  it('a lookup probes at most key.length radix nodes, independent of n', () => {
    const small = measure(256);
    const large = measure(65536); // 256× the keys, same key length
    // Path-compressed: probes are bounded by the key length (10), not by n.
    expect(small).toBeLessThanOrEqual(10);
    expect(large).toBeLessThanOrEqual(10);
  });

  it('compresses shared prefixes (fewer nodes than total characters)', () => {
    const t = new RadixTree();
    const keys = buildKeys(4096);
    for (const k of keys) t.insert(k, k);
    const seen = new Set<RawArtNode>();
    const count = (node: RawArtNode): number => {
      if (seen.has(node)) return 0;
      seen.add(node);
      let total = 1;
      for (const child of node.children.values()) total += count(child);
      return total;
    };
    const nodes = count((t as unknown as { root: RawArtNode }).root);
    expect(nodes).toBeLessThan(keys.reduce((s, k) => s + k.length, 0) / 4);
  });
});

// ── LsmTree — O(1) memtable put, bounded run count ──────────────────────────

describe('LsmTree — O(1) memtable put, bounded run fan-out', () => {
  it('each put is a single memtable store; compaction keeps runs bounded', () => {
    const l = new LsmTree(8, 4);
    const meter = meterMap((l as unknown as { mem: Map<number, unknown> }).mem);
    (l as unknown as { mem: Map<number, unknown> }).mem = meter.proxy;
    for (let i = 0; i < 1000; i++) l.put(i, i);
    expect(meter.set()).toBe(1000); // one memtable write per put — never a run rewrite
    expect(l.runCount).toBeLessThan(4); // < compactAt: a read examines O(1) runs
    expect(l.get(500)).toBe(500);
    expect(l.get(9999)).toBeUndefined();
  });
});
