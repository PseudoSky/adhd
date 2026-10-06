import { describe, it, expect } from 'vitest';
import { Fenwick, RoaringBitmap, LsmTree } from './index';

/**
 * Regression specs for the 2026-10-05 audit findings. Each fails if the fix is
 * reverted (teeth), and asserts the consumer-visible value, not the implementation.
 */
describe('index-structure audit fixes', () => {
  it('B5: Fenwick.update rejects an out-of-range index instead of spinning forever', () => {
    const f = new Fenwick(4);
    expect(() => f.update(-1, 1)).toThrow(RangeError);
    expect(() => f.update(4, 1)).toThrow(RangeError);
  });

  it('B3: RoaringBitmap.toArray preserves a value whose lowest set bit is 31', () => {
    const r = new RoaringBitmap();
    for (let i = 0; i < 4100; i++) r.add(i); // >4096 ids promotes the container to a bitmap
    const arr = r.toArray();
    expect(arr).toContain(31);
    expect(arr).toHaveLength(4100);
    expect(arr.every((x) => Number.isInteger(x))).toBe(true);
  });

  it('B6: LsmTree.get does not fall through to a stale run when the newest value is undefined', () => {
    const lsm = new LsmTree(1, 100); // flush on every put
    lsm.put(1, 'a');
    lsm.put(1, undefined);
    expect(lsm.get(1)).toBeUndefined();
  });
});
