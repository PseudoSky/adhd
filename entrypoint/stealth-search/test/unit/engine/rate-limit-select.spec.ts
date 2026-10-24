/**
 * guards: a captured 429 or 503 is hidden behind a larger 200 body or the id=rso body
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.12]
 * Rate limits are visible even when the page is small: the `select` function the engine hands to the core
 * capture prefers a captured 429 or 503 response over the id="rso" body and over a larger 200 body.
 * Ticket 8468f7b1 · [search-port-engine.12] · commit 591e1a7.
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { networkSearch, retryAfterOf, selectCandidate } from '../../../src/lib/network.js'
import { exchange, exchangesCapture, fixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const arxiv = getProvider('arxiv')
const google = getProvider('google')
const bigPage = `<html><body>${Array.from({ length: 200 }, (_, i) => `<li class="arxiv-result"><p class="title"><a href="/abs/2410.${String(i).padStart(5, '0')}">paper ${i}</a></p></li>`).join('')}</body></html>`
const run = async (landings: Parameters<typeof exchangesCapture>[0]) => {
  const rec = recordingCapture(exchangesCapture(landings))
  return networkSearch('ws://page', arxiv, 'cross-file refactoring', {}, makeDeps({ capture: rec.capture }))
}

describe('591e1a7: select prefers a rate-limit response [search-port-engine.12]', () => {
  it('429: a large 200 body and a small 429 body with retry-after 30 give outcome rate_limited with the retry-after surfaced', async () => {
    const r = await run([
      { at: 0, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 200, body: bigPage }) },
      { at: 5, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 429, body: 'Too Many Requests', headers: { 'retry-after': '30' } }) },
    ])
    expect(r.outcome).toBe('rate_limited')
    expect(r.error).toBe('Ban detected: rate_limited (HTTP 429, retry-after 30)')
    expect(r.raw?.status).toBe(429)
    expect(r.raw?.preview).toBe('Too Many Requests')
    expect(r.count).toBe(0)
  })

  it('429: the 429 wins whatever order the responses landed in', async () => {
    const r = await run([
      { at: 0, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 429, body: 'slow down', headers: { 'retry-after': '30' } }) },
      { at: 5, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 200, body: bigPage }) },
    ])
    expect(r.outcome).toBe('rate_limited')
  })

  it('503: a small 503 body outranks a larger 200 body (a challenge or overload page reaches the ban rules) and Retry-After is read case-insensitively', async () => {
    const r = await run([
      { at: 0, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 200, body: bigPage }) },
      { at: 5, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 503, body: 'unavailable', headers: { 'Retry-After': '120' } }) },
    ])
    expect(r.outcome).toBe('rate_limited')
    expect(r.error).toContain('HTTP 503')
    expect(r.error).toContain('retry-after 120')
    expect(retryAfterOf({ 'Retry-After': '120' })).toBe('120')
    expect(retryAfterOf({ other: '1' })).toBeUndefined()
    expect(retryAfterOf(undefined)).toBeUndefined()
  })

  it('no status recorded: an exchange without a status is assumed 200, so the unchanged largest-body rule applies', async () => {
    const r = await run([
      { at: 0, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 0, body: bigPage }) },
      { at: 5, exchange: exchange({ url: 'https://arxiv.org/search/?query=a', status: 0, body: 'tiny' }) },
    ])
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(200)
    expect(r.raw?.status).toBe(200)
  })

  it('select: a rate-limit status outranks the rso rule, the rso rule outranks a larger body, and the largest body wins otherwise (ties to the later capture)', () => {
    const limited = exchange({ url: 'u1', status: 429, body: 'x' })
    const rso = exchange({ url: 'u2', status: 200, body: '<div id="rso">r</div>' })
    const large = exchange({ url: 'u3', status: 200, body: 'L'.repeat(500) })
    const tieA = exchange({ url: 'u4', status: 200, body: 'aaa' })
    const tieB = exchange({ url: 'u5', status: 200, body: 'bbb' })
    expect(selectCandidate([large, rso, limited])?.url).toBe('u1')
    expect(selectCandidate([large, rso])?.url).toBe('u2')
    expect(selectCandidate([exchange({ url: 'h', status: 200, body: 'see #rso here' }), large])?.url).toBe('h')
    expect(selectCandidate([tieA, large])?.url).toBe('u3')
    expect(selectCandidate([tieA, tieB])?.url).toBe('u5')
    expect(selectCandidate([])).toBeUndefined()
  })

  it('select: a 503 counts like a 429 and a 500 does not; a missing status (0) is treated as 200', () => {
    expect(selectCandidate([exchange({ url: 'big', status: 200, body: 'B'.repeat(50) }), exchange({ url: 's503', status: 503, body: 'n' })])?.url).toBe('s503')
    expect(selectCandidate([exchange({ url: 'big', status: 200, body: 'B'.repeat(50) }), exchange({ url: 's500', status: 500, body: 'n' })])?.url).toBe('big')
    expect(selectCandidate([exchange({ url: 'big', status: 0, body: 'B'.repeat(50) }), exchange({ url: 'small0', status: 0, body: 'n' })])?.url).toBe('big')
  })

  it('rso: a smaller response carrying id="rso" is the one read for Google, ahead of a larger 200 body', async () => {
    const serp = fixture('google-serp.html')
    const decoy = `<html><body>${'x'.repeat(serp.length * 3)}</body></html>`
    const rec = recordingCapture(
      exchangesCapture([
        { at: 0, exchange: exchange({ url: 'https://www.google.com/search?q=decoy', status: 200, body: decoy }) },
        { at: 5, exchange: exchange({ url: 'https://www.google.com/search?q=serp', status: 200, body: serp }) },
      ]),
    )
    const r = await networkSearch('ws://page', google, 'structured logging node', {}, makeDeps({ capture: rec.capture }))
    expect(r.raw?.sourceUrl).toBe('https://www.google.com/search?q=serp')
    expect(r.contentSize).toBe(serp.length)
  })
})
