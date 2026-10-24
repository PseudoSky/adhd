/**
 * Selection features of the capture.
 * Ticket 8468f7b1 AC capture-upgrade.20 · [capture-upgrade.20]
 * Real use: only the traffic the agent asked for is fetched and considered;
 * a redirect does not lose the match; the largest body wins; empty answers are
 * answers and failed fetches are not.
 * guards: zero Network.getResponseBody calls for the non-matching id
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.20]
 */
import { describe, expect, it, vi } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { fixtureWith, optionsFor, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.20] only urlPattern-matching requests are body-fetched', () => {
  const rig = useFixture('two-tabs-parallel')

  it('zero Network.getResponseBody calls for the non-matching id', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel', { urlPattern: /\/a$/ }))
    expect(out.requestId).toBe('A1')
    const bodyCalls = rig.server.received.filter((r) => r.method === 'Network.getResponseBody')
    expect(bodyCalls.map((c) => c.params['requestId'])).toEqual(['A1'])
  })
})

describe('8468f7b1 [capture-upgrade.20] tracking is sticky across a redirect', () => {
  const rig = useFixture('redirect-301-200')

  it('first hop matches, second hop does not: still captured, url is the final hop', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('redirect-301-200', { urlPattern: /\/old$/ }))
    expect(out.requestId).toBe('R1')
    expect(out.url).toBe('https://site.test/new')
    expect(rig.server.received.filter((r) => r.method === 'Network.getResponseBody')).toHaveLength(1)
  })

  it('only the second hop matches: captured too, with the first hop kept in the chain', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('redirect-301-200', { urlPattern: /\/new$/ }))
    expect(out.url).toBe('https://site.test/new')
    expect(out.redirects).toHaveLength(1)
    expect(out.redirects[0]?.request.url).toBe('https://site.test/old')
  })
})

const withBodies = (a: string, b: string) => () =>
  fixtureWith('two-tabs-parallel', (f) => {
    const generic = f.steps.findIndex((s) => s.when.method === 'Network.getResponseBody')
    f.steps.splice(
      generic,
      1,
      { when: { method: 'Network.getResponseBody', params: { requestId: 'A1' } }, reply: { result: { body: a, base64Encoded: false } } },
      { when: { method: 'Network.getResponseBody', params: { requestId: 'B1' } }, reply: { result: { body: b, base64Encoded: false } } },
    )
  })

describe('8468f7b1 [capture-upgrade.20] the largest body wins', () => {
  useFixture(withBodies('a much longer first body', 'short'))
  it('even when it arrived first', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel'))
    expect(out.requestId).toBe('A1')
  })
})

describe('8468f7b1 [capture-upgrade.20] ties go to the later capture', () => {
  useFixture(withBodies('same-size', 'same-size'))
  it('equal lengths select the second to land', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('two-tabs-parallel'))
    expect(out.requestId).toBe('B1')
  })
})

describe('8468f7b1 [capture-upgrade.20] an empty-string body is a candidate', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const body = f.steps.find((s) => s.when.method === 'Network.getResponseBody')
      if (body) body.reply = { result: { body: '', base64Encoded: false } }
    }),
  )
  it('is returned as body ""', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('doc-200'))
    expect(out.body).toBe('')
    expect(out.status).toBe(200)
  })
})

describe('8468f7b1 [capture-upgrade.20] a body error on a 200 is not a candidate', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const body = f.steps.find((s) => s.when.method === 'Network.getResponseBody')
      if (body) body.reply = { error: { code: -32000, message: 'No resource with given identifier found' } }
    }),
  )
  it('the capture times out empty-handed instead of returning an empty page', async () => {
    vi.useFakeTimers()
    const p = captureNetworkResponse(WS_URL, optionsFor('doc-200', { timeoutMs: 300 }))
    const assertion = expect(p).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(300)
    await assertion
  })
})

describe('8468f7b1 [capture-upgrade.20] the result url', () => {
  useFixture('redirect-301-200')

  it('is the final hop url', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('redirect-301-200'))
    expect(out.url).toBe('https://site.test/new')
  })

  it('falls back to navigateUrl when the selected exchange carries no url', async () => {
    const out = await captureNetworkResponse(
      WS_URL,
      optionsFor('redirect-301-200', { select: (c) => (c[0] ? { ...c[0], url: '' } : undefined) }),
    )
    expect(out.url).toBe('https://site.test/old') // navigateUrl of the fixture
  })
})
