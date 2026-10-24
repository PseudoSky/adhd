/**
 * CL19 (N2 N6) shared Chrome and the grace window.
 * Ticket 8468f7b1 · [chrome-lifecycle.19]
 *
 * Several agents start at once on one machine: they share ONE Chrome and ONE
 * reaper host. When the last client leaves (an orderly `release` on exit, or a
 * disconnect when it was killed) the host does not close Chrome at once: its
 * periodic tick waits `shutdownGraceMs` (fake clock) so a quickly-restarting
 * client re-adopts the same Chrome, then closes it.
 * Simulated machine (manager-world); no socket, no process, no real port.
 * guards: three concurrent ready() calls: one Chrome, one reaper host, three registered clients
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.19]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { GRACE, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'
import { must } from '../../helpers/must.js'

/** Long client idle window so only the host tick (with shutdownGraceMs) decides here. */
const CLIENT_IDLE = 600_000
const shutdownGraceMs = GRACE

beforeEach(() => {
  vi.useFakeTimers()
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function threeClients() {
  const hub = makeHub({ idleTimeoutMs: CLIENT_IDLE, shutdownGraceMs })
  const cs = [11, 22, 33].map((pid) => client(hub, pid, { idleTimeoutMs: CLIENT_IDLE, shutdownGraceMs }))
  await Promise.all(cs.map((c) => c.manager.ready()))
  for (const c of cs) c.manager.bump()
  return { hub, cs }
}

describe('8468f7b1 [chrome-lifecycle.19] N managers share one Chrome', () => {
  it('three concurrent ready() calls: one Chrome, one reaper host, three registered clients', async () => {
    const { hub } = await threeClients()
    expect(world.spawns).toBe(1)
    expect(hub.spawns).toBe(1)
    expect(must(hub.host).clients().map((c) => c.pid)).toEqual([11, 22, 33])
  })
})

describe('8468f7b1 [chrome-lifecycle.19] the host closes Chrome within shutdownGraceMs after the last client leaves', () => {
  it('after the last release, the tick waits shutdownGraceMs then reaps', async () => {
    const { hub, cs } = await threeClients()
    for (const c of cs) await c.manager.release()
    expect(must(hub.host).clients()).toEqual([])
    await vi.advanceTimersByTimeAsync(shutdownGraceMs - 1)
    expect(await must(hub.host).tick()).toMatchObject({ action: 'wait', pinnedBy: 'grace', reaped: false })
    expect(world.chromeUp).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await must(hub.host).tick()).toMatchObject({ action: 'reap', reaped: true })
    expect(world.chromeUp).toBe(false)
  })

  it('after the last client disconnects (killed, no release), the tick reaps within shutdownGraceMs', async () => {
    const { hub, cs } = await threeClients()
    for (const c of cs) c.link.kill9()
    expect(must(hub.host).clients()).toEqual([])
    await vi.advanceTimersByTimeAsync(shutdownGraceMs)
    expect(await must(hub.host).tick()).toMatchObject({ reaped: true })
    expect(world.chromeUp).toBe(false)
  })

  it('a client that returns within the grace window keeps the shared Chrome', async () => {
    const { hub, cs } = await threeClients()
    for (const c of cs) await c.manager.release()
    await vi.advanceTimersByTimeAsync(shutdownGraceMs / 2)
    const back = client(hub, 44, { idleTimeoutMs: CLIENT_IDLE, shutdownGraceMs })
    await back.manager.ready()
    await vi.advanceTimersByTimeAsync(shutdownGraceMs)
    expect(await must(hub.host).tick()).toMatchObject({ action: 'keep', pinnedBy: 'client' })
    expect(world.spawns).toBe(1)
    expect(world.chromeUp).toBe(true)
  })
})
