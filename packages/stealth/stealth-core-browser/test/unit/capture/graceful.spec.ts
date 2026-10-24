/**
 * Graceful capture outcomes.
 * Ticket 8468f7b1 AC capture-upgrade.19 · [capture-upgrade.19]
 * Real use: a slow page, a dying Chrome or a flaky command must not throw away
 * a response that was already captured. Only an empty-handed capture fails.
 * guards: extraWaitMs longer than timeoutMs: the timeout ends the capture as a success
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.19]
 */
import { describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import type { FakeWebSocket } from '../../helpers/fake-cdp.js'
import { fixtureWith, optionsFor, track, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.19] a timeout with one captured body returns it', () => {
  useFixture('doc-200')

  it('extraWaitMs longer than timeoutMs: the timeout ends the capture as a success', async () => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 5_000, timeoutMs: 1_000 })))
    await vi.advanceTimersByTimeAsync(999)
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await t.value()).body).toContain('hello')
  })
})

describe('8468f7b1 [capture-upgrade.19] a socket error after a captured body returns it', () => {
  const rig = useFixture('doc-200')

  it('error then close (how a WebSocket really dies) after the body landed still returns the body', async () => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 5_000, timeoutMs: 10_000 })))
    await vi.advanceTimersByTimeAsync(10)
    const socket = (rig.server as unknown as { sockets: FakeWebSocket[] }).sockets[0]
    ;(socket as unknown as { dispatch(type: string, ev: object): void }).dispatch('error', {})
    rig.server.closeFromServer()
    await vi.advanceTimersByTimeAsync(100)
    expect(t.done()).toBe(true)
    expect((await t.value()).status).toBe(200)
  })
})

describe('8468f7b1 [capture-upgrade.19] closeFromServer after a captured body returns it', () => {
  const rig = useFixture('doc-200')

  it('Chrome dying while the debounce is pending returns what was captured', async () => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 5_000, timeoutMs: 10_000 })))
    await vi.advanceTimersByTimeAsync(10)
    rig.server.closeFromServer()
    await vi.advanceTimersByTimeAsync(100)
    expect(t.done()).toBe(true)
    expect((await t.value()).body).toBe('<html><body>hello</body></html>')
  })
})

describe('8468f7b1 [capture-upgrade.19] rejected setup commands are logged and never throw while a body still lands', () => {
  const rejecting = (): ReturnType<typeof fixtureWith> =>
    fixtureWith('doc-200', (f) => {
      for (const s of f.steps) {
        if (['Page.enable', 'Network.enable', 'Page.navigate'].includes(s.when.method)) {
          s.reply = { error: { code: -32000, message: `${s.when.method} refused` } }
        }
      }
    })
  useFixture(rejecting)

  it('Page.enable, Network.enable and Page.navigate rejections are logged; the response is still captured', async () => {
    const opts = optionsFor('doc-200')
    const out = await captureNetworkResponse(WS_URL, opts)
    expect(out.status).toBe(200)
    expect(opts.logs.some((l) => l.includes('Page.enable'))).toBe(true)
    expect(opts.logs.some((l) => l.includes('Network.enable'))).toBe(true)
    expect(opts.logs.some((l) => l.includes('Page.navigate'))).toBe(true)
    expect(opts.logs).toHaveLength(3)
  })
})
