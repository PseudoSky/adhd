/**
 * The request timeout reaches every capture: the verb threads the SearchInput `timeoutMs` (default 30000)
 * to each engine `networkSearch` call (primary, fallback and the post-challenge retry), so a slow provider
 * response (arXiv, 8 to 16 s) is captured instead of reported `empty`. The real engine runs over a recording
 * capture; only the page, the clock and the network are fakes.
 *
 * Ticket 8468f7b1 · commit 591e1a7 · [search-verbs.14]
 */
import { describe, expect, it, vi } from 'vitest'
import { body, exchange, exchangesCapture, fixture, FakePage, githubFixture, makeClock, makeDeps, recordingCapture } from '../engine/harness.js'
import { input, makeWorld } from './harness.js'

const arxivPage = '<html><body><li class="arxiv-result"><p class="title is-5"><a href="/abs/2410.00001">A paper</a></p><span class="abstract-short">s</span></li></body></html>'

describe('591e1a7: timeoutMs reaches networkSearch from the verb [search-verbs.14]', () => {
  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('primary networkSearch: a search with timeoutMs %s records %i at the first capture', async (given, expected) => {
    const rec = recordingCapture(async () => body(arxivPage))
    const world = makeWorld({ engine: makeDeps({ capture: rec.capture }) })
    const out = await world.svc.search(input({ provider: 'arxiv', query: 'x', ...(given !== undefined ? { timeoutMs: given } : {}) }))
    expect(out.outcome).toBe('success')
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual([expected])
  })

  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('fallback networkSearch: github with the direct fetch failing and timeoutMs %s records %i at the fallback capture', async (given, expected) => {
    const rec = recordingCapture(async () => body(githubFixture('repo-search.html'), { url: 'https://github.com/search?q=vite&type=repositories' }))
    const world = makeWorld({
      engine: makeDeps({ capture: rec.capture, fetchImpl: async () => new Response('{}', { status: 500 }) }),
    })
    await world.svc.search(input({ ...(given !== undefined ? { timeoutMs: given } : {}) }))
    expect(rec.calls.length).toBeGreaterThan(0)
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual(rec.calls.map(() => expected))
  })

  it.each([
    [undefined, 30000],
    [12000, 12000],
  ])('post-challenge networkSearch retry: pypi behind a challenge with timeoutMs %s records %i at both captures', async (given, expected) => {
    const clean = new FakePage({ html: fixture('pypi-results.html') })
    const rec = recordingCapture(async (_call, n) => (n === 0 ? body(fixture('cf-challenge.html')) : body(fixture('pypi-results.html'))))
    const clock = makeClock()
    const world = makeWorld({ engine: makeDeps({ capture: rec.capture, clock, connect: async () => clean }) })
    const out = await world.svc.search(input({ provider: 'pypi', query: 'requests', ...(given !== undefined ? { timeoutMs: given } : {}) }))
    expect(rec.calls.map((c) => c.options.timeoutMs)).toEqual([expected, expected])
    expect(out.outcome).toBe('success')
  })

  it('30000: the wait the verb hands the capture is the deadline default, never a fixed 10 s', async () => {
    const rec = recordingCapture(async () => body(arxivPage))
    const world = makeWorld({ engine: makeDeps({ capture: rec.capture }) })
    await world.svc.search(input({ provider: 'arxiv', query: 'x' }))
    expect(rec.calls[0]?.options.timeoutMs).not.toBe(10_000)
    expect(rec.calls[0]?.options.timeoutMs).toBe(30000)
  })

  it('12000: a slow arXiv response at 14 s is captured under the 30000 default and reported timeout, not empty, under timeoutMs 12000', async () => {
    vi.useFakeTimers()
    try {
      const landing = [{ at: 14000, exchange: exchange({ url: 'https://arxiv.org/search/?query=x', status: 200, body: arxivPage }) }]
      const engine = () => makeDeps({ capture: recordingCapture(exchangesCapture(landing)).capture, sleep: async () => undefined, now: () => Date.now() })
      // under the default 30000 the response lands at 14 s and is captured
      const slow = makeWorld({ engine: engine() })
      const ok = slow.svc.search(input({ provider: 'arxiv', query: 'x', maxAttempts: 1 }))
      await vi.advanceTimersByTimeAsync(14_000)
      expect((await ok).outcome).toBe('success')
      // under 12000 nothing lands in time: a transport timeout
      const tight = makeWorld({ engine: engine() })
      const miss = tight.svc.search(input({ provider: 'arxiv', query: 'x', maxAttempts: 1, timeoutMs: 12000 }))
      await vi.advanceTimersByTimeAsync(12_000)
      expect((await miss).outcome).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
