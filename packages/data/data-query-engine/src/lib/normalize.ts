/**
 * `normalizeQuery` — translate the deprecated v1 clause family into the
 * canonical (v2) IR at the `DataView` boundary.
 *
 * The package now has ONE canonical grammar (`./expressions`' `QueryExpression`,
 * which is the v2 self-similar grammar with the v1 clauses retained as
 * `@deprecated` aliases). A query that uses ONLY v1 spellings is executed by the
 * shipped v1 pipeline unchanged (so `aggregate.spec.ts`'s semantics — e.g. a
 * null-excluding `_avg`, `output:'rows'`, grouping sets — are preserved exactly).
 * A query that uses ANY canonical construct is normalized here and executed by
 * the v2 reference executor.
 *
 * This module is PURE: it reshapes a query and never executes it. The table:
 *
 *   v1 (deprecated)                -> v2 (canonical)
 *   ------------------------------    -----------------------------------------
 *   root `aggregate` map            -> `group_by` items `{ name, aggregate }`
 *   `window` (query-level)          -> `_window` on each fold
 *   `having`                        -> conjuncts appended to `where` (post-group)
 *   `top_n { n, by, other }`        -> `order_by:[{by:'desc'}]` + `keep`/`limit`
 *   `keep`/`qualify`/`source`/`name`/nested `select`  -> pass through
 *   `_rollup`/`_cube`/`_nest`/`output:'rows'`  -> NO canonical form: a canonical
 *                                       query carrying one is a THROW (the shape
 *                                       is supported only by the v1 backend,
 *                                       which the DataView routes to directly).
 */

import type {
  AggregateExpression,
  AggregateFunction,
  GroupByExpression,
  GroupKey,
  QueryExpression,
  WindowSpec,
} from './expressions';
import type {
  BucketKey,
  Expr,
  GroupItem,
  OrderByExpression,
  Predicate,
  QueryExpression as CanonicalQueryExpression,
  SelectItem,
  WindowSpec as CanonicalWindowSpec,
} from './model/types';
import { QueryValidationError } from './errors';

/** The normalized result: the canonical IR, plus the plan's `legacyGrouping` tag. */
export type NormalizedQuery = CanonicalQueryExpression & { legacyGrouping?: true };

const FOLD_KEYS: readonly string[] = [
  '_sum',
  '_count',
  '_min',
  '_max',
  '_avg',
  '_distinct_count',
  '_quantile',
  '_ratio_of_sums',
];
const ARITH_KEYS: readonly string[] = ['_add', '_sub', '_mul', '_div', '_coalesce', '_round'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isOperatorKey = (k: string): boolean => FOLD_KEYS.includes(k) || ARITH_KEYS.includes(k);

/** A v1 aggregate-map: an object whose TOP-LEVEL keys are output FIELD names. */
export function isV1AggregateMap(value: unknown): value is AggregateExpression {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && !keys.some(isOperatorKey);
}

/** A v2 root leaf: an object with a fold/arithmetic operator key at the top. */
export function isV2AggregateLeaf(value: unknown): value is Expr {
  return isObject(value) && Object.keys(value).some(isOperatorKey);
}

/** A v2 `group_by`: an array containing a non-bucket object item (`{name,aggregate}`). */
export function isV2GroupBy(groupBy: unknown): boolean {
  return (
    Array.isArray(groupBy) && groupBy.some((item) => isObject(item) && !('_bucket' in item))
  );
}

/** A v2 `select`: an array containing a non-string item (nested query / window fold). */
export function isV2Select(select: unknown): boolean {
  return Array.isArray(select) && select.some((item) => typeof item !== 'string');
}

function isScalarOperator(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('_') && k !== '_and' && k !== '_or' && k !== '_not');
}

function isSubqueryOperand(value: unknown): boolean {
  return isObject(value) && !isScalarOperator(value);
}

/** Does a predicate tree carry a `_in`/`_nin` operand that is itself a subquery? */
export function hasSubqueryWhere(where: unknown): boolean {
  if (!isObject(where)) return false;
  for (const [key, value] of Object.entries(where)) {
    if (key === '_and' || key === '_or') {
      if (Array.isArray(value) && value.some(hasSubqueryWhere)) return true;
      continue;
    }
    if (key === '_not') {
      if (hasSubqueryWhere(value)) return true;
      continue;
    }
    if (isObject(value)) {
      const inOp = (value as Record<string, unknown>)['_in'];
      const ninOp = (value as Record<string, unknown>)['_nin'];
      if (isSubqueryOperand(inOp) || isSubqueryOperand(ninOp)) return true;
    }
  }
  return false;
}

/**
 * Does this query use ANY canonical construct? A query with none is executed by
 * the shipped v1 pipeline verbatim (which is what keeps every v1 spec green);
 * a query with any is normalized and executed by the v2 reference executor.
 */
export function hasCanonicalMarker(query: QueryExpression): boolean {
  if (
    query.source !== undefined ||
    query.name !== undefined ||
    query.qualify !== undefined ||
    query.keep !== undefined
  ) {
    return true;
  }
  if (isV2GroupBy(query.group_by)) return true;
  if (isV2AggregateLeaf(query.aggregate)) return true;
  if (isV2Select(query.select)) return true;
  if (hasSubqueryWhere(query.where)) return true;
  return false;
}

/** The v1-pipeline predicate: a query with no canonical construct is legacy. */
export const isLegacyQuery = (query: QueryExpression): boolean => !hasCanonicalMarker(query);

/** `_rollup`/`_cube`/`_nest` — a grouping-set family with no canonical form. */
function isGroupingSetFamily(groupBy: GroupByExpression | GroupItem[] | undefined): boolean {
  if (!isObject(groupBy)) return false;
  return '_rollup' in groupBy || '_cube' in groupBy || '_nest' in groupBy;
}

/** The v1 `window` -> a v2 fold `_window`. */
function windowAsFoldWindow(window: WindowSpec): CanonicalWindowSpec {
  return { field: window.field, period: window.period };
}

function withWindow(aggregate: AggregateFunction | Expr, window: WindowSpec | undefined): Expr {
  if (window === undefined) return aggregate as Expr;
  return { ...(aggregate as Record<string, unknown>), _window: windowAsFoldWindow(window) } as Expr;
}

function normalizeGroupKey(key: GroupKey): string | BucketKey {
  if (typeof key === 'string') return key;
  return { _bucket: key._bucket };
}

function normalizeGroupItem(item: GroupItem | GroupKey, window: WindowSpec | undefined): GroupItem {
  if (typeof item === 'string') return item;
  if (isObject(item) && '_bucket' in item) return normalizeGroupKey(item as GroupKey);
  // A v2 group item `{ name, aggregate }` — attach a deprecated top-level window
  // to its fold, if one was supplied.
  const q = item as CanonicalQueryExpression;
  if (q.aggregate !== undefined && q.aggregate !== null && isObject(q.aggregate)) {
    return { ...q, aggregate: withWindow(q.aggregate as unknown as AggregateFunction, window) };
  }
  return q;
}

/**
 * Normalize a canonical query: translate every deprecated v1 alias into the v2
 * IR. Pure — never executes — and throws `QueryValidationError` on a query that
 * mixes a canonical construct with a v1 construct that has no canonical form.
 */
export function normalizeQuery(query: QueryExpression): NormalizedQuery {
  if (isGroupingSetFamily(query.group_by)) {
    throw new QueryValidationError(
      'grouping-set group_by (_rollup/_cube/_nest) has no canonical form; it is ' +
        'supported only by the shipped v1 grouping backend and cannot be combined ' +
        'with a canonical construct (source/name/qualify/keep/position-typed items)'
    );
  }
  if (query.output === 'rows') {
    throw new QueryValidationError(
      "output:'rows' has no canonical form (broadcast is a window fold in `select`); " +
        'it cannot be combined with a canonical construct'
    );
  }

  const out: NormalizedQuery = {};

  if (query.source !== undefined) out.source = query.source;
  if (query.name !== undefined) out.name = query.name;
  if (query.distinct_on !== undefined) out.distinct_on = query.distinct_on;
  if (query.offset !== undefined) out.offset = query.offset;
  if (query.limit !== undefined) out.limit = query.limit;
  if (query.qualify !== undefined) out.qualify = query.qualify;
  if (query.keep !== undefined) out.keep = query.keep;
  if (query.order_by !== undefined) out.order_by = [...query.order_by];

  // ── group_by: keys/items, then the root aggregate-map folded in as items ──
  const window = query.window;
  const groupItems: GroupItem[] = [];
  if (Array.isArray(query.group_by)) {
    for (const item of query.group_by) groupItems.push(normalizeGroupItem(item, window));
  }
  if (isV1AggregateMap(query.aggregate)) {
    for (const [name, fn] of Object.entries(query.aggregate)) {
      groupItems.push({ name, aggregate: withWindow(fn, window) });
    }
  } else if (isV2AggregateLeaf(query.aggregate)) {
    out.aggregate = query.aggregate;
  }
  if (groupItems.length > 0) out.group_by = groupItems;

  // ── where: the ONE tree, with `having` appended as post-group conjuncts ──
  const whereParts: Predicate[] = [];
  if (query.where !== undefined) whereParts.push(query.where as Predicate);
  if (query.having !== undefined) whereParts.push(query.having as unknown as Predicate);
  if (whereParts.length === 1) out.where = whereParts[0];
  else if (whereParts.length > 1) out.where = { _and: whereParts };

  // ── select: a v1 string projection or a v2 item list, passed through ──
  if (query.select !== undefined) out.select = query.select as SelectItem[];

  // ── top_n: top-N = order_by + keep/limit ──
  if (query.top_n !== undefined) {
    const topN = query.top_n;
    const rankBy = { [topN.by]: 'desc' } as OrderByExpression;
    out.order_by = [rankBy, ...(out.order_by ?? [])];
    if (topN.other === true) out.keep = { n: topN.n, other: true };
    else if (out.limit === undefined) out.limit = topN.n;
  }

  return out;
}
