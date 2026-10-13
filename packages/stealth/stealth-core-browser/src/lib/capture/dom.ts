/**
 * stealth-core-browser/src/lib/capture/dom.ts — CDP DOM tree walker.
 *
 * Walks the rendered DOM tree via CDP DOM.getDocument({depth:-1})
 * and extracts results using structural or pattern-based extraction.
 *
 * No runtime script evaluation — uses CDP DOM API walk only.
 *
 * This is a SERP-oriented walker: its structural mode (`extractStructuralFromDom`)
 * targets Google search-result pages (anchors carrying `jsname`, class-independent),
 * and the pattern mode walks any page against a caller-supplied DomPattern set.
 * It is kept as a feature; whether it stays part of the public surface is a product call.
 */

import type { CdpSession } from '../cdp/session.js'
import type { DomExtractor, DomPattern, ParseResult } from '../types.js'

export interface DomWalkOptions {
  navigateUrl: string
  waitFor: string
  timeoutMs: number
}

/**
 * Walk the DOM tree of a page to extract results.
 *
 * 1. Navigates to the URL
 * 2. Waits for the waitFor selector
 * 3. Gets the full DOM tree
 * 4. Walks the tree to extract results
 *
 * Ban detection is the caller's responsibility.
 */
export async function walkDomTree(
  pageSession: CdpSession,
  options: DomWalkOptions,
  extractConfig: DomExtractor,
): Promise<ParseResult[]> {
  // Navigate
  await pageSession.send('Page.enable')
  await pageSession.send('Page.navigate', { url: options.navigateUrl })

  // Wait for load
  await pageSession.send('Page.loadEventFired', {}, options.timeoutMs).catch(() => undefined)

  // Wait for result selector
  const doc0 = await pageSession.send<{ root: DomNode }>('DOM.getDocument', { depth: 0 })
  const docNodeId = doc0.root.nodeId
  await waitForSelector(pageSession, docNodeId, options.waitFor, options.timeoutMs)

  // Get full DOM tree
  const full = await pageSession.send<{ root: DomNode }>('DOM.getDocument', { depth: -1 })

  // Extract results — use structural mode if configured
  const results = extractConfig.structural
    ? extractStructuralFromDom(full.root)
    : extractFromDom(full.root, extractConfig)

  return results
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

/** A CDP DOM node. */
interface DomNode {
  nodeId: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  attributes?: string[]
  children?: DomNode[]
}

function getText(node: DomNode): string {
  if (node.nodeType === 3) return (node.nodeValue ?? '').trim()
  if (!node.children) return ''
  const parts: string[] = []
  for (const child of node.children) {
    if (child.nodeName === 'SCRIPT' || child.nodeName === 'STYLE') continue
    const t = getText(child)
    if (t) parts.push(t)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function getAttr(node: DomNode, name: string): string | undefined {
  if (!node.attributes) return undefined
  for (let i = 0; i < node.attributes.length; i += 2) {
    if (node.attributes[i] === name) return node.attributes[i + 1]
  }
  return undefined
}

function matches(node: DomNode, pattern: {
  tag?: string
  attrs?: Record<string, string | RegExp>
  text?: RegExp
}): boolean {
  if (pattern.tag && pattern.tag !== '*' && node.nodeName !== pattern.tag) return false
  if (pattern.attrs) {
    for (const [key, val] of Object.entries(pattern.attrs)) {
      const attrVal = getAttr(node, key)
      if (attrVal === undefined) return false
      if (val instanceof RegExp && !val.test(attrVal)) return false
      if (typeof val === 'string' && val !== attrVal) return false
    }
  }
  if (pattern.text) {
    const t = getText(node)
    if (!pattern.text.test(t)) return false
  }
  return true
}

function findChild(node: DomNode, pattern: DomPattern, depth = 4): DomNode | undefined {
  if (depth <= 0 || !node.children) return undefined
  for (const child of node.children) {
    if (matches(child, pattern)) return child
  }
  for (const child of node.children) {
    const found = findChild(child, pattern, depth - 1)
    if (found) return found
  }
  return undefined
}

function extractValue(container: DomNode, pattern: DomPattern & { attr?: string }): string {
  const el = findChild(container, pattern)
  if (!el) return ''
  if (pattern.attr) {
    const v = getAttr(el, pattern.attr)
    return v ?? ''
  }
  return getText(el)
}

function findContainers(node: DomNode, pattern: DomPattern): DomNode[] {
  const results: DomNode[] = []
  function walk(n: DomNode): void {
    if (matches(n, pattern)) {
      results.push(n)
      return
    }
    if (n.children) for (const child of n.children) walk(child)
  }
  walk(node)
  return results
}

function normalizeUrl(raw: string): string {
  const ddgMatch = raw.match(/[?&]uddg=([^&]+)/)
  if (ddgMatch) return decodeURIComponent(ddgMatch[1])
  const googleMatch = raw.match(/[?&]q=([^&]+)/)
  if (googleMatch && !raw.startsWith('http')) return decodeURIComponent(googleMatch[1])
  if (raw.startsWith('//')) return 'https:' + raw
  return raw
}

/**
 * Extract results from the DOM tree using structural position (no class names).
 * Finds a[jsname] elements matching the > div > div pattern (Google's stable
 * structural marker for search result titles), then walks the parent chain
 * to capture the full result section.
 */
function extractStructuralFromDom(domRoot: DomNode): ParseResult[] {
  const results: ParseResult[] = []
  const seen = new Set<string>()

  // Walk the DOM tree once with parent chain tracking.
  // CDP DOM nodes don't have parent pointers, so we pass the chain via stack.
  const candidates: Array<{ node: DomNode; parentChain: DomNode[] }> = []
  const stack: Array<{ node: DomNode; parentChain: DomNode[] }> = [
    { node: domRoot, parentChain: [] },
  ]

  while (stack.length > 0) {
    const { node, parentChain } = stack.pop()!

    // Collect a[jsname] elements that match the > div > div pattern.
    // This filters out non-result links (header/footer/sidebar)
    // because only real search results have this exact structure.
    if (
      node.nodeName === 'A' &&
      getAttr(node, 'jsname') &&
      getAttr(node, 'href')
    ) {
      candidates.push({ node, parentChain })
    }

    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({
          node: node.children[i],
          parentChain: [...parentChain, node],
        })
      }
    }
  }

  for (const { node, parentChain } of candidates) {
    // Only process elements matching a[jsname] > div > div
    // (anchors whose first child div has a child div)
    if (!hasDivDiv(node)) continue

    const url = getAttr(node, 'href') ?? ''
    if (!url || seen.has(url)) continue
    seen.add(url)

    // Title: find the heading tag (H2/H3) inside the a[jsname].
    // Google wraps the breadcrumb inside the same anchor, so we must
    // find the heading specifically rather than taking all text.
    let title = findHeadingText(node)
    if (!title) {
      // Fallback: if no heading found, use shortest text chunk from a
      // (breadcrumbs contain URL paths, headings don't)
      const allText = getText(node)
      const chunks = allText.split(/\s{2,}|•|\|/).map(s => s.trim()).filter(Boolean)
      chunks.sort((a, b) => a.length - b.length)
      title = chunks[0] ?? allText
    }
    if (!title) continue

    // Container: walk up from a[jsname] to find the result card.
    // The a[jsname] is nested 3-4 divs deep inside the card.
    // We find the container by looking for a div with substantial content.
    const container = findContainer(node, parentChain)

    // Snippet: first substantial text block in container that isn't the title
    const snippet = container ? findSnippet(container, title) : ''

    results.push({ title, url: normalizeUrl(url), snippet })
  }

  return results
}

/** Find the text of the first heading tag (H2/H3) inside a node. */
function findHeadingText(node: DomNode): string {
  if (['H2', 'H3'].includes(node.nodeName)) return getText(node)
  if (node.children) {
    for (const c of node.children) {
      const t = findHeadingText(c)
      if (t) return t
    }
  }
  return ''
}

/** Check if an a[jsname] matches the > div > div structure.
 *  Real search results have a wrapper div with exactly 1 child (the title div).
 *  Non-result links (video timestamps, knowledge panels) have 2+ children
 *  in the wrapper (title + breadcrumb). Only real results match. */
function hasDivDiv(node: DomNode): boolean {
  if (!node.children) return false
  const wrapper = node.children.find(c => c.nodeName === 'DIV')
  if (!wrapper?.children) return false
  // Real results: wrapper has exactly 1 child, and it's a div
  return wrapper.children.length === 1 && wrapper.children[0].nodeName === 'DIV'
}

/**
 * Walk up the parent chain to find the result card container.
 * Uses a structural heuristic: find the first div up the chain
 * that has ≥3 children and accumulated text > 50 chars.
 * Falls back to walking exactly 4 levels up.
 */
function findContainer(node: DomNode, parentChain: DomNode[]): DomNode | null {
  for (let i = parentChain.length - 1; i >= 0; i--) {
    const p = parentChain[i]
    if (
      p.nodeName === 'DIV' &&
      p.children &&
      p.children.length >= 3 &&
      getText(p).length > 50
    ) {
      return p
    }
  }
  return parentChain[Math.max(0, parentChain.length - 4)] ?? null
}

/** Find the best snippet in a result container: longest descriptive text
 *  that isn't the title. Prefers text > 60 chars (real descriptions)
 *  over short metadata lines. */
function findSnippet(container: DomNode, title: string): string {
  const texts: string[] = []
  function walk(n: DomNode): void {
    if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE') return
    const t = getText(n)
    if (t.length > 40 && !t.includes(title) && !title.includes(t)) {
      texts.push(t)
    }
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(container)
  texts.sort((a, b) => b.length - a.length)
  return texts[0] ?? ''
}

export function extractFromDom(
  domRoot: DomNode,
  extract: DomExtractor,
): ParseResult[] {
  const containers = extract.container ? findContainers(domRoot, extract.container) : [domRoot]
  const results: ParseResult[] = []

  for (const c of containers) {
    const title = extract.title
      ? extractValue(c, extract.title)
      : getText(c)
    const url = extract.link?.attr
      ? normalizeUrl(extractValue(c, extract.link))
      : ''
    const snippet = extract.snippet
      ? extractValue(c, extract.snippet)
      : ''

    if (!title && !url) continue

    const meta: Record<string, string> = {}
    if (extract.extra) {
      for (const [key, pattern] of Object.entries(extract.extra)) {
        const val = extractValue(c, pattern)
        if (val) meta[key] = val
      }
    }

    results.push({
      title,
      url,
      snippet,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    })
  }

  return results
}

// ─── Wait for selector (poll DOM.querySelector, no JS injection) ─────────────

async function waitForSelector(
  session: CdpSession,
  docNodeId: number,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const result = await session.send<{ nodeId: number }>('DOM.querySelector', {
        nodeId: docNodeId,
        selector,
      })
      if (result && result.nodeId > 0 && result.nodeId !== docNodeId) return
    } catch (e) {
      lastErr = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 1200))
  }
  throw new Error(`Timed out waiting for "${selector}" (${timeoutMs}ms). Last error: ${lastErr}`)
}

// ─── Simple ban detection via DOM ─────────────────────────────────────────────

export async function detectBanInPage(
  session: CdpSession,
  docNodeId: number,
): Promise<string | null> {
  // Check for common CAPTCHA/ban patterns in the DOM
  // These are broad patterns that match many providers
  const banSelectors = [
    '.g-recaptcha',
    '#captcha',
    '.captcha',
    '[class*="captcha"]',
    '[class*="challenge"]',
    '#challenge-running',
  ]

  for (const sel of banSelectors) {
    try {
      const result = await session.send<{ nodeId: number }>('DOM.querySelector', {
        nodeId: docNodeId,
        selector: sel,
      })
      if (result && result.nodeId > 0 && result.nodeId !== docNodeId) {
        return 'captcha'
      }
    } catch { /* not found */ }
  }

  return null
}
