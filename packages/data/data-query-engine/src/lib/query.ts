import { Transform as _ } from '@adhd/data-base-transforms';
import {
  BooleanExpression,
  type GroupItem,
  OrderByExpression,
  Predicate,
  QueryExpression,
} from './expressions';
import { compileWhere, parseOrderBy } from './parser';
import { compileAccessor } from './path';
import { QueryModelError } from './model/errors';
import { executePlanned, execute, type EvalCtx } from './model/execute';
import { planQuery } from './model/plan';
import { planKey } from './model/canonical';
import { IndexStore, type IndexField } from './model/indexing';
import { IncrementalGrouped, incrementalPlan } from './model/incremental';
import type { Row } from './expressions';

/**
 * Build the order comparator for a set of `order_by` keys. Kept as a standalone
 * helper (and exported) so callers can reuse it; the v2 executor orders through
 * `compareMulti` internally.
 */
export const orderBy =
  (props: OrderByExpression[] = []) => {
    const orderOps = parseOrderBy(props).map((op) => ({
      ...op,
      get: compileAccessor(op.key),
    }));
    if (orderOps.length === 0) return undefined;
    return (a: unknown, b: unknown) => {
      for (const p in orderOps) {
        const { dir, nulls, get } = orderOps[p];
        const cmp = dir === 'asc' ? _.defaultSort : _.reverseSort;
        const x = get(a);
        const y = get(b);
        if (x !== y) {
          if (nulls && !_.isDefined(x)) {
            return nulls === 'last' ? 1 : -1;
          } else if (nulls && !_.isDefined(y)) {
            return nulls === 'last' ? -1 : 1;
          }
          return cmp(x, y);
        }
      }
      return 0;
    };
  };

type QueryType = {
  raw?: QueryExpression;
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number;
  distinct_on?: string[];
  offset?: number;
  limit?: number;
  select?: string[];
};

/**
 * The compiled-query object. In the one-grammar engine the executor works over
 * the raw `QueryExpression`, so this class is a small, self-contained helper kept
 * on the package surface.
 */
export class Query implements QueryType {
  raw: QueryExpression;
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number;
  distinct_on?: string[];
  offset = 0;
  limit?: number;
  select?: string[];
  constructor(_query: QueryExpression = {}) {
    this.raw = {};
    this.setQuery(_query);
  }

  setQuery = (query: QueryExpression = {}) => {
    const ops = [
      this.setWhere(query.where),
      this.setOrderBy(query.order_by),
      this.setDistinctOn(query.distinct_on),
      this.setOffset(query.offset),
      this.setLimit(query.limit),
      this.setSelect(query.select),
    ];
    return ops.some(_.isTrue);
  };

  setSelect = (selectQuery: QueryExpression['select']) => {
    if (_.isEqual(selectQuery, this.raw.select)) return false;
    this.raw.select = selectQuery;
    this.select = selectQuery as string[] | undefined;
    return true;
  };

  setWhere = (whereQuery: QueryExpression['where'] = {}) => {
    if (_.isEqual(whereQuery, this.raw.where)) return false;
    this.raw.where = whereQuery;
    this.where = compileWhere(whereQuery as BooleanExpression);
    return true;
  };

  setOrderBy = (orderByQuery: QueryExpression['order_by'] = []) => {
    if (_.isEqual(orderByQuery, this.raw.order_by)) return false;
    this.raw.order_by = orderByQuery;
    this.order_by = orderBy(orderByQuery);
    return true;
  };

  setDistinctOn = (distinctOnQuery: QueryExpression['distinct_on']) => {
    if (_.isEqual(distinctOnQuery, this.raw.distinct_on)) return false;
    this.raw.distinct_on = distinctOnQuery;
    this.distinct_on = distinctOnQuery;
    return true;
  };

  setOffset = (offsetQuery: QueryExpression['offset'] = 0) => {
    if (_.isEqual(offsetQuery, this.raw.offset)) return false;
    this.raw.offset = offsetQuery;
    this.offset = offsetQuery;
    return true;
  };

  setLimit = (limitQuery?: QueryExpression['limit']) => {
    if (_.isEqual(limitQuery, this.raw.limit)) return false;
    this.raw.limit = limitQuery;
    this.limit = limitQuery;
    return true;
  };

  toJson() {
    return this.raw;
  }
}

/** A named dataset the `DataView` can hold. */
export interface DataSource {
  name: string;
  data: Row[];
}

/** Per-source index configuration: a source with a config gets a maintained IndexStore. */
export interface DataViewOptions {
  indexes?: Record<string, IndexField[]>;
}

/** The callable `DataView.query` surface: run a query against a named source. */
export type CallableQuery = (q?: QueryExpression) => Row[];

/** Arg1 is a source list iff it is non-empty, every element is `{name, data}`, and arg2 is absent or options. */
function isSourceList(arg1: unknown, arg2: unknown): boolean {
  if (!Array.isArray(arg1) || arg1.length === 0) return false;
  const everySource = arg1.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as { name?: unknown }).name === 'string' &&
      Array.isArray((e as { data?: unknown }).data)
  );
  if (!everySource) return false;
  if (arg2 === undefined || arg2 === null) return true;
  return typeof arg2 === 'object' && 'indexes' in (arg2 as object);
}

/**
 * An empty / non-array `order_by` is no ordering (it is the same query as an
 * absent `order_by`, and must not trigger a no-op sort).
 */
function normalizeOrderBy(orderByValue: QueryExpression['order_by']): OrderByExpression[] | undefined {
  return Array.isArray(orderByValue) && orderByValue.length > 0 ? orderByValue : undefined;
}

/**
 * The ONE `DataView`: the v2 self-similar grammar, ONE executor entry
 * (`commit()` -> the reference `execute`), a multi-source named-dataset surface
 * with writes, and an incremental grouped cache for append/retract.
 */
export class DataView<T = unknown> {
  data: T[] = [];
  dataview: T[] = [];
  query: CallableQuery;
  dirty = false;
  logging: boolean;
  has_more = false;
  metrics = {
    total: 0,
    total_matched: 0,
    total_distinct: 0,
    total_groups: 0,
  };
  static Query: typeof Query;

  private _raw: QueryExpression = {};
  private readonly sources = new Map<string, Row[]>();
  private readonly caches = new Map<string, Map<string, IncrementalGrouped>>();
  private readonly indexStores = new Map<string, IndexStore>();
  private _dataName = 'data';

  // The sources overload is listed FIRST so `new DataView([{ name, data }])`
  // binds to it (T stays the class default) rather than inferring T from the
  // source-entry objects — which would make `insert`/`append` reject data rows.
  constructor(sources: DataSource[], options?: DataViewOptions);
  constructor(data: T[]);
  constructor(data: T[], query?: QueryExpression, logging?: boolean);
  constructor(
    dataOrSources: T[] | DataSource[] = [],
    queryOrOptions?: QueryExpression | DataViewOptions,
    logging = false
  ) {
    this.logging = logging;
    this.query = (q?: QueryExpression) => this.runQuery(q ?? this._raw);
    if (isSourceList(dataOrSources, queryOrOptions)) {
      this._initSources(
        dataOrSources as DataSource[],
        queryOrOptions as DataViewOptions | undefined
      );
    } else {
      this._initSingle(
        dataOrSources as T[],
        queryOrOptions as QueryExpression | undefined
      );
    }
  }

  private _initSingle(data: T[], query: QueryExpression | undefined): void {
    this._dataName = 'data';
    this.data = data;
    this.sources.set('data', data as unknown as Row[]);
    this.dirty = true;
    this.applyQuery(query ?? {});
  }

  private _initSources(sources: DataSource[], options: DataViewOptions | undefined): void {
    for (const source of sources) {
      this.sources.set(source.name, [...source.data]);
      const config = options?.indexes?.[source.name];
      if (config !== undefined) {
        const store = new IndexStore(config);
        for (const row of source.data) store.add(row);
        this.indexStores.set(source.name, store);
      }
    }
    this.data = (this.sources.get(this._dataName) ??
      [...this.sources.values()][0] ??
      []) as unknown as T[];
    this.dataview = this.data;
    this._raw = {};
    this.dirty = false;
  }

  private applyQuery(query: QueryExpression): void {
    const next: QueryExpression = { ...query };
    if (next.order_by !== undefined) next.order_by = normalizeOrderBy(next.order_by);
    this._raw = next;
    this.dirty = true;
    this.commit();
  }

  setData = (data: T[]) => {
    this.data = data;
    this.sources.set(this._dataName, data as unknown as Row[]);
    this.dirty = true;
    return this;
  };

  setQuery = (query: QueryExpression = {}) => {
    this.applyQuery(query);
    return this;
  };

  // ── builders (v2 grammar) ────────────────────────────────────────────────
  select = (selectQuery: QueryExpression['select']) => {
    this._raw.select = selectQuery;
    this.dirty = true;
    return this;
  };

  where = (whereQuery: QueryExpression['where']) => {
    this._raw.where = whereQuery as Predicate;
    this.dirty = true;
    return this;
  };

  orderBy = (orderByQuery: QueryExpression['order_by']) => {
    this._raw.order_by = normalizeOrderBy(orderByQuery);
    this.dirty = true;
    return this;
  };

  distinctOn = (distinctOnQuery: QueryExpression['distinct_on']) => {
    this._raw.distinct_on = distinctOnQuery;
    this.dirty = true;
    return this;
  };

  offset = (offset: QueryExpression['offset']) => {
    this._raw.offset = offset;
    this.dirty = true;
    return this;
  };

  limit = (limit?: QueryExpression['limit']) => {
    this._raw.limit = limit;
    this.dirty = true;
    return this;
  };

  groupBy = (groupBy: QueryExpression['group_by']) => {
    this._raw.group_by = groupBy;
    this.dirty = true;
    return this;
  };

  qualify = (qualify: QueryExpression['qualify']) => {
    this._raw.qualify = qualify;
    this.dirty = true;
    return this;
  };

  keep = (keep: QueryExpression['keep']) => {
    this._raw.keep = keep;
    this.dirty = true;
    return this;
  };

  // The `source` / `name` / `aggregate` slots complete the fluent surface — every
  // `QueryExpression` slot now has a fluent equivalent.
  from = (source: string) => {
    this._raw.source = source;
    this.dirty = true;
    return this;
  };

  as = (name: string) => {
    this._raw.name = name;
    this.dirty = true;
    return this;
  };

  aggregate = (expr: QueryExpression['aggregate']) => {
    this._raw.aggregate = expr;
    this.dirty = true;
    return this;
  };

  // ── grouping sets, expressed as `select` relations ───────────────────────
  /**
   * ROLLUP: the hierarchical grouping sets over `dims` — the full set, then the
   * set with the trailing dimension dropped, …, then the empty (grand-total)
   * set. Each set becomes a relation-valued `select` item named for its key set
   * (`'region_product'`, `'region'`, `'total'`); the parent has no `group_by`,
   * so each relation aggregates the whole dataset.
   */
  rollup = (...dims: string[]) => {
    const sets: string[][] = [];
    for (let i = dims.length; i >= 0; i--) sets.push(dims.slice(0, i));
    this.applyGroupingSets(sets);
    return this;
  };

  /**
   * CUBE: EVERY subset of `dims` (including the empty set) as its own relation,
   * ordered by descending set size (ties in dimension order).
   */
  cube = (...dims: string[]) => {
    const n = dims.length;
    const scored: { set: string[]; mask: number }[] = [];
    for (let mask = 0; mask < 1 << n; mask++) {
      const set: string[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(dims[i]);
      scored.push({ set, mask });
    }
    scored.sort((a, b) => b.set.length - a.set.length || a.mask - b.mask);
    this.applyGroupingSets(scored.map((s) => s.set));
    return this;
  };

  /**
   * The aggregate items that seed every grouping set — the `{ name, aggregate }`
   * items already placed on `group_by`, or a `_count` default when there are
   * none. Dimension keys on `group_by` are ignored (the dimensions come from the
   * verb's own arguments).
   */
  private aggregateItems = (): GroupItem[] => {
    const items = this._raw.group_by ?? [];
    const aggs = items.filter(
      (item): item is QueryExpression =>
        typeof item === 'object' && item !== null && 'name' in item && 'aggregate' in item
    );
    return aggs.length > 0 ? aggs : [{ name: 'count', aggregate: { _count: true } }];
  };

  private applyGroupingSets = (sets: string[][]): void => {
    const aggs = this.aggregateItems();
    this._raw.group_by = undefined;
    this._raw.select = sets.map((set) => ({
      name: set.length === 0 ? 'total' : set.join('_'),
      group_by: [...set, ...aggs],
    }));
    this.dirty = true;
  };

  // ── multi-source reads / writes ──────────────────────────────────────────
  insert = (name: string, row: T): void => {
    const data = this.require(name);
    data.push(row as unknown as Row);
    this.indexStores.get(name)?.add(row as unknown as Row);
    this.onInsert(name, row as unknown as Row);
    this.dirty = true;
  };

  append = (name: string, rows: T[]): void => {
    const data = this.require(name);
    for (const row of rows) {
      data.push(row as unknown as Row);
      this.indexStores.get(name)?.add(row as unknown as Row);
      this.onInsert(name, row as unknown as Row);
    }
    this.dirty = true;
  };

  /** Retract one row equal to `row` (a Z-set `-1`). Non-invertible caches recompute. */
  remove = (name: string, row: T): void => {
    const data = this.require(name);
    const idx = data.findIndex((r) => _.isEqual(r, row));
    if (idx < 0) throw new QueryModelError('remove: no matching row in the source');
    data.splice(idx, 1);
    this.indexStores.get(name)?.remove(row as unknown as Row);
    const byPlan = this.caches.get(name);
    if (byPlan !== undefined) {
      for (const [key, cache] of byPlan) {
        if (cache.invertible) cache.applyRow(row as unknown as Row, -1);
        else byPlan.delete(key);
      }
    }
    this.dirty = true;
  };

  get = (name: string): Row[] => {
    return [...this.require(name)]; // a copy — a caller must not mutate the source array
  };

  private onInsert = (name: string, row: Row): void => {
    const byPlan = this.caches.get(name);
    if (byPlan === undefined) return;
    for (const cache of byPlan.values()) cache.applyRow(row, 1);
  };

  private require = (name: string): Row[] => {
    const data = this.sources.get(name);
    if (data === undefined) throw new QueryModelError(`unknown source '${name}'`);
    return data;
  };

  private singleName = (): string => {
    if (this.sources.size === 1) {
      const name = [...this.sources.keys()][0];
      if (name !== undefined) return name;
    }
    throw new QueryModelError('a query needs a `source` when the DataView has more than one dataset');
  };

  /** Execute a query against its `source` (or the sole dataset), incrementally where possible. */
  private runQuery = (query: QueryExpression): Row[] => {
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
  };

  /** The ONE execution entry: run the v2 grammar over the current data. */
  commit = (): boolean => {
    if (!this.dirty || !this.data) return false;
    const rows = this.data as unknown as Row[];
    const ctx: EvalCtx = {
      sourceRows: rows,
      sources: new Map([[this._dataName, rows]]),
      memo: new Map(),
    };
    this.metrics.total = rows.length;
    const limit = this._raw.limit;
    if (limit !== undefined) {
      const { limit: _drop, ...unlimited } = this._raw;
      const preLimit = execute(unlimited, rows, ctx).length;
      this.dataview = execute(this._raw, rows, ctx) as unknown as T[];
      this.has_more = preLimit > limit;
    } else {
      this.dataview = execute(this._raw, rows, ctx) as unknown as T[];
      this.has_more = false;
    }
    this.metrics.total_matched = this.dataview.length;
    this.metrics.total_distinct = this.dataview.length;
    this.dirty = false;
    return true;
  };

  view = (): T[] => {
    this.commit();
    return this.dataview ? this.dataview : this.data;
  };

  toJson() {
    return this._raw;
  }
}

DataView.Query = Query;

export default DataView;
