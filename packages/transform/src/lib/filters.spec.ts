/* eslint-disable @typescript-eslint/no-empty-function */
import {
  isEqual,
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
  isObject,
  isRegExp,
  isShallowEqual,
  isTrue,
  isUndefined,
  isValue,
  isArray,
  isDate,
  isDefined,
  isEmpty,
  isNumber,
  isString,
  isType,
  isNotEqual,
} from './filters';

describe('ts', () => {
  describe('isEqual', () => {
    it('should correctly identify equal values', () => {
      expect(isEqual(42, 42)).toBe(true);
      expect(isEqual('hello', 'hello')).toBe(true);
      expect(isEqual(new Date(), new Date())).toBe(true);
      expect(isEqual({}, {})).toBe(true);
      expect(isEqual([], [])).toBe(true);
      expect(isEqual(2, 42)).toBe(false);
      expect(isEqual('ello', 'hello')).toBe(false);
      expect(isEqual('', new Date())).toBe(false);
      expect(isEqual({a:1}, {})).toBe(false);
      expect(isEqual([1], [])).toBe(false);
      expect(isEqual([], {})).toBe(false);
      expect(isEqual({}, [])).toBe(false);
    });
  });
  describe('isNotEqual', () => {
    it('should correctly identify not equal values', () => {
      expect(isNotEqual(42, 42)).toBe(false);
      expect(isNotEqual('hello', 'hello')).toBe(false);
      expect(isNotEqual(new Date(), new Date())).toBe(false);
      expect(isNotEqual({}, {})).toBe(false);
      expect(isNotEqual([], [])).toBe(false);
      expect(isNotEqual(2, 42)).toBe(true);
      expect(isNotEqual('ello', 'hello')).toBe(true);
      expect(isNotEqual('', new Date())).toBe(true);
      expect(isNotEqual({a:1}, {})).toBe(true);
      expect(isNotEqual([1], [])).toBe(true);
      expect(isNotEqual([], {})).toBe(true);
      expect(isNotEqual({}, [])).toBe(true);
    });
  });

  describe('isFalse', () => {
    it('should correctly identify false values', () => {
      expect(isFalse(false)).toBe(true);
      expect(isFalse(0)).toBe(false);
      expect(isFalse('')).toBe(false);
      expect(isFalse(null)).toBe(false);
      expect(isFalse(undefined)).toBe(false);
    });
  });

  describe('isFloat', () => {
    it('should correctly identify float values', () => {
      expect(isFloat(3.14)).toBe(true);
      expect(isFloat(42)).toBe(false);
      expect(isFloat('3.14')).toBe(false);
      expect(isFloat(null)).toBe(false);
      expect(isFloat(undefined)).toBe(false);
    });
  });

  describe('isFunction', () => {
    it('should correctly identify function values', () => {
      expect(isFunction(() => {})).toBe(true);
      expect(isFunction(42)).toBe(false);
      expect(isFunction('hello')).toBe(false);
      expect(isFunction(new Date())).toBe(false);
      expect(isFunction(null)).toBe(false);
      expect(isFunction(undefined)).toBe(false);
    });
  });

  describe('isGreaterThan', () => {
    it('should correctly identify greater than relationships', () => {
      expect(isGreaterThan(5, 3)).toBe(true);
      expect(isGreaterThan(3, 5)).toBe(false);
      expect(isGreaterThan(3, 3)).toBe(false);
    });
  });

  describe('isGreaterThanOrEqual', () => {
    it('should correctly identify greater than or equal relationships', () => {
      expect(isGreaterThanOrEqual(5, 3)).toBe(true);
      expect(isGreaterThanOrEqual(3, 5)).toBe(false);
      expect(isGreaterThanOrEqual(3, 3)).toBe(true);
    });
  });

  describe('isILike', () => {
    it('should correctly identify case-insensitive string matches', () => {
      expect(isILike('hello', 'HELLO')).toBe(true);
      expect(isILike('HELLO', 'hello')).toBe(true);
      expect(isILike('hello', 'world')).toBe(false);
    });
  });

  describe('isIn', () => {
    it('should correctly identify if a value is in an array', () => {
      expect(isIn('a', ['a', 'b', 'c'])).toBe(true);
      expect(isIn('d', ['a', 'b', 'c'])).toBe(false);
    });
  });

  describe('isInt', () => {
    it('should correctly identify integer values', () => {
      expect(isInt(42)).toBe(true);
      expect(isInt(3.14)).toBe(false);
      expect(isInt('42')).toBe(false);
      expect(isInt(null)).toBe(false);
      expect(isInt(undefined)).toBe(false);
    });
  });

  describe('isLessThan', () => {
    it('should correctly identify less than relationships', () => {
      expect(isLessThan(3, 5)).toBe(true);
      expect(isLessThan(5, 3)).toBe(false);
      expect(isLessThan(3, 3)).toBe(false);
    });
  });

  describe('isLessThanOrEqual', () => {
    it('should correctly identify less than or equal relationships', () => {
      expect(isLessThanOrEqual(3, 5)).toBe(true);
      expect(isLessThanOrEqual(5, 3)).toBe(false);
      expect(isLessThanOrEqual(3, 3)).toBe(true);
    });
  });

  describe('isLike', () => {
    it('should correctly identify string matches', () => {
      expect(isLike('hello', 'hello')).toBe(true);
      expect(isLike('hello', 'HELLO')).toBe(false);
      expect(isLike('hello', 'world')).toBe(false);
    });
  });

  describe('isNotILike', () => {
    it('should correctly identify case-insensitive string non-matches', () => {
      expect(isNotILike('hello', 'HELLO')).toBe(false);
      expect(isNotILike('HELLO', 'hello')).toBe(false);
      expect(isNotILike('hello', 'world')).toBe(true);
    });
  });

  describe('isNotIn', () => {
    it('should correctly identify if a value is not in an array', () => {
      expect(isNotIn('d', ['a', 'b', 'c'])).toBe(true);
      expect(isNotIn('a', ['a', 'b', 'c'])).toBe(false);
    });
  });

  describe('isNotLike', () => {
    it('should correctly identify string non-matches', () => {
      expect(isNotLike('hello', 'hello')).toBe(false);
      expect(isNotLike('hello', 'HELLO')).toBe(true);
      expect(isNotLike('hello', 'world')).toBe(true);
    });
  });

  describe('isNotShallowEqual', () => {
    it('should correctly identify non-shallow equality', () => {
      const a = { a: 1 }
      expect(isNotShallowEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(isNotShallowEqual(a, a)).toBe(false);
    });
  });

  describe('isNull', () => {
    it('should correctly identify null values', () => {
      expect(isNull(null)).toBe(true);
      expect(isNull(undefined)).toBe(false);
      expect(isNull(0)).toBe(false);
      expect(isNull('')).toBe(false);
    });
  });

  describe('isNumber', () => {
    it('should correctly identify number values', () => {
      expect(isNumber(42)).toBe(true);
      expect(isNumber('42')).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
    });
  });

  describe('isObject', () => {
    it('should correctly identify object values', () => {
      expect(isObject({})).toBe(true);
      expect(isObject([])).toBe(false);
      expect(isObject(42)).toBe(false);
      expect(isObject('hello')).toBe(false);
      expect(isObject(null)).toBe(false);
      expect(isObject(undefined)).toBe(false);
    });
  });

  describe('isRegExp', () => {
    it('should correctly identify regular expression values', () => {
      expect(isRegExp(/pattern/)).toBe(true);
      expect(isRegExp(new RegExp('pattern'))).toBe(true);
      expect(isRegExp(42)).toBe(false);
      expect(isRegExp('hello')).toBe(false);
      expect(isRegExp(null)).toBe(false);
      expect(isRegExp(undefined)).toBe(false);
    });
  });

  describe('isShallowEqual', () => {
    it('should correctly identify shallow equality', () => {
      const a = { a: 1 }
      expect(isShallowEqual(a, a)).toBe(true);
      expect(isShallowEqual({ a: 1 }, { a: 1 })).toBe(false);
    });
  });

  describe('isString', () => {
    it('should correctly identify string values', () => {
      expect(isString('hello')).toBe(true);
      expect(isString(42)).toBe(false);
      expect(isString(new Date())).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
    });
  });

  describe('isTrue', () => {
    it('should correctly identify true values', () => {
      expect(isTrue(true)).toBe(true);
      expect(isTrue(1)).toBe(false);
      expect(isTrue('true')).toBe(false);
      expect(isTrue(null)).toBe(false);
      expect(isTrue(undefined)).toBe(false);
    });
  });

  describe('isUndefined', () => {
    it('should correctly identify undefined values', () => {
      expect(isUndefined(undefined)).toBe(true);
      expect(isUndefined(null)).toBe(false);
      expect(isUndefined(0)).toBe(false);
      expect(isUndefined('')).toBe(false);
    });
  });

  describe('isValue', () => {
    it('should correctly identify values that are not null or undefined', () => {
      expect(isValue(42)).toBe(true);
      expect(isValue('hello')).toBe(true);
      expect(isValue(new Date())).toBe(true);
      expect(isValue({})).toBe(false);
      expect(isValue([])).toBe(false);
      expect(isValue(() => {})).toBe(false);
      expect(isValue(/pattern/)).toBe(false);
      expect(isValue(null)).toBe(true);
      expect(isValue(undefined)).toBe(true);
    });
  });
  describe('isArray', () => {
    it('should correctly identify arrays', () => {
      expect(isArray([])).toBe(true);
      expect(isArray({})).toBe(false);
      expect(isArray(42)).toBe(false);
      expect(isArray('hello')).toBe(false);
      expect(isArray(new Date())).toBe(false);
      expect(isArray(null)).toBe(false);
      expect(isArray(undefined)).toBe(false);
      expect(isArray(() => {})).toBe(false);
      expect(isArray(/pattern/)).toBe(false);
    });
  });

  describe('isDate', () => {
    it('should correctly identify dates', () => {
      expect(isDate(new Date())).toBe(true);
      expect(isDate({})).toBe(false);
      expect(isDate(42)).toBe(false);
      expect(isDate('hello')).toBe(false);
      expect(isDate(null)).toBe(false);
      expect(isDate(undefined)).toBe(false);
      expect(isDate([])).toBe(false);
      expect(isDate(() => {})).toBe(false);
      expect(isDate(/pattern/)).toBe(false);
    });
  });

  describe('isDefined', () => {
    it('should correctly identify defined values', () => {
      expect(isDefined(42)).toBe(true);
      expect(isDefined('hello')).toBe(true);
      expect(isDefined(new Date())).toBe(true);
      expect(isDefined({})).toBe(true);
      expect(isDefined([])).toBe(true);
      expect(isDefined(() => {})).toBe(true);
      expect(isDefined(/pattern/)).toBe(true);
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
    });
  });

  describe('isEmpty', () => {
    it('should correctly identify empty values', () => {
      expect(isEmpty({})).toBe(true);
      expect(isEmpty([])).toBe(true);
      expect(isEmpty(42)).toBe(false);
      expect(isEmpty('hello')).toBe(false);
      expect(isEmpty(new Date())).toBe(false);
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);
      expect(isEmpty(() => {})).toBe(false);
      expect(isEmpty(/pattern/)).toBe(false);
    });
  });
  describe('isType', () => {
    it('should correctly identify primitive types', () => {
      expect(isType('hello', 'String')).toBe(true);
      expect(isType(42, 'Number')).toBe(true);
      expect(isType(new Date(), 'Date')).toBe(true);
      expect(isType(null, 'Null')).toBe(true);
      expect(isType(undefined, 'Undefined')).toBe(true);
      expect(isType([], 'Array')).toBe(true);
      expect(isType({}, 'Object')).toBe(true);
      expect(isType(() => {}, 'Function')).toBe(true);
      expect(isType(/pattern/, 'RegExp')).toBe(true);
    });

    it('should correctly identify non-primitive types', () => {
      expect(isType(42, 'String')).toBe(false);
      expect(isType('hello', 'Number')).toBe(false);
      expect(isType(new Date(), 'Null')).toBe(false);
      expect(isType(null, 'Undefined')).toBe(false);
      expect(isType({}, 'Array')).toBe(false);
      expect(isType([], 'Object')).toBe(false);
      expect(isType(42, 'Function')).toBe(false);
      expect(isType(() => {}, 'RegExp')).toBe(false);
    });
  });

  describe('isString', () => {
    it('should correctly identify strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString(42)).toBe(false);
      expect(isString(new Date())).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString([])).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString(() => {})).toBe(false);
      expect(isString(/pattern/)).toBe(false);
    });
  });

  describe('isNumber', () => {
    it('should correctly identify numbers', () => {
      expect(isNumber(42)).toBe(true);
      expect(isNumber('hello')).toBe(false);
      expect(isNumber(new Date())).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
      expect(isNumber([])).toBe(false);
      expect(isNumber({})).toBe(false);
      expect(isNumber(() => {})).toBe(false);
      expect(isNumber(/pattern/)).toBe(false);
    });
  });
  // describe('filters', () => {
    // expect(isArray(undefined)).toEqual(false)
    // expect(isDate(undefined)).toEqual(false)
    // expect(isDefined(undefined)).toEqual(false)
    // expect(isEmpty(9)).toEqual(false)
    // expect(isEmpty(undefined)).toEqual(true);
    // expect(isEqual(undefined, 1)).toEqual(false)
    // expect(isFalse(undefined)).toEqual(false)
    // expect(isFunction(undefined)).toEqual(false)
    // expect(isGreaterThan(0,0)).toEqual(false)
    // expect(isGreaterThanOrEqual(-1,1)).toEqual(false)
    // expect(isILike('a', 'A')).toEqual(true)
    // expect(isNotILike('a', 'A')).toEqual(false);
    // expect(isLike('a', 'A')).toEqual(false);
    // expect(isNotLike('a', 'a')).toEqual(false);
    // expect(isIn("a", "aaa")).toEqual(true)
    // expect(isNotIn("a", ["A"])).toEqual(true)
    // expect(isInt(undefined)).toEqual(false)
    // expect(isLessThan(1,0)).toEqual(false)
    // expect(isLessThanOrEqual(1,0)).toEqual(false)
    // expect(isNotShallowEqual(undefined, undefined)).toEqual(false)
    // expect(isNull(undefined)).toEqual(false)
    // expect(isNumber(undefined)).toEqual(false)
    // expect(isObject(undefined)).toEqual(false)
    // expect(isRegExp(undefined)).toEqual(false)
    // expect(isShallowEqual(undefined, 1)).toEqual(false)
    // expect(isString(undefined)).toEqual(false)
    // expect(isTrue(undefined)).toEqual(false)
    // expect(isType("a", "string")).toEqual(false)
    // expect(isUndefined(9)).toEqual(false)
    // expect(isValue(undefined)).toEqual(true)
    // expect(isValue({})).toEqual(false)
    // expect(isValue(() => null)).toEqual(false)
    // expect(isFloat(undefined)).toEqual(false)
    // expect(isFloat(9.1)).toEqual(true)
    // expect(isFloat(9)).toEqual(false)
    // expect(isFloat(9.0)).toEqual(false)
  // });
});
