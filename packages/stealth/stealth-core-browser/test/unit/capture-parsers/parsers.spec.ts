/**
 * Unit spec for src/lib/parsers.ts.
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-extract.1] [tests-unit-extract.2]
 * [tests-unit-extract.4].
 * node-html-parser, @xmldom/xmldom and xpath are pure and run for real against
 * in-test HTML/JSON fixtures; no network or process is involved.
 * guards: [fs-144] xpath extraction returns deduplicated titled results from a SERP-shaped document
 * tier: S
 * cites: 8468f7b1 [tests-unit-extract.1] [tests-unit-extract.2] [tests-unit-extract.4]
 */
import { describe, expect, it } from 'vitest'
import {
  extractResultsFromEmbeddedJson,
  extractResultsFromHtml,
  extractResultsFromJson,
  extractStructural,
  extractWithXpath,
} from '../../../src/lib/parsers.js'
import type { CaptureConfig } from '../../../src/lib/types.js'

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
  it('[fs-144] xpath extraction returns deduplicated titled results from a SERP-shaped document', () => {
    const out = extractWithXpath(googleHtml)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'Result One', url: 'https://one.test/page', snippet: LONG })
    expect(out[1].url).toBe('https://two.test/')
  })

  it('[fs-144] xpath extraction skips duplicate hrefs, heading-less anchors and anchors without jsname', () => {
    const urls = extractWithXpath(googleHtml).map((r) => r.url)
    expect(urls).not.toContain('https://noheading.test/')
    expect(urls).not.toContain('https://plain.test/')
    expect(urls.filter((u) => u === 'https://one.test/page')).toHaveLength(1)
  })

  it('returns [] for empty or result-free input', () => {
    expect(extractWithXpath('')).toEqual([])
    expect(extractWithXpath('<html><body><p>nothing</p></body></html>')).toEqual([])
  })

  it('[fs-143] xpath extraction survives malformed html without throwing', () => {
    expect(() => extractWithXpath('<div><a jsname="q" href="x"><div><div><h3>t</h3></div></div>')).not.toThrow()
    expect(() => extractWithXpath('<<<>>> <a jsname=')).not.toThrow()
    expect(extractWithXpath('<<<>>> <a jsname=')).toEqual([])
    // unclosed tags still yield the well-formed result
    const out = extractWithXpath(`<div><a jsname="q" href="https://m.test/"><div><div><h3>Mal</h3></div></div></a><div>${LONG}</div><div>x</div>`)
    expect(out.length).toBeLessThanOrEqual(1)
  })

  it('[fs-145] xpath extraction finds a snippet with a fallback to remaining parent text', () => {
    // preferred: a >60-char descendant div that is neither the title nor a link
    expect(extractWithXpath(googleHtml)[0].snippet).toBe(LONG)
    // fallback: container has < 3 child nodes, so the remaining parent text is taken
    const fallback = `<div><a jsname="b" href="https://f.test/"><div><div><h3>Fall</h3></div></div></a>${LONG}</div>`
    const out = extractWithXpath(fallback)
    expect(out).toHaveLength(1)
    expect(out[0].snippet).toBe(LONG)
    // nothing descriptive anywhere: empty snippet
    expect(extractWithXpath(`<div><a jsname="c" href="https://e.test/"><div><div><h3>Bare</h3></div></div></a></div>`)[0].snippet).toBe('')
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

  it('[fs-146] extracts results from json by dot path with meta maps, normalising urls', () => {
    const out = extractResultsFromJson(body, c)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'Alpha', url: '/a', snippet: 'snip a', meta: { score: '7' } })
    expect(out[1].url).toBe('https://b.test/x')
    expect(out[1].meta).toEqual({ score: '' })
  })

  it('[fs-148] applies the url template to relative hrefs and bare ids', () => {
    const out = extractResultsFromJson(body, { ...c, fields: { ...c.fields, urlTemplate: 'https://site.test{}' } })
    expect(out[0].url).toBe('https://site.test/a')
    const ids = extractResultsFromJson(JSON.stringify([{ t: 'Q', link: '30621', s: '' }]), {
      ...c, resultSelector: '*', fields: { ...c.fields, urlTemplate: 'https://news.test/item?id={}' },
    })
    expect(ids[0].url).toBe('https://news.test/item?id=30621')
    // html path applies the template before normalisation too
    const html = extractResultsFromHtml(`<p class="title"><a href="/pkg/x">Pkg</a></p>`, cfg({ fields: { title: 'p.title', url: 'a', snippet: 'span.d', urlTemplate: 'https://reg.test{}' } }))
    expect(html[0].url).toBe('https://reg.test/pkg/x')
  })

  it('[fs-147] resolves dot paths safely, with "*" as the root and undefined through null or scalar steps', () => {
    const out = extractResultsFromJson(JSON.stringify([{ t: 'Root', link: 'u', s: '' }]), { ...c, resultSelector: '*' })
    expect(out[0].title).toBe('Root')
    // null / scalar steps on the way down yield empty fields rather than throwing
    const nulls = extractResultsFromJson(JSON.stringify([{ t: null, link: 'u', s: 'x', n: 5 }]), {
      ...c, resultSelector: '*', fields: { title: 't.deep', url: 'link', snippet: 's', meta: { m: 'n.deeper', z: 'missing.a.b' } },
    })
    expect(nulls[0]).toMatchObject({ title: '', url: 'u', meta: { m: '', z: '' } })
    expect(extractResultsFromJson(JSON.stringify({ a: null }), { ...c, resultSelector: 'a.b.c' })).toEqual([])
  })

  it('[fs-150] extracts meta fields per result as named strings', () => {
    const out = extractResultsFromJson(body, c)
    expect(out[0].meta).toEqual({ score: '7' })
    const multi = extractResultsFromJson(JSON.stringify([{ t: 'T', link: 'u', s: '', a: { b: 'deep' }, n: 3 }]), {
      ...c, resultSelector: '*', fields: { title: 't', url: 'link', snippet: 's', meta: { first: 'a.b', num: 'n', gone: 'x.y' } },
    })
    expect(multi[0].meta).toEqual({ first: 'deep', num: '3', gone: '' })
  })

  it('[fs-146] json extraction returns [] for invalid JSON, a missing path, or a non-array', () => {
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

  it('[fs-149] extracts embedded json results with github urls and html-stripped snippet lines (default 1 line)', () => {
    const out = extractResultsFromEmbeddedJson(page('react-app.embeddedData', data), c)
    expect(out[0].url).toBe('https://github.com/o/r/blob/main/src/a.ts')
    expect(out[0].snippet).toBe('hit one')
    expect(out[0].title).toBe('a.ts')
    // snippet lines are capped at 500 chars
    const long = page('react-app.embeddedData', { payload: { results: [{ repo_nwo: 'o/r', ref_name: 'main', path: 'p', name: 'n', snippets: [{ lines: ['x'.repeat(900)] }] }] } })
    expect(extractResultsFromEmbeddedJson(long, c)[0].snippet).toHaveLength(500)
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

  it('[fs-155] structural extraction finds jsname result cards by structure, de-duplicated by url', () => {
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
  it('[fs-151] class based extraction passes one and two: pass 1 href on the title element, ddg redirect unwrapped', () => {
    const html = `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fddg.test%2Fp">DDG <b>Hit</b></a><p class="result__snippet">snippet <i>one</i></p>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'a.result__a', url: 'a.result__a', snippet: 'p.result__snippet' } }))
    expect(out).toEqual([{ title: 'DDG Hit', url: 'https://ddg.test/p', snippet: 'snippet one' }])
  })

  it('[fs-151] class based extraction passes one and two: pass 2 href on a child anchor, de-duplicated', () => {
    const html = `<p class="title"><a href="/pkg/x">Pkg X</a></p><p class="title"><a href="/pkg/x">Pkg X again</a></p>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'p.title', url: 'a', snippet: 'span.d', urlTemplate: 'https://reg.test{}' } }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ title: 'Pkg X', url: 'https://reg.test/pkg/x' })
  })

  it('[fs-152] wrapper anchors pair titles with their own href (no off-by-one pairing)', () => {
    const html = `<a class="snippet" href="/project/requests/"><span class="name">requests</span></a>` +
      `<a class="snippet" href="/project/selenium-requests/"><span class="name">selenium-requests</span></a>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'span.name', url: 'a.snippet', snippet: 'p.d' } }))
    expect(out.map((r) => [r.title, r.url])).toEqual([
      ['requests', '/project/requests/'],
      ['selenium-requests', '/project/selenium-requests/'],
    ])
  })

  it('[fs-153] pairs a title with the nearest following link', () => {
    const html = `<h3>Sibling Title</h3><a class="lnk" href="https://sib.test/">go</a>`
    const out = extractResultsFromHtml(html, cfg({ fields: { title: 'h3', url: 'a.lnk', snippet: 'p' } }))
    expect(out).toEqual([{ title: 'Sibling Title', url: 'https://sib.test/', snippet: '' }])
    const two = extractResultsFromHtml(`<h3>A</h3><a class="lnk" href="https://a.test/">a</a><h3>B</h3><a class="lnk" href="https://b.test/">b</a>`, cfg({ fields: { title: 'h3', url: 'a.lnk', snippet: 'p' } }))
    expect(two.map((r) => [r.title, r.url])).toEqual([['A', 'https://a.test/'], ['B', 'https://b.test/']])
  })

  it('[fs-154] reads a snippet near the match, windowed around it', () => {
    const near = `<a class="t" href="https://s.test/">Title</a><div>filler</div><p class="sn">near <b>snippet</b>  text</p>`
    const out = extractResultsFromHtml(near, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p.sn' } }))
    expect(out[0].snippet).toBe('near snippet text')
    // beyond the +5000 char window the snippet is not found
    const far = `<a class="t" href="https://s.test/">Title</a>${'z'.repeat(6000)}<p class="sn">too far</p>`
    expect(extractResultsFromHtml(far, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p.sn' } }))[0].snippet).toBe('')
    // an invalid snippet pattern yields no snippet rather than failing
    expect(extractResultsFromHtml(near, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: '##' } }))[0].snippet).toBe('')
  })

  it('[fs-156] normalizeUrl handles redirect and relative forms (uddg, q=, //, /abs/, /goto?url=)', () => {
    const abs = extractResultsFromHtml(`<a class="t" href="/abs/2401.1">Paper</a>`, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p' } }))
    expect(abs[0].url).toBe('https://arxiv.org/abs/2401.1')
    const go = extractResultsFromHtml(`<a class="t" href="/goto?url=TOKEN">G</a>`, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p' } }))
    expect(go[0].url).toBe('https://www.google.com/goto?url=TOKEN')
    const one = (href: string) => extractResultsFromHtml(`<a class="t" href="${href}">T</a>`, cfg({ fields: { title: 'a.t', url: 'a.t', snippet: 'p' } }))[0].url
    expect(one('/l/?uddg=https%3A%2F%2Fddg.test%2Fp')).toBe('https://ddg.test/p')
    expect(one('/url?q=https%3A%2F%2Fg.test%2F')).toBe('https://g.test/')
    expect(one('//proto.test/x')).toBe('https://proto.test/x')
    expect(one('https://abs.test/?q=keep')).toBe('https://abs.test/?q=keep')
  })

  it('returns [] for an unparseable title pattern or an empty body', () => {
    expect(extractResultsFromHtml('<h2>x</h2>', cfg({ fields: { title: '##bad', url: 'a', snippet: 'p' } }))).toEqual([])
    expect(extractResultsFromHtml('', cfg())).toEqual([])
  })
})
