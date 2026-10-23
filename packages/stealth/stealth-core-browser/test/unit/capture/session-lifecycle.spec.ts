/**
 * Session ownership and cleanup.
 * Ticket 8468f7b1 AC capture-upgrade.22 · [capture-upgrade.22]
 * Real use: a capture run must leave nothing behind (no socket, no timer, no
 * stray callbacks), and it must never close a session a caller handed in.
 * guards: on success
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.22]
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { CdpSession } from '../../../src/lib/cdp/session.js'
import { connectSession, fireRequest, makeSinkSpy, optionsFor, silentFixture, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

afterEach(() => vi.restoreAllMocks())

describe('8468f7b1 [capture-upgrade.22] the session the wrapper created is always closed', () => {
  useFixture('doc-200')

  it('on success', async () => {
    const close = vi.spyOn(CdpSession.prototype, 'close')
    await captureNetworkResponse(WS_URL, optionsFor('doc-200'))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('on a ban', async () => {
    const close = vi.spyOn(CdpSession.prototype, 'close')
    await expect(captureNetworkResponse(WS_URL, optionsFor('doc-200', { banRules: [{ name: 'x', signal: 'banned', checkBody: /hello/ }] }))).rejects.toMatchObject({ code: 'CAPTURE_BAN_DETECTED' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('on a no-match error', async () => {
    vi.useFakeTimers()
    const close = vi.spyOn(CdpSession.prototype, 'close')
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { urlPattern: /nope/, timeoutMs: 200 }))
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_NO_MATCH' })
    await vi.advanceTimersByTimeAsync(200)
    await assertion
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('8468f7b1 [capture-upgrade.22] timeout path and timers', () => {
  useFixture(() => silentFixture())

  it('closes the session on timeout and leaves no timer pending', async () => {
    vi.useFakeTimers()
    const close = vi.spyOn(CdpSession.prototype, 'close')
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 300 }))
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(300)
    await assertion
    expect(close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.22] success leaves no timer pending', () => {
  useFixture('doc-200')

  it('even with a long timeoutMs and a debounce', async () => {
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 60_000, extraWaitMs: 250 }))
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.22] a caller-supplied session', () => {
  const rig = useFixture('doc-200')

  it('is never closed; events after the capture returned reach neither onExchange nor the sink', async () => {
    const session = await connectSession()
    const close = vi.spyOn(session, 'close')
    const sink = makeSinkSpy()
    const seen: string[] = []
    const out = await captureNetworkResponse(WS_URL, optionsFor('doc-200', { session, sink, onExchange: (e) => seen.push(e.requestId) }))
    expect(out.status).toBe(200)
    expect(close).not.toHaveBeenCalled()
    expect(session.connected).toBe(true)
    expect(seen).toEqual(['R1'])
    expect(sink.written).toHaveLength(1)

    fireRequest(rig.server, 'LATE')
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['R1'])
    expect(sink.written).toHaveLength(1)
    expect(sink.log.filter((l) => l === 'close')).toHaveLength(1)
  })
})
