/**
 * The package root: it exports the eleven verbs, `configureSearch`, the types' runtime companions and the
 * error classes, and importing it has no side effect (no listen, no spawn, no socket, no timer, no telemetry).
 *
 * Inventory rows: I-02 .. I-07 (through the verbs).
 * Ticket 8468f7b1 · [search-verbs.5]
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ELEVEN = ['search', 'listProviders', 'describeProvider', 'tripwireStatus', 'clearTripwire', 'chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity', 'getPageContext']

const srcDir = path.resolve(__dirname, '..', '..', '..')

const spawns = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), fork: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, ...spawns }
})

const handles = (): string[] => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo()

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('importing the package root creates no handle [search-verbs.5]', () => {
  it('a fresh import of index starts no process, opens no socket, listens on nothing and leaves the active resources unchanged', async () => {
    vi.resetModules()
    const connect = vi.spyOn(net, 'connect')
    const createServer = vi.spyOn(net, 'createServer')
    const createConnection = vi.spyOn(net, 'createConnection')
    const before = handles()

    const root = await import('../../../index.js')

    expect(Object.keys(root).length).toBeGreaterThan(0)
    expect(spawns.spawn).not.toHaveBeenCalled()
    expect(spawns.exec).not.toHaveBeenCalled()
    expect(spawns.fork).not.toHaveBeenCalled()
    expect(spawns.execFile).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(createServer).not.toHaveBeenCalled()
    expect(createConnection).not.toHaveBeenCalled()
    // no new handle of any kind (a pre-existing transient one may end meanwhile)
    const after = handles()
    for (const kind of new Set(after)) expect(after.filter((k) => k === kind).length, kind).toBeLessThanOrEqual(before.filter((k) => k === kind).length)  })

  it('index.ts and api.ts import no tracing or telemetry module (the hosts own them)', () => {
    for (const file of ['index.ts', 'api.ts', 'lib/search.ts']) {
      const text = fs.readFileSync(path.join(srcDir, file), 'utf8')
      expect(text, file).not.toMatch(/from '\.{1,2}\/(?:lib\/)?(?:tracing|telemetry)(?:\.js)?'/)
      expect(text, file).not.toMatch(/initTelemetry|makeTracingPlugin/)
    }
  })
})

describe('the package root exports the surface [search-verbs.5]', () => {
  it('exports the eleven verbs and configureSearch', async () => {
    const root = (await import('../../../index.js')) as unknown as Record<string, unknown>
    for (const name of [...ELEVEN, 'configureSearch', 'createSearchService']) expect(typeof root[name], name).toBe('function')
  })

  it('exports the typed error classes, the codes and the provider names', async () => {
    const root = await import('../../../index.js')
    expect(new root.StealthSearchError('SEARCH_FAILED', 'x')).toBeInstanceOf(root.StealthCoreBrowserError)
    expect(root.SEARCH_ERROR_CODES).toContain('HITL_ABORTED')
    expect(root.isSearchError(new root.StealthSearchError('SEARCH_FAILED', 'x'))).toBe(true)
    expect(root.PROVIDER_NAMES).toContain('github')
    expect(root.DEFAULT_SEARCH_TIMEOUT_MS).toBe(30_000)
  })

  it('configureSearch accepts { interaction?, config? } and wires them into the verbs without any I/O', async () => {
    const root = await import('../../../index.js')
    const interaction = { confirmSolved: vi.fn(async () => 'abort' as const), promptTripwireGate: vi.fn(async () => 'abort' as const) }
    expect(() => root.configureSearch({ interaction, config: { dataDir: '/nowhere' } })).not.toThrow()
    expect(() => root.configureSearch()).not.toThrow()
    expect(interaction.confirmSolved).not.toHaveBeenCalled()
  })
})
