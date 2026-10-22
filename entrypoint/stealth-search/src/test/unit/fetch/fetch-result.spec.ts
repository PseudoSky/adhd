/**
 * Token-efficient fetch result (backlog cd05ad09): metadata by default, windowed markdown on request.
 * Ticket 8468f7b1 · [search-port-fetch.9]
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_CONTENT_SIZE, fetchPage, sliceWindow } from '../../../lib/fetch/fetch.js'
import { htmlToMarkdown } from '../../../lib/fetch/markdown.js'
import { makeWorld, page, PROVIDER } from './harness.js'

const README_BYTES = 408112
const URL_ = 'https://github.com/example/big-repo'

/** A repository README page whose markdown is exactly 408112 bytes (synthetic-protocol-conformant). */
async function readmeHtml(): Promise<string> {
  let body = '<h1>big-repo</h1>'
  for (let i = 0; i < 3000; i++) body += `<h2>Section ${i}</h2><p>Install step ${i}: run <code>pnpm add big-repo</code> then read the <a href="https://example.com/${i}">guide ${i}</a>. Café ✓</p>`
  const probe = async (k: number): Promise<number> => Buffer.byteLength((await htmlToMarkdown(page('big-repo', `${body}<p>${'z'.repeat(k)}</p>`))).markdown)
  const small = await probe(1)
  const k = 1 + README_BYTES - small
  expect(k).toBeGreaterThan(0)
  const html = page('big-repo', `${body}<p>${'z'.repeat(k)}</p>`)
  expect(Buffer.byteLength((await htmlToMarkdown(html)).markdown)).toBe(README_BYTES)
  return html
}

describe('cd05ad09: default fetch of a 408112-byte README is metadata only (under 2048 bytes)', () => {
  it('serializes under 2048 bytes with exactly the metadata fields and contentSize 408112', async () => {
    const w = makeWorld({ html: [await readmeHtml()] })
    const r = await fetchPage(PROVIDER, URL_, {}, w.deps)
    expect(r.outcome).toBe('success')
    expect(r.contentSize).toBe(README_BYTES)
    expect(JSON.stringify(r).length).toBeLessThan(2048)
    expect(Object.keys(r).sort()).toEqual(
      ['attempts', 'contentSize', 'contentType', 'finalUrl', 'outcome', 'provider', 'status', 'title', 'tookMs', 'truncated', 'url'].sort(),
    )
    expect(r).not.toHaveProperty('content')
    expect(JSON.stringify(r)).not.toContain('<html')
    expect(JSON.stringify(r)).not.toContain('preview')
  })
})

describe('cd05ad09: content full is bounded by maxContentSize 20000 and pages with offset and nextOffset', () => {
  it('returns at most 20000 bytes plus nextOffset, and following nextOffset reaches the end', async () => {
    expect(DEFAULT_MAX_CONTENT_SIZE).toBe(20000)
    const html = await readmeHtml()
    const converted = await htmlToMarkdown(html)
    const whole = converted.markdown
    let offset: number | undefined = 0
    let got = ''
    let pages = 0
    let last: Awaited<ReturnType<typeof fetchPage>> | undefined
    while (offset !== undefined) {
      const w = makeWorld({ html: [html] }, { toMarkdown: async () => converted })
      last = await fetchPage(PROVIDER, URL_, { content: 'full', offset }, w.deps)
      expect(Buffer.byteLength(last.content ?? '')).toBeLessThanOrEqual(20000)
      expect(last.contentSize).toBe(README_BYTES)
      if (last.nextOffset !== undefined) {
        expect(last.truncated).toBe(true)
        expect(last.nextOffset).toBeGreaterThan(offset)
      }
      got += last.content ?? ''
      offset = last.nextOffset
      pages++
    }
    expect(pages).toBe(Math.ceil(README_BYTES / 20000))
    expect(last).not.toHaveProperty('nextOffset')
    expect(got).toBe(whole)
  })

  it('a custom maxContentSize and offset window the document; finalUrl is reported', async () => {
    const w = makeWorld({ html: [page('T', '<p>abcdefghij</p>')], responses: [{ url: 'https://example.com/final', status: 200, mimeType: 'text/html' }] })
    const r = await fetchPage(PROVIDER, 'https://example.com/start', { content: 'full', maxContentSize: 4, offset: 2 }, w.deps)
    expect(r.finalUrl).toBe('https://example.com/final')
    expect(r.url).toBe('https://example.com/start')
    const whole = (await htmlToMarkdown(page('T', '<p>abcdefghij</p>'))).markdown
    expect(r.content).toBe(whole.slice(2, 6))
    expect(r.nextOffset).toBe(6)
  })
})

describe('sliceWindow never splits a multi-byte character', () => {
  it('pages a non-ASCII text back to the original', () => {
    const text = 'é✓\u{1F600}abc'.repeat(50)
    let off: number | undefined = 0
    let out = ''
    while (off !== undefined) {
      const w: { content: string; nextOffset?: number } = sliceWindow(text, off, 5)
      expect(w.content).not.toContain('�')
      out += w.content
      off = w.nextOffset
    }
    expect(out).toBe(text)
  })

  it('an offset past the end yields an empty window and a window narrower than a character still advances', () => {
    expect(sliceWindow('abc', 99, 10)).toEqual({ content: '' })
    expect(sliceWindow('\u{1F600}x', 0, 1).nextOffset).toBe(4)
  })
})
