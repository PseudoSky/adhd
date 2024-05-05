
import {
  difference,
  intersection,
  flattenDeep,
  keyByArray,
  keyBy,
  sortByKey,
  sortBy,
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
  reverseSort,
  first,
  last,
  sortByProp,
  maxByProp,
  minByProp,
  filterExclude,
  filterInclude,
  // groupByProp,
  unique,
  uniqueByProp,
  uniqueBy,
  indexBy,
  rangeByProp,
  rangeByProps,
  range,
} from './collections';






const ObjSample = {"key": "value"}
const ArrEx = [0,2,1,4,5,3];
const ArrShift = ArrEx.map(e => e+3);
const CollectionEx = ArrEx.map(i => ({...ObjSample, "sort": i, nested: ObjSample}))

describe('transforms', () => {
  it('should work', () => {
    const cmp = (a,b): 0|-1|1 => (a<b)? 1 : -1;
    const compare = (a,b) => (a>b)? 1 : -1;
    const check = (a,b) => (a===b)? 1 : -1;
    const boolCheck = (a) => (!!a ? true : false);
    // const checkIsArray = () =>
    const checks = [cmp, compare, check];
    const a = 10;
    const b = -10;
    const step = 1;
    const start = -10;
    const stop = 10;

    const arr = ArrEx;
    const array = ArrShift;
    const arrays = [ArrEx, ArrShift];
    const collection = CollectionEx;

    const obj = ObjSample;
    const orig = ObjSample;
    const props = ["sort", "key"];

    const key = "key";
    const prop = "sort";
    const target = {"key": "value", "sort": 5};
    const selector = "sort";
    expect(difference(arrays)).toEqual([0,2,1]);
    expect(intersection(arrays)).toEqual([4,5,3]);
    expect(flattenDeep([[1, [4, [1], [null]]]])).toEqual([1, 4, 1, null]);
    expect(keyByArray(CollectionEx, 'sort')).toEqual({
      '0': { key: 'value', nested: { key: 'value' }, sort: 0 },
      '1': { key: 'value', nested: { key: 'value' }, sort: 1 },
      '2': { key: 'value', nested: { key: 'value' }, sort: 2 },
      '3': { key: 'value', nested: { key: 'value' }, sort: 3 },
      '4': { key: 'value', nested: { key: 'value' }, sort: 4 },
      '5': { key: 'value', nested: { key: 'value' }, sort: 5 },
    });
    expect(keyBy(collection, 'sort')).toEqual({
      '0': { key: 'value', nested: { key: 'value' }, sort: 0 },
      '1': { key: 'value', nested: { key: 'value' }, sort: 1 },
      '2': { key: 'value', nested: { key: 'value' }, sort: 2 },
      '3': { key: 'value', nested: { key: 'value' }, sort: 3 },
      '4': { key: 'value', nested: { key: 'value' }, sort: 4 },
      '5': { key: 'value', nested: { key: 'value' }, sort: 5 },
    });
    expect(collection.sort(sortByKey(prop)).map(e => e[prop])).toEqual([0,1,2,3,4,5]);
    expect(
      sortBy(
        collection,
        key,
        (a: string, b: string) => a.localeCompare(b) as 0 | 1 | -1
      )
    ).toEqual([
      { key: 'value', nested: { key: 'value' }, sort: 0 },
      { key: 'value', nested: { key: 'value' }, sort: 1 },
      { key: 'value', nested: { key: 'value' }, sort: 2 },
      { key: 'value', nested: { key: 'value' }, sort: 3 },
      { key: 'value', nested: { key: 'value' }, sort: 4 },
      { key: 'value', nested: { key: 'value' }, sort: 5 },
    ]);
    expect(isMatchType(obj, target)).toEqual(true);
    expect(isMatch(obj, target)).toEqual(true);
    expect(overSome([(e:any) => e==0])(0)).toEqual(true);
    expect(overEvery(checks)([])).toEqual(true);
    expect(overEach(checks)(arr)).toEqual([-1,-1,-1]);
    expect(omitBy(orig, check)).toEqual({});
    expect(pickBy(orig, boolCheck)).toEqual({ key: 'value' });
    expect(keySelect(key)({key:9})).toEqual(9);
    expect(pluck(CollectionEx, key)).toEqual(['value','value','value','value','value','value']);
    expect(minBy(collection, ({sort}) => sort)).toEqual({});
    expect(maxBy(collection, ({sort}) => sort)).toEqual({});
    expect(defaultSort(a, b)).toEqual({});
    expect(reverseSort(a, b)).toEqual({});
    expect(reverseSort(a, b)).toEqual({});
    expect(first(arr)).toEqual({});
    expect(last(arr)).toEqual({});
    expect(sortByProp(arr, prop)).toEqual({});
    expect(maxByProp(arr, prop)).toEqual({});
    expect(minByProp(arr, prop)).toEqual({});
    expect(filterExclude(arr, obj)).toEqual({});
    expect(filterInclude(arr, obj)).toEqual({});
    expect(unique(arr)).toEqual({});
    expect(uniqueByProp(arr, prop)).toEqual({});
    expect(uniqueBy(arr, props)).toEqual({});
    expect(indexBy(arr, prop)).toEqual({});
    expect(rangeByProp(arr, prop)).toEqual({});
    expect(rangeByProps(arr, props)).toEqual({});
    expect(range(start, stop, step)).toEqual({});
  });
});
