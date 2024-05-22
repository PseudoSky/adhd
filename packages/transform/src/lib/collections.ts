import { extractThen } from './function'
import Stats from './stats'

export const difference = (arrays:any[]) => arrays.reduce((a, b) => a.filter(c => !b.includes(c)))
export const intersection = (arrays:any[]) => arrays.reduce((a, b) => a.filter(c => b.includes(c)))
export const flattenDeep = (arr:any[]): any[] => arr.flatMap((subArray, index) => Array.isArray(subArray) ? flattenDeep(subArray) : subArray)
export const keyByArray = (array:any[], key: string) => (array || []).reduce((r, x) => ({ ...r, [key ? x[key] : x]: x }), {});
// keyBy for array and object
export const keyBy = (collection, key) => {
  const c = collection || {};
  return Array.isArray(c)
    ? keyByArray(c, key)
    : Object.values(keyByArray(c, key));
}

export function isMatchType(obj: any, target: any){
  return typeof obj === typeof target
}

export function isMatch(obj, target){
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
type BooleanFilter = (e: any) => boolean
export function overSome(checks: BooleanFilter[]){
  return (item: any) => checks.some(check => check(item))
}

export function overEvery(checks: BooleanFilter[]){
  return (item: any) => checks.every(check => check(item))
}

export function overEach(arr: any[]){
  return (...args: any[]) => arr.map(func => func(...args))
}

export function omitBy(orig: object, check: BooleanFilter) {
  const obj = { ...orig }
  return Object.entries(obj).reduce((res, [key, value]) => {
    if(!check(value)) res[key]=obj[key];
    return res
  }, orig.constructor())
}

export function pickBy(orig: any, check: (val: any) => boolean) {
  const obj = { ...orig }
  return Object.entries(obj).reduce((res, [key, value]) => {
    if(check(value)) res[key]=obj[key];
    return res
  }, orig.constructor())
}

export function keySelect(key: string) {
  return ({[key]: res} : Record<string, any>) => res
}

export function pluck(arr: any[], key: string){
  return arr.map(keySelect(key))
}

type Selector<T> = (data: T, index: number, orig: T[]) => any

export function minBy<T>(collection: T[], selector: Selector<T>, compare: (a: any, b: any) => number=extractThen('value', Stats.getMin)){
  // slower because need to create a lambda function for each call...

  // Maps all collection items to objects with their selector values and index
  //    {value, index, data}
  // then reduces them using the "compare" function
  return collection.map(
    (data, index, orig) => ({
      value: selector(data, index, orig),
      index,
      data,
    })
  ).reduce(compare, {}).data
}

export function maxBy<T>(collection: T[], selector: Selector<T>, compare=extractThen('value', Stats.getMax)){
  // slower because need to create a lambda function for each call...
  return minBy(collection, selector, compare)
}




  // (a, b) => (a[key] > b[key]) ? 1 : ((b[key] > a[key]) ? -1 : 0);
export function defaultSort(a, b) {
  return a==b ? 0 : a > b ?  1 : -1;
}

export function reverseSort(a, b) {
  return a==b ? 0 : b > a ? 1 : -1;
}

// export function reverseSort(a, b, cmp = defaultSort) {
//   return cmp(a, b) * -1;
// }
export function first(arr: any[]){ return arr[0] }
export function last(arr){ return arr[arr.length-1] }
export function sortByProp<T, P extends string, V extends T[], >(arr: V, prop: P, cmp=defaultSort) {
  // REF: Performance
  // https://stackoverflow.com/questions/4020796/finding-the-max-value-of-an-attribute-in-an-array-of-objects
  return (arr && arr.sort) ? arr.sort(({[prop]: a},{[prop]: b}) => cmp(a,b)) : arr
}

export const sortByKey = (key: string) => { return extractThen(key, defaultSort) };

export const sortBy = (arr: any[], prop?: string, cmp=defaultSort) => !prop && !!cmp? arr.sort(cmp) : sortByProp(arr, prop, cmp);

export function maxByProp(arr: any[], prop: string){
  // REF: Performance
  // http://www.codeblocq.com/2016/05/Get-the-last-element-of-an-Array-in-JavaScript/
  return sortByProp(arr, prop)[arr.length-1]
}

export function minByProp(arr: any[], prop){
  return sortByProp(arr, prop)[0]
}

export function filterExclude(arr: any[], obj={}){
  return arr.filter(e => !isMatch(e, obj))
}

export function filterInclude(arr: any[], obj={}){
  return arr.filter(e => isMatch(e, obj))
}

// export function groupByProp(arr, key){
//   return arr.reduce((res, element) => Object.assign(res, {[element[key]]: element}) = (res[element[key]]||[]).concat([]))
// }

export function unique(arr: any[]){
  return arr.reduce((a, d) => {
    if (!a.includes(d)) { a.push(d); }
    return a;
  }, []);
}

export function uniqueByProp<Entry extends Record<string,any>, Prop = keyof Entry>(arr: Entry[], prop:keyof Entry){
  if(!prop || !arr) return arr;
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

export function uniqueBy(arr: any[], props: string[]){
  if(!props || !props.length) return []
  return props.reduce(uniqueByProp, arr);
}

export function indexBy(arr: any[], prop: string){
  if (!prop || !arr || !arr.length) return {};
  return arr.reduce((res, e) => {
    if(prop in e) res[e[prop]] = e
    return res
  }, {})
}

export function rangeByProp(arr: any[], prop: string){
  if(!arr || !prop) return arr
  if(arr.length===1){
    return [prop, arr[0][prop], arr[0][prop]]
  }
  const sorted = sortByProp(arr, prop)

  return [prop, sorted[0][prop], sorted[sorted.length-1][prop]];
}

export function rangeByProps(arr: any[], props: string[]){
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
