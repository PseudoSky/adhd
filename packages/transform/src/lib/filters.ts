/* SECTION: typechecks */
type PrimitiveTypes = string|number|Date|null|undefined|any[]|object|((...args: any[]) => void)|RegExp

const TypeMap: {[type: string]: string} = {
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

export function isType(x: any,type: keyof (typeof TypeMap)) { return Object.prototype.toString.call(x)===TypeMap[type] }
export function isString(x: any)    { return isType(x, 'String');    }
export function isNumber(x: any)    { return isType(x, 'Number');    }
export function isDate(x: any)      { return isType(x, 'Date');      }
export function isNull(x: any)      { return isType(x, 'Null');      }
export function isUndefined(x: any) { return isType(x, 'Undefined'); }
export function isArray(x: any)     { return isType(x, 'Array');     }
export function isObject(x: any)    { return isType(x, 'Object');    }
export function isFunction(x: any)  { return isType(x, 'Function');  }
export function isRegExp(x: any)    { return isType(x, 'RegExp');    }
export function isDefined(x: any)   { return (isUndefined(x) || isNull(x))===false        }
export function isInt(x: any)       { return (isNumber(x) && Number.isInteger(x))===true  }
export function isFloat(x: any)     { return (isDefined(x) && (isNumber(x) && Number.isInteger(x) === false)); }
// Currently undefined and nulls are considered values
export function isValue(x: any)     { return (isObject(x) || isArray(x) || isFunction(x) || isRegExp(x))===false;         }

/* SECTION: comparisons */
export function isTrue(a: any){
  return a===true
}
export function isFalse(a: any) {
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
export function isShallowEqual(a: any, b: any) {
  return a===b
}
export function isIn(a: any, b: string | any[]): boolean {
  return isDefined(b) && b.includes(a);
}
export function isLike(a: string, b: string) {
  return isDefined(a) && isDefined(b) && a.includes(b)
}
export function isILike(a: string, b: string) {
  return isDefined(a) && isDefined(b) && isIn(b.toLowerCase(), a.toLowerCase())
}

/* SECTION: comparisons: not */
export function isNotShallowEqual(a: any, b: any) {
  return a!==b
}
export function isNotIn(a: any, b: any[]): boolean
export function isNotIn(a: string, b: string | any[]): boolean {
  return !isIn(a, b)
}
export function isNotLike(a: string, b: string) {
  return !isLike(a, b)
}
export function isNotILike(a: string, b: string) {
  return !isILike(a,b)
}


export function isEqual(a: any, b: any){
  return JSON.stringify(a)===JSON.stringify(b)
}
export function isNotEqual(a: any, b: any){
  return JSON.stringify(a)!==JSON.stringify(b)
}

export function isEmpty(obj: any){
  return [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;
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
