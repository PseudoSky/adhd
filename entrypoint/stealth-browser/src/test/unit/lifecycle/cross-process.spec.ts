/**
 * Cross-process coordination failsafes, proven through the connection-based
 * mechanism (one held connection per client to the reaper host; no shared
 * heartbeat file). The FEATURE of each row is unchanged; the mechanism that
 * provides it is the host registry (`createReaperHost`).
 * Ticket 8468f7b1 · [chrome-lifecycle.5] [chrome-lifecycle.6] [chrome-lifecycle.16] ·
 * inventory [fs-012] [fs-013] [fs-014] [fs-015] [fs-016] [fs-019]
 */
import { describe, expect, it } from 'vitest'
import { GRACE, IDLE, makeHost, resultOf } from './host-fixture.js'

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
    expect(reapedAt! - start).toBeLessThanOrEqual(IDLE + GRACE + 5_000)
    expect(reapedAt! - start).toBeGreaterThanOrEqual(IDLE)
  })
})
