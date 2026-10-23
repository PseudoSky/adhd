/**
 * guards: the cookieless render, PDF branch or two-phase Cloudflare wait is skipped or mis-ordered
 * tier: S
 * cites: ticket 8468f7b1 [search-port-fetch.2] [search-port-fetch.4]
 * The cookieless render, PDF branch and two-phase Cloudflare wait (inventory I-27).
 * Ticket 8468f7b1 · [search-port-fetch.2] [search-port-fetch.4]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage, FETCH_UA, pdfLooksComplete } from '../../../src/lib/fetch/fetch.js'
import { CF_BAN, longBody, makeWorld, page, PDF_SENTENCE, PROVIDER, readFixture } from '../../helpers/fetch/harness.js'

const URL_ = 'https://docs.example.com/guide'

describe('cookieless render to markdown', () => {
  it('opens an isolated page, serializes the DOM, converts and disposes the page', async () => {
    const w = makeWorld({ html: [page('Guide', `<h1>Guide</h1>${longBody()}`)] })
    const r = await fetchPage(PROVIDER, URL_, { content: 'full' }, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.title).toBe('Guide')
    expect(r.content).toContain('# Guide')
    expect(r.status).toBe(200)
    expect(w.opened).toBe(1)
    expect(w.disposed).toBe(1)
    expect(w.closed).toBe(1)
    expect(w.calls).toEqual(expect.arrayContaining(['DOM.getDocument', 'DOM.getOuterHTML']))
    expect(w.calls).not.toContain('Runtime.evaluate')
  })

  it('keepPage leaves the isolated page open', async () => {
    const w = makeWorld({ html: [page('Guide', longBody())] })
    await fetchPage(PROVIDER, URL_, { keepPage: true }, w.deps)
    expect(w.disposed).toBe(0)
  })

  it('an unsettled page is reported as a warning, not hidden', async () => {
    const w = makeWorld({ html: [page('Guide', longBody())], settled: false })
    const r = await fetchPage(PROVIDER, URL_, {}, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.warning).toContain('never demonstrably settled')
  })

  it('an empty document is outcome empty', async () => {
    const w = makeWorld({ html: ['<html><body></body></html>'] })
    expect((await fetchPage(PROVIDER, URL_, {}, w.deps)).outcome).toBe('empty')
  })

  it('a transport failure is a result outcome error, never a throw', async () => {
    const w = makeWorld({}, { openPage: async () => { throw new Error('chrome unreachable') } })
    const r = await fetchPage(PROVIDER, URL_, {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/^SEARCH_FAILED:.*chrome unreachable/)
  })
})

describe('sparse challenge page: two-phase Cloudflare wait', () => {
  const wall = page('Just a moment...', '<p>Just a moment</p>')
  const real = page('Docs', `<h1>Docs</h1>${longBody()}`)

  it('a sparse wall that auto-clears in phase 1 never reveals the window', async () => {
    const w = makeWorld({ html: [wall, real] })
    const r = await fetchPage({ id: 'fetch', bans: CF_BAN }, URL_, { challengeWaitMs: 25_000 }, w.deps)
    expect(r.outcome).toBe('success')
    expect(w.revealed).toBe(0)
    expect(w.grabs).toBe(2)
  })

  it('a wall that needs a human is revealed on-screen after phase 1, then clears', async () => {
    const w = makeWorld({ html: [wall, wall, wall, wall, wall, wall, wall, wall, real] })
    const r = await fetchPage(PROVIDER, URL_, { challengeWaitMs: 25_000 }, w.deps)
    expect(r.outcome).toBe('success')
    expect(w.revealed).toBe(1)
    expect(w.calls).toContain('Page.bringToFront')
    expect(w.logs.join('')).toContain('needs you')
  })

  it('a wall that never clears returns captcha after the wait', async () => {
    const w = makeWorld({ html: [wall] })
    const r = await fetchPage(PROVIDER, URL_, { challengeWaitMs: 10_000 }, w.deps)
    expect(r.outcome).toBe('captcha')
    expect(r.error).toContain('did not clear')
    expect(w.revealed).toBe(1)
  })

  it('challengeWaitMs 0 returns the ban immediately without polling', async () => {
    const w = makeWorld({ html: [wall] })
    const r = await fetchPage(PROVIDER, URL_, { challengeWaitMs: 0 }, w.deps)
    expect(r.outcome).toBe('captcha')
    expect(w.grabs).toBe(1)
  })

  it('a long page that merely mentions the ban phrase is not a challenge (3000-character heuristic)', async () => {
    const w = makeWorld({ html: [page('Docs', `<p>Just a moment</p>${longBody(4000)}`)] })
    expect((await fetchPage(PROVIDER, URL_, {}, w.deps)).outcome).toBe('success')
  })
})

describe('PDF branch', () => {
  const pdf = new Uint8Array(readFixture('two-page.pdf'))
  const pdfUrl = 'https://arxiv.example.org/pdf/1234.pdf'

  it('FETCH_UA is a browser-like user agent', () => {
    expect(FETCH_UA).toMatch(/^Mozilla\/5\.0 .*Chrome\//)
  })

  it('pdfLooksComplete rejects a truncated plugin-streamed body', () => {
    expect(pdfLooksComplete(pdf)).toBe(true)
    expect(pdfLooksComplete(pdf.subarray(0, 536))).toBe(false)
  })

  it('extracts text from the browser network response (Fetch interception)', async () => {
    const w = makeWorld({ html: ['<html></html>'], pdf, responses: [{ url: pdfUrl, status: 200, mimeType: 'application/pdf' }] })
    const r = await fetchPage(PROVIDER, pdfUrl, { content: 'full' }, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.contentType).toBe('application/pdf')
    expect(r.content).toContain(PDF_SENTENCE)
    expect(w.calls).toEqual(expect.arrayContaining(['Fetch.enable', 'Fetch.getResponseBody', 'Fetch.disable']))
  })

  it('falls back to a direct fetch whose redirects are policy-checked', async () => {
    const calls: string[] = []
    const fetchImpl = (async (u: string) => {
      calls.push(String(u))
      return new Response(pdf, { status: 200 })
    }) as unknown as typeof fetch
    const w = makeWorld({ html: ['<html></html>'], responses: [{ url: pdfUrl, status: 200, mimeType: 'application/pdf' }] }, { fetchImpl })
    const r = await fetchPage(PROVIDER, pdfUrl, { content: 'full' }, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.content).toContain(PDF_SENTENCE)
    expect(calls).toEqual([pdfUrl])
  })

  it('a direct-fetch redirect to a private address is refused with FETCH_URL_REFUSED', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x.pdf' } })) as unknown as typeof fetch
    const w = makeWorld({ html: ['<html></html>'], responses: [{ url: pdfUrl, status: 200, mimeType: 'application/pdf' }] }, { fetchImpl })
    const r = await fetchPage(PROVIDER, pdfUrl, {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/^FETCH_URL_REFUSED:/)
  })

  it('a corrupt PDF is outcome error carrying PDF_EXTRACT_FAILED', async () => {
    const bad = new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1100, 0x41), Buffer.from('\n%%EOF\n')]))
    const w = makeWorld({ html: ['<html></html>'], pdf: bad, responses: [{ url: pdfUrl, status: 200, mimeType: 'application/pdf' }] })
    const r = await fetchPage(PROVIDER, pdfUrl, {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/^PDF_EXTRACT_FAILED:/)
  })
})
