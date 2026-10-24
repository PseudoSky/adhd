/**
 * The shutdown sequence a user relies on when Chrome is closed for them:
 * pages first, then the process, every step non-fatal, then a clean reset so
 * the next use relaunches.
 * Ticket 8468f7b1 · [chrome-lifecycle.10] [chrome-lifecycle.2] ·
 * inventory [fs-028] [fs-029] [fs-030] [fs-031]
 *
 * Simulated machine (manager-world); no socket, no process, no real port.
 * guards: closes all pages before killing Chrome
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.10] [chrome-lifecycle.2]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { IDLE, openPage, PORT, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.10] ordered shutdown', () => {
  it('closes all pages before killing Chrome', async () => {
    // [fs-028] both the force path and the reaper's soft path.
    const a = client(makeHub(), 11)
    await a.manager.ready()
    openPage('https://a.example/')
    await a.manager.shutdown()
    expect(world.events.filter((e) => e !== 'hide')).toEqual(['close-pages', `kill:${PORT}`])

    resetWorld()
    const b = client(makeHub(), 22)
    await b.manager.ready()
    openPage('chrome://newtab/')
    await vi.advanceTimersByTimeAsync(IDLE)
    const kills = world.events.filter((e) => e.startsWith('host:'))
    expect(kills[0]).toBe('host:close-pages')
    expect(kills[1]).toMatch(/^host:kill-group:\d+$/)
  })

  it('a failing page close does not stop the kill', async () => {
    // [fs-029]
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.failClose = true
    await c.manager.shutdown()
    expect(world.events).toContain(`kill:${PORT}`)
    expect(world.chromeUp).toBe(false)
    expect(c.logs).toContain('Failed to close page targets during shutdown: close failed')
  })

  it('a failing kill is logged and swallowed', async () => {
    // [fs-030]
    const c = client(makeHub(), 11)
    await c.manager.ready()
    world.failKill = true
    await expect(c.manager.shutdown()).resolves.toBeUndefined()
    expect(c.logs).toContain('Failed to kill Chrome during shutdown: kill EPERM')
  })
})

describe('8468f7b1 [chrome-lifecycle.2] reset after a real shutdown', () => {
  it('state resets after a real shutdown', async () => {
    // [fs-031] the timer is dropped and ready is false, so a later ready() relaunches and arms a fresh timer.
    const c = client(makeHub(), 11)
    await c.manager.ready()
    await c.manager.shutdown()
    expect(c.manager.isReady).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await c.manager.ready()
    expect(world.spawns).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(c.link.reapCalls).toBe(1)
  })
})
