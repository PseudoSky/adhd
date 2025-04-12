import { Transform as _ } from "@adhd/transform";
export const partialApply = (fn: ((...args: any[]) => any), ...cache: undefined[]) => (...args: any[]) => {
  const all = cache.concat(args);
  return all.length >= fn.length ? fn(...all) : partialApply(fn, ...all);
};
export const applyAll = (fns: any[], obj: any) => fns.flatMap((f: (arg0: any) => any) => f(obj));
const hasValues = (values: string | any[], target: any[]) => target.every((v: any) => values.includes(v));
const checkHasKey = (key: string, obj: { hasOwnProperty: (arg0: any) => any; }) => _.isObject(obj) && key in obj;
const partialHasKey = (key: string) => (obj: any) => checkHasKey(key, obj);
const checkSome = (check = _.isTrue, arr: any[]) => arr.some(check);
const checkEvery = (check = _.isTrue, arr: any[]) => arr.every(check);
const hasKeysSome = partialApply((targets: any, value: any) => checkSome(partialHasKey(value), targets));
const hasKeysEvery = partialApply((targets: any, value: any) => checkEvery(partialHasKey(value), targets));
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
const isNull = (a: any, b: boolean) => _.isDefined(a) !== b;
export type Filter = (...args: any) => boolean;
export type FilterPartial = (...args: any) => Filter;
/* SECTION: query filters */
//https://github.com/hasura/graphql-engine/blob/b84db36ebb51acd5b51e1254c103f3097a7c2358/server/src-lib/Hasura/GraphQL/Resolve/BoolExp.hs
export const operators: Record<string, FilterPartial> = {
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
  _has_keys_all: partialApply(hasKeysAll),
  _is_null: partialApply(isNull),
};

export const logicalOperators: Record<string, FilterPartial> = {
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
};
export type OperatorKey = keyof typeof operators;
export type LogicalOperatorKey = keyof typeof logicalOperators;