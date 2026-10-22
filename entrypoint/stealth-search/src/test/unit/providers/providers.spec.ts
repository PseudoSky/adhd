/**
 * The provider registry: the twelve real provider ids in order, each with its extractor config and
 * qualifier examples, and getProvider on an unknown id through the real call.
 * Inventory rows I-22. Ticket 8468f7b1 · [search-port-providers.1] [search-port-providers.6].
 */
import { describe, expect, it } from 'vitest'
import { capture, StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import { StealthSearchError, exitCodeFor } from '../../../errors.js'
import { PROVIDERS, PROVIDER_NAMES, getProvider, isProviderName } from '../../../lib/providers.js'

const TWELVE = ['duckduckgo', 'google', 'arxiv', 'npm', 'github', 'maven', 'wikipedia', 'crates', 'pypi', 'mdn', 'stackoverflow', 'fetch']

describe('twelve providers [search-port-providers.1]', () => {
  it('twelve providers: the ordered id list equals duckduckgo google arxiv npm github maven wikipedia crates pypi mdn stackoverflow fetch', () => {
    expect(PROVIDER_NAMES).toEqual(TWELVE)
    expect(Object.keys(PROVIDERS)).toEqual(TWELVE)
  })

  it.each(TWELVE)('provider %s carries its own id, a name, a url builder, strategies, bans and retry', (id) => {
    const p = getProvider(id)
    expect(p.id).toBe(id)
    expect(p.name.length).toBeGreaterThan(0)
    expect(p.url(id === 'fetch' ? 'https://react.dev' : 'vite')).toMatch(/^https?:\/\//)
    expect(p.strategies.primary).toBeTruthy()
    expect(p.retry.maxAttempts).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(p.bans)).toBe(true)
  })

  it.each(TWELVE.filter((id) => id !== 'fetch'))('provider %s has a network or dom extractor config matching its primary strategy', (id) => {
    const p = getProvider(id)
    const strategies = [p.strategies.primary, p.strategies.fallback]
    if (strategies.includes('network')) expect(p.network?.resultSelector).toBeTruthy()
    if (strategies.includes('dom')) expect(p.dom?.waitFor).toBeTruthy()
  })

  it('qualifier examples: the providers with inline qualifiers list them, the free-text ones list none', () => {
    for (const id of ['duckduckgo', 'google', 'arxiv', 'npm', 'github', 'maven', 'mdn', 'stackoverflow']) {
      expect(getProvider(id).qualifierExamples.length, id).toBeGreaterThan(0)
    }
    expect(getProvider('github').qualifierExamples[0]).toMatch(/^type:code/)
    expect(getProvider('arxiv').qualifierExamples).toContain('au:smith            Author search')
    for (const id of ['wikipedia', 'crates', 'pypi', 'fetch']) expect(getProvider(id).qualifierExamples).toEqual([])
  })

  it('urls: duckduckgo and google encode the query; fetch treats the query as the URL', () => {
    expect(getProvider('duckduckgo').url('a b')).toBe('https://html.duckduckgo.com/html?q=a%20b')
    expect(getProvider('google').url('a&b')).toBe('https://www.google.com/search?q=a%26b&hl=en')
    expect(getProvider('fetch').url('https://react.dev')).toBe('https://react.dev')
  })

  it('direct-fetch JSON providers (npm maven wikipedia crates github) use the public API without a browser', () => {
    for (const id of ['npm', 'maven', 'wikipedia', 'crates', 'github']) {
      const n = getProvider(id).network
      expect(n?.directFetch, id).toBe(true)
      expect(n?.parser, id).toBe('json')
    }
  })

  it('mdn and stackoverflow run the structural Google DOM walk first and the network capture second', () => {
    for (const id of ['mdn', 'stackoverflow']) {
      const p = getProvider(id)
      expect(p.strategies).toEqual({ primary: 'dom', fallback: 'network' })
      expect(p.dom?.structural).toBe(true)
    }
    expect(getProvider('mdn').url('flex')).toContain('site%3Adeveloper.mozilla.org')
    expect(getProvider('stackoverflow').url('flex')).toContain('site%3Astackoverflow.com')
  })

  it('ban rules fire on real hostile responses: ddg challenge url, google /sorry/, arxiv 503, npm 429', () => {
    expect(capture.checkBans(getProvider('duckduckgo').bans, { url: 'https://html.duckduckgo.com/challenge', status: 200, body: '' })).toBe('captcha')
    expect(capture.checkBans(getProvider('google').bans, { url: 'https://www.google.com/sorry/index', status: 429, body: '' })).toBe('captcha')
    expect(capture.checkBans(getProvider('arxiv').bans, { url: 'https://arxiv.org/search/', status: 503, body: '' })).toBe('rate_limited')
    expect(capture.checkBans(getProvider('npm').bans, { url: 'https://registry.npmjs.org/-/v1/search', status: 429, body: '' })).toBe('rate_limited')
    expect(capture.checkBans(getProvider('npm').bans, { url: 'https://registry.npmjs.org/-/v1/search', status: 200, body: '{}' })).toBeNull()
  })
})

describe('getProvider on an unknown id [search-port-providers.1]', () => {
  it('UNKNOWN_PROVIDER: the real call throws a StealthSearchError carrying the code, the available ids and exit 70', () => {
    let caught: unknown
    try {
      getProvider('bing')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(StealthSearchError)
    expect(caught).toBeInstanceOf(StealthCoreBrowserError)
    const err = caught as StealthSearchError
    expect(err.code).toBe('UNKNOWN_PROVIDER')
    expect(err.message).toContain('Unknown provider "bing"')
    expect(err.message).toContain(TWELVE.join(', '))
    expect(exitCodeFor(err.code)).toBe(70)
  })

  it('UNKNOWN_PROVIDER: inherited object keys are not providers', () => {
    expect(isProviderName('toString')).toBe(false)
    expect(() => getProvider('constructor')).toThrowError(StealthSearchError)
  })
})
