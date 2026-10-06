/**
 * A path-compressed radix tree — the core of an Adaptive Radix Tree (§11 row 9) for
 * string/byte keys. Each node carries the edge label shared by every key beneath it
 * and a map of children keyed by their next character, so keys that share a prefix
 * share nodes. Supports exact `get`, upsert, and an ordered `prefix` scan.
 */
function commonPrefix(source: string, offset: number, label: string): number {
  const n = Math.min(source.length - offset, label.length);
  let i = 0;
  while (i < n && source[offset + i] === label[i]) i += 1;
  return i;
}

class RadixNode {
  label = '';
  readonly children = new Map<string, RadixNode>();
  value: unknown;
  hasValue = false;
}

export class RadixTree {
  private readonly root = new RadixNode();

  insert(key: string, value: unknown): void {
    let node = this.root;
    let i = 0;
    for (;;) {
      if (i === key.length) {
        node.value = value;
        node.hasValue = true;
        return;
      }
      const first = key[i] as string;
      const child = node.children.get(first);
      if (child === undefined) {
        const leaf = new RadixNode();
        leaf.label = key.slice(i);
        leaf.value = value;
        leaf.hasValue = true;
        node.children.set(first, leaf);
        return;
      }
      const common = commonPrefix(key, i, child.label);
      if (common === child.label.length) {
        node = child;
        i += common;
        continue;
      }
      // Split the child at `common`: an intermediate node takes the shared prefix.
      const inter = new RadixNode();
      inter.label = child.label.slice(0, common);
      child.label = child.label.slice(common);
      node.children.set(first, inter);
      inter.children.set(child.label[0] as string, child);
      if (common === key.length - i) {
        inter.value = value;
        inter.hasValue = true;
      } else {
        const leaf = new RadixNode();
        leaf.label = key.slice(i + common);
        leaf.value = value;
        leaf.hasValue = true;
        inter.children.set(leaf.label[0] as string, leaf);
      }
      return;
    }
  }

  /**
   * The deepest node whose path the key reaches, with that node's FULL path. A key
   * that ends inside an edge returns that edge's node (the prefix scan base); `get`
   * distinguishes an exact hit by `path === key`.
   */
  private findNode(key: string): { node: RadixNode; path: string } | undefined {
    let node = this.root;
    let path = '';
    let i = 0;
    while (i < key.length) {
      const child = node.children.get(key[i] as string);
      if (child === undefined) return undefined;
      if (child.label.startsWith(key.slice(i))) {
        return { node: child, path: path + child.label };
      }
      if (!key.startsWith(child.label, i)) return undefined;
      i += child.label.length;
      path += child.label;
      node = child;
    }
    return { node, path };
  }

  get(key: string): unknown {
    const res = this.findNode(key);
    if (res === undefined) return undefined;
    return res.path === key && res.node.hasValue ? res.node.value : undefined;
  }

  has(key: string): boolean {
    const res = this.findNode(key);
    if (res === undefined) return false;
    return res.path === key && res.node.hasValue;
  }

  /** All `[key, value]` whose key starts with `prefix`, in key order. */
  prefix(prefix: string): Array<[string, unknown]> {
    const res = this.findNode(prefix);
    if (res === undefined) return [];
    const out: Array<[string, unknown]> = [];
    const walk = (n: RadixNode, path: string): void => {
      if (n.hasValue) out.push([path, n.value]);
      for (const key of [...n.children.keys()].sort()) {
        const child = n.children.get(key);
        if (child !== undefined) walk(child, path + child.label);
      }
    };
    walk(res.node, res.path);
    return out;
  }
}
