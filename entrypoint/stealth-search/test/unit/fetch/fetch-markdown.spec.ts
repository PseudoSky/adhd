/**
 * guards: HTML-to-markdown lets an oversized input through uncapped, drops the truncation marker, or fails without the degraded fallback
 * tier: S
 * cites: ticket 8468f7b1 [search-port-fetch.4]
 * HTML to markdown: the 1 MiB input cap, truncation marker and degraded fallback (inventory I-29).
 * Ticket 8468f7b1 · [search-port-fetch.4]
 */
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, TRUNCATION_MARKER, TURNDOWN_INPUT_CAP } from '../../../src/lib/fetch/markdown.js'

describe('input cap and truncation marker', () => {
  it('converts a small document with Turndown, removing script/style/noscript/iframe', async () => {
    const r = await htmlToMarkdown('<h1>Title</h1><p>Body</p><script>evil()</script><style>p{}</style><noscript>n</noscript><iframe src="x"></iframe>')
    expect(r.via).toBe('turndown')
    expect(r.markdown).toBe('# Title\n\nBody')
    expect(r.truncated).toBe(false)
  })

  it('truncates a 1.5 MiB HTML input at the 1 MiB cap and appends the marker', async () => {
    expect(TURNDOWN_INPUT_CAP).toBe(1_048_576)
    const html = `<p>${'0123456789abcdef '.repeat(Math.ceil((1.5 * 1024 * 1024) / 17))}</p>`
    expect(html.length).toBeGreaterThan(1.5 * 1024 * 1024)
    const r = await htmlToMarkdown(html)
    expect(r.truncated).toBe(true)
    expect(r.markdown.endsWith(TRUNCATION_MARKER)).toBe(true)
    const full = await htmlToMarkdown(html.slice(0, TURNDOWN_INPUT_CAP))
    expect(r.markdown.length).toBe(full.markdown.length + TRUNCATION_MARKER.length)
  })

  it('an input exactly at the cap is not truncated', async () => {
    const r = await htmlToMarkdown('x'.repeat(TURNDOWN_INPUT_CAP))
    expect(r.truncated).toBe(false)
    expect(r.markdown.endsWith(TRUNCATION_MARKER)).toBe(false)
  })

  it('degrades to cleaned text when Turndown throws, keeping the truncation marker', async () => {
    const html = '<script>x()</script><p>Hello</p><div>World</div>' + ' '.repeat(TURNDOWN_INPUT_CAP)
    const r = await htmlToMarkdown(html, async () => {
      throw new Error('turndown unavailable')
    })
    expect(r.via).toBe('fallback')
    expect(r.markdown).toContain('Hello')
    expect(r.markdown).not.toContain('x()')
    expect(r.truncated).toBe(true)
    expect(r.markdown.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})
