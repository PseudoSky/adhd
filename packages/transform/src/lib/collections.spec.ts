
import {
  defaultSort,
  difference,
  filterExclude,
  filterInclude,
  first,
  flattenDeep,
  indexBy,
  intersection,
  isMatch,
  isMatchType,
  keyBy,
  keyByArray,
  keySelect,
  last,
  maxBy,
  maxByProp,
  minBy,
  minByProp,
  omitBy,
  overEach,
  overEvery,
  overSome,
  pickBy,
  pluck,
  range,
  rangeByProp,
  rangeByProps,
  reverseSort,
  sortBy,
  sortByKey,
  sortByProp,
  // groupByProp,
  unique,
  uniqueBy,
  uniqueByProp,
} from './collections';



describe('collections', () => {
  describe('difference', () => {
    it('should return the difference between two arrays', () => {
      expect(difference([[1, 2, 3], [2, 3, 4]])).toEqual([1]);
      expect(difference([[1, 2, 3], [1, 2, 3]])).toEqual([]);
    });
  });

  describe('intersection', () => {
    it('should return the intersection of two arrays', () => {
      expect(intersection([[1, 2, 3], [2, 3, 4]])).toEqual([2, 3]);
      expect(intersection([[1, 2, 3], [1, 2, 3]])).toEqual([1, 2, 3]);
    });
  });

  describe('flattenDeep', () => {
    it('should flatten a nested array', () => {
      expect(flattenDeep([[1, [4, [1], [null]]]])).toEqual([1, 4, 1, null]);
    });
  });

  describe('keyByArray', () => {
    it('should create an object with keys from an array', () => {
      const data = [
        { id: 1, name: 'John' },
        { id: 2, name: 'Jane' },
        { id: 3, name: 'Bob' },
      ];
      expect(keyByArray(data, 'id')).toEqual({
        '1': { id: 1, name: 'John' },
        '2': { id: 2, name: 'Jane' },
        '3': { id: 3, name: 'Bob' },
      });
    });
  });

  describe('keyBy', () => {
    it('should create an object with keys from a property', () => {
      const data = [
        { id: 1, name: 'John' },
        { id: 2, name: 'Jane' },
        { id: 3, name: 'Bob' },
      ];
      expect(keyBy(data, 'id')).toEqual({
        '1': { id: 1, name: 'John' },
        '2': { id: 2, name: 'Jane' },
        '3': { id: 3, name: 'Bob' },
      });
    });
  });

  describe('sortByKey', () => {
    it('should sort an array of objects by a key', () => {
      const data = [
        { id: 2, name: 'Jane' },
        { id: 1, name: 'John' },
        { id: 3, name: 'Bob' },
      ];
      expect(data.sort(sortByKey('id')).map(item => item.id)).toEqual([1, 2, 3]);
    });
  });

  describe('sortBy', () => {
    it('should sort an array of objects by a key using a custom comparator', () => {
      const data = [
        { id: 2, name: 'Jane' },
        { id: 1, name: 'John' },
        { id: 3, name: 'Bob' },
      ];
      expect(sortBy(data, 'name', (a, b) => a.localeCompare(b))).toEqual([
        { id: 3, name: 'Bob' },
        { id: 2, name: 'Jane' },
        { id: 1, name: 'John' },
      ]);
    });
  });

  describe('isMatchType', () => {
    it('should check if an object matches a target object by type', () => {
      const obj = { a: 1, b: '2' };
      const target = { a: 0, b: '' };
      expect(isMatchType(obj, target)).toBe(true);
    });
  });

  describe('isMatch', () => {
    it('should check if an object matches a target object', () => {
      const obj = { a: 1, b: '2' };
      const target = { a: 1, b: '2' };
      expect(isMatch(obj, target)).toBe(true);
    });
  });

  // Add more test cases for the remaining functions...
});


describe('collections.ts', () => {
  it('should work', () => {
    const ObjSample = { "key": "value" }
    const ArrEx = [0, 2, 1, 4, 5, 3];
    const ArrShift = ArrEx.map(e => e + 3);
    const CollectionEx = ArrEx.map((i, index) => ({ ...ObjSample, "sort": i, value: i * index, nested: ObjSample }))

    const cmp = (a: number, b: number): 0 | -1 | 1 => (a < b) ? 1 : -1;
    const compare = (a: number, b: number) => (a > b) ? 1 : -1;
    const check = (a: any, b: any) => (a === b) ? 1 : -1;
    const boolCheckTrue = (a: any) => true;
    const boolCheckFalse = (a: any) => false;
    const boolCheckExists = (a: any) => (!!a);
    const boolCheckNotExists = (a: any) => (!a);
    const boolCheckNotEqOne = (a: any) => (a != 1);
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
    const target = { "key": "value", "sort": 5 };
    const selector = "sort";
    expect(difference(arrays)).toEqual([0, 2, 1]);
    expect(intersection(arrays)).toEqual([4, 5, 3]);
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
      '0': { key: 'value', nested: { key: 'value' }, sort: 0, "value": 0 },
      '1': { key: 'value', nested: { key: 'value' }, sort: 1, "value": 2 },
      '2': { key: 'value', nested: { key: 'value' }, sort: 2, "value": 2 },
      '3': { key: 'value', nested: { key: 'value' }, sort: 3, "value": 15 },
      '4': { key: 'value', nested: { key: 'value' }, sort: 4, "value": 12 },
      '5': { key: 'value', nested: { key: 'value' }, sort: 5, "value": 20 },
    });
    expect(collection.sort(sortByKey(prop)).map(e => e[prop])).toEqual([0, 1, 2, 3, 4, 5]);
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
    expect(overSome([(e: any) => e == 0])(0)).toEqual(true);
    expect(overEvery([boolCheckExists, boolCheckNotEqOne])([])).toEqual(true);
    expect(overEvery([boolCheckExists, boolCheckNotExists])([])).toEqual(false);
    expect(overEach([boolCheckExists, boolCheckNotExists, boolCheckNotEqOne])(arr)).toEqual([true, false, true]);
    expect(omitBy(orig, boolCheckTrue)).toEqual({});
    expect(omitBy([orig, orig], (e) => e.value == 1)).toEqual([orig, orig]);
    expect(omitBy([orig, orig], (e) => e.key == "value")).toEqual([]);
    expect(pickBy(orig, boolCheckExists)).toEqual({ key: 'value' });
    expect(pickBy([orig, orig], boolCheckExists)).toEqual([{ key: 'value' }, { key: 'value' }]);
    expect(keySelect(key)({ key: 9 })).toEqual(9);
    expect(pluck(CollectionEx, key)).toEqual(['value', 'value', 'value', 'value', 'value', 'value']);
    expect(defaultSort(a, b)).toEqual(1);
    expect(reverseSort(a, b)).toEqual(-1);
    expect(first(arr)).toEqual(0);
    expect(last(arr)).toEqual(3);
    expect(sortByProp(collection, prop)).toEqual(CollectionEx);
    expect(maxByProp(collection, prop)).toEqual({ key: "value", nested: { key: "value" }, sort: 5, value: 20 });
    expect(minByProp(collection, prop)).toEqual({ key: "value", nested: { key: "value" }, sort: 0, value: 0 });
    expect(filterExclude(collection, obj)).toEqual([]);
    expect(filterInclude(collection, obj)).toEqual(collection);
    expect(unique(arr)).toEqual(arr);
    expect(unique([...arr, 0, 2, 0, 1, 4])).toEqual(arr);
    expect(uniqueByProp(collection, prop)).toMatchObject(collection);
    expect(uniqueByProp(collection, key)).toMatchObject([collection[0]]);
    expect(uniqueBy(collection, props)).toMatchObject([collection[0]]);
    expect(indexBy(collection, key)).toEqual({ value: collection });
    expect(rangeByProp(collection, prop)).toEqual({ "key": prop, min: 0, max: 5 });
    expect(rangeByProps(collection, ["value", prop])).toEqual([
      { "key": "value", "max": 20, "min": 0, },
      { "key": "sort", "max": 5, "min": 0, }
    ]);
    expect(range(-10, 10, 1)).toEqual([-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(range(0, 5, 0.5)).toEqual([0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    expect(maxBy(collection, (o) => o.value)).toEqual({ key: "value", nested: { key: "value" }, sort: 5, value: 20 });
    expect(minBy(collection, (o) => o.value)).toEqual({ key: "value", nested: { key: "value" }, sort: 0, value: 0 });
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