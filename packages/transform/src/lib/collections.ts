import { extractThen } from './function';

export type BooleanFilter = (e: any) => boolean
export type ArrayOrObject = Record<string | number, any>;
export type Selector<T> = (data: T, index: number, orig: T[]) => any
export type ComparisonFunction<T> = ((a: T, b: T) => 0 | 1 | -1)

export const difference = (arrays: any[][]) => arrays.reduce((a, b) => a.filter((c: any) => !b.includes(c)))
export const intersection = (arrays: any[][]) => arrays.reduce((a, b) => a.filter((c: any) => b.includes(c)))
export const flattenDeep = (arr: any[][]): any[] => arr.flatMap((subArray, index) => Array.isArray(subArray) ? flattenDeep(subArray) : subArray)
export const keyByArray = (array: any[], key: string) => (array || []).reduce((r, x) => ({ ...r, [key ? x[key] : x]: x }), {});
export const keyBy = (collection: Record<string, any> | [], key: string) => {
  // keyBy for array and object
  const c = collection || {};
  return Array.isArray(c)
    ? keyByArray(c, key)
    : Object.values(keyByArray(c as [], key));
}

export function isMatchType(obj: any, target: any) {
  return typeof obj === typeof target
}

export function isMatch(obj: any, target: any) {
  // TODO: This needs to be fixed
  return true
  // if(!isMatchType(obj, target) ) return false;
  // switch(typeof target){
  //   case 'array':
  //     return obj.length>=target.length &&
  //       target.reduce((r, e, i) => r && isMatch(e, obj[i]), true)
  //   case 'object':
  //     return Object.entries(target).reduce(
  //       (res, [key, val]) => {
  //         return res && (key in obj && isMatch(obj[key], val));
  //       }, true
  //     )
  //   default:
  //     return obj===target
  // }
}

export function overSome(checks: BooleanFilter[]) {
  return (item: any) => checks.some(check => check(item))
}

export function overEvery(checks: BooleanFilter[]) {
  return (item: any) => checks.every(check => check(item))
}

export function overEach(arr: any[]) {
  return (...args: any[]) => arr.map(func => func(...args))
}

export function omitBy(orig: ArrayOrObject, check: BooleanFilter) {
  // TODO: change Check type to pass key and value in the case exclusions are key based
  const obj: Record<string | number, any> = { ...orig }
  return Object.entries(orig).reduce((res, [key, value]) => {
    if (!check(value)) res[key] = obj[key];
    return res
  }, orig.constructor())
}

export function pickBy(orig: ArrayOrObject, check: BooleanFilter) {
  const obj = { ...orig }
  return Object.entries(obj).reduce((res, [key, value]) => {
    if (check(value)) res[key] = obj[key];
    return res
  }, orig.constructor())
}

export function keySelect(key: string) {
  return ({ [key]: res }: Record<string, any>) => res
}

export function pluck(arr: any[], key: string) {
  return arr.map(keySelect(key))
}

export function minBy<T>(collection: T[], selector: Selector<T>, compare: ComparisonFunction<number> = reverseSort) {
  // TODO: make a default minby compare so the types work

  // slower because need to create a lambda function for each call...

  // Maps all collection items to objects with their selector values and index
  //    {value, index, data}
  // then reduces them using the "compare" function 
  const indexed = collection.map(
    (data, index, orig) => ({
      value: selector(data, index, orig),
      index,
      data,
    })
  )
  return indexed.reduce((r, e) => compare(r.value, e.value) == -1 ? e : r, indexed[0]).data
}

export function maxBy<T>(collection: T[], selector: Selector<T>, compare: ComparisonFunction<number> = defaultSort) {
  // slower because need to create a lambda function for each call...
  return minBy(collection, selector, compare)
}

export function defaultSort(a: any, b: any) {
  if (a == b) return 0
  return a > b ? 1 : -1;
}

export function reverseSort(a: number, b: number) {
  if (a == b) return 0;
  return b > a ? 1 : -1;
}

export function first(arr: any[]) { return arr[0] }
export function last(arr: string | any[]) { return arr[arr.length - 1] }

export function sortByProp<T, P extends keyof T>(arr: T[], prop: P, cmp: ComparisonFunction<T[P]> = defaultSort) {
  // REF: Performance
  // https://stackoverflow.com/questions/4020796/finding-the-max-value-of-an-attribute-in-an-array-of-objects
  return (arr && arr.sort) ? arr.sort(({ [prop]: a }, { [prop]: b }) => cmp(a, b)) : arr
}

export const sortByKey = (key: string) => { return extractThen(key, defaultSort) };

export const sortBy = <T, P extends keyof T>(arr: T[], prop?: P, cmp: ComparisonFunction<T[P] | any> = defaultSort) => !prop ? arr.sort(cmp) : sortByProp(arr, prop, cmp);

export function maxByProp<T, P extends keyof T>(arr: T[], prop: P) {
  // REF: Performance
  // http://www.codeblocq.com/2016/05/Get-the-last-element-of-an-Array-in-JavaScript/
  return sortByProp(arr, prop)[arr.length - 1]
}

export function minByProp<T, P extends keyof T>(arr: T[], prop: P) {
  return sortByProp(arr, prop)[0]
}

export function filterExclude(arr: any[], obj = {}) {
  return arr.filter(e => !isMatch(e, obj))
}

export function filterInclude(arr: any[], obj = {}) {
  return arr.filter(e => isMatch(e, obj))
}

// export function groupByProp(arr, key){
//   return arr.reduce((res, element) => Object.assign(res, {[element[key]]: element}) = (res[element[key]]||[]).concat([]))
// }

export function unique(arr: any[]) {
  return arr.reduce((a, d) => {
    if (!a.includes(d)) { a.push(d); }
    return a;
  }, []);
}

export function uniqueByProp<Entry extends Record<string, any>, Prop extends keyof Entry>(arr: Entry[], prop: Prop) {
  if (!prop || !arr) return arr;
  const seen = new Set()
  return arr.reduce((a, d) => {
    if (!seen.has(d[prop])) {
      seen.add(d[prop])
      a.push(d);
    } else if (!(prop in d)) {
      a.push(d)
    }
    return a;
  }, [] as Entry[]);
}

export function uniqueBy(arr: any[], props: string[]) {
  if (!props || !props.length) return []
  return props.reduce(uniqueByProp, arr);
}

export function indexBy(arr: any[], prop: string) {
  if (!prop || !arr || !arr.length) return {};
  return arr.reduce((res, e) => {
    if (prop in e) res[e[prop]] = (res[e[prop]] || []).concat(e)
    return res
  }, {})
}

export function rangeByProp(arr: any[], prop: string) {
  if (arr.length === 1) {
    return { "key": prop, "min": arr[0][prop], "max": arr[0][prop] }
  }
  const sorted = sortByProp(arr, prop)

  return { "key": prop, "min": sorted[0][prop], "max": sorted[sorted.length - 1][prop] };
}

export function rangeByProps(arr: any[], props: string[]) {
  return props.map(prop => rangeByProp(arr, prop))
}

export function range(start: number, stop: number, step: number) {
  const a = [start]
  let b = start;
  while (b < stop) {
    a.push(b += step || 1);
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
}
