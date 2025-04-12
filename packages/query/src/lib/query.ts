import { Transform as _ } from '@adhd/transform';
import { OrderByExpression, QueryExpression } from './expressions';
import { parseOrderBy, parseWhere } from './parser';

export const orderBy = (props: OrderByExpression[] = []) => (a: any, b: any) => {
  const orderOps = parseOrderBy(props);
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

type QueryType = {
  raw?: QueryExpression;
  where?: (() => boolean) | ((obj: any) => any);
  order_by?: ((a: any, b: any) => number)// | string[];
  distinct_on?: string[];
  offset?: number;
  limit?: number;
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
export class Query implements QueryType {
  raw: QueryExpression;
  where?: (() => boolean) | ((obj: any) => any);
  order_by?: (((a: any, b: any) => any));// | string[]);
  distinct_on: any;
  offset = 0;
  limit: any;
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
    ];
    return ops.some(_.isTrue);
  };

  setWhere = (whereQuery: QueryExpression['where'] = {}) => {
    if (_.isEqual(whereQuery, this.raw.where)) return false;
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    /* @ts-ignore */
    this.raw.where = whereQuery;
    this.where = d => parseWhere(whereQuery, d)
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

export class DataView {
  data: any[] = [];
  dataview: any[] = [];
  query: Query;
  dirty: any;
  logging: boolean;
  has_more = false;
  metrics = {
    total: 0,
    total_matched: 0,
    total_distinct: 0,
  };
  static Query: typeof Query;
  constructor(data: any[], query: QueryExpression = {}, logging = false) {
    this.query = new Query();
    this.logging = logging;
    this.setData(data);
    this.setQuery(query);
  }

  setData = (data: any[]) => {
    this.data = data;
    this.dirty = true;
    // this.dataview = null;
    // this.query = new Query();
    return this;
  };

  setQuery = (query: QueryExpression) => {
    this.dirty = this.query.setQuery(query);
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
    let res = this.data;
    this.metrics.total = res.length;
    if (this.query.where) res = res.filter(this.query.where);
    this.metrics.total_matched = res.length;
    if (this.query.order_by) res = res.sort(this.query.order_by);
    if (this.query.distinct_on) res = _.uniqueBy(res, this.query.distinct_on);
    this.metrics.total_distinct = res.length;
    if (this.query.offset) res = res.slice(this.query.offset);
    if (this.query.limit) {
      res = res.slice(0, this.query.limit);
      this.has_more = res.length === this.query.limit;
    }
    this.dataview = res;
    this.dirty = false;
    // console.debug('DataView.commit', { dirty: this.dirty, metrics: this.metrics, query: this.query.toJson() })
    return true;
  };

  view = () => {
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
