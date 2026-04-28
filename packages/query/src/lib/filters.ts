import { Transform as _ } from "@adhd/transform";
// export const partialApply = (fn: ((...args: unknown[]) => any), ...cache: undefined[]) => (...args: unknown[][]) => {
//   const all = cache.concat(args);
//   return all.length >= fn.length ? fn(...all) : partialApply(fn, ...all);
// };
export function partialApply<F extends (...args: any[]) => any>(
  fn: F,
  ...cache: any[]
): (...args: any[]) => any {
  return (...args: any[]) => {
    const all = [...cache, ...args];
    return all.length >= fn.length
      ? fn(...all)
      : partialApply(fn, ...all);
  };
}
/**
 * Map an object through multiple functions and flatten the results.
 */
export const applyAll = <T, R>(fns: Array<(arg: T) => R | R[]>, obj: T): R[] =>
  fns.flatMap(f => f(obj));
const hasValues = (values: string | unknown[], target: unknown[]): boolean =>
  target.every(v => values.includes(v as any));

// export const applyAll = (fns: unknown[], obj: unknown) => fns.flatMap((f: (arg0: unknown) => any) => f(obj));
// const hasValues = (values: string | any[], target: unknown[]) => target.every((v: unknown) => values.includes(v));
const checkHasKey = <T extends string | number | symbol>(key: T, obj: unknown): obj is Record<T, unknown> =>
  _.isObject(obj) && key in obj;

// const checkHasKey = (key: string, obj: { hasOwnProperty: (arg0: unknown) => any; }) => _.isObject(obj) && key in obj;
const partialHasKey = (key: string | number | symbol) => (obj: unknown): boolean =>
  checkHasKey(key, obj);
const checkSome = (check: (v: unknown) => boolean = _.isTrue, arr: unknown[]) => arr.some(check);
const checkEvery = (check: (v: unknown) => boolean = _.isTrue, arr: unknown[]) => arr.every(check);
const hasKeysSome = partialApply((targets: unknown[], value: string | number | symbol) => checkSome(partialHasKey(value), targets));
const hasKeysEvery = partialApply((targets: unknown[], value: string | number | symbol) => checkEvery(partialHasKey(value), targets));
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
const matchesRegex = (a: string, b: string) => _.isDefined(a) && new RegExp(b).test(a);
const matchesIRegex = (a: string, b: string) => _.isDefined(a) && new RegExp(b, 'i').test(a);
const matchesNRegex = (a: string, b: string) => !matchesRegex(a, b);
const matchesNIRegex = (a: string, b: string) => !matchesIRegex(a, b);
const isNull = (a: unknown, b: boolean) => _.isDefined(a) !== b;
export type Filter = (...args: unknown[]) => boolean;
export type FilterPartial = (...args: any[]) => Filter;
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
  _regex: partialApply(matchesRegex),
  _iregex: partialApply(matchesIRegex),
  _nregex: partialApply(matchesNRegex),
  _niregex: partialApply(matchesNIRegex),
};

export const logicalOperators: Record<string, FilterPartial> = {
  _and: (ops, path = [], iter = (v: unknown, _pth: unknown) => _.isTrue(v)) => {
    const opList = ops.map((q: unknown, i: unknown) => iter(q, [...path]));
    return (obj: unknown) => {
      const res = applyAll(opList, obj);
      const bool = res.every(_.isTrue);
      return bool;
    };
  },
  _or: (ops, path = [], iter = (v: unknown, _pth: unknown) => _.isTrue(v)) => {
    const opList = ops.map((q: unknown) => iter(q, [...path]));
    return (obj) => applyAll(opList, obj).some(_.isTrue);
  },
  _not: (op, path = [], iter = (v: unknown, _pth: unknown) => _.isTrue(v)) => {
    const child = iter(op, [...path]);
    return (obj) => _.isFalse(child(obj));
  },
};
export type OperatorKey = keyof typeof operators;
export type LogicalOperatorKey = keyof typeof logicalOperators;