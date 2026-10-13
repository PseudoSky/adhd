/**
 * CL28 degraded mode (decision D1).
 * Ticket 8468f7b1 · [chrome-lifecycle.28]
 *
 * On a machine where the reaper cannot run — `ensureBackend` gives `failed`
 * (including E_UDS_DIR_UNSAFE: the socket directory is not private) or the
 * state directory itself is unsafe — the user's work is never blocked:
 * `ready()` still succeeds, `status().reaper` is false, the idle timer still
 * fires but never closes Chrome (it cannot see sibling clients, so it defers),
 * a force `shutdown()` still works, and exactly one warning is logged for the
 * whole degraded session.
 *
 * The manager runs with NO injected link: the real `createProxyReaperLink` is
 * used, over vi.mock('@adhd/sox-service-proxy') whose `ensureBackend` double is
 * asserted to have actually been called (the degraded path is not reached by
 * a short-circuit). Simulated machine (manager-world); no socket, no process.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { ChromeManager } from '../../../lib/chrome-manager.js'
import { HOST, PORT, resetSp, resetWorld, sp, STATE_DIR, world } from './manager-world.js'

const IDLE = 300

let warn: Mock<(msg: string) => void>
let logs: string[]

function degradedManager(): ChromeManager {
  return new ChromeManager({
    cdpHost: HOST,
    idleTimeoutMs: IDLE,
    stateDir: STATE_DIR,
    logger: (m) => {
      logs.push(m)
      if (m.startsWith('warning:')) warn(m)
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  logs = []
  warn = vi.fn()
  sp.ensureBackend = vi.fn(async () => ({ disposition: 'failed', detail: 'socket directory is group-writable', errorCode: 'E_UDS_DIR_UNSAFE' }))
  sp.dialBackend = vi.fn(() => {
    throw new Error('a degraded manager must never dial')
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.28] ensureBackend fails with E_UDS_DIR_UNSAFE: degraded', () => {
  it('ready() still succeeds and status().reaper is false', async () => {
    const m = degradedManager()
    await expect(m.ready()).resolves.toBeUndefined()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(1)
    expect(sp.dialBackend).not.toHaveBeenCalled()
    expect(m.isReady).toBe(true)
    expect(await m.status()).toMatchObject({ ready: true, reaper: false, processes: 0, siblingWarning: false })
  })

  it('the idle timer fires but never closes Chrome (it defers), forever', async () => {
    const m = degradedManager()
    await m.ready()
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(true)
    expect(world.events.filter((e) => e.includes('kill'))).toEqual([])
    expect(logs.filter((l) => l.startsWith('reaper unavailable — not closing Chrome')).length).toBe(5)
    // The previously failed ensure is retried exactly once, at the first idle fire.
    expect(sp.ensureBackend).toHaveBeenCalledTimes(2)
    expect(m.isReady).toBe(true)
  })

  it('a force shutdown() still works', async () => {
    const m = degradedManager()
    await m.ready()
    await m.shutdown()
    expect(world.events).toContain(`kill:${PORT}`)
    expect(world.chromeUp).toBe(false)
    expect(m.isReady).toBe(false)
  })

  it('exactly one warning is logged for the whole degraded session', async () => {
    const m = degradedManager()
    await m.ready()
    await m.ready()
    m.bump()
    await vi.advanceTimersByTimeAsync(2_500) // a bump with the link down retries (rate-limited) while Chrome is up
    m.bump()
    await vi.advanceTimersByTimeAsync(IDLE * 3)
    await m.shutdownIfIdle()
    expect(vi.mocked(sp.ensureBackend).mock.calls.length).toBeGreaterThan(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^warning: reaper unavailable, running degraded/)
    expect(warn.mock.calls[0]![0]).toMatch(/E_UDS_DIR_UNSAFE|not private|0700/)
  })
})

describe('8468f7b1 [chrome-lifecycle.28] the state directory is unsafe: degraded', () => {
  beforeEach(() => {
    world.dirUnsafe = true
  })

  it('ready() succeeds, status().reaper is false, and the reaper is never even ensured', async () => {
    const m = degradedManager()
    await expect(m.ready()).resolves.toBeUndefined()
    expect(sp.ensureBackend).toHaveBeenCalledTimes(0)
    expect((await m.status()).reaper).toBe(false)
  })

  it('the idle timer defers, shutdown() still closes Chrome, one warning in total', async () => {
    const m = degradedManager()
    await m.ready()
    await vi.advanceTimersByTimeAsync(IDLE * 4)
    expect(world.chromeUp).toBe(true)
    await m.shutdown()
    expect(world.chromeUp).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/E_UDS_DIR_UNSAFE|not private/)
  })
})
