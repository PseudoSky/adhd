/**
 * Feature pins of the capture failsafe inventory (fs-123 to fs-132).
 * Ticket 8468f7b1 AC capture-upgrade.28 · [capture-upgrade.28]
 * Each test keeps one behaviour of the original event-driven capture alive on
 * the new pipeline, by the row id in its comment.
 * guards: resolves after the extra wait once a body is captured
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.28]
 */
import { describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { CaptureError } from '../../../src/lib/recording/errors.js'
import { fixtureWith, optionsFor, silentFixture, track, useFixture, WS_URL, fireRequest } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.28] [fs-123] extra wait', () => {
  useFixture('doc-200')
  it('resolves after the extra wait once a body is captured', async () => {
    // [fs-123] the quiet period is extraWaitMs (default now 0: the old 500 ms default for an unset or zero value is gone)
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { extraWaitMs: 200 })))
    await vi.advanceTimersByTimeAsync(199)
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await t.value()).body).toContain('hello')
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-124] single winner', () => {
  useFixture(() =>
    fixtureWith('two-tabs-parallel', (f) => {
      const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
      f.steps.splice(
        generic,
        1,
        { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { result: { body: '<html>the whole document with content</html>', base64Encoded: false } } },
        { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: '{}', base64Encoded: false } } },
      )
    }),
  )
  it('the largest matching body wins', async () => {
    // [fs-124]
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel'))
    expect(out.requestId).toBe('A1')
    expect(out.body).toContain('whole document')
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-125] url pattern', () => {
  const rig = useFixture('two-tabs-parallel')
  it('captures only urls matching the pattern', async () => {
    // [fs-125] fetched at loadingFinished through Network.getResponseBody, only for matches
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { urlPattern: /\/b$/ }))
    expect(out.url).toBe('https://site.test/b')
    expect(rig.server.received.filter((r) => r.method === 'Network.getResponseBody').map((r) => r.params['requestId'])).toEqual(['B1'])
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-126] base64 bodies', () => {
  useFixture('binary-base64')
  it('decodes base64 bodies', async () => {
    // [fs-126]
    const out = await captureNetworkResponse(WS_URL, optionsFor('binary-base64'))
    expect(out.body).toBe(Buffer.from('iVBORw0KGgo=', 'base64').toString('utf-8'))
    expect(out.exchange.response?.bodyEncoding).toBe('base64')
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-126] a failing getResponseBody is ignored', () => {
  useFixture(() =>
    fixtureWith('two-tabs-parallel', (f) => {
      const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
      f.steps.splice(
        generic,
        1,
        { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { error: { code: -32000, message: 'No resource' } } },
        { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: 'survivor', base64Encoded: false } } },
      )
    }),
  )
  it('ignores the failed fetch and keeps the response that did arrive', async () => {
    // [fs-126]
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel'))
    expect(out.body).toBe('survivor')
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-127] timeout', () => {
  useFixture(() => silentFixture())
  it('times out gracefully with no match', async () => {
    // [fs-127] default timeout is 10 s
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, { urlPattern: /x/, navigateUrl: 'https://site.test/home', logger: () => undefined }))
    const assertion = expect(t.value()).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(t.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-128] socket error', () => {
  const rig = useFixture(() => silentFixture())
  it('a socket error ends the capture', async () => {
    // [fs-128] the capture ends instead of hanging until the timeout
    vi.useFakeTimers()
    const t = track(captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 60_000 })))
    const assertion = expect(t.value()).rejects.toMatchObject({ code: 'CAPTURE_SESSION_CLOSED' })
    await vi.advanceTimersByTimeAsync(10)
    rig.server.closeFromServer()
    await vi.advanceTimersByTimeAsync(60)
    expect(t.done()).toBe(true)
    await assertion
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-129] events after the timeout', () => {
  const rig = useFixture(() => silentFixture())
  it('ignores events after the timeout', async () => {
    // [fs-129]
    vi.useFakeTimers()
    const seen: string[] = []
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 100, onExchange: (e) => seen.push(e.requestId) }))
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    fireRequest(rig.server, 'LATE')
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual([])
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-130] setup commands', () => {
  const rig = useFixture('doc-200')
  it('enables Page and Network then navigates', async () => {
    // [fs-130] the order is Page.enable, Network.enable, Page.navigate; a failing one is logged (graceful.spec.ts)
    await captureNetworkResponse(WS_URL, optionsFor('doc-200'))
    expect(rig.server.received.slice(0, 3).map((r) => r.method)).toEqual(['Page.enable', 'Network.enable', 'Page.navigate'])
    expect(rig.server.received[2]?.params).toEqual({ url: 'https://site.test/home' })
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-131] nothing matched', () => {
  useFixture('doc-200')
  it('reports no matching request', async () => {
    // [fs-131] an empty-handed capture throws a typed error instead of returning nothing
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { urlPattern: /never/, timeoutMs: 250 }))
    const assertion = expect(p).rejects.toBeInstanceOf(CaptureError)
    await vi.advanceTimersByTimeAsync(250)
    await assertion
    await expect(p).rejects.toMatchObject({ code: 'CAPTURE_NO_MATCH' })
  })
})

describe('8468f7b1 [capture-upgrade.28] [fs-132] ban rules', () => {
  useFixture('doc-200')
  it('ban rules reject the captured response', async () => {
    // [fs-132]
    await expect(
      captureNetworkResponse(WS_URL, optionsFor('doc-200', { banRules: [{ name: 'greeting', signal: 'captcha', checkBody: /hello/ }] })),
    ).rejects.toMatchObject({ code: 'CAPTURE_BAN_DETECTED', detail: { signal: 'captcha' } })
  })
})
