/**
 * Public surface of capture/network.
 * Ticket 8468f7b1 AC capture-upgrade.12 · [capture-upgrade.12]
 * Real use: existing callers pass only urlPattern and navigateUrl and read
 * status, headers, body and url from the result; a 204 answer has an empty body.
 * guards: capture/network still exports both capture functions and the barrel re-exports them
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.12]
 */
import { describe, expect, it } from 'vitest'
import * as network from '../../../src/lib/capture/network.js'
import type { CapturedResponse, CaptureOptions } from '../../../src/lib/capture/network.js'
import * as captureBarrel from '../../../src/lib/capture/index.js'
import { useFixture, WS_URL } from '../../helpers/capture/capture-kit.js'

describe('8468f7b1 [capture-upgrade.12] exports', () => {
  it('capture/network still exports both capture functions and the barrel re-exports them', () => {
    expect(typeof network.captureNetworkResponse).toBe('function')
    expect(typeof network.captureAllNetworkResponses).toBe('function')
    expect(captureBarrel.captureNetworkResponse).toBe(network.captureNetworkResponse)
    expect(captureBarrel.captureAllNetworkResponses).toBe(network.captureAllNetworkResponses)
  })

  it('the minimal legacy options and the result fields still type-check', () => {
    const minimal: CaptureOptions = { urlPattern: /x/, navigateUrl: 'https://site.test/' }
    const shape = (r: CapturedResponse): [number, Record<string, string>, string, string] => [r.status, r.headers, r.body, r.url]
    expect(minimal.navigateUrl).toBe('https://site.test/')
    expect(typeof shape).toBe('function')
  })
})

describe('8468f7b1 [capture-upgrade.12] no-body-204', () => {
  useFixture('no-body-204')

  it('a 204 answer whose body fetch errors yields body === "" with the real status and method', async () => {
    const out = await network.captureNetworkResponse(WS_URL, { urlPattern: /api\/ping/, navigateUrl: 'https://site.test/api/ping', timeoutMs: 2_000 })
    expect(out.body).toBe('')
    expect(out.status).toBe(204)
    expect(out.method).toBe('POST')
    expect(out.url).toBe('https://site.test/api/ping')
    expect(out.headers).toBe(out.responseHeaders)
    expect(out.headers['content-type']).toBe('text/plain')
  })
})
