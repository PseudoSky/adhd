/**
 * The v2 query model — the self-similar, position-typed grammar.
 *
 * This module is ADDITIVE: it does not alter the shipped `QueryExpression`. It is
 * exported under the `queryModel` namespace so it can be promoted to the package
 * surface only once its ADR lands (see `tmp/data-query-engine/model.md`).
 *
 * The one structural idea: a query is SELF-SIMILAR — `group_by` and `select` hold
 * queries; a leaf is a query with an `aggregate`. Window is an attribute of the
 * aggregate (`_window`), not a query-level key. `where` carries BOTH the WHERE and
 * the HAVING predicate in one tree, split into pre/post-group by a phase rule
 * (see `./phase`). `qualify` is the post-window filter.
 */
import type { OrderByExpression } from '../expressions';

// Re-export the operator/order vocabulary and the boolean type this model extends.
export type { BooleanExpression, Operator, OrderByExpression } from '../expressions';

/** A raw row: the model is schema-agnostic and works over nested JSON records. */
export type Row = Record<string, unknown>;

// ── Window (an aggregate's input scope) ─────────────────────────────────────
/**
 * An inclusive `[from, to]` frame, modeling SQL `{RANGE|ROWS|GROUPS} BETWEEN
 * <start> AND <end>`:
 *  - a number bound = a ROWS/GROUPS offset (negative = preceding, 0 = current);
 *  - an ISO-8601 duration string = a RANGE value offset (`"P7D"` = 7 days before);
 *  - `'unbounded'` = UNBOUNDED PRECEDING/FOLLOWING.
 */
export type WindowBound = number | string | 'unbounded';
export type WindowFrame = [WindowBound, WindowBound];
/** Explicit frame unit when the bound type is ambiguous (a number could be ROWS or GROUPS). */
export type WindowFrameMode = 'rows' | 'groups' | 'range';

export interface WindowSpec {
  /** Order key FALLBACK for a window over raw rows; else the group_by entry's `order_by`. */
  field?: string;
  frame_mode?: WindowFrameMode;
  period?: string | [string, number];
  frame?: WindowFrame;
  /** Defaults to the query's `group_by`. */
  partition_by?: string | string[];
}

export interface FoldMods {
  _window?: WindowSpec;
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
 * shipped per-type `GenericOperator`, so a boolean/string/Date operand types
 * without a cast (the engine is schema-agnostic; the operator NAMES are validated
 * at execution).
 */
export type ScalarOperator = Record<string, unknown>;

/**
 * The model's predicate — the shipped `BooleanExpression` WIDENED so that
 * `_in`/`_nin` may carry a subquery operand (`{ name, where, select }`) in
 * addition to an array. A field key maps to a `ScalarOperator`; the reserved keys
 * `_and`/`_or`/`_not` carry the boolean structure.
 */
export interface Predicate {
  _and?: Predicate[];
  _or?: Predicate[];
  _not?: Predicate;
  [fieldOrKey: string]: PredicateValue;
}

export type PredicateValue =
  | ScalarOperator
  | Predicate
  | Predicate[]
  | QueryExpression
  | unknown[]
  | undefined;

// ── The self-similar query, with position-typed slots ───────────────────────
// Position typing: a `group_by` KEY is a scalar, NON-AGGREGATE expression; a
// `group_by` AGGREGATE item is `{ name, aggregate }`; a `select` item is a scalar
// ref/computation OR a relation-valued nested query; a subquery in a scalar
// position (e.g. `_in`) selects exactly one item.
export interface QueryExpression {
  /** INPUT binding — the named dataset this node reads (top query only). */
  source?: string;
  /** OUTPUT identity (`as`) — the key a nested result nests under. */
  name?: string;
  /** LEAF value (fold / arithmetic / field ref). */
  aggregate?: Expr;
  /** ONE tree: PRE + POST-group filter — split by the phase rule (`./phase`). */
  where?: Predicate;
  /** POST-WINDOW filter — window-fold outputs only (SQL QUALIFY). */
  qualify?: Predicate;
  group_by?: GroupItem[];
  /**
   * Keep the top `n` groups (ranked by `order_by`) and fold the rest into one
   * `_other` row whose accumulators are the merge of the dropped groups'
   * (the shipped `top_n`/`_other` semantics, §2.5). `other` MUST be `true` — a
   * bare `keep` with no `_other` is rejected (there would be nothing to keep it for).
   */
  keep?: { n: number; other: true };
  select?: SelectItem[];
  order_by?: OrderByExpression[];
  distinct_on?: string[];
  offset?: number;
  limit?: number;
}

/**
 * A time-bucket group key: the row's `field` epoch is floored to a bucket. `seconds`
 * (+ `offset`) is the shipped form; `unit` (`second|minute|hour|day|week`) and
 * `tz` (IANA) are the **listed change** of §15.5, implemented here.
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
