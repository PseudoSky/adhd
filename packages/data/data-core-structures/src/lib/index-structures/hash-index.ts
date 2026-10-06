/**
 * Equality index (§11 row 1): a value → row-id map. O(1) expected lookup/insert,
 * O(#ids) delete. The `keyOf` canonicalisation makes un-keyable JS values (objects)
 * usable as keys via their JSON form.
 */
export function keyOf(value: unknown): string {
  const t = typeof value;
  if (t === 'string') return `s:${value as string}`;
  if (t === 'number') return `n:${String(value)}`;
  if (t === 'boolean') return `b:${String(value)}`;
  if (value === null) return 'z';
  if (value === undefined) return 'u';
  return `j:${JSON.stringify(value)}`;
}

export class HashIndex {
  private readonly map = new Map<string, number[]>();

  add(key: unknown, id: number): void {
    const k = keyOf(key);
    const ids = this.map.get(k);
    if (ids === undefined) this.map.set(k, [id]);
    else ids.push(id);
  }

  get(key: unknown): number[] {
    return [...(this.map.get(keyOf(key)) ?? [])];
  }

  has(key: unknown): boolean {
    return this.map.has(keyOf(key));
  }

  remove(key: unknown, id: number): void {
    const k = keyOf(key);
    const ids = this.map.get(k);
    if (ids === undefined) return;
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
    if (ids.length === 0) this.map.delete(k);
  }
}
