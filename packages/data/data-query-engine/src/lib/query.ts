import { Transform as _ } from '@adhd/data-base-transforms';
import {
  AggregateExpression,
  BooleanExpression,
  GroupByExpression,
  OrderByExpression,
  QueryExpression,
} from './expressions';
import { compileWhere, parseOrderBy } from './parser';
import {
  compileAccessor,
  compilePath,
  projectRefs,
  uniqueByPaths,
} from './path';
import {
  CompiledGrouping,
  GroupingSpec,
  compileGrouping,
  runGrouping,
} from './aggregate';
import { QueryValidationError } from './errors';
import { QueryModelError } from './model/errors';
import { executePlanned, execute, type EvalCtx } from './model/execute';
import { planQuery } from './model/plan';
import { planKey } from './model/canonical';
import { IndexStore, type IndexField } from './model/indexing';
import { IncrementalGrouped, incrementalPlan } from './model/incremental';
import { isLegacyQuery, normalizeQuery, type NormalizedQuery } from './normalize';
import type { QueryExpression as CanonicalQueryExpression, Row } from './model/types';

export const orderBy =
  (props: OrderByExpression[] = []) => {
    // Parse ONCE per query, not once per comparison. `parseOrderBy` is pure in
    // `props`, so hoisting it out of the returned comparator is behaviour-
    // preserving — but it removes a full spec re-parse from every one of the
    // ~n·log n pairwise comparisons a sort makes (defect 73f35930).
    // Compile each order key ONCE, alongside `parseOrderBy`. The accessor is the
    // unified exact-name-first/path-fallback resolver, so `order_by` sees the SAME
    // field value as `where`/`having`/`aggregate` — including a grouped output key
    // stored FLAT under its raw path name (`'a.b'`).
    const orderOps = parseOrderBy(props).map((op) => ({
      ...op,
      get: compileAccessor(op.key),
    }));
    // Skip-when-unnecessary (defect 24948077). An absent or empty `order_by`
    // yields zero order operations, and the comparator built below would then
    // fall straight through its empty loop to `return 0` — a comparator that can
    // never reorder anything, yet is truthy, so the execute path's
    // `if (this.query.order_by)` guard would run a full O(n·log n) no-op sort on
    // EVERY query. Returning `undefined` here makes that guard genuinely skip the
    // sort. A query WITH an ordering gets the byte-identical comparator as before.
    if (orderOps.length === 0) return undefined;
    return (a: unknown, b: unknown) => {
      // console.log({orderOps})
      for (const p in orderOps) {
        const { dir, nulls, get } = orderOps[p];
        const cmp = dir === 'asc' ? _.defaultSort : _.reverseSort;
        const x = get(a);
        const y = get(b);
        // console.log("order by", {x, y, key, dir, nulls })
        // TODO: doesnt look like multiple sort works
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
  // `compileWhere()` returns exactly `(obj: Record<string, unknown>) => boolean`.
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number;
  distinct_on?: string[];
  offset?: number;
  limit?: number;
  grouping?: CompiledGrouping;
  select?: string[];
};

// TODO: Need to separate Query interface from QueryType
//   Currently the functional interface and the raw type are mixed
// These fields were widened to `unknown` by the any->unknown sweep, which made the
// class violate the `QueryType` contract it declares (TS2416 on order_by /
// distinct_on / limit). Restore the interface's own types — the class is the
// implementation of that contract, not a looser one.
export class Query implements QueryType {
  raw: QueryExpression;
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number;
  distinct_on?: string[];
  offset = 0;
  limit?: number;
  grouping?: CompiledGrouping;
  select?: string[];
  private _groupingRaw: GroupingSpec | null = null;
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
      this.setGrouping(query),
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

  setGrouping = (query: QueryExpression = {}) => {
    const next: GroupingSpec = {
      group_by: query.group_by as GroupByExpression | undefined,
      aggregate: query.aggregate as AggregateExpression | undefined,
      having: query.having,
      window: query.window,
      output: query.output,
      top_n: query.top_n,
    };
    if (_.isEqual(next, this._groupingRaw)) return false;
    this._groupingRaw = next;
    this.raw.group_by = query.group_by;
    this.raw.aggregate = query.aggregate;
    this.raw.having = query.having;
    this.raw.window = query.window;
    this.raw.output = query.output;
    this.raw.top_n = query.top_n;
    const hasSurface =
      query.group_by !== undefined || query.aggregate !== undefined;
    if (
      !hasSurface &&
      (query.having !== undefined ||
        query.window !== undefined ||
        query.top_n !== undefined)
    ) {
      throw new QueryValidationError(
        'having/window/top_n require group_by or aggregate on the query'
      );
    }
    this.grouping = hasSurface ? compileGrouping(next) : undefined;
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

/** A named dataset the merged `DataView` can hold. */
export interface DataSource {
  name: string;
  data: Row[];
}

/** Per-source index configuration: a source with a config gets a maintained IndexStore. */
export interface DataViewOptions {
  indexes?: Record<string, IndexField[]>;
}

/**
 * The `DataView.query` surface. It is BOTH callable — `dv.query(q)` runs the v2
 * executor against the named source — AND carries the compiled `Query` fields
 * (`dv.query.order_by`, …), so the v1 fluent surface and the v2 callable surface
 * are the SAME property on the SAME class.
 */
export type CallableQuery = ((q?: QueryExpression) => Row[]) & Query;

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
 * The ONE `DataView`: the shipped v1 fluent view with the v2 query features
 * folded in. A single class, a single grammar (`QueryExpression`), a single
 * execution entry. v1-spelled queries run the shipped pipeline unchanged;
 * v2-spelled queries are normalized (`normalizeQuery`) and run by the reference
 * executor. Multi-source (`[{name,data}]`) + named writes (`insert`/`append`/
 * `remove`/`get`) and the incremental grouped cache live here too.
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

  private readonly _query: Query;
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
    this._query = new Query();
    this.query = this._callable();
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

  private _callable = (): CallableQuery => {
    const fn = ((q?: QueryExpression): Row[] => this.runQuery(q ?? this._raw)) as CallableQuery;
    return Object.assign(fn, this._query);
  };

  private applyQuery = (query: QueryExpression): void => {
    this._raw = { ...query };
    // The shipped v1 compiler runs eagerly for a v1-spelled query so its
    // compile-time validation (unknown operator / aggregate / having field)
    // fires at construction — SPEC AC-6 / AC-15. A canonical query is validated
    // by the v2 executor instead.
    if (isLegacyQuery(query)) this._query.setQuery(query);
    this.dirty = true;
    this.query = this._callable();
    this.commit();
  };

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

  private _sync = (): this => {
    this.dirty = true;
    this.query = this._callable();
    return this;
  };

  // SELECT is a PURE FINAL projection (see `commit`): it runs after the whole
  // tail, so it is a builder method like any other — no separate phase slot.
  select = (selectQuery: QueryExpression['select']) => {
    this._query.setSelect(selectQuery);
    this._raw.select = selectQuery;
    return this._sync();
  };

  where = (whereQuery: QueryExpression['where']) => {
    this._query.setWhere(whereQuery);
    this._raw.where = whereQuery;
    return this._sync();
  };

  orderBy = (orderByQuery: QueryExpression['order_by']) => {
    this._query.setOrderBy(orderByQuery);
    this._raw.order_by = orderByQuery;
    return this._sync();
  };

  /* TODO: currently doesnt do deep distinct */
  distinctOn = (distinctOnQuery: QueryExpression['distinct_on']) => {
    this._query.setDistinctOn(distinctOnQuery);
    this._raw.distinct_on = distinctOnQuery;
    return this._sync();
  };

  offset = (offset: QueryExpression['offset']) => {
    this._query.setOffset(offset);
    this._raw.offset = offset;
    return this._sync();
  };

  limit = (limit?: QueryExpression['limit']) => {
    this._query.setLimit(limit);
    this._raw.limit = limit;
    return this._sync();
  };

  // ── v2 builders (canonical clauses) ──────────────────────────────────────
  groupBy = (groupBy: QueryExpression['group_by']) => {
    this._raw.group_by = groupBy;
    return this._sync();
  };

  qualify = (qualify: QueryExpression['qualify']) => {
    this._raw.qualify = qualify;
    return this._sync();
  };

  keep = (keep: QueryExpression['keep']) => {
    this._raw.keep = keep;
    return this._sync();
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
    if (byPlan === undefined) {
      this.dirty = true;
      return;
    }
    for (const [key, cache] of byPlan) {
      if (cache.invertible) cache.applyRow(row as unknown as Row, -1);
      else byPlan.delete(key);
    }
    this.dirty = true;
  };

  // A named source is a raw `Row` dataset (the v2 surface is schema-agnostic and
  // independent of the single-source `T`); returns a copy so a caller cannot
  // mutate the array behind the incremental cache.
  get = (name: string): Row[] => {
    return [...this.require(name)];
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

    const canonical = query as unknown as CanonicalQueryExpression;
    const plan = incrementalPlan(canonical);
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
      const cacheKey = planKey(canonical);
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
    const physical = planQuery(canonical, { indexFor, defaultSource: resolved });
    return executePlanned(physical, rows, ctx, indexFor, resolved);
  };

  commit = (): boolean => {
    if (!this.dirty || !this.data) return false;
    if (isLegacyQuery(this._raw)) return this.commitLegacy();
    const normalized = normalizeQuery(this._raw);
    if (normalized.legacyGrouping) return this.commitLegacy();
    return this.commitCanonical(normalized);
  };

  /** The shipped v1 pipeline, unchanged: where -> group -> tail -> final select. */
  private commitLegacy = (): boolean => {
    if (!this.dirty || !this.data) return false;
    let res = [...this.data];
    this.metrics.total = res.length;
    // `compileWhere()` and `uniqueBy()` are typed for `Record<string, unknown>`,
    // while `DataView` stays generic over `T` for its callers. Constraining
    // `T extends Record<string, unknown>` would break every consumer that passes an
    // interface (interfaces have no index signature), so narrow at these two
    // boundaries instead. Rows ARE records at runtime — that is the engine's premise.
    if (this._query.where)
      res = res.filter(this._query.where as unknown as (row: T) => boolean);
    this.metrics.total_matched = res.length;
    // Phases 2-6 (GROUP -> AGGREGATE -> HAVING -> TOP_N -> OUTPUT) are inserted
    // here, between the per-row WHERE phase and the tail (order_by -> distinct_on
    // -> offset -> limit), which then runs on the grouped result unchanged.
    if (this._query.grouping) {
      const grouped = runGrouping(
        res as unknown as Record<string, unknown>[],
        this._query.grouping
      );
      this.metrics.total_groups = grouped.groups.length;
      res = grouped.tail as unknown as T[];
    }
    if (this._query.order_by) res = res.sort(this._query.order_by);
    if (this._query.distinct_on)
      res = uniqueByPaths(
        res as unknown as Record<string, unknown>[],
        this._query.distinct_on
      ) as unknown as T[];
    this.metrics.total_distinct = res.length;
    if (this._query.offset) res = res.slice(this._query.offset);
    if (this._query.limit) {
      const preSliceLength = res.length;
      res = res.slice(0, this._query.limit);
      this.has_more = preSliceLength > this._query.limit;
    }
    // SELECT — the FINAL phase, after the entire tail. `order_by`, `distinct_on`
    // and `limit` may reference fields that are NOT selected (the SQL rule).
    if (this._query.select) {
      const accessors = this._query.select.map((ref) => ({
        ref,
        compiled: compilePath(ref),
      }));
      res = res.map((row) =>
        projectRefs(row as Record<string, unknown>, accessors)
      ) as unknown as T[];
    }
    this.dataview = res;
    this.dirty = false;
    return true;
  };

  /** The canonical (v2) path: normalize the deprecated aliases, then execute. */
  private commitCanonical = (query: NormalizedQuery): boolean => {
    const rows = this.data as unknown as Row[];
    const ctx: EvalCtx = {
      sourceRows: rows,
      sources: new Map([[this._dataName, rows]]),
      memo: new Map(),
    };
    const res = execute(query, rows, ctx);
    this.metrics.total = rows.length;
    this.metrics.total_matched = res.length;
    this.dataview = res as unknown as T[];
    this.dirty = false;
    this.has_more = false;
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
