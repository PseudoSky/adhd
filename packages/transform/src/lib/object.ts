import { makeGetter } from './function'
import { isObject } from './filters'

export const entries = Object.entries
export const values = Object.values
export const keys = Object.keys
export const stringify = JSON.stringify
export function isEqual(a,b){ return stringify(a)===stringify(b)}

export function zipObject(array, loose=false) {
  return Object.fromEntries(array)
}

export function rollObject(keys, values) {
  if(keys.length===values.length){
    return keys.reduce((res, k, i) => Object.assign(res, {[k]: values[i]}), {})
  }
}

export function omit(object, keys) {
  const keySet = new Set(keys)
  return Object.fromEntries(
    Object.entries(object).filter(([k, v]) => !keySet.has(k))
  );
}

export function pick(object, keys) {
  return keys.reduce((obj, key) => {
     if (object && object.hasOwnProperty(key)) {
        obj[key] = object[key];
     }
     return obj;
   }, {});
}

export const maskObject = pick;

export function isEmpty(obj){
  return [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;
}

export function toFlagMap(arr, default_value=true) {
  return arr.reduce((obj, key) => {
    obj[key] = default_value
    return obj
  }, {})
}

export function has(obj: Record<string, any>, key?: string) {
  return key && obj.hasOwnProperty(key);
}

export function hasAll(obj: Record<string, any>, keys: string[] = []) {
  return keys.reduce((r, k) => r && obj.hasOwnProperty(k), true);
}

export function groupBy(arr: any[], props: string[]){
  return Object.values(arr.reduce((res,e) => {
    const vals = props.map(makeGetter(null, e))
    const k = vals.join(':')
    res[k] = res[k] || { ...rollObject(props, vals), children:[]}
    res[k].children.push(e)
    res[k].size = res[k].children.length
    return res
  }, {}))
}

export function unZipObject(object: Record<string,any>, loose=false) {
  return Object.keys(object).reduce((res: [string,any][], key) => {
      if(loose || (key in object && object[key])){
        res.push([key, object[key]])
      }
      return res
   }, [])
}


export function deepEquals(object1, object2) {
  return JSON.stringify(object1)===JSON.stringify(object2)
}

export function deepCopy(object1){
  return JSON.parse(JSON.stringify(object1))
}

/**
 * Deep diff between two object, using lodash
 * @param  {Object} object Object compared
 * @param  {Object} base   Object to compare with
 * @return {Object}        Return a new object who represent the diff
 */
export function difference(_object, _base) {
  function changes(object, base, _res = {}) {
    return Object.entries(object).reduce(
      function(result, [key, value]) {
        if (!isEqual(value, base[key])) {
          result[key] =
            isObject(value) && isObject(base[key])
              ? changes(value, base[key])
              : value;
        }
        return result;
      }, _res
    );
  }
  return changes(_object, _base);
}

export default {
  deepCopy,
  deepEquals,
  difference,
  entries,
  groupBy,
  has,
  hasAll,
  isEmpty,
  isEqual,
  keys,
  maskObject,
  omit,
  pick,
  rollObject,
  stringify,
  toFlagMap,
  unZipObject,
  values,
  zipObject,
};
