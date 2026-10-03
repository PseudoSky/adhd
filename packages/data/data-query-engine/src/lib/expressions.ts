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

export type Operator =
  | NumberOperator
  | StringOperator
  | JsonOperator
  | PeriodOperator;

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
 * The grouping-set family. A plain array is a single grouping set; `_rollup`
 * emits the prefix hierarchy `{a,b}, {a}, {}`; `_cube` emits every subset.
 * See SPEC AC-9.
 */
export type GroupByExpression =
  | GroupKey[]
  | { _rollup: GroupKey[] }
  | { _cube: GroupKey[] };

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

export interface QueryExpression {
  distinct_on?: string[];
  limit?: number;
  offset?: number;
  order_by?: OrderByExpression[];
  where?: BooleanExpression;
  // Grouping / aggregation surface (SPEC: engine group-by + aggregation + HAVING).
  group_by?: GroupByExpression;
  aggregate?: AggregateExpression;
  having?: HavingExpression;
  window?: WindowSpec;
  output?: QueryOutput;
  top_n?: TopNExpression;
}

export type QueryExpressionValues =
  | QueryExpression
  | OrderByExpression[]
  | BooleanExpression;
