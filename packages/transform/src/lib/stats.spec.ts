import stats from './stats';

describe('transforms', () => {
  it('should work', () => {

    expect(stats.getMin(1,5)).toEqual(1);
    expect(stats.getMax(1,5)).toEqual(5);
    expect(`${stats.randomRange(0,1)}`).toMatch(/0\.\d{15}/);
    expect(`${stats.randomRangeInt(1,10)}`).toMatch(/[1-9]/);
    // expect(stats.normalizeValue(5, 0, 4)).toEqual([0,1,2,3,4]);
    expect(stats.roundToIncrement(1.2, 1)).toEqual(1);
    expect(stats.roundToIncrement(1.26,.5)).toEqual(1.5);
    expect(stats.range([1, 2, 3, 4, 5])).toEqual({ max: 5, min: 1 });
    expect(stats.normalize([1, 2, 3, 4, 5], { max: 4, min: 0 })).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(stats.normalizeBetween(1, 1, 10, 1, 10)).toEqual(1);
    expect(stats.makeListNormalizer([1,2,3,4,5],1,10)(2)).toEqual(3.25);
    expect(stats.histogram([1,2,3,4,5])).toEqual(new Map([[1,1],[2,1],[3,1],[4,1],[5,1]]));
    expect(stats.mostCommon([1,2,3,4,5])).toEqual(1);
    expect([...new stats.Counter([1,2,3,4,5]).entries()]).toEqual([[1,1],[2,1],[3,1],[4,1],[5,1]]);
    expect(new stats.NormalizedHistogram([1,2,3,4,5],10,1,.5).bins(1,10)).toEqual([]);
  });
});
