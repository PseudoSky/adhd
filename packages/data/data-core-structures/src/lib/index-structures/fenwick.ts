/**
 * A Fenwick (binary-indexed) tree (§11 row 4): prefix sums over a fixed-size
 * ordered dimension, with O(log n) point-update and prefix-query. A window
 * `[lo, hi]` is a prefix difference (`query(hi) - query(lo-1)`) — the O(log n)
 * window edge the spec calls for.
 */
export class Fenwick {
  private readonly tree: number[];

  constructor(readonly size: number) {
    this.tree = new Array<number>(size + 1).fill(0);
  }

  /** Add `delta` at 0-based index `i`. Throws on an out-of-range index (an `i < 0`
   *  would otherwise spin forever: `x = i+1 = 0` and `x & -x === 0` never advances). */
  update(i: number, delta: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.size) {
      throw new RangeError(`Fenwick.update: index ${i} out of range [0, ${this.size})`);
    }
    for (let x = i + 1; x <= this.size; x += x & -x) this.tree[x] = (this.tree[x] ?? 0) + delta;
  }

  /** The prefix sum of indices `[0, i]`. */
  query(i: number): number {
    let sum = 0;
    for (let x = Math.min(i, this.size - 1) + 1; x > 0; x -= x & -x) sum += this.tree[x] ?? 0;
    return sum;
  }

  /** The sum over `[lo, hi]` inclusive. */
  range(lo: number, hi: number): number {
    if (hi < lo) return 0;
    const before = lo === 0 ? 0 : this.query(lo - 1);
    return this.query(hi) - before;
  }

  static from(values: number[]): Fenwick {
    const f = new Fenwick(values.length);
    values.forEach((v, i) => {
      if (v !== 0) f.update(i, v);
    });
    return f;
  }
}
