/**
 * guards: the network strategy accepts a missing config silently, fetches JSON through a browser, or drops the core capture contract
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.1] [search-port-engine.4]
 * The network strategy: the missing-config error outcome, the direct JSON-API fetch (no browser), and the
 * capture path through the core's `capture.captureNetworkResponse` with the engine's `select` function.
 * Inventory rows [I-24] (network search and missing config error).
 * Ticket 8468f7b1 · [search-port-engine.1] [search-port-engine.4] · commits 591e1a7, c00edea.
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { DEFAULT_TIMEOUT_MS, networkSearch, selectCandidate } from '../../../src/lib/network.js'
import type { ProviderConfig } from '../../../src/lib/types.js'
import { body, fixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const ddg = getProvider('duckduckgo')
const npm = getProvider('npm')
const ddgPage = fixture('ddg-results.html')

const npmJson = JSON.stringify({
  objects: [
    { package: { name: 'ast-grep', version: '0.30.1', description: 'structural search and rewrite', links: { npm: 'https://www.npmjs.com/package/ast-grep' } }, publisher: { username: 'herrington' } },
    { package: { name: 'ast-types', version: '0.14.2', description: 'esprima-compatible AST', links: { npm: 'https://www.npmjs.com/package/ast-types' } }, publisher: { username: 'benjamn' } },
  ],
})

const jsonResponse = (text: string, status = 200): Response => new Response(text, { status, headers: { 'content-type': 'application/json' } })

describe('network search and missing config error [search-port-engine.4]', () => {
  it('No network config: a provider without a network section returns outcome error and touches nothing', async () => {
    const { network: _removed, ...noNetwork } = ddg
    void _removed
    const rec = recordingCapture(async () => body(ddgPage))
    const r = await networkSearch('ws://page', noNetwork as ProviderConfig, 'tree-sitter', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('No network config')
    expect(r.strategy).toBe('network')
    expect(r.count).toBe(0)
    expect(rec.calls).toHaveLength(0)
  })

  it('direct JSON fetch: a public JSON API is read with fetch, no page, no capture, no session', async () => {
    const fetched: Array<{ url: string; init?: RequestInit }> = []
    const rec = recordingCapture(async () => body(''))
    let sessions = 0
    const r = await networkSearch(
      '',
      npm,
      'ast-grep',
      {},
      makeDeps({
        capture: rec.capture,
        connect: async () => {
          sessions++
          throw new TypeError('no browser expected')
        },
        fetchImpl: async (url, init) => {
          fetched.push({ url: String(url), init })
          return jsonResponse(npmJson)
        },
      }),
    )
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('network')
    expect(r.count).toBe(2)
    expect(r.results[0]).toMatchObject({ title: 'ast-grep', url: 'https://www.npmjs.com/package/ast-grep', snippet: 'structural search and rewrite' })
    expect(r.results[0]?.meta).toMatchObject({ version: '0.30.1', publisher: 'herrington' })
    expect(r.raw?.status).toBe(200)
    expect(r.raw?.contentType).toBe('application/json')
    expect(fetched).toHaveLength(1)
    expect(fetched[0]?.url).toBe('https://registry.npmjs.org/-/v1/search?text=ast-grep&size=10')
    expect(new Headers(fetched[0]?.init?.headers).get('accept')).toBe('application/json')
    expect(rec.calls).toHaveLength(0)
    expect(sessions).toBe(0)
  })

  it('direct JSON fetch: the github API url prefix (apiUrl) is used instead of the page url', async () => {
    const github = getProvider('github')
    const urls: string[] = []
    const r = await networkSearch(
      '',
      github,
      'vite',
      {},
      makeDeps({
        fetchImpl: async (url) => {
          urls.push(String(url))
          return jsonResponse(JSON.stringify({ items: [{ full_name: 'vitejs/vite', html_url: 'https://github.com/vitejs/vite', description: 'Next generation frontend tooling', stargazers_count: 1, language: 'TypeScript', forks_count: 2, updated_at: '2026-10-01' }] }))
        },
      }),
    )
    expect(urls).toEqual(['https://api.github.com/search/repositories?q=vite'])
    expect(r.outcome).toBe('success')
    expect(r.results[0]?.title).toBe('vitejs/vite')
  })

  it('direct JSON fetch: an npm query outside 2 to 64 characters is an error outcome without any request', async () => {
    let calls = 0
    const deps = makeDeps({
      fetchImpl: async () => {
        calls++
        return jsonResponse(npmJson)
      },
    })
    const short = await networkSearch('', npm, 'a', {}, deps)
    const long = await networkSearch('', npm, 'x'.repeat(65), {}, deps)
    expect(short.outcome).toBe('error')
    expect(short.error).toContain('between 2 and 64')
    expect(long.outcome).toBe('error')
    expect(calls).toBe(0)
  })

  it('direct JSON fetch: HTTP 429 is rate_limited, a 500 is error, a body ban is captcha, a refused connection is error', async () => {
    const limited = await networkSearch('', npm, 'ast-grep', {}, makeDeps({ fetchImpl: async () => jsonResponse('{}', 429) }))
    expect(limited.outcome).toBe('rate_limited')
    expect(limited.error).toBe('Ban detected: rate_limited (HTTP 429)')

    const server = await networkSearch('', npm, 'ast-grep', {}, makeDeps({ fetchImpl: async () => jsonResponse('{}', 500) }))
    expect(server.outcome).toBe('error')
    expect(server.error).toBe('HTTP 500')

    const withBodyRule: ProviderConfig = { ...npm, bans: [{ name: 'body', signal: 'captcha', checkBody: /unusual traffic/ }] }
    const wall = await networkSearch('', withBodyRule, 'ast-grep', {}, makeDeps({ fetchImpl: async () => jsonResponse('unusual traffic detected') }))
    expect(wall.outcome).toBe('captcha')

    const refused = await networkSearch('', npm, 'ast-grep', {}, makeDeps({ fetchImpl: async () => Promise.reject(new TypeError('connect ECONNREFUSED')) }))
    expect(refused.outcome).toBe('error')
    expect(refused.error).toBe('Fetch failed: connect ECONNREFUSED')
  })

  it('direct JSON fetch: the request carries an abort signal and a fetch timeout is outcome timeout', async () => {
    let signal: AbortSignal | null | undefined
    const r = await networkSearch(
      '',
      npm,
      'ast-grep',
      { timeoutMs: 1234 },
      makeDeps({
        fetchImpl: async (_url, init) => {
          signal = init?.signal
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        },
      }),
    )
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(r.outcome).toBe('timeout')
    expect(r.error).toContain('Fetch failed')
  })

  it('direct JSON fetch: content full returns the body bounded by maxContentSize and contentSize reports the whole', async () => {
    const r = await networkSearch('', npm, 'ast-grep', { content: 'full', maxContentSize: 20 }, makeDeps({ fetchImpl: async () => jsonResponse(npmJson) }))
    expect(r.content).toBe(npmJson.slice(0, 20))
    expect(r.contentSize).toBe(npmJson.length)
    const none = await networkSearch('', npm, 'ast-grep', {}, makeDeps({ fetchImpl: async () => jsonResponse(npmJson) }))
    expect(none.content).toBeUndefined()
  })
})

describe('network capture goes through the core with a select function [search-port-engine.1]', () => {
  it('capture: the page is read through one capture call carrying urlPattern, navigateUrl, select and the default 30000 timeoutMs', async () => {
    const rec = recordingCapture(async () => body(ddgPage, { url: 'https://html.duckduckgo.com/html?q=tree-sitter' }))
    const r = await networkSearch('ws://page/1', ddg, 'tree-sitter', {}, makeDeps({ capture: rec.capture }))
    expect(rec.calls).toHaveLength(1)
    const { pageWsUrl, options } = rec.calls[0] ?? { pageWsUrl: '', options: undefined }
    expect(pageWsUrl).toBe('ws://page/1')
    expect(options?.urlPattern.test('https://html.duckduckgo.com/html?q=tree-sitter')).toBe(true)
    expect(options?.navigateUrl).toBe(ddg.url('tree-sitter'))
    expect(options?.select).toBe(selectCandidate)
    expect(options?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(options?.timeoutMs).toBe(30000)
    expect(options?.extraWaitMs).toBe(0)
    // Ban rules are checked by the engine on the returned response, never inside the core capture (it would throw and lose the body).
    expect(options?.banRules).toBeUndefined()
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(3)
    expect(r.results[0]).toMatchObject({ title: 'Tree-sitter | Introduction', url: 'https://tree-sitter.github.io/' })
    expect(r.raw?.sourceUrl).toBe('https://html.duckduckgo.com/html?q=tree-sitter')
    expect(r.raw?.preview.length).toBeLessThanOrEqual(4096)
  })

  it('capture: a Cloudflare managed-challenge body is a hitl interrupt with reason captcha and the page url', async () => {
    const rec = recordingCapture(async () => body(fixture('cf-challenge.html'), { url: 'https://html.duckduckgo.com/html?q=x' }))
    const r = await networkSearch('ws://page', ddg, 'x', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('hitl')
    expect(r.hitl).toMatchObject({ reason: 'captcha', pageUrl: 'https://html.duckduckgo.com/html?q=x', strategy: 'network', provider: 'duckduckgo', query: 'x' })
    expect(r.count).toBe(0)
  })

  it('capture: a Cloudflare block page is hitl with reason banned', async () => {
    const rec = recordingCapture(async () => body(fixture('ddg-banned.html')))
    const r = await networkSearch('ws://page', ddg, 'x', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('banned')
    expect(r.hitl?.pageUrl).toBe(ddg.url('x'))
  })

  it('capture: content full returns the captured body in content, bounded by maxContentSize', async () => {
    const rec = recordingCapture(async () => body(ddgPage))
    const r = await networkSearch('ws://page', ddg, 'x', { content: 'full', maxContentSize: 50 }, makeDeps({ capture: rec.capture }))
    expect(r.content).toBe(ddgPage.slice(0, 50))
    expect(r.contentSize).toBe(ddgPage.length)
  })

  it('capture: a parsed page with zero results is empty (a legitimate answer), distinct from a missing capture', async () => {
    const rec = recordingCapture(async () => body(fixture('ddg-empty.html')))
    const r = await networkSearch('ws://page', ddg, 'zzqxv', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('empty')
    expect(r.count).toBe(0)
    expect(r.error).toBeUndefined()
  })

  it('capture: a response recorded without a status (0) is read as 200 for the ban rules', async () => {
    const arxiv = getProvider('arxiv')
    const rec = recordingCapture(async () => body('<html><body>none</body></html>', { status: 0 }))
    const r = await networkSearch('ws://page', arxiv, 'x', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('empty')
    expect(r.raw?.status).toBe(200)
  })
})
