/**
 * CL21 (F26) best-effort I/O.
 * Ticket 8468f7b1 · [chrome-lifecycle.21]
 *
 * Coordination I/O is never on the critical path of a user's call: a failing
 * ownership-record write, a broken breaker store and an unsafe state
 * directory never fail `ready()`, and a broken reaper link never fails
 * `bump()`, `release()` or `shutdown()`. Each failure is logged.
 * Simulated machine (manager-world); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { isLifecycleError } from '../../../lib/lifecycle/errors.js'
import { ownerRecordPath } from '../../../lib/lifecycle/ownership.js'
import { breakerPath } from '../../../lib/lifecycle/launch-breaker.js'
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

/** Make every write/rename whose path contains `needle` throw. */
function failWrites(needle: string): void {
  const fs = world.fs
  const write = fs.writeFileSync.bind(fs)
  const rename = fs.renameSync.bind(fs)
  fs.writeFileSync = (p: string, d: string, o?: { flag?: string; mode?: number }) => {
    if (p.includes(needle)) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' })
    write(p, d, o)
  }
  fs.renameSync = (a: string, b: string) => {
    if (b.includes(needle)) throw Object.assign(new Error(`EACCES: ${b}`), { code: 'EACCES' })
    rename(a, b)
  }
}

describe('8468f7b1 [chrome-lifecycle.21] ownership, breaker and state-dir failures never fail a call', () => {
  it('an ownership record that cannot be written: ready() still succeeds and logs it', async () => {
    failWrites(`chrome-${PORT}.json`)
    const c = client(makeHub(), 11)
    await expect(c.manager.ready()).resolves.toBeUndefined()
    expect(c.manager.isReady).toBe(true)
    expect(world.fs.existsSync(ownerRecordPath(STATE_DIR, PORT))).toBe(false)
    expect(c.logs.some((l) => l.startsWith('owner record write failed'))).toBe(true)
  })

  it('a breaker store that cannot be read or written: ready() still succeeds; a launch failure stays LAUNCH_FAILED', async () => {
    failWrites('breaker')
    const read = world.fs.readFileSync.bind(world.fs)
    world.fs.readFileSync = (p: string) => {
      if (p.includes('breaker')) throw new Error('EIO: breaker store unreadable')
      return read(p)
    }
    const ok = client(makeHub(), 11)
    await expect(ok.manager.ready()).resolves.toBeUndefined()

    resetWorld()
    failWrites('breaker')
    world.launch = 'fail'
    world.chromeUp = false
    const bad = client(makeHub(), 22)
    const err = await bad.manager.ready().catch((e: unknown) => e)
    expect(isLifecycleError(err, 'LAUNCH_FAILED')).toBe(true)
    expect(world.fs.existsSync(breakerPath(STATE_DIR, PORT))).toBe(false)
  })

  it('an unsafe state directory: ready() still succeeds (degraded, no ownership record, in-memory breaker)', async () => {
    world.dirUnsafe = true
    const hub = makeHub()
    const c = client(hub, 11)
    await expect(c.manager.ready()).resolves.toBeUndefined()
    expect(c.manager.isReady).toBe(true)
    expect(world.fs.existsSync(ownerRecordPath(STATE_DIR, PORT))).toBe(false)
    expect((await c.manager.status()).reaper).toBe(false)
  })
})

describe('8468f7b1 [chrome-lifecycle.21] a reaper link failure never fails bump(), release() or shutdown()', () => {
  it('bump(), release() and shutdown() survive a broken link', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    c.link.broken = true
    expect(() => c.manager.bump()).not.toThrow()
    await expect(c.manager.release()).resolves.toBeUndefined()
    await expect(c.manager.shutdown()).resolves.toBeUndefined()
    expect(world.chromeUp).toBe(false)
    expect(c.logs).toContain('activity not sent: fake transport broken')
    expect(c.logs).toContain('release failed: fake transport broken')
  })

  it('an idle fire with a broken link defers (re-arms) instead of throwing', async () => {
    const c = client(makeHub(), 11, { idleTimeoutMs: 300 })
    await c.manager.ready()
    c.link.broken = true
    await vi.advanceTimersByTimeAsync(300)
    expect(c.logs).toContain('reapIfIdle failed: fake transport broken')
    expect(world.chromeUp).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(c.link.reapCalls).toBe(2)
  })
})
