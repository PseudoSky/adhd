/* SECTION: typechecks */
type Expand<T> = T extends any ? T : T;
type ValueType = string | number | boolean | null | undefined | Date
type PrimitiveTypes = ValueType | readonly unknown[] | Record<string, unknown> | ((...args: unknown[]) => void) | RegExp

type TsTypeMap = {
  String: string;
  Number: number;
  Date: Date;
  Null: null;
  Undefined: undefined;
  Boolean: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array: readonly unknown[]
  Object: Record<string, unknown>
  Function: (...args: unknown[]) => unknown;
  RegExp: RegExp;
}
type TSTypes = keyof TsTypeMap;

const TypeMap: Record<TSTypes, string> = {
  String: "[object String]",
  Number: "[object Number]",
  Date: "[object Date]",
  Null: "[object Null]",
  Undefined: "[object Undefined]",
  Boolean: '[object Boolean]',
  Array: "[object Array]",
  Object: "[object Object]",
  Function: "[object Function]",
  RegExp: "[object RegExp]",
}

export function isType<T extends TSTypes>(x: unknown, type: T): x is TsTypeMap[T] { return Object.prototype.toString.call(x) === TypeMap[type] }
export function isBoolean(x: unknown) { return isType(x, 'Boolean'); }
export function isString(x: unknown) { return isType(x, 'String'); }
export function isNumber(x: unknown) { return isType(x, 'Number'); }
export function isDate(x: unknown) { return isType(x, 'Date'); }
export function isNull(x: unknown) { return isType(x, 'Null') && x === null; }
export function isUndefined(x: unknown) { return isType(x, 'Undefined') && x === undefined; }
export function isArray(x: unknown) { return isType(x, 'Array'); }
export function isObject(x: unknown) { return isType(x, 'Object'); }
export function isFunction(x: unknown) { return isType(x, 'Function'); }
export function isRegExp(x: unknown) { return isType(x, 'RegExp'); }
export function isDefined(x: unknown): x is Exclude<PrimitiveTypes, null | undefined> { return x !== null && x !== undefined }
export function isInt(x: unknown): x is number { return isNumber(x) && Number.isInteger(x) }
export function isFloat(x: unknown): x is number { return isNumber(x) && !Number.isInteger(x) && Number.isFinite(x); }
// Currently undefined and nulls are considered values
// eslint-disable-next-line @typescript-eslint/ban-types
export function isValue(x: unknown): x is Expand<ValueType> & {} {
  return (
    isString(x) ||
    isNumber(x) ||
    isDate(x) ||
    isNull(x) ||
    isUndefined(x) ||
    isBoolean(x)
  )
}

/* SECTION: comparisons */
export function isTrue(a: unknown) {
  return a === true
}
export function isFalse(a: unknown) {
  return a === false;
}
export function isLessThan(a: number, b: number) {
  return a < b
}
export function isGreaterThan(a: number, b: number) {
  return a > b
}
export function isLessThanOrEqual(a: number, b: number) {
  return (a <= b)
}
export function isGreaterThanOrEqual(a: number, b: number) {
  return a >= b;
}
export function isShallowEqual(a: unknown, b: unknown) {
  return a === b
}
export function isIn(a: unknown, b: string | unknown[]): boolean {
  if (isArray(b)) {
    return b.includes(a)
  } else if (isString(b)) {
    return b.includes(`${a}`)
  }
  return false
}

// TODO: consider adding regex support for like/ilike patterns
export function isLike(a: string, b: string) {
  return isDefined(a) && isDefined(b) && a.includes(b)
}
// TODO: consider adding regex support for like/ilike patterns
export function isILike(a: string, b: string) {
  return isDefined(a) && isDefined(b) && isIn(b.toLowerCase(), a.toLowerCase())
}

/* SECTION: comparisons: not */
export function isNotShallowEqual(a: unknown, b: unknown) {
  return a !== b
}
export function isNotIn(a: unknown, b: unknown[]): boolean
export function isNotIn(a: unknown, b: string | unknown[]): boolean {
  return !isIn(a, b)
}
export function isNotLike(a: string, b: string) {
  return !isLike(a, b)
}
export function isNotILike(a: string, b: string) {
  return !isILike(a, b)
}


export function isEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}
export function isNotEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) !== JSON.stringify(b)
}
// TODO: Currently only checks if the value is an empty object or array, not if it's an empty string, null, or undefined. Consider whether this is the desired behavior.
export function isEmpty(obj: unknown) {
  if (isUndefined(obj) || isNull(obj)) return true;
  return (isObject(obj) || isArray(obj)) && !Object.entries((obj || {})).length
}

export default {
  isArray,
  isDate,
  isBoolean,
  isDefined,
  isEmpty,
  isEqual,
  isNotEqual,
  isFalse,
  isFloat,
  isFunction,
  isGreaterThan,
  isGreaterThanOrEqual,
  isILike,
  isIn,
  isInt,
  isLessThan,
  isLessThanOrEqual,
  isLike,
  isNotILike,
  isNotIn,
  isNotLike,
  isNotShallowEqual,
  isNull,
  isNumber,
  isObject,
  isRegExp,
  isShallowEqual,
  isString,
  isTrue,
  isType,
  isUndefined,
  isValue,
};
