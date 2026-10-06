/**
 * Independent Big-O / correctness harness for the §11 index structures.
 * NOT part of the authored suite — added by an independent performance review to
 * (a) independently measure the growth exponents the authored tests bound, and
 * (b) cover hot paths the authored suite asserts complexity for but does not test
 *     (`SkipList.rank`/`select`, `BPlusTree.range`, `Fenwick` growth, roaring
 *     container-boundary exactness).
 *
 * Structural observables only (node visits / array-cell reads) — no wall-clock.
 */
import { describe, it, expect, vi } from 'vitest';
import { BPlusTree, SkipList, Fenwick, RoaringBitmap } from './index';

interface RawNode {
  keys: number[];
  size?: number;
  children?: RawNode[];
  forward?: Array<RawNode | undefined>;
}

const INDEX_PROP = /^(0|[1-9]\d*)$/;
const exp = (a: number, b: number, span: number): number => Math.log2(b / a) / Math.log2(span);

/** Count numeric-index reads of every internal node's `children`. */
function treeMeter(tree: BPlusTree): { reads: () => number; reset: () => void } {
  let reads = 0;
  const seen = new Set<RawNode>();
  const walk = (node: RawNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.children)) {
      const real = node.children;
      node.children = new Proxy(real, {
        get(t, p) {
          if (typeof p === 'string' && INDEX_PROP.test(p)) reads += 1;
          return Reflect.get(t, p, t);
        },
      });
      for (const c of real) walk(c);
    }
  };
  walk((tree as unknown as { root: RawNode }).root);
  return { reads: () => reads, reset: () => { reads = 0; } };
}

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

/** Count forward-pointer reads across a skiplist built deterministically. */
function skipMeter(n: number): { sl: SkipList; reads: () => number; reset: () => void } {
  const rand = vi.spyOn(Math, 'random').mockImplementation(mulberry32(0xabc + n));
  const sl = new SkipList();
  for (let i = 0; i < n; i++) sl.insert(i, i);
  rand.mockRestore();
  const head = (sl as unknown as { head: RawNode }).head;
  const nodes: RawNode[] = [];
  let cur = head.forward?.[0];
  while (cur !== undefined) {
    nodes.push(cur);
    cur = cur.forward?.[0];
  }
  let reads = 0;
  for (const node of [head, ...nodes]) {
    const real = node.forward as Array<RawNode | undefined>;
    node.forward = new Proxy(real, {
      get(t, p) {
        if (typeof p === 'string' && INDEX_PROP.test(p)) reads += 1;
        return Reflect.get(t, p, t);
      },
    });
  }
  return { sl, reads: () => reads, reset: () => { reads = 0; } };
}

const buildBPlus = (n: number): BPlusTree => {
  const t = new BPlusTree();
  for (let i = 0; i < n; i++) t.insert(i, i);
  return t;
};

describe('BPlusTree — independent growth check', () => {
  it('rank+select visit-count grows sub-linearly (exponent < 0.4) across 64×', () => {
    const measure = (n: number): number => {
      const t = buildBPlus(n);
      const m = treeMeter(t);
      m.reset();
      t.rank(n - 1);
      t.select(0);
      return m.reads();
    };
    const a = measure(1024);
    const b = measure(65536); // 64×
    expect(exp(a, b, 64)).toBeLessThan(0.4);
  });

  it('range over a fixed-width window is sub-linear in n (O(log n + k))', () => {
    const measure = (n: number): number => {
      const t = buildBPlus(n);
      const m = treeMeter(t);
      m.reset();
      const lo = n >> 1;
      t.range(lo, lo + 10);
      return m.reads();
    };
    const a = measure(1024);
    const b = measure(65536);
    expect(exp(a, b, 64)).toBeLessThan(0.4);
  });
});

describe('SkipList — rank/select (claimed O(log n); UNTESTED by the authored suite)', () => {
  it('rank + select reads grow sub-linearly (exponent < 0.5) across 8×', () => {
    const measure = (n: number): number => {
      const { sl, reads, reset } = skipMeter(n);
      reset();
      sl.rank(n >> 1);
      sl.select(n >> 1);
      return reads();
    };
    const a = measure(1024);
    const b = measure(8192); // 8×
    expect(exp(a, b, 8)).toBeLessThan(0.5);
  });

  it('rank/select are correct for a range of positions', () => {
    const { sl } = skipMeter(512);
    for (const i of [0, 1, 255, 511]) {
      expect(sl.select(i), `select(${i})`).toBe(i);
      expect(sl.rank(i), `rank(${i})`).toBe(i);
    }
  });
});

describe('RoaringBitmap — container-boundary exactness', () => {
  it('preserves values at bit 31, the 32768 word boundary, and the 65535 container end', () => {
    const r = new RoaringBitmap();
    const values = [0, 31, 32, 32767, 32768, 32769, 65535, 65536, 70000];
    for (const v of values) r.add(v);
    expect(r.cardinality).toBe(values.length);
    for (const v of values) expect(r.has(v), `has(${v})`).toBe(true);
    expect([...r.toArray()].sort((x, y) => x - y)).toEqual(values);
  });

  it('a promoted (>4096) bitmap container keeps every value across word boundaries', () => {
    const r = new RoaringBitmap();
    const n = 5000;
    for (let i = 0; i < n; i++) r.add(i); // promotes hi=0 to a bitmap container
    r.add(32768); // a value above the old (32768-bit) array bound
    r.add(65535); // bit 31 of the container's final word
    r.remove(32768);
    const arr = r.toArray();
    expect(arr).toHaveLength(n + 1); // 5000 + 65535, minus the removed 32768
    expect(arr).toContain(65535);
    expect(arr).not.toContain(32768);
    expect(r.has(32768)).toBe(false);
    expect(arr.every((x) => Number.isInteger(x))).toBe(true);
  });
});

describe('Fenwick — independent growth check', () => {
  it('update+query cell-touches grow ~logarithmically', () => {
    const measure = (n: number): number => {
      const f = new Fenwick(n);
      const tree = (f as unknown as { tree: number[] }).tree;
      let touches = 0;
      (f as unknown as { tree: number[] }).tree = new Proxy(tree, {
        get(t, p) {
          if (typeof p === 'string' && INDEX_PROP.test(p)) touches += 1;
          return Reflect.get(t, p, t);
        },
        set(t, p, v) {
          if (typeof p === 'string' && INDEX_PROP.test(p)) touches += 1;
          return Reflect.set(t, p, v, t);
        },
      });
      f.update(0, 1);
      f.query(n - 2);
      return touches;
    };
    const a = measure(1 << 14);
    const b = measure(1 << 20); // 64×
    expect(exp(a, b, 64)).toBeLessThan(0.4);
  });
});
