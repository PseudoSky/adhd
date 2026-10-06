import type {
  Expr,
  GroupItem,
  Predicate,
  SelectItem,
} from './model/types';

/**
 * The v2 canonical grammar types now live on the ONE package surface. The
 * `QueryExpression` interface below is the single canonical query type: it is
 * the v2 self-similar grammar (canonical) widened with the v1 clause family
 * (`having`/`window`/`output`/`top_n`, the root aggregate-map, and an array
 * `group_by`) as `@deprecated` aliases translated by `normalizeQuery()`.
 *
 * The leaf/position types (`Expr`, `Fold`, `Predicate`, `GroupItem`,
 * `SelectItem`, `BucketKey`, `Row`) are re-exported so a consumer importing
 * from the package barrel gets the whole grammar, not just the v1 spellings.
 */
export type {
  BucketKey,
  Expr,
  Fold,
  GroupItem,
  Predicate,
  Row,
  SelectItem,
} from './model/types';

/**
 * Generic operators (all column types except json, jsonb)
 */
export interface GenericOperator<T> {
  _eq?: T;
  _gt?: T;
  _gte?: T;
  _in?: Array<T>;
  _is_null?: boolean;
  _lt?: T;
  _lte?: T;
  _ne?: T;
  _nin?: Array<T>;
}

/** expression to compare columns of type Int. All fields are combined with logical 'AND'. */
export type NumberOperator = GenericOperator<number>;

/** expression to compare columns of type String. All fields are combined with logical 'AND'. */
export interface StringOperator extends GenericOperator<string> {
  _ilike?: string;
  _like?: string;
  _nilike?: string;
  _nlike?: string;
  _nsimilar?: string;
  _similar?: string;
  _regex?: string;
  _iregex?: string;
  _nregex?: string;
  _niregex?: string;
}

/** expression to compare columns of type json. All fields are combined with logical 'AND'. */
export interface JsonOperator
  extends GenericOperator<number | string | object> {
  /* is the column contained in the given json value */
  _contained_in?: object;
  /* does the column contain the given json value at the top level */
  _contains?: object;
  /* does the string exist as a top-level key in the column */
  _has_key?: string;
  /* do any of these strings exist as top-level keys in the column */
  _has_keys_any?: string[];
  /* do all of these strings exist as top-level keys in the column */
  _has_keys_all?: string[];
}

/**
 * ISO-8601 duration period operator. Filters a timestamp column to the window
 * `[anchor - duration, anchor]`, where the anchor is `Date.now()` for a bare
 * duration string, or the tuple's second element for a `[duration, anchor]`
 * value. Calendar components (Y/M) resolve against the calendar — see
 * `resolveIsoPeriod` in `./period` — so `P1M` is a CALENDAR month, not 30 fixed
 * days.
 */
export interface PeriodOperator {
  _period?: string | [string, number];
}

/**
 * A date-time bound accepted by the range operators: an epoch-ms number, a
 * `Date`, or a parseable date-time string. Normalized by the shared
 * `toEpochMs` (same normalization `_period` uses).
 */
export type DateInput = string | number | Date;

/**
 * Absolute date-time range operators. `_in_datetimerange` / `_nin_datetimerange`
 * test a POINT against a list of inclusive `[from, to]` ranges — the `_in` /
 * `_nin` shape lifted to intervals. `_between` / `_nbetween` are COMPILE-TIME
 * SUGAR for a single-range `_in_datetimerange` / `_nin_datetimerange` and
 * desugar into the SAME predicate (there is never a second code path).
 * `_overlaps` is a genuinely different predicate: the row's own value is an
 * INTERVAL `[from, to]` and it is true when that interval intersects any query
 * range — a POINT test such as `_in_datetimerange` would miss it.
 *
 * Semantics (shared): both ends inclusive; a null/non-coercible row value is
 * `_in` false / `_nin` true; an empty list is false/true; a malformed bound
 * contributes nothing and does NOT throw; a reversed range matches nothing
 * (no auto-swap).
 */
export interface DatetimeRangeOperator {
  _in_datetimerange?: Array<[DateInput, DateInput]>;
  _nin_datetimerange?: Array<[DateInput, DateInput]>;
  _between?: [DateInput, DateInput];
  _nbetween?: [DateInput, DateInput];
  _overlaps?: Array<[DateInput, DateInput]>;
}

export type Operator =
  | NumberOperator
  | StringOperator
  | JsonOperator
  | PeriodOperator
  | DatetimeRangeOperator;

export interface BooleanExpression {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _and?: BooleanExpression[];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _or?: BooleanExpression[];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _not?: BooleanExpression;
  [key: string]: Operator | BooleanExpression | BooleanExpression[];
}

type OrderByValue =
  | 'asc' // in ascending order, nulls last
  | 'asc_nulls_first' // in ascending order, nulls first
  | 'asc_nulls_last' // in ascending order, nulls last
  | 'desc' // in descending order, nulls first
  | 'desc_nulls_first' // in descending order, nulls first
  | 'desc_nulls_last'; // in descending order, nulls last

export interface OrderByExpression {
  [key: string]: OrderByValue | OrderByExpression;
}

/**
 * A single grouping dimension. Either a field name (group by its value) or a
 * time bucket `{_bucket:{field,seconds,offset?}}` that maps a row to
 * `floor((t - offset) / (seconds*1000)) * (seconds*1000) + offset` (UTC epoch
 * arithmetic; `offset` defaults to 0). See SPEC AC-10.
 */
export type GroupKey =
  | string
  | {
      _bucket: {
        field: string;
        seconds: number;
        offset?: number;
      };
    };

/**
 * One level of a nested (`_nest`) grouping. Each node groups its slice of the
 * input by `key`, accumulates its OWN `aggregate` over every row beneath it,
 * filters itself with `having`, and prunes its own children with `top_n`
 * (per-parent, with a per-parent `_other`). `children` recurses. The top-level
 * `aggregate` / `having` / `top_n` are MUTUALLY EXCLUSIVE with these per-node
 * fields — a nested query expresses them per node.
 */
export interface NestedGroupNode {
  key: GroupKey;
  aggregate?: AggregateExpression;
  having?: HavingExpression;
  top_n?: TopNExpression;
  children?: NestedGroupNode[];
}

/**
 * The grouping-set family. A plain array is a single grouping set; `_rollup`
 * emits the prefix hierarchy `{a,b}, {a}, {}`; `_cube` emits every subset; and
 * `_nest` builds a hierarchical trie whose roots are emitted with their
 * children attached (`output:'groups'` on a nested query already means
 * roots-with-children — there is no separate `output:'tree'`). See SPEC AC-9.
 */
export type GroupByExpression =
  | GroupKey[]
  | { _rollup: GroupKey[] }
  | { _cube: GroupKey[] }
  | { _nest: NestedGroupNode[] };

/**
 * The closed algebraic aggregate vocabulary (SPEC section 4). One operator key
 * per aggregate. It is intentionally NOT an arbitrary JavaScript reducer: a
 * row-stream transform would make the query non-serialisable and break the
 * dashboard seam's expression round-trip.
 */
export type AggregateFunction =
  | { _sum: string }
  | { _count: true | string }
  | { _min: string }
  | { _max: string }
  | { _avg: string }
  | { _ratio_of_sums: { num: string; den: string } }
  | { _distinct_count: string }
  | { _quantile: { field: string; q: number } };

/** `outputField -> aggregate function`; each output field is computed per group. */
export interface AggregateExpression {
  [outputField: string]: AggregateFunction;
}

/**
 * A predicate over the GROUPED record — its field names are the aggregate
 * output fields (and, for reference, group keys). Structurally the same shape
 * as `BooleanExpression`, but its fields are resolved against the post-GROUP
 * record, which is what makes "an aggregate predicate inside `where`"
 * unrepresentable (SPEC section 2 / AC-15).
 */
export interface HavingExpression {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _and?: HavingExpression[];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _or?: HavingExpression[];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  _not?: HavingExpression;
  [outputField: string]:
    | NumberOperator
    | StringOperator
    | HavingExpression
    | HavingExpression[];
}

/**
 * A scoped window: it restricts the rows fed INTO the aggregate (Phase 3),
 * never the rows emitted. `period` is the SAME value form the `_period`
 * operator accepts and is resolved by the SAME `resolveIsoPeriod` (SPEC AC-7):
 * a bare duration string anchors at `Date.now()`, a `[duration, anchorMs]`
 * tuple pins the anchor; the window is CLOSED `[from, to]`.
 */
export interface WindowSpec {
  field: string;
  period: string | [string, number];
}

/** `groups` = one row per group (default); `rows` = broadcast back to input rows. */
export type QueryOutput = 'groups' | 'rows';

/**
 * Top-N groups, optionally collapsing the dropped tail into one `_other` row
 * whose accumulators are the merge of the dropped groups (SPEC AC-11). Applied
 * to the FINAL grouped result, per grouping set — never to raw events.
 */
export interface TopNExpression {
  n: number;
  by: string;
  other?: boolean;
}

/**
 * The ONE canonical query type — the v2 self-similar grammar (canonical) with
 * the v1 clause family retained as `@deprecated` aliases.
 *
 * v2 (canonical): a query is SELF-SIMILAR. A query is a leaf when it carries an
 * `aggregate` value; `group_by`/`select` hold queries; `where` carries BOTH the
 * pre- and post-group predicate in one tree, split by the phase rule; `qualify`
 * is the post-window filter; `keep` folds a top-N tail into one `_other` row.
 *
 * v1 (deprecated): the root `aggregate`-map, an array `group_by`, and the
 * `having`/`window`/`output`/`top_n` clauses are still accepted; `normalizeQuery`
 * translates them into the canonical IR at the `DataView` boundary.
 */
export interface QueryExpression {
  // ── canonical (v2) ────────────────────────────────────────────────────────
  /** INPUT binding — the named dataset this node reads (top query only). */
  source?: string;
  /** OUTPUT identity (`as`) — the key a nested result nests under. */
  name?: string;
  /** Root: a v1 aggregate-map | a v2 leaf expression (fold / arithmetic). */
  aggregate?: AggregateExpression | Expr;
  /** ONE tree: PRE + POST-group filter, split by the phase rule. */
  where?: BooleanExpression | Predicate;
  /** POST-WINDOW filter — window-fold outputs only (SQL QUALIFY). */
  qualify?: Predicate;
  /** Group keys (v1 array) | v2 position-typed items (`{ name, aggregate }`). */
  group_by?: GroupByExpression | GroupItem[];
  /** Keep the top `n` groups and fold the rest into one `_other` row (v2). */
  keep?: { n: number; other: true };
  /**
   * Pure FINAL projection. In the v2 grammar a `select` item is a scalar
   * ref/computation OR a relation-valued nested query; in the v1 grammar it is
   * a `string[]` projection applied last (after order_by -> distinct_on ->
   * offset -> limit), exactly as SQL's select list is applied last.
   */
  select?: string[] | SelectItem[];
  order_by?: OrderByExpression[];
  distinct_on?: string[];
  offset?: number;
  limit?: number;
  // ── deprecated (v1) — normalized at the DataView boundary ─────────────────
  /** @deprecated put a post-group leaf in `where` (phase rule). */
  having?: HavingExpression;
  /** @deprecated put `_window` on the fold. */
  window?: WindowSpec;
  /** @deprecated use a window fold in `select` (broadcast). */
  output?: QueryOutput;
  /** @deprecated use `order_by`+`limit`, or `keep`. */
  top_n?: TopNExpression;
}

export type QueryExpressionValues =
  | QueryExpression
  | OrderByExpression[]
  | BooleanExpression;
