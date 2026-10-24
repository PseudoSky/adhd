/**
 * guards: the DOM strategy misextracts SERP results, skips a ban check, or retries the selector wait without the 600-1800 ms jitter and SELECTOR_TIMEOUT
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.2] [search-port-engine.10]
 * The DOM strategy over a fake page session built from HTML fixtures: pattern extraction, the structural Google
 * result-page (SERP) walker, ban checks (selector probes, serialized-DOM rules, redirect URL rules) and the selector
 * wait with jittered 600-1800 ms retries raising SELECTOR_TIMEOUT. Fixtures labelled synthetic-protocol-conformant.
 * Inventory rows [I-25] (dom extraction and selector wait), [I-25.a] (google serp walker extracts results).
 * Ticket 8468f7b1 · [search-port-engine.2] [search-port-engine.10] · backlog 406a4e66.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import {
  JITTER_MAX_MS,
  JITTER_MIN_MS,
  checkPageUrlForBan,
  detectBanInPage,
  domSearch,
  extractFromDom,
  extractGoogleSerp,
  jitterMs,
  waitForSelector,
} from '../../../src/lib/dom.js'
import { isSearchError, StealthSearchError } from '../../../src/errors.js'
import type { ProviderConfig } from '../../../src/lib/types.js'
import { FakePage, fixture, htmlToDomTree, makeClock, makeDeps } from '../../helpers/engine/harness.js'

const ddg = getProvider('duckduckgo')
const google = getProvider('google')
const pypi = getProvider('pypi')

const run = (provider: ProviderConfig, page: FakePage, timeoutMs = 30000, randoms: number[] = []) => {
  const clock = makeClock(randoms)
  return domSearch(page, provider, 'tree-sitter', timeoutMs, makeDeps({ clock })).then((response) => ({ response, clock }))
}

describe('dom extraction and selector wait [search-port-engine.2]', () => {
  it('result page: a DuckDuckGo page yields three results with decoded urls, titles and snippets, via DOM commands only', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html') })
    const { response: r } = await run(ddg, page)
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('dom')
    expect(r.count).toBe(3)
    expect(r.results[0]).toMatchObject({ title: 'Tree-sitter | Introduction', url: 'https://tree-sitter.github.io/', snippet: 'Tree-sitter is a parser generator tool and an incremental parsing library.' })
    expect(r.results[1]?.url).toBe('https://github.com/tree-sitter/tree-sitter')
    expect(r.results[2]?.url).toBe('https://en.wikipedia.org/wiki/Tree-sitter')
    expect(page.methods()).toContain('Page.navigate')
    expect(page.calls.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: ddg.url('tree-sitter') })
    expect(page.methods()).not.toContain('Runtime.evaluate')
    expect(page.methods().filter((m) => m === 'DOM.getDocument')).toHaveLength(2)
  })

  it('result page: title, snippet and the extra version pattern are read from the pypi cards', async () => {
    const page = new FakePage({ html: fixture('pypi-results.html') })
    const { response: r } = await run(pypi, page)
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(2)
    expect(r.results[0]).toMatchObject({ title: 'requests', snippet: 'Python HTTP for Humans.', meta: { version: '2.32.3' } })
    expect(r.results[1]).toMatchObject({ title: 'httpx', meta: { version: '0.27.0' } })
  })

  it('empty page: the results container renders with no organic results and the outcome is empty', async () => {
    const { response: r } = await run(google, new FakePage({ html: fixture('google-serp-empty.html') }))
    expect(r.outcome).toBe('empty')
    expect(r.count).toBe(0)
    expect(r.error).toBeUndefined()
  })

  it('banned page: a Cloudflare block page in the rendered DOM is a hitl interrupt with reason banned', async () => {
    const page = new FakePage({ html: fixture('ddg-banned.html') })
    const { response: r } = await run(ddg, page)
    expect(r.outcome).toBe('hitl')
    expect(r.hitl).toMatchObject({ reason: 'banned', strategy: 'dom', provider: 'duckduckgo', query: 'tree-sitter', pageUrl: ddg.url('tree-sitter') })
    expect(r.error).toContain('Challenge detected: banned')
    expect(r.count).toBe(0)
    expect(page.calls.filter((c) => c.method === 'DOM.getDocument' && c.params['depth'] === -1)).toHaveLength(0)
  })

  it('banned page: a CAPTCHA widget found by the selector probes is hitl captcha before any extraction', async () => {
    const page = new FakePage({ html: fixture('ddg-captcha.html') })
    const { response: r } = await run(ddg, page)
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('captcha')
    expect(page.calls.filter((c) => c.method === 'DOM.getDocument' && c.params['depth'] === -1)).toHaveLength(0)
  })

  it('banned page: a redirect to a challenge url is hitl captcha before the selector wait begins', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html'), url: 'https://duckduckgo.com/challenge?x=1' })
    const { response: r } = await run(ddg, page)
    expect(r.outcome).toBe('hitl')
    expect(r.hitl?.reason).toBe('captcha')
    expect(page.queries('.result')).toBe(0)
  })

  it('selector wait: a selector that appears after two misses is found after two jittered retries', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html'), appearsAfter: { '.result': 2 } })
    const { response: r, clock } = await run(ddg, page, 30000, [0, 0, 1])
    expect(r.outcome).toBe('success')
    expect(page.queries('.result')).toBe(3)
    // one render pause, then one retry pause per miss: all drawn from the 600-1800 ms range
    expect(clock.sleeps).toEqual([600, 600, 1800])
  })

  it('selector timeout: a selector that never appears is outcome timeout carrying SELECTOR_TIMEOUT', async () => {
    const page = new FakePage({ html: fixture('ddg-empty.html') })
    const { response: r, clock } = await run(ddg, page, 10000)
    expect(r.outcome).toBe('timeout')
    expect(r.error).toContain('SELECTOR_TIMEOUT')
    expect(r.error).toContain('Timed out waiting for ".result"')
    expect(clock.sleeps.length).toBeGreaterThan(2)
    expect(page.queries('.result')).toBeGreaterThan(1)
  })

  it('no dom config: a provider without a dom section is an error outcome, not a throw', async () => {
    const { dom: _removed, ...noDom } = ddg
    void _removed
    const page = new FakePage({ html: fixture('ddg-results.html') })
    const { response: r } = await run(noDom as ProviderConfig, page)
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('No DOM config for provider')
    expect(page.methods()).toEqual([])
  })

  it('page failure: a CDP command rejecting mid-search is an error outcome naming the cause', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html'), reject: { 'Page.navigate': 'Target closed' } })
    const { response: r } = await run(ddg, page)
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('Target closed')
  })
})

describe('selector wait raises SELECTOR_TIMEOUT with jittered 600-1800 ms retries [search-port-engine.2]', () => {
  it('SELECTOR_TIMEOUT: waitForSelector rejects with a StealthSearchError carrying the selector, timeout and last error', async () => {
    const page = new FakePage({ html: fixture('ddg-empty.html'), never: ['.result'] })
    const clock = makeClock()
    const err = await waitForSelector(page, 1, '.result', 5000, clock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StealthSearchError)
    expect(isSearchError(err, 'SELECTOR_TIMEOUT')).toBe(true)
    expect((err as StealthSearchError).detail).toMatchObject({ selector: '.result', timeoutMs: 5000 })
    expect((err as StealthSearchError).message).toContain('Timed out waiting for ".result" (5000ms)')
  })

  it('jitter: every retry pause lies in 600-1800 ms and the bounds are the exported constants', async () => {
    expect(JITTER_MIN_MS).toBe(600)
    expect(JITTER_MAX_MS).toBe(1800)
    expect(jitterMs(() => 0)).toBe(600)
    expect(jitterMs(() => 0.999999)).toBe(1800)
    const page = new FakePage({ html: '<html></html>', never: ['.result'] })
    const clock = makeClock([0.1, 0.9, 0.35, 0.6, 0.77])
    await waitForSelector(page, 1, '.result', 30000, clock).catch(() => undefined)
    expect(clock.sleeps.length).toBeGreaterThan(5)
    for (const ms of clock.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(600)
      expect(ms).toBeLessThanOrEqual(1800)
    }
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1)
  })

  it('SELECTOR_TIMEOUT: a CDP error while polling is retried and its message is the last error in the failure', async () => {
    const page = new FakePage({ html: '<html></html>', reject: { 'DOM.querySelector': 'Cannot find context with specified id' } })
    const err = await waitForSelector(page, 1, '#search', 3000, makeClock()).catch((e: unknown) => e)
    expect(isSearchError(err, 'SELECTOR_TIMEOUT')).toBe(true)
    expect((err as StealthSearchError).message).toContain('Last error: Cannot find context with specified id')
  })

  it('a selector found on the first poll returns without any pause', async () => {
    const clock = makeClock()
    await waitForSelector(new FakePage({ html: fixture('ddg-results.html') }), 1, '.result', 5000, clock)
    expect(clock.sleeps).toEqual([])
  })
})

describe('ban checks [search-port-engine.2]', () => {
  it('detectBanInPage: a clean results page is no ban, a provider body rule over the serialized DOM is its signal', async () => {
    expect(await detectBanInPage(new FakePage({ html: fixture('ddg-results.html') }), 1, ddg)).toBeNull()
    expect(await detectBanInPage(new FakePage({ html: fixture('cf-challenge.html') }), 1, ddg)).toBe('captcha')
    expect(await detectBanInPage(new FakePage({ html: fixture('ddg-banned.html') }), 1, ddg)).toBe('banned')
  })

  it('detectBanInPage: the url rules run against the current navigation url as well', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html'), url: 'https://www.google.com/sorry/index' })
    expect(await detectBanInPage(page, 1, google)).toBe('captcha')
  })

  it('detectBanInPage: a failing probe is treated as not found (best effort)', async () => {
    const page = new FakePage({ html: fixture('ddg-results.html'), reject: { 'DOM.querySelector': 'boom', 'DOM.getOuterHTML': 'boom' } })
    expect(await detectBanInPage(page, 1, ddg)).toBeNull()
  })

  it('checkPageUrlForBan: a login redirect matches the provider url rule signal; no history means no ban', async () => {
    const github = getProvider('github')
    expect(await checkPageUrlForBan(new FakePage({ html: '', url: 'https://github.com/login/?return_to=x' }), github, 'https://github.com/search')).toBe('login_required')
    expect(await checkPageUrlForBan(new FakePage({ html: '', url: 'https://github.com/search?q=x' }), github, 'https://github.com/search')).toBeNull()
    expect(await checkPageUrlForBan(new FakePage({ html: '', reject: { 'Page.getNavigationHistory': 'x' } }), github, 'u')).toBeNull()
  })
})

describe('pattern extractor [search-port-engine.2]', () => {
  it('extractFromDom: containers without a title and a url are dropped and a missing extra field is left out of meta', () => {
    const tree = htmlToDomTree('<div class="result"><a class="result__a" href="/x">First</a><a class="result__url" href="/x"></a></div><div class="result"></div>')
    const results = extractFromDom(tree, ddg.dom?.extract ?? {})
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ title: 'First', url: '/x', snippet: '' })
    expect(results[0]?.meta).toBeUndefined()
  })

  it('extractFromDom: an extractor without container, title, link and snippet yields no results instead of throwing', () => {
    expect(extractFromDom(htmlToDomTree('<div class="result"></div>'), {})).toEqual([])
  })
})

describe('Google SERP walker lives in dom.ts [search-port-engine.10]', () => {
  it('google serp walker extracts results: titles, urls and snippets by structure, not class names (backlog 406a4e66)', async () => {
    const page = new FakePage({ html: fixture('google-serp.html') })
    const { response: r } = await run(google, page)
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('dom')
    expect(r.results.map((x) => x.url)).toEqual(['https://github.com/pinojs/pino', 'https://betterstack.com/community/guides/logging/nodejs-logging-best-practices/'])
    expect(r.results[0]?.title).toBe('pino - super fast, all natural JSON logger for Node.js')
    expect(r.results[0]?.snippet).toContain('pino is a very low overhead Node.js logger')
    expect(r.results[1]?.title).toBe('11 Node.js logging best practices')
    expect(r.results[1]?.snippet).toContain('structured logging in Node.js')
  })

  it('Google SERP walker: the same markup with every class name renamed still parses (class-independent)', async () => {
    const renamed = fixture('google-serp.html').replace(/class="[^"]*"/g, 'class="zz"')
    const results = await extractGoogleSerp(htmlToDomTree(renamed))
    expect(results.map((x) => x.title)).toEqual(['pino - super fast, all natural JSON logger for Node.js', '11 Node.js logging best practices'])
  })

  it('Google SERP walker: duplicate urls are dropped and a video-timestamp link (a wrapper with two children) is not a result', async () => {
    const results = await extractGoogleSerp(htmlToDomTree(fixture('google-serp.html')))
    expect(results).toHaveLength(2)
    expect(results.some((x) => x.url.includes('youtube.com'))).toBe(false)
  })

  it('Google SERP walker: an anchor without a heading and an anchor with no text are skipped (no guessed title)', async () => {
    const html =
      '<div id="rso"><div><div><a jsname="a" href="https://a.test/x"><div><div><span>A short title</span><span>•</span><span>a.test › deep › breadcrumb › path › here</span></div></div></div></a><span>x</span><p>y</p></div></div>' +
      '<div><a jsname="b" href="https://b.test/empty"><div><div></div></div></a></div></div>'
    expect(await extractGoogleSerp(htmlToDomTree(html))).toEqual([])
  })

  it('Google SERP walker: a redirect href is normalized (goto, protocol-relative, q= redirects)', async () => {
    const card = (href: string, title: string): string => `<div><a jsname="k" href="${href}"><div><div><h3>${title}</h3></div></div></a></div>`
    const results = await extractGoogleSerp(htmlToDomTree(`<body>${card('/goto?url=abc', 'One')}${card('//example.com/p', 'Two')}${card('/url?q=https%3A%2F%2Fthree.test%2F&sa=U', 'Three')}</body>`))
    expect(results.map((x) => x.url)).toEqual(['https://www.google.com/goto?url=abc', 'https://example.com/p', 'https://three.test/'])
  })

  it('Google SERP walker: the structural dom config of the mdn and stackoverflow providers uses the same walker', async () => {
    for (const id of ['mdn', 'stackoverflow']) {
      const { response: r } = await run(getProvider(id), new FakePage({ html: fixture('google-serp.html') }))
      expect(r.outcome).toBe('success')
      expect(r.count).toBe(2)
    }
  })

  it('Google SERP walker is delegated: dom.ts calls the core walkDomTree and carries no walker of its own', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'lib', 'dom.ts'), 'utf8')
    expect(source).toMatch(/capture\.walkDomTree/)
    expect(source).toMatch(/export async function extractGoogleSerp/)
    expect(source).not.toMatch(/function hasDivDiv/)
  })
})
