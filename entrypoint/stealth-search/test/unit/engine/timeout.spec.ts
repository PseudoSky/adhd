/**
 * guards: the capture wait ignores the request timeoutMs and uses a fixed 10 s on the primary, fallback or retry call
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.13]
 * The capture wait honours the request timeout: networkSearch passes the SearchInput timeoutMs (default 30000)
 * as the capture wait for the primary call, the fallback call and the post-challenge retry call, never a fixed 10 s.
 * Ticket 8468f7b1 · [search-port-engine.13] · commit 591e1a7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { networkSearch, runStrategies } from '../../../src/lib/network.js'
import { body, exchange, exchangesCapture, fixture, FakePage, makeClock, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const arxiv = getProvider('arxiv')
const ddgResults = fixture('ddg-results.html')
const arxivPage = '<html><body><li class="arxiv-result"><p class="title is-5"><a href="/abs/2410.00001">A paper</a></p><span class="abstract-short">s</span></li></body></html>'

describe('591e1a7: timeoutMs reaches the capture [search-port-engine.13]', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('14000: a response delivered at 14000 ms is captured with timeoutMs 30000 (a fixed 10 s would report timeout)', async () => {
    const rec = recordingCapture(exchangesCapture([{ at: 14000, exchange: exchange({ url: 'https://arxiv.org/search/?query=x', status: 200, body: arxivPage }) }]))
    const pending = networkSearch('ws://page', arxiv, 'x', { timeoutMs: 30000 }, makeDeps({ capture: rec.capture, now: () => Date.now() }))
    await vi.advanceTimersByTimeAsync(14000)
    const r = await pending
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(1)
    expect(rec.calls[0]?.options.timeoutMs).toBe(30000)
    expect(r.tookMs).toBe(14000)
  })

  it('5000: the same response with timeoutMs 5000 is outcome timeout, reported at 5000 ms (not empty)', async () => {
    const rec = recordingCapture(exchangesCapture([{ at: 14000, exchange: exchange({ url: 'https://arxiv.org/search/?query=x', status: 200, body: arxivPage }) }]))
    const pending = networkSearch('ws://page', arxiv, 'x', { timeoutMs: 5000 }, makeDeps({ capture: rec.capture, now: () => Date.now() }))
    await vi.advanceTimersByTimeAsync(5000)
    const r = await pending
    expect(r.outcome).toBe('timeout')
    expect(r.error).toBe('nothing captured within 5000ms')
    expect(r.tookMs).toBe(5000)
    expect(rec.calls[0]?.options.timeoutMs).toBe(5000)
  })

  it('30000: with no timeoutMs given the capture wait is the 30000 default', async () => {
    const rec = recordingCapture(exchangesCapture([{ at: 14000, exchange: exchange({ url: 'https://arxiv.org/search/?query=x', status: 200, body: arxivPage }) }]))
    const pending = networkSearch('ws://page', arxiv, 'x', {}, makeDeps({ capture: rec.capture, now: () => Date.now() }))
    await vi.advanceTimersByTimeAsync(14000)
    expect((await pending).outcome).toBe('success')
    expect(rec.calls[0]?.options.timeoutMs).toBe(30000)
  })
})

describe('591e1a7: all three call sites receive timeoutMs [search-port-engine.13]', () => {
  const page = { pageWsUrl: 'ws://page', reveal: async () => undefined }

  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('primary call: runStrategies with timeoutMs %s passes %i to the first capture', async (given, expected) => {
    const rec = recordingCapture(async () => body(arxivPage))
    await runStrategies(page, arxiv, 'x', { timeoutMs: given }, makeDeps({ capture: rec.capture }))
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual([expected])
  })

  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('fallback call: the github fallback capture (primary direct fetch failing) with timeoutMs %s receives %i', async (given, expected) => {
    const github = getProvider('github')
    const rec = recordingCapture(async () => body('<html></html>', { url: 'https://github.com/search?q=vite&type=repositories' }))
    const fetched: string[] = []
    await runStrategies(
      page,
      github,
      'vite',
      { timeoutMs: given },
      makeDeps({
        capture: rec.capture,
        fetchImpl: async (url) => {
          fetched.push(String(url))
          return new Response('{}', { status: 500 })
        },
      }),
    )
    expect(fetched).toHaveLength(1)
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual([expected])
  })

  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('post-challenge retry call: the primary and the retry capture with timeoutMs %s both receive %i', async (given, expected) => {
    const pypi = getProvider('pypi')
    const clean = new FakePage({ html: fixture('pypi-results.html') })
    const rec = recordingCapture(async (_call, n) => (n === 0 ? body(fixture('cf-challenge.html')) : body(fixture('pypi-results.html'))))
    const clock = makeClock()
    const r = await runStrategies(page, pypi, 'requests', { timeoutMs: given }, makeDeps({ capture: rec.capture, clock, connect: async () => clean }))
    expect(rec.calls).toHaveLength(2)
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual([expected, expected])
    expect(r.outcome).toBe('success')
  })

  it('a fixed 10 s is never used: the default capture wait is not the core default', async () => {
    const rec = recordingCapture(async () => body(ddgResults))
    await networkSearch('ws://page', getProvider('duckduckgo'), 'x', {}, makeDeps({ capture: rec.capture }))
    expect(rec.calls[0]?.options.timeoutMs).not.toBe(10_000)
  })
})
