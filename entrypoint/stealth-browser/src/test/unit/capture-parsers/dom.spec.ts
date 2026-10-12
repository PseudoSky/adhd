/**
 * Unit spec for src/lib/capture/dom.ts (CDP DOM walker).
 * Ticket 8468f7b1 AC2 · criteria [tests-unit-extract.1] [tests-unit-extract.2]
 * [tests-unit-extract.3] [tests-unit-extract.4].
 * The CDP session is a hand-rolled fake (vi.fn); no socket, process or Chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectBanInPage, extractFromDom, walkDomTree } from '../../../lib/capture/dom.js'
import type { DomExtractor } from '../../../lib/types.js'

interface N {
  nodeId: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  attributes?: string[]
  children?: N[]
}

let id = 1
const el = (nodeName: string, attributes: string[] = [], children: N[] = []): N => ({
  nodeId: id++,
  nodeType: 1,
  nodeName,
  attributes,
  children,
})
const txt = (nodeValue: string): N => ({ nodeId: id++, nodeType: 3, nodeName: '#text', nodeValue })

const SNIPPET = 'This is a sufficiently long descriptive snippet of the page content for testing.'

/** Google-like result: div > [a[jsname] > div > div > h3, breadcrumb, snippet div]. */
function result(url: string, title: string, snippet = SNIPPET): N {
  const anchor = el('A', ['jsname', 'abc', 'href', url], [
    el('DIV', [], [el('DIV', [], [el('H3', [], [txt(title)])])]),
  ])
  return el('DIV', [], [anchor, el('DIV', [], [txt(snippet)]), el('DIV', [], [txt('meta')])])
}

const doc = (...kids: N[]): N => el('#document', [], [el('HTML', [], [el('BODY', [], kids)])])

describe('8468f7b1 AC2 [tests-unit-extract.1] extractFromDom (pattern mode)', () => {
  const item = (cls: string, title: string, href: string, snippet: string): N =>
    el('LI', ['class', cls], [
      el('H2', [], [txt(title)]),
      el('A', ['href', href, 'data-x', 'v1'], [txt('link')]),
      el('P', ['class', 'snip'], [txt(snippet)]),
      el('SCRIPT', [], [txt('ignored()')]),
    ])

  const extractor: DomExtractor = {
    container: { tag: 'LI', attrs: { class: /^res/ } },
    title: { tag: 'H2' },
    link: { tag: 'A', attr: 'href' },
    snippet: { tag: 'P', attrs: { class: 'snip' } },
    extra: { tag: { tag: 'A', attr: 'data-x' }, missing: { tag: 'SPAN' } },
  }

  it('extracts title, normalised url, snippet and extra meta per container', () => {
    const root = doc(item('res a', 'First', '//example.com/a', 'one'), item('res b', 'Second', '/l?uddg=https%3A%2F%2Fb.test%2F', 'two'))
    const out = extractFromDom(root, extractor)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ title: 'First', url: 'https://example.com/a', snippet: 'one', meta: { tag: 'v1' } })
    expect(out[1].url).toBe('https://b.test/')
  })

  it('skips containers that do not match the pattern', () => {
    const root = doc(item('other', 'Nope', '/x', 's'))
    expect(extractFromDom(root, extractor)).toEqual([])
  })

  it('drops containers with neither title nor url and omits empty meta', () => {
    const bare = el('LI', ['class', 'res'], [el('SPAN', [], [txt('x')])])
    const out = extractFromDom(doc(bare), { container: extractor.container, title: { tag: 'H2' }, link: { tag: 'A', attr: 'href' } })
    expect(out).toEqual([])
    const withTitle = extractFromDom(doc(item('res', 'T', '/u', 's')), { container: extractor.container, title: { tag: 'H2' } })
    expect(withTitle[0].meta).toBeUndefined()
    expect(withTitle[0].url).toBe('')
  })

  it('falls back to the whole document and its text when no container is configured', () => {
    const out = extractFromDom(doc(el('P', [], [txt('hello'), el('STYLE', [], [txt('x{}')]), txt('world')])), {})
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('hello world')
  })

  it('does not match when a required attribute is absent or a string attr differs', () => {
    const noAttr = el('LI', [], [el('H2', [], [txt('T')])])
    expect(extractFromDom(doc(noAttr), extractor)).toEqual([])
    const wrong = el('LI', ['class', 'res'], [el('H2', [], [txt('T')])])
    expect(extractFromDom(doc(wrong), { container: { tag: 'LI', attrs: { class: 'exact' } }, title: { tag: 'H2' } })).toEqual([])
  })

  it('applies text patterns to tags and the wildcard tag', () => {
    const root = doc(el('DIV', [], [el('B', [], [txt('keep me')]), el('B', [], [txt('drop')])]))
    const out = extractFromDom(root, { container: { tag: '*', text: /keep/ }, title: { tag: 'B', text: /keep/ } })
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].title).toBe('keep me')
  })
})

/** Structural extraction is only reachable through walkDomTree (extractFromDom is pattern mode). */
const walkStructural = (tree: N) => {
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'DOM.getDocument') return { root: params['depth'] === -1 ? tree : { nodeId: 1, nodeType: 9, nodeName: '#document' } }
    if (method === 'DOM.querySelector') return { nodeId: 42 }
    return {}
  })
  return walkDomTree({ send } as never, { navigateUrl: 'https://s.test/', waitFor: '#r', timeoutMs: 1_000 }, { structural: true })
}

describe('8468f7b1 AC2 [tests-unit-extract.1] walkDomTree (structural mode)', () => {
  it('finds a[jsname] results with heading titles, snippets and normalised urls', async () => {
    const root = doc(
      result('https://one.test/', 'Result One'),
      result('//two.test/x', 'Result Two', 'Another long enough descriptive text block sitting next to result two.'),
    )
    const out = await walkStructural(root)
    expect(out.map((r) => r.title)).toEqual(['Result One', 'Result Two'])
    expect(out[1].url).toBe('https://two.test/x')
    expect(out[0].snippet).toBe(SNIPPET)
  })

  it('de-duplicates by href', async () => {
    const out = await walkStructural(doc(result('https://dup.test/', 'A'), result('https://dup.test/', 'B')))
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('A')
  })

  it('rejects anchors without jsname/href or without the div>div shape', async () => {
    const noJs = el('A', ['href', 'https://x.test/'], [el('DIV', [], [el('DIV', [], [el('H3', [], [txt('t')])])])])
    const twoKids = el('A', ['jsname', 'a', 'href', 'https://y.test/'], [
      el('DIV', [], [el('DIV', [], [txt('title')]), el('DIV', [], [txt('crumb')])]),
    ])
    const noKids = el('A', ['jsname', 'a', 'href', 'https://z.test/'])
    expect(await walkStructural(doc(el('DIV', [], [noJs, twoKids, noKids])))).toEqual([])
  })

  it('falls back to the shortest text chunk when there is no heading', async () => {
    const anchor = el('A', ['jsname', 'a', 'href', 'https://nh.test/'], [
      el('DIV', [], [el('DIV', [], [el('SPAN', [], [txt('Short')]), el('SPAN', [], [txt('a much longer breadcrumb')])])]),
    ])
    const out = await walkStructural(doc(el('DIV', [], [anchor, el('DIV'), el('DIV')])))
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Short a much longer breadcrumb')
  })

  it('skips results with no recoverable title', async () => {
    const anchor = el('A', ['jsname', 'a', 'href', 'https://empty.test/'], [el('DIV', [], [el('DIV')])])
    expect(await walkStructural(doc(anchor))).toEqual([])
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1][tests-unit-extract.3] walkDomTree', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const makeSession = (handlers: Record<string, (p: Record<string, unknown>) => unknown>) => {
    const send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      const h = handlers[method]
      if (!h) return {}
      return h(params)
    })
    return { send }
  }
  const opts = { navigateUrl: 'https://search.test/?q=a', waitFor: '#res', timeoutMs: 5_000 }

  it('navigates, waits for the selector and extracts from the full tree', async () => {
    const tree = doc(result('https://hit.test/', 'Hit'))
    const session = makeSession({
      'DOM.getDocument': (p) => (p['depth'] === -1 ? { root: tree } : { root: { nodeId: 1, nodeType: 9, nodeName: '#document' } }),
      'DOM.querySelector': () => ({ nodeId: 42 }),
      'Page.loadEventFired': () => {
        throw new Error('no event')
      },
    })
    const out = await walkDomTree(session as never, opts, { structural: true })
    expect(out[0].title).toBe('Hit')
    const methods = session.send.mock.calls.map((c) => c[0])
    expect(methods.slice(0, 2)).toEqual(['Page.enable', 'Page.navigate'])
    expect(session.send).toHaveBeenCalledWith('Page.navigate', { url: opts.navigateUrl })
    expect(methods).not.toContain('Runtime.evaluate')
  })

  it('throws a timeout naming the selector and last error when it never appears', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const session = makeSession({
      'DOM.getDocument': () => ({ root: { nodeId: 1, nodeType: 9, nodeName: '#document' } }),
      'DOM.querySelector': () => {
        throw new Error('selector failed')
      },
    })
    const p = walkDomTree(session as never, { ...opts, timeoutMs: 2_000 }, {})
    const assertion = expect(p).rejects.toThrow(/Timed out waiting for "#res" \(2000ms\)\. Last error: selector failed/)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] detectBanInPage', () => {
  it('reports captcha when a ban selector resolves to a real node', async () => {
    const send = vi.fn(async (_m: string, p: Record<string, unknown>) => ({ nodeId: p['selector'] === '#captcha' ? 9 : 0 }))
    await expect(detectBanInPage({ send } as never, 1)).resolves.toBe('captcha')
  })

  it('returns null when nothing matches or queries throw', async () => {
    const none = vi.fn(async () => ({ nodeId: 0 }))
    expect(await detectBanInPage({ send: none } as never, 1)).toBeNull()
    const boom = vi.fn(async () => {
      throw new Error('gone')
    })
    expect(await detectBanInPage({ send: boom } as never, 1)).toBeNull()
    expect(boom).toHaveBeenCalledTimes(6)
  })

  it('ignores a hit that is the document node itself', async () => {
    const same = vi.fn(async () => ({ nodeId: 1 }))
    expect(await detectBanInPage({ send: same } as never, 1)).toBeNull()
  })
})
