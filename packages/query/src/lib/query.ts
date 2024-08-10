import _ from '@adhd/transform';
import { BooleanExpression, OrderByExpression, QueryExpression, QueryExpressionValues } from './expressions';
import { OrderByOperation } from './operators';
import { CallbackFunctionTyped } from 'packages/transform/src/lib/function';

interface ASTNode {
  type: string;
}

class ConditionNode implements ASTNode {
  type = "Condition";
  path: string[];
  operator: string;
  value: any;
  public getter: (obj: any, create?: boolean | undefined) => any; 
  
  public run = (obj: any): boolean => {
    // console.log({obj, operator: this.operator, value: this.value})
    const func = operators[this.operator];
    const input = this.getter(obj)
    const res = func(input)(this.value)
    // console.log(`\tConditionNode(result=${res}, ${this.path.join(".")}, ${input} ${this.operator} ${this.value})`)
    return res;
  }

  constructor(field: string | string[], operator: string, value: any) {
    this.path = typeof field =="string" ? [field] : field;
    this.getter = _.makeGetter(this.path.join('.'));
    this.operator = operator;
    this.value = value;
  }
  toJson = (): any => {
    return {[this.path.join('.')]: {[this.operator]: this.value}};
  }
  toString = (): string => {
    // const wrappers = {'_in': ["[","]"],'_nin': ["[","]"], '_contained_in': ["{","}"]};
    // const wrap = this.operator in wrappers ? wrappers[this.operator as keyof typeof wrappers] :["",""]
    return JSON.stringify({[this.path.join('.')]: {[this.operator]: this.value}})
    // return `{ "${this.path.join('.')}":  "{${this.operator}": ${wrap[0]}${this.value}${wrap[1]}}}`;
  }
}
type LogicalOperatorKey = "_and" | "_or" | "_not"
class LogicalOperatorNode implements ASTNode {
  type = "LogicalOperator";
  operator: "_and" | "_or" | "_not";
  conditions: (LogicalOperatorNode|ConditionNode)[] = [];
  public getter: (obj: any, create?: boolean | undefined) => any = (obj) => obj;
  constructor(operator: LogicalOperatorKey, conditions: BooleanExpression[], path: string[]=[]) {
      this.operator = operator;
      this.getter = (obj: any) => obj
      this.conditions = conditions.flatMap((exp) => {
        const query_entries = Object.entries(exp);
        console.log({operator, query_entries})
        const conditions = query_entries.flatMap(
            ([q, children])=> {
              if(q in operators && q !== "_and" && q !== "_or" && q !== "_not"){
                return new ConditionNode([...path], q, children)
              } else if(q==='_and' || q==="_or"){
                return new LogicalOperatorNode(q as "_and" | "_or" | "_not", children as BooleanExpression[], path)
              } else if (q=='_not'){
                return new LogicalOperatorNode(q, [children as BooleanExpression], path)
              } else {
                // const keys = Object.keys(children)
                // return keys.map(k => new ConditionNode([...path, q], k, children[k]))
                // return lo;
                return new LogicalOperatorNode("_and", [children as BooleanExpression], [...path, q])
              }
            }
        )
        if(operator=='_or'){
          const lo = new LogicalOperatorNode("_and", [], path)
          lo.conditions = conditions;
          return lo
        }
        return conditions;
      });
      
    
  }
  // constructor(operator: "_and" | "_or" | "_not") {
  //   this.operator = operator;
  // }
  // buildTree = (conditions: BooleanExpression[], path: string[] = []) => {
  //   const queue: [BooleanExpression, string[]][] = [];

  //   for (const exp of conditions) {
  //     queue.push([exp, path]);
  //   }

  //   while (queue.length > 0) {
  //     const [exp, currentPath] = queue.shift()!;
  //     const query_entries = Object.entries(exp);

  //     for (const [q, children] of query_entries) {
  //       if (q in operators && q !== "_and" && q !== "_or" && q !== "_not") {
  //         this.conditions.push(new ConditionNode([...currentPath], q, children));
  //       } else if (q === '_and' || q === "_or" || q === '_not') {
  //         const node = new LogicalOperatorNode(q as "_and" | "_or" | "_not");
  //         this.conditions.push(node);
  //         for (const child of children as BooleanExpression[]) {
  //           queue.push([child, currentPath]);
  //         }
  //       } else {
  //         const childExp = children as BooleanExpression;
  //         queue.push([childExp, [...currentPath, q]]);
  //       }
  //     }
  //   }

  //   if (this.operator === '_or') {
  //     const andNode = new LogicalOperatorNode("_and");
  //     andNode.conditions = this.conditions;
  //     this.conditions = [andNode];
  //   }
  // }
  private logAndRun = (obj: any) => {
    return (condition: (LogicalOperatorNode|ConditionNode))=>{
      const res = condition.run(obj);
      console.log(`\t${condition.toString()} ${condition.getter(obj)} -> ${res}`)
      return res
    }
  }
  public run = (obj: any):boolean  => {
    // console.log({logicalEval: this})
    switch (this.operator) {
      case "_and":
          return this.conditions.every(this.logAndRun(obj));
      case "_or":
          return this.conditions.some(this.logAndRun(obj));
      case "_not":
          return !this.conditions.every(this.logAndRun(obj));
      default:
          throw new Error(`Unknown logical operator: ${this.operator}`);
    }
  }
  public toJson = (): any => {
    return {
      [this.operator]: this.conditions.map(c => c.toJson())
    }
  }
  toString(): string {
      // const wrap = {'_and': ["[","]"],'_or': ["[","]"], '_not': ["{","}"]}[this.operator]
      return JSON.stringify(this.toJson())
      // return `{${this.operator}: ${wrap[0]}${this.conditions.map(c => ''+c.toString()).join(',  ')}${wrap[1]}}`;
  }
}

function negate(func: (...args:any[])=> boolean) {
  return (...args: any) => func(...args)===false;
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
const isNe = _.isNotEqual;
const isNeq = _.isNotEqual;
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
  // console.log({ a, b });
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
};
const logicalOperators: Record<string, FilterPartial> = {
  _and: (ops, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    const opList = ops.map((q: any, i: any) => iter(q, [...path]));
    return (obj: any) => {
      const res = applyAll(opList, obj);
      const bool = res.every(_.isTrue);
      return bool;
    };
  },
  _or: (ops, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    const opList = ops.map((q: any) => iter(q, [...path]));
    return (obj) => applyAll(opList, obj).some(_.isTrue);
  },
  _not: (op, path = [], iter = (v: any, _pth: any) => _.isTrue(v)) => {
    const child = iter(op, [...path]);
    return (obj) => _.isFalse(child(obj));
  },
}
const andOperator = (ops: Filter[]) => {
  return (obj: any) => {
    const res = applyAll(ops, obj);
    const bool = res.every(_.isTrue);
    return bool;
  };
}
const orOperator = (ops: Filter[]) => {
  // const opList = ops.map((q: any) => iter(q, [...path]));
  return (obj: any) => applyAll(ops, obj).some(_.isTrue);
}
const notOperator = (op: Filter) => {
  // const child = iter(op, [...path]);
  return (obj:any) => _.isFalse(op(obj));
}

const getPath = partialApply(_.makeGetter);

function makeExpression(exp: string, rhs: unknown, path: string[]) {
  // console.log("makeExpression", {path, rhs, exp});
  const getter = getPath(path);
  const expression = operators[exp];
  return function (obj: any) {
    const lhs = getter(obj, false)();
    const result = expression(lhs, rhs);
    // NOTE: useful for debugging the operators
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
class CallStack<T=[QueryExpressionValues,string[]]|[QueryExpressionValues,string[], string]> {
  private stack: T[] = [];
  private name = 'stack'
  // override push(item: T) {
  //   console.log('stack', JSON.stringify(this.stack, null, 2));
  //   this.stack.push(item)
  //   return this.stack.length;
  // }
  // override pop() {
  //   return this.stack.pop();
  // }
  // get() {
  //   return this.stack;
  // }
  private items: T[] = [];

  constructor(name: string, initialItems?: T[]) {
    // super()
    this.name=name;
    if (initialItems) {
      this.stack = initialItems;
    }
  }

  push(...items: T[]): number {
    items.forEach(item => this.stack.push(item));
    // console.log(this.name, JSON.stringify(this.stack, null, 2));
    return this.stack.length;
  }

  pop(): T | undefined {
    return this.stack.pop();
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.stack.length) {
      return undefined;
    }
    return this.stack[index];
  }

  set(index: number, item: T): void {
    if (index < 0 || index >= this.stack.length) {
      throw new Error("Index out of bounds");
    }
    this.stack[index] = item;
  }
  clear(): void {
    this.stack = [];
  }
  
  length(): number {
    return this.stack.length;
  }
}

// function CallStack<T=[QueryExpressionValues,string[]]>() {
//   const stack: T[] = [];
//   return {
//     push: (item: T) => {
//       console.log('stack', JSON.stringify(stack,null,2));
//       stack.push(item)
//     },
//     pop: () => stack.pop(),
//     get: () => stack,
//   };
// }


const argStack: CallStack = new CallStack('ARGS')
const resStack: CallStack = new CallStack('RES')
// TODO: this shouldn't be recursive - it blows the stack in react
function processStack(query_entries: [string, any][], matchers: (FilterPartial | Filter | boolean)[], path: string[] = []){
  return ([k, value]: [k:string, value: QueryExpressionValues]) => {
    if (k in logicalOperators) {
      matchers.push(logicalOperators[k](value, path, walk));
    } else if (k in operators) {
      matchers.push(makeExpression(k, value, [...path]));
    } else {
      // argStack.push([value, [...path, k]])
      matchers.push((() => {
        const res = walk(value, [...path, k]);
        // resStack.push([value, [...path, k], typeof res])
        return res;
      })());
    }
  }
}


function walk(query: QueryExpressionValues = {}, path: string[] = []) {
  if (_.isEmpty(query)) return () => true;
  const query_entries = Object.entries({ ...query });
  const matchers: (FilterPartial | Filter | boolean)[] = [];
  // const stack: [string, ] = []
  // const rootNode = new LogicalOperatorNode('_and', [query], path);
  // console.log(rootNode.toString())

  query_entries.forEach(processStack(query_entries, matchers, path));
  return (obj: any) => {
    return applyAll(matchers, obj).every(_.isTrue);
  };
}
// function walk(q: QueryExpressionValues = {}, p: string[] = []) {
//   if (_.isEmpty(q)) return () => true;
//   argStack.push([q, p])
//   while (argStack.length()>0){
//     const [query, path] = argStack.pop()!;
  
//     const query_entries = Object.entries({ ...query });
//     const matchers: (FilterPartial | Filter | boolean)[] = [];

//     query_entries.forEach(([k, value]) => {
//       if (k === '_and' || k === '_or' || k === '_not') {
//         matchers.push(operators[k](value, path, walk));
//       } else if (k in operators) {
//         matchers.push(makeExpression(k, value, [...path]));
//       } else {
//         argStack.push([value, [...path, k]])
//         matchers.push((() => {
//           const res = walk(value, [...path, k]);
//           resStack.push([value, [...path, k], typeof res])
//           return res;
//         })());
//       }
//     });
//   }
//   return (obj: any) => {
//     return applyAll(matchers, obj).every(_.isTrue);
//   };
// }

function parseOrderBy(query: string | OrderByExpression | OrderByExpression[], paths: string[] = []): OrderByOperation[] {
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
        return op;
      } else {
        const op: OrderByOperation[] = parseOrderBy(v, key);
        return op;
      }
    });
  }
  return [] as  OrderByOperation[];
}

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
    argStack.clear()
    resStack.clear()
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
  data?: any[];
  dataview: any;
  query: Query;
  dirty: any;
  logging: boolean;
  has_more=false;
  static Query: typeof Query;
  constructor(data: any[], query: QueryExpression = {}, logging=false) {
    this.query = new Query();
    this.logging = logging;
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
    if (!this.dirty || !this.data) return false;
    let res = this.data;
    if (this.query.where) {
      if(this.query.raw.where){
        const rootNode = new LogicalOperatorNode('_and', [this.query.raw.where], []);
        // const rootNode = new LogicalOperatorNode('_and');
        // rootNode.buildTree([this.query.raw.where])
        res = res.filter(rootNode.run)
        
        console.log('ROOT', rootNode.toString())
        if(this.logging){
          console.log({results: res, expected: res.filter(this.query.where)});
        }
      }
    }
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
