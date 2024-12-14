import functional from './function';

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
    // expect(functional.Differ(() => false)).toEqual(false);
  });
});
