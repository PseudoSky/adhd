import { isEqual } from './object'
import { sortBy } from "./collections";
import { isFunction, isValue, isArray, isDate } from './filters';

export const intMin = Number.MIN_SAFE_INTEGER;
export const intMax = Number.MAX_SAFE_INTEGER;

export const compose = (...funcs: Function[]) =>
  funcs.reduce(
    (a, b) => (...args) => a(b(...args)),
    arg => arg
  );


export function noop(){return null}

export function extractThen(key: string, callback: (...p: any) => any) {
  return (...args) => callback(...args.map(({[key]: value}) => value))
}

/*
 * Traversal & transform utils
 * Set and get based on string paths
 */

const STR_PATH_REGEX = /[,[\].]+?/ // ALT from site /[,[\]]+?/
export function toPath(path: string | any){
  return typeof path==='string' ? path.split(STR_PATH_REGEX)
                                .filter(Boolean) : path

}

// TODO falsey is unclear - seems like it's actually doing the opposite
export function isFalsey (obj: any){
  return !obj || obj == null || obj == undefined;
}

export function makeGetter(_path?: string, obj?: any, useSetters=true) {
  if(!obj){
    return (_obj: any) => makeGetter(_path, _obj, useSetters)()
  }
  if(!_path) {
    return (path: string) => makeGetter(path, obj, useSetters)()
  }
  const path=toPath(_path)
  if(!path.length) return (defaultValue: any) => obj||defaultValue
  return (defaultValue: any) => path.reduce(
    ([parent, lastKey, res], key, index) => {
      if(isFalsey(res) && isFalsey(parent)) return defaultValue
      const field = key.replace(/(^")|("$)/g,'')
      const isInt = !Number.isNaN(parseInt(field))
      const isEnd = index === path.length-1
      if(isFalsey(res)){
        if(!isFalsey(parent)){
          res = isInt && key === field ? [] : {}
          if(useSetters){
            parent[lastKey]=res
            if(isEnd){
              res[field] = defaultValue
            }
          }
        }
        if(isEnd){
          return defaultValue
        }
      }
      return isEnd ? res[field] : [res, field, res[field]]
    }, [null, null, obj]
  ) || defaultValue
}

// TODO: doesn't look like it works
export function makeSetter(path: string, obj: any) {
  const getAttr = makeGetter(path, obj)
  return (value) => {
    const res = getAttr(value);
    return obj
  }
}

export function get(obj: any, path: string, defaultValue: any=undefined, useSetters=false) {
  return makeGetter(path, obj, useSetters)(defaultValue)
}

export function set(data: any, path: string, value: any){
  return makeSetter(path, data)(value);
}

export function getAll(obj: any, paths: string[], into={}, useSetters=false){
  return paths.reduce((res, path) => {
    const value = get(obj, path, undefined, useSetters)
    return set(res, path, value)
  }, into);
}

// export getAll;
// export toPath;
// export makeGetter;
// export makeSetter;
// export get;
// export set;



/*
EXAMPLE

var object = { a: [{ b: { c: 3 } }] };
var result = get(object, 'a[0].b.c', 1);
// output: 3

*/

// export function get(obj, path, defaultValue){
//   const travel = regexp =>
//     String.prototype.split
//       .call(path, regexp)
//       .filter(Boolean)
//       .reduce((res, key) => (res !== null && res !== undefined ? res[key] : res), obj);
//   const result = travel(/[,[\]]+?/) || travel(/[,[\].]+?/);
//   return result === undefined || result === obj ? defaultValue : result;
// };

/* end traversal utils */


/*
 * Function modifiers
 */

export function runAfter(f: Function, t: number) {
  return function () {
    const args = arguments;
    const self = this;
    return setTimeout(() => f.apply(self, args), t);
  };
}

export function throttle<T extends Function>(func: T, timeFrame: number) {
  let lastTime = 0;
  return function () {
      const now = Number(new Date());
      if (now - lastTime >= timeFrame) {
          func.apply(this, arguments);
          lastTime = now;
      }
  };
}

export function flowPipe(...funcs: Function[]) {
  return (...props: any) => {
    return funcs.reduce((res, f) => {
      return Array.isArray(res) ? f.apply(this, res) : f(res);
    }, props);
  };
}

export function splitPipe(...funcs: Function[]) {
  return (...args) => funcs.map(function(f){
      return f(args)
    })
}


export function flow(funcs: Function[]){
  return (...args) => {
    return funcs.reduce((prev, fnc) => [fnc(...prev)], args)[0]
  }
}

export function partial(func: Function, ...boundArgs){
  return (...remainingArgs) => func(...boundArgs, ...remainingArgs)
}

export class Differ {
  static VALUE_CREATED = "created"
  static VALUE_UPDATED = "updated"
  static VALUE_DELETED = "deleted"
  static VALUE_UNCHANGED = "unchanged"

  static map = (obj1?: Record<string,any>, obj2: Record<string,any>) => {
    if (isFunction(obj1) || isFunction(obj2)) {
      throw "Invalid argument. Function given, object expected.";
    }
    if (isValue(obj1) || isValue(obj2)) {
      const change = Differ.compareArrays(obj1, obj2)
      if(change===Differ.VALUE_UNCHANGED){
        return null
      }
      return obj2 === undefined ? obj1 : obj2
      // {
      //   type: Differ.compareValues(obj1, obj2),
      //   data: obj2 === undefined ? obj1 : obj2
      // };
    }

    if (isArray(obj1) || isArray(obj2)) {
      const change = Differ.compareArrays(obj1, obj2)
      if(change===Differ.VALUE_UNCHANGED){
        return null
      }
      return Differ.getArrayDiffData(obj1, obj2);
    }

    const diff: Record<string,any> = {};
    for (const key in obj1) {

      if (isFunction(obj1[key])) {
        continue;
      }

      let value2 = undefined;
      if (obj2[key] !== undefined) {
        value2 = obj2[key];
      }

      const d = Differ.map(obj1[key], value2);
      if(d) {
        diff[key] = d
      }
    }
    for (const key in obj2) {
      if (isFunction(obj2[key]) || diff[key] !== undefined) {
        continue;
      }
      const d = Differ.map(undefined, obj2[key])
      if(d){
        diff[key] = d;
      }
    }

    return diff;

  }

  static getArrayDiffData = (arr1: any[], arr2: any[]) => {
    if (arr1 === undefined || arr2 === undefined) {
       return arr1 === undefined ? arr1 : arr2;
    }
    console.log({arr1,arr2})
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);

    const deleted = [...arr1].filter(x => !set2.has(x));

    const added = [...arr2].filter(x => !set1.has(x));

    return {
      added, deleted
    };

  }

  static compareArrays = (arr1: any[], arr2: any[]) => {
    // const set1 = new Set(arr1);
    // const set2 = new Set(arr2);
    if (isEqual(sortBy(arr1), sortBy(arr2))) {
      return Differ.VALUE_UNCHANGED;
    }
    if (arr1 === undefined) {
      return Differ.VALUE_CREATED;
    }
    if (arr2 === undefined) {
      return Differ.VALUE_DELETED;
    }
    return Differ.VALUE_UPDATED;
  }

  static compareValues = (value1: any, value2: any) => {
    if (value1 === value2) {
      return Differ.VALUE_UNCHANGED;
    }
    if (isDate(value1) && isDate(value2) && value1.getTime() === value2.getTime()) {
      return Differ.VALUE_UNCHANGED;
    }
    if (value1 === undefined) {
      return Differ.VALUE_CREATED;
    }
    if (value2 === undefined) {
      return Differ.VALUE_DELETED;
    }
    return Differ.VALUE_UPDATED;
  }
}

export default {
  intMin,
  intMax,
  compose,
  noop,
  extractThen,
  toPath,
  isFalsey,
  makeGetter,
  makeSetter,
  get,
  set,
  getAll,
  runAfter,
  throttle,
  flowPipe,
  splitPipe,
  flow,
  partial,
  Differ,
}
