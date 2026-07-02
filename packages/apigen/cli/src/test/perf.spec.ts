// perf.spec.ts — consumer-outcome regression net for the extraction-session
// performance/memory work, driven through the REAL orchestrator entrypoint
// (buildDescriptor), the same seam `apigen generate/run/serve` use.
//
// What it pins (and how it stays deterministic):
//   1. Correctness under caching — repeated runs return DEEP-EQUAL descriptors
//      (a stale/corrupt cache breaks this, timing never does).
//   2. Heap flatness — N repeated runs must not grow the heap: before this
//      work every run leaked ~2 ts-morph Projects + generators (~180MB/run);
//      with real gc between runs the assertion is stable.
//   3. Warm-run cheapness — after run 1, the persistent tier makes a run
//      near-free; the bound is set ~100x above the measured warm time (<10ms)
//      so it only trips on a real regression (a full program rebuild is >1s).
//
// Fixtures live under tmp/apigen/perf-spec (repo rule: all ephemera under
// tmp/) and are removed on teardown.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildDescriptor } from '../lib/orchestrator'

const FIXTURE_DIR = path.resolve(
  __dirname, '..', '..', '..', '..', '..', 'tmp', 'apigen', 'perf-spec',
)
const FILES = 3
const FNS = 6

function writeFixtures(): Array<{ file: string; tsconfig: string; namespace: string }> {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const tsconfig = path.join(FIXTURE_DIR, 'tsconfig.json')
  fs.writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      target: 'ES2020', module: 'esnext', moduleResolution: 'bundler',
      esModuleInterop: true, strict: true, skipLibCheck: true,
    },
  }))

  const sources: Array<{ file: string; tsconfig: string; namespace: string }> = []
  for (let f = 0; f < FILES; f++) {
    const lines = [
      `export interface IItem${f} { id: string; at: Date; qty: bigint }`,
    ]
    for (let i = 0; i < FNS; i++) {
      switch (i % 3) {
        case 0:
          lines.push(`export function fn${i}_named(item: IItem${f}, n: number): IItem${f}[] { return [item] }`)
          break
        case 1:
          lines.push(`export async function fn${i}_inline(input: { when: Date; tags: string[] }): Promise<{ ok: boolean }> { return { ok: !!input } }`)
          break
        case 2:
          lines.push(`export const fn${i}_arrow = (m: Map<string, Date>, mode: 'a' | 'b'): [Date, string] => [new Date(), mode]`)
          break
      }
    }
    const file = path.join(FIXTURE_DIR, `svc${f}.ts`)
    fs.writeFileSync(file, lines.join('\n\n') + '\n')
    sources.push({ file, tsconfig, namespace: `svc${f}` })
  }
  return sources
}

let sources: Array<{ file: string; tsconfig: string; namespace: string }>

beforeAll(() => {
  sources = writeFixtures()
})

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
})

/** Serializable view of a descriptor for deep-equality across runs. */
async function runOnce() {
  const d = await buildDescriptor({ sources })
  return {
    operations: d.operations,
    packages: [...d.packageSchemas.entries()],
  }
}

describe('[perf] buildDescriptor through the real orchestrator', () => {
  it('repeated runs return deep-equal descriptors (cache changes nothing observable)', async () => {
    const first = await runOnce()
    expect(first.operations.length).toBe(FILES * FNS)

    const second = await runOnce()
    const third = await runOnce()
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  }, 120_000)

  it('heap stays flat across repeated runs (no per-run Project/generator leak)', async () => {
    const gc = (globalThis as { gc?: () => void }).gc
    if (typeof gc !== 'function') {
      // Loud failure, never a silent skip: the vite config must inject --expose-gc.
      throw new Error('global.gc missing — vite.config test.poolOptions must pass --expose-gc')
    }

    await runOnce() // reach the cached plateau before measuring
    const heaps: number[] = []
    for (let i = 0; i < 10; i++) {
      await runOnce()
      gc()
      heaps.push(process.memoryUsage().heapUsed)
    }
    const firstAvg = (heaps[0] + heaps[1] + heaps[2]) / 3
    const lastAvg = (heaps[7] + heaps[8] + heaps[9]) / 3
    // Pre-fix this grew ~180MB+ per run (≥ 1GB over the loop); 40MB of slack
    // absorbs allocator noise while still failing hard on a real leak.
    expect(lastAvg - firstAvg).toBeLessThan(40 * 1024 * 1024)
  }, 300_000)

  it('warm runs are near-free (persistent tier reused across runs)', async () => {
    await runOnce() // ensure warm
    const t0 = performance.now()
    await runOnce()
    const warmMs = performance.now() - t0
    // Measured warm ≈ 10ms. A single full TS program rebuild costs >1000ms,
    // so 1500ms only trips when the persistent tier stops working.
    expect(warmMs).toBeLessThan(1_500)
  }, 120_000)
})
