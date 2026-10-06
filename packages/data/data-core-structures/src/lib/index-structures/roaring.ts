/**
 * A Roaring bitmap (§11 row 3) for low-cardinality membership.
 *
 * The 32-bit universe is partitioned by the high 16 bits into containers; each
 * container holds its low 16 bits as a sorted `number[]` (an "array container"),
 * promoted to a 2^16-bit `Uint32Array` ("bitmap container") once it exceeds
 * `ARRAY_MAX` — the standard roaring representation.
 */
const ARRAY_MAX = 4096;

type Container = number[] | Uint32Array;

function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function toBitmap(arr: number[]): Uint32Array {
  // The low 16 bits span 0..65535 — 65536 bits = 2048 Uint32 words. A 1024-word
  // (32768-bit) array silently drops every value whose low bits are ≥ 32768.
  const bits = new Uint32Array(2048);
  for (const lo of arr) bits[lo >>> 5] |= 1 << (lo & 31);
  return bits;
}

export class RoaringBitmap {
  private readonly containers = new Map<number, Container>();
  private card = 0;

  add(value: number): void {
    const v = value >>> 0;
    const hi = v >>> 16;
    const lo = v & 0xffff;
    const c = this.containers.get(hi);
    if (c === undefined) {
      this.containers.set(hi, [lo]);
      this.card += 1;
      return;
    }
    if (Array.isArray(c)) {
      const i = lowerBound(c, lo);
      if (c[i] === lo) return;
      c.splice(i, 0, lo);
      this.card += 1;
      if (c.length > ARRAY_MAX) this.containers.set(hi, toBitmap(c));
    } else {
      const w = lo >>> 5;
      const bit = 1 << (lo & 31);
      if (((c[w] ?? 0) & bit) === 0) {
        c[w] |= bit;
        this.card += 1;
      }
    }
  }

  has(value: number): boolean {
    const v = value >>> 0;
    const c = this.containers.get(v >>> 16);
    if (c === undefined) return false;
    const lo = v & 0xffff;
    if (Array.isArray(c)) return c[lowerBound(c, lo)] === lo;
    return ((c[lo >>> 5] ?? 0) & (1 << (lo & 31))) !== 0;
  }

  remove(value: number): void {
    const v = value >>> 0;
    const hi = v >>> 16;
    const c = this.containers.get(hi);
    if (c === undefined) return;
    const lo = v & 0xffff;
    if (Array.isArray(c)) {
      const i = lowerBound(c, lo);
      if (c[i] !== lo) return;
      c.splice(i, 1);
      this.card -= 1;
      if (c.length === 0) this.containers.delete(hi);
    } else {
      const w = lo >>> 5;
      const bit = 1 << (lo & 31);
      if (((c[w] ?? 0) & bit) === 0) return;
      c[w] &= ~bit;
      this.card -= 1;
    }
  }

  get cardinality(): number {
    return this.card;
  }

  toArray(): number[] {
    const out: number[] = [];
    for (const [hi, c] of [...this.containers.entries()].sort((a, b) => a[0] - b[0])) {
      const base = hi << 16;
      if (Array.isArray(c)) for (const lo of c) out.push(base + lo);
      else for (let w = 0; w < c.length; w++) {
        let bits = c[w] ?? 0;
        while (bits !== 0) {
          const lsb = bits & -bits;
          // `lsb` is signed int32, so `Math.log2` returns NaN once bit 31 is the
          // lowest set bit (0x80000000 reads as -2147483648). `clz32` is unsigned.
          out.push(base + (w << 5) + (31 - Math.clz32(lsb)));
          bits ^= lsb;
        }
      }
    }
    return out;
  }

  union(other: RoaringBitmap): RoaringBitmap {
    const out = new RoaringBitmap();
    for (const v of this.toArray()) out.add(v);
    for (const v of other.toArray()) out.add(v);
    return out;
  }

  intersect(other: RoaringBitmap): RoaringBitmap {
    const out = new RoaringBitmap();
    const [small, large] = this.card <= other.card ? [this, other] : [other, this];
    for (const v of small.toArray()) if (large.has(v)) out.add(v);
    return out;
  }
}
