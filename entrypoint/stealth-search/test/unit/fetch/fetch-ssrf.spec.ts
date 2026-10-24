/**
 * guards: a name that resolves public at the check and private at the connection reaches loopback or metadata, a browser redirect hop to a private address is followed and its content returned, or the direct PDF fetch is unbounded
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1] [fix-search-fetch.1]
 * Pre-review P4 (resolve once and connect to the validated address), P8 (every redirect hop and the connected
 * address pass the policy before content is read) and P29 (the direct PDF fetch is bounded in bytes and time).
 * The resolver, the CDP page and the direct fetch are injected fakes: no socket, no process, no Chrome.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import type { FetchDeps } from '../../../src/lib/fetch/fetch.js'
import { PDF_MAX_BYTES } from '../../../src/lib/fetch/pinned.js'
import { longBody, makeWorld, page, PROVIDER, readFixture } from '../../helpers/fetch/harness.js'

const URL_ = 'https://docs.example.test/guide'
const PUBLIC = '93.184.216.34'
const PDF = new Uint8Array(readFixture('two-page.pdf'))

/** A resolver whose answer for a host flips from public to `later` after the first call for that host. */
function flipping(later: string[]): { resolve: FetchDeps['resolveHost']; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolve: async (host) => {
      calls.push(host)
      return calls.filter((h) => h === host).length === 1 ? [PUBLIC] : later
    },
  }
}

describe('resolve once, connect to the validated address (P4) [audit-fixes.1]', () => {
  it('P4 direct fetch pinned: the resolver answer flips to loopback after the check, the fetch still connects to the validated address and resolves the host once', async () => {
    const r = flipping(['127.0.0.1'])
    const connected: string[] = []
    const w = makeWorld(
      { html: ['<html></html>'], responses: [{ url: URL_ + '.pdf', status: 200, mimeType: 'application/pdf' }] },
      {
        resolveHost: r.resolve,
        fetchDirect: async (_url, address) => {
          connected.push(address)
          return { status: 200, location: null, body: PDF }
        },
      },
    )
    const out = await fetchPage(PROVIDER, URL_ + '.pdf', { content: 'full' }, w.deps)
    expect(out.outcome).toBe('success')
    expect(connected).toEqual([PUBLIC])
    expect(r.calls).toEqual(['docs.example.test'])
  })

  it('P4 direct redirect hop pinned: the hop host is resolved once, validated and fetched at its own validated address', async () => {
    const hops: Array<[string, string]> = []
    const answers: Record<string, string> = { 'docs.example.test': PUBLIC, 'cdn.example.test': '151.101.1.1' }
    const w = makeWorld(
      { html: ['<html></html>'], responses: [{ url: URL_ + '.pdf', status: 200, mimeType: 'application/pdf' }] },
      {
        resolveHost: async (h) => [answers[h] ?? '10.0.0.1'],
        fetchDirect: async (url, address) => {
          hops.push([new URL(url).hostname, address])
          return hops.length === 1 ? { status: 302, location: 'https://cdn.example.test/a.pdf', body: new Uint8Array(0) } : { status: 200, location: null, body: PDF }
        },
      },
    )
    const out = await fetchPage(PROVIDER, URL_ + '.pdf', {}, w.deps)
    expect(out.outcome).toBe('success')
    expect(hops).toEqual([
      ['docs.example.test', PUBLIC],
      ['cdn.example.test', '151.101.1.1'],
    ])
  })

  it('P4 browser connected address: a name that passed the check but connected to loopback is refused and the page is never read', async () => {
    const r = flipping(['127.0.0.1'])
    const w = makeWorld({ html: [page('Guide', longBody())], responses: [{ url: URL_, status: 200, mimeType: 'text/html', remoteIPAddress: '127.0.0.1' }] }, { resolveHost: r.resolve })
    const out = await fetchPage(PROVIDER, URL_, { content: 'full' }, w.deps)
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^FETCH_URL_REFUSED: .*connected to 127\.0\.0\.1/)
    expect(w.calls).not.toContain('DOM.getDocument')
    expect(out.content).toBeUndefined()
  })

  it('P4 browser connected address: a public connected address (bracketed IPv6 included) is accepted', async () => {
    const w = makeWorld({ html: [page('Guide', longBody())], responses: [{ url: URL_, status: 200, mimeType: 'text/html', remoteIPAddress: '[2606:4700::6810:84e5]' }] })
    const out = await fetchPage(PROVIDER, URL_, {}, w.deps)
    expect(out.outcome).toBe('success')
  })
})

describe('every redirect hop passes the policy before content is read (P8) [audit-fixes.1]', () => {
  const run = async (script: Partial<Parameters<typeof makeWorld>[0]>, extra: Partial<FetchDeps> = {}) => {
    const w = makeWorld({ html: [page('Guide', longBody())], ...script }, extra)
    const out = await fetchPage(PROVIDER, URL_, { content: 'full' }, w.deps)
    return { out, w }
  }

  it('P8 literal private hop: a redirect to the metadata address is refused and no DOM is read', async () => {
    const { out, w } = await run({
      requests: [{ url: URL_ }, { url: 'http://169.254.169.254/latest/meta-data/', redirectResponse: { url: URL_ } }],
      responses: [{ url: 'http://169.254.169.254/latest/meta-data/', status: 200, mimeType: 'text/html' }],
    })
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^FETCH_URL_REFUSED: .*169\.254\.169\.254/)
    expect(w.calls).not.toContain('DOM.getOuterHTML')
    expect(w.calls).toContain('Page.stopLoading')
    expect(out.content).toBeUndefined()
  })

  it('P8 hop that resolves private: a redirect to a public-looking name whose answer is private is refused', async () => {
    const { out } = await run(
      { requests: [{ url: URL_ }, { url: 'https://evil.example.test/x', redirectResponse: { url: URL_ } }], responses: [{ url: 'https://evil.example.test/x', status: 200, mimeType: 'text/html' }] },
      { resolveHost: async (h) => (h === 'evil.example.test' ? ['10.1.2.3'] : [PUBLIC]) },
    )
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^FETCH_URL_REFUSED: .*10\.1\.2\.3/)
  })

  it('P8 hop that connected private: the redirect response of an earlier hop that connected to loopback is refused', async () => {
    const { out } = await run({
      requests: [{ url: URL_ }, { url: 'https://other.example.test/', redirectResponse: { url: URL_, remoteIPAddress: '127.0.0.1' } }],
      responses: [{ url: 'https://other.example.test/', status: 200, mimeType: 'text/html', remoteIPAddress: PUBLIC }],
    })
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^FETCH_URL_REFUSED:/)
  })

  it('P8 final url: a document response from a forbidden connected address with no request event is refused', async () => {
    const { out } = await run({ responses: [{ url: 'https://elsewhere.example.test/', status: 200, mimeType: 'text/html', remoteIPAddress: '10.0.0.7' }] })
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^FETCH_URL_REFUSED:/)
  })

  it('P8 public hops: a redirect chain through public hosts is followed and the page is returned', async () => {
    const { out } = await run({
      requests: [{ url: URL_ }, { url: 'https://www.example.test/guide', redirectResponse: { url: URL_, remoteIPAddress: PUBLIC } }],
      responses: [{ url: 'https://www.example.test/guide', status: 200, mimeType: 'text/html', remoteIPAddress: PUBLIC }],
    })
    expect(out.outcome).toBe('success')
    expect(out.finalUrl).toBe('https://www.example.test/guide')
  })
})

describe('the direct PDF fetch is bounded (P29) [audit-fixes.1]', () => {
  it('P29 request bounds: the direct fetch is asked for a byte cap and a timeout', async () => {
    const seen: Array<{ maxBytes: number; timeoutMs: number }> = []
    const w = makeWorld(
      { html: ['<html></html>'], responses: [{ url: URL_ + '.pdf', status: 200, mimeType: 'application/pdf' }] },
      {
        fetchDirect: async (_u, _a, opts) => {
          seen.push({ maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs })
          return { status: 200, location: null, body: PDF }
        },
      },
    )
    await fetchPage(PROVIDER, URL_ + '.pdf', {}, w.deps)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.maxBytes).toBe(PDF_MAX_BYTES)
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('P29 oversized body: a body above the cap is a typed failure, not a PDF', async () => {
    const w = makeWorld(
      { html: ['<html></html>'], responses: [{ url: URL_ + '.pdf', status: 200, mimeType: 'application/pdf' }] },
      { fetchDirect: async () => ({ status: 200, location: null, body: new Uint8Array(PDF_MAX_BYTES + 1) }) },
    )
    const out = await fetchPage(PROVIDER, URL_ + '.pdf', {}, w.deps)
    expect(out.outcome).toBe('error')
    expect(out.error).toMatch(/^SEARCH_FAILED: .*larger than/)
  })
})
