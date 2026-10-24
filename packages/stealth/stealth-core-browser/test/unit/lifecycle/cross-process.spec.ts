/**
 * Cross-process coordination failsafes, proven through the connection-based
 * mechanism (one held connection per client to the reaper host; no shared
 * heartbeat file). The FEATURE of each row is unchanged; the mechanism that
 * provides it is the host registry (`createReaperHost`).
 * Ticket 8468f7b1 · [chrome-lifecycle.5] [chrome-lifecycle.6] [chrome-lifecycle.16] [chrome-lifecycle.21] ·
 * inventory [fs-012] [fs-013] [fs-014] [fs-015] [fs-016] [fs-017] [fs-018] [fs-019]
 *
 * The host-level rows call `createReaperHost` directly (host-fixture); the
 * client-side rows (fs-017, fs-018) drive real ChromeManagers on the simulated
 * machine (manager-world). No socket, no process, no real port.
 * guards: defers while a live sibling was active within the window
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.5] [chrome-lifecycle.6] [chrome-lifecycle.16] [chrome-lifecycle.21]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => (await import('../../helpers/lifecycle/manager-world.js')).fsModule())
vi.mock('../../../src/lib/cdp/browser.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).browserModule(vi.fn))
vi.mock('../../../src/lib/cdp/targets.js', async () => (await import('../../helpers/lifecycle/manager-world.js')).targetsModule(vi.fn))
vi.mock('@adhd/sox-service-proxy', async (orig) => (await import('../../helpers/lifecycle/manager-world.js')).spModule(await orig<Record<string, unknown>>()))

import { GRACE, IDLE, makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'
import { IDLE as CLIENT_IDLE, openPage, resetSp, resetWorld, world } from '../../helpers/lifecycle/manager-world.js'
import { client, makeHub } from '../../helpers/lifecycle/manager-clients.js'
import { must } from '../../helpers/must.js'

beforeEach(() => {
  resetWorld()
  resetSp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [chrome-lifecycle.5] cross-process coordination through the reaper host', () => {
  it('defers while a live sibling was active within the window', async () => {
    // [fs-012] tier 1: client B sent `activity` inside the window, A's reapIfIdle keeps Chrome.
    const h = makeHost()
    await h.join('A', 11)
    await h.join('B', 22)
    await h.notify('B', 'activity')
    h.advance(60_000)
    expect(resultOf(await h.call('A', 'reapIfIdle'))).toEqual({ action: 'keep', pinnedBy: 'client', reaped: false })
    expect(h.world.events).toEqual([])
  })

  it('ignores its own activity record and honours the window', async () => {
    // [fs-013] the caller is excluded from the client pin; the window is exactly idleTimeoutMs.
    const h = makeHost()
    await h.join('A', 11)
    await h.join('B', 22)
    await h.notify('A', 'activity')
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')

    const w = makeHost()
    await w.join('A', 11)
    await w.join('B', 22)
    await w.notify('B', 'activity')
    w.advance(IDLE - 1)
    expect(resultOf<{ action: string }>(await w.call('A', 'reapIfIdle')).action).toBe('keep')
    w.advance(1)
    expect(resultOf<{ action: string }>(await w.call('A', 'reapIfIdle')).action).toBe('reap')
  })

  it("merges its record with the siblings' records", async () => {
    // [fs-014] one entry per connection: a third client's hello and activity leave A and B untouched.
    const h = makeHost()
    await h.join('A', 11)
    await h.notify('A', 'activity')
    h.advance(1_000)
    await h.join('B', 22)
    await h.notify('B', 'activity')
    const before = h.host.clients()
    h.advance(1_000)
    await h.join('C', 33)
    await h.notify('C', 'activity')
    const after = h.host.clients()
    expect(after.filter((c) => c.id !== 'C')).toEqual(before)
    expect(after.map((c) => [c.id, c.pid])).toEqual([
      ['A', 11],
      ['B', 22],
      ['C', 33],
    ])
  })

  it('ignores records of dead processes', async () => {
    // [fs-015] a killed client (kill -9: no release) disconnects and is dropped at once; it cannot hold Chrome.
    const h = makeHost()
    await h.join('A', 11)
    await h.join('B', 22)
    await h.notify('B', 'activity')
    h.host.onClientDisconnect('B', 'end')
    expect(h.host.clients().map((c) => c.id)).toEqual(['A'])
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
  })

  it('tolerates missing and malformed coordination data', async () => {
    // [fs-016] malformed/unknown params and a missing hello never break a decision.
    const h = makeHost()
    h.host.onClientConnect('X') // connected, never said hello
    expect((await h.call('X', 'hello', { pid: 'not-a-pid' }))?.error?.code).toBe(-32602)
    expect((await h.call('X', 'hello', null))?.error?.code).toBe(-32602)
    expect(await h.notify('X', 'mystery', [1, 2, 3])).toBeUndefined()
    expect(h.host.clients()).toEqual([])
    // A disconnect / release of an unknown connection is harmless.
    h.host.onClientDisconnect('never-seen', 'error')
    expect(resultOf(await h.call('ghost', 'release'))).toEqual({ released: true })
    // The decision still works: nobody pins, Chrome is reaped.
    expect(resultOf<{ action: string }>(await h.call('X', 'reapIfIdle')).action).toBe('reap')
  })
})

describe('8468f7b1 [chrome-lifecycle.6] livelock protection on the host tick', () => {
  it('two idle managers do not keep each other alive forever', async () => {
    // [fs-019] two idle clients, zero http pages, history off: reaped within idle + grace (+ one 5 s tick).
    const h = makeHost()
    await h.join('A', 11, false)
    await h.join('B', 22, false)
    await h.notify('A', 'activity')
    await h.notify('B', 'activity')
    const start = h.world.now
    const stamps = h.host.clients().map((c) => c.lastActivityAt)
    let reapedAt: number | null = null
    for (let t = 0; t <= IDLE + GRACE + 10_000 && reapedAt === null; t += 5_000) {
      const out = await h.host.tick()
      // Deferral never writes activity: every stamp is unchanged by every tick.
      expect(h.host.clients().map((c) => c.lastActivityAt)).toEqual(stamps)
      if (out.reaped) reapedAt = h.world.now
      else h.advance(5_000)
    }
    expect(reapedAt).not.toBeNull()
    expect(must(reapedAt) - start).toBeLessThanOrEqual(IDLE + GRACE + 5_000)
    expect(must(reapedAt) - start).toBeGreaterThanOrEqual(IDLE)
  })
})

describe('8468f7b1 [chrome-lifecycle.21] coordination is best effort on the client', () => {
  it('coordination write failures never break a call', async () => {
    // [fs-017] a link whose sends fail, a dial that never comes up and an unsafe state dir never fail bump()/ready().
    vi.useFakeTimers()
    const hub = makeHub()
    const c = client(hub, 11)
    await c.manager.ready()
    c.link.broken = true // activity / release / reapIfIdle now throw inside the transport
    expect(() => c.manager.bump()).not.toThrow()
    await expect(c.manager.ready()).resolves.toBeUndefined()
    await expect(c.manager.withBrowser(async () => 42)).resolves.toBe(42)
    await expect(c.manager.release()).resolves.toBeUndefined()

    resetWorld()
    const down = makeHub()
    down.available = false // the reaper cannot be started
    const d = client(down, 22)
    await expect(d.manager.ready()).resolves.toBeUndefined()
    expect(() => d.manager.bump()).not.toThrow()

    resetWorld()
    world.dirUnsafe = true
    const u = client(makeHub(), 33)
    await expect(u.manager.ready()).resolves.toBeUndefined()
    expect(() => u.manager.bump()).not.toThrow()
  })

  it('a deferring process does not advertise activity', async () => {
    // [fs-018] livelock protection: A's idle fires keep deferring to an open page; A never sends
    // `activity` for them and its lastActivityAt on the host never moves.
    vi.useFakeTimers()
    const hub = makeHub()
    const a = client(hub, 11)
    const b = client(hub, 22)
    await a.manager.ready()
    await b.manager.ready()
    openPage('https://captcha.example/')
    const sent = a.link.activityCalls
    const stamp = must(must(hub.host).clients().find((x) => x.pid === 11)).lastActivityAt
    await vi.advanceTimersByTimeAsync(CLIENT_IDLE * 5)
    expect(a.link.reapCalls).toBe(5)
    expect(a.link.activityCalls).toBe(sent)
    expect(must(must(hub.host).clients().find((x) => x.pid === 11)).lastActivityAt).toBe(stamp)
    // B, equally idle, is not kept alive by A's deferrals either: its stamp never moved.
    expect(must(must(hub.host).clients().find((x) => x.pid === 22)).lastActivityAt).toBe(stamp)
  })
})
