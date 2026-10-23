/**
 * guards: an end-to-end fetch returns the wrong page, skips the SSRF policy, or breaks markdown or PDF extraction
 * tier: S
 * cites: ticket 8468f7b1 [search-usecases.1] [search-usecases.3] [search-usecases.5] [search-usecases.6]
 * Use case: an agent fetches a URL through the stealth browser. The real fetch policy, page
 * pipeline, markdown conversion and pdfjs extraction run over a scripted CDP page session (the
 * only fake) and fixture PDFs read in-process. No process, no socket, no Chrome.
 * Ported from the agent-search end-to-end fetch scenarios (I-28, I-29, I-30).
 * Ticket 8468f7b1 · [search-usecases.1] [search-usecases.3] [search-usecases.5] [search-usecases.6]
 */
import { describe, expect, it } from 'vitest'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import { htmlToMarkdown, TRUNCATION_MARKER, TURNDOWN_INPUT_CAP } from '../../../src/lib/fetch/markdown.js'
import { longBody, makeWorld, page, PDF_SENTENCE, PROVIDER, readFixture } from '../../helpers/fetch/harness.js'

const REFUSED: Array<[string, string]> = [
  ['cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
  ['IPv4-mapped IPv6 metadata address', 'http://[::ffff:169.254.169.254]/latest/meta-data'],
  ['trailing-dot localhost', 'https://localhost./admin'],
  ['embedded credentials user:pass@', 'https://user:pass@example.com/'],
  ['file: scheme', 'file:///etc/passwd'],
  ['loopback with the debugging port path', 'http://127.0.0.1/json'],
  ['private RFC1918 range', 'https://192.168.1.1/router'],
  ['single-label intranet host', 'https://intranet/'],
]

describe('the SSRF refusal matrix returns outcome error and never contacts the browser', () => {
  it.each(REFUSED)('%s is refused with FETCH_URL_REFUSED and no page is opened', async (_name, url) => {
    const w = makeWorld({})

    const r = await fetchPage(PROVIDER, url, {}, w.deps)

    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/^FETCH_URL_REFUSED:/)
    expect(w.opened).toBe(0)
    expect(w.calls).toEqual([])
  })

  it('a public https URL passes the policy and the page is fetched', async () => {
    const w = makeWorld({ html: [page('Docs', longBody())] })
    const r = await fetchPage(PROVIDER, 'https://example.com/docs', { content: 'full' }, w.deps)
    expect(r.outcome).toBe('success')
    expect(w.opened).toBe(1)
  })
})

describe('a PDF response takes the PDF branch', () => {
  it('the document body is intercepted, parsed by pdfjs and returned as text', async () => {
    const pdf = new Uint8Array(readFixture('two-page.pdf'))
    const url = 'https://arxiv.example.org/pdf/1234.pdf'
    const w = makeWorld({ html: ['<html></html>'], pdf, responses: [{ url, status: 200, mimeType: 'application/pdf' }] })

    const r = await fetchPage(PROVIDER, url, { content: 'full' }, w.deps)

    expect(r.outcome).toBe('success')
    expect(r.contentType).toBe('application/pdf')
    expect(r.content).toContain(PDF_SENTENCE)
    expect(w.calls).toEqual(expect.arrayContaining(['Fetch.enable', 'Fetch.getResponseBody', 'Fetch.disable']))
  })

  it('a corrupt pdf is a typed outcome, not a crash', async () => {
    const bad = new Uint8Array(readFixture('corrupt.pdf'))
    const url = 'https://arxiv.example.org/pdf/bad.pdf'
    const w = makeWorld({ html: ['<html></html>'], pdf: bad, responses: [{ url, status: 200, mimeType: 'application/pdf' }] })

    const r = await fetchPage(PROVIDER, url, {}, w.deps)

    expect(r.outcome).toBe('error')
  })
})

describe('markdown output is capped with a truncation marker', () => {
  it('an HTML document over the 1 MiB cap is cut at the cap and ends with the truncation marker', async () => {
    const html = `<p>${'0123456789abcdef '.repeat(Math.ceil((1.5 * 1024 * 1024) / 17))}</p>`

    const r = await htmlToMarkdown(html)

    expect(r.truncated).toBe(true)
    expect(r.markdown.endsWith(TRUNCATION_MARKER)).toBe(true)
    const atCap = await htmlToMarkdown(html.slice(0, TURNDOWN_INPUT_CAP))
    expect(r.markdown.length).toBe(atCap.markdown.length + TRUNCATION_MARKER.length)
  })

  it('a large page returned to the agent is windowed to 20000 bytes with a nextOffset to continue', async () => {
    const w = makeWorld({ html: [page('Big', longBody(60_000))] })

    const r = await fetchPage(PROVIDER, 'https://example.com/big', { content: 'full' }, w.deps)

    expect(r.outcome).toBe('success')
    expect(Buffer.byteLength(r.content ?? '')).toBeLessThanOrEqual(20_000)
    expect(r.truncated).toBe(true)
    expect(r.nextOffset).toBeGreaterThan(0)
  })
})
