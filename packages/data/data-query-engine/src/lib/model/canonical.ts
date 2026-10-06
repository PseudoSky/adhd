/**
 * Canonicalization — a stable, order-independent identity for a `QueryExpression`
 * and a `Predicate`, used for plan identity and the CSE/cache key.
 *
 * STRUCTURAL object keys are sorted everywhere. The COMMUTATIVE OPERAND arrays are
 * sorted too: `_and`/`_or` (idempotent, commutative), `_in`/`_nin` (set-valued), and
 * `group_by` (a set of grouping keys). Order-SENSITIVE slots are NOT reordered —
 * `order_by`, `distinct_on`, `select`, and the arithmetic operand arrays
 * (`_add`/`_sub`/`_mul`/`_div`/`_coalesce`/`_round`) keep their order, because
 * evaluation depends on it (notably float summation order).
 *
 * Two queries that differ only in the order of a commutative slot share a key; two
 * that differ anywhere meaningful do not.
 */
import type { Predicate, QueryExpression } from './types';

/** Arrays whose element order is irrelevant — sorted, duplicates dropped. */
const SORT_DEDUP: ReadonlySet<string> = new Set(['_and', '_or', '_in', '_nin']);
/** Arrays whose element order is irrelevant — sorted, duplicates KEPT (a repeated
 *  `group_by` key is a query-shape fact, not something to hide by dedupe). */
const SORT_KEEP: ReadonlySet<string> = new Set(['group_by']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An identity-keyed memo for a single canonicalization pass. A shared-reference
 * (DAG) query would otherwise re-canonicalize a reused subexpression once per
 * reference — ~2^depth — so the planner threads ONE memo through every key it
 * computes, making the whole pass O(nodes). Query objects are treated as
 * immutable for the duration of a pass (they are).
 */
export type CanonMemo = Map<unknown, string>;

/** A canonical JSON string: object keys sorted; commutative arrays normalized. */
function canon(value: unknown, key: string | undefined, memo: CanonMemo): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => canon(v, undefined, memo));
    if (key !== undefined && SORT_DEDUP.has(key)) return `[${[...new Set(items)].sort().join(',')}]`;
    if (key !== undefined && SORT_KEEP.has(key)) return `[${[...items].sort().join(',')}]`;
    return `[${items.join(',')}]`;
  }
  if (isRecord(value)) {
    const hit = memo.get(value);
    if (hit !== undefined) return hit;
    const keys = Object.keys(value).sort();
    const out = `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k], k, memo)}`).join(',')}}`;
    memo.set(value, out);
    return out;
  }
  const out = JSON.stringify(value);
  return out === undefined ? 'null' : out;
}

/** The structural canonical string of a predicate. */
export function canonicalizePredicate(pred: Predicate, memo: CanonMemo = new Map()): string {
  return canon(pred, undefined, memo);
}

/**
 * The full plan key — includes `name` and `source`. Stable across object-key order
 * and `_and`/`_or`/`_in`/`_nin`/`group_by` operand order.
 */
export function planKey(query: QueryExpression, memo: CanonMemo = new Map()): string {
  return canon(query, undefined, memo);
}

/**
 * The CSE/compute key — `planKey` with `name` removed. `execute` never reads a
 * node's `name` (only its parent labels the output), so two items that are identical
 * but for `name` compute identically and may share one evaluation.
 */
export function computeKey(query: QueryExpression, memo: CanonMemo = new Map()): string {
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'name') continue;
    clone[k] = v;
  }
  return canon(clone, undefined, memo);
}
