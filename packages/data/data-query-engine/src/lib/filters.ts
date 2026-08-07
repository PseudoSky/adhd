import { Transform as _ } from '@adhd/data-base-transforms';
// export const partialApply = (fn: ((...args: unknown[]) => any), ...cache: undefined[]) => (...args: unknown[][]) => {
//   const all = cache.concat(args);
//   return all.length >= fn.length ? fn(...all) : partialApply(fn, ...all);
// };
/**
 * Any callable. `never[]` in the parameter position is the standard way to accept
 * a function of ANY parameter list without `any`: parameters are checked
 * contravariantly, and `never` is assignable to every type.
 *
 * The previous constraint was `F extends (...args: unknown[]) => unknown`, which
 * almost no real function satisfies — `(a: string, b: string) => boolean` is NOT
 * assignable to it, because `unknown` is not assignable to `string`. Every
 * `partialApply(isEq)` call site therefore failed with TS2345 once `any` was swept
 * to `unknown`. This is the single root cause of most of this file's errors.
 */
type AnyFn = (...args: never[]) => unknown;

export function partialApply<F extends AnyFn>(
  fn: F,
  ...cache: unknown[]
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const all = [...cache, ...args];
    // Arity-driven currying cannot be expressed in the type system; the call is
    // guarded by `all.length >= fn.length`, which is exactly the runtime contract.
    const apply = fn as unknown as (...a: unknown[]) => unknown;
    return all.length >= fn.length ? apply(...all) : partialApply(apply, ...all);
  };
}
/**
 * Map an object through multiple functions and flatten the results.
 */
export const applyAll = <T, R>(fns: Array<(arg: T) => R | R[]>, obj: T): R[] =>
  fns.flatMap((f) => f(obj));
const hasValues = (values: string | unknown[], target: unknown[]): boolean =>
  // `values` is a string OR an array. `String.prototype.includes` only accepts a
  // string, so narrow before calling — previously this was `values.includes(v as unknown)`,
  // which no overload accepts (TS2345).
  typeof values === 'string'
    ? target.every((v) => typeof v === 'string' && values.includes(v))
    : target.every((v) => values.includes(v));

// export const applyAll = (fns: unknown[], obj: unknown) => fns.flatMap((f: (arg0: unknown) => any) => f(obj));
// const hasValues = (values: string | any[], target: unknown[]) => target.every((v: unknown) => values.includes(v));
const checkHasKey = <T extends string | number | symbol>(
  key: T,
  obj: unknown
): obj is Record<T, unknown> => _.isObject(obj) && key in obj;

// const checkHasKey = (key: string, obj: { hasOwnProperty: (arg0: unknown) => any; }) => _.isObject(obj) && key in obj;
const partialHasKey =
  (key: string | number | symbol) =>
  (obj: unknown): boolean =>
    checkHasKey(key, obj);
const checkSome = (check: (v: unknown) => boolean = _.isTrue, arr: unknown[]) =>
  arr.some(check);
const checkEvery = (
  check: (v: unknown) => boolean = _.isTrue,
  arr: unknown[]
) => arr.every(check);
const hasKeysSome = partialApply(
  (targets: unknown[], value: string | number | symbol) =>
    checkSome(partialHasKey(value), targets)
);
const hasKeysEvery = partialApply(
  (targets: unknown[], value: string | number | symbol) =>
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
const matchesRegex = (a: string, b: string) =>
  _.isDefined(a) && new RegExp(b).test(a);
const matchesIRegex = (a: string, b: string) =>
  _.isDefined(a) && new RegExp(b, 'i').test(a);
const matchesNRegex = (a: string, b: string) => !matchesRegex(a, b);
const matchesNIRegex = (a: string, b: string) => !matchesIRegex(a, b);
const isNull = (a: unknown, b: boolean) => _.isDefined(a) !== b;
export type Filter = (...args: unknown[]) => boolean;
export type FilterPartial = (...args: unknown[]) => Filter;

/**
 * Adapt a plain predicate into the curried `FilterPartial` the operator table stores.
 *
 * `partialApply` returns `(...args: unknown[]) => unknown` because arity-driven
 * currying returns EITHER the final value OR another partially-applied function —
 * a union the type system cannot resolve statically. One narrowing assertion here,
 * with this justification, is honest; sprinkling 25 casts across the table is not.
 * The runtime contract (`all.length >= fn.length` → call, else curry) is what makes
 * the eventual value a boolean, and it is covered by this package's filter specs.
 */
const asFilterPartial = (fn: AnyFn): FilterPartial =>
  partialApply(fn) as FilterPartial;
/* SECTION: query filters */
//https://github.com/hasura/graphql-engine/blob/b84db36ebb51acd5b51e1254c103f3097a7c2358/server/src-lib/Hasura/GraphQL/Resolve/BoolExp.hs
export const operators: Record<string, FilterPartial> = {
  // _cast: asFilterPartial(isCast),
  _eq: asFilterPartial(isEq),
  _ne: asFilterPartial(isNe),
  _neq: asFilterPartial(isNeq),
  _in: asFilterPartial(isIn),
  _nin: asFilterPartial(isNin),
  _gt: asFilterPartial(isGt),
  _lt: asFilterPartial(isLt),
  _gte: asFilterPartial(isGte),
  _lte: asFilterPartial(isLte),
  _like: asFilterPartial(isLike),
  _nlike: asFilterPartial(isNlike),
  _ilike: asFilterPartial(isIlike),
  _nilike: asFilterPartial(isNilike),
  _similar: asFilterPartial(isSimilar),
  _nsimilar: asFilterPartial(isNsimilar),
  _contains: asFilterPartial(contains),
  _contained_in: asFilterPartial(isContainedIn),
  _has_key: asFilterPartial(hasKey),
  _has_keys_any: asFilterPartial(hasKeysAny),
  _has_keys_all: asFilterPartial(hasKeysAll),
  _is_null: asFilterPartial(isNull),
  _regex: asFilterPartial(matchesRegex),
  _iregex: asFilterPartial(matchesIRegex),
  _nregex: asFilterPartial(matchesNRegex),
  _niregex: asFilterPartial(matchesNIRegex),
};

/** Compiles a sub-expression at `path` into a `Filter`. Supplied by the query compiler. */
type OpIter = (v: unknown, pth: unknown[]) => Filter;

/**
 * Placeholder default, preserved verbatim from the original code: it returns a
 * boolean, not a `Filter`. Every real caller (see `query.ts`) passes a compiled
 * `iter`, so this branch is never exercised — but changing it would be a behaviour
 * change, not a type fix, so it stays and the mismatch is asserted here rather than
 * silently widened.
 */
const defaultIter = ((v: unknown, _pth: unknown[]) =>
  _.isTrue(v)) as unknown as OpIter;

/** `FilterPartial`'s `(...args: unknown[])` erases these params, so declare them explicitly. */
export const logicalOperators: Record<string, FilterPartial> = {
  _and: ((ops: unknown, path: unknown[] = [], iter: OpIter = defaultIter) => {
    // `ops` arrives as `unknown`; narrow before iterating (previously TS18046/TS2488).
    const list = _.isArray(ops) ? [...ops] : [];
    const opList = list.map((q) => iter(q, [...path]));
    return (obj: unknown) => {
      const res = applyAll(opList, obj);
      const bool = res.every(_.isTrue);
      return bool;
    };
  }) as FilterPartial,

  _or: ((ops: unknown, path: unknown[] = [], iter: OpIter = defaultIter) => {
    const list = _.isArray(ops) ? [...ops] : [];
    const opList = list.map((q) => iter(q, [...path]));
    return (obj: unknown) => applyAll(opList, obj).some(_.isTrue);
  }) as FilterPartial,

  _not: ((op: unknown, path: unknown[] = [], iter: OpIter = defaultIter) => {
    const child = iter(op, [...path]);
    return (obj: unknown) => _.isFalse(child(obj));
  }) as FilterPartial,
};
export type OperatorKey = keyof typeof operators;
export type LogicalOperatorKey = keyof typeof logicalOperators;
