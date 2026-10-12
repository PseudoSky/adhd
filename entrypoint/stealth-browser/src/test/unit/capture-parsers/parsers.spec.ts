/**
 * Unit spec for src/lib/parsers.ts.
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-extract.1] [tests-unit-extract.2]
 * [tests-unit-extract.4].
 * node-html-parser, @xmldom/xmldom and xpath are pure and run for real against
 * in-test HTML/JSON fixtures; no network or process is involved.
 */
import { describe, expect, it } from 'vitest'
import {
  extractResultsFromEmbeddedJson,
  extractResultsFromHtml,
  extractResultsFromJson,
  extractStructural,
  extractWithXpath,
} from '../../../lib/parsers.js'
import type { CaptureConfig } from '../../../lib/types.js'

const cfg = (over: Partial<Omit<CaptureConfig, 'fields'>> & { fields?: Partial<CaptureConfig['fields']> } = {}): CaptureConfig => ({
  urlPattern: '.*',
  parser: 'html',
  resultSelector: '*',
  ...over,
  fields: { title: 'h2', url: 'a', snippet: 'p', ...over.fields },
})

const LONG = 'A long descriptive snippet that is definitely more than sixty characters in total length.'

const googleHtml = `<html><body><div id="rso">
<div><a jsname="x1" href="https://one.test/page"><div><div><h3>Result   One</h3></div></div></a><div>${LONG}</div><div>meta</div></div>
<div><a jsname="x2" href="/url?q=https%3A%2F%2Ftwo.test%2F&amp;sa=U"><div><div><h3>Result Two</h3></div></div></a><div>${LONG}</div><div>m</div></div>
<div><a jsname="x1" href="https://one.test/page"><div><div><h3>Duplicate</h3></div></div></a></div>
<div><a jsname="n1" href="https://noheading.test/"><div><div><span>no heading</span></div></div></a></div>
<div><a href="https://plain.test/">no jsname</a></div>
</div></body></html>`

describe('8468f7b1 AC2 [tests-unit-extract.1] extractWithXpath (xmldom + xpath)', () => {
  it('extracts title, url and snippet from a SERP-shaped document', () => {
    const out = extractWithXpath(googleHtml)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'Result One', url: 'https://one.test/page', snippet: LONG })
    expect(out[1].url).toBe('https://two.test/')
  })

  it('skips duplicate hrefs, heading-less anchors and anchors without jsname', () => {
    const urls = extractWithXpath(googleHtml).map((r) => r.url)
    expect(urls).not.toContain('https://noheading.test/')
    expect(urls).not.toContain('https://plain.test/')
    expect(urls.filter((u) => u === 'https://one.test/page')).toHaveLength(1)
  })

  it('returns [] for empty or result-free input', () => {
    expect(extractWithXpath('')).toEqual([])
    expect(extractWithXpath('<html><body><p>nothing</p></body></html>')).toEqual([])
  })

  it('never throws on malformed markup', () => {
    expect(() => extractWithXpath('<div><a jsname="q" href="x"><div><div><h3>t</h3></div></div>')).not.toThrow()
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] extractResultsFromJson', () => {
  const body = JSON.stringify({
    data: { items: [
      { t: 'Alpha', link: '/a', s: 'snip a', n: { score: 7 } },
      { t: 'Beta', link: '//b.test/x', s: 'snip b' },
    ] },
  })
  const c = cfg({ parser: 'json', resultSelector: 'data.items', fields: { title: 't', url: 'link', snippet: 's', meta: { score: 'n.score' } } })

  it('maps dot-path fields and meta, normalising urls', () => {
    const out = extractResultsFromJson(body, c)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'Alpha', url: '/a', snippet: 'snip a', meta: { score: '7' } })
    expect(out[1].url).toBe('https://b.test/x')
    expect(out[1].meta).toEqual({ score: '' })
  })

  it('applies urlTemplate to the extracted value', () => {
    const out = extractResultsFromJson(body, { ...c, fields: { ...c.fields, urlTemplate: 'https://site.test{}' } })
    expect(out[0].url).toBe('https://site.test/a')
  })

  it('supports "*" selector for a root array', () => {
    const out = extractResultsFromJson(JSON.stringify([{ t: 'Root', link: 'u', s: '' }]), { ...c, resultSelector: '*' })
    expect(out[0].title).toBe('Root')
  })

  it('returns [] for invalid JSON, a missing path, or a non-array', () => {
    expect(extractResultsFromJson('{not json', c)).toEqual([])
    expect(extractResultsFromJson('{"data":{}}', c)).toEqual([])
    expect(extractResultsFromJson('{"data":{"items":{"a":1}}}', c)).toEqual([])
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] extractResultsFromEmbeddedJson', () => {
  const data = {
    payload: { results: [
      { repo_nwo: 'o/r', ref_name: 'refs/heads/main', path: 'src/a.ts', name: 'a.ts', snippets: [{ lines: ['<b>hit</b> one', 'two', 'three'] }] },
      { name: 'fallback', url: '/plain', snippet: 'direct' },
    ] },
  }
  const page = (target: string, json: unknown) =>
    `<html><script type="application/json" data-target="${target}">${JSON.stringify(json)}</script></html>`
  const c = cfg({ parser: 'embedded-json', resultSelector: 'payload.results', fields: { title: 'name', url: 'url', snippet: 'snippet' } })

  it('builds blob urls and strips html from snippet lines (default 1 line)', () => {
    const out = extractResultsFromEmbeddedJson(page('react-app.embeddedData', data), c)
    expect(out[0].url).toBe('https://github.com/o/r/blob/main/src/a.ts')
    expect(out[0].snippet).toBe('hit one')
    expect(out[0].title).toBe('a.ts')
  })

  it('honours snippetLines and falls back to field values', () => {
    const out = extractResultsFromEmbeddedJson(page('react-app.embeddedData', data), { ...c, snippetLines: 2 })
    expect(out[0].snippet).toBe('hit one two')
    expect(out[1]).toMatchObject({ url: '/plain', snippet: 'direct' })
  })

  it('honours a custom dataTarget and urlTemplate', () => {
    const out = extractResultsFromEmbeddedJson(page('custom.target', data), { ...c, dataTarget: 'custom.target', fields: { ...c.fields, urlTemplate: 'https://t.test{}' } })
    expect(out).toHaveLength(2)
    expect(out[1].url).toBe('https://t.test/plain')
  })

  it('returns [] when the script tag is absent, has other target, or JSON is broken', () => {
    expect(extractResultsFromEmbeddedJson('<html></html>', c)).toEqual([])
    expect(extractResultsFromEmbeddedJson(page('other', data), c)).toEqual([])
    expect(extractResultsFromEmbeddedJson('<script type="application/json" data-target="react-app.embeddedData">{bad</script>', c)).toEqual([])
    expect(extractResultsFromEmbeddedJson(page('react-app.embeddedData', { payload: { results: 'x' } }), c)).toEqual([])
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] extractStructural (node-html-parser)', () => {
  const html = `<html><body><div><a jsname="j" href="https://s.test/1"><div><div>Structural One</div></div></a><div>${LONG}</div><div>x</div></div>` +
    `<div><a jsname="j" href="https://s.test/1"><div><div>Dup</div></div></a></div>` +
    `<div><a jsname="j" href="https://s.test/2"><span>not a div child</span></a></div></body></html>`

  it('finds a[jsname] > div > div results, de-duplicated by url', () => {
    const out = extractStructural(html, cfg())
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Structural One')
    expect(out[0].url).toBe('https://s.test/1')
    expect(out[0].snippet).toContain('descriptive snippet')
  })

  it('applies urlTemplate and returns [] when nothing qualifies', () => {
    expect(extractStructural(html, cfg({ fields: { urlTemplate: 'https://base.test{}' } }))[0].url).toBe('https://base.testhttps://s.test/1')
    expect(extractStructural('<p>none</p>', cfg())).toEqual([])
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] extractResultsFromHtml (class-based)', () => {
  it('pass 1: href on the title element, with ddg redirect unwrapped', () => {
    const html = `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fddg.test%2Fp">DDG <b>Hit</b></a><p class="result__snippet">snippet <i>one</i></p>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'a.result__a', url: 'a.result__a', snippet: 'p.result__snippet' } }))
    expect(out).toEqual([{ title: 'DDG Hit', url: 'https://ddg.test/p', snippet: 'snippet one' }])
  })

  it('pass 2: href on a child anchor, with urlTemplate', () => {
    const html = `<p class="title"><a href="/pkg/x">Pkg X</a></p><p class="title"><a href="/pkg/x">Pkg X again</a></p>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'p.title', url: 'a', snippet: 'span.d', urlTemplate: 'https://reg.test{}' } }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: 'Pkg X', url: 'https://reg.test/pkg/x' })
  })

  it('pass 2.5: wrapper anchor encloses the title (no off-by-one pairing)', () => {
    const html = `<a class="snippet" href="/project/requests/"><span class="name">requests</span></a>` +
      `<a class="snippet" href="/project/selenium-requests/"><span class="name">selenium-requests</span></a>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'span.name', url: 'a.snippet', snippet: 'p.d' } }))
    expect(out.map((r) => [r.title, r.url])).toEqual([
      ['requests', '/project/requests/'],
      ['selenium-requests', '/project/selenium-requests/'],
    ])
  })

  it('pass 3: title and link on separate sibling elements', () => {
    const html = `<h3>Sibling Title</h3><a class="lnk" href="https://sib.test/">go</a>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'h3', url: 'a.lnk', snippet: 'p' } }))
    expect(out).toEqual([{ title: 'Sibling Title', url: 'https://sib.test/', snippet: '' }])
  })

  it('normalises /abs/ and /goto?url= paths', () => {
    const abs = extractResultsFromHtml(`<a class="t" href="/abs/2401.1">Paper</a>`, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p' } }))
    expect(abs[0].url).toBe('https://arxiv.org/abs/2401.1')
    const go = extractResultsFromHtml(`<a class="t" href="/goto?url=TOKEN">G</a>`, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p' } }))
    expect(go[0].url).toBe('https://www.google.com/goto?url=TOKEN')
  })

  it('returns [] for an unparseable title pattern or an empty body', () => {
    expect(extractResultsFromHtml('<h2>x</h2>', cfg({ fields: { title: '##bad', url: 'a', snippet: 'p' } }))).toEqual([])
    expect(extractResultsFromHtml('', cfg())).toEqual([])
  })
})
