/**
 * CL6 (F9) livelock protection.
 * Ticket 8468f7b1 · [chrome-lifecycle.6]
 *
 * Two agents sit idle on one Chrome. If deferring wrote activity, each idle
 * fire would keep the other alive forever. Proven end to end: the defer paths
 * (idle fire, `shutdownIfIdle`), the host ticks and `reapIfIdle` leave every
 * client's `lastActivityAt` unchanged — `activity` is the only writer and only
 * genuine use (`bump`, `ready`, `withBrowser`) sends it — and two idle clients
 * with zero http pages and history off are reaped within idle plus grace.
 * Simulated machine (manager-world); no socket, no process, no real port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('./manager-world.js')).fsModule())
vi.mock('../../../lib/cdp/browser.js', async () => (await import('./manager-world.js')).browserModule(vi.fn))
vi.mock('../../../lib/cdp/targets.js', async () => (await import('./manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('./manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { GRACE, IDLE, openPage, resetSp, resetWorld, world } from './manager-world.js'
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

describe('8468f7b1 [chrome-lifecycle.6] deferral never writes activity', () => {
  it('idle fires, shutdownIfIdle, host ticks and reapIfIdle leave every lastActivityAt unchanged', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    a.manager.bump()
    b.manager.bump()
    openPage('https://captcha.example/') // every evaluation defers on the page tier
    const stamps = () => hub.host!.clients().map((c) => [c.id, c.lastActivityAt])
    const before = stamps()
    const sentA = a.link.activityCalls
    const sentB = b.link.activityCalls

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(IDLE) // both idle timers fire and defer
      await hub.host!.tick()
    }
    await a.manager.shutdownIfIdle()
    await b.manager.shutdownIfIdle()

    expect(a.link.reapCalls).toBeGreaterThanOrEqual(5)
    expect(b.link.reapCalls).toBeGreaterThanOrEqual(5)
    expect(stamps()).toEqual(before)
    // `bump` (genuine use) is the only path that sends `activity`; deferral sent none.
    expect(a.link.activityCalls).toBe(sentA)
    expect(b.link.activityCalls).toBe(sentB)
    expect(world.chromeUp).toBe(true)
  })

  it('only bump() moves lastActivityAt, on the host clock', async () => {
    const hub = makeHub()
    const a = client(hub, 11)
    await a.manager.ready()
    const t0 = hub.host!.clients()[0]!.lastActivityAt!
    await vi.advanceTimersByTimeAsync(400)
    a.manager.bump()
    expect(hub.host!.clients()[0]!.lastActivityAt).toBe(t0 + 400)
  })
})

describe('8468f7b1 [chrome-lifecycle.6] two idle clients do not keep each other alive', () => {
  it('zero http pages, history off: reaped within idle plus grace', async () => {
    const hub = makeHub()
    const a = client(hub, 11, { checkHistory: false })
    const b = client(hub, 22, { checkHistory: false })
    await a.manager.ready()
    await b.manager.ready()
    world.history = true // a recent visit exists but the tier is off for every client
    const start = Date.now()
    let reapedAt: number | null = null
    while (reapedAt === null && Date.now() - start <= IDLE + GRACE + 1_000) {
      await vi.advanceTimersByTimeAsync(100)
      if (!world.chromeUp) reapedAt = Date.now()
    }
    expect(reapedAt).not.toBeNull()
    expect((reapedAt ?? Infinity) - start).toBeLessThanOrEqual(IDLE + GRACE)
  })
})
