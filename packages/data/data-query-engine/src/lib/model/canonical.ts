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

/** A canonical JSON string: object keys sorted; commutative arrays normalized. */
function canon(value: unknown, key?: string): string {
  if (Array.isArray(value)) {
    const arr: readonly unknown[] = value;
    let items = arr.map((v) => canon(v));
    if (key !== undefined && SORT_DEDUP.has(key)) items = [...new Set(items)].sort();
    else if (key !== undefined && SORT_KEEP.has(key)) items = [...items].sort();
    return `[${items.join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k], k)}`).join(',')}}`;
  }
  const out = JSON.stringify(value);
  return out === undefined ? 'null' : out;
}

/** The structural canonical string of a predicate. */
export function canonicalizePredicate(pred: Predicate): string {
  return canon(pred);
}

/**
 * The full plan key — includes `name` and `source`. Stable across object-key order
 * and `_and`/`_or`/`_in`/`_nin`/`group_by` operand order.
 */
export function planKey(query: QueryExpression): string {
  return canon(query);
}

/**
 * The CSE/compute key — `planKey` with `name` removed. `execute` never reads a
 * node's `name` (only its parent labels the output), so two items that are identical
 * but for `name` compute identically and may share one evaluation.
 */
export function computeKey(query: QueryExpression): string {
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'name') continue;
    clone[k] = v;
  }
  return canon(clone);
}
