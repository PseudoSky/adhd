import { Transform as _ } from '@adhd/data-base-transforms';
import { OrderByExpression, QueryExpression } from './expressions';
import { compileWhere, parseOrderBy } from './parser';
import {
  CompiledGrouping,
  GroupingSpec,
  compileGrouping,
  runGrouping,
} from './aggregate';
import { QueryValidationError } from './errors';

export const orderBy =
  (props: OrderByExpression[] = []) => {
    // Parse ONCE per query, not once per comparison. `parseOrderBy` is pure in
    // `props`, so hoisting it out of the returned comparator is behaviour-
    // preserving — but it removes a full spec re-parse from every one of the
    // ~n·log n pairwise comparisons a sort makes (defect 73f35930).
    const orderOps = parseOrderBy(props);
    return (a: unknown, b: unknown) => {
      // console.log({orderOps})
      for (const p in orderOps) {
        const { key, dir, nulls } = orderOps[p];
        const cmp = dir === 'asc' ? _.defaultSort : _.reverseSort;
        const x = _.get(a, key);
        const y = _.get(b, key);
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
  // The old union also admitted `() => boolean`, which a 1-arg predicate is NOT
  // assignable to ("target signature provides too few arguments", TS2322).
  // No caller ever supplies a 0-arg predicate.
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number; // | string[];
  distinct_on?: string[];
  offset?: number;
  limit?: number;
  grouping?: CompiledGrouping;
};

// const EmptyQuery: QueryType = {
//   raw: {},
//   where: () => true,
//   order_by: () => 0,
//   distinct_on: undefined,
//   offset: undefined,
//   limit: undefined,
// };

// function RawQuery(query: QueryExpression = {}){
//   return {
//     ...EmptyQuery,
//     ...query,
//   };
// }

// TODO: Need to separate Query interface from QueryType
//   Currently the functional interface and the raw type are mixed
// These fields were widened to `unknown` by the any->unknown sweep, which made the
// class violate the `QueryType` contract it declares (TS2416 on order_by /
// distinct_on / limit). Restore the interface's own types — the class is the
// implementation of that contract, not a looser one.
export class Query implements QueryType {
  raw: QueryExpression;
  where?: (obj: Record<string, unknown>) => boolean;
  order_by?: (a: unknown, b: unknown) => number; // | string[]);
  distinct_on?: string[];
  offset = 0;
  limit?: number;
  grouping?: CompiledGrouping;
  private _groupingRaw: GroupingSpec | null = null;
  constructor(_query: QueryExpression = {}) {
    // const query = RawQuery(_query);
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
    ];
    return ops.some(_.isTrue);
  };

  setGrouping = (query: QueryExpression = {}) => {
    const next: GroupingSpec = {
      group_by: query.group_by,
      aggregate: query.aggregate,
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
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    /* @ts-ignore */
    this.raw.where = whereQuery;
    this.where = compileWhere(whereQuery);
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

export class DataView<T = unknown> {
  data: T[] = [];
  dataview: T[] = [];
  query: Query;
  // Assigned in every constructor branch, but only conditionally, so TS's
  // strictPropertyInitialization cannot see it (TS2564). Initialise explicitly;
  // the constructor immediately overwrites it.
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
  constructor(data: T[], query: QueryExpression = {}, logging = false) {
    this.query = new Query();
    this.logging = logging;
    this.setData(data);
    this.setQuery(query);
  }

  setData = (data: T[]) => {
    this.data = data;
    this.dirty = true;
    // this.dataview = null;
    // this.query = new Query();
    return this;
  };

  setQuery = (query: QueryExpression) => {
    const didUpdate = this.query.setQuery(query);
    this.dirty = this.dirty || didUpdate;
    this.commit();
    return this;
  };

  // TODO: add select support
  // select = (selectQuery: QueryExpression['select']) => {...}

  where = (whereQuery: QueryExpression['where']) => {
    const didUpdate = this.query.setWhere(whereQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  orderBy = (orderByQuery: QueryExpression['order_by']) => {
    const didUpdate = this.query.setOrderBy(orderByQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  /* TODO: currently doesnt do deep distinct */
  distinctOn = (distinctOnQuery: QueryExpression['distinct_on']) => {
    const didUpdate = this.query.setDistinctOn(distinctOnQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  offset = (offset: QueryExpression['offset']) => {
    const didUpdate = this.query.setOffset(offset);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  limit = (limit?: QueryExpression['limit']) => {
    const didUpdate = this.query.setLimit(limit);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  commit = () => {
    // console.warn('DataView.commit', { dirty: this.dirty, metrics: this.metrics, query: this.query.toJson() })
    if (!this.dirty || !this.data) return false;
    let res = [...this.data];
    this.metrics.total = res.length;
    // `compileWhere()` and `uniqueBy()` are typed for `Record<string, unknown>`,
    // while `DataView` stays generic over `T` for its callers. Constraining
    // `T extends Record<string, unknown>` would break every consumer that passes an
    // interface (interfaces have no index signature), so narrow at these two
    // boundaries instead. Rows ARE records at runtime — that is the engine's premise.
    if (this.query.where)
      res = res.filter(this.query.where as unknown as (row: T) => boolean);
    this.metrics.total_matched = res.length;
    // Phases 2-6 (GROUP -> AGGREGATE -> HAVING -> TOP_N -> OUTPUT) are inserted
    // here, between the per-row WHERE phase and the tail (order_by -> distinct_on
    // -> offset -> limit), which then runs on the grouped result unchanged. The
    // phase order is fixed by construction: each phase is a distinct, single-valued
    // expression field and there is exactly one slot per field, so "having before
    // group" or "aggregate before where" is unrepresentable.
    if (this.query.grouping) {
      const grouped = runGrouping(
        res as unknown as Record<string, unknown>[],
        this.query.grouping
      );
      this.metrics.total_groups = grouped.groups.length;
      res = grouped.tail as unknown as T[];
    }
    if (this.query.order_by) res = res.sort(this.query.order_by);
    if (this.query.distinct_on)
      res = _.uniqueBy(
        res as unknown as Record<string, unknown>[],
        this.query.distinct_on
      ) as unknown as T[];
    this.metrics.total_distinct = res.length;
    if (this.query.offset) res = res.slice(this.query.offset);
    if (this.query.limit) {
      const preSliceLength = res.length;
      res = res.slice(0, this.query.limit);
      this.has_more = preSliceLength > this.query.limit;
    }
    this.dataview = res;
    this.dirty = false;
    // console.debug('DataView.commit', { dirty: this.dirty, metrics: this.metrics, query: this.query.toJson() })
    return true;
  };

  view = (): T[] => {
    // console.warn('DataView.view', { dirty: this.dirty, metrics: this.metrics, query: this.query.toJson() })
    this.commit();
    return this.dataview ? this.dataview : this.data;
  };

  toJson() {
    return this.query.toJson();
  }
}

DataView.Query = Query;

export default DataView;
