/**
 * Redirect chains.
 * Ticket 8468f7b1 AC capture-upgrade.7 · [capture-upgrade.7]
 * Real use: a page that 301s must be one exchange that remembers the hop, so a
 * replay knows where it was sent and what the final answer was.
 */
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../lib/capture/network.js'
import { optionsFor, useFixture, WS_URL } from './capture-kit.js'

describe('8468f7b1 [capture-upgrade.7] redirect-301-200', () => {
  const rig = useFixture('redirect-301-200')

  it('keeps the 301 hop with its location header and returns the final 200 under the same requestId', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('redirect-301-200'))
    expect(out.redirects).toHaveLength(1)
    expect(out.redirects[0]?.response.status).toBe(301)
    expect(out.redirects[0]?.response.headers['location']).toBe('https://site.test/new')
    expect(out.redirects[0]?.request.url).toBe('https://site.test/old')
    expect(out.status).toBe(200)
    expect(out.requestId).toBe('R1')
    expect(out.url).toBe('https://site.test/new') // final hop
    expect(out.body).toBe('<html>new</html>')
    expect(out.exchange.requestId).toBe('R1')
    expect(rig.server.received.filter((r) => r.method === 'Network.getResponseBody')).toHaveLength(1)
  })
})
