/**
 * CL5 (F8) cross-process coordination in the reaper host.
 * Ticket 8468f7b1 · [chrome-lifecycle.5]
 *
 * `createReaperHost(deps).handler(req, { connectionId })` and
 * `onClientDisconnect(id, reason)` are called directly: no socket, no process.
 * Client A is the one asking to reap (soft `reapIfIdle`); client B is a
 * sibling process sharing the same Chrome.
 * guards: defers A when B sent activity within the idle window
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.5]
 */
import { describe, expect, it } from 'vitest'
import { IDLE, makeHost, PORT, resultOf } from '../../helpers/lifecycle/host-fixture.js'

describe('8468f7b1 [chrome-lifecycle.5] a sibling client active within the idle window keeps Chrome', () => {
  it('defers A when B sent activity within the idle window', async () => {
    const h = makeHost()
    await h.join('A', 101)
    await h.join('B', 202)
    await h.notify('B', 'activity')
    h.advance(IDLE - 1)
    const out = resultOf<{ action: string; pinnedBy?: string; reaped: boolean }>(await h.call('A', 'reapIfIdle'))
    expect(out).toEqual({ action: 'keep', pinnedBy: 'client', reaped: false })
    expect(h.world.events).toEqual([])
  })

  it("reaps when B stayed silent past the idle window", async () => {
    const h = makeHost()
    await h.join('A', 101)
    await h.join('B', 202)
    await h.notify('B', 'activity')
    h.advance(IDLE)
    const out = resultOf<{ action: string; reaped: boolean }>(await h.call('A', 'reapIfIdle'))
    expect(out.action).toBe('reap')
    expect(out.reaped).toBe(true)
    expect(h.world.events).toEqual(['close-pages', `kill-port:${PORT}`, 'remove-record'])
  })

  it("drops B at once on its disconnect (kill -9) even when B's last activity was 1 s ago", async () => {
    const h = makeHost()
    await h.join('A', 101)
    await h.join('B', 202)
    await h.notify('B', 'activity')
    h.advance(1_000)
    // kill -9 of B: no `release`, the kernel closes B's socket and the transport reports the disconnect.
    h.host.onClientDisconnect('B', 'end')
    expect(h.host.clients().map((c) => c.id)).toEqual(['A'])
    const out = resultOf<{ action: string; reaped: boolean }>(await h.call('A', 'reapIfIdle'))
    expect(out).toMatchObject({ action: 'reap', reaped: true })
  })

  it("never lets the caller's own activity pin Chrome", async () => {
    const h = makeHost()
    await h.join('A', 101)
    await h.notify('A', 'activity')
    const out = resultOf<{ action: string }>(await h.call('A', 'reapIfIdle'))
    expect(out.action).toBe('reap')
  })

  it('a periodic tick also defers to any client active within the window (no caller excluded)', async () => {
    const h = makeHost()
    await h.join('A', 101)
    await h.notify('A', 'activity')
    h.advance(IDLE - 1)
    const out = await h.host.tick()
    expect(out).toEqual({ action: 'keep', pinnedBy: 'client', reaped: false })
  })

  it('does nothing when Chrome is not running', async () => {
    const h = makeHost({}, { chromeUp: false })
    await h.join('A', 101)
    const out = resultOf<{ action: string }>(await h.call('A', 'reapIfIdle'))
    expect(out.action).toBe('none')
    expect(h.world.events).toEqual([])
  })
})
