/**
 * A Z-set (DBSP) — a finitely-supported map from a key to an integer weight.
 * Insert = `+1`, delete = `-1`. Weights make duplicate / unkeyed rows
 * distinguishable, which is what lets a delete over an unkeyed row be expressed at
 * all. This is the delta algebra the incremental view is built on (§12.3 / §13).
 */
export type ZSet = Map<string, number>;

/** Add `weight` (default `+1`) to `key`, dropping the entry when it returns to zero. */
export function zsetAdd(z: ZSet, key: string, weight = 1): void {
  const next = (z.get(key) ?? 0) + weight;
  if (next === 0) z.delete(key);
  else z.set(key, next);
}

/** The additive inverse — every weight negated (a retraction of the whole set). */
export function zsetNegate(z: ZSet): ZSet {
  const out: ZSet = new Map();
  for (const [key, weight] of z) out.set(key, -weight);
  return out;
}

/** The group sum of two Z-sets. */
export function zsetUnion(a: ZSet, b: ZSet): ZSet {
  const out = new Map(a);
  for (const [key, weight] of b) zsetAdd(out, key, weight);
  return out;
}

/** The total weight (cardinality with multiplicity). */
export function zsetTotal(z: ZSet): number {
  let total = 0;
  for (const weight of z.values()) total += weight;
  return total;
}
