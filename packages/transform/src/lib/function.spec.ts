import functional, { Differ } from './function';

describe('functional', () => {
  it('setters', () => {
    expect(functional.set({}, "a", 1)).toMatchObject({ a: 1 })
    expect(functional.set({}, "a.b.c", 1)).toMatchObject({ a: { b: { c: 1 } } })
    expect(functional.set({}, "a[0].c", 1)).toMatchObject({ a: [{ c: 1 }] })
    expect(functional.set({}, "a.b.c", [])).toMatchObject({ a: { b: { c: [] } } })
    expect(functional.set({}, "a.b[0]", [])).toMatchObject({ a: { b: [[]] } })
  })


  it('should work', () => {

    expect(functional.intMin).toBeLessThan(-100000000);
    expect(functional.intMax).toBeGreaterThan(100000000);
    expect(functional.compose(() => false)()).toEqual(false);
    expect(functional.noop()).toEqual(null);
    expect(functional.extractThen("a", (a) => a * 10)({ a: 1 })).toEqual(10);
    expect(functional.toPath('a[0].b.c')).toEqual(['a', '0', 'b', 'c']);
    // TODO broken somehow
    // expect(functional.isFalsey(() => false)).toEqual(false);
  })
  it('makeGetter', () => {
    const testObject = { a: [{ b: { c: 3 } }] };
    expect(functional.makeGetter('a[0].b.c')(testObject)).toEqual(3);
    expect(functional.get(testObject, 'a[0].b.c', 1)).toEqual(3);
  })
  it('makeSetter', () => {
    const testObject = { a: [{ b: { c: 3 } }] };
    const testObject2 = { a: [{ b: { c: 3, e: 1 } }] };
    functional.makeSetter('a[0].b.e', testObject)(1)
    expect(testObject).toEqual(testObject2);
  })
  it('set', () => {
    const testObject = { a: [{ b: { c: 3 } }] };
    const testObject2 = { a: [{ b: { c: 3, e: 1 } }] };
    expect(
      functional.set(testObject, 'a[0].b.e', 1)
    ).toMatchObject(testObject2);
  })
  it('getAll', () => {
    const testObject = { a: [{ b: { c: 3 } }] };
    expect(functional.getAll(testObject, ['a[0].b.c'])).toMatchObject([3]);

    // expect(functional.runAfter(() => false, 9)()).toEqual(false);
    // expect(functional.throttle(() => false, 9)()).toEqual(false);
    expect(functional.flowPipe(() => false)()).toEqual(false);
    expect(functional.splitPipe(() => false, () => true)()).toEqual([false, true]);
    expect(functional.flow([() => false, (a: any) => !a])()).toEqual(true);
    expect(functional.partial((a: number, b: number) => a + b, 1)(2)).toEqual(3);
  });
});

// Regression coverage for BUG-TRANSFORM-001. Assertions captured from real execution.
// Reverting either fix in Differ.map turns these red: the scalar branch would THROW
// ("arr.sort is not a function"), and the second-pass guard prevents unchanged keys
// from reappearing as changes.
describe('Differ', () => {
  it('diffs objects with scalar fields without throwing (BUG-TRANSFORM-001)', () => {
    // The exact case that used to crash: an object whose fields are primitives.
    expect(() => Differ.map({ a: 1 }, { a: 2 })).not.toThrow();
    expect(Differ.map({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('returns only the changed keys, excluding unchanged ones', () => {
    // Unchanged `name` must NOT appear; only genuinely changed keys are returned.
    expect(
      Differ.map(
        { name: 'Alice', meta: { score: 10 }, tags: ['a', 'b'] },
        { name: 'Alice', meta: { score: 12 }, tags: ['b', 'c'] },
      ),
    ).toEqual({ meta: { score: 12 }, tags: { added: ['c'], deleted: ['a'] } });
  });

  it('returns an empty object when nothing changed', () => {
    expect(Differ.map({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({});
  });

  it('surfaces added and removed keys', () => {
    expect(Differ.map({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
    expect(Differ.map({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: 2 });
  });

  it('recurses nested objects and reports only the changed leaf', () => {
    expect(Differ.map({ u: { name: 'A', age: 30 } }, { u: { name: 'A', age: 31 } }))
      .toEqual({ u: { age: 31 } });
  });

  it('diffs arrays via added/deleted tracking', () => {
    expect(Differ.map([1, 2], [2, 3])).toEqual({ added: [3], deleted: [1] });
    expect(Differ.getArrayDiffData([1, 2], [2, 3])).toEqual({ added: [3], deleted: [1] });
    expect(Differ.map({ tags: ['a', 'b'] }, { tags: ['b', 'c'] }))
      .toEqual({ tags: { added: ['c'], deleted: ['a'] } });
  });

  it('classifies value comparisons and exposes status constants', () => {
    expect(Differ.compareValues(5, 5)).toEqual(Differ.VALUE_UNCHANGED);
    expect(Differ.compareValues(5, 7)).toEqual(Differ.VALUE_UPDATED);
    expect(Differ.VALUE_CREATED).toEqual('created');
    expect(Differ.VALUE_DELETED).toEqual('deleted');
  });
});
