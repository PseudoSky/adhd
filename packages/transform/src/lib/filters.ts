/* SECTION: typechecks */
type PrimitiveTypes = string | boolean | number | Date | null | undefined | unknown[] | object | ((...args: any[]) => void) | RegExp

const TypeMap: { [type: string]: string } = {
  String: "[object String]",
  Number: "[object Number]",
  Date: "[object Date]",
  Null: "[object Null]",
  Undefined: "[object Undefined]",
  Array: "[object Array]",
  Object: "[object Object]",
  Function: "[object Function]",
  RegExp: "[object RegExp]",
}

export function isType(x: PrimitiveTypes, type: keyof (typeof TypeMap)) { return Object.prototype.toString.call(x) === TypeMap[type] }
export function isString(x: PrimitiveTypes) { return isType(x, 'String'); }
export function isNumber(x: PrimitiveTypes) { return isType(x, 'Number'); }
export function isDate(x: PrimitiveTypes) { return isType(x, 'Date'); }
export function isNull(x: PrimitiveTypes) { return isType(x, 'Null'); }
export function isUndefined(x: PrimitiveTypes) { return isType(x, 'Undefined'); }
export function isArray(x: PrimitiveTypes) { return isType(x, 'Array'); }
export function isObject(x: PrimitiveTypes) { return isType(x, 'Object'); }
export function isFunction(x: PrimitiveTypes) { return isType(x, 'Function'); }
export function isRegExp(x: PrimitiveTypes) { return isType(x, 'RegExp'); }
export function isDefined(x: PrimitiveTypes) { return (isUndefined(x) || isNull(x)) === false }
export function isInt(x: PrimitiveTypes) { return (isNumber(x) && Number.isInteger(x)) === true }
export function isFloat(x: PrimitiveTypes) { return (isDefined(x) && (isNumber(x) && Number.isInteger(x) === false)); }
// Currently undefined and nulls are considered values
export function isValue(x: PrimitiveTypes) { return (isObject(x) || isArray(x) || isFunction(x) || isRegExp(x)) === false; }

/* SECTION: comparisons */
export function isTrue(a: PrimitiveTypes) {
  return a === true
}
export function isFalse(a: PrimitiveTypes) {
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
export function isShallowEqual(a: PrimitiveTypes, b: PrimitiveTypes) {
  return a === b
}
export function isIn(a: PrimitiveTypes, b: string | PrimitiveTypes[]): boolean {
  // @ts-expect-error b for some reason thinks it can only look for a string (not true)
  return isDefined(b) && b.includes(a);
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
export function isNotShallowEqual(a: PrimitiveTypes, b: PrimitiveTypes) {
  return a !== b
}
export function isNotIn(a: PrimitiveTypes, b: PrimitiveTypes[]): boolean
export function isNotIn(a: PrimitiveTypes, b: string | PrimitiveTypes[]): boolean {
  return !isIn(a, b)
}
export function isNotLike(a: string, b: string) {
  return !isLike(a, b)
}
export function isNotILike(a: string, b: string) {
  return !isILike(a, b)
}


export function isEqual(a: PrimitiveTypes, b: PrimitiveTypes) {
  return JSON.stringify(a) === JSON.stringify(b)
}
export function isNotEqual(a: PrimitiveTypes, b: PrimitiveTypes) {
  return JSON.stringify(a) !== JSON.stringify(b)
}
// TODO: Currently only checks if the value is an empty object or array, not if it's an empty string, null, or undefined. Consider whether this is the desired behavior.
export function isEmpty(obj: PrimitiveTypes) {
  if (isUndefined(obj) || isNull(obj)) return true;
  return (isObject(obj) || isArray(obj)) && !Object.entries((obj || {})).length
}

export default {
  isArray,
  isDate,
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
