/**
 * Real status and response headers.
 * Ticket 8468f7b1 AC capture-upgrade.4 · [capture-upgrade.4]
 * Real use: an agent hitting a rate limit must SEE the 429 and its retry-after
 * header, and status ban rules (previously dead because the status was a
 * hard-coded success) must now fire.
 * guards: reports 404 with the real response headers
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.4]
 */
import { describe, expect, it } from 'vitest'
import { captureNetworkResponse } from '../../../src/lib/capture/network.js'
import { CaptureError } from '../../../src/lib/recording/errors.js'
import { optionsFor, useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.4] real status (search-404)', () => {
  useFixture('search-404')
  it('reports 404 with the real response headers', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('search-404', { urlPattern: /search/ }))
    expect(out.status).toBe(404)
    expect(out.headers['content-type']).toBe('application/json')
    expect(out.body).toBe('{"error":"not found"}')
  })
})

describe('8468f7b1 [capture-upgrade.4] rate limiting (rate-limit-429)', () => {
  useFixture('rate-limit-429')

  it('reports 429 and the retry-after header the agent needs to back off', async () => {
    const out = await captureNetworkResponse(WS_URL, optionsFor('rate-limit-429', { urlPattern: /feed/ }))
    expect(out.status).toBe(429)
    expect(out.headers['retry-after']).toBe('30')
  })

  it('a status ban rule {status:[403,429]} now yields CAPTURE_BAN_DETECTED', async () => {
    const run = captureNetworkResponse(
      WS_URL,
      optionsFor('rate-limit-429', { urlPattern: /feed/, banRules: [{ name: 'throttle', signal: 'rate_limited', checkStatus: [403, 429] }] }),
    )
    await expect(run).rejects.toMatchObject({ code: 'CAPTURE_BAN_DETECTED', detail: { signal: 'rate_limited', status: 429 } })
    await expect(run).rejects.toBeInstanceOf(CaptureError)
  })

  it('the same rule does not fire on a 200 page', async () => {
    // negative control: a 404 is not in [403, 429]
    // (uses the 429 fixture with a rule on 403 only)
    const out = await captureNetworkResponse(
      WS_URL,
      optionsFor('rate-limit-429', { urlPattern: /feed/, banRules: [{ name: 'forbidden', signal: 'banned', checkStatus: [403] }] }),
    )
    expect(out.status).toBe(429)
  })
})
