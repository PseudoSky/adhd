/**
 * A rank-supporting skip list (§11 row 8): ordered insert/search/range plus
 * RANK and select in O(log n) expected — the append-heavy ordered + rank
 * structure. Level spans carry the subtree sizes, so `rank` never scans.
 */
const MAX_LEVEL = 24;
const P = 0.25;

class SLNode {
  readonly forward: Array<SLNode | undefined>;
  readonly span: number[];
  constructor(
    readonly key: number,
    public value: unknown,
    level: number
  ) {
    this.forward = new Array<SLNode | undefined>(level + 1).fill(undefined);
    this.span = new Array<number>(level + 1).fill(0);
  }
}

export class SkipList {
  private readonly head = new SLNode(Number.NEGATIVE_INFINITY, undefined, MAX_LEVEL);
  private level = 0;
  private length = 0;

  private static randomLevel(): number {
    let lvl = 0;
    while (lvl < MAX_LEVEL && Math.random() < P) lvl += 1;
    return lvl;
  }

  get size(): number {
    return this.length;
  }

  private locate(key: number, update: Array<SLNode>, rank: number[]): void {
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      rank[i] = i === this.level ? 0 : (rank[i + 1] ?? 0);
      let fwd = x.forward[i];
      while (fwd !== undefined && fwd.key < key) {
        rank[i] = (rank[i] ?? 0) + (x.span[i] ?? 0);
        x = fwd;
        fwd = x.forward[i];
      }
      update[i] = x;
    }
  }

  /** 0-based rank — the number of entries strictly before `key`. */
  rank(key: number): number {
    let x = this.head;
    let r = 0;
    for (let i = this.level; i >= 0; i--) {
      let fwd = x.forward[i];
      while (fwd !== undefined && fwd.key < key) {
        r += x.span[i] ?? 0;
        x = fwd;
        fwd = x.forward[i];
      }
    }
    return r;
  }

  private find(key: number): SLNode | undefined {
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      let fwd = x.forward[i];
      while (fwd !== undefined && fwd.key < key) {
        x = fwd;
        fwd = x.forward[i];
      }
    }
    const target = x.forward[0];
    return target?.key === key ? target : undefined;
  }

  get(key: number): unknown {
    return this.find(key)?.value;
  }

  has(key: number): boolean {
    return this.find(key) !== undefined;
  }

  insert(key: number, value: unknown): void {
    const update: SLNode[] = new Array<SLNode>(MAX_LEVEL + 1).fill(this.head);
    const rank: number[] = new Array<number>(MAX_LEVEL + 1).fill(0);
    this.locate(key, update, rank);

    const existing = update[0].forward[0];
    if (existing?.key === key) {
      existing.value = value;
      return;
    }

    const lvl = SkipList.randomLevel();
    if (lvl > this.level) {
      for (let i = this.level + 1; i <= lvl; i++) {
        rank[i] = 0;
        update[i] = this.head;
      }
      this.level = lvl;
    }
    const node = new SLNode(key, value, lvl);
    for (let i = 0; i <= lvl; i++) {
      const up = update[i];
      node.forward[i] = up.forward[i];
      up.forward[i] = node;
      node.span[i] = (up.span[i] ?? 0) - ((rank[0] ?? 0) - (rank[i] ?? 0));
      up.span[i] = (rank[0] ?? 0) - (rank[i] ?? 0) + 1;
    }
    for (let i = lvl + 1; i <= this.level; i++) update[i].span[i] = (update[i].span[i] ?? 0) + 1;
    this.length += 1;
  }

  /** The value at 0-based rank `index`, or `undefined` (the Redis rank-descent). */
  select(index: number): unknown {
    if (index < 0 || index >= this.length) return undefined;
    let x = this.head;
    let rank = index + 1;
    for (let i = this.level; i >= 0; i--) {
      let fwd = x.forward[i];
      while (fwd !== undefined && (x.span[i] ?? 0) <= rank) {
        rank -= x.span[i] ?? 0;
        x = fwd;
        fwd = x.forward[i];
      }
      if (rank === 0) return x.value;
    }
    return undefined;
  }

  /** All entries with `lo <= key <= hi`, ascending. */
  range(lo: number, hi: number): Array<[number, unknown]> {
    const out: Array<[number, unknown]> = [];
    let x = this.head;
    for (let i = this.level; i >= 0; i--) {
      let fwd = x.forward[i];
      while (fwd !== undefined && fwd.key < lo) {
        x = fwd;
        fwd = x.forward[i];
      }
    }
    let node = x.forward[0];
    while (node !== undefined && node.key <= hi) {
      out.push([node.key, node.value]);
      node = node.forward[0];
    }
    return out;
  }
}
