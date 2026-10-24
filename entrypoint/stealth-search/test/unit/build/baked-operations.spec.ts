/**
 * guards: the operations cache is written at the first run (a ~13 s cold start against the 15 s limit), a stale baked cache is trusted, or the build does not produce the baked file in dist
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-build.1] [resolve-findings.4]
 * I-35: the operations are extracted at BUILD time and shipped as `dist/operations.baked.json`; a cold
 * start reads that file and never extracts. Only a stale baked file (key mismatch) re-extracts, and it
 * says so through a typed HOST_BOOT_FAILED diagnostic. The extractor is injected (a TypeScript program is
 * what costs the ~13 s) and the clock is a counter the fake extractor advances: no disk, no process.
 * Ticket 8468f7b1 · plan state fix-search-build.
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/build/baked-operations.spec.ts -> exit 1; with the default bakedFile removed from buildStealthSearchPackage the default-location test extracts (calls 1)
 *
 * Criteria: [fix-search-build.1]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Operation } from '@adhd/apigen-core-client'
import { describe, expect, it } from 'vitest'
import { HostBootFailedError } from '../../../src/host-errors.js'
import { BAKED_OPERATIONS_FILE, bakeOperations, buildStealthSearchPackage, packageRoot, resolveOperations } from '../../../src/server.js'
import type { HostFs } from '../../../src/server.js'

const root = join(__dirname, '..', '..', '..')
const COLD_EXTRACTION_MS = 13_000
const COLD_START_LIMIT_MS = 15_000
const API = '/pkg/dist/api.d.ts'
const BAKED = `/pkg/dist/${BAKED_OPERATIONS_FILE}`
const RUNTIME_CACHE = '/data/cache/operations.json'

const op = (name: string): Operation => ({ id: name, kind: 'action', path: [{ raw: name, words: [name] }] }) as unknown as Operation

function memoryFs(files: Record<string, string>): HostFs & { files: Record<string, string> } {
  return {
    files,
    appendFile: (p, d) => void (files[p] = (files[p] ?? '') + d),
    readFile: (p) => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    writeFile: (p, d) => void (files[p] = d),
    mkdirp: () => undefined,
    rename: (from, to) => {
      files[to] = files[from] as string
      delete files[from]
    },
  }
}

/** An extractor that costs `COLD_EXTRACTION_MS` of simulated time per call. */
function slowExtractor() {
  const state = { calls: 0, clockMs: 0 }
  const extractor = async (): Promise<Operation[]> => {
    state.calls++
    state.clockMs += COLD_EXTRACTION_MS
    return [op('search'), op('fetch')]
  }
  return { state, extractor }
}

describe('I-35 baked operations cache [fix-search-build.1]', () => {
  it('I-35 build: baking extracts once and writes the baked file under the key of the declarations', async () => {
    const fs = memoryFs({ [API]: 'declare const a: 1' })
    const { state, extractor } = slowExtractor()
    const baked = await bakeOperations({ apiSource: API, outFile: BAKED, fs, extractor })
    expect(state.calls).toBe(1)
    expect(baked.file).toBe(BAKED)
    expect(baked.count).toBe(2)
    const written = JSON.parse(fs.files[BAKED] as string) as { key: string; operations: unknown[] }
    expect(written.key).toBe(baked.key)
    expect(written.operations).toHaveLength(2)
    expect(Object.keys(fs.files).filter((k) => k.endsWith('.tmp'))).toEqual([])
  })

  it('I-35 cold start with a fresh baked cache never extracts and stays inside the 15 s limit', async () => {
    const fs = memoryFs({ [API]: 'declare const a: 1' })
    await bakeOperations({ apiSource: API, outFile: BAKED, fs, extractor: slowExtractor().extractor })
    const cold = slowExtractor()
    const stale: unknown[] = []
    const ops = await resolveOperations({ apiSource: API, bakedFile: BAKED, cacheFile: RUNTIME_CACHE, fs, extractor: cold.extractor, onStale: (e) => stale.push(e) })
    expect(cold.state.calls).toBe(0)
    expect(cold.state.clockMs).toBeLessThan(COLD_START_LIMIT_MS)
    expect(ops.map((o) => o.id)).toEqual(['search', 'fetch'])
    expect(stale).toEqual([])
    expect(fs.files[RUNTIME_CACHE]).toBeUndefined()
  })

  it('I-35 control: with no baked file a cold start pays the whole extraction once, then the runtime cache spares the next start', async () => {
    const fs = memoryFs({ [API]: 'declare const a: 1' })
    const first = slowExtractor()
    await resolveOperations({ apiSource: API, bakedFile: BAKED, cacheFile: RUNTIME_CACHE, fs, extractor: first.extractor })
    expect(first.state.calls).toBe(1)
    expect(first.state.clockMs).toBe(COLD_EXTRACTION_MS)
    expect(fs.files[RUNTIME_CACHE]).toBeDefined()
    const second = slowExtractor()
    const ops = await resolveOperations({ apiSource: API, bakedFile: BAKED, cacheFile: RUNTIME_CACHE, fs, extractor: second.extractor })
    expect(second.state.calls).toBe(0)
    expect(ops.map((o) => o.id)).toEqual(['search', 'fetch'])
  })

  it('I-35 stale baked cache: a key mismatch re-extracts once and reports a typed HOST_BOOT_FAILED diagnostic', async () => {
    const fs = memoryFs({ [API]: 'declare const a: 1' })
    await bakeOperations({ apiSource: API, outFile: BAKED, fs, extractor: slowExtractor().extractor })
    fs.files[API] = 'declare const a: 2' // the declarations moved on after the bake
    const run = slowExtractor()
    const stale: unknown[] = []
    const ops = await resolveOperations({ apiSource: API, bakedFile: BAKED, cacheFile: RUNTIME_CACHE, fs, extractor: run.extractor, onStale: (e) => stale.push(e) })
    expect(run.state.calls).toBe(1)
    expect(ops).toHaveLength(2)
    expect(stale).toHaveLength(1)
    const err = stale[0] as HostBootFailedError
    expect(err).toBeInstanceOf(HostBootFailedError)
    expect(err.code).toBe('HOST_BOOT_FAILED')
    expect(err.detail).toMatchObject({ reason: 'baked-cache-stale', bakedFile: BAKED })
  })

  it('I-35 stale versus fresh: extraction runs only for the stale baked cache', async () => {
    const fresh = memoryFs({ [API]: 'v1' })
    await bakeOperations({ apiSource: API, outFile: BAKED, fs: fresh, extractor: slowExtractor().extractor })
    const staleFs = memoryFs({ ...fresh.files, [API]: 'v2' })
    const a = slowExtractor()
    const b = slowExtractor()
    await resolveOperations({ apiSource: API, bakedFile: BAKED, fs: fresh, extractor: a.extractor })
    await resolveOperations({ apiSource: API, bakedFile: BAKED, fs: staleFs, extractor: b.extractor })
    expect([a.state.calls, b.state.calls]).toEqual([0, 1])
  })

  it('I-35 a corrupt or empty baked file is stale, never a crash: it re-extracts', async () => {
    for (const body of ['{not json', JSON.stringify({ key: 'x', operations: [] }), JSON.stringify({ operations: [op('a')] })]) {
      const fs = memoryFs({ [API]: 'v1', [BAKED]: body })
      const run = slowExtractor()
      const ops = await resolveOperations({ apiSource: API, bakedFile: BAKED, fs, extractor: run.extractor })
      expect(run.state.calls).toBe(1)
      expect(ops).toHaveLength(2)
    }
  })

  it('I-35 baking fails with a typed HOST_BOOT_FAILED when the declarations cannot be extracted', async () => {
    const fs = memoryFs({ [API]: 'v1' })
    const boom = async (): Promise<Operation[]> => {
      throw new Error('tsc exploded')
    }
    await expect(bakeOperations({ apiSource: API, outFile: BAKED, fs, extractor: boom })).rejects.toMatchObject({ code: 'HOST_BOOT_FAILED' })
    expect(fs.files[BAKED]).toBeUndefined()
  })
})

describe('I-35 the build produces the baked cache file in dist [fix-search-build.1]', () => {
  const project = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')) as { targets: Record<string, { command?: string; options?: { command?: string }; outputs?: string[] }> }
  const buildBin = project.targets['build-bin'] as { outputs: string[]; options: { command: string } }

  it('I-35 build-bin runs the bake script after compiling, and declares the baked file as an output', () => {
    const cmd = buildBin.options.command
    expect(cmd).toContain('scripts/bake-operations.mjs')
    expect(cmd.indexOf('tsc')).toBeLessThan(cmd.indexOf('bake-operations'))
    expect(buildBin.outputs).toContain(`{projectRoot}/dist/${BAKED_OPERATIONS_FILE}`)
  })

  it('I-35 the bake script writes dist/operations.baked.json from the compiled server module', () => {
    const script = readFileSync(join(root, 'scripts', 'bake-operations.mjs'), 'utf8')
    expect(script).toContain('dist/src/server.js')
    expect(script).toContain('bakeOperations')
    expect(script).toContain('BAKED_OPERATIONS_FILE')
  })

  it('I-35 the host reads the baked file next to the shipped declarations by default', async () => {
    const api = join(packageRoot(), 'api.d.ts')
    const baked = join(packageRoot(), BAKED_OPERATIONS_FILE)
    const fs = memoryFs({ [api]: 'declare const a: 1' })
    await bakeOperations({ apiSource: api, outFile: baked, fs, extractor: slowExtractor().extractor })
    const run = slowExtractor()
    await buildStealthSearchPackage({ fs, extractor: run.extractor, onStale: () => undefined }).catch(() => undefined)
    expect(run.state.calls).toBe(0) // the baked file at the default location was trusted; nothing was extracted
  })
})
