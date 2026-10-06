/**
 * A Log-Structured Merge tree (§11 row 10) for append-heavy, spill-oriented use.
 * Writes land in a sorted MEMTABLE; when it fills it is flushed to an immutable
 * sorted RUN carrying a Bloom filter; reads check the memtable then runs
 * newest-first; runs are merged by compaction.
 */
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** A fixed-size Bloom filter over `bits` bits with 3 probes. */
class Bloom {
  private readonly bytes: Uint8Array;
  private readonly bits: number;

  constructor(expected: number) {
    this.bits = Math.max(32, expected * 2);
    this.bytes = new Uint8Array(Math.ceil(this.bits / 8));
  }

  add(key: number): void {
    const s = String(key);
    for (let i = 1; i <= 3; i++) {
      const b = fnv1a(s, i) % this.bits;
      this.bytes[b >> 3] |= 1 << (b & 7);
    }
  }

  mightContain(key: number): boolean {
    const s = String(key);
    for (let i = 1; i <= 3; i++) {
      const b = fnv1a(s, i) % this.bits;
      if ((this.bytes[b >> 3] & (1 << (b & 7))) === 0) return false;
    }
    return true;
  }
}

class SortedRun {
  readonly keys: number[];
  readonly values: unknown[];
  private readonly bloom: Bloom;

  constructor(entries: Array<[number, unknown]>) {
    this.keys = entries.map((e) => e[0]);
    this.values = entries.map((e) => e[1]);
    this.bloom = new Bloom(this.keys.length + 1);
    for (const k of this.keys) this.bloom.add(k);
  }

  get(key: number): unknown {
    if (!this.bloom.mightContain(key)) return undefined;
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = this.keys[mid] as number;
      if (k === key) return this.values[mid];
      if (k < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  entries(): Array<[number, unknown]> {
    return this.keys.map((k, i) => [k, this.values[i]]);
  }
}

export class LsmTree {
  private readonly mem = new Map<number, unknown>();
  private runs: SortedRun[] = [];

  constructor(
    private readonly flushAt = 4,
    private readonly compactAt = 3
  ) {}

  get runCount(): number {
    return this.runs.length;
  }

  put(key: number, value: unknown): void {
    this.mem.set(key, value);
    if (this.mem.size >= this.flushAt) this.flush();
  }

  get(key: number): unknown {
    if (this.mem.has(key)) return this.mem.get(key);
    for (const run of this.runs) {
      const v = run.get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** All `[key, value]` with `lo <= key <= hi`, ascending; a newer write wins. */
  scan(lo: number, hi: number): Array<[number, unknown]> {
    const merged = new Map<number, unknown>();
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i];
      if (run === undefined) continue;
      for (const [k, v] of run.entries()) if (k >= lo && k <= hi) merged.set(k, v);
    }
    for (const [k, v] of this.mem) if (k >= lo && k <= hi) merged.set(k, v);
    return [...merged.entries()].sort((a, b) => a[0] - b[0]);
  }

  private flush(): void {
    const sorted = [...this.mem.entries()].sort((a, b) => a[0] - b[0]);
    this.runs.unshift(new SortedRun(sorted));
    this.mem.clear();
    if (this.runs.length >= this.compactAt) this.compact();
  }

  private compact(): void {
    const merged = new Map<number, unknown>();
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i];
      if (run === undefined) continue;
      for (const [k, v] of run.entries()) merged.set(k, v);
    }
    this.runs = [new SortedRun([...merged.entries()].sort((a, b) => a[0] - b[0]))];
  }
}
