/**
 * CL18 (F25) the sibling diagnostic.
 * Ticket 8468f7b1 · [chrome-lifecycle.18]
 *
 * Many agents attached to one Chrome is worth a loud diagnostic, never a kill:
 * `status().siblingWarning` (from the host `status` answer: connected clients
 * at or above the threshold, default 4) turns true at the threshold, and
 * nothing is signalled for it. A degraded manager (no reaper) reports false.
 * Simulated machine (manager-world); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { killChrome, killProcessGroup } from '../../../lib/cdp/browser.js'
import { openPage, resetSp, resetWorld, world } from './manager-world.js'
import { client, makeHub } from './manager-clients.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
  vi.mocked(killChrome).mockClear()
  vi.mocked(killProcessGroup).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.18] status().siblingWarning', () => {
  it('is false below the threshold and true at it (4 connected clients)', async () => {
    const hub = makeHub()
    const cs = [11, 22, 33].map((pid) => client(hub, pid))
    for (const c of cs) await c.manager.ready()
    expect((await cs[0]!.manager.status()).siblingWarning).toBe(false)
    const fourth = client(hub, 44)
    await fourth.manager.ready()
    const s = await cs[0]!.manager.status()
    expect(s).toMatchObject({ siblingWarning: true, processes: 4, reaper: true, ready: true })
    expect((await fourth.manager.status()).siblingWarning).toBe(true)
  })

  it('the diagnostic never kills anything', async () => {
    const hub = makeHub()
    const cs = [11, 22, 33, 44, 55, 66].map((pid) => client(hub, pid))
    for (const c of cs) await c.manager.ready()
    for (const c of cs) expect((await c.manager.status()).siblingWarning).toBe(true)
    expect(killChrome).not.toHaveBeenCalled()
    expect(killProcessGroup).not.toHaveBeenCalled()
    expect(world.events.filter((e) => e.includes('kill'))).toEqual([])
    expect(world.chromeUp).toBe(true)
  })

  it('status() reports the rest of the picture: owned, active processes, http pages, breaker', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    openPage('https://example.com/')
    const s = await a.manager.status()
    expect(s).toEqual({
      ready: true,
      owned: true,
      processes: 2,
      activeProcesses: 2,
      httpPages: 1,
      reaper: true,
      breaker: { open: false },
      siblingWarning: false,
    })
    expect((await b.manager.status()).owned).toBe(false)
  })

  it('a degraded manager (reaper unavailable) reports reaper false and no sibling warning', async () => {
    const hub = makeHub()
    hub.available = false
    const c = client(hub, 11)
    await c.manager.ready()
    expect(await c.manager.status()).toMatchObject({ reaper: false, siblingWarning: false, processes: 0, httpPages: 0 })
  })
})
