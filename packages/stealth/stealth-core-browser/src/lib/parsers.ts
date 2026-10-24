/**
 * stealth-core-browser/src/lib/parsers.ts — Server-side parsers for extraction responses.
 *
 * For HTML:
 *   xpath-based:   @xmldom/xmldom + xpath — no JS injection, pure server-side.
 *   class-based:   match elements by tag+class patterns (legacy).
 *   structural:    find results by structural markers (legacy).
 *
 * For JSON — dot-path selectors.
 * No JS injection — all parsing is server-side.
 *
 * The class-based regex parsers are the legacy extraction path; extractWithXpath()
 * (@xmldom/xmldom + xpath) is the preferred one.
 */

import type { ParseResult, CaptureConfig } from './types.js'
import { normalizeUrl } from './redirect-url.js'
import type { HTMLElement } from 'node-html-parser';
import { parse } from 'node-html-parser'

// ═══════════════════════════════════════════════════════════════════════════════
// XPath — Preferred. Uses @xmldom/xmldom + xpath library for extraction.
// No JS injection, no CDP DOM dependency, pure server-side parsing.
// ═══════════════════════════════════════════════════════════════════════════════

import { DOMParser } from '@xmldom/xmldom'
import * as xpath from 'xpath'

export function extractWithXpath(body: string): ParseResult[] {
  // @xmldom throws on malformed HTML (which Google's always is).
  // onError: suppress to handle gracefully.
  let doc: ReturnType<DOMParser['parseFromString']>
  try {
    doc = new DOMParser({ onError: () => undefined }).parseFromString(body, 'text/html')
  } catch {
    return []
  }

  // Find a[jsname] elements with the > div > div structure that identifies
  // real search results (not sidebar links, video timestamps, etc.)
  const expr = "//*[local-name()='a' and @jsname][./*[local-name()='div']/*[local-name()='div']]"
  const selected = xpath.select(expr, doc as unknown as Node)
  const nodes = Array.isArray(selected) ? (selected as Element[]) : []

  const results: ParseResult[] = []
  const seen = new Set<string>()

  for (const a of nodes) {
    const url = a.getAttribute('href') ?? ''
    if (!url || seen.has(url)) continue

    // Title: find heading text inside the anchor
    const hExpr = ".//*[local-name()='h2' or local-name()='h3']/text()"
    const hText = (xpath.select(hExpr, a) as Text[]).map(t => t.data).join('').trim()
    if (!hText) continue
    const title = hText.replace(/\s+/g, ' ')

    seen.add(url)

    // Snippet: walk up to the result card, find descriptive text not inside the anchor.
    // Uses element.textContent (concatenates all child text) rather than individual
    // text() nodes which Google fragments across multiple adjacent nodes.
    let snippet = ''
    let container: Node | null = a.parentNode
    let depth = 0
    while (container?.nodeType === 1 && depth < 6) {
      depth++
      const el = container as Element
      if ((el.childNodes?.length ?? 0) >= 3) {
        // Find all div descendants with substantive text, excluding those inside a[jsname]
        const textContainers = xpath.select(
          ".//*[local-name()='div' and string-length(normalize-space())>60 and not(.//*[local-name()='a'][@jsname])]",
          container,
        ) as Element[]
        // Also check direct children of the container (Google's snippet is often
        // a direct sibling of the a's parent, not wrapped in a deeper div)
        for (const tc of textContainers) {
          const text = tc.textContent.replace(/\s+/g, ' ').trim()
          if (text.length > 60 && !text.includes(title) && !text.includes('http')) {
            snippet = text
            break
          }
        }
        if (snippet) break
      }
      container = container.parentNode
    }
    // Fallback: if no div container found, try any text > 60 chars in the parent chain
    if (!snippet) {
      let p: Node | null = a.parentNode
      while (p?.nodeType === 1) {
        const text = (p as Element).textContent.replace(/\s+/g, ' ').trim()
        const aText = a.textContent.replace(/\s+/g, ' ').trim()
        const remaining = text.replace(aText, '').trim()
        if (remaining.length > 60) {
          snippet = remaining
          break
        }
        p = p.parentNode
      }
    }

    results.push({ title, url: normalizeUrl(url), snippet })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON
// ═══════════════════════════════════════════════════════════════════════════════

export function extractResultsFromJson(body: string, capture: CaptureConfig): ParseResult[] {
  let data: unknown
  try { data = JSON.parse(body) } catch { return [] }
  const items = resolvePath(data, capture.resultSelector)
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    let url = String(resolvePath(item, capture.fields.url) ?? '')
    if (capture.fields.urlTemplate) {
      url = capture.fields.urlTemplate.replace('{}', url)
    }
    return {
      title: String(resolvePath(item, capture.fields.title) ?? ''),
      url: normalizeUrl(url),
      snippet: String(resolvePath(item, capture.fields.snippet) ?? ''),
      meta: capture.fields.meta ? extractMeta(item, capture.fields.meta) : undefined,
    }
  })
}

/** Extract JSON embedded in a <script type="application/json"> tag within HTML.
 *  Used by sites like GitHub that embed API data in the initial HTML response.
 *  The `dataTarget` config field specifies which `data-target` attribute to match.
 *  Supports special fields:
 *    - `_snippet` — extracts first line from the `snippets[0].lines` array
 *    - Fields starting with `_url_` — constructs a GitHub blob URL from repo_nwo/ref_name/path */
export function extractResultsFromEmbeddedJson(body: string, capture: CaptureConfig): ParseResult[] {
  const dataTarget = capture.dataTarget ?? 'react-app.embeddedData'
  const payload = findEmbeddedJsonScript(body, dataTarget)
  if (payload === null) return []

  let data: unknown
  try { data = JSON.parse(payload) } catch { return [] }

  const items = resolvePath(data, capture.resultSelector)
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    const itemObj = item as Record<string, unknown>

    // Snippet: extract lines from snippets[0].lines, stripped of HTML
    let snippet = ''
    const snippets = resolvePath(itemObj, 'snippets') as Array<{ lines?: string[] }> | undefined
    const maxLines = capture.snippetLines ?? 1
    if (Array.isArray(snippets) && snippets[0]?.lines?.length) {
      snippet = snippets[0].lines.slice(0, maxLines)
        .map((l) => cleanText(l))
        .filter(Boolean)
        .join(' ')
        .slice(0, 500)
    }

    // URL: construct GitHub blob URL from repo_nwo + ref_name + path
    const repo = String(resolvePath(itemObj, 'repo_nwo') ?? '')
    const ref = String(resolvePath(itemObj, 'ref_name') ?? '').replace('refs/heads/', '')
    const path = String(resolvePath(itemObj, 'path') ?? '')
    let url = repo && ref && path ? `https://github.com/${repo}/blob/${ref}/${path}` : renderField(itemObj, capture.fields.url)
    if (capture.fields.urlTemplate) {
      url = capture.fields.urlTemplate.replace('{}', url)
    }

    // Titles and snippets may carry search highlight markup (e.g. "vitejs/<em>vite</em>").
    return {
      title: cleanText(renderField(itemObj, capture.fields.title)),
      url: normalizeUrl(url),
      snippet: snippet || cleanText(renderField(itemObj, capture.fields.snippet)),
      meta: capture.fields.meta ? extractMeta(itemObj, capture.fields.meta) : undefined,
    }
  })
}

/**
 * The text of the first `<script type="application/json" data-target="<dataTarget>">` element. Attributes are read
 * individually, so their order, spacing and quote style (`"` or `'`) do not matter.
 */
function findEmbeddedJsonScript(body: string, dataTarget: string): string | null {
  const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  for (let m = scriptTag.exec(body); m !== null; m = scriptTag.exec(body)) {
    const attrs = new Map<string, string>()
    for (const a of (m[1] ?? '').matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set((a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '')
    }
    if (attrs.get('type')?.toLowerCase() === 'application/json' && attrs.get('data-target') === dataTarget) return m[2] ?? ''
  }
  return null
}

function extractMeta(item: unknown, metaConfig: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, path] of Object.entries(metaConfig)) {
    result[key] = String(resolvePath(item, path) ?? '')
  }
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML — structural (Google, class-name-independent)
// ═══════════════════════════════════════════════════════════════════════════════

/** Structural (class-name-independent) Google-SERP extraction; extractWithXpath() is the preferred path. */
export function extractStructural(body: string, capture: CaptureConfig): ParseResult[] {
  const doc = parse(body)
  const results: ParseResult[] = []
  const seen = new Set<string>()

  const links = doc.querySelectorAll('a[jsname]').filter((link) => {
    const firstChild = link.firstChild
    if (firstChild?.nodeType !== 1 || (firstChild as HTMLElement).tagName !== 'DIV') return false
    const childDiv = firstChild as HTMLElement
    return childDiv.querySelector('div') !== null
  })

  for (const link of links) {
    const childDiv = link.firstChild as HTMLElement
    const innerDiv = childDiv.querySelector('div')
    const title = (innerDiv ?? link).textContent.trim()
    const url = normalizeUrl(applyUrlTemplate(link.getAttribute('href') ?? '', capture))
    if (!title || !url || seen.has(url)) continue
    seen.add(url)

    let container: HTMLElement | null = link.parentNode
    while (container) {
      const text = container.textContent.trim()
      if (container.tagName === 'DIV' && text.length > 50 && container.childNodes.length >= 3) {
        break
      }
      container = container.parentNode
    }

    let snippet = ''
    if (container) {
      const allText = container.querySelectorAll('div, span, p')
      const textBlocks: string[] = []
      for (const el of allText) {
        const t = el.textContent.trim()
        if (t.length > 30 && !t.includes(title)) {
          textBlocks.push(t)
        }
      }
      textBlocks.sort((a, b) => a.length - b.length)
      snippet = textBlocks[0] ?? ''
    }

    results.push({ title, url, snippet })
  }

  return results
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML — class-based
// ═══════════════════════════════════════════════════════════════════════════════

export function extractResultsFromHtml(body: string, capture: CaptureConfig): ParseResult[] {
  const titlePattern = capture.fields.title
  const snippetPattern = capture.fields.snippet

  const titleM = titlePattern.match(/^(\w+)(?:\.(.+))?$/)
  if (!titleM) return []
  const [, titleTag, titleClass] = titleM
  const classRe = titleClass ? `class="[^"]*${escapeRe(titleClass)}[^"]*"` : ''

  // Pass 1: href on same element  (e.g. <a class="result__a" href="...">)
  const reSelf = new RegExp(
    `<${titleTag}[^>]*${classRe}[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, 'gi',
  )
  // Pass 2: href on child <a>  (e.g. <p class="title"><a href="...">)
  const reChild = new RegExp(
    `<${titleTag}[^>]*${classRe}[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, 'gi',
  )

  const results: ParseResult[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  // Each card's snippet is looked up between its own title element and the START of the next title
  // element (`cardEnd`), so a card without a snippet of its own never takes the next card's.
  const selfMatches = [...body.matchAll(reSelf)]
  selfMatches.forEach((m, i) => {
    const url = normalizeUrl(applyUrlTemplate(m[1], capture))
    const title = stripHtml(m[2]).trim().replace(/\s+/g, ' ')
    if (!title || seen.has(url)) return
    seen.add(url)
    const snippet = extractSnippet(body, m.index, snippetPattern, cardEnd(selfMatches, i, body))
    results.push({ title, url, snippet })
  })

  const childMatches = [...body.matchAll(reChild)]
  childMatches.forEach((m, i) => {
    const inner = m[1]
    const title = stripHtml(inner).trim().replace(/\s+/g, ' ')
    const aHref = inner.match(/<a[^>]*href="([^"]*)"[^>]*>/i)
    const url = aHref ? normalizeUrl(applyUrlTemplate(aHref[1], capture)) : ''
    if (!title || !url || seen.has(url)) return
    seen.add(url)
    const snippet = extractSnippet(body, m.index, snippetPattern, cardEnd(childMatches, i, body))
    results.push({ title, url, snippet })
  })

  // Pass 2.5: wrapper anchor — the URL element (`fields.url`) ENCLOSES the title
  // element (e.g. pypi: `<a class="package-snippet" href="/project/x/"> …
  // <span class="package-snippet__name">x</span> … </a>`). Passes 1/2 look for
  // the href on/inside the TITLE element; pass 3 pairs a title with the nearest
  // href AFTER it — so a wrapper anchor makes pass 3 pair every title with the
  // NEXT result's href (an off-by-one that shipped: pypi returned title
  // "requests" -> url "/project/selenium-requests/"). Match the URL element and
  // pull the title from INSIDE it. Only consulted when passes 1/2 found nothing.
  if (results.length === 0 && titlePattern !== capture.fields.url) {
    const linkPattern = capture.fields.linkSelector ?? capture.fields.url
    const linkM = linkPattern.match(/^(\w+)(?:\.(.+))?$/)
    if (linkM) {
      const [, linkTag, linkClass] = linkM
      const lcRe = linkClass ? `class="[^"]*${escapeRe(linkClass)}[^"]*"` : ''
      const wrapRe = new RegExp(`<${linkTag}[^>]*${lcRe}[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/${linkTag}>`, 'gi')
      const wrapMatches = [...body.matchAll(wrapRe)]
      wrapMatches.forEach((m, i) => {
        const url = normalizeUrl(applyUrlTemplate(m[1], capture))
        const titleInner = m[2].match(new RegExp(`<${titleTag}[^>]*${classRe}[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, 'i'))
        const title = titleInner ? stripHtml(titleInner[1]).trim().replace(/\s+/g, ' ') : ''
        if (!title || !url || seen.has(url)) return
        seen.add(url)
        const snippet = extractSnippet(body, m.index, snippetPattern, cardEnd(wrapMatches, i, body))
        results.push({ title, url, snippet })
      })
    }
  }

  // Pass 3: title and link on separate elements (Google h3-style pairing)
  if (results.length === 0 && titlePattern !== capture.fields.url) {
    const linkPattern = capture.fields.linkSelector ?? capture.fields.url
    const linkM = linkPattern.match(/^(\w+)(?:\.(.+))?$/)
    if (linkM) {
      const [, linkTag, linkClass] = linkM
      const lcRe = linkClass ? `class="[^"]*${escapeRe(linkClass)}[^"]*"` : ''
      const hrefs: Array<{ url: string; index: number }> = []
      const hrefRe = new RegExp(`<${linkTag}[^>]*${lcRe}[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/${linkTag}>`, 'gi')
      while ((match = hrefRe.exec(body)) !== null) {
        const url = normalizeUrl(applyUrlTemplate(match[1], capture))
        if (!seen.has(url)) hrefs.push({ url, index: match.index })
      }
      const tRe = new RegExp(`<${titleTag}[^>]*${classRe}[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, 'gi')
      const titleMatches = [...body.matchAll(tRe)]
      titleMatches.forEach((m, i) => {
        const t = stripHtml(m[1]).trim().replace(/\s+/g, ' ')
        if (!t) return
        const matchIndex = m.index
        const nearest = hrefs.find((h) => h.index > matchIndex)
        if (!nearest || seen.has(nearest.url)) return
        seen.add(nearest.url)
        const snippet = extractSnippet(body, m.index, snippetPattern, cardEnd(titleMatches, i, body))
        results.push({ title: t, url: nearest.url, snippet })
      })
    }
  }

  return results
}

/** Longest stretch after a title element in which its snippet is looked for. */
const SNIPPET_WINDOW = 5000

/** Where the card of `matches[i]` ends: the start of the next title element, or the end of the body. */
function cardEnd(matches: readonly RegExpMatchArray[], i: number, body: string): number {
  return matches[i + 1]?.index ?? body.length
}

/**
 * The snippet of the card whose title element starts at `matchIndex`. The window runs forward to the
 * start of the next card (`cardEndIndex`), never past `SNIPPET_WINDOW` characters and never past the body,
 * so a card without a snippet of its own gets an empty one instead of the next card's.
 */
function extractSnippet(body: string, matchIndex: number, snippetPattern: string, cardEndIndex: number = body.length): string {
  const m = snippetPattern.match(/^(\w+)(?:\.(.+))?$/)
  if (!m) return ''
  const [, tag, cls] = m
  const ctx = body.slice(matchIndex, Math.min(body.length, cardEndIndex, matchIndex + SNIPPET_WINDOW))
  const cp = cls ? `class="[^"]*${escapeRe(cls)}[^"]*"` : ''
  const re = new RegExp(`<${tag}[^>]*${cp}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const hit = re.exec(ctx)
  return hit ? stripHtml(hit[1]).trim().replace(/\s+/g, ' ') : ''
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function stripHtml(s: string): string { return s.replace(/<[^>]*>/g, '') }

/** Strip highlight markup FIRST, then decode the entities the embedded JSON carries
 *  (so a decoded `<tools>` survives). Used for embedded-json titles and snippets only. */
function cleanText(s: string): string {
  return stripHtml(s)
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * Resolve a field spec against one item. A plain dot-path returns the value; a
 * spec containing `{path}` placeholders is interpolated (a missing path renders
 * empty), e.g. `'{repo.repository.owner_login}/{repo.repository.name}'`.
 */
function renderField(item: unknown, spec: string | undefined): string {
  if (!spec) return ''
  if (!spec.includes('{')) return String(resolvePath(item, spec) ?? '')
  return spec.replace(/\{([^{}]+)\}/g, (_, path: string) => String(resolvePath(item, path) ?? ''))
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function resolvePath(obj: unknown, path: string): unknown {
  if (path === '*') return obj
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Apply a provider's `urlTemplate` (e.g. `'https://pypi.org{}'`) to a URL the
 * page supplied — the query placeholder `{}` is replaced with the extracted
 * value. Needed whenever the page emits a RELATIVE href (`/project/x/`) or a
 * bare id (`30621`) and the parser has only the response BODY, never the page
 * URL, so it cannot absolutize on its own. Mirrors the JSON path
 * (`extractResultsFromJson` / `extractResultsFromEmbeddedJson`); applied
 * BEFORE `normalizeUrl`, matching those. No-op when the provider sets none.
 */
function applyUrlTemplate(url: string, capture: CaptureConfig): string {
  const template = capture.fields.urlTemplate
  return template ? template.replace('{}', url) : url
}

