/**
 * CL2 (F3 F17) self-heal and reset.
 * Ticket 8468f7b1 · [chrome-lifecycle.2]
 *
 * A long-running agent keeps one ChromeManager while the shared Chrome is
 * killed under it by another process: the next `ready()` notices (one
 * /json/version probe) and relaunches instead of trusting a stale flag. After a
 * real `shutdown` (or the reaper closing an idle Chrome) the manager is reset:
 * a later `ready()` relaunches and arms a fresh idle timer that fires again.
 * Simulated machine (manager-world); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { chromeGone, IDLE, PORT, resetSp, resetWorld, world } from './manager-world.js'
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

describe('8468f7b1 [chrome-lifecycle.2] self-heal after another process killed the shared Chrome', () => {
  it('the next ready() relaunches when Chrome died under a ready manager', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    expect(world.spawns).toBe(1)
    chromeGone() // another process's shutdown, or a crash
    await c.manager.ready()
    expect(world.spawns).toBe(2)
    expect(c.manager.isReady).toBe(true)
    expect(c.logs.some((l) => l.includes('stale _ready'))).toBe(true)
  })

  it('a reachable Chrome is not relaunched (the probe is the only cost)', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    const probes = world.probes
    await c.manager.ready()
    expect(world.spawns).toBe(1)
    expect(world.probes).toBe(probes + 1)
  })
})

describe('8468f7b1 [chrome-lifecycle.2] state resets after a real shutdown', () => {
  it('after shutdown() a later ready() relaunches and a fresh idle timer fires again', async () => {
    const hub = makeHub()
    const c = client(hub, 11)
    await c.manager.ready()
    await c.manager.shutdown()
    expect(c.manager.isReady).toBe(false)
    expect(world.chromeUp).toBe(false)
    expect(world.events).toContain(`kill:${PORT}`)

    await c.manager.ready()
    expect(world.spawns).toBe(2)
    expect(c.manager.isReady).toBe(true)
    // The fresh timer fires: nothing pins Chrome, so the host reaps the Chrome this process launched.
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(c.link.reapCalls).toBe(1)
    expect(world.chromeUp).toBe(false)
    expect(world.events.filter((e) => e.startsWith('host:kill-group:'))).toEqual([`host:kill-group:${world.nextPid - 1}`])
    expect(c.manager.isReady).toBe(false)
  })

  it('after the reaper closed an idle Chrome, ready() relaunches and re-arms', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(world.chromeUp).toBe(false)
    expect(c.manager.isReady).toBe(false)
    await c.manager.ready()
    expect(world.spawns).toBe(2)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(c.link.reapCalls).toBe(2)
    expect(world.chromeUp).toBe(false)
  })

  it('bump() after a real shutdown is a no-op until the next ready()', async () => {
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await c.manager.shutdown()
    const sent = c.link.activityCalls
    c.manager.bump()
    expect(c.link.activityCalls).toBe(sent)
    expect(vi.getTimerCount()).toBe(0)
  })
})
