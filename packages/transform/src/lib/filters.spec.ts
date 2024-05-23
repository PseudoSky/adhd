import filters from './filters';

describe('transforms', () => {
  it('should work', () => {
    expect(filters.isArray(undefined)).toEqual(false)
    expect(filters.isDate(undefined)).toEqual(false)
    expect(filters.isDefined(undefined)).toEqual(false)
    expect(filters.isEmpty(9)).toEqual(false)
    expect(filters.isEmpty(undefined)).toEqual(true);
    expect(filters.isEqual(undefined, 1)).toEqual(false)
    expect(filters.isFalse(undefined)).toEqual(false)
    expect(filters.isFunction(undefined)).toEqual(false)
    expect(filters.isGreaterThan(0,0)).toEqual(false)
    expect(filters.isGreaterThanOrEqual(-1,1)).toEqual(false)
    expect(filters.isILike('a', 'A')).toEqual(true)
    expect(filters.isNotILike('a', 'A')).toEqual(false);
    expect(filters.isLike('a', 'A')).toEqual(false);
    expect(filters.isNotLike('a', 'a')).toEqual(false);
    expect(filters.isIn("a", "aaa")).toEqual(true)
    expect(filters.isNotIn("a", ["A"])).toEqual(true)
    expect(filters.isInt(undefined)).toEqual(false)
    expect(filters.isLessThan(1,0)).toEqual(false)
    expect(filters.isLessThanOrEqual(1,0)).toEqual(false)
    expect(filters.isNotShallowEqual(undefined, undefined)).toEqual(false)
    expect(filters.isNull(undefined)).toEqual(false)
    expect(filters.isNumber(undefined)).toEqual(false)
    expect(filters.isObject(undefined)).toEqual(false)
    expect(filters.isRegExp(undefined)).toEqual(false)
    expect(filters.isShallowEqual(undefined, 1)).toEqual(false)
    expect(filters.isString(undefined)).toEqual(false)
    expect(filters.isTrue(undefined)).toEqual(false)
    expect(filters.isType("a", "string")).toEqual(false)
    expect(filters.isUndefined(9)).toEqual(false)
    expect(filters.isValue(undefined)).toEqual(true)
    expect(filters.isValue({})).toEqual(false)
    expect(filters.isValue(() => null)).toEqual(false)
    expect(filters.isFloat(undefined)).toEqual(false)
    expect(filters.isFloat(9.1)).toEqual(true)
    expect(filters.isFloat(9)).toEqual(false)
    expect(filters.isFloat(9.0)).toEqual(false)
  });
});
