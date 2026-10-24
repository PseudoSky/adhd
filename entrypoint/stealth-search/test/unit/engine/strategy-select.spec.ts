/**
 * guards: strategy index 0 runs the wrong view, or a dom strategy on a provider without dom config throws or touches a page
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.14]
 * The strategy pass is provider-shaped: strategy index 0 runs against the provider as given, a network strategy at
 * index above 0 runs against fallbackView(provider), and a dom strategy on a provider with no dom config (github)
 * returns outcome error without throwing, touching a page or entering a retry.
 * Inventory rows [I-11] (strategy select), [I-11.a] (dom strategy without config errors).
 * Ticket 8468f7b1 · [search-port-engine.14] · commit 591e1a7.
 */
import { describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { planStrategies, runStrategies } from '../../../src/lib/network.js'
import { fallbackView } from '../../../src/lib/utils.js'
import { body, fixture, FakePage, githubFixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const github = getProvider('github')
const page = { pageWsUrl: 'ws://page', reveal: async () => undefined }
const apiJson = JSON.stringify({ items: [{ full_name: 'vitejs/vite', html_url: 'https://github.com/vitejs/vite', description: 'tooling', stargazers_count: 1, language: 'TypeScript', forks_count: 2, updated_at: '2026-10-01' }] })

describe('591e1a7: strategy select by index [search-port-engine.14]', () => {
  it('strategy select: the plan follows primary then fallback, and a forced strategy is the only one', () => {
    expect(planStrategies(getProvider('duckduckgo'))).toEqual(['network', 'dom'])
    expect(planStrategies(getProvider('mdn'))).toEqual(['dom', 'network'])
    expect(planStrategies(getProvider('maven'))).toEqual(['network'])
    expect(planStrategies(github)).toEqual(['network', 'network'])
    expect(planStrategies(getProvider('fetch'))).toEqual([])
    expect(planStrategies(getProvider('duckduckgo'), 'dom')).toEqual(['dom'])
    expect(planStrategies(getProvider('duckduckgo'), 'network')).toEqual(['network'])
  })

  it('fallbackView: github index 0 hits the API (direct fetch, no capture) and the index 1 fallback hits the page url pattern', async () => {
    const fetched: string[] = []
    const rec = recordingCapture(async () => body(githubFixture('repo-search.html'), { url: 'https://github.com/search?q=vite&type=repositories' }))
    const r = await runStrategies(
      page,
      github,
      'vite',
      {},
      makeDeps({
        capture: rec.capture,
        fetchImpl: async (url) => {
          fetched.push(String(url))
          return new Response('Server Error', { status: 500 })
        },
      }),
    )
    // index 0: the provider as given -> the REST API, fetched directly
    expect(fetched).toEqual(['https://api.github.com/search/repositories?q=vite'])
    // index 1: fallbackView(github) -> the rendered page, captured through the core
    expect(rec.calls).toHaveLength(1)
    const pattern = rec.calls[0]?.options.urlPattern as RegExp
    expect(pattern.test('https://github.com/search?q=vite&type=repositories')).toBe(true)
    expect(pattern.test('https://api.github.com/search/repositories?q=vite')).toBe(false)
    expect(pattern.source).toBe(new RegExp(fallbackView(github).network?.urlPattern ?? '').source)
    expect(rec.calls[0]?.options.navigateUrl).toBe(github.url('vite'))
    expect(r.outcome).toBe('success')
    expect(r.count).toBe(2)
    expect(r.results[0]?.title).toBe('vitejs/vite')
  })

  it('index 0 success returns at once: the github API answer never runs the fallback', async () => {
    const rec = recordingCapture(async () => body(''))
    const r = await runStrategies(page, github, 'vite', {}, makeDeps({ capture: rec.capture, fetchImpl: async () => new Response(apiJson, { status: 200 }) }))
    expect(r.outcome).toBe('success')
    expect(rec.calls).toHaveLength(0)
  })

  it('index above 0 for a provider without fallbackNetwork runs against the provider itself (mdn: dom primary, network fallback)', async () => {
    const mdn = getProvider('mdn')
    const dom = new FakePage({ html: fixture('google-serp-empty.html') })
    const rec = recordingCapture(async () => body(fixture('google-serp.html'), { url: 'https://www.google.com/search?q=x' }))
    const r = await runStrategies(page, mdn, 'x', { timeoutMs: 20000 }, makeDeps({ capture: rec.capture, connect: async () => dom }))
    // dom at index 0 found a results container with no organic cards -> empty -> falls back to the network strategy at index 1
    expect(dom.methods()).toContain('DOM.getDocument')
    expect(dom.closed).toBe(1)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]?.options.urlPattern.source).toBe(new RegExp(fallbackView(mdn).network?.urlPattern ?? '').source)
    expect(r.strategy).toBe('network')
  })
})

describe('591e1a7: dom strategy without config errors [search-port-engine.14]', () => {
  it('dom strategy without config errors: github forced to dom returns outcome error naming "no DOM strategy config", never throws', async () => {
    const rec = recordingCapture(async () => body(''))
    let sessions = 0
    let fetches = 0
    const r = await runStrategies(
      page,
      github,
      'vite',
      { strategy: 'dom' },
      makeDeps({
        capture: rec.capture,
        connect: async () => {
          sessions++
          throw new TypeError('page must not be opened')
        },
        fetchImpl: async () => {
          fetches++
          return new Response('{}')
        },
      }),
    )
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('Provider "github" has no DOM strategy config')
    expect(r.strategy).toBe('dom')
    expect(r.attempts).toBe(1)
    expect(r.count).toBe(0)
    expect(rec.calls).toHaveLength(0)
    expect(sessions).toBe(0)
    expect(fetches).toBe(0)
  })

  it('github has no dom to fall back to: with the primary failing and the fallback failing the result is the last error, not a throw', async () => {
    const rec = recordingCapture(async () => {
      throw Object.assign(new Error('the CDP socket closed before any matching response was captured'), { code: 'CAPTURE_SESSION_CLOSED' })
    })
    const r = await runStrategies(page, github, 'vite', {}, makeDeps({ capture: rec.capture, fetchImpl: async () => new Response('', { status: 502 }) }))
    expect(github.dom).toBeUndefined()
    expect(r.outcome).toBe('error')
    expect(r.strategy).toBe('network')
    expect(r.error).toContain('socket closed')
    expect(rec.calls).toHaveLength(1)
  })

  it('a provider that has a dom config accepts a forced dom strategy: duckduckgo over a result page at index 0', async () => {
    const dom = new FakePage({ html: fixture('ddg-results.html') })
    const rec = recordingCapture(async () => body(''))
    const r = await runStrategies(page, getProvider('duckduckgo'), 'tree-sitter', { strategy: 'dom', timeoutMs: 8000 }, makeDeps({ capture: rec.capture, connect: async () => dom }))
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('dom')
    expect(r.count).toBe(3)
    expect(rec.calls).toHaveLength(0)
    expect(dom.closed).toBe(1)
  })

  it('no strategy to run (the fetch provider) is an error outcome, not a throw', async () => {
    const r = await runStrategies(page, getProvider('fetch'), 'https://example.com', {}, makeDeps())
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('No strategy to run')
  })
})
