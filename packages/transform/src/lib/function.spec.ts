import functional from './function';

describe('functional', () => {
  it('should work', () => {
    const testObject = { a: [{ b: { c: 3 } }] };
    expect(functional.intMin).toBeLessThan(-100000000);
    expect(functional.intMax).toBeGreaterThan(100000000);
    expect(functional.compose(() => false)()).toEqual(false);
    expect(functional.noop()).toEqual(null);
    expect(functional.extractThen("a", (a) => a*10)({a: 1})).toEqual(10);
    expect(functional.toPath('a[0].b.c')).toEqual(['a', '0', 'b', 'c']);
    // TODO broken somehow
    // expect(functional.isFalsey(() => false)).toEqual(false);
    expect(functional.makeGetter('a[0].b.c')(testObject)).toEqual(3);
    expect(functional.makeSetter('a[0].b.c', {...testObject})(3)).toEqual(testObject);
    expect(functional.get(testObject, 'a[0].b.c', 1)).toEqual(3);

    expect(
      functional.set(testObject, 'a[0].b.e', 1)
    ).toMatchObject({ a: [{ b: { c: 3, e: 1 } }] });
    expect(functional.getAll(testObject, ['a[0].b.c'])).toMatchObject([3]);
    expect(functional.runAfter(() => false, 9)).toEqual(false);
    expect(functional.throttle(() => false, 9)).toEqual(false);
    expect(functional.flowPipe(() => false)).toEqual(false);
    expect(functional.splitPipe(() => false)).toEqual(false);
    expect(functional.flow([() => false, (a) => !a])).toEqual(true);
    expect(functional.partial((a: number, b: number) => a + b, 1)(2)).toEqual(false);
    // expect(functional.Differ(() => false)).toEqual(false);
  });
});
