import _ from '@adhd/transform';
import { OrderByExpression, QueryExpression, QueryExpressionValues } from './expressions';
import { OrderByOperation } from './operators';
import { CallbackFunctionTyped } from 'packages/transform/src/lib/function';
function negate(func: (...args:any[])=> boolean) {
  return (...args: any) => !func(args);
}
const pipe = (...fns: any[]) => (x: any) => fns.reduce((y, f) => f(y), x);
const mapArgs = (fn: (value: any, index: number, array: any[]) => unknown) => (...args: any[]) => args.map(fn);
const map = (fn: CallbackFunctionTyped<any, any>) => (mappable: any[]) => mappable.map(fn);
const partialApply = (fn: ((...args: any[]) => any), ...cache: undefined[]) => (...args: any[]) => {
  const all = cache.concat(args);
  return all.length >= fn.length ? fn(...all) : partialApply(fn, ...all);
};
const applyAll = (fns: any[], obj: any) => fns.flatMap((f: (arg0: any) => any) => f(obj));

// function hasValues(target){
//   return (values) => target.every(v => values.includes(v))
// }
const hasValues = (values: string | any[], target: any[]) => target.every((v: any) => values.includes(v));

const checkHasKey = (key: string, obj: { hasOwnProperty: (arg0: any) => any; }) => _.isObject(obj) && key in obj;
const checkHasValue = (value: any, arr: string | any[]) => arr.includes(value);
const partialHasKey = (key: string) => (obj: any) => checkHasKey(key, obj);
const partialHasValue = (obj: any, value: any) => checkHasValue(value, obj);
const checkSome = (check = _.isTrue, arr: any[]) => arr.some(check);
const checkEvery = (check = _.isTrue, arr: any[]) => arr.every(check);

const some = partialApply(checkSome);
const every = partialApply(checkEvery);

const hasKeysSome = partialApply((targets: any, value: any) =>
  checkSome(partialHasKey(value), targets)
);
const hasKeysEvery = partialApply((targets: any, value: any) =>
  checkEvery(partialHasKey(value), targets)
);

const isEq = _.isEqual;
const isNe = negate(_.isEqual);
const isNeq = negate(_.isEqual);
const isIn = _.isIn;
const isNin = _.isNotIn;
const isGt = _.isGreaterThan;
const isLt = _.isLessThan;
const isGte = _.isGreaterThanOrEqual;
const isLte = _.isLessThanOrEqual;
const isLike = _.isLike;
const isNlike = _.isNotLike;
const isIlike = _.isILike;
const isNilike = _.isNotILike;
const isSimilar = _.isILike;
const isNsimilar = _.isNotILike;
const contains = hasValues;
const isContainedIn = _.isIn;
const hasKey = checkHasKey;
const hasKeysAny = hasKeysSome;
const hasKeysAll = hasKeysEvery;
const isNull = (a: any, b: boolean) => {
  console.log({ a, b });
  return _.isDefined(a) !== b;
};

type Filter = (...args: any) => boolean
type FilterPartial = (...args: any) => Filter

/* SECTION: query filters */
//https://github.com/hasura/graphql-engine/blob/b84db36ebb51acd5b51e1254c103f3097a7c2358/server/src-lib/Hasura/GraphQL/Resolve/BoolExp.hs
const operators: Record<string, FilterPartial> = {
  // _cast: partialApply(isCast),
  _eq: partialApply(isEq),
  _ne: partialApply(isNe),
  _neq: partialApply(isNeq),
  _in: partialApply(isIn),
  _nin: partialApply(isNin),
  _gt: partialApply(isGt),
  _lt: partialApply(isLt),
  _gte: partialApply(isGte),
  _lte: partialApply(isLte),
  _like: partialApply(isLike),
  _nlike: partialApply(isNlike),
  _ilike: partialApply(isIlike),
  _nilike: partialApply(isNilike),
  _similar: partialApply(isSimilar),
  _nsimilar: partialApply(isNsimilar),
  _contains: partialApply(contains),
  _contained_in: partialApply(isContainedIn),
  _has_key: partialApply(hasKey),
  _has_keys_any: partialApply(hasKeysAny),
  _is_null: partialApply(isNull),
  _has_keys_all: partialApply(hasKeysAll),
  _and: (ops, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    // console.log('_and', {ops, path})
    const opList = ops.map((q: any, i: any) => iter(q, [...path]));
    return (obj: any) => {
      const res = applyAll(opList, obj);
      const bool = res.every(_.isTrue);
      if (bool) console.log('_and', bool, res);
      return bool;
    };
  },
  _or: (ops, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    // console.log("_or", { ops, path });
    const opList = ops.map((q: any) => iter(q, [...path]));
    return (obj) => applyAll(opList, obj).some(_.isTrue);
  },
  _not: (op, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    // console.log("_not", { op, path });
    const child = iter(op, [...path]);
    return (obj) => _.isFalse(child(obj));
  },
};

const getPath = partialApply(_.makeGetter);

function makeExpression(exp: string, rhs: unknown, path: string[]) {
  // console.log("makeExpression", {path, rhs, exp});
  const getter = getPath(path);
  const expression = operators[exp];
  return function (obj: any) {
    const lhs = getter(obj, false)();
    const result = expression(lhs, rhs);
    // if(result){
    //   console.log('execute', [
    //     lhs,
    //     exp,
    //     rhs,
    //     result,
    //   ]);
    // }
    return result;
  };
}

function walk(query: QueryExpressionValues = {}, path: string[] = []) {
  if (_.isEmpty(query)) return () => true;
  const keys = Object.entries({ ...query });
  const matchers: (FilterPartial | Filter | boolean)[] = [];

  keys.forEach(([k, value]) => {
    if (k === '_and' || k === '_or' || k === '_not') {
      matchers.push(operators[k](value, path, walk));
    } else if (k in operators) {
      matchers.push(makeExpression(k, value, [...path]));
    } else {
      matchers.push(walk(value, [...path, k]));
    }
  });
  // console.log({matchers});
  // return operators._and(matchers, path, walk)
  return (obj: any) => {
    return applyAll(matchers, obj).every(_.isTrue);
  };
}

function parseOrderBy(query: string | OrderByExpression | OrderByExpression[], paths: string[] = []): OrderByOperation[] {
  // console.log(query, paths);
  if (_.isString(query)) {
    return [{ key: (query as string), dir: 'desc', nulls: 'last' }];
  } else if (_.isArray(query)) {
    return (query as OrderByExpression[]).flatMap((e) => parseOrderBy(e, paths));
  } else if (_.isObject(query)) {
    // Sort object keys to be deterministic
    const entries = Object.entries(query).sort(([k1], [k2]) =>
      _.defaultSort(k1, k2)
    );
    return entries.flatMap(([k, v]) => {
      const key = paths.concat([k]);
      if (_.isString(v)) {
        const [dir, ___, nulls = 'last'] = v.split('_');
        const op: OrderByOperation[] = [{ key: key.join('.'), dir, nulls }];
        // console.log("Object -> val", { op });
        return op;
      } else {
        const op: OrderByOperation[] = parseOrderBy(v, key);
        // console.log("Object -> arr/obj", { op });
        return op;
      }
    });
  }
  return [] as  OrderByOperation[];
}

export const orderBy = (props: OrderByExpression[] = []) => (a: any, b: any) => {
  const orderOps = parseOrderBy(props);
  console.log({orderOps})
  for (const p in orderOps) {
    const { key, dir, nulls } = orderOps[p];
    const cmp = dir === 'asc' ? _.defaultSort : _.reverseSort;
    const x = _.get(a, key);
    const y = _.get(b, key);

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

const EmptyQuery: QueryType = {
  raw: {},
  where: () => true,
  order_by: () => 0,
  distinct_on: undefined,
  offset: undefined,
  limit: undefined,
};

function RawQuery(query: QueryExpression = {}){
  return {
    ...EmptyQuery,
    ...query,
  };
}

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
    this.where = walk(whereQuery);
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

  setLimit = (limitQuery: QueryExpression['limit']) => {
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
  data?: any[];
  dataview: any;
  query: Query;
  dirty: any;
  has_more=false;
  static Query: typeof Query;
  constructor(data: any[], query: QueryExpression = {}) {
    this.query = new Query();
    this.setData(data);
    this.setQuery(query);
  }

  setData = (data: any[]) => {
    this.data = data;
    this.dataview = null;
    this.query = new Query();
  };

  setQuery = (query: QueryExpression) => {
    this.dirty = this.query.setQuery(query);
    this.commit();
    return this;
  };

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

  limit = (limit: QueryExpression['limit']) => {
    const didUpdate = this.query.setLimit(limit);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  commit = () => {
    if (!this.dirty || !this.data) return false;
    let res = this.data;
    if (this.query.where) res = res.filter(this.query.where);
    if (this.query.order_by) res = res.sort(this.query.order_by);
    if (this.query.distinct_on) res = _.uniqueBy(res, this.query.distinct_on);
    if (this.query.offset) res = res.slice(this.query.offset);
    if (this.query.limit) {
      res = res.slice(0, this.query.limit);
      this.has_more = res.length === this.query.limit;
    }
    this.dataview = res;
    this.dirty = false;
    return true;
  };

  view = () => {
    this.commit();
    return this.dataview ? this.dataview : this.data;
  };

  toJson() {
    return this.query.toJson();
  }
}

DataView.Query = Query;

export default DataView;
