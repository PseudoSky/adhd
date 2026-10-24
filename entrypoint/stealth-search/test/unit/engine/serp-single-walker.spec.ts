/**
 * guards: a second copy of the Google result-page walker lives in the search package, or the dead whitespace-split title fallback returns
 * tier: S
 * cites: ticket 8468f7b1 [fix-search-engine.2] [fix-search-engine.3]
 * One Google SERP walker, kept in the core (OD-11, provisional). The search package's extractGoogleSerp
 * delegates to the core walkDomTree structural mode; a Google fixture parses to the same titles, and the
 * title fallback that split on runs of whitespace (dead, because the text helper already collapses
 * whitespace) exists in neither package. Ticket 8468f7b1 · [fix-search-engine.2] [fix-search-engine.3]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractGoogleSerp } from '../../../src/lib/dom.js'
import { fixture, htmlToDomTree } from '../../helpers/engine/harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const searchDom = readFileSync(join(here, '..', '..', '..', 'src', 'lib', 'dom.ts'), 'utf8')
const coreDom = readFileSync(join(here, '..', '..', '..', '..', '..', 'packages', 'stealth', 'stealth-core-browser', 'src', 'lib', 'capture', 'dom.ts'), 'utf8')

describe('google serp through the single walker [fix-search-engine.2]', () => {
  it('google fixture: the title of each result is its heading text, read by the single walker', async () => {
    const results = await extractGoogleSerp(htmlToDomTree(fixture('google-serp.html')))
    expect(results.map((r) => r.title)).toEqual(['pino - super fast, all natural JSON logger for Node.js', '11 Node.js logging best practices'])
    expect(results[0]?.url).toBe('https://github.com/pinojs/pino')
  })

  it('google heading with inner whitespace: the title is whitespace-collapsed by the text helper, not split into chunks', async () => {
    const html = '<div id="rso"><div><div><a jsname="a" href="https://a.test/x"><div><div><h3>Two   words\n  and   a gap</h3></div></div></a><span>x</span><p>y</p></div></div></div>'
    const results = await extractGoogleSerp(htmlToDomTree(html))
    expect(results.map((r) => r.title)).toEqual(['Two words and a gap'])
  })

  it('google anchor without a heading: the dead title fallback is gone, so no guessed title is produced', async () => {
    const html =
      '<div id="rso"><div><div><a jsname="a" href="https://a.test/x"><div><div><span>A short title</span><span>a.test deep breadcrumb path here</span></div></div></div></a><span>x</span><p>y</p></div></div>'
    expect(await extractGoogleSerp(htmlToDomTree(html))).toEqual([])
  })

  it('google redirect href: the single walker normalizes the goto, protocol-relative and q= redirects', async () => {
    const card = (href: string, title: string): string => `<div><a jsname="k" href="${href}"><div><div><h3>${title}</h3></div></div></a></div>`
    const results = await extractGoogleSerp(htmlToDomTree(`<body>${card('/goto?url=abc', 'One')}${card('//example.com/p', 'Two')}${card('/url?q=https%3A%2F%2Fthree.test%2F&sa=U', 'Three')}</body>`))
    expect(results.map((r) => r.url)).toEqual(['https://www.google.com/goto?url=abc', 'https://example.com/p', 'https://three.test/'])
  })
})

describe('exactly one walker [fix-search-engine.3]', () => {
  it('single walker: the search dom.ts holds no second copy of the google result-page walker helpers', () => {
    for (const helper of ['hasDivDiv', 'findHeadingText', 'findSnippet', 'findContainer']) expect(searchDom).not.toMatch(new RegExp(`function ${helper}\\b`))
    expect(searchDom).toContain('walkDomTree')
  })

  it('whitespace split fallback: the dead \\s{2,} title fallback exists in neither the search nor the core dom.ts', () => {
    expect(searchDom).not.toMatch(/\\s\{2,\}/)
    expect(coreDom).not.toMatch(/\\s\{2,\}/)
  })

  it('google walker lives in the core: the core dom.ts still holds hasDivDiv and findHeadingText', () => {
    expect(coreDom).toContain('function hasDivDiv')
    expect(coreDom).toContain('function findHeadingText')
  })
})
