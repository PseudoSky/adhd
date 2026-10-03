import type {
  AggregateExpression,
  AggregateFunction,
  BooleanExpression,
  GroupByExpression,
  GroupKey,
  HavingExpression,
  NestedGroupNode,
  QueryOutput,
  TopNExpression,
  WindowSpec,
} from './expressions';
import { QueryValidationError } from './errors';
import { compileWhere } from './parser';
import { resolveIsoPeriod } from './period';
import { compileAccessor, PathGetter } from './path';

/**
 * Grouping / aggregation / HAVING runtime for the DataView pipeline.
 *
 * Phase model (SPEC section 2). The order is held by a single fixed runtime
 * pipeline (commit(), this module) plus compile-time validation — it is NOT a
 * type-level guarantee. `having` is compiled by the same compiler as `where`
 * (so an aggregate is only rejected under `where` at runtime, when `where` is
 * built before grouping); the phases run in exactly this order:
 *   Phase 0 SCOPE      window bounds resolved once (resolveIsoPeriod)
 *   Phase 1 WHERE      per-row predicate (done by commit(), before this module)
 *   Phase 2 GROUP      hash-partition the post-WHERE rows by group key
 *   Phase 3 AGGREGATE  per-group fold over the rows INSIDE the window
 *   Phase 4 HAVING     per-group predicate over the aggregate output fields
 *   Phase 5 TOP_N      per grouping set, on the final grouped rows
 *   Phase 6 OUTPUT     `groups` (one row per group) or `rows` (broadcast back)
 *
 * The window constrains the AGGREGATION, never row emission: for
 * `output: 'rows'` every post-WHERE row of a surviving group is emitted,
 * including rows whose own timestamp is outside the window (SPEC AC-4).
 *
 * A `_nest` group_by replaces phases 2-6 with a single-pass trie of
 * accumulators: one row descends every level once, accumulating into each
 * ancestor. Time O(n * nodes) = O(n) at a fixed tree, space O(G) groups; no
 * event array is materialized. Its output is always roots-with-children.
 */

type Row = Record<string, unknown>;

export type GroupedRow = Record<string, unknown> & { _grouping?: string[] };

/** The subset of QueryExpression that drives grouping. */
export interface GroupingSpec {
  group_by?: GroupByExpression;
  aggregate?: AggregateExpression;
  having?: HavingExpression;
  window?: WindowSpec;
  output?: QueryOutput;
  top_n?: TopNExpression;
}

export interface CompiledGrouping {
  mode: 'flat' | 'rollup' | 'cube' | 'nest';
  keys: CompiledGroupKey[];
  aggregates: CompiledAggregate[];
  hasHaving: boolean;
  having?: (row: Record<string, unknown>) => boolean;
  hasWindow: boolean;
  windowField?: string;
  /** Compiled accessor for `window.field` (exact-name-first, path-fallback). */
  windowGet?: PathGetter;
  windowFrom?: number;
  windowTo?: number;
  output: QueryOutput;
  topN?: { n: number; by: string; byGet: PathGetter; other: boolean };
  /** Present iff mode === 'nest': the roots of the nested hierarchy. */
  nest?: CompiledNestNode[];
  knownFields: Set<string>;
  raw: GroupingSpec;
}

/**
 * A compiled node of a `_nest` hierarchy. Each node owns a key, its own
 * aggregate set (accumulated over every row beneath it), an optional per-node
 * HAVING over its own emitted row, and an optional per-node `top_n` that prunes
 * THIS node's children (per-parent; the dropped tail collapses into a single
 * `_other` child, mirroring flat `top_n`). `knownFields` are the fields of the
 * node's OWN emitted row (key name + aggregate outputs).
 */
export interface CompiledNestNode {
  key: CompiledGroupKey;
  aggregates: CompiledAggregate[];
  knownFields: Set<string>;
  hasHaving: boolean;
  having?: (row: Record<string, unknown>) => boolean;
  topN?: { n: number; by: string; byGet: PathGetter; other: boolean };
  children: CompiledNestNode[];
}

interface CompiledGroupKey {
  name: string;
  field: string;
  bucket?: { seconds: number; offset: number };
  /** Compiled accessor replacing the old fastGet (exact-name-first, path-fallback). */
  get: PathGetter;
}

/**
 * A compiled aggregate. `op` is the operator key; the remaining fields are the
 * parameters that key carries (only the relevant ones are set). `get`/`numGet`/
 * `denGet` are compiled field accessors (path-notation parity with where).
 */
interface CompiledAggregate {
  out: string;
  op: string;
  field?: string;
  get?: PathGetter;
  num?: string;
  numGet?: PathGetter;
  den?: string;
  denGet?: PathGetter;
  q?: number;
  countRows?: boolean;
}

/** Mutable per-group accumulator. One shape with optional lanes, switched on `op`. */
interface Acc {
  op: string;
  field?: string;
  get?: PathGetter;
  q?: number;
  countRows?: boolean;
  num?: string;
  numGet?: PathGetter;
  den?: string;
  denGet?: PathGetter;
  sum?: number;
  count?: number;
  val?: number; // min/max high-water mark
  numSum?: number;
  denSum?: number;
  seen?: Set<unknown>;
  values?: number[];
}

interface GroupEntry {
  setIndex: number;
  keyValues: unknown[];
  accs: Acc[];
  row: GroupedRow;
}

const AGGREGATE_OPERATORS = new Set([
  '_sum',
  '_count',
  '_min',
  '_max',
  '_avg',
  '_ratio_of_sums',
  '_distinct_count',
  '_quantile',
]);

const CUBE_MAX_DIMENSIONS = 12;

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Same coercion the `_period` operator uses for its column (filters.ts). */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function requireField(value: unknown, out: string, op: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QueryValidationError(
      `aggregate "${out}" (${op}) requires a non-empty field name, got ${JSON.stringify(
        value
      )}`
    );
  }
  return value;
}

function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = q * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  const frac = rank - lo;
  return s[lo] + (s[hi] - s[lo]) * frac;
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

function compileGroupKey(
  key: GroupKey,
  where: string | number
): CompiledGroupKey {
  if (typeof key === 'string') {
    if (key.length === 0) {
      throw new QueryValidationError(`group_by[${where}] is an empty field name`);
    }
    return { name: key, field: key, get: compileAccessor(key) };
  }
  if (key && typeof key === 'object' && key._bucket) {
    const b = key._bucket;
    if (typeof b.field !== 'string' || b.field.length === 0) {
      throw new QueryValidationError(
        `group_by[${where}]._bucket.field must be a non-empty field name`
      );
    }
    if (typeof b.seconds !== 'number' || !(b.seconds > 0)) {
      throw new QueryValidationError(
        `group_by[${where}]._bucket.seconds must be a positive number, got ${JSON.stringify(
          b.seconds
        )}`
      );
    }
    const offset = typeof b.offset === 'number' ? b.offset : 0;
    return {
      name: b.field,
      field: b.field,
      bucket: { seconds: b.seconds, offset },
      get: compileAccessor(b.field),
    };
  }
  throw new QueryValidationError(
    `group_by[${where}] must be a field name or {_bucket:{field,seconds,offset?}}`
  );
}

function resolveGroupKeys(groupBy: GroupByExpression | undefined): {
  mode: CompiledGrouping['mode'];
  keys: CompiledGroupKey[];
  nest?: CompiledNestNode[];
} {
  if (groupBy === undefined) return { mode: 'flat', keys: [] };
  if (Array.isArray(groupBy)) {
    return { mode: 'flat', keys: groupBy.map(compileGroupKey) };
  }
  // `groupBy` is now `{_rollup}|{_cube}|{_nest}`; TS does not narrow a union
  // member by an optional property, so narrow through a single structural cast.
  const compound = groupBy as {
    _rollup?: GroupKey[];
    _cube?: GroupKey[];
    _nest?: NestedGroupNode[];
  };
  if (compound._rollup !== undefined) {
    return { mode: 'rollup', keys: compound._rollup.map(compileGroupKey) };
  }
  if (compound._cube !== undefined) {
    if (compound._cube.length > CUBE_MAX_DIMENSIONS) {
      throw new QueryValidationError(
        `_cube with ${compound._cube.length} dimensions would emit 2^${compound._cube.length} grouping sets; the engine caps cube dimensions at ${CUBE_MAX_DIMENSIONS}`
      );
    }
    return { mode: 'cube', keys: compound._cube.map(compileGroupKey) };
  }
  if (compound._nest !== undefined) {
    const nest = compileNest(compound._nest);
    return { mode: 'nest', keys: flattenNestKeys(nest), nest };
  }
  throw new QueryValidationError(
    'group_by must be an array, {_rollup:[...]}, {_cube:[...]} or {_nest:[...]}'
  );
}

/**
 * Compile one node of a `_nest` hierarchy. A node's `knownFields` are the
 * fields of its OWN emitted row (its key name + its aggregate outputs); a
 * node's `top_n.by` must name a field of one of its CHILD rows (so the node can
 * rank its children), which is the nested analogue of flat `top_n.by`.
 */
function compileNestNode(raw: NestedGroupNode, path: string): CompiledNestNode {
  const key = compileGroupKey(raw.key, path);
  const aggregates = Object.entries(raw.aggregate ?? {}).map(([out, fn]) =>
    compileAggregate(out, fn)
  );
  const knownFields = new Set<string>([
    key.name,
    ...aggregates.map((a) => a.out),
  ]);

  let having: ((row: Record<string, unknown>) => boolean) | undefined;
  if (raw.having !== undefined) {
    validateHaving(raw.having, knownFields, `${path}.having`);
    having = compileWhere(raw.having as unknown as BooleanExpression);
  }

  const children = (raw.children ?? []).map((child, i) =>
    compileNestNode(child, `${path}.children[${i}]`)
  );

  let topN: CompiledNestNode['topN'];
  if (raw.top_n !== undefined) {
    const t = raw.top_n;
    if (!t || typeof t.n !== 'number' || !(t.n >= 1)) {
      throw new QueryValidationError(
        `${path}.top_n.n must be a number >= 1, got ${JSON.stringify(t?.n)}`
      );
    }
    const childFields = new Set<string>();
    for (const child of children) {
      child.knownFields.forEach((f) => childFields.add(f));
    }
    if (typeof t.by !== 'string' || !childFields.has(t.by)) {
      throw new QueryValidationError(
        `${path}.top_n.by must name a child key or child aggregate output; got ${JSON.stringify(
          t.by
        )}. Known child fields: ${[...childFields].join(', ')}`
      );
    }
    topN = {
      n: Math.floor(t.n),
      by: t.by,
      byGet: compileAccessor(t.by),
      other: t.other === true,
    };
  }

  return {
    key,
    aggregates,
    knownFields,
    hasHaving: raw.having !== undefined,
    having,
    topN,
    children,
  };
}

function compileNest(nodes: NestedGroupNode[]): CompiledNestNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new QueryValidationError(
      '_nest must be a non-empty array of group nodes'
    );
  }
  return nodes.map((n, i) => compileNestNode(n, `group_by._nest[${i}]`));
}

/** All keys of a compiled nest tree, DFS order (the `keys` for the plan). */
function flattenNestKeys(nodes: CompiledNestNode[]): CompiledGroupKey[] {
  const keys: CompiledGroupKey[] = [];
  const walk = (node: CompiledNestNode): void => {
    keys.push(node.key);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return keys;
}

/** All emitted-row field names across a compiled nest tree (plan knownFields). */
function collectNestKnownFields(nodes: CompiledNestNode[]): string[] {
  const fields: string[] = [];
  const walk = (node: CompiledNestNode): void => {
    node.knownFields.forEach((f) => fields.push(f));
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return fields;
}

function compileAggregate(
  out: string,
  fn: AggregateFunction
): CompiledAggregate {
  const keys = Object.keys(fn);
  if (keys.length !== 1 || !AGGREGATE_OPERATORS.has(keys[0])) {
    throw new QueryValidationError(
      `aggregate "${out}": unknown aggregate function ${JSON.stringify(
        fn
      )}. Known functions: ${[...AGGREGATE_OPERATORS].join(', ')}`
    );
  }
  const op = keys[0];
  const param = (fn as unknown as Record<string, unknown>)[op];
  switch (op) {
    case '_sum':
    case '_min':
    case '_max':
    case '_avg':
    case '_distinct_count': {
      const field = requireField(param, out, op);
      return { out, op, field, get: compileAccessor(field) };
    }
    case '_count': {
      if (param === true) return { out, op, countRows: true };
      const field = requireField(param, out, op);
      return { out, op, field, get: compileAccessor(field) };
    }
    case '_ratio_of_sums': {
      const r = (param ?? {}) as { num?: unknown; den?: unknown };
      const num = requireField(r.num, out, `${op}.num`);
      const den = requireField(r.den, out, `${op}.den`);
      return { out, op, num, den, numGet: compileAccessor(num), denGet: compileAccessor(den) };
    }
    case '_quantile': {
      const p = (param ?? {}) as { field?: unknown; q?: unknown };
      const field = requireField(p.field, out, `${op}.field`);
      if (typeof p.q !== 'number' || p.q < 0 || p.q > 1) {
        throw new QueryValidationError(
          `aggregate "${out}" (_quantile) requires q in [0,1], got ${JSON.stringify(
            p.q
          )}`
        );
      }
      return { out, op, field, get: compileAccessor(field), q: p.q };
    }
    default:
      // unreachable: AGGREGATE_OPERATORS and this switch list the same keys
      throw new QueryValidationError(
        `aggregate "${out}": unhandled aggregate function "${op}"`
      );
  }
}

/**
 * Validate that every field a `having` tree references is a known output field
 * (an aggregate output or a group key). The operator names themselves are
 * validated by `compileWhere`, which now throws on an unknown operator.
 */
function validateHaving(
  node: HavingExpression,
  known: Set<string>,
  path: string
): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new QueryValidationError(`having at ${path} must be an object`);
  }
  const record = node as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === '_and' || key === '_or') {
      const arr = record[key];
      if (!Array.isArray(arr)) {
        throw new QueryValidationError(`having.${key} at ${path} must be an array`);
      }
      arr.forEach((child, i) =>
        validateHaving(child as HavingExpression, known, `${path}.${key}[${i}]`)
      );
    } else if (key === '_not') {
      validateHaving(record[key] as HavingExpression, known, `${path}._not`);
    } else if (key.startsWith('_')) {
      throw new QueryValidationError(
        `having at ${path}: unexpected logical key "${key}"`
      );
    } else if (!known.has(key)) {
      throw new QueryValidationError(
        `having references unknown output field "${key}" at ${path}. Known fields: ${[
          ...known,
        ].join(', ')}`
      );
    }
  }
}

function compileWindow(
  window: WindowSpec | undefined
): Pick<
  CompiledGrouping,
  'hasWindow' | 'windowField' | 'windowGet' | 'windowFrom' | 'windowTo'
> {
  if (window === undefined) {
    return { hasWindow: false };
  }
  if (!window || typeof window.field !== 'string' || window.field.length === 0) {
    throw new QueryValidationError('window.field must be a non-empty field name');
  }
  const period = window.period;
  const duration = Array.isArray(period) ? period[0] : period;
  const anchor = Array.isArray(period) ? period[1] : Date.now();
  // Same resolver as the `_period` operator (SPEC AC-7); throws on a bad period.
  const bounds = resolveIsoPeriod(duration, anchor);
  return {
    hasWindow: true,
    windowField: window.field,
    windowGet: compileAccessor(window.field),
    windowFrom: bounds.from,
    windowTo: bounds.to,
  };
}

export function compileGrouping(spec: GroupingSpec): CompiledGrouping {
  const raw: GroupingSpec = spec ?? {};
  const { mode, keys, nest } = resolveGroupKeys(raw.group_by);

  // A `_nest` owns aggregation/HAVING/top_n per node; the top-level slots are
  // mutually exclusive with it, so there is exactly one place each belongs.
  if (nest !== undefined) {
    if (
      raw.aggregate !== undefined ||
      raw.having !== undefined ||
      raw.top_n !== undefined
    ) {
      throw new QueryValidationError(
        'top-level aggregate/having/top_n are not allowed with a _nest group_by; ' +
          'use the per-node aggregate/having/top_n fields on each _nest node'
      );
    }
    if (raw.output === 'rows') {
      throw new QueryValidationError(
        "output 'rows' is not supported for a _nest group_by; nested grouping emits roots-with-children"
      );
    }
  }

  const aggregates = Object.entries(raw.aggregate ?? {}).map(([out, fn]) =>
    compileAggregate(out, fn)
  );
  const knownFields = new Set<string>(
    nest !== undefined
      ? collectNestKnownFields(nest)
      : [...keys.map((k) => k.name), ...aggregates.map((a) => a.out)]
  );

  let having: ((row: Record<string, unknown>) => boolean) | undefined;
  if (raw.having !== undefined) {
    validateHaving(raw.having, knownFields, 'having');
    having = compileWhere(raw.having as unknown as BooleanExpression);
  }

  const window = compileWindow(raw.window);

  let topN: CompiledGrouping['topN'];
  if (raw.top_n !== undefined) {
    const t = raw.top_n;
    if (!t || typeof t.n !== 'number' || !(t.n >= 1)) {
      throw new QueryValidationError(
        `top_n.n must be a number >= 1, got ${JSON.stringify(t?.n)}`
      );
    }
    if (typeof t.by !== 'string' || !knownFields.has(t.by)) {
      throw new QueryValidationError(
        `top_n.by must name an aggregate output or group key; got ${JSON.stringify(
          t.by
        )}. Known fields: ${[...knownFields].join(', ')}`
      );
    }
    topN = {
      n: Math.floor(t.n),
      by: t.by,
      byGet: compileAccessor(t.by),
      other: t.other === true,
    };
  }

  const output: QueryOutput = raw.output ?? 'groups';
  if (output !== 'groups' && output !== 'rows') {
    throw new QueryValidationError(
      `output must be 'groups' or 'rows', got ${JSON.stringify(output)}`
    );
  }

  return {
    mode,
    keys,
    aggregates,
    hasHaving: raw.having !== undefined,
    having,
    ...window,
    output,
    topN,
    nest,
    knownFields,
    raw,
  };
}

// ---------------------------------------------------------------------------
// grouping sets
// ---------------------------------------------------------------------------

/** The grouping-set family, in emit order (full set first). */
export function buildGroupingSets(
  mode: CompiledGrouping['mode'],
  n: number
): number[][] {
  if (n === 0) return [[]];
  const all = Array.from({ length: n }, (_, i) => i);
  if (mode === 'flat') return [all];
  if (mode === 'nest') return [all];
  if (mode === 'rollup') {
    const sets: number[][] = [];
    for (let i = n; i >= 0; i--) sets.push(all.slice(0, i));
    return sets;
  }
  // cube
  const scored: { set: number[]; mask: number }[] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    const set: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(i);
    scored.push({ set, mask });
  }
  scored.sort((a, b) => b.set.length - a.set.length || a.mask - b.mask);
  return scored.map((s) => s.set);
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** Root key for the zero-dimension (grand total) grouping set. */
const ROOT_KEY = Symbol('group-root');

/** Normalise an object group value for Map identity (primitives pass through). */
function mapKey(value: unknown): unknown {
  return value !== null && typeof value === 'object'
    ? `j${JSON.stringify(value)}`
    : value;
}

function keyValue(row: Row, key: CompiledGroupKey): unknown {
  const raw = key.get(row);
  if (!key.bucket) return raw;
  const t = toEpochMs(raw);
  if (t === null) return undefined;
  const ms = key.bucket.seconds * 1000;
  return Math.floor((t - key.bucket.offset) / ms) * ms + key.bucket.offset;
}

/** Type-tagged key encoding so `undefined`, `null`, `1` and `"1"` never collide. */
function encodeKey(values: unknown[]): string {
  let s = '';
  for (const v of values) {
    if (v === null) s += 'n|';
    else if (v === undefined) s += 'u|';
    else if (typeof v === 'number') s += `d${v}|`;
    else if (typeof v === 'boolean') s += `b${v}|`;
    else if (typeof v === 'string') s += `s${v.length}:${v}|`;
    else s += `j${JSON.stringify(v)}|`;
  }
  return s;
}

function newAcc(agg: CompiledAggregate): Acc {
  switch (agg.op) {
    case '_sum':
    case '_avg':
      return { op: agg.op, field: agg.field, get: agg.get, sum: 0, count: 0 };
    case '_min':
    case '_max':
      return { op: agg.op, field: agg.field, get: agg.get };
    case '_count':
      return {
        op: agg.op,
        field: agg.field,
        get: agg.get,
        countRows: agg.countRows,
        count: 0,
      };
    case '_ratio_of_sums':
      return {
        op: agg.op,
        num: agg.num,
        numGet: agg.numGet,
        den: agg.den,
        denGet: agg.denGet,
        numSum: 0,
        denSum: 0,
      };
    case '_distinct_count':
      return { op: agg.op, field: agg.field, get: agg.get, seen: new Set() };
    case '_quantile':
      return { op: agg.op, field: agg.field, get: agg.get, q: agg.q, values: [] };
    default:
      throw new QueryValidationError(`unhandled aggregate "${agg.op}"`);
  }
}

function addAcc(acc: Acc, row: Row): void {
  const value = acc.get !== undefined ? acc.get(row) : undefined;
  switch (acc.op) {
    case '_sum':
    case '_avg': {
      const n = finiteNumber(value);
      if (n !== null) {
        acc.sum = (acc.sum ?? 0) + n;
        acc.count = (acc.count ?? 0) + 1;
      }
      break;
    }
    case '_min': {
      const n = finiteNumber(value);
      if (n !== null) acc.val = acc.val === undefined ? n : Math.min(acc.val, n);
      break;
    }
    case '_max': {
      const n = finiteNumber(value);
      if (n !== null) acc.val = acc.val === undefined ? n : Math.max(acc.val, n);
      break;
    }
    case '_count': {
      if (acc.countRows || !isNullish(value)) acc.count = (acc.count ?? 0) + 1;
      break;
    }
    case '_ratio_of_sums': {
      const n = finiteNumber(acc.numGet ? acc.numGet(row) : undefined);
      if (n !== null) acc.numSum = (acc.numSum ?? 0) + n;
      const d = finiteNumber(acc.denGet ? acc.denGet(row) : undefined);
      if (d !== null) acc.denSum = (acc.denSum ?? 0) + d;
      break;
    }
    case '_distinct_count': {
      if (!isNullish(value)) acc.seen?.add(value);
      break;
    }
    case '_quantile': {
      const n = finiteNumber(value);
      if (n !== null) acc.values?.push(n);
      break;
    }
    default:
      break;
  }
}

function finalizeAcc(acc: Acc): unknown {
  switch (acc.op) {
    case '_sum':
      return (acc.count ?? 0) > 0 ? acc.sum : undefined;
    case '_avg':
      return (acc.count ?? 0) > 0
        ? (acc.sum ?? 0) / (acc.count as number)
        : undefined;
    case '_min':
    case '_max':
      return acc.val;
    case '_count':
      return acc.count ?? 0;
    case '_ratio_of_sums':
      return (acc.denSum ?? 0) > 0
        ? (acc.numSum ?? 0) / (acc.denSum as number)
        : undefined;
    case '_distinct_count':
      return acc.seen?.size ?? 0;
    case '_quantile':
      return quantile(acc.values ?? [], acc.q ?? 0);
    default:
      return undefined;
  }
}

/** Merge `b` into `a` (used only for top_n's `_other` collapse). */
function mergeAcc(a: Acc, b: Acc): Acc {
  if (a.op !== b.op) {
    throw new QueryValidationError(
      `cannot merge aggregates of different kinds (${a.op} vs ${b.op})`
    );
  }
  switch (a.op) {
    case '_sum':
    case '_avg':
      a.sum = (a.sum ?? 0) + (b.sum ?? 0);
      a.count = (a.count ?? 0) + (b.count ?? 0);
      break;
    case '_min':
      if (b.val !== undefined) a.val = a.val === undefined ? b.val : Math.min(a.val, b.val);
      break;
    case '_max':
      if (b.val !== undefined) a.val = a.val === undefined ? b.val : Math.max(a.val, b.val);
      break;
    case '_count':
      a.count = (a.count ?? 0) + (b.count ?? 0);
      break;
    case '_ratio_of_sums':
      a.numSum = (a.numSum ?? 0) + (b.numSum ?? 0);
      a.denSum = (a.denSum ?? 0) + (b.denSum ?? 0);
      break;
    case '_distinct_count':
      b.seen?.forEach((v) => a.seen?.add(v));
      break;
    case '_quantile':
      if (b.values) a.values = (a.values ?? []).concat(b.values);
      break;
    default:
      break;
  }
  return a;
}

function finalizeEntry(
  entry: GroupEntry,
  set: number[],
  plan: CompiledGrouping
): void {
  set.forEach((idx, j) => {
    entry.row[plan.keys[idx].name] = entry.keyValues[j];
  });
  plan.aggregates.forEach((agg, ai) => {
    entry.row[agg.out] = finalizeAcc(entry.accs[ai]);
  });
  if (plan.mode !== 'flat') {
    const included = new Set(set);
    entry.row['_grouping'] = plan.keys
      .filter((_, i) => !included.has(i))
      .map((k) => k.name);
  }
}

function rolledUpNames(set: number[], plan: CompiledGrouping): string[] {
  const included = new Set(set);
  return plan.keys.filter((_, i) => !included.has(i)).map((k) => k.name);
}

function applyTopN(
  entries: GroupEntry[],
  sets: number[][],
  plan: CompiledGrouping
): GroupEntry[] {
  const topN = plan.topN;
  if (!topN) return entries;
  const bySet = new Map<number, GroupEntry[]>();
  for (const e of entries) {
    const bucket = bySet.get(e.setIndex);
    if (bucket) bucket.push(e);
    else bySet.set(e.setIndex, [e]);
  }
  const result: GroupEntry[] = [];
  for (let si = 0; si < sets.length; si++) {
    const bucket = bySet.get(si);
    if (!bucket) continue;
    const sorted = [...bucket].sort((a, b) => {
      const x = finiteNumber(topN.byGet(a.row));
      const y = finiteNumber(topN.byGet(b.row));
      return (y ?? Number.NEGATIVE_INFINITY) - (x ?? Number.NEGATIVE_INFINITY);
    });
    const kept = sorted.slice(0, topN.n);
    result.push(...kept);
    if (topN.other && sorted.length > kept.length) {
      const dropped = sorted.slice(kept.length);
      const mergedAccs = plan.aggregates.map((agg, ai) =>
        dropped.reduce<Acc>(
          (acc, e) => mergeAcc(acc, e.accs[ai]),
          newAcc(agg)
        )
      );
      const otherRow: GroupedRow = { _other: true };
      plan.aggregates.forEach((agg, ai) => {
        otherRow[agg.out] = finalizeAcc(mergedAccs[ai]);
      });
      if (plan.mode !== 'flat') {
        otherRow['_grouping'] = rolledUpNames(sets[si], plan);
      }
      result.push({
        setIndex: si,
        keyValues: [],
        accs: mergedAccs,
        row: otherRow,
      });
    }
  }
  return result;
}

export interface GroupingResult {
  /** Rows that feed the unchanged tail (order_by -> distinct_on -> offset -> limit). */
  tail: Row[];
  /** The surviving grouped rows, in emit order. */
  groups: GroupedRow[];
}

// ---------------------------------------------------------------------------
// nested (_nest) execution
//
// A `_nest` is a trie of accumulators. Each row descends the node tree ONCE,
// adding into every ancestor's accumulator along the way. That is O(n * nodes)
// time — O(n) at a fixed tree shape — and O(G) space: the trie holds one
// accumulator per emitted group and NO per-group event array, so a large input
// is never materialized. Per-node `top_n` sorts one node's children, adding a
// G-log-G term at the root/level totals; the per-N complexity ladder cannot
// separate that from linear, and cannot vary the tree depth `d` independently
// (both are stated in complexity.spec.ts).
// ---------------------------------------------------------------------------

type NestRow = GroupedRow & { children?: NestRow[] };

interface NestRuntime {
  node: CompiledNestNode;
  keyValue: unknown;
  accs: Acc[];
  /** One map per child dimension of `node`, keyed by that child's group value. */
  childMaps: Map<unknown, NestRuntime>[];
}

/** Fold one row into `rt` and every descendant node it reaches. */
function walkNest(node: CompiledNestNode, rt: NestRuntime, row: Row): void {
  for (let a = 0; a < node.aggregates.length; a++) {
    addAcc(rt.accs[a], row);
  }
  for (let ci = 0; ci < node.children.length; ci++) {
    const child = node.children[ci];
    const raw = keyValue(row, child.key);
    const k = mapKey(raw);
    const map = rt.childMaps[ci];
    let crt = map.get(k);
    if (crt === undefined) {
      crt = {
        node: child,
        keyValue: raw,
        accs: child.aggregates.map(newAcc),
        childMaps: child.children.map(() => new Map<unknown, NestRuntime>()),
      };
      map.set(k, crt);
    }
    walkNest(child, crt, row);
  }
}

/**
 * Turn a node's accumulated runtime into its emitted row (key + aggregates),
 * apply the node's HAVING, then recursively materialize and rank its children.
 * Returns null when the node's own HAVING rejects it.
 */
function materializeNest(rt: NestRuntime): NestRow | null {
  const node = rt.node;
  const row: NestRow = {};
  row[node.key.name] = rt.keyValue;
  node.aggregates.forEach((agg, ai) => {
    row[agg.out] = finalizeAcc(rt.accs[ai]);
  });
  if (node.hasHaving && node.having && !node.having(row)) return null;

  const entries: { node: CompiledNestNode; rt: NestRuntime; row: NestRow }[] = [];
  node.children.forEach((childNode, ci) => {
    for (const crt of rt.childMaps[ci].values()) {
      const crow = materializeNest(crt);
      if (crow) entries.push({ node: childNode, rt: crt, row: crow });
    }
  });
  let children = entries.map((e) => e.row);
  if (node.topN && entries.length > 0) {
    const { n, byGet, other } = node.topN;
    const sorted = [...entries].sort((a, b) => {
      const x = finiteNumber(byGet(a.row));
      const y = finiteNumber(byGet(b.row));
      return (y ?? Number.NEGATIVE_INFINITY) - (x ?? Number.NEGATIVE_INFINITY);
    });
    const kept = sorted.slice(0, n);
    children = kept.map((e) => e.row);
    if (other && sorted.length > kept.length) {
      const dropped = sorted.slice(kept.length);
      // Every child dimension of one node shares the node's child shape, so the
      // first dropped child supplies the merge template. (A heterogeneous node
      // — children with differing aggregate sets — is not a supported shape.)
      const template = dropped[0].node;
      const mergedAccs = template.aggregates.map((agg, ai) =>
        dropped.reduce<Acc>((acc, e) => mergeAcc(acc, e.rt.accs[ai]), newAcc(agg))
      );
      const otherRow: NestRow = { _other: true };
      template.aggregates.forEach((agg, ai) => {
        otherRow[agg.out] = finalizeAcc(mergedAccs[ai]);
      });
      children.push(otherRow);
    }
  }
  if (children.length) row.children = children;
  return row;
}

/** Execute a `_nest` plan. Output is always roots-with-children. */
export function runNestedGrouping(
  rows: Row[],
  plan: CompiledGrouping
): GroupingResult {
  const nest = plan.nest as CompiledNestNode[];
  const aggRows =
    plan.hasWindow && plan.windowGet
      ? rows.filter((row) => {
          const t = toEpochMs(plan.windowGet ? plan.windowGet(row) : undefined);
          return (
            t !== null &&
            t >= (plan.windowFrom as number) &&
            t <= (plan.windowTo as number)
          );
        })
      : rows;

  const rootMaps = nest.map(() => new Map<unknown, NestRuntime>());
  for (const row of aggRows) {
    for (let ri = 0; ri < nest.length; ri++) {
      const node = nest[ri];
      const raw = keyValue(row, node.key);
      const k = mapKey(raw);
      let rt = rootMaps[ri].get(k);
      if (rt === undefined) {
        rt = {
          node,
          keyValue: raw,
          accs: node.aggregates.map(newAcc),
          childMaps: node.children.map(() => new Map<unknown, NestRuntime>()),
        };
        rootMaps[ri].set(k, rt);
      }
      walkNest(node, rt, row);
    }
  }

  const out: NestRow[] = [];
  for (const map of rootMaps) {
    for (const rt of map.values()) {
      const r = materializeNest(rt);
      if (r) out.push(r);
    }
  }
  return { tail: out, groups: out };
}

export function runGrouping(rows: Row[], plan: CompiledGrouping): GroupingResult {
  if (plan.mode === 'nest' && plan.nest) {
    return runNestedGrouping(rows, plan);
  }

  const aggRows =
    plan.hasWindow && plan.windowGet
      ? rows.filter((row) => {
          const t = toEpochMs(plan.windowGet ? plan.windowGet(row) : undefined);
          return (
            t !== null &&
            t >= (plan.windowFrom as number) &&
            t <= (plan.windowTo as number)
          );
        })
      : rows;

  const sets = buildGroupingSets(plan.mode, plan.keys.length);
  let entries: GroupEntry[] = [];

  for (let si = 0; si < sets.length; si++) {
    const set = sets[si];
    // Nested-map group index: no per-row key string is built. `vals` is reused
    // across rows (allocated once per set) and `keyValues` is copied only when a
    // new group is created, so allocation is O(G), not O(N * dimensions).
    const root = new Map<unknown, unknown>();
    const vals: unknown[] = new Array(set.length);
    const created: GroupEntry[] = [];
    for (const row of aggRows) {
      let node = root;
      let entry: GroupEntry | undefined;
      if (set.length === 0) {
        entry = node.get(ROOT_KEY) as GroupEntry | undefined;
        if (entry === undefined) {
          entry = {
            setIndex: si,
            keyValues: [],
            accs: plan.aggregates.map(newAcc),
            row: {},
          };
          node.set(ROOT_KEY, entry);
          created.push(entry);
        }
      } else {
        for (let k = 0; k < set.length; k++) {
          const raw = keyValue(row, plan.keys[set[k]]);
          vals[k] = raw;
          const key = mapKey(raw);
          if (k === set.length - 1) {
            entry = node.get(key) as GroupEntry | undefined;
            if (entry === undefined) {
              entry = {
                setIndex: si,
                keyValues: vals.slice(),
                accs: plan.aggregates.map(newAcc),
                row: {},
              };
              node.set(key, entry);
              created.push(entry);
            }
          } else {
            let next = node.get(key) as Map<unknown, unknown> | undefined;
            if (next === undefined) {
              next = new Map();
              node.set(key, next);
            }
            node = next;
          }
        }
      }
      if (entry === undefined) continue;
      for (let a = 0; a < plan.aggregates.length; a++) {
        addAcc(entry.accs[a], row);
      }
    }
    for (const entry of created) finalizeEntry(entry, set, plan);
    entries.push(...created);
  }

  if (plan.having) {
    entries = entries.filter((e) => (plan.having as (r: Row) => boolean)(e.row));
  }
  if (plan.topN) {
    entries = applyTopN(entries, sets, plan);
  }

  let tail: Row[];
  if (plan.output === 'rows') {
    const finest = sets[0];
    const survivors = new Set<string>();
    for (const e of entries) {
      if (e.row['_other']) continue;
      survivors.add(encodeKey(e.keyValues));
    }
    tail = rows.filter((row) =>
      survivors.has(
        encodeKey(finest.map((i) => keyValue(row, plan.keys[i])))
      )
    );
  } else {
    tail = entries.map((e) => e.row);
  }

  return { tail, groups: entries.map((e) => e.row) };
}
