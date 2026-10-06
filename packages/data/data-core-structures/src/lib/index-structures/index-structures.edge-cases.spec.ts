/**
 * Edge-case regression from the parallel test-audit: `RoaringBitmap.toArray()`
 * must round-trip the full unsigned 32-bit range (the `hi << 16` base was a
 * signed int32 shift, negative for values >= 2^31).
 */
import { describe, it, expect } from 'vitest';
import { RoaringBitmap } from './roaring';

describe('RoaringBitmap.toArray — full unsigned range', () => {
  it('reconstructs ids >= 2^31 without sign overflow', () => {
    const r = new RoaringBitmap();
    r.add(2147483648); // 2^31
    r.add(4294967295); // 2^32 - 1
    expect(r.has(2147483648)).toBe(true);
    expect(r.has(4294967295)).toBe(true);
    expect(r.toArray()).toEqual([2147483648, 4294967295]);
  });

  it('a bitmap CONTAINER spanning the top of the range stays unsigned', () => {
    // > ARRAY_MAX (4096) values in the highest 16-bit container: hi = 0xFFFF.
    const r = new RoaringBitmap();
    const base = 4294901760; // 0xFFFF0000
    for (let i = 0; i < 5000; i++) r.add(base + i);
    const arr = r.toArray();
    expect(arr[0]).toBe(base);
    expect(arr[arr.length - 1]).toBe(base + 4999);
    expect(arr.every((v) => v >= 0)).toBe(true);
  });

  it('union / intersect inherit the unsigned reconstruction', () => {
    const a = new RoaringBitmap();
    a.add(2147483648);
    const b = new RoaringBitmap();
    b.add(2147483648);
    b.add(4294967295);
    expect(a.union(b).toArray()).toEqual([2147483648, 4294967295]);
    expect(a.intersect(b).toArray()).toEqual([2147483648]);
  });
});
