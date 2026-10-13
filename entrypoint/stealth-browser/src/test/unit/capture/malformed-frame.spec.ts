/**
 * Malformed protocol input.
 * Ticket 8468f7b1 AC capture-upgrade.23 · [capture-upgrade.23]
 * Real use: one malformed Network event (a field missing, the wrong type) must
 * be skipped and logged, never abort the capture or lose the good traffic
 * around it.
 */
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import { fixtureWith, optionsFor, useFixture, WS_URL } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.23] malformed events are skipped and logged', () => {
  useFixture(() =>
    fixtureWith('doc-200', (f) => {
      const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
      nav?.emit?.unshift(
        { method: 'Network.requestWillBeSent', params: { requestId: 'BAD1' } }, // no request
        { method: 'Network.requestWillBeSent', params: { request: { url: 'https://site.test/x' } } }, // no requestId
        { method: 'Network.responseReceived', params: { requestId: 'R1', response: 'not-an-object' } },
        { method: 'Network.loadingFinished', params: {} },
      )
    }),
  )

  it('the malformed events are logged and the real page is still captured', async () => {
    const opts = optionsFor('doc-200')
    const out = await captureNetworkResponse(WS_URL, opts)
    expect(out.status).toBe(200)
    expect(out.body).toContain('hello')
    const malformed = opts.logs.filter((l) => l.includes('malformed'))
    expect(malformed.length).toBe(4)
    expect(malformed.some((l) => l.includes('Network.requestWillBeSent'))).toBe(true)
  })
})
