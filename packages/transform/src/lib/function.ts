import { isEqual } from './object'
import { sortBy } from "./collections";
import { isFunction, isValue, isArray, isDate, isUndefined, isDefined } from './filters';

export type entryOf<o> = {
  [k in keyof o]-?: [k, Exclude<o[k], undefined>]
}[o extends readonly unknown[] ? keyof o & number : keyof o] &
  unknown

export type entriesOf<o extends object> = entryOf<o>[] & unknown

export const entriesOf = <o extends object>(o: o) =>
  Object.entries(o) as entriesOf<o>

/**
 * Represents the minimum safe integer value.
 */
export const intMin = Number.MIN_SAFE_INTEGER;
/**
 * Represents the maximum safe integer value.
 */
export const intMax = Number.MAX_SAFE_INTEGER;
/**
 * Represents a variadic callback function that takes any number of arguments.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallbackFunctionVariadic = (...args: any[]) => any;
/**
 * Represents a typed callback function that takes a specific set of parameters.
 * @typeParam Params - The type of the parameters for the callback function.
 */
export type CallbackFunctionTyped<RT, Params extends []> = (...args: Params) => RT;

/**
 * Composes a sequence of functions, where each function consumes the return value of the function that follows.
 * @param funcs - An array of callback functions to be composed.
 * @returns A new function that represents the composition of the input functions.
 */
export const compose = (...funcs: CallbackFunctionVariadic[]) =>
  funcs.reduce(
    (a, b) => (...args) => a(b(...args)),
    arg => arg
  );

/**
 * A no-operation function that returns null.
 * @returns null
 */
export function noop(){return null}

/**
 * Extracts a value from an object and passes it as an argument to a callback function.
 * @param key - The key to extract the value from.
 * @param callback - The callback function to call with the extracted value.
 * @returns A new function that, when called, will extract the value from the object and pass it to the callback.
 */
export function extractThen(key: string, callback: CallbackFunctionVariadic): (...args: Parameters<typeof callback>) => ReturnType<typeof callback> {
  return (...args) => callback(...(args.map(({[key]: value}) => value)))
}

/*
 * Traversal & transform utils
 * Set and get based on string paths
 */


const STR_PATH_REGEX = /[,[\].]+?/ // ALT from site /[,[\]]+?/
/**
 * Converts a string or an array of strings into an array of individual path segments.
 * @param path - The string or array of strings to be converted.
 * @returns An array of path segments.
 */
export function toPath(path: string | string[]): string[]{
  return typeof path==='string' ? path.split(STR_PATH_REGEX)
                                .filter(Boolean) : path

}

// TODO falsey is unclear - seems like it's actually doing the opposite
/**
 * Checks if a value is falsey (not null and not undefined).
 * @param obj - The value to check.
 * @returns True if the value is falsey, false otherwise.
 */
export function isFalsey (obj: any){
  return obj !== null && obj !== undefined
}

/**
 * Checks if an object exists (is not null and not undefined).
 * @param obj - The object to check.
 * @returns True if the object exists, false otherwise.
 */
export function doesObjectExists (obj: any){
  return !!obj && obj !== null && obj !== undefined;
}

/**
 * Creates a getter function for accessing values in an object using a string path.
 * @param _path - The string path to the value.
 * @param obj - The object to get the value from.
 * @returns A function that, when called, will retrieve the value at the specified path.
 */
export function makeGetter(_path?: string, obj?: any): (value?: any) => any  {
  // TODO: see https://github.com/g-makarov/dot-path-value/blob/main/src/index.ts
  //       for future typing
  if(!obj){
    return (_obj: any) => makeGetter(_path, _obj)()
  }
  if(!_path) {
    return (path: string) => makeGetter(path, obj)()
  }
  const path=toPath(_path)
  if(!path.length) return (value: any) => obj||value
  return (value: any) => path.reduce(
    (previous, key: string, index: number) => {
      const res = previous;
      const field = key.replace(/(^")|("$)/g,'') as keyof typeof res
      const isEnd = index === path.length-1
      if(!isEnd){
        const nextType = !Number.isNaN(parseInt(path[index+1])) ? []: {};
        if(!(field in res)){
          res[field] = nextType
        }
        return res[field]
      }
      // TODO: this had a bug for number values of 0 needs more testing
      return isUndefined(res[field]) ? value : res[field];
  }, obj )
}

/**
 * Creates a setter function for setting values in an object using a string path.
 * @param _path - The string path to the value.
 * @param obj - The object to set the value in.
 * @returns A function that, when called with a value, will set the value at the specified path.
 */
export function makeSetter(_path: string, obj?: any)  {
  const path=toPath(_path)
  if(!path.length) return (defaultValue: any) => obj||defaultValue
  return (value: any) => path.reduce(
    (previous, key: string, index: number) => {
      const res = previous;
      const field = key.replace(/(^")|("$)/g,'') as keyof typeof res
      const isEnd = index === path.length-1
      if(!isEnd){
        const nextType = !Number.isNaN(parseInt(path[index+1])) ? []: {};
        if(!(field in res)){
          res[field] = nextType
        }
      }
      if(isEnd){
        res[field] = value
        return obj
      }
      return res[field];
  }, obj)
}

/**
 * Retrieves a value from an object using a string path.
 * @param obj - The object to get the value from.
 * @param path - The string path to the value.
 * @param defaultValue - The default value to return if the path does not exist.
 * @returns The value at the specified path, or the default value if the path does not exist.
 */
export function get(obj: any, path: string, defaultValue: any = undefined) {
  return makeGetter(path, obj)(defaultValue);
}

/**
 * Sets a value in an object using a string path.
 * @param data - The object to set the value in.
 * @param path - The string path to the value.
 * @param value - The value to set.
 * @returns The updated object.
 */
export function set(data: any, path: string, value: any) {
  return makeSetter(path, data)(value);
}

/**
 * Retrieves the values at multiple paths in an object.
 * @param obj - The object to get the values from.
 * @param paths - An array of string paths to the values.
 * @param into - An optional array to store the retrieved values in.
 * @returns An array of the retrieved values.
 */
export function getAll(obj: any, paths: string[], into: any[] = []) {
  return paths.reduce((res, path) => {
    const value = get(obj, path, undefined);
    return res.concat([value]);
  }, into);
}

/* end traversal utils */


/*
 * Function modifiers
 */

export function runAfter(f: CallbackFunctionVariadic, t: number) {
  return function (...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return setTimeout(() => f.apply(self, args), t);
  };
}

export function throttle<T extends CallbackFunctionVariadic>(func: T, timeFrame: number) {
  let lastTime = 0;
  return function (...args: Parameters<T>) {
      const now = Number(new Date());
      if (now - lastTime >= timeFrame) {
          func.apply(this, args);
          lastTime = now;
      }
  };
}

export function flowPipe(...funcs: CallbackFunctionVariadic[]) {
  return (...props: any) => {
    return funcs.reduce((res, f) => {
      return Array.isArray(res) ? f.apply(this, res) : f(res);
    }, props);
  };
}

export function splitPipe(...funcs: CallbackFunctionVariadic[]) {
  return (...args: Parameters<typeof funcs[0]>) => funcs.map(function(f){
      return f(args)
    })
}

export function flow(funcs: CallbackFunctionVariadic[]){
  return (...args: Parameters<typeof funcs[0]>) => {
    return funcs.reduce((prev, fnc) => [fnc(...prev)], args)[0]
  }
}

export function partial<F extends CallbackFunctionVariadic>(func: CallbackFunctionVariadic, ...boundArgs: Parameters<F>){
  return (...remainingArgs: Parameters<F>) => func(...boundArgs, ...remainingArgs)
}

export class Differ {
  static VALUE_CREATED = "created"
  static VALUE_UPDATED = "updated"
  static VALUE_DELETED = "deleted"
  static VALUE_UNCHANGED = "unchanged"

  static map = <O1=Record<string,any> | any[],O2=Record<string,any> | any[]>(obj1?: O1, obj2?: O2) => {
    if (isFunction(obj1) || isFunction(obj2)) {
      throw "Invalid argument. Function given, object expected.";
    }
    
    // TODO: looks like this will short circuit the rest of the func (array is value)
    if (isValue(obj1) || isValue(obj2)) {
      const change = Differ.compareArrays(obj1 as any[], obj2 as any[])
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
      const change = Differ.compareArrays((obj1 as any[]), obj2 as any[])
      if(change===Differ.VALUE_UNCHANGED){
        return null
      }
      return Differ.getArrayDiffData(obj1 as any[], obj2 as any[]);
    }

    const diff: Record<string,any> = {};
    for (const key in obj1) {

      if (isFunction(obj1[key as keyof typeof obj1])) {
        continue;
      }

      let value2 = undefined;
      if (obj2 && obj2[key as keyof O2] !== undefined) {
        value2 = obj2[key as keyof O2];
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
