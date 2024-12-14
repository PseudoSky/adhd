import objectUtils from './object';

describe.only('object', () => {
  it('should work', () => {
    expect(objectUtils.deepCopy({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(
      objectUtils.deepEquals(
        { a: 1, b: [1, 2], c: { d: 3 } },
        { a: 1, b: [1, 2], c: { d: 3 } }
      )
    ).toEqual(true);
    expect(objectUtils.difference({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 });
    expect(objectUtils.entries({ "a": 1, "b": 2 })).toEqual([["a", 1], ["b", 2]])
    expect(
      objectUtils.groupBy([{ a: 1, b: 2 }, { a: 1, b: 4 }, { a: 2, b: 2 }], ['a'])
    ).toEqual([
      { "a": 1, "children": [{ "a": 1, "b": 2, }, { "a": 1, "b": 4, },], "size": 2 },
      { "a": 2, "children": [{ "a": 2, "b": 2 },], "size": 1, }
    ]);
    expect(objectUtils.has({ "a": 1, "b": 2 }, "a")).toEqual(true)
    expect(objectUtils.hasAll({ "a": 1, "b": 2 }, ['a', 'b'])).toEqual(true)
    const allP = objectUtils.allPaths(
      {
        x: {
          y: { z: 1 },
          g: {
            a: 1,
            b: [
              { c: 1 },
              { d: { e: [1, 2, 3] } }
            ]
          }
        }
      }
    )
    console.log({
      results: allP,
      expected: [[
        ["x", "g", "a"],
        ["x", "g", "b", "1", "d", "e"],
        ["x", "g", "b", "0", "c"],
        ["x", "y", "z"]
      ]]
    })
    expect(allP).toEqual([
      ["x", "y", "z"],
      ["x", "g", "a"],
      ["x", "g", "b", "0", "c"],
      ["x", "g", "b", "1", "d", "e"],
    ])

    expect(objectUtils.isEmpty({ "a": 1, "b": 2 })).toEqual(false)
    expect(objectUtils.isEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual(true);
    expect(objectUtils.keys({ "a": 1, "b": 2 })).toEqual(['a', 'b'])
    expect(objectUtils.maskObject({ "a": 1, "b": 2 }, ['a'])).toEqual({ "a": 1 })
    expect(objectUtils.omit({ "a": 1, "b": 2 }, ['a'])).toEqual({ 'b': 2 })
    expect(objectUtils.pick({ "a": 1, "b": 2 }, ['a'])).toEqual({ 'a': 1 })
    expect(objectUtils.rollObject(['a', 'b'], [1, 2])).toEqual({ a: 1, b: 2 });
    expect(objectUtils.stringify({ a: 1, b: 2 })).toEqual('{"a":1,"b":2}');
    expect(objectUtils.unZipObject({ "a": 1, "b": 2 })).toEqual([['a', 1], ['b', 2]])
    expect(objectUtils.values({ "a": 1, "b": 2 })).toEqual([1, 2])
    expect(objectUtils.zipObject([['a', 1], ["b", 2]])).toEqual({ "a": 1, "b": 2 })
    // TODO: doesn't work
    // expect(objectUtils.toFlagMap([{"a": 1, "b": 2}], true)).toEqual([{'a' :true,'b': true}])
  });
});
