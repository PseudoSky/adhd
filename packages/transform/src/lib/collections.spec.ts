
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
const CollectionEx = ArrEx.map((i, index) => ({...ObjSample, "sort": i, value: i*index, nested: ObjSample}))

describe('transforms', () => {
  it('should work', () => {
    const cmp = (a: number,b: number): 0|-1|1 => (a<b)? 1 : -1;
    const compare = (a: number,b: number) => (a>b)? 1 : -1;
    const check = (a: any,b: any) => (a===b)? 1 : -1;
    const boolCheck = (a: any) => (!a ? false : true);
    // const checkIsArray = () =>
    const checks = [cmp, compare, check];
    const a = 10;
    const b = -10;
    const step = 1;
    const halfStep = 0.5;
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
      '0': { key: 'value', nested: { key: 'value' }, sort: 0, "value": 0 },
      '1': { key: 'value', nested: { key: 'value' }, sort: 1, "value": 2 },
      '2': { key: 'value', nested: { key: 'value' }, sort: 2, "value": 2 },
      '3': { key: 'value', nested: { key: 'value' }, sort: 3, "value": 15 },
      '4': { key: 'value', nested: { key: 'value' }, sort: 4, "value": 12 },
      '5': { key: 'value', nested: { key: 'value' }, sort: 5, "value": 20 },
    });
    expect(keyBy(collection, 'sort')).toEqual({
      '0': { key: 'value', nested: { key: 'value' }, sort: 0, "value": 0},
      '1': { key: 'value', nested: { key: 'value' }, sort: 1, "value": 2 },
      '2': { key: 'value', nested: { key: 'value' }, sort: 2, "value": 2 },
      '3': { key: 'value', nested: { key: 'value' }, sort: 3, "value": 15 },
      '4': { key: 'value', nested: { key: 'value' }, sort: 4, "value": 12 },
      '5': { key: 'value', nested: { key: 'value' }, sort: 5, "value": 20 },
    });
    expect(collection.sort(sortByKey(prop)).map(e => e[prop])).toEqual([0,1,2,3,4,5]);
    expect(
      sortBy(
        collection,
        key,
        (a: string, b: string) => a.localeCompare(b) as 0 | 1 | -1
      )
    ).toEqual([
      { key: 'value', nested: { key: 'value' }, sort: 0, "value": 0 },
      { key: 'value', nested: { key: 'value' }, sort: 1, "value": 2 },
      { key: 'value', nested: { key: 'value' }, sort: 2, "value": 2 },
      { key: 'value', nested: { key: 'value' }, sort: 3, "value": 15 },
      { key: 'value', nested: { key: 'value' }, sort: 4, "value": 12 },
      { key: 'value', nested: { key: 'value' }, sort: 5, "value": 20 },
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
    expect(defaultSort(a, b)).toEqual(1);
    expect(reverseSort(a, b)).toEqual(-1);
    expect(first(arr)).toEqual(0);
    expect(last(arr)).toEqual(3);
    expect(sortByProp(collection, prop)).toEqual(CollectionEx);
    expect(maxByProp(collection, prop)).toEqual({key: "value",nested: {key: "value"},sort: 5, value: 20});
    expect(minByProp(collection, prop)).toEqual({key: "value",nested: {key: "value"},sort: 0, value: 0});
    expect(filterExclude(collection, obj)).toEqual([]);
    expect(filterInclude(collection, obj)).toEqual(collection);
    expect(unique(arr)).toEqual(arr);
    expect(unique([...arr, 0,2,0,1,4])).toEqual(arr);
    expect(uniqueByProp(collection, prop)).toMatchObject(collection);
    expect(uniqueByProp(collection, key)).toMatchObject([collection[0]]);
    expect(uniqueBy(collection, props)).toMatchObject([collection[0]]);
    expect(indexBy(collection, key)).toEqual({value: collection});
    expect(rangeByProp(collection, prop)).toEqual({"key": prop, min: 0, max: 5});
    expect(rangeByProps(collection, ["value", prop])).toEqual([
      { "key": "value", "max": 20, "min": 0, },
      { "key": "sort", "max": 5, "min": 0, }
    ]);
    expect(range(-10, 10, 1)).toEqual([-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10]);
    expect(range(0, 5, 0.5)).toEqual([0,.5,1,1.5,2,2.5,3,3.5,4,4.5,5]);
    expect(maxBy(collection, (o) => o.value, (a, b) => defaultSort(a.value, b.value))).toEqual({key: "value",nested: {key: "value"},sort: 5, value: 20});
    expect(minBy(collection, (o) => o.value, (a, b) => defaultSort(a.value, b.value))).toEqual({key: "value",nested: {key: "value"},sort: 0, value: 0});
  });
});


// honey/src/components/Search/QuickFilters.js
// import { Collections } from "@adhd/utils";

// function extractLabel({ name, event_labels_aggregate: agg }) {
//   return { name, count: agg.aggregate.count };
// }

// export function QuickFilters({ filters = {}, onFilterPress, labels = [] }) {
//   const chips = useMemo(() => {
//     return Collections.sortBy(
//       labels.map(extractLabel),
//       "count"
//     )