/**
 * guards: parallel search calls lose a result, return the wrong url or provider, or exceed the concurrency cap
 * tier: S
 * cites: ticket 8468f7b1 [search-verbs.12]
 * Parallel calls return one result each: five concurrent `search` calls with the fetch provider run through
 * the real FIFO queue on the fake core (one URL not found, one whose CDP call rejects with a Page.enable
 * timeout, one whose page closes mid-render, two good). Promise.all resolves with five results, each carrying
 * its own url and provider; failures are outcome `error`, never undefined, null, an empty object or a rejection;
 * the concurrency cap holds.
 *
 * Inventory rows: I-04 (concurrency cap), I-14 (dispose in finally).
 * Ticket 8468f7b1 · backlog 86ed154e · [search-verbs.12]
 */
import { describe, expect, it } from 'vitest'
import type { SearchOutput } from '../../../src/api.js'
import type { FetchDeps, FetchSession } from '../../../src/lib/fetch/fetch.js'
import { makeWorld } from '../../helpers/verbs/harness.js'

const GOOD_A = 'https://example.com/good-a'
const GOOD_B = 'https://example.com/good-b'
const MISSING = 'https://example.com/missing'
const ENABLE_TIMEOUT = 'https://example.com/enable-timeout'
const CLOSES = 'https://example.com/closes-mid-render'

const MARKDOWN = `# A page\n\n${'A real, substantial paragraph of documentation text. '.repeat(80)}`
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Fetch collaborators whose behavior is decided per URL when the pipeline navigates. */
function scriptedFetch(): Partial<FetchDeps> {
  return {
    newSession: () => {
      const handlers = new Map<string, Array<(p: Record<string, unknown>) => void>>()
      let url = ''
      const session: FetchSession & { setUrl(u: string): void; emit(m: string, p: Record<string, unknown>): void } = {
        setUrl: (u) => {
          url = u
        },
        emit: (m, p) => (handlers.get(m) ?? []).forEach((h) => h(p)),
        connect: async () => undefined,
        on: (m, h) => {
          handlers.set(m, [...(handlers.get(m) ?? []), h])
          return () => undefined
        },
        close: () => undefined,
        send: (async (method: string) => {
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
          if (method === 'DOM.getOuterHTML') {
            if (url === CLOSES) throw new Error('Target closed: the page was closed during render')
            return { outerHTML: '<html><head><title>A page</title></head><body>content</body></html>' }
          }
          return {}
        }) as FetchSession['send'],
      }
      return session
    },
    settle: async (rawSession, { navigate }) => {
      const session = rawSession as FetchSession & { setUrl(u: string): void; emit(m: string, p: Record<string, unknown>): void }
      session.setUrl(navigate)
      await tick(5) // keep pages open long enough for the queue to matter
      if (navigate === ENABLE_TIMEOUT) throw new Error('CDP Page.enable timed out after 10000ms')
      session.emit('Network.responseReceived', { type: 'Document', requestId: 'r1', response: { url: navigate, status: navigate === MISSING ? 404 : 200, mimeType: 'text/html' } })
      return { signal: 'networkIdle', settled: true, tookMs: 5 }
    },
    toMarkdown: async () => ({ markdown: MARKDOWN, via: 'turndown', truncated: false }),
  }
}

describe('86ed154e: five concurrent fetch calls return one result each [search-verbs.12]', () => {
  const urls = [GOOD_A, MISSING, ENABLE_TIMEOUT, CLOSES, GOOD_B]

  async function run(): Promise<{ results: SearchOutput[]; world: ReturnType<typeof makeWorld> }> {
    const world = makeWorld({ fetch: scriptedFetch() })
    const results = await Promise.all(urls.map((url) => world.svc.search({ provider: 'fetch', query: url, content: 'full' })))
    return { results, world }
  }

  it('Promise.all: five concurrent results come back, none thrown, none undefined, null or an empty object', async () => {
    const { results } = await run()
    expect(results).toHaveLength(5)
    for (const r of results) {
      expect(r).toBeTruthy()
      expect(typeof r).toBe('object')
      expect(Object.keys(r).length).toBeGreaterThan(0)
      expect(r.outcome).toBeTypeOf('string')
    }
  })

  it('per-URL: each result carries its own url and provider, in call order', async () => {
    const { results } = await run()
    expect(results.map((r) => r.url)).toEqual(urls)
    expect(results.every((r) => r.provider === 'fetch')).toBe(true)
    expect(results.map((r) => r.query)).toEqual(urls)
  })

  it('outcome: the failing URLs are outcome error with a message, the good ones success with content', async () => {
    const { results } = await run()
    const [goodA, missing, enableTimeout, closes, goodB] = results
    expect(goodA).toMatchObject({ outcome: 'success', attempts: 1 })
    expect(goodB).toMatchObject({ outcome: 'success', attempts: 1 })
    expect(goodA?.content).toContain('A real, substantial paragraph')
    expect(missing).toMatchObject({ outcome: 'error', status: 404 })
    expect(missing?.error).toContain('404')
    expect(enableTimeout).toMatchObject({ outcome: 'error' })
    expect(enableTimeout?.error).toContain('Page.enable')
    expect(closes).toMatchObject({ outcome: 'error' })
    expect(closes?.error).toContain('closed')
    for (const bad of [missing, enableTimeout, closes]) expect(bad?.content).toBeUndefined()
  })

  it('concurrent: the cap of 2 is respected, every page is disposed and the queue drained', async () => {
    const { world } = await run()
    expect(world.core.pages).toHaveLength(5)
    expect(world.core.maxLive).toBe(2)
    expect(world.core.live).toBe(0)
    expect(world.core.pages.every((p) => p.disposed === 1)).toBe(true)
  })

  it('concurrent: a failing call never starves the others, and the same set run again behaves identically', async () => {
    const world = makeWorld({ fetch: scriptedFetch(), config: { maxConcurrent: 1 } })
    for (let round = 0; round < 2; round++) {
      const results = await Promise.all(urls.map((url) => world.svc.search({ provider: 'fetch', query: url })))
      expect(results.map((r) => r.outcome)).toEqual(['success', 'error', 'error', 'error', 'success'])
    }
    expect(world.core.maxLive).toBe(1)
    expect(world.core.live).toBe(0)
  })
})
