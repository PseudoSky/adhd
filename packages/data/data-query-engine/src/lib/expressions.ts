/**
 * The ONE query grammar — the v2 self-similar, position-typed model. There is no
 * v1 clause family: `having` is a post-group leaf in the merged `where` (phase
 * rule), a time-scoped aggregate is `_filter` on the fold, a running/sliding
 * aggregate is `_scan` on a fold (a fold-mode broadcast in `select` + `qualify`),
 * and top-N is `order_by` + `limit` / `keep:{n,other:true}`.
 *
 * The `Operator`/`BooleanExpression` vocabulary (the shared predicate language)
 * is retained, and is a subset of what the schema-agnostic `Predicate` accepts.
 */

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

// ── the v2 grammar (canonical) ──────────────────────────────────────────────

/** A raw row: the model is schema-agnostic and works over nested JSON records. */
export type Row = Record<string, unknown>;

// ── Scan (an aggregate as a per-row fold-mode over an ordered frame) ─────────
/**
 * The frame of a `_scan`:
 *  - `'running'` (the default) — the partition rows from the first through the
 *    current row;
 *  - a `number` `n` — a sliding frame of the last `n` rows through the current row;
 *  - `{ where }` — the frame is the set of partition rows satisfying the predicate
 *    (position-independent; `{ where: {} }` is the whole partition).
 */
export type ScanFrame = 'running' | number | { where: Predicate };

/**
 * A scan modifier on a fold: the SAME closed fold vocabulary in
 * "retain-intermediates" mode over an ordered frame, producing one value per row
 * of the relation it is attached to (a broadcast). It is a fold-mode, NOT a phase
 * and NOT a detached clause. The partition defaults to the enclosing `group_by`.
 */
export interface ScanSpec {
  /** The order key within each partition. */
  order_by: string;
  /** Defaults to `'running'`. */
  frame?: ScanFrame;
  /** Partition key(s); defaults to the enclosing `group_by`. */
  partition_by?: string | string[];
}

export interface FoldMods {
  _scan?: ScanSpec;
  _filter?: Predicate;
}

export type QuantileSketch = 'exact' | 'ddsketch';

export type Fold = FoldMods &
  (
    | { _sum: Expr }
    | { _count: true | Expr }
    | { _min: Expr }
    | { _max: Expr }
    | { _avg: Expr }
    | { _distinct_count: Expr }
    | {
        _quantile: {
          field: Expr;
          q: number;
          sketch?: QuantileSketch;
          relativeAccuracy?: number;
        };
      }
    | { _ratio_of_sums: { num: Expr; den: Expr } }
  );

export type Arith =
  | { _add: Expr[] }
  | { _sub: [Expr, Expr] }
  | { _mul: Expr[] }
  | { _div: [Expr, Expr] }
  | { _coalesce: Expr[] }
  | { _round: [Expr, number] };

export type Expr = string | number | boolean | null | Fold | Arith;

/**
 * A scalar comparison object — its keys are operators (`_eq`, `_gt`, …) and its
 * values are operands. Deliberately `Record<string, unknown>` rather than the
 * per-type `GenericOperator`, so a boolean/string/Date operand types without a
 * cast (the engine is schema-agnostic; the operator NAMES are validated at
 * execution).
 */
export type ScalarOperator = Record<string, unknown>;

/**
 * The model's predicate — `BooleanExpression` WIDENED so that `_in`/`_nin` may
 * carry a subquery operand (`{ name, where, select }`) in addition to an array.
 * A field key maps to a `ScalarOperator`; the reserved keys `_and`/`_or`/`_not`
 * carry the boolean structure.
 */
export interface Predicate {
  _and?: Predicate[];
  _or?: Predicate[];
  _not?: Predicate;
  [fieldOrKey: string]: PredicateValue;
}

export type PredicateValue =
  | ScalarOperator
  | Operator
  | BooleanExpression
  | BooleanExpression[]
  | Predicate
  | Predicate[]
  | QueryExpression
  | unknown[]
  | undefined;

/**
 * A time-bucket group key: the row's `field` epoch is floored to a bucket. `seconds`
 * (+ `offset`) is the shipped form; `unit` (`second|minute|hour|day|week`) and
 * `tz` (IANA) are also accepted.
 */
export interface BucketKey {
  _bucket: {
    field: string;
    seconds?: number;
    unit?: string;
    tz?: string;
    offset?: number;
  };
}

/** `string` = a field group key; a bucket = a time bucket; a query = `{ name, aggregate }`. */
export type GroupItem = string | BucketKey | QueryExpression;
/** `string` = a field ref; a query = a scalar computation OR a relation-valued nested query. */
export type SelectItem = string | QueryExpression;

/**
 * The ONE query type — the self-similar, position-typed v2 grammar.
 *
 * Position typing: a `group_by` KEY is a scalar, NON-AGGREGATE expression; a
 * `group_by` AGGREGATE item is `{ name, aggregate }`; a `select` item is a scalar
 * ref/computation OR a relation-valued nested query; a subquery in a scalar
 * position (e.g. `_in`) selects exactly one item.
 */
export interface QueryExpression {
  /** INPUT binding — the named dataset this node reads (top query only). */
  source?: string;
  /** OUTPUT identity (`as`) — the key a nested result nests under. */
  name?: string;
  /** LEAF value (fold / arithmetic / field ref). */
  aggregate?: Expr;
  /** ONE tree: PRE + POST-group filter — split by the phase rule (`./model/phase`). */
  where?: Predicate;
  /** POST-WINDOW filter — window-fold outputs only (SQL QUALIFY). */
  qualify?: Predicate;
  group_by?: GroupItem[];
  /**
   * Keep the top `n` groups (ranked by `order_by`) and fold the rest into one
   * `_other` row whose accumulators are the merge of the dropped groups'
   * (the shipped `top_n`/`_other` semantics). `other` MUST be `true`.
   */
  keep?: { n: number; other: true };
  select?: SelectItem[];
  order_by?: OrderByExpression[];
  distinct_on?: string[];
  offset?: number;
  limit?: number;
}
