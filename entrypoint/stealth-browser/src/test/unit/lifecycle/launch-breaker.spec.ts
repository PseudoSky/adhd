/**
 * CL17 (N4) the launch circuit breaker.
 * Ticket 8468f7b1 · [chrome-lifecycle.17]
 *
 * A machine where Chrome cannot start (missing binary, locked profile) must
 * not be hammered by every agent's `ready()`: 3 failed launches within 60 s
 * open the breaker for 30 s, the 4th `ready()` throws LAUNCH_CIRCUIT_OPEN
 * carrying `retryAfterMs` WITHOUT spawning, the breaker lets a probe through
 * after the cool-off, a success resets it, and the state is shared across
 * managers through the `FileBreakerStore` (`<stateDir>/breaker-<port>.json`,
 * atomic rename). The state machine is the real `createCircuitBreaker` of the
 * service proxy (only its I/O siblings are mocked).
 * Simulated machine (manager-world, MemFs); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { isLifecycleError, type LifecycleError } from '../../../lib/lifecycle/errors.js'
import { breakerPath, createLaunchBreaker, FileBreakerStore, LAUNCH_COOLDOWN_MS } from '../../../lib/lifecycle/launch-breaker.js'
import { PORT, resetSp, resetWorld, STATE_DIR, world } from './manager-world.js'
import { client, makeHub } from './manager-clients.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function failingReady(c: ReturnType<typeof client>): Promise<LifecycleError> {
  const e = await c.manager.ready().then(
    () => null,
    (err: unknown) => err,
  )
  if (!(e instanceof Error)) throw new Error('expected ready() to fail')
  return e as LifecycleError
}

describe('8468f7b1 [chrome-lifecycle.17] three failed launches open the breaker', () => {
  it('the 4th ready() throws LAUNCH_CIRCUIT_OPEN with retryAfterMs and does not spawn', async () => {
    world.launch = 'fail'
    const c = client(makeHub(), 11)
    for (let i = 0; i < 3; i++) expect((await failingReady(c)).code).toBe('LAUNCH_FAILED')
    expect(world.ensureCalls).toBe(3)
    const open = await failingReady(c)
    expect(isLifecycleError(open, 'LAUNCH_CIRCUIT_OPEN')).toBe(true)
    expect(open.detail?.retryAfterMs).toBe(LAUNCH_COOLDOWN_MS)
    expect(open.detail?.port).toBe(PORT)
    expect(world.ensureCalls).toBe(3) // no launch attempt, no spawn
    expect(world.spawns).toBe(0)
    expect((await c.manager.status()).breaker).toEqual({ open: true, retryAfterMs: LAUNCH_COOLDOWN_MS })
  })

  it('a CDP that never answered after a launch counts as a failure too', async () => {
    world.launch = 'unreachable'
    const c = client(makeHub(), 11)
    for (let i = 0; i < 3; i++) expect((await failingReady(c)).code).toBe('CHROME_UNREACHABLE_AFTER_LAUNCH')
    expect((await failingReady(c)).code).toBe('LAUNCH_CIRCUIT_OPEN')
    expect(world.spawns).toBe(3)
  })

  it('retryAfterMs counts down and the breaker lets a probe launch through after the cool-off', async () => {
    world.launch = 'fail'
    const c = client(makeHub(), 11)
    for (let i = 0; i < 3; i++) await failingReady(c)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await failingReady(c)).detail?.retryAfterMs).toBe(LAUNCH_COOLDOWN_MS - 10_000)
    await vi.advanceTimersByTimeAsync(LAUNCH_COOLDOWN_MS - 10_000)
    world.launch = 'ok' // the operator fixed Chrome
    await expect(c.manager.ready()).resolves.toBeUndefined()
    expect(world.spawns).toBe(1)
    expect((await c.manager.status()).breaker).toEqual({ open: false })
  })

  it('a success resets the count (two failures, a success, two failures stay closed)', async () => {
    const c = client(makeHub(), 11)
    world.launch = 'fail'
    await failingReady(c)
    await failingReady(c)
    world.launch = 'ok'
    await c.manager.ready()
    await c.manager.shutdown()
    world.launch = 'fail'
    await failingReady(c)
    expect((await failingReady(c)).code).toBe('LAUNCH_FAILED')
    expect((await c.manager.status()).breaker.open).toBe(false)
  })

  it('the state is shared across managers through the FileBreakerStore', async () => {
    world.launch = 'fail'
    const a = client(makeHub(), 11)
    for (let i = 0; i < 3; i++) await failingReady(a)
    expect(world.fs.existsSync(breakerPath(STATE_DIR, PORT))).toBe(true)
    // Another agent process on the same machine, same port: it fails fast without trying.
    const b = client(makeHub(), 22)
    const err = await failingReady(b)
    expect(err.code).toBe('LAUNCH_CIRCUIT_OPEN')
    expect(world.ensureCalls).toBe(3)
  })
})

describe('8468f7b1 [chrome-lifecycle.17] FileBreakerStore', () => {
  beforeEach(() => {
    world.fs.mkdirSync(STATE_DIR, { recursive: true })
  })

  it('writes <stateDir>/breaker-<port>.json through a temp file and an atomic rename', () => {
    const renames: Array<[string, string]> = []
    const fs = world.fs
    const rename = fs.renameSync.bind(fs)
    fs.renameSync = (from: string, to: string) => {
      renames.push([from, to])
      rename(from, to)
    }
    const store = new FileBreakerStore(breakerPath(STATE_DIR, PORT), fs)
    store.save({ consecutive: 1, recent: [5], openedAt: null, probeStartedAt: null })
    expect(store.path).toBe(`${STATE_DIR}/breaker-${PORT}.json`)
    expect(renames).toHaveLength(1)
    expect(renames[0]![0]).toMatch(/breaker-9333\.json\.\d+\.tmp$/)
    expect(renames[0]![1]).toBe(store.path)
    expect(store.load()).toEqual({ consecutive: 1, recent: [5], openedAt: null, probeStartedAt: null })
  })

  it('a missing or malformed store loads as null (best effort, never throws)', () => {
    const store = new FileBreakerStore(breakerPath(STATE_DIR, PORT), world.fs)
    expect(store.load()).toBeNull()
    world.fs.writeFileSync(store.path, '{"consecutive":"x"}')
    expect(store.load()).toBeNull()
    world.fs.writeFileSync(store.path, 'not json')
    expect(store.load()).toBeNull()
  })

  it('a throwing store degrades the breaker to memory and logs it (the breaker still works)', () => {
    const logs: string[] = []
    const fs = world.fs
    fs.writeFileSync = () => {
      throw new Error('EROFS: read-only file system')
    }
    let now = 1_000_000
    const breaker = createLaunchBreaker({ port: PORT, stateDir: STATE_DIR, fs, now: () => now, logger: (m) => logs.push(m) })
    for (let i = 0; i < 3; i++) breaker.recordFailure()
    expect(() => breaker.assertClosed()).toThrow(expect.objectContaining({ code: 'LAUNCH_CIRCUIT_OPEN' }))
    expect(logs.some((l) => l.startsWith('launch breaker store failed'))).toBe(true)
    now += LAUNCH_COOLDOWN_MS
    expect(() => breaker.assertClosed()).not.toThrow()
  })
})
