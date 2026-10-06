/**
 * A B+ tree with order-statistic rank/select (§11 rows 5–6): all keys live in the
 * leaves, internal nodes hold separator copies, leaves are linked for range scans,
 * and every node's subtree size is computed so `rank`/`select` are O(log n). The
 * "arbitrary ordered + range" and "exact rank / k-th" structure.
 */
const ORDER = 4; // max children per internal node (fan-out 4, for split coverage)
const MAX_KEYS = ORDER - 1;

class Leaf {
  readonly keys: number[] = [];
  readonly values: unknown[] = [];
  next: Leaf | undefined = undefined;
}

class Internal {
  readonly keys: number[] = []; // separator: keys[i] is the min key of children[i+1]
  readonly children: Array<Leaf | Internal> = [];
}

type Node = Leaf | Internal;

function subtreeSize(node: Node): number {
  return node instanceof Leaf ? node.keys.length : node.children.reduce((s, c) => s + subtreeSize(c), 0);
}

export class BPlusTree {
  private root: Node = new Leaf();

  get size(): number {
    return subtreeSize(this.root);
  }

  /** The number of keys strictly less than `key` (0-based rank). */
  rank(key: number): number {
    let r = 0;
    let node: Node = this.root;
    for (;;) {
      if (node instanceof Leaf) {
        for (const k of node.keys) {
          if (k < key) r += 1;
          else break;
        }
        return r;
      }
      let i = 0;
      while (i < node.keys.length && key > (node.keys[i] ?? 0)) {
        const child = node.children[i];
        if (child === undefined) return r;
        r += subtreeSize(child);
        i += 1;
      }
      const next = node.children[i];
      if (next === undefined) return r;
      node = next;
    }
  }

  /** The `[key, value]` at 0-based rank `index`, or `undefined`. */
  select(index: number): [number, unknown] | undefined {
    let node: Node = this.root;
    let target = index;
    for (;;) {
      if (node instanceof Leaf) {
        const k = node.keys[target];
        return k === undefined ? undefined : [k, node.values[target]];
      }
      let i = 0;
      for (;;) {
        const child = node.children[i];
        if (child === undefined) return undefined;
        const size = subtreeSize(child);
        if (target < size) {
          node = child;
          break;
        }
        target -= size;
        i += 1;
      }
    }
  }

  get(key: number): unknown {
    let node: Node = this.root;
    while (node instanceof Internal) {
      let i = 0;
      while (i < node.keys.length && key > (node.keys[i] ?? 0)) i += 1;
      const next = node.children[i];
      if (next === undefined) return undefined;
      node = next;
    }
    const i = node.keys.indexOf(key);
    return i < 0 ? undefined : node.values[i];
  }

  insert(key: number, value: unknown): void {
    const split = this.insertInto(this.root, key, value);
    if (split !== undefined) {
      const newRoot = new Internal();
      newRoot.children.push(this.root, split.right);
      newRoot.keys.push(split.separator);
      this.root = newRoot;
    }
  }

  private insertInto(node: Node, key: number, value: unknown): { separator: number; right: Node } | undefined {
    if (node instanceof Leaf) {
      const existing = node.keys.indexOf(key);
      if (existing >= 0) {
        node.values[existing] = value;
        return undefined;
      }
      let i = 0;
      while (i < node.keys.length && (node.keys[i] ?? 0) < key) i += 1;
      node.keys.splice(i, 0, key);
      node.values.splice(i, 0, value);
      if (node.keys.length <= MAX_KEYS) return undefined;
      const mid = Math.ceil(node.keys.length / 2);
      const right = new Leaf();
      right.keys.push(...node.keys.splice(mid));
      right.values.push(...node.values.splice(mid));
      right.next = node.next;
      node.next = right;
      return { separator: right.keys[0] as number, right };
    }
    let i = 0;
    while (i < node.keys.length && key > (node.keys[i] ?? 0)) i += 1;
    const child = node.children[i];
    if (child === undefined) return undefined;
    const childSplit = this.insertInto(child, key, value);
    if (childSplit === undefined) return undefined;
    node.keys.splice(i, 0, childSplit.separator);
    node.children.splice(i + 1, 0, childSplit.right);
    if (node.keys.length <= MAX_KEYS) return undefined;
    const mid = Math.ceil(node.keys.length / 2);
    const right = new Internal();
    const sep = node.keys.splice(mid, 1)[0] as number;
    right.keys.push(...node.keys.splice(mid));
    right.children.push(...node.children.splice(mid + 1));
    return { separator: sep, right };
  }

  /** All `[key, value]` with `lo <= key <= hi`, ascending. */
  range(lo: number, hi: number): Array<[number, unknown]> {
    const out: Array<[number, unknown]> = [];
    let node: Node = this.root;
    while (node instanceof Internal) {
      let i = 0;
      while (i < node.keys.length && lo > (node.keys[i] ?? 0)) i += 1;
      const next = node.children[i];
      if (next === undefined) return out;
      node = next;
    }
    let leaf: Leaf | undefined = node;
    while (leaf !== undefined) {
      for (let i = 0; i < leaf.keys.length; i++) {
        const k = leaf.keys[i] as number;
        if (k > hi) return out;
        if (k >= lo) out.push([k, leaf.values[i]]);
      }
      leaf = leaf.next;
    }
    return out;
  }
}
