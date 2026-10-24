/**
 * Unit spec for extractSnippet (src/lib/parsers.ts), driven through
 * extractResultsFromHtml the way a rendered result list reaches it.
 * Pure logic: no process, network or profile access.
 * guards: a card's snippet is taken from the previous card when the 500-character look-behind window reaches it
 * tier: S
 * cites: 8468f7b1 [fix-core-parsers.1]
 */
import { describe, expect, it } from 'vitest'
import { extractResultsFromHtml } from '../../../src/lib/parsers.js'
import type { CaptureConfig } from '../../../src/lib/types.js'

const capture: CaptureConfig = {
  parser: 'html',
  fields: { title: 'a.t', url: 'a', snippet: 'p.s' },
} as unknown as CaptureConfig

const card = (i: number, snippet: string | null, filler = ''): string =>
  `<li><a class="t" href="https://site.test/r/${i}">Card ${i}</a>${snippet === null ? '' : `<p class="s">${snippet}</p>`}${filler}</li>`

describe('8468f7b1 [fix-core-parsers.1] extractSnippet on short cards never takes the previous card within the 500-character window', () => {
  const snippets = Array.from({ length: 12 }, (_, i) => `snippet-${i}`)
  const list = `<ul>${snippets.map((s, i) => card(i, s)).join('')}</ul>`

  it('short cards: each of 12 cards returns its own snippet, never the previous card', () => {
    const out = extractResultsFromHtml(list, capture)
    expect(out).toHaveLength(12)
    out.forEach((r, i) => {
      expect(r.title).toBe(`Card ${i}`)
      expect(r.snippet).toBe(snippets[i])
    })
  })

  it('every short card window reaches its predecessor within 500 characters (precondition)', () => {
    for (const s of snippets) expect(s.length).toBeLessThan(40)
    const second = list.indexOf('Card 1')
    expect(list.slice(Math.max(0, second - 500), second)).toContain('snippet-0')
  })

  it('the first card has no predecessor and returns its own snippet', () => {
    expect(extractResultsFromHtml(list, capture)[0].snippet).toBe('snippet-0')
  })

  it('previous card snippet is not borrowed when the card has no snippet of its own', () => {
    const body = `<ul>${card(0, 'only-first')}${card(1, null)}</ul>`
    const out = extractResultsFromHtml(body, capture)
    expect(out[0].snippet).toBe('only-first')
    expect(out[1].snippet).toBe('')
  })

  it('long card truncates at the forward window: own snippet inside 5000 is found, beyond it is not', () => {
    const inside = `<ul>${card(0, null).replace('</li>', '')}<p>${'y'.repeat(4000)}</p><p class="s">near</p></li></ul>`
    expect(extractResultsFromHtml(inside, capture)[0].snippet).toBe('near')
    const beyond = `<ul>${card(0, null).replace('</li>', '')}<p>${'y'.repeat(6000)}</p><p class="s">far</p></li></ul>`
    expect(extractResultsFromHtml(beyond, capture)[0].snippet).toBe('')
  })
})
