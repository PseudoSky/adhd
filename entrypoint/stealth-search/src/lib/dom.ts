/**
 * @adhd/stealth-search — src/lib/dom.ts
 *
 * The DOM tree strategy: walk the page through the CDP DOM domain (`DOM.getDocument`,
 * `DOM.querySelector`, `DOM.getOuterHTML`) and extract results with pattern or structural
 * extraction. No `Runtime.evaluate`, no script injection. Browser access is only a page session
 * shaped like the core's `cdp.CdpSession`.
 *
 * Contents:
 *   - `domSearch`            navigate, ban-check, wait for the selector, walk, extract
 *   - `waitForSelector`      polls with jittered 600-1800 ms retries, raises SELECTOR_TIMEOUT when exhausted
 *   - `extractFromDom`       pattern extractor (container / title / link / snippet / extra patterns)
 *   - `extractGoogleSerp`    structural Google result-page (SERP) walker: class-independent, keyed on the
 *                            `a[jsname] > div > div` result-title anchor. A search feature owned here, not
 *                            by the core (backlog 406a4e66).
 *   - ban checks             `detectBanInPage` (selector probes plus the provider's own ban rules over the
 *                            serialized DOM) and `checkPageUrlForBan` (redirect to a login or challenge URL)
 *
 * Every time source (sleep, clock, random) is an injected `EngineClock`, so the unit lane runs the whole
 * strategy with a virtual clock.
 *
 * Inventory rows: I-25 (DOM extraction, ban checks, selector wait with jittered 600-1800 ms retry),
 * I-25.a (Google SERP walker, search-owned).
 * Ticket 8468f7b1 · plan state search-port-engine · backlog 406a4e66.
 */
import { capture, type cdp } from '@adhd/stealth-core-browser'
import type { BanSignal, DomExtractor, DomPattern } from '@adhd/stealth-core-browser'
import { isSearchError, searchError } from '../errors.js'
import type { ProviderConfig, SearchResponse, SearchResult } from './types.js'

/** Lower bound of the jittered pause between selector polls (and after load), in ms. */
export const JITTER_MIN_MS = 600
/** Upper bound of the jittered pause between selector polls (and after load), in ms. */
export const JITTER_MAX_MS = 1800

/** The time sources of the engine. Production uses real timers; the unit lane injects a virtual clock. */
export interface EngineClock {
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** A number in [0, 1). */
  random: () => number
}

/** The real clock. */
export function defaultClock(): EngineClock {
  return {
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: () => Math.random(),
  }
}

/** The slice of the core's `cdp.CdpSession` the DOM strategy uses. */
export type DomSession = Pick<InstanceType<typeof cdp.CdpSession>, 'send'>

/** The collaborators of the DOM strategy beyond the page session. */
export interface DomDeps extends EngineClock {
  checkBans: (rules: ProviderConfig['bans'], ctx: { url: string; status: number; body: string }) => BanSignal | null
}

/** The production dependencies: the core's `capture.checkBans` and the real clock. */
export function defaultDomDeps(): DomDeps {
  return { ...defaultClock(), checkBans: (rules, ctx) => capture.checkBans(rules, ctx) }
}

/** A pause drawn from [JITTER_MIN_MS, JITTER_MAX_MS]. */
export function jitterMs(random: () => number): number {
  return Math.round(JITTER_MIN_MS + random() * (JITTER_MAX_MS - JITTER_MIN_MS))
}

/** A CDP DOM node. */
export interface DomNode {
  nodeId: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  attributes?: string[]
  children?: DomNode[]
}

// ─── The strategy ─────────────────────────────────────────────────────────────

function failure(provider: ProviderConfig, query: string, startedAt: number, deps: DomDeps, outcome: 'error' | 'timeout', error: string): SearchResponse {
  return { provider: provider.id, query, count: 0, results: [], outcome, error, tookMs: deps.now() - startedAt, attempts: 1, strategy: 'dom' }
}

function hitlResponse(provider: ProviderConfig, query: string, startedAt: number, deps: DomDeps, signal: BanSignal, pageUrl: string): SearchResponse {
  return {
    provider: provider.id,
    query,
    count: 0,
    results: [],
    outcome: 'hitl',
    error: `Challenge detected: ${signal} — solve in browser to continue`,
    tookMs: deps.now() - startedAt,
    attempts: 1,
    strategy: 'dom',
    hitl: { pageUrl, reason: signal, provider: provider.id, query, trippedAt: new Date(deps.now()).toISOString(), strategy: 'dom' },
  }
}

/**
 * Run a search with the DOM tree strategy.
 *
 * 1. navigate to the search URL and pause for the page to render (jittered)
 * 2. check the landing URL against the provider's URL ban rules (redirect to a login or CAPTCHA page)
 * 3. wait for the result selector (`waitForSelector`)
 * 4. check the rendered DOM for ban markers
 * 5. fetch the full DOM tree and extract with the structural or the pattern extractor
 *
 * Returns outcomes as data: `hitl` for a challenge, `timeout` when the selector never appears
 * (SELECTOR_TIMEOUT), `error` for any other page failure, `success` / `empty` otherwise.
 */
export async function domSearch(
  pageSession: DomSession,
  provider: ProviderConfig,
  query: string,
  timeoutMs: number,
  overrides: Partial<DomDeps> = {},
): Promise<SearchResponse> {
  const deps: DomDeps = { ...defaultDomDeps(), ...overrides }
  const startedAt = deps.now()
  const searchUrl = provider.url(query)
  const domCfg = provider.dom

  if (!domCfg) return failure(provider, query, startedAt, deps, 'error', 'No DOM config for provider')

  try {
    // Navigate. The page is given a jittered moment to render: the selector poll below is the real
    // readiness signal, so no load-event command is awaited here.
    await pageSession.send('Page.enable')
    await pageSession.send('Page.navigate', { url: searchUrl })
    await deps.sleep(jitterMs(deps.random))

    // A ban redirect (login page, CAPTCHA) shows in the URL before any selector exists.
    const urlBan = await checkPageUrlForBan(pageSession, provider, searchUrl)
    if (urlBan) return hitlResponse(provider, query, startedAt, deps, urlBan, searchUrl)

    const doc0 = await pageSession.send<{ root: DomNode }>('DOM.getDocument', { depth: 0 })
    const docNodeId = doc0.root.nodeId
    await waitForSelector(pageSession, docNodeId, domCfg.waitFor, timeoutMs, deps)

    const pageBan = await detectBanInPage(pageSession, docNodeId, provider, deps)
    if (pageBan) return hitlResponse(provider, query, startedAt, deps, pageBan, searchUrl)

    const full = await pageSession.send<{ root: DomNode }>('DOM.getDocument', { depth: -1 })
    const results = domCfg.structural ? extractGoogleSerp(full.root) : extractFromDom(full.root, domCfg.extract, provider.network?.fields?.urlTemplate)

    return {
      provider: provider.id,
      query,
      count: results.length,
      results,
      outcome: results.length > 0 ? 'success' : 'empty',
      tookMs: deps.now() - startedAt,
      attempts: 1,
      strategy: 'dom',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isSearchError(err, 'SELECTOR_TIMEOUT')) return failure(provider, query, startedAt, deps, 'timeout', `SELECTOR_TIMEOUT: ${message}`)
    return failure(provider, query, startedAt, deps, 'error', message)
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

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

function matches(node: DomNode, pattern: DomPattern): boolean {
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
    if (!pattern.text.test(getText(node))) return false
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
  if (pattern.attr) return getAttr(el, pattern.attr) ?? ''
  return getText(el)
}

function findContainers(node: DomNode, pattern: DomPattern): DomNode[] {
  const results: DomNode[] = []
  const walk = (n: DomNode): void => {
    if (matches(n, pattern)) {
      results.push(n)
      return
    }
    if (n.children) for (const child of n.children) walk(child)
  }
  walk(node)
  return results
}

/** Unwrap tracking redirects (DuckDuckGo `uddg`, a Google `q=` redirect) and protocol-relative URLs. */
function normalizeUrl(raw: string): string {
  const ddgMatch = raw.match(/[?&]uddg=([^&]+)/)
  if (ddgMatch) return decodeURIComponent(ddgMatch[1])
  const googleMatch = raw.match(/[?&]q=([^&]+)/)
  if (googleMatch && !raw.startsWith('http')) return decodeURIComponent(googleMatch[1])
  if (raw.startsWith('//')) return `https:${raw}`
  // Google's newer SERP encrypted redirect.
  if (raw.startsWith('/goto?url=')) return `https://www.google.com${raw}`
  return raw
}

// ─── Pattern extractor ────────────────────────────────────────────────────────

/**
 * Pattern extraction: find every container matching `extract.container`, then read the title, link,
 * snippet and `extra` fields from the first descendant (depth 4) matching each pattern. A result with
 * neither a title nor a URL is dropped.
 */
export function extractFromDom(domRoot: DomNode, extract: DomExtractor, urlTemplate?: string): SearchResult[] {
  if (!extract.container || !extract.title || !extract.link || !extract.snippet) return []
  const containers = findContainers(domRoot, extract.container)
  const results: SearchResult[] = []

  for (const c of containers) {
    const title = extractValue(c, extract.title)
    const rawUrl = extractValue(c, extract.link)
    const url = normalizeUrl(urlTemplate ? urlTemplate.replace('{}', rawUrl) : rawUrl)
    const snippet = extractValue(c, extract.snippet)

    if (!title && !url) continue

    const meta: Record<string, string> = {}
    if (extract.extra) {
      for (const [key, pattern] of Object.entries(extract.extra)) {
        const val = extractValue(c, pattern)
        if (val) meta[key] = val
      }
    }

    results.push({ title, url, snippet, meta: Object.keys(meta).length > 0 ? meta : undefined })
  }

  return results
}

// ─── Google SERP walker (structural, class-independent) ──────────────────────

/**
 * Extract results from a Google result page by structural position, never by class name. Finds
 * `a[jsname][href]` anchors matching the `a > div > div` pattern (the stable structural marker of a
 * result title), reads the heading as the title, walks the parent chain to the result card and takes
 * the longest descriptive text in the card as the snippet. Duplicate URLs are dropped.
 */
export function extractGoogleSerp(domRoot: DomNode): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  // CDP DOM nodes carry no parent pointers, so the parent chain rides along on the stack.
  const candidates: Array<{ node: DomNode; parentChain: DomNode[] }> = []
  const stack: Array<{ node: DomNode; parentChain: DomNode[] }> = [{ node: domRoot, parentChain: [] }]

  while (stack.length > 0) {
    const { node, parentChain } = stack.pop() as { node: DomNode; parentChain: DomNode[] }
    if (node.nodeName === 'A' && getAttr(node, 'jsname') && getAttr(node, 'href')) candidates.push({ node, parentChain })
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], parentChain: [...parentChain, node] })
      }
    }
  }

  for (const { node, parentChain } of candidates) {
    if (!hasDivDiv(node)) continue

    const url = getAttr(node, 'href') ?? ''
    if (!url || seen.has(url)) continue
    seen.add(url)

    // The breadcrumb lives inside the same anchor, so the heading is read specifically.
    let title = findHeadingText(node)
    if (!title) {
      // No heading: take the shortest text chunk (breadcrumbs hold URL paths, headings do not).
      const allText = getText(node)
      const chunks = allText.split(/\s{2,}|•|\|/).map((s) => s.trim()).filter(Boolean)
      chunks.sort((a, b) => a.length - b.length)
      title = chunks[0] ?? allText
    }
    if (!title) continue

    const container = findContainer(parentChain)
    const snippet = container ? findSnippet(container, title) : ''
    results.push({ title, url: normalizeUrl(url), snippet })
  }

  return results
}

/** The text of the first heading (H2/H3) inside a node. */
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

/**
 * True for the real-result `a > div > div` shape: the wrapper div has exactly one child and it is a div.
 * Non-result links (video timestamps, knowledge panels) carry two or more children in the wrapper.
 */
function hasDivDiv(node: DomNode): boolean {
  if (!node.children) return false
  const wrapper = node.children.find((c) => c.nodeName === 'DIV')
  if (!wrapper?.children) return false
  return wrapper.children.length === 1 && wrapper.children[0].nodeName === 'DIV'
}

/** The result card: the nearest ancestor div with at least 3 children and over 50 characters of text, else 4 levels up. */
function findContainer(parentChain: DomNode[]): DomNode | null {
  for (let i = parentChain.length - 1; i >= 0; i--) {
    const p = parentChain[i]
    if (p.nodeName === 'DIV' && p.children && p.children.length >= 3 && getText(p).length > 50) return p
  }
  return parentChain[Math.max(0, parentChain.length - 4)] ?? null
}

/** The longest descriptive text (over 40 characters) in a card that is not the title. */
function findSnippet(container: DomNode, title: string): string {
  const texts: string[] = []
  const walk = (n: DomNode): void => {
    if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE') return
    const t = getText(n)
    if (t.length > 40 && !t.includes(title) && !title.includes(t)) texts.push(t)
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(container)
  texts.sort((a, b) => b.length - a.length)
  return texts[0] ?? ''
}

// ─── Wait for selector (poll DOM.querySelector, no JS injection) ──────────────

/**
 * Poll `DOM.querySelector` until `selector` matches below the document, pausing a jittered
 * 600-1800 ms between polls. Raises StealthSearchError SELECTOR_TIMEOUT (with the selector,
 * the timeout and the last CDP error in `detail`) when `timeoutMs` elapses first.
 */
export async function waitForSelector(
  session: DomSession,
  docNodeId: number,
  selector: string,
  timeoutMs: number,
  overrides: Partial<EngineClock> = {},
): Promise<void> {
  const clock: EngineClock = { ...defaultClock(), ...overrides }
  const deadline = clock.now() + timeoutMs
  let lastError = ''
  while (clock.now() < deadline) {
    try {
      const result = await session.send<{ nodeId: number }>('DOM.querySelector', { nodeId: docNodeId, selector })
      if (result && result.nodeId > 0 && result.nodeId !== docNodeId) return
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await clock.sleep(jitterMs(clock.random))
  }
  throw searchError('SELECTOR_TIMEOUT', `Timed out waiting for "${selector}" (${timeoutMs}ms). Last error: ${lastError || 'none'}`, {
    detail: { selector, timeoutMs, lastError },
  })
}

// ─── Ban checks ───────────────────────────────────────────────────────────────

const BAN_SELECTORS = ['.g-recaptcha', '#captcha', '.captcha', '[class*="captcha"]', '[class*="challenge"]', '#challenge-running']

/**
 * Detect a challenge in the rendered page: first the common CAPTCHA selectors (signal `captcha`), then
 * the provider's own ban rules over the serialized DOM (`DOM.getOuterHTML`) and the current URL.
 * Best effort: a CDP failure on a probe means "not found".
 */
export async function detectBanInPage(session: DomSession, docNodeId: number, provider: Pick<ProviderConfig, 'bans'>, overrides: Partial<DomDeps> = {}): Promise<BanSignal | null> {
  const deps: DomDeps = { ...defaultDomDeps(), ...overrides }

  for (const selector of BAN_SELECTORS) {
    try {
      const result = await session.send<{ nodeId: number }>('DOM.querySelector', { nodeId: docNodeId, selector })
      if (result && result.nodeId > 0 && result.nodeId !== docNodeId) return 'captcha'
    } catch {
      /* not found */
    }
  }

  try {
    const { outerHTML } = await session.send<{ outerHTML: string }>('DOM.getOuterHTML', { nodeId: docNodeId })
    const history = await session
      .send<{ currentIndex: number; entries: Array<{ url: string }> }>('Page.getNavigationHistory')
      .catch(() => ({ currentIndex: 0, entries: [] as Array<{ url: string }> }))
    const currentUrl = history?.entries?.[history.currentIndex]?.url ?? ''
    if (currentUrl || outerHTML) {
      const ban = deps.checkBans(provider.bans, { url: currentUrl, status: 200, body: outerHTML })
      if (ban) return ban
    }
  } catch {
    /* best effort */
  }

  return null
}

/**
 * The ban signal of a URL rule matching the page's current URL (login redirect, CAPTCHA redirect), or
 * null. Reads the real URL after redirects from `Page.getNavigationHistory`.
 */
export async function checkPageUrlForBan(session: DomSession, provider: Pick<ProviderConfig, 'bans'>, searchUrl: string): Promise<BanSignal | null> {
  try {
    const history = await session.send<{ currentIndex: number; entries: Array<{ url: string }> }>('Page.getNavigationHistory')
    const currentUrl = history?.entries?.[history.currentIndex]?.url ?? searchUrl
    for (const ban of provider.bans) {
      if (ban.checkUrl?.test(currentUrl)) return ban.signal
    }
  } catch {
    /* best effort */
  }
  return null
}
