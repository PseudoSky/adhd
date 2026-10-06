/**
 * Posting index (§11 row 2): a dimension value → the SET of row ids that carry it.
 * O(1) amortised insert, O(1) lookup returning the id set, O(#ids) delete. The
 * set form is what an `_in`/membership predicate intersects.
 */
import { keyOf } from './hash-index';

export class PostingIndex {
  private readonly map = new Map<string, Set<number>>();

  add(value: unknown, id: number): void {
    const k = keyOf(value);
    const ids = this.map.get(k);
    if (ids === undefined) this.map.set(k, new Set([id]));
    else ids.add(id);
  }

  get(value: unknown): Set<number> {
    return new Set(this.map.get(keyOf(value)) ?? []);
  }

  remove(value: unknown, id: number): void {
    const k = keyOf(value);
    const ids = this.map.get(k);
    if (ids === undefined) return;
    ids.delete(id);
    if (ids.size === 0) this.map.delete(k);
  }

  /** The ids present for value — an intersection with another posting set. */
  intersect(a: unknown, b: unknown): Set<number> {
    const left = this.map.get(keyOf(a));
    const right = this.map.get(keyOf(b));
    const out = new Set<number>();
    if (left === undefined || right === undefined) return out;
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    for (const id of small) if (large.has(id)) out.add(id);
    return out;
  }
}
