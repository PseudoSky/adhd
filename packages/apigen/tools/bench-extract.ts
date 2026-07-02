// bench-extract.ts — human-readable extraction benchmark for apigen.
//
// Drives the REAL `buildDescriptor` orchestrator entrypoint over a generated
// multi-file fixture and prints cold/warm wall-clock plus retained heap.
// Fixtures + all output live under tmp/apigen/bench (repo ephemera rule).
//
// Run via the nx target:   npx nx run apigen-cli:bench
// (equivalent to: TSX_TSCONFIG_PATH=tsconfig.base.json \
//    node --expose-gc --import tsx packages/apigen/tools/bench-extract.ts)
//
// Reference numbers (6 files × 10 fns, M-series MacBook Pro):
//   before extraction-session work:  ~37.4s/run, ~1.0GB retained, no warm gain
//   after:                            ~7.4s cold, 6–11ms warm, capped plateau

import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildDescriptor } from '../cli/src/lib/orchestrator'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const BENCH_DIR = path.join(ROOT, 'tmp', 'apigen', 'bench')
const FIXTURE_DIR = path.join(BENCH_DIR, 'fixtures')
const FILES = Number(process.env['BENCH_FILES'] ?? 6)
const FNS = Number(process.env['BENCH_FNS'] ?? 10)
const RUNS = Number(process.env['BENCH_RUNS'] ?? 5)

function writeFixtures(): void {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020', module: 'esnext', moduleResolution: 'bundler',
        esModuleInterop: true, strict: true, skipLibCheck: true,
      },
    }, null, 2),
  )
  for (let f = 0; f < FILES; f++) {
    const lines = [
      `export interface IUser${f} { id: string; name: string; createdAt: Date; balance: bigint }`,
      `export interface IOrder${f} { user: IUser${f}; total: number; tags: string[] }`,
    ]
    for (let i = 0; i < FNS; i++) {
      switch (i % 5) {
        case 0:
          lines.push(`export function fn${i}_named(user: IUser${f}, count: number): IOrder${f} { return { user, total: count, tags: [] } }`)
          break
        case 1:
          lines.push(`export async function fn${i}_inline(input: { at: Date; label: string; nested: { deep: number[] } }, flag?: boolean): Promise<{ ok: boolean; when: Date }> { return { ok: !!flag && !!input, when: new Date() } }`)
          break
        case 2:
          lines.push(`export const fn${i}_arrow = (m: Map<string, Date>, s: Set<number>): [Date, number] => [new Date(), m.size + s.size]`)
          break
        case 3:
          lines.push(`export function fn${i}_union(mode: 'a' | 'b' | 'c', payload: Record<string, number>): string[] { return [mode, ...Object.keys(payload)] }`)
          break
        case 4:
          lines.push(`export async function fn${i}_scalars(data: Uint8Array, when: Date, big: bigint): Promise<IUser${f}[]> { return [{ id: String(big), name: String(when), createdAt: when, balance: big + BigInt(data.length) }] }`)
          break
      }
    }
    fs.writeFileSync(path.join(FIXTURE_DIR, `svc${f}.ts`), lines.join('\n\n') + '\n')
  }
}

async function main(): Promise<void> {
  writeFixtures()
  const tsconfig = path.join(FIXTURE_DIR, 'tsconfig.json')
  const sources = fs.readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({ file: path.join(FIXTURE_DIR, f), tsconfig, namespace: path.basename(f, '.ts') }))

  const gc = (globalThis as { gc?: () => void }).gc
  const times: number[] = []
  const heaps: number[] = []
  let ops = 0
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    const d = await buildDescriptor({ sources })
    times.push(performance.now() - t0)
    ops = d.operations.length
    gc?.()
    heaps.push(process.memoryUsage().heapUsed)
    console.log(`run ${i + 1}: ${times[i].toFixed(0).padStart(6)}ms  heap=${(heaps[i] / 1048576).toFixed(1)}MB  ops=${ops}`)
  }

  const warm = times.slice(1)
  console.log(JSON.stringify({
    files: FILES, fnsPerFile: FNS, ops,
    coldMs: Math.round(times[0]),
    warmBestMs: Math.round(Math.min(...warm)),
    warmAvgMs: Math.round(warm.reduce((a, b) => a + b, 0) / warm.length),
    heapLastMB: +(heaps[heaps.length - 1] / 1048576).toFixed(1),
    gcExposed: typeof gc === 'function',
  }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
