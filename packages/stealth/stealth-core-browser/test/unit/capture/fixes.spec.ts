/**
 * Fix register of the capture rewrite.
 * Ticket 8468f7b1 AC capture-upgrade.25 · [capture-upgrade.25]
 * One named test per recorder fix X1 to X7 (EVAL-store-adapter-v1.md section 4),
 * each asserting the NEW behaviour so a regression is traceable by id.
 * guards: X1 the default and an explicit 0 add no wait (the old code waited 500 ms for both)
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.25]
 */
import { describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { fixtureWith, optionsFor, silentFixture, track, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.25] X1 default debounce', () => {
  useFixture('doc-200')
  it('X1 the default and an explicit 0 add no wait (the old code waited 500 ms for both)', async () => {
    vi.useFakeTimers()
    const unset = track(captureNetworkResponse(WS_URL, optionsFor('doc-200')))
    const zero = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 0 })))
    await vi.advanceTimersByTimeAsync(0)
    expect(unset.done()).toBe(true)
    expect(zero.done()).toBe(true)
  })
})

describe('8468f7b1 [capture-upgrade.25] X2 and X3 real wire data', () => {
  useFixture('search-404')
  it('X2 status is the real status, not a hard-coded success', async () => {
    expect((await captureNetworkResponse(WS_URL, optionsFor('search-404'))).status).toBe(404)
  })
  it('X3 requestId, method and response headers are real, not fabricated', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('search-404'))
    expect(out.requestId).toBe('R1')
    expect(out.method).toBe('GET')
    expect(out.responseHeaders?.['content-type']).toBe('application/json')
  })
})

describe('8468f7b1 [capture-upgrade.25] X4 a closed socket fails fast', () => {
  const rig = useFixture(() => silentFixture())
  it('X4 closeFromServer mid-capture rejects SESSION_CLOSED within the poll interval, not after the whole timeout', async () => {
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 30_000 })))
    const assertion = expect(t.value()).rejects.toMatchObject({ code: 'CAPTURE_SESSION_CLOSED' })
    await vi.advanceTimersByTimeAsync(10)
    rig.server.closeFromServer()
    await vi.advanceTimersByTimeAsync(60)
    expect(t.done()).toBe(true)
    await assertion
  })
})

describe('8468f7b1 [capture-upgrade.25] X5 timers are cleared', () => {
  useFixture('doc-200')
  it('X5 after a successful capture with the default timeout no timer is left running', async () => {
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: undefined }))
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('8468f7b1 [capture-upgrade.25] X6 malformed input does not throw out of the listener', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      f.steps.find((s) => s.when.method === 'Page.navigate')?.emit?.unshift({ method: 'Network.loadingFailed', params: { requestId: 42 } })
    }),
  )
  it('X6 a malformed event is logged and skipped', async () => {
    const opts = optionsFor('doc-200')
    await expect(captureNetworkResponse(WS_URL, opts)).resolves.toMatchObject({ status: 200 })
    expect(opts.logs.some((l) => l.includes('malformed'))).toBe(true)
  })
})

describe('8468f7b1 [capture-upgrade.25] X7 navigation failure is typed', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      if (nav) {
        nav.reply = { result: { errorText: 'net::ERR_CONNECTION_REFUSED' } }
        nav.emit = []
      }
    }),
  )
  it('X7 a failed Page.navigate is CAPTURE_NAVIGATE_FAILED, not a late generic timeout', async () => {
    await expect(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 30_000 }))).rejects.toMatchObject({
      code: 'CAPTURE_NAVIGATE_FAILED',
      detail: { errorText: 'net::ERR_CONNECTION_REFUSED' },
    })
  })
})
