import _ from '@adhd/transform';

function negate(func) {
  return (...args) => !func(args);
}
const pipe = (...fns) => (x) => fns.reduce((y, f) => f(y), x);
const mapArgs = (fn) => (...args) => args.map(fn);
const map = (fn: CallableFunction) => (mappable: any[]) => mappable.map(fn);
const partialApply = (fn, ...cache) => (...args) => {
  const all = cache.concat(args);
  return all.length >= fn.length ? fn(...all) : partialApply(fn, ...all);
};
const applyAll = (fns, obj) => fns.flatMap((f) => f(obj));

// function hasValues(target){
//   return (values) => target.every(v => values.includes(v))
// }
const hasValues = (values, target) => target.every((v) => values.includes(v));

const checkHasKey = (key, obj) => _.isObject(obj) && obj.hasOwnProperty(key);
const checkHasValue = (value, arr) => arr.includes(value);
const partialHasKey = (obj, key?: string) => checkHasKey(key, obj);
const partialHasValue = (obj, value) => checkHasValue(value, obj);
const checkSome = (check = _.isTrue, arr) => arr.some(check);
const checkEvery = (check = _.isTrue, arr) => arr.every(check);

const some = partialApply(checkSome);
const every = partialApply(checkEvery);

const hasKeysSome = partialApply((targets, value) =>
  checkSome(partialHasKey(value), targets)
);
const hasKeysEvery = partialApply((targets, value) =>
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
const isNull = (a, b) => {
  console.log({ a, b });
  return _.isDefined(a) !== b;
};

/* SECTION: query filters */
//https://github.com/hasura/graphql-engine/blob/b84db36ebb51acd5b51e1254c103f3097a7c2358/server/src-lib/Hasura/GraphQL/Resolve/BoolExp.hs
const operators = {
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
  _and: (ops, path = [], iter = (v, _pth) => _.isTrue(v)) => {
    // console.log('_and', {ops, path})
    const opList = ops.map((q, i) => iter(q, [...path]));
    return (obj: any) => {
      const res = applyAll(opList, obj);
      const bool = res.every(_.isTrue);
      if (bool) console.log('_and', bool, res);
      return bool;
    };
  },
  _or: (ops, path = [], iter = (v, _pth) => _.isTrue(v)) => {
    // console.log("_or", { ops, path });
    const opList = ops.map((q) => iter(q, [...path]));
    return (obj) => applyAll(opList, obj).some(_.isTrue);
  },
  _not: (op, path = [], iter = (v, _pth) => _.isTrue(v)) => {
    // console.log("_not", { op, path });
    const child = iter(op, [...path]);
    return (obj) => _.isFalse(child(obj));
  },
};

const getPath = partialApply(_.makeGetter);

function makeExpression(exp, rhs, path) {
  // console.log("makeExpression", {path, rhs, exp});
  const getter = getPath(path);
  const expression = operators[exp];
  return function (obj) {
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

function walk(query = {}, path = []) {
  if (_.isEmpty(query)) return () => true;
  const keys = Object.entries({ ...query });
  const matchers = [];

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
  return (obj) => {
    return applyAll(matchers, obj).every(_.isTrue);
  };
}

function parseOrderBy(query, paths = []) {
  let res = [];
  // console.log(query, paths);
  if (_.isString(query)) {
    return [{ key: query, dir: 'desc', nulls: 'last' }];
  } else if (_.isArray(query)) {
    return query.flatMap((e) => parseOrderBy(e, paths));
  } else if (_.isObject(query)) {
    // Sort object keys to be deterministic
    const entries = Object.entries(query).sort(([k1], [k2]) =>
      _.defaultSort(k1, k2)
    );
    return entries.flatMap(([k, v]) => {
      const key = paths.concat([k]);
      if (_.isString(v)) {
        const [dir, ___, nulls = 'last'] = v.split('_');
        const op = { key: key.join('.'), dir, nulls };
        // console.log("Object -> val", { op });
        return op;
      } else {
        const op = parseOrderBy(v, key);
        // console.log("Object -> arr/obj", { op });
        return op;
      }
    });
  }
  return res;
}

export const orderBy = (props = []) => (a, b) => {
  const orderOps = parseOrderBy(props);
  for (let p in orderOps) {
    const { key, dir, nulls } = orderOps[p];
    const cmp = dir === 'asc' ? _.defaultSort : _.reverseSort;
    const x = _.get(a, key);
    const y = _.get(b, key);
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
  raw?: {};
  where?: (() => boolean) | ((obj: any) => any);
  order_by?: ((a: any, b: any) => any) | string[];
  distinct_on?: any;
  offset?: number;
  limit?: any;
};

const EmptyQuery: QueryType = {
  raw: {},
  where: () => true,
  order_by: () => 0,
  distinct_on: null,
  offset: null,
  limit: null,
};

function RawQuery(query: QueryType = {}){
  return {
    ...EmptyQuery,
    ...query,
  };
}

export class Query implements QueryType {
  raw: QueryType;
  where: (() => boolean) | ((obj: any) => any);
  order_by: (((a: any, b: any) => any) | string[]);
  distinct_on: any;
  offset: number;
  limit: any;
  constructor(_query: QueryType = EmptyQuery) {
    const query = RawQuery(_query);
    this.raw = EmptyQuery;
    this.setQuery(query);
  }

  setQuery = (query = EmptyQuery) => {
    const ops = [
      /* @ts-ignore */
      this.setWhere(query.where) /* @ts-ignore */,
      this.setOrderBy(query.order_by) /* @ts-ignore */,
      this.setDistinctOn(query.distinct_on),
      this.setOffset(query.offset),
      this.setLimit(query.limit),
    ];
    return ops.some(_.isTrue);
  };

  setWhere = (whereQuery = EmptyQuery.where) => {
    if (_.isEqual(whereQuery, this.raw.where)) return false;
    /* @ts-ignore */
    this.raw.where = whereQuery;
    this.where = walk(whereQuery);
    return true;
  };

  setOrderBy = (orderByQuery = []) => {
    if (_.isEqual(orderByQuery, this.raw.order_by)) return false;
    this.raw.order_by = orderByQuery;
    this.order_by = orderBy(orderByQuery);
    return true;
  };

  setDistinctOn = (distinctOnQuery = null) => {
    if (_.isEqual(distinctOnQuery, this.raw.distinct_on)) return false;
    this.raw.distinct_on = distinctOnQuery;
    this.distinct_on = distinctOnQuery;
    return true;
  };

  setOffset = (offsetQuery = 0) => {
    if (_.isEqual(offsetQuery, this.raw.offset)) return false;
    this.raw.offset = offsetQuery;
    this.offset = offsetQuery;
    return true;
  };

  setLimit = (limitQuery = null) => {
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
  data: any;
  dataview: any;
  query: Query;
  dirty: any;
  has_more: boolean;
  static Query: typeof Query;
  constructor(data, query = {}) {
    this.setData(data);
    this.setQuery(query);
  }

  setData = (data) => {
    this.data = data;
    this.dataview = null;
    this.query = new Query();
  };

  setQuery = (query) => {
    this.dirty = this.query.setQuery(query);
    this.commit();
    return this;
  };

  where = (whereQuery) => {
    const didUpdate = this.query.setWhere(whereQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  orderBy = (orderByQuery) => {
    const didUpdate = this.query.setOrderBy(orderByQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  /* TODO: currently doesnt do deep distinct */
  distinctOn = (distinctOnQuery) => {
    const didUpdate = this.query.setDistinctOn(distinctOnQuery);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  offset = (offset) => {
    const didUpdate = this.query.setOffset(offset);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  limit = (limit) => {
    const didUpdate = this.query.setLimit(limit);
    this.dirty = this.dirty || didUpdate;
    return this;
  };

  commit = () => {
    if (!this.dirty) return false;
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
