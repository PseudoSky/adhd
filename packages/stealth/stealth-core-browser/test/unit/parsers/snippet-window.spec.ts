/**
 * guards: a result card without a snippet of its own takes the snippet of the next card, the forward window is unbounded on adversarial input, or one malformed percent-escape aborts the parse of a whole results page
 * tier: S
 * cites: ticket 8468f7b1 [audit-fixes.1]
 * Pre-review P1 (the forward snippet window ends at the next card's title element and never exceeds
 * SNIPPET_WINDOW characters) and P27 (page-supplied percent-escapes cannot throw URIError). Driven through
 * extractResultsFromHtml with adversarial pages: no process, network or profile access.
 * Ticket 8468f7b1 · [audit-fixes.1]
 */
import { describe, expect, it } from 'vitest'
import { extractResultsFromHtml } from '../../../src/lib/parsers.js'
import type { CaptureConfig } from '../../../src/lib/types.js'

/** The documented bound of the forward snippet window (src/lib/parsers.ts). */
const SNIPPET_WINDOW = 5000

const selfHref: CaptureConfig = { parser: 'html', fields: { title: 'a.t', url: 'a', snippet: 'p.s' } } as unknown as CaptureConfig
const childTitle: CaptureConfig = { parser: 'html', fields: { title: 'h3.t', url: 'a', snippet: 'p.s' } } as unknown as CaptureConfig
const wrapper: CaptureConfig = { parser: 'html', fields: { title: 'span.name', url: 'a.card', snippet: 'p.s' } } as unknown as CaptureConfig

const card = (i: number, snippet: string | null): string => `<li><a class="t" href="https://site.test/r/${i}">Card ${i}</a>${snippet === null ? '' : `<p class="s">${snippet}</p>`}</li>`

describe('a card never takes the next card\'s snippet [audit-fixes.1]', () => {
  it('P1 title-with-href cards: the card without a snippet is empty and the next card keeps its own', () => {
    const out = extractResultsFromHtml(`<ul>${card(0, 'first')}${card(1, null)}${card(2, 'third')}</ul>`, selfHref)
    expect(out.map((r) => r.snippet)).toEqual(['first', '', 'third'])
  })

  it('P1 the last card without a snippet is empty and a snippet-less run is all empty', () => {
    expect(extractResultsFromHtml(`<ul>${card(0, 'a')}${card(1, null)}</ul>`, selfHref).map((r) => r.snippet)).toEqual(['a', ''])
    expect(extractResultsFromHtml(`<ul>${card(0, null)}${card(1, null)}${card(2, null)}</ul>`, selfHref).map((r) => r.snippet)).toEqual(['', '', ''])
  })

  it('P1 child-anchor cards (pass 2): the same boundary holds', () => {
    const c = (i: number, s: string | null): string => `<div><h3 class="t"><a href="https://site.test/c/${i}">Child ${i}</a></h3>${s === null ? '' : `<p class="s">${s}</p>`}</div>`
    const out = extractResultsFromHtml(`${c(0, null)}${c(1, 'second')}`, childTitle)
    expect(out.map((r) => [r.title, r.snippet])).toEqual([
      ['Child 0', ''],
      ['Child 1', 'second'],
    ])
  })

  it('P1 wrapper-anchor cards (pass 2.5): the same boundary holds', () => {
    const w = (i: number, s: string | null): string => `<a class="card" href="/project/p${i}/"><span class="name">p${i}</span>${s === null ? '' : `<p class="s">${s}</p>`}</a>`
    const out = extractResultsFromHtml(`${w(0, null)}${w(1, 'only second')}`, wrapper)
    expect(out.map((r) => [r.title, r.snippet])).toEqual([
      ['p0', ''],
      ['p1', 'only second'],
    ])
  })

  it('P1 adversarial: a snippet beyond the window, an unclosed snippet tag and a snippet-looking decoy far away are never returned', () => {
    const far = `<ul>${card(0, null)}<div>${'x'.repeat(SNIPPET_WINDOW + 10)}</div><p class="s">too far</p></ul>`
    expect(extractResultsFromHtml(far, selfHref)[0]?.snippet).toBe('')
    const unclosed = `<ul><li><a class="t" href="https://site.test/u">U</a><p class="s">never closed</li></ul>`
    expect(extractResultsFromHtml(unclosed, selfHref)[0]?.snippet).toBe('')
  })

  it('P1 adversarial: 20000 snippet-less cards parse in bounded time and stay empty', () => {
    const page = `<ul>${Array.from({ length: 20000 }, (_, i) => card(i, null)).join('')}<p class="s">orphan</p></ul>`
    const t0 = Date.now()
    const out = extractResultsFromHtml(page, selfHref)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(out).toHaveLength(20000)
    expect(out.slice(0, 19999).every((r) => r.snippet === '')).toBe(true)
  })

  it('P1 adversarial: a card title containing regex metacharacters and nested tags still pairs its own snippet', () => {
    const page = '<ul><li><a class="t" href="https://site.test/m">A (b) [c] *d* <b>bold</b></a><p class="s">own <i>text</i></p></li></ul>'
    const out = extractResultsFromHtml(page, selfHref)
    expect(out[0]?.snippet).toBe('own text')
  })
})

describe('a malformed percent-escape does not abort the page [audit-fixes.1]', () => {
  const ddg: CaptureConfig = { parser: 'html', fields: { title: 'a.result__a', url: 'a', snippet: 'p.s' } } as unknown as CaptureConfig
  const link = (href: string, title: string): string => `<a class="result__a" href="${href}">${title}</a><p class="s">${title} text</p>`

  it('P27 a bad uddg escape keeps the other results of the page and the bad run as written', () => {
    const page = `${link('//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.test%2Fa&rut=1', 'Good')}${link('//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.test%2F%E0%A4%A&rut=2', 'Bad')}${link('//duckduckgo.com/l/?uddg=https%3A%2F%2Fnext.test%2Fz', 'Next')}`
    const out = extractResultsFromHtml(page, ddg)
    expect(out.map((r) => r.title)).toEqual(['Good', 'Bad', 'Next'])
    expect(out[0]?.url).toBe('https://good.test/a')
    expect(out[1]?.url).toBe('https://bad.test/%E0%A4%A')
    expect(out[2]?.url).toBe('https://next.test/z')
  })

  it('P27 a lone percent sign and a truncated multi-byte sequence are tolerated in the q= form too', () => {
    const page = `${link('/url?q=https://site.test/100%&sa=U', 'Pct')}${link('/url?q=https%3A%2F%2Fsite.test%2F%E2%82&sa=U', 'Trunc')}`
    const out = extractResultsFromHtml(page, ddg)
    expect(out.map((r) => r.title)).toEqual(['Pct', 'Trunc'])
    expect(out[0]?.url).toBe('https://site.test/100%')
  })
})
