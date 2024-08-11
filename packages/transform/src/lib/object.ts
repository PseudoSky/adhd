import { makeGetter } from './function'
import { isObject } from './filters'

/**
 * Returns an array of a given object's own enumerable string-keyed property [key, value] pairs.
 * @param object - The object whose enumerable string-keyed property [key, value] pairs are to be returned.
 * @returns An array of the given object's own enumerable string-keyed property [key, value] pairs.
 */
export const entries = Object.entries;

/**
 * Returns an array of a given object's own enumerable property values.
 * @param object - The object whose enumerable own property values are to be returned.
 * @returns An array of the given object's own enumerable property values.
 */
export const values = Object.values;

/**
 * Returns an array of a given object's own enumerable property names.
 * @param object - The object whose enumerable own property names are to be returned.
 * @returns An array of the given object's own enumerable property names.
 */
export const keys = Object.keys;

/**
 * Converts a JavaScript value to a JSON string.
 * @param value - The value to be converted to a JSON string.
 * @returns A JSON string representing the value.
 */
export const stringify = JSON.stringify;

/**
 * Checks if two values are equal by converting them to JSON strings and comparing.
 * @param a - The first value to compare.
 * @param b - The second value to compare.
 * @returns True if the two values are equal, false otherwise.
 */
export function isEqual(a: unknown, b: any) {
  return stringify(a) === stringify(b);
}

/**
 * Enumerates all paths of an opject
 * @param o - The first value to compare.
 * @returns Array of all primitive holding paths
 */
export function allPaths(o: any) {
  if (!o || typeof o !== 'object') return [];

  const paths: {[pathString: string]: string[]} = {};
  const stack: { obj: any, path: string[] }[] = [{ obj: o, path: [] }];

  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { obj, path } = stack.pop()!;

    if (typeof obj === 'object' && obj !== null) {
      for (const key in obj) {
        
        const nextObj = obj[key]
        // Ignore primitive arrays
        if(Array.isArray(obj) && typeof nextObj !== 'object'){
            paths[path.join('.')] = path;
        } else {
            stack.push({ obj: nextObj, path: [...path, key] });
        }
      }
    } else {
      paths[path.join('.')] = path;
    }
  }
  return Object.values(paths);
}

/**
 * Creates an object from an array of key-value pairs.
 * @param array - An iterable of key-value pairs.
 * @param loose - If true, omits entries where the value is falsy.
 * @returns An object created from the given key-value pairs.
 */
export function zipObject(array: Iterable<readonly [PropertyKey, any]>, loose = false) {
  return Object.fromEntries(array);
}

/**
 * Creates an object from separate arrays of keys and values.
 * @param keys - An array of keys.
 * @param values - A string or array of values.
 * @returns An object created from the given keys and values.
 */
export function rollObject(keys: any[], values: string | any[]) {
  if (keys.length === values.length) {
    return keys.reduce((res: any, k: any, i: number) => Object.assign(res, { [k]: values[i] }), {});
  }
}

/**
 * Creates a new object with the same properties as the given object, except for the properties specified.
 * @param object - The object to omit properties from.
 * @param keys - An iterable of keys to omit, or null/undefined to omit no keys.
 * @returns A new object with the specified keys omitted.
 */
export function omit(object: { [s: string]: unknown } | ArrayLike<unknown>, keys: Iterable<unknown> | null | undefined) {
  const keySet = new Set(keys);
  return Object.fromEntries(
    Object.entries(object).filter(([k, v]) => !keySet.has(k))
  );
}

/**
 * Creates a new object with the specified keys taken from the given object.
 * @param object - The object to pick properties from.
 * @param keys - An array of keys to pick.
 * @returns A new object with the specified keys.
 */
export function pick(object: { [x: string]: any; hasOwnProperty: (arg0: any) => any }, keys: any[]) {
  return keys.reduce((obj: { [x: string]: any }, key: string | number) => {
    if (object && key in object) {
      obj[key] = object[key];
    }
    return obj;
  }, {});
}

/**
 * An alias for the `pick` function.
 */
export const maskObject = pick;

/**
 * Checks if an object is empty.
 * @param obj - The object to check.
 * @returns True if the object is empty, false otherwise.
 */
export function isEmpty(obj: any) {
  return [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;
}

/**
 * Creates an object with boolean values from an array of keys.
 * @param arr - The array of keys.
 * @param default_value - The default value for the object properties (default is true).
 * @returns An object with boolean values for the given keys.
 */
export function toFlagMap(arr: any[], default_value = true) {
  return arr.reduce((obj: { [x: string]: boolean }, key: string | number) => {
    obj[key] = default_value;
    return obj;
  }, {});
}

/**
 * Checks if an object has a specific key.
 * @param obj - The object to check.
 * @param key - The key to check for.
 * @returns True if the object has the specified key, false otherwise.
 */
export function has(obj: Record<string, any>, key?: string) {
  return key && key in obj;
}

/**
 * Checks if an object has all the specified keys.
 * @param obj - The object to check.
 * @param keys - An array of keys to check for.
 * @returns True if the object has all the specified keys, false otherwise.
 */
export function hasAll(obj: Record<string, any>, keys: string[] = []) {
  return keys.reduce((r, k) => r && k in obj, true);
}

/**
 * Groups an array of objects by the specified properties.
 * @param arr - The array of objects to group.
 * @param props - The properties to group by.
 * @returns An array of grouped objects.
 */
export function groupBy(arr: any[], props: string[]) {
  return Object.values(arr.reduce((res, e) => {
    const vals = props.map(makeGetter(undefined, e));
    const k = vals.join(':');
    res[k] = res[k] || { ...rollObject(props, vals), children: [] };
    res[k].children.push(e);
    res[k].size = res[k].children.length;
    return res;
  }, {}));
}

/**
 * Creates an array of key-value pairs from an object.
 * @param object - The object to unzip.
 * @param loose - If true, omits entries where the value is falsy.
 * @returns An array of key-value pairs.
 */
export function unZipObject(object: Record<string, any>, loose = false) {
  return Object.keys(object).reduce((res: [string, any][], key) => {
    if (loose || (key in object && object[key])) {
      res.push([key, object[key]]);
    }
    return res;
  }, []);
}

/**
 * Checks if two objects are deeply equal.
 * @param object1 - The first object to compare.
 * @param object2 - The second object to compare.
 * @returns True if the objects are deeply equal, false otherwise.
 */
export function deepEquals(object1: any, object2: any) {
  return JSON.stringify(object1) === JSON.stringify(object2);
}

/**
 * Creates a deep copy of an object.
 * @param object1 - The object to copy.
 * @returns A deep copy of the object.
 */
export function deepCopy(object1: any) {
  return JSON.parse(JSON.stringify(object1));
}

/**
 * Calculates the difference between two objects.
 * @param _object - The object to compare.
 * @param _base - The base object to compare against.
 * @returns A new object representing the difference between the two objects.
 */
export function difference<T extends Record<string|number, any>>(_object: T, _base: any) {
  function changes(object: T, base: { [x: string]: any }, _res: Record<string, any> = {}) {
    return Object.entries(object).reduce(
      function (result, [key, value]) {
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
  allPaths,
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
