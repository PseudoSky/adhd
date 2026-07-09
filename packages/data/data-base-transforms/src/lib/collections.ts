import { isArray, isObject, isValue } from './filters';
import { extractThen } from './function';

export type BooleanFilter = (e: unknown) => boolean;
export type ArrayOrObject = Record<string | number, unknown>;
export type Selector<T> = (data: T, index: number, orig: T[]) => unknown;
export type ComparisonFunction<T> = (a: T, b: T) => 0 | 1 | -1;

export const difference = <T,>(arrays: T[][]): T[] =>
  arrays.reduce((a, b) => a.filter((c: T) => !b.includes(c)));
export const intersection = <T,>(arrays: T[][]): T[] =>
  arrays.reduce((a, b) => a.filter((c: T) => b.includes(c)));

type NestedArray<T> = T | NestedArray<T>[];
export const flattenDeep = <T,>(arr: NestedArray<T>[]): T[] =>
  arr.flatMap((subArray) =>
    Array.isArray(subArray) ? flattenDeep(subArray) : subArray
  );

export const keyByArray = <T extends Record<string, unknown>>(
  array: T[],
  key: keyof T & string
): Record<string, T> =>
  (array || []).reduce((r, x) => {
    // Computed property names require a string/number/symbol key. The
    // legacy (pre-`unknown`) behaviour let JS's implicit object-to-string
    // coercion decide the key when `key` was falsy; `String(...)`
    // reproduces that exactly instead of changing runtime behaviour.
    const k = key ? String(x[key]) : String(x);
    return { ...r, [k]: x };
  }, {} as Record<string, T>);
export const keyBy = (
  collection: Record<string, unknown> | unknown[],
  key: string
): Record<string, unknown> => {
  // keyBy for array and object
  const c = collection || {};
  return Array.isArray(c)
    ? keyByArray(c as Record<string, unknown>[], key)
    : Object.values(keyByArray(c as Record<string, unknown>, key));
};

export function isMatchType(obj: unknown, target: unknown) {
  return typeof obj === typeof target;
}

export function isMatch(obj: unknown, target: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[obj, target]];

  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [current, pattern] = stack.pop()!;

    if (isValue(pattern)) {
      if (current !== pattern) return false;
      continue;
    }

    if (isArray(pattern)) {
      if (!isArray(current) || current.length < pattern.length) return false;
      for (let i = 0; i < pattern.length; i++) {
        stack.push([current[i], pattern[i]]);
      }
      continue;
    }

    if (isObject(pattern)) {
      if (!isObject(current)) return false;
      for (const [key, val] of Object.entries(pattern)) {
        if (!(key in current)) return false;
        stack.push([current[key], val]);
      }
      continue;
    }

    if (current !== pattern) return false;
  }

  return true;
}

export function overSome(checks: BooleanFilter[]) {
  return (item: unknown) => checks.some((check) => check(item));
}

export function overEvery(checks: BooleanFilter[]) {
  return (item: unknown) => checks.every((check) => check(item));
}

export function overEach(arr: ((...args: unknown[]) => unknown)[]) {
  return (...args: unknown[]) => arr.map((func) => func(...args));
}

export function omitBy(orig: ArrayOrObject, check: BooleanFilter) {
  // TODO: change Check type to pass key and value in the case exclusions are key based
  const obj: Record<string | number, unknown> = { ...orig };
  return Object.entries(orig).reduce((res, [key, value]) => {
    if (!check(value)) res[key] = obj[key];
    return res;
  }, orig.constructor());
}

export function pickBy(orig: ArrayOrObject, check: BooleanFilter) {
  const obj = { ...orig };
  return Object.entries(obj).reduce((res, [key, value]) => {
    if (check(value)) res[key] = obj[key];
    return res;
  }, orig.constructor());
}

export function keySelect(key: string) {
  return ({ [key]: res }: Record<string, unknown>) => res;
}

export function pluck(arr: Record<string, unknown>[], key: string) {
  return arr.map(keySelect(key));
}

export function minBy<T>(
  collection: T[],
  selector: Selector<T>,
  compare: ComparisonFunction<unknown> = reverseSort
) {
  // Maps all collection items to objects with their selector values and index
  //    {value, index, data}
  // then reduces them using the "compare" function
  const indexed = collection.map((data, index, orig) => ({
    value: selector(data, index, orig),
    index,
    data,
  }));
  return indexed.reduce(
    (r, e) => (compare(r.value as number, e.value as number) == -1 ? e : r),
    indexed[0]
  ).data;
}

export function maxBy<T>(
  collection: T[],
  selector: Selector<T>,
  compare: ComparisonFunction<unknown> = defaultSort
) {
  // slower because need to create a lambda function for each call...
  return minBy(collection, selector, compare);
}

export function defaultSort<T>(a: T, b: T): 0 | 1 | -1 {
  if (a == b) return 0;
  // Generic passthrough comparator: relies on JS's abstract relational
  // comparison, which is defined for all values (numbers, strings, Dates,
  // etc.) and yields `false` (not a throw) for incomparable types — the
  // same permissive behaviour the legacy `any`-typed version relied on.
  return (a as unknown as number) > (b as unknown as number) ? 1 : -1;
}

export function reverseSort<T>(a: T, b: T): 0 | 1 | -1 {
  if (a == b) return 0;
  return (b as unknown as number) > (a as unknown as number) ? 1 : -1;
}

export function first(arr: unknown[]) {
  return arr[0];
}
export function last(arr: unknown[]) {
  return arr[arr.length - 1];
}

export function sortByProp<T, P extends keyof T>(
  arr: T[],
  prop: P,
  cmp: ComparisonFunction<T[P]> = defaultSort
) {
  // REF: Performance
  // https://stackoverflow.com/questions/4020796/finding-the-max-value-of-an-attribute-in-an-array-of-objects
  return arr && arr.sort
    ? arr.sort(({ [prop]: a }, { [prop]: b }) => cmp(a, b))
    : arr;
}

export const sortByKey = (key: string) => {
  return extractThen(key, defaultSort);
};

export const sortBy = <T, P extends keyof T>(
  arr: T[],
  prop?: P,
  cmp: ComparisonFunction<T[P] | unknown> = defaultSort
) => (!prop ? arr.sort(cmp) : sortByProp(arr, prop, cmp));

export function maxByProp<T, P extends keyof T>(arr: T[], prop: P) {
  // REF: Performance
  // http://www.codeblocq.com/2016/05/Get-the-last-element-of-an-Array-in-JavaScript/
  return sortByProp(arr, prop)[arr.length - 1];
}

export function minByProp<T, P extends keyof T>(arr: T[], prop: P) {
  return sortByProp(arr, prop)[0];
}

export function filterExclude(arr: unknown[], obj = {}) {
  return arr.filter((e) => !isMatch(e, obj));
}

export function filterInclude(arr: unknown[], obj = {}) {
  return arr.filter((e) => isMatch(e, obj));
}

// export function groupByProp(arr, key){
//   return arr.reduce((res, element) => Object.assign(res, {[element[key]]: element}) = (res[element[key]]||[]).concat([]))
// }

export function unique<T>(arr: T[]): T[] {
  return arr.reduce((a: T[], d) => {
    if (!a.includes(d)) {
      a.push(d);
    }
    return a;
  }, [] as T[]);
}

export function uniqueByProp<
  Entry extends Record<string, unknown>,
  Prop extends keyof Entry
>(arr: Entry[], prop: Prop) {
  if (!prop || !arr) return arr;
  const seen = new Set();
  return arr.reduce((a, d) => {
    if (!seen.has(d[prop])) {
      seen.add(d[prop]);
      a.push(d);
    } else if (!(prop in d)) {
      a.push(d);
    }
    return a;
  }, [] as Entry[]);
}

export function uniqueBy(arr: Record<string, unknown>[], props: string[]) {
  if (!props || !props.length) return [];
  return props.reduce(uniqueByProp, arr);
}

export function indexBy(arr: Record<string, unknown>[], prop: string) {
  if (!prop || !arr || !arr.length) return {};
  return arr.reduce((res: Record<string, unknown[]>, e) => {
    if (prop in e) {
      // Object/array keys are always coerced to strings by JS at runtime;
      // `String(...)` makes that explicit instead of changing behaviour.
      const key = String(e[prop]);
      res[key] = (res[key] || []).concat(e);
    }
    return res;
  }, {});
}

export function rangeByProp(arr: Record<string, unknown>[], prop: string) {
  if (arr.length === 1) {
    return { key: prop, min: arr[0][prop], max: arr[0][prop] };
  }
  const sorted = sortByProp(arr, prop);

  return {
    key: prop,
    min: sorted[0][prop],
    max: sorted[sorted.length - 1][prop],
  };
}

export function rangeByProps(arr: Record<string, unknown>[], props: string[]) {
  return props.map((prop) => rangeByProp(arr, prop));
}

export function range(start: number, stop: number, step: number) {
  const a = [start];
  let b = start;
  while (b < stop) {
    a.push((b += step || 1));
  }
  return a;
}

export default {
  reverseSort,
  difference,
  intersection,
  flattenDeep,
  keyByArray,
  keyBy,
  isMatchType,
  isMatch,
  overSome,
  overEvery,
  overEach,
  omitBy,
  pickBy,
  keySelect,
  pluck,
  minBy,
  maxBy,
  defaultSort,
  first,
  last,
  sortByProp,
  sortByKey,
  sortBy,
  maxByProp,
  minByProp,
  filterExclude,
  filterInclude,
  unique,
  uniqueByProp,
  uniqueBy,
  indexBy,
  rangeByProp,
  rangeByProps,
  range,
};
