/**
 * guards: a 400 KB page serializes over 8192 bytes by default, or full content ignores maxContentSize
 * tier: S
 * cites: ticket 8468f7b1 [search-verbs.10]
 * Verb output is token-efficient by default: a 400 KB page for the duckduckgo, github and fetch providers
 * serializes to under 8192 bytes (`Buffer.byteLength`) with `content: 'none'` and `preview: 'none'`;
 * `preview: 'include'` adds the preview; `content: 'full'` is bounded by `maxContentSize` and pages with `nextOffset`.
 *
 * Ticket 8468f7b1 · backlog cd05ad09 · [search-verbs.10]
 */
import { describe, expect, it } from 'vitest'
import type { SearchInput, SearchOutput } from '../../../src/api.js'
import type { FetchDeps } from '../../../src/lib/fetch/fetch.js'
import { DEFAULT_MAX_CONTENT_SIZE } from '../../../src/lib/fetch/fetch.js'
import { body, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'
import { makeWorld, type World } from '../../helpers/verbs/harness.js'

const KB = 1024
const wordy = (bytes: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(bytes / 27)).slice(0, bytes)

// ─── The three 400 KB pages ───────────────────────────────────────────────────

/** A duckduckgo html page of ten results with 30 KB snippets plus filler: 400 KB of HTML. */
function ddgPage(): string {
  const result = (i: number): string =>
    `<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">` +
    `<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp${i}&amp;rut=a${i}">Result ${i}</a></h2>` +
    `<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp${i}&amp;rut=a${i}">${wordy(30 * KB)}</a></div></div>`
  const html = `<html><head><title>q at DuckDuckGo</title></head><body><div id="links" class="results">${Array.from({ length: 10 }, (_, i) => result(i)).join('')}</div><!-- ${wordy(100 * KB)} --></body></html>`
  return html
}

/** A github API answer of ten repositories with 40 KB descriptions. */
function githubJson(): string {
  return JSON.stringify({
    total_count: 10,
    items: Array.from({ length: 10 }, (_, i) => ({
      full_name: `org/repo-${i}`,
      html_url: `https://github.com/org/repo-${i}`,
      description: wordy(40 * KB),
      stargazers_count: i,
      language: 'TypeScript',
      forks_count: i,
      updated_at: '2026-10-01',
    })),
  })
}

/** A rendered document of about 400 KB that converts to markdown of the same size. */
const FETCH_MARKDOWN = `# A very large page\n\n${wordy(400 * KB)}`
const FETCH_URL = 'https://example.com/very-large'

const fetchDeps = (): Partial<FetchDeps> => ({
  newSession: () => ({
    connect: async () => undefined,
    on: () => () => undefined,
    close: () => undefined,
    send: (async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.getOuterHTML') return { outerHTML: '<html><body>big</body></html>' }
      return {}
    }) as never,
  }),
  settle: async () => ({ signal: 'networkIdle', settled: true, tookMs: 1 }),
  toMarkdown: async () => ({ markdown: FETCH_MARKDOWN, via: 'turndown', truncated: false }),
})

interface Case {
  name: string
  world: () => World
  base: SearchInput
  /** The text a `content: 'full'` read must reassemble. */
  full: string
}

const cases: Case[] = [
  {
    name: 'duckduckgo',
    world: () => makeWorld({ engine: makeDeps({ capture: recordingCapture(async () => body(ddgPage())).capture }) }),
    base: { provider: 'duckduckgo', query: 'tree-sitter' },
    full: ddgPage(),
  },
  {
    name: 'github',
    world: () => makeWorld({ engine: makeDeps({ fetchImpl: async () => new Response(githubJson(), { status: 200, headers: { 'content-type': 'application/json' } }) }) }),
    base: { provider: 'github', query: 'vite' },
    full: githubJson(),
  },
  {
    name: 'fetch',
    world: () => makeWorld({ fetch: fetchDeps() }),
    base: { provider: 'fetch', query: FETCH_URL },
    full: FETCH_MARKDOWN,
  },
]

const size = (out: SearchOutput): number => Buffer.byteLength(JSON.stringify(out))

describe.each(cases)('cd05ad09: a 400 KB $name page [search-verbs.10]', (c) => {
  it('byteLength 8192: the default result (content none, preview none) serializes under 8192 bytes with no raw preview and no body', async () => {
    expect(Buffer.byteLength(c.full)).toBeGreaterThanOrEqual(390 * KB)
    const out = await c.world().svc.search(c.base)
    expect(out.outcome).toBe('success')
    expect(size(out)).toBeLessThan(8192)
    expect(out.content).toBeUndefined()
    expect(out.raw?.preview).toBeUndefined()
  })

  it('snippet: every hit is {title, url, snippet} with the snippet clamped to 300 characters (+ ellipsis)', async () => {
    const out = await c.world().svc.search(c.base)
    if (c.name !== 'fetch') {
      expect(out.results.length).toBeGreaterThan(0)
      for (const hit of out.results) {
        expect(Object.keys(hit)).toEqual(expect.arrayContaining(['title', 'url', 'snippet']))
        expect(hit.snippet.length).toBeLessThanOrEqual(301)
      }
    } else {
      expect(out.results).toEqual([])
    }
  })

  it('preview: preview include adds a bounded preview of the raw response or document head', async () => {
    const out = await c.world().svc.search({ ...c.base, preview: 'include' })
    expect(out.raw?.preview).toBeTypeOf('string')
    expect(Buffer.byteLength(out.raw?.preview ?? '')).toBeLessThanOrEqual(4096)
    expect(out.raw?.preview?.length).toBeGreaterThan(0)
    // the body is still not returned
    expect(out.content).toBeUndefined()
  })

  it('maxContentSize nextOffset: content full is bounded by maxContentSize and carries nextOffset while the document continues', async () => {
    const out = await c.world().svc.search({ ...c.base, content: 'full', maxContentSize: 2000 })
    expect(Buffer.byteLength(out.content ?? '')).toBeLessThanOrEqual(2000)
    expect(out.content?.length).toBeGreaterThan(0)
    expect(out.nextOffset).toBeGreaterThan(0)
    expect(out.content).toBe(c.full.slice(0, out.content?.length))
  })

  it('maxContentSize: with no maxContentSize the window is DEFAULT_MAX_CONTENT_SIZE (20000 bytes)', async () => {
    expect(DEFAULT_MAX_CONTENT_SIZE).toBe(20_000)
    const out = await c.world().svc.search({ ...c.base, content: 'full' })
    expect(Buffer.byteLength(out.content ?? '')).toBeLessThanOrEqual(DEFAULT_MAX_CONTENT_SIZE)
    expect(Buffer.byteLength(out.content ?? '')).toBeGreaterThan(DEFAULT_MAX_CONTENT_SIZE - 8)
    expect(out.nextOffset).toBeDefined()
  })

  it('nextOffset: following nextOffset through offset reassembles the document, and the last window has no nextOffset', async () => {
    let text = ''
    let offset: number | undefined
    let pages = 0
    do {
      const out: SearchOutput = await c.world().svc.search({ ...c.base, content: 'full', maxContentSize: 60_000, ...(offset !== undefined ? { offset } : {}) })
      text += out.content ?? ''
      offset = out.nextOffset
      pages++
    } while (offset !== undefined && pages < 20)
    expect(offset).toBeUndefined()
    expect(pages).toBeGreaterThan(5)
    expect(Buffer.from(text).equals(Buffer.from(c.full))).toBe(true)
  })
})
