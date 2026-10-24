/**
 * guards: the baked operations file ships 0600 (unreadable to other users of a shared install, with a silent slow fallback), the boot trace is written with default permissions, or an unreadable baked file falls back without a word
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [fix-search-build.1] [resolve-findings.4]
 * plan: resolve-findings
 * teeth: red: npx vitest run test/unit/build/file-modes.spec.ts -> exit 1; with the global fs stub answering 'declarations' for package.json the strict bake refuses the unreadable version
 * Pre-review P5 and P37 through the real `nodeHostFs` over a mocked `node:fs` (no disk): the baked artifact is
 * written 0644 and chmod'ed, the runtime state files (operations cache, boot trace) stay 0600 whether or not the
 * file already existed, and a baked file that exists but cannot be read reports a typed HOST_BOOT_FAILED.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsm = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  readFileSync: vi.fn(),
}))
vi.mock('node:fs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...fsm }))

import type { Operation } from '@adhd/apigen-core-client'
import { BAKED_FILE_MODE, PRIVATE_FILE_MODE, bakeOperations, createBootTrace, nodeHostFs, resolveOperations } from '../../../src/server.js'

const op = { id: 'search', kind: 'action', path: [{ raw: 'search', words: ['search'] }] } as unknown as Operation
const extractor = async (): Promise<Operation[]> => [op]

/** The files the cache key reads: package.json files carry a version (the baker refuses an unreadable one), everything else is the declarations. */
function readStub(path: unknown): string {
  return String(path).endsWith('package.json') ? '{"version":"1.2.3"}' : 'declarations'
}

beforeEach(() => {
  for (const f of Object.values(fsm)) f.mockReset()
  fsm.readFileSync.mockImplementation(readStub)
})

describe('file modes of what the host writes [audit-fixes.1]', () => {
  it('P5 baked file: bakeOperations writes the artifact 0644 and chmods it, so a shared install can read it', async () => {
    await bakeOperations({ apiSource: '/pkg/dist/api.d.ts', outFile: '/pkg/dist/operations.baked.json', extractor })
    expect(BAKED_FILE_MODE).toBe(0o644)
    const writes = fsm.writeFileSync.mock.calls as Array<[string, string, { mode: number }]>
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[2]).toEqual({ mode: 0o644 })
    expect(fsm.chmodSync).toHaveBeenCalledWith(writes[0]?.[0], 0o644)
    expect(fsm.renameSync).toHaveBeenCalledWith(writes[0]?.[0], '/pkg/dist/operations.baked.json')
  })

  it('P5 runtime cache: the operations cache under the data directory stays 0600', async () => {
    await resolveOperations({ apiSource: '/pkg/dist/api.d.ts', cacheFile: '/data/cache/operations.json', extractor })
    const writes = fsm.writeFileSync.mock.calls as Array<[string, string, { mode: number }]>
    expect(writes).toHaveLength(1)
    expect(writes[0]?.[2]).toEqual({ mode: PRIVATE_FILE_MODE })
    expect(fsm.chmodSync).toHaveBeenCalledWith(writes[0]?.[0], 0o600)
  })

  it('P37 boot trace: every appended line is written 0600 and an existing looser file is tightened', () => {
    const trace = createBootTrace('/data/boot.trace', { pid: 1, now: () => new Date(0) })
    trace('boot', { transport: 'stdio' })
    trace('hooks-installed')
    expect(fsm.appendFileSync).toHaveBeenCalledTimes(2)
    for (const call of fsm.appendFileSync.mock.calls as Array<[string, string, { mode: number }]>) expect(call[2]).toEqual({ mode: 0o600 })
    expect(fsm.chmodSync).toHaveBeenCalledWith('/data/boot.trace', 0o600)
  })

  it('P37 nodeHostFs: writeFile defaults to 0600 and honours an explicit mode', () => {
    nodeHostFs.writeFile('/a', 'x')
    nodeHostFs.writeFile('/b', 'y', 0o640)
    expect(fsm.writeFileSync).toHaveBeenNthCalledWith(1, '/a', 'x', { mode: 0o600 })
    expect(fsm.writeFileSync).toHaveBeenNthCalledWith(2, '/b', 'y', { mode: 0o640 })
    expect(fsm.chmodSync).toHaveBeenCalledWith('/b', 0o640)
  })
})

describe('an unreadable baked file is reported [audit-fixes.1]', () => {
  it('P5 unreadable: EACCES on the baked file raises a typed baked-cache-unreadable diagnostic and extraction runs', async () => {
    fsm.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('operations.baked.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return readStub(path)
    })
    const seen: unknown[] = []
    const ops = await resolveOperations({ apiSource: '/pkg/dist/api.d.ts', bakedFile: '/pkg/dist/operations.baked.json', extractor, onStale: (e) => void seen.push(e) })
    expect(ops).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ code: 'HOST_BOOT_FAILED', detail: { reason: 'baked-cache-unreadable' } })
  })

  it('P5 missing: a baked file that does not exist stays silent (a source checkout has none)', async () => {
    fsm.readFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('operations.baked.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return readStub(path)
    })
    const seen: unknown[] = []
    await resolveOperations({ apiSource: '/pkg/dist/api.d.ts', bakedFile: '/pkg/dist/operations.baked.json', extractor, onStale: (e) => void seen.push(e) })
    expect(seen).toEqual([])
  })
})
