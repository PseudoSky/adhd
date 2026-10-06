/**
 * The reference executor for the v2 query model — over an array of rows.
 *
 * Fixed phase order (the wrong order is unrepresentable):
 *   where(pre) -> group_by -> aggregate -> where(post) -> window -> qualify ->
 *   order_by -> distinct_on -> offset -> limit -> select (final projection).
 */
import { Transform as _ } from '@adhd/data-base-transforms';
import { compileAccessor, type PathGetter } from '../path';
import { resolveIsoPeriod } from '../period';
import type { OrderByExpression } from '../expressions';
import { postNames, splitWhere, validateQuery } from './phase';
import { computeKey } from './canonical';
import { QueryModelError } from './errors';
import type { PlannerIndex } from './indexing';
import type { PhysicalPlan } from './plan';
import type {
  Arith,
  BucketKey,
  Expr,
  Fold,
  Predicate,
  QueryExpression,
  Row,
  ScalarOperator,
  SelectItem,
  WindowBound,
  WindowFrame,
  WindowSpec,
} from './types';

// ── evaluation context ──────────────────────────────────────────────────────
export interface EvalCtx {
  /** The rows of the top query's `source` (or of the only dataset). */
  sourceRows: Row[];
  /** The DataView's named datasets, for a subquery that names its own `source`. */
  sources: ReadonlyMap<string, Row[]>;
  /** Memoized subquery value-sets, so an `_in` subquery evaluates once, not per row. */
  memo: Map<string, Set<unknown>>;
  /** Planner index lookup, installed by `executePlanned`. */
  indexFor?: (source: string) => PlannerIndex | undefined;
  /** The resolved top source name (for an un-named `_in` subquery). */
  planSource?: string;
  /** The plan tree, installed by `executePlanned` — consulted for CSE + child access. */
  plan?: PhysicalPlan;
}

const emptyCtx = (rows: Row[]): EvalCtx => ({ sourceRows: rows, sources: new Map(), memo: new Map() });

// ── field access (compiled once, reused) ────────────────────────────────────
const accessors = new Map<string, PathGetter>();
function get(path: string): PathGetter {
  let accessor = accessors.get(path);
  if (accessor === undefined) {
    accessor = compileAccessor(path);
    accessors.set(path, accessor);
  }
  return accessor;
}

// ── time helpers ────────────────────────────────────────────────────────────
function toMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function periodMatch(value: unknown, bound: unknown): boolean {
  let duration: string;
  let anchor: number;
  if (typeof bound === 'string') {
    duration = bound;
    anchor = Date.now();
  } else if (Array.isArray(bound) && bound.length === 2 && typeof bound[0] === 'string' && typeof bound[1] === 'number') {
    duration = bound[0];
    anchor = bound[1];
  } else {
    return false;
  }
  const t = toMs(value);
  if (t === null) return false;
  try {
    const { from, to } = resolveIsoPeriod(duration, anchor);
    return t >= from && t <= to;
  } catch {
    return false;
  }
}

function between(value: unknown, bound: unknown): boolean {
  if (!Array.isArray(bound) || bound.length < 2) return false;
  const t = toMs(value);
  const from = toMs(bound[0]);
  const to = toMs(bound[1]);
  return t !== null && from !== null && to !== null && t >= from && t <= to;
}

// ── subquery operands ───────────────────────────────────────────────────────
function isScalarOp(value: unknown): value is ScalarOperator {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('_') && k !== '_and' && k !== '_or' && k !== '_not');
}

function isSubquery(value: unknown): value is QueryExpression {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('_and' in value) && !isScalarOp(value);
}

/** `_in`/`_nin`: an array operand OR a subquery operand (memoized once per execute). */
function inOperand(value: unknown, bound: unknown, ctx: EvalCtx): boolean {
  if (Array.isArray(bound)) return _.isIn(value, bound);
  if (typeof bound === 'string') return _.isIn(value, bound);
  if (isSubquery(bound)) {
    const key = computeKey(bound);
    let set = ctx.memo.get(key);
    if (set === undefined) {
      let childRows = bound.source === undefined ? ctx.sourceRows : ctx.sources.get(bound.source) ?? [];
      // Index-narrow a subquery operand the planner indexed (PRE predicate only; the
      // exact predicate is still re-checked by `execute` below).
      const planned = ctx.plan?.nodes.get(key);
      const store = ctx.indexFor?.(bound.source ?? ctx.planSource ?? '');
      if (planned?.access.kind === 'index' && store !== undefined) {
        childRows = store.rowsFor(planned.access.ids);
      }
      const select = bound.select;
      if (select?.length !== 1) {
        throw new QueryModelError('a subquery used as a scalar operand must select exactly one item');
      }
      const result = execute(bound, childRows, ctx);
      const column = typeof select[0] === 'string' ? select[0] : select[0].name;
      if (column === undefined) {
        throw new QueryModelError('a scalar-operand subquery must select a named column');
      }
      set = new Set(result.map((r) => r[column]));
      ctx.memo.set(key, set);
    }
    return set.has(value);
  }
  return false;
}

type Op = (a: unknown, b: unknown, ctx: EvalCtx) => boolean;
const OPS: Record<string, Op> = {
  _eq: (a, b) => _.isEqual(a, b),
  _ne: (a, b) => _.isNotEqual(a, b),
  // A nullish operand must NOT pass a range comparison — gate on isDefined, then
  // use the total order (compareOrder). (Shipped `_.isGreaterThan` has the same
  // null→false rule; `compareOrder` alone would sort null last and wrongly pass.)
  _gt: (a, b) => _.isDefined(a) && _.isDefined(b) && _.compareOrder(a, b) > 0,
  _gte: (a, b) => _.isDefined(a) && _.isDefined(b) && _.compareOrder(a, b) >= 0,
  _lt: (a, b) => _.isDefined(a) && _.isDefined(b) && _.compareOrder(a, b) < 0,
  _lte: (a, b) => _.isDefined(a) && _.isDefined(b) && _.compareOrder(a, b) <= 0,
  _in: (a, b, ctx) => inOperand(a, b, ctx),
  _nin: (a, b, ctx) => !inOperand(a, b, ctx),
  _is_null: (a, b) => _.isDefined(a) !== b,
  _period: (a, b) => periodMatch(a, b),
  _between: (a, b) => between(a, b),
};

function matchLeaf(field: string, operator: ScalarOperator, row: Row, ctx: EvalCtx): boolean {
  const value = get(field)(row);
  for (const [op, operand] of Object.entries(operator)) {
    if (operand === undefined) continue;
    const fn = OPS[op];
    if (fn === undefined) throw new QueryModelError(`unknown operator '${op}' on '${field}'`);
    if (!fn(value, operand, ctx)) return false;
  }
  return true;
}

/** Evaluate a predicate tree against a row (rejecting an empty `_or`/`_and` or a malformed leaf). */
export function matches(node: Predicate, row: Row, ctx: EvalCtx): boolean {
  if (node._or?.length === 0) throw new QueryModelError('empty `_or` is malformed');
  if (node._and?.length === 0) throw new QueryModelError('empty `_and` is malformed');
  for (const c of node._and ?? []) if (!matches(c, row, ctx)) return false;
  if (node._or !== undefined && !node._or.some((c) => matches(c, row, ctx))) return false;
  if (node._not !== undefined && matches(node._not, row, ctx)) return false;
  for (const key of Object.keys(node)) {
    if (key === '_and' || key === '_or' || key === '_not') continue;
    const operator = node[key];
    if (!isScalarOp(operator)) {
      throw new QueryModelError(`malformed predicate: '${key}' is neither a reserved boolean key nor a scalar operator`);
    }
    if (!matchLeaf(key, operator, row, ctx)) return false;
  }
  return true;
}

// ── expression evaluation ───────────────────────────────────────────────────
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const isArith = (e: Expr): e is Arith =>
  typeof e === 'object' &&
  e !== null &&
  ('_add' in e || '_sub' in e || '_mul' in e || '_div' in e || '_coalesce' in e || '_round' in e);

function evalArith(node: Arith, evalExpr: (e: Expr) => unknown): unknown {
  if ('_add' in node) return node._add.reduce<number>((s, e) => s + num(evalExpr(e)), 0);
  if ('_sub' in node) return num(evalExpr(node._sub[0])) - num(evalExpr(node._sub[1]));
  if ('_mul' in node) return node._mul.reduce<number>((s, e) => s * num(evalExpr(e)), 1);
  if ('_div' in node) {
    const den = num(evalExpr(node._div[1]));
    return den === 0 ? null : num(evalExpr(node._div[0])) / den;
  }
  if ('_coalesce' in node) {
    for (const e of node._coalesce) {
      const v = evalExpr(e);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if ('_round' in node) {
    const factor = Math.pow(10, node._round[1]);
    return Math.round(num(evalExpr(node._round[0])) * factor) / factor;
  }
  return undefined;
}

/** Evaluate a row-level expression (field ref / literal / arithmetic). */
export function evalRow(expr: Expr, row: Row): unknown {
  if (typeof expr === 'string') return get(expr)(row);
  if (expr === null || typeof expr !== 'object') return expr;
  if (isArith(expr)) return evalArith(expr, (e) => evalRow(e, row));
  return undefined;
}

/** Evaluate a post-group expression (field refs resolve against the group record). */
function evalGroup(expr: Expr, record: Row): unknown {
  if (typeof expr === 'string') return record[expr];
  if (expr === null || typeof expr !== 'object') return expr;
  if (isArith(expr)) return evalArith(expr, (e) => evalGroup(e, record));
  return undefined;
}

/** The field names an expression references (its string leaves). */
function collectRefs(expr: Expr): string[] {
  if (typeof expr === 'string') return [expr];
  if (expr === null || typeof expr !== 'object') return [];
  if ('_add' in expr) return expr._add.flatMap(collectRefs);
  if ('_sub' in expr) return [expr._sub[0], expr._sub[1]].flatMap(collectRefs);
  if ('_mul' in expr) return expr._mul.flatMap(collectRefs);
  if ('_div' in expr) return [expr._div[0], expr._div[1]].flatMap(collectRefs);
  if ('_coalesce' in expr) return expr._coalesce.flatMap(collectRefs);
  if ('_round' in expr) return collectRefs(expr._round[0]);
  return [];
}

// ── quantile sketch (DDSketch, relative error) ──────────────────────────────
class DDSketch {
  private readonly gamma: number;
  private readonly logGamma: number;
  private readonly pos = new Map<number, number>();
  private readonly neg = new Map<number, number>();
  private zero = 0;
  private count = 0;

  constructor(relativeAccuracy: number) {
    const a = relativeAccuracy > 0 && relativeAccuracy < 1 ? relativeAccuracy : 0.01;
    this.gamma = (1 + a) / (1 - a);
    this.logGamma = Math.log(this.gamma);
  }

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    if (value === 0) {
      this.zero += 1;
      return;
    }
    const map = value > 0 ? this.pos : this.neg;
    const idx = Math.ceil(Math.log(Math.abs(value)) / this.logGamma);
    map.set(idx, (map.get(idx) ?? 0) + 1);
  }

  quantile(q: number): number | null {
    if (this.count === 0) return null;
    const target = Math.max(1, Math.ceil(q * this.count));
    let acc = 0;
    for (const idx of [...this.neg.keys()].sort((a, b) => b - a)) {
      acc += this.neg.get(idx) ?? 0;
      if (acc >= target) return -this.valueFor(idx);
    }
    acc += this.zero;
    if (acc >= target) return 0;
    for (const idx of [...this.pos.keys()].sort((a, b) => a - b)) {
      acc += this.pos.get(idx) ?? 0;
      if (acc >= target) return this.valueFor(idx);
    }
    return null;
  }

  private valueFor(idx: number): number {
    // The representative of bucket [gamma^(idx-1), gamma^idx): its geometric midpoint.
    return (2 * Math.pow(this.gamma, idx)) / (this.gamma + 1);
  }
}

// ── folds ───────────────────────────────────────────────────────────────────
const FOLD_KEYS = [
  '_sum',
  '_count',
  '_min',
  '_max',
  '_avg',
  '_distinct_count',
  '_quantile',
  '_ratio_of_sums',
] as const;

export const isFold = (e: Expr): e is Fold =>
  typeof e === 'object' && e !== null && FOLD_KEYS.some((k) => k in e);

/** Restrict a fold's input rows: its `_filter`, then its `_window.period` (Phase-3 scope). */
function scopeFold(fold: Fold, rows: Row[], ctx: EvalCtx): Row[] {
  let scoped = rows;
  const filter = fold._filter;
  if (filter !== undefined) scoped = scoped.filter((r) => matches(filter, r, ctx));
  const spec = fold._window;
  if (spec?.period === undefined) return scoped;
  if (spec.field === undefined) throw new QueryModelError('`_window.period` requires `field` (the order key)');
  if (spec.frame !== undefined) throw new QueryModelError('`_window.period` and `_window.frame` are mutually exclusive');
  const field = spec.field;
  const { from, to } =
    typeof spec.period === 'string' ? resolveIsoPeriod(spec.period, Date.now()) : resolveIsoPeriod(spec.period[0], spec.period[1]);
  return scoped.filter((r) => {
    const t = toMs(get(field)(r));
    return t !== null && t >= from && t <= to;
  });
}

function applyFold(fold: Fold, rows: Row[], ctx: EvalCtx): unknown {
  const scoped = scopeFold(fold, rows, ctx);
  if ('_count' in fold) {
    if (fold._count === true) return scoped.length;
    const operand = fold._count;
    return scoped.filter((r) => {
      const v = evalRow(operand, r);
      return v !== null && v !== undefined;
    }).length;
  }
  if ('_sum' in fold) return scoped.reduce<number>((s, r) => s + num(evalRow(fold._sum, r)), 0);
  if ('_avg' in fold) {
    if (scoped.length === 0) return null;
    return scoped.reduce<number>((s, r) => s + num(evalRow(fold._avg, r)), 0) / scoped.length;
  }
  if ('_min' in fold) {
    const vals = scoped.map((r) => evalRow(fold._min, r)).filter((v) => v !== null && v !== undefined);
    return vals.length === 0 ? null : vals.reduce((a, b) => (_.compareOrder(b, a) < 0 ? b : a));
  }
  if ('_max' in fold) {
    const vals = scoped.map((r) => evalRow(fold._max, r)).filter((v) => v !== null && v !== undefined);
    return vals.length === 0 ? null : vals.reduce((a, b) => (_.compareOrder(b, a) > 0 ? b : a));
  }
  if ('_distinct_count' in fold) {
    return new Set(scoped.map((r) => JSON.stringify(evalRow(fold._distinct_count, r)))).size;
  }
  if ('_ratio_of_sums' in fold) {
    const { num: n, den } = fold._ratio_of_sums;
    const d = scoped.reduce<number>((s, r) => s + num(evalRow(den, r)), 0);
    return d === 0 ? null : scoped.reduce<number>((s, r) => s + num(evalRow(n, r)), 0) / d;
  }
  if ('_quantile' in fold) {
    const { field, q, sketch, relativeAccuracy } = fold._quantile;
    if (sketch === 'ddsketch') {
      const ds = new DDSketch(relativeAccuracy ?? 0.01);
      for (const r of scoped) ds.add(num(evalRow(field, r)));
      return ds.quantile(q);
    }
    const vals = scoped.map((r) => num(evalRow(field, r))).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    const idx = (vals.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
  }
  return null;
}

// ── grouping (field keys + time-bucket keys + aggregate items) ──────────────
const isBucketKey = (item: unknown): item is BucketKey =>
  typeof item === 'object' && item !== null && '_bucket' in item;

function unitToMs(unit: string): number {
  switch (unit) {
    case 'second':
      return 1000;
    case 'minute':
      return 60_000;
    case 'hour':
      return 3_600_000;
    case 'day':
      return 86_400_000;
    case 'week':
      return 604_800_000;
    default:
      throw new QueryModelError(`unsupported _bucket unit '${unit}'`);
  }
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function tzOffsetMs(tz: string, t: number): number {
  let dtf = tzFormatters.get(tz);
  if (dtf === undefined) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    tzFormatters.set(tz, dtf);
  }
  const parts = dtf.formatToParts(new Date(t));
  const val = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p === undefined ? 0 : Number(p.value);
  };
  const asUtc = Date.UTC(val('year'), val('month') - 1, val('day'), val('hour') % 24, val('minute'), val('second'));
  return asUtc - t;
}

/** The bucket start (epoch ms) for a row, or `''` when the field is un-coercible. */
function bucketValue(row: Row, key: BucketKey): number | string {
  const b = key._bucket;
  const t = toMs(get(b.field)(row));
  if (t === null) return '';
  let unitMs: number;
  if (b.seconds !== undefined) unitMs = b.seconds * 1000;
  else if (b.unit !== undefined) unitMs = unitToMs(b.unit);
  else unitMs = 86_400_000;
  const offset = b.offset ?? 0;
  const off = b.tz !== undefined ? tzOffsetMs(b.tz, t) : 0;
  const shifted = t + off;
  return Math.floor((shifted - offset) / unitMs) * unitMs + offset - off;
}

interface Grouped {
  record: Row;
  rows: Row[];
}

function computeItems(group: Grouped, items: QueryExpression[], ctx: EvalCtx): void {
  const names = new Map<QueryExpression, string>();
  for (const item of items) {
    const name = item.name;
    if (name === undefined) throw new QueryModelError('a group_by aggregate item needs a `name`');
    names.set(item, name);
    const agg = item.aggregate;
    if (agg !== undefined && isFold(agg)) group.record[name] = applyFold(agg, group.rows, ctx);
  }
  const pending = items.filter((it) => {
    const agg = it.aggregate;
    return agg !== undefined && !isFold(agg);
  });
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      const agg = item.aggregate;
      const name = names.get(item);
      if (agg === undefined || name === undefined) continue;
      if (collectRefs(agg).every((r) => r in group.record)) {
        group.record[name] = evalGroup(agg, group.record);
        pending.splice(i, 1);
        progressed = true;
      }
    }
  }
  if (pending.length > 0) throw new QueryModelError('cycle in `group_by` derived items');
}

// ── window broadcast ────────────────────────────────────────────────────────
interface WindowColumn {
  name: string;
  spec: WindowSpec;
  fold: Fold;
}

function collectWindowColumns(select: SelectItem[] | undefined): WindowColumn[] {
  const cols: WindowColumn[] = [];
  for (const item of select ?? []) {
    if (typeof item === 'string') continue;
    const { name, aggregate } = item;
    if (name === undefined || aggregate === undefined) continue;
    if (isFold(aggregate) && aggregate._window !== undefined) cols.push({ name, spec: aggregate._window, fold: aggregate });
  }
  return cols;
}

function partitionKeysOf(spec: WindowSpec): string[] {
  if (spec.partition_by === undefined) return [];
  return Array.isArray(spec.partition_by) ? spec.partition_by : [spec.partition_by];
}

function lowerBound(bound: WindowBound, cur: number): number {
  if (bound === 'unbounded') return -Infinity;
  if (typeof bound === 'string') return resolveIsoPeriod(bound, cur).from;
  return Number.NEGATIVE_INFINITY;
}

function upperBound(bound: WindowBound, cur: number): number {
  if (bound === 'unbounded') return Infinity;
  if (typeof bound === 'string') return resolveIsoPeriod(bound, cur).to;
  return Number.POSITIVE_INFINITY;
}

function frameRowsFor(ordered: number[], pos: number, rows: Row[], spec: WindowSpec): Row[] {
  const frame: WindowFrame | undefined = spec.frame;
  if (frame === undefined) return ordered.map((i) => rows[i]);
  const [fromB, toB] = frame;
  const orderKey = spec.field;
  // A bound is a RANGE (time) offset only when it is a duration string — `'unbounded'`
  // is also a string, so it must be excluded.
  const hasDuration =
    (fromB !== 'unbounded' && typeof fromB === 'string') || (toB !== 'unbounded' && typeof toB === 'string');
  const mode = spec.frame_mode ?? (hasDuration ? 'range' : 'rows');
  if (mode === 'range') {
    if (orderKey === undefined) throw new QueryModelError('a RANGE frame requires `_window.field`');
    const cur = toMs(get(orderKey)(rows[ordered[pos]]));
    if (cur === null) return [];
    const lower = lowerBound(fromB, cur);
    const upper = upperBound(toB, cur);
    return ordered
      .map((i) => rows[i])
      .filter((r) => {
        const t = toMs(get(orderKey)(r));
        return t !== null && t >= lower && t <= upper;
      });
  }
  if (mode === 'groups') {
    const gid = new Array<number>(ordered.length);
    let g = -1;
    let prev: unknown;
    ordered.forEach((i, p) => {
      const v = orderKey === undefined ? p : get(orderKey)(rows[i]);
      if (p === 0 || !_.isEqual(v, prev)) {
        g += 1;
        prev = v;
      }
      gid[p] = g;
    });
    const total = g + 1;
    const posG = gid[pos];
    const loG = fromB === 'unbounded' ? 0 : posG + (typeof fromB === 'number' ? fromB : 0);
    const hiG = toB === 'unbounded' ? total - 1 : posG + (typeof toB === 'number' ? toB : 0);
    return ordered.filter((_, p) => gid[p] >= Math.max(0, loG) && gid[p] <= Math.min(total - 1, hiG)).map((i) => rows[i]);
  }
  const lo = fromB === 'unbounded' ? 0 : pos + (typeof fromB === 'number' ? fromB : 0);
  const hi = toB === 'unbounded' ? ordered.length - 1 : pos + (typeof toB === 'number' ? toB : 0);
  return ordered.slice(Math.max(0, lo), Math.min(ordered.length - 1, hi) + 1).map((i) => rows[i]);
}

/** Per-position inclusive frame bounds for a ROWS-mode (or whole-partition) frame. */
function rowFrameBounds(n: number, spec: WindowSpec): { lo: number[]; hi: number[] } | undefined {
  const frame = spec.frame;
  if (frame === undefined) {
    return { lo: new Array<number>(n).fill(0), hi: new Array<number>(n).fill(n - 1) };
  }
  const [fromB, toB] = frame;
  const hasDuration =
    (fromB !== 'unbounded' && typeof fromB === 'string') || (toB !== 'unbounded' && typeof toB === 'string');
  const mode = spec.frame_mode ?? (hasDuration ? 'range' : 'rows');
  if (mode !== 'rows') return undefined; // groups/range frames stay on the materializing path
  const lo = new Array<number>(n);
  const hi = new Array<number>(n);
  for (let pos = 0; pos < n; pos++) {
    lo[pos] = Math.max(0, fromB === 'unbounded' ? 0 : pos + (typeof fromB === 'number' ? fromB : 0));
    hi[pos] = Math.min(n - 1, toB === 'unbounded' ? n - 1 : pos + (typeof toB === 'number' ? toB : 0));
  }
  return { lo, hi };
}

/** A monoid fold the fast window path can answer from prefix sums / a deque. */
function isFastFold(fold: Fold): boolean {
  return (
    '_sum' in fold || '_count' in fold || '_avg' in fold || '_min' in fold || '_max' in fold || '_ratio_of_sums' in fold
  );
}

function prefix(ordered: number[], rows: Row[], val: (r: Row) => number): number[] {
  const p = new Array<number>(ordered.length + 1);
  p[0] = 0;
  let acc = 0;
  ordered.forEach((rowIndex, i) => {
    const row = rows[rowIndex];
    acc += row === undefined ? 0 : val(row);
    p[i + 1] = acc;
  });
  return p;
}

const rangeSum = (p: number[], lo: number, hi: number): number => (hi < lo ? 0 : (p[hi + 1] ?? 0) - (p[lo] ?? 0));

/** Sliding-window min/max over monotone `[lo, hi]` bounds via a monotonic deque. */
function monotonicFrames(vals: unknown[], lo: number[], hi: number[], isMin: boolean): unknown[] {
  const n = vals.length;
  const out = new Array<unknown>(n);
  const deque: number[] = [];
  let head = 0;
  let nextAdd = 0;
  const notBetter = (a: unknown, b: unknown): boolean =>
    isMin ? _.compareOrder(a, b) >= 0 : _.compareOrder(a, b) <= 0;
  for (let pos = 0; pos < n; pos++) {
    const hiPos = hi[pos] ?? -1;
    while (nextAdd <= hiPos) {
      const v = vals[nextAdd];
      if (v !== null && v !== undefined) {
        while (deque.length > head) {
          const backPos = deque[deque.length - 1];
          const bv = backPos === undefined ? undefined : vals[backPos];
          if (bv !== null && bv !== undefined && notBetter(bv, v)) deque.pop();
          else break;
        }
        deque.push(nextAdd);
      }
      nextAdd += 1;
    }
    const loPos = lo[pos] ?? 0;
    while (deque.length > head) {
      const f = deque[head];
      if (f !== undefined && f < loPos) head += 1;
      else break;
    }
    const front = deque[head];
    out[pos] = front === undefined ? null : vals[front];
  }
  return out;
}

/** O(partition) evaluation of a ROWS-mode / whole-partition monoid window fold. */
function evaluateWindowFast(
  ordered: number[],
  rows: Row[],
  fold: Fold,
  bounds: { lo: number[]; hi: number[] },
  out: unknown[]
): void {
  const n = ordered.length;
  const { lo, hi } = bounds;
  const emit = (column: unknown[]): void => {
    for (let pos = 0; pos < n; pos++) {
      const rowIndex = ordered[pos];
      if (rowIndex !== undefined) out[rowIndex] = column[pos];
    }
  };
  const prefixColumn = (p: number[]): number[] => lo.map((l, pos) => rangeSum(p, l, hi[pos] ?? 0));
  if ('_sum' in fold) {
    emit(prefixColumn(prefix(ordered, rows, (r) => num(evalRow(fold._sum, r)))));
    return;
  }
  if ('_count' in fold) {
    if (fold._count === true) {
      emit(lo.map((l, pos) => Math.max(0, (hi[pos] ?? 0) - l + 1)));
      return;
    }
    const operand = fold._count;
    emit(
      prefixColumn(
        prefix(ordered, rows, (r) => {
          const v = evalRow(operand, r);
          return v !== null && v !== undefined ? 1 : 0;
        })
      )
    );
    return;
  }
  if ('_avg' in fold) {
    const p = prefix(ordered, rows, (r) => num(evalRow(fold._avg, r)));
    emit(
      lo.map((l, pos) => {
        const cnt = (hi[pos] ?? 0) - l + 1;
        return cnt <= 0 ? null : rangeSum(p, l, hi[pos] ?? 0) / cnt;
      })
    );
    return;
  }
  if ('_min' in fold || '_max' in fold) {
    const operand = '_min' in fold ? fold._min : fold._max;
    const vals = ordered.map((i) => {
      const row = rows[i];
      return row === undefined ? undefined : evalRow(operand, row);
    });
    emit(monotonicFrames(vals, lo, hi, '_min' in fold));
    return;
  }
  if ('_ratio_of_sums' in fold) {
    const { num: numExpr, den } = fold._ratio_of_sums;
    const pn = prefix(ordered, rows, (r) => num(evalRow(numExpr, r)));
    const pd = prefix(ordered, rows, (r) => num(evalRow(den, r)));
    emit(
      lo.map((l, pos) => {
        const d = rangeSum(pd, l, hi[pos] ?? 0);
        return d === 0 ? null : rangeSum(pn, l, hi[pos] ?? 0) / d;
      })
    );
  }
}

function computeWindowColumn(rows: Row[], col: WindowColumn, ctx: EvalCtx): unknown[] {
  const orderKey = col.spec.field;
  const partitionKeys = partitionKeysOf(col.spec);
  const partitions = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = JSON.stringify(partitionKeys.map((k) => get(k)(row)));
    const list = partitions.get(key);
    if (list === undefined) partitions.set(key, [i]);
    else list.push(i);
  });
  const out = new Array<unknown>(rows.length);
  const fastEligible = isFastFold(col.fold) && col.fold._filter === undefined && col.spec.period === undefined;
  for (const indices of partitions.values()) {
    const ordered =
      orderKey === undefined
        ? indices
        : [...indices].sort((x, y) => _.compareOrder(get(orderKey)(rows[x]), get(orderKey)(rows[y])));
    const bounds = fastEligible ? rowFrameBounds(ordered.length, col.spec) : undefined;
    if (bounds !== undefined) {
      evaluateWindowFast(ordered, rows, col.fold, bounds, out);
    } else {
      ordered.forEach((rowIndex, pos) => {
        out[rowIndex] = applyFold(col.fold, frameRowsFor(ordered, pos, rows, col.spec), ctx);
      });
    }
  }
  return out;
}

/** Attach every window-fold column in `select` to each row (the window phase). */
function applyWindowPhase(rows: Row[], select: SelectItem[] | undefined, ctx: EvalCtx): Row[] {
  const cols = collectWindowColumns(select);
  if (cols.length === 0) return rows;
  let out = rows;
  for (const col of cols) {
    const column = computeWindowColumn(rows, col, ctx);
    out = out.map((row, i) => ({ ...row, [col.name]: column[i] }));
  }
  return out;
}

// ── tail + projection ───────────────────────────────────────────────────────
/**
 * One order key. The null bucket is decided by the direction SUFFIX only (`_nulls_first`
 * / `_nulls_last`), and the value order by `asc`/`desc` — so `asc_nulls_first` puts
 * nulls first and `desc_nulls_last` puts them last (SQL default: ASC → NULLS LAST,
 * DESC → NULLS FIRST).
 */
function compareOrderKey(av: unknown, bv: unknown, dir: string): number {
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsFirst = dir.endsWith('_nulls_first') || (dir === 'desc' && !dir.endsWith('_nulls_last'));
    const nullRank = nullsFirst ? -1 : 1;
    return aNull ? nullRank : -nullRank;
  }
  const c = _.compareOrder(av, bv);
  return dir.startsWith('desc') ? -c : c;
}

function compareMulti(orders: OrderByExpression[], a: Row, b: Row): number {
  for (const order of orders) {
    for (const [field, dir] of Object.entries(order)) {
      if (typeof dir !== 'string') continue;
      const c = compareOrderKey(get(field)(a), get(field)(b), dir);
      if (c !== 0) return c;
    }
  }
  return 0;
}

function distinctBy<T>(rows: T[], refs: string[], toRow: (t: T) => Row): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const source = toRow(row);
    const key = JSON.stringify(refs.map((ref) => get(ref)(source)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function applyTail<T>(rows: T[], query: QueryExpression, toRow: (t: T) => Row): T[] {
  let out = rows;
  if (query.order_by !== undefined) {
    const orders = query.order_by;
    out = [...out].sort((a, b) => compareMulti(orders, toRow(a), toRow(b)));
  }
  if (query.distinct_on !== undefined) {
    const refs = query.distinct_on;
    out = distinctBy(out, refs, toRow);
  }
  if (query.offset !== undefined) out = out.slice(query.offset);
  if (query.limit !== undefined) out = out.slice(0, query.limit);
  return out;
}

function projectGroup(group: Grouped, query: QueryExpression, ctx: EvalCtx): Row {
  const select = query.select;
  if (select === undefined) return group.record;
  const out: Row = {};
  // CSE: identical nested queries in one projection evaluate once over the same rows
  // (sound — `execute` is deterministic and never reads a node's `name`).
  const nested = new Map<string, Row[]>();
  for (const item of select) {
    if (typeof item === 'string') {
      out[item] = get(item)(group.record);
      continue;
    }
    const name = item.name ?? 'nested';
    const agg = item.aggregate;
    if (agg !== undefined && isFold(agg) && agg._window !== undefined) {
      out[name] = group.record[name]; // the window column, computed in the window phase
    } else {
      const key = computeKey(item);
      let rows = nested.get(key);
      if (rows === undefined) {
        rows = execute(item, group.rows, ctx);
        nested.set(key, rows);
      }
      out[name] = rows;
    }
  }
  return out;
}

function mergeOther(groups: Grouped[], keep: { n: number }, query: QueryExpression, ctx: EvalCtx): Grouped[] {
  const orders = query.order_by;
  const ranked = orders !== undefined ? [...groups].sort((a, b) => compareMulti(orders, a.record, b.record)) : groups;
  const top = ranked.slice(0, keep.n);
  const rest = ranked.slice(keep.n);
  if (rest.length === 0) return top;
  const merged: Grouped = { record: { _other: true }, rows: rest.flatMap((g) => g.rows) };
  const aggItems = (query.group_by ?? []).filter((i): i is QueryExpression => typeof i === 'object' && i !== null && !isBucketKey(i));
  computeItems(merged, aggItems, ctx);
  return [...top, merged];
}

/**
 * Execute a query over rows. `ctx` carries the sources for subquery operands; at
 * the top level it defaults to the rows themselves.
 */
export function execute(query: QueryExpression, rows: Row[], ctx?: EvalCtx): Row[] {
  const context: EvalCtx = ctx ?? emptyCtx(rows);
  validateQuery(query);
  const post = postNames(query);
  const { pre, post: postFilter } = splitWhere(query.where, post);

  const data = pre !== undefined ? rows.filter((r) => matches(pre, r, context)) : rows.slice();

  const items = query.group_by ?? [];
  const select = query.select;

  if (items.length === 0) {
    // A relation-valued select with no group_by nests over the SOURCE (the parent)
    // and emits ONE row (§15.10) — unless a window fold is present (broadcast, §15.7).
    const hasWindow = collectWindowColumns(select).length > 0;
    const relations = (select ?? []).filter(
      (item): item is QueryExpression =>
        typeof item !== 'string' && !(item.aggregate !== undefined && isFold(item.aggregate) && item.aggregate._window !== undefined)
    );
    if (relations.length > 0 && !hasWindow) {
      const out: Row = {};
      const nested = new Map<string, Row[]>();
      for (const item of select ?? []) {
        if (typeof item === 'string') {
          out[item] = get(item)(data[0] ?? {});
          continue;
        }
        const key = computeKey(item);
        let rows = nested.get(key);
        if (rows === undefined) {
          rows = execute(item, data, context);
          nested.set(key, rows);
        }
        out[item.name ?? 'nested'] = rows;
      }
      // Apply the tail + qualify to the single emitted row (consistent with the
      // grouped path) rather than silently ignoring them.
      let rowsOut: Row[] = [out];
      const qualify = query.qualify;
      if (qualify !== undefined) rowsOut = rowsOut.filter((r) => matches(qualify, r, context));
      return applyTail(rowsOut, query, (r) => r);
    }

    let rowsOut = applyWindowPhase(data, select, context);
    const qualify = query.qualify;
    if (qualify !== undefined) rowsOut = rowsOut.filter((r) => matches(qualify, r, context));
    const tailed = applyTail(rowsOut, query, (r) => r);
    if (select === undefined) return tailed;
    return tailed.map((row) => {
      const out: Row = {};
      const nested = new Map<string, Row[]>();
      for (const item of select) {
        if (typeof item === 'string') {
          out[item] = get(item)(row);
          continue;
        }
        const name = item.name ?? 'nested';
        const agg = item.aggregate;
        if (agg !== undefined && isFold(agg) && agg._window !== undefined) out[name] = row[name];
        else {
          const key = computeKey(item);
          let rows = nested.get(key);
          if (rows === undefined) {
            rows = execute(item, [row], context);
            nested.set(key, rows);
          }
          out[name] = rows;
        }
      }
      return out;
    });
  }

  if (postFilter !== undefined && query.keep !== undefined) {
    throw new QueryModelError('`keep`/`_other` with a post-group predicate is not supported');
  }

  const keyItems = items.filter((i): i is string | BucketKey => typeof i === 'string' || isBucketKey(i));
  const aggItems = items.filter((i): i is QueryExpression => typeof i === 'object' && i !== null && !isBucketKey(i));

  const keyOf = (row: Row): unknown[] => keyItems.map((item) => (typeof item === 'string' ? get(item)(row) : bucketValue(row, item)));
  const keyName = (item: string | BucketKey): string => (typeof item === 'string' ? item : item._bucket.field);

  const groups = new Map<string, Grouped>();
  for (const row of data) {
    const values = keyOf(row);
    const key = JSON.stringify(values);
    let group = groups.get(key);
    if (group === undefined) {
      const created: Grouped = { record: {}, rows: [] };
      keyItems.forEach((item, idx) => {
        created.record[keyName(item)] = values[idx];
      });
      groups.set(key, created);
      group = created;
    }
    group.rows.push(row);
  }

  let grouped = [...groups.values()];
  for (const group of grouped) computeItems(group, aggItems, context);
  if (query.keep?.other === true) {
    grouped = mergeOther(grouped, query.keep, query, context);
  }
  if (postFilter !== undefined) grouped = grouped.filter((g) => matches(postFilter, g.record, context));

  // Window phase over the group records (partition defaults to the group_by — here,
  // each record is one group, so the window is whole-partition unless overridden).
  if (collectWindowColumns(select).length > 0) {
    const records = applyWindowPhase(
      grouped.map((g) => g.record),
      select,
      context
    );
    grouped = grouped.map((g, i) => ({ record: records[i], rows: g.rows }));
  }

  const qualify = query.qualify;
  if (qualify !== undefined) grouped = grouped.filter((g) => matches(qualify, g.record, context));

  grouped = applyTail(grouped, query, (g) => g.record);
  return grouped.map((g) => projectGroup(g, query, context));
}

/**
 * Execute a planned query: install the plan + index lookup on the context, apply the
 * root's access path (an index candidate-narrowing — the exact predicate is still
 * re-checked by `execute`), and delegate to the reference executor.
 */
export function executePlanned(
  plan: PhysicalPlan,
  rows: Row[],
  ctx?: EvalCtx,
  indexFor?: (source: string) => PlannerIndex | undefined,
  source?: string
): Row[] {
  const base = ctx ?? emptyCtx(rows);
  const context: EvalCtx = { ...base, plan, planSource: source, indexFor };
  const readSource = plan.root.query.source ?? source;
  const store = readSource === undefined ? undefined : indexFor?.(readSource);
  const narrowed =
    plan.root.access.kind === 'index' && store !== undefined ? store.rowsFor(plan.root.access.ids) : rows;
  return execute(plan.root.query, narrowed, context);
}
