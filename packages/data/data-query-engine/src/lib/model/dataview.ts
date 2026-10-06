/**
 * `DataView` — the model's multi-source entry point.
 *
 * It holds named datasets and supports writes: `insert`/`append` (a Z-set `+1`)
 * and `remove` (a Z-set `-1`, §12.3). For a query whose group items are all
 * commutative-monoid folds, the grouped result is maintained INCREMENTALLY from a
 * Z-set of source rows: an append folds only the new rows into per-group
 * accumulators, and a retraction SUBTRACTS them (O(1) per group for the invertible
 * ops — `_sum`/`_count`/`_avg`). Any other shape (or a non-invertible `_min`/`_max`
 * under a retraction) falls back to the reference executor.
 *
 * The O(1)-per-group claim holds ONLY for the invertible monoid fragment (string
 * group keys + `_sum`/`_count`/`_avg` on a single field operand, no where/order/
 * limit/qualify/select/derived). The §11–§14 index/sketch/IVM-dependency layers are
 * a proposal (their §14 gate needs human approval) and are NOT part of this module.
 */
import { QueryModelError } from './errors';
import { executePlanned, isFold, type EvalCtx } from './execute';
import { compileAccessor } from '../path';
import { zsetAdd, zsetTotal, type ZSet } from './zset';
import { IndexStore, type IndexField } from './indexing';
import { planQuery } from './plan';
import { planKey } from './canonical';
import { Transform as _ } from '@adhd/data-base-transforms';
import type { Fold, QueryExpression, Row } from './types';

export interface DataSource {
  name: string;
  data: Row[];
}

const MONOID = new Set(['_sum', '_count', '_min', '_max', '_avg']);
const INVERTIBLE = new Set(['_sum', '_count', '_avg']);

const operandAccessors = new Map<string, (row: unknown) => unknown>();
function getOperand(row: Row, path: string): unknown {
  let accessor = operandAccessors.get(path);
  if (accessor === undefined) {
    accessor = compileAccessor(path);
    operandAccessors.set(path, accessor);
  }
  return accessor(row);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The single operand of a monoid fold, or `undefined` for a non-monoid shape. */
function foldOperand(fold: Fold): unknown {
  if ('_count' in fold) return fold._count;
  if ('_sum' in fold) return fold._sum;
  if ('_avg' in fold) return fold._avg;
  if ('_min' in fold) return fold._min;
  if ('_max' in fold) return fold._max;
  return undefined;
}

interface FoldState {
  sum: number;
  count: number;
  min: unknown;
  max: unknown;
  seen: boolean;
}

/** Fold one row into a fold's running state with a Z-set weight (+1 insert / -1 retract). */
function foldStep(state: FoldState, fold: Fold, row: Row, weight: number): void {
  const val = (operand: unknown): unknown => (typeof operand === 'string' ? getOperand(row, operand) : undefined);
  if ('_count' in fold) {
    if (fold._count === true) {
      state.count += weight;
    } else {
      const v = val(fold._count);
      if (v !== null && v !== undefined) state.count += weight;
    }
    state.seen = state.seen || weight > 0;
    return;
  }
  if ('_sum' in fold) {
    state.sum += weight * num(val(fold._sum));
    state.seen = true;
  } else if ('_avg' in fold) {
    state.sum += weight * num(val(fold._avg));
    state.count += weight;
    state.seen = true;
  } else if ('_min' in fold) {
    const v = val(fold._min);
    if (v !== null && v !== undefined && (!state.seen || _.compareOrder(v, state.min) < 0)) state.min = v;
    state.seen = true;
  } else if ('_max' in fold) {
    const v = val(fold._max);
    if (v !== null && v !== undefined && (!state.seen || _.compareOrder(v, state.max) > 0)) state.max = v;
    state.seen = true;
  }
}

interface AggItem {
  name: string;
  fold: Fold;
}

interface GroupState {
  record: Row;
  weight: number;
  states: Map<string, FoldState>;
}

/** Maintains a grouped monoid result from a Z-set of source rows. */
class IncrementalGrouped {
  readonly keyPaths: string[];
  readonly aggs: AggItem[];
  readonly invertible: boolean;
  /** The multiset of source rows behind the accumulators (a Z-set): insert +1, remove -1. */
  private readonly rows: ZSet = new Map();
  private readonly groups = new Map<string, GroupState>();

  constructor(keyPaths: string[], aggs: AggItem[], invertible: boolean) {
    this.keyPaths = keyPaths;
    this.aggs = aggs;
    this.invertible = invertible;
  }

  /** The number of source rows currently folded in (with multiplicity). */
  get rowCount(): number {
    return zsetTotal(this.rows);
  }

  applyRow(row: Row, weight: number): void {
    if (weight === 0) return;
    zsetAdd(this.rows, JSON.stringify(row), weight);
    const keyVals = this.keyPaths.map((p) => getOperand(row, p));
    const key = JSON.stringify(keyVals);
    let group = this.groups.get(key);
    if (group === undefined) {
      if (weight < 0) return; // retracting from an absent group contributes nothing
      const record: Row = {};
      this.keyPaths.forEach((p, idx) => {
        record[p] = keyVals[idx];
      });
      group = { record, weight: 0, states: new Map() };
      this.groups.set(key, group);
    }
    group.weight += weight;
    for (const agg of this.aggs) {
      let state = group.states.get(agg.name);
      if (state === undefined) {
        state = { sum: 0, count: 0, min: undefined, max: undefined, seen: false };
        group.states.set(agg.name, state);
      }
      foldStep(state, agg.fold, row, weight);
    }
    if (group.weight === 0) this.groups.delete(key);
  }

  records(): Row[] {
    const out: Row[] = [];
    for (const group of this.groups.values()) {
      const rec: Row = { ...group.record };
      for (const agg of this.aggs) {
        const st = group.states.get(agg.name);
        if (st === undefined) continue;
        if ('_avg' in agg.fold) rec[agg.name] = st.count === 0 ? null : st.sum / st.count;
        else if ('_min' in agg.fold) rec[agg.name] = st.seen && st.min !== undefined ? st.min : null;
        else if ('_max' in agg.fold) rec[agg.name] = st.seen && st.max !== undefined ? st.max : null;
        else if ('_count' in agg.fold) rec[agg.name] = st.count;
        else rec[agg.name] = st.sum;
      }
      out.push(rec);
    }
    return out;
  }
}

/** A query is incrementally maintainable iff it is a plain grouped monoid query. */
function incrementalPlan(
  query: QueryExpression
): { keyPaths: string[]; aggs: AggItem[]; invertible: boolean } | undefined {
  if (query.keep !== undefined || query.qualify !== undefined || query.select !== undefined || query.group_by === undefined) {
    return undefined;
  }
  const keyPaths: string[] = [];
  const aggs: AggItem[] = [];
  let invertible = true;
  for (const item of query.group_by) {
    if (typeof item === 'string') {
      keyPaths.push(item);
      continue;
    }
    if ('_bucket' in item) return undefined; // a bucket key recomputes, never incremental
    const { name, aggregate } = item;
    if (name === undefined || aggregate === undefined || !isFold(aggregate)) return undefined;
    if (aggregate._window !== undefined || aggregate._filter !== undefined) return undefined;
    const kind = Object.keys(aggregate).find((k) => k.startsWith('_') && MONOID.has(k));
    if (kind === undefined) return undefined;
    const operand = foldOperand(aggregate);
    if (operand !== true && typeof operand !== 'string') return undefined;
    if (!INVERTIBLE.has(kind)) invertible = false;
    aggs.push({ name, fold: aggregate });
  }
  return { keyPaths, aggs, invertible };
}

/** Per-source index configuration: a source with a config gets a maintained IndexStore. */
export interface DataViewOptions {
  indexes?: Record<string, IndexField[]>;
}

/** A multi-source, incrementally-maintained view over named datasets. */
export class DataView {
  private readonly sources = new Map<string, Row[]>();
  private readonly caches = new Map<string, Map<string, IncrementalGrouped>>();
  private readonly indexStores = new Map<string, IndexStore>();

  constructor(sources: DataSource[], options?: DataViewOptions) {
    for (const source of sources) {
      this.sources.set(source.name, [...source.data]);
      const config = options?.indexes?.[source.name];
      if (config !== undefined) {
        const store = new IndexStore(config);
        for (const row of source.data) store.add(row);
        this.indexStores.set(source.name, store);
      }
    }
  }

  insert(name: string, row: Row): void {
    this.require(name).push(row);
    this.indexStores.get(name)?.add(row);
    this.onInsert(name, row);
  }

  append(name: string, rows: Row[]): void {
    const data = this.require(name);
    for (const row of rows) {
      data.push(row);
      this.indexStores.get(name)?.add(row);
      this.onInsert(name, row);
    }
  }

  /** Retract one row equal to `row` (a Z-set `-1`). Non-invertible caches recompute. */
  remove(name: string, row: Row): void {
    const data = this.require(name);
    const idx = data.findIndex((r) => _.isEqual(r, row));
    if (idx < 0) throw new QueryModelError('remove: no matching row in the source');
    data.splice(idx, 1);
    this.indexStores.get(name)?.remove(row);
    const byPlan = this.caches.get(name);
    if (byPlan === undefined) return;
    for (const [planKey, cache] of byPlan) {
      if (cache.invertible) cache.applyRow(row, -1);
      else byPlan.delete(planKey);
    }
  }

  get(name: string): Row[] {
    return [...this.require(name)]; // a copy — a caller must not mutate the array behind the cache
  }

  /** Execute `query` against its `source` (or the sole dataset), incrementally where possible. */
  query(query: QueryExpression): Row[] {
    const resolved = query.source ?? this.singleName();
    const rows = this.require(resolved);
    const ctx: EvalCtx = { sourceRows: rows, sources: this.sources, memo: new Map() };

    const plan = incrementalPlan(query);
    if (
      plan !== undefined &&
      query.where === undefined &&
      query.order_by === undefined &&
      query.distinct_on === undefined &&
      query.offset === undefined &&
      query.limit === undefined
    ) {
      let byPlan = this.caches.get(resolved);
      if (byPlan === undefined) {
        byPlan = new Map();
        this.caches.set(resolved, byPlan);
      }
      // Key on the FULL canonical plan — the group_by carries each agg's name AND
      // its fold (kind + operand), and the key is order-independent, so two queries
      // differing only in group-item ORDER share one cache.
      const cacheKey = planKey(query);
      let cache = byPlan.get(cacheKey);
      if (cache === undefined) {
        cache = new IncrementalGrouped(plan.keyPaths, plan.aggs, plan.invertible);
        for (const row of rows) cache.applyRow(row, 1);
        byPlan.set(cacheKey, cache);
      }
      return cache.records();
    }

    // Plan the access path (index narrowing from the PRE predicate only) and execute.
    const indexFor = (s: string): IndexStore | undefined => this.indexStores.get(s);
    const physical = planQuery(query, { indexFor, defaultSource: resolved });
    return executePlanned(physical, rows, ctx, indexFor, resolved);
  }

  private onInsert(name: string, row: Row): void {
    const byPlan = this.caches.get(name);
    if (byPlan === undefined) return;
    for (const cache of byPlan.values()) cache.applyRow(row, 1);
  }

  private require(name: string): Row[] {
    const data = this.sources.get(name);
    if (data === undefined) throw new QueryModelError(`unknown source '${name}'`);
    return data;
  }

  private singleName(): string {
    if (this.sources.size === 1) {
      const name = [...this.sources.keys()][0];
      if (name !== undefined) return name;
    }
    throw new QueryModelError('a query needs a `source` when the DataView has more than one dataset');
  }
}
