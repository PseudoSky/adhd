/**
 * @adhd/stealth-search — src/lib/fetch/fetch.ts
 *
 * The `fetch` provider: arbitrary URL, settled cookieless render, markdown (inventory I-27, I-09).
 *
 * Pipeline: policy check, isolated cookieless page, navigate + event-driven settle, serialize the
 * rendered DOM (`DOM.getDocument` + `DOM.getOuterHTML`, never a walk, never `Runtime.evaluate`),
 * Turndown. A PDF is parsed from bytes instead. A bot wall is waited out in two phases. The result
 * is token-efficient by default: metadata only, with the converted document opt-in and paged
 * ([search-port-fetch.9]). A missing page is never a success ([search-port-fetch.10]).
 *
 * Chrome is reached only through the core's `cdp.*` and `capture.*` namespaces; every collaborator is
 * an injectable `FetchDeps` entry so the unit lane runs the whole pipeline with no process, socket or
 * network. No environment variable is read; the user agent is the `FETCH_UA` constant.
 *
 * Ticket 8468f7b1 · plan state search-port-fetch.
 */
import { capture, cdp } from '@adhd/stealth-core-browser'
import type { BanRule } from '@adhd/stealth-core-browser'
import { isSearchError, searchError } from '../../errors.js'
import { htmlToMarkdown, type MarkdownResult } from './markdown.js'
import { extractPdfText, type PdfText } from './pdf.js'
import { PDF_DIRECT_TIMEOUT_MS, PDF_MAX_BYTES, pinnedGet } from './pinned.js'
import type { DirectFetch } from './pinned.js'
import { forbiddenTargetReason, isForbiddenAddress, resolveAndCheck, systemResolver, validateFetchUrl } from './policy.js'

/** Browser-like user agent for the PDF byte-fetch fallback (this tier is cookieless anyway). */
export const FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

/**
 * Below this many characters of rendered markdown, a ban-marker match is trusted as a real
 * interstitial and a not-found title marks a soft 404. Above it the page has real content and
 * markers in prose are ignored (MDN's JS docs are ~19k characters and mention "Permission denied").
 */
export const CHALLENGE_SPARSE_CHARS = 3000

/** Default size, in bytes, of the `content: 'full'` window ([search-port-fetch.9], backlog cd05ad09). */
export const DEFAULT_MAX_CONTENT_SIZE = 20_000

/** The CDP endpoint used when none is given. */
export const DEFAULT_CDP_HOST = '127.0.0.1:9222'

const DEFAULT_DEADLINE_MS = 20_000
const DEFAULT_CHALLENGE_WAIT_MS = 25_000
const CHALLENGE_POLL_MS = 2_000
const REVEAL_AFTER_MS = 8_000
const PDF_BROWSER_TIMEOUT_MS = 15_000
const PDF_POLL_MS = 250
const MAX_PDF_REDIRECTS = 5

/** What a fetch ends as. Outcomes are data, never exceptions. */
export type FetchOutcome = 'success' | 'empty' | 'error' | 'captcha' | 'rate_limited' | 'banned'

/** The provider facts the fetch needs (a structural subset of the provider config). */
export interface FetchProviderConfig {
  id: string
  /** Ban rules checked against a sparse rendered page. */
  bans: readonly BanRule[]
  /** A search qualifier; the fetch route never prepends it (inventory I-09). */
  qualifier?: string
}

/** Caller options of one fetch. */
export interface FetchOptions {
  /** CDP endpoint (default 127.0.0.1:9222). */
  cdpHost?: string
  /** `none` (default): metadata only. `full`: add the converted document, windowed. */
  content?: 'none' | 'full'
  /** Window size in bytes for `content: 'full'` (default DEFAULT_MAX_CONTENT_SIZE; 0 = unbounded). */
  maxContentSize?: number
  /** Byte offset into the converted document where the window starts (default 0). */
  offset?: number
  /** Settle deadline in ms (default 20000). */
  deadlineMs?: number
  /** How long to wait for a bot wall to clear in ms (default 25000; 0 disables). */
  challengeWaitMs?: number
  /** Keep the browser window on-screen from the start. */
  foreground?: boolean
  /** Leave the isolated page open after the fetch. */
  keepPage?: boolean
}

/**
 * The result of a fetch. The metadata fields are always the whole result by default; `content` and
 * `nextOffset` appear only for `content: 'full'`, `error` for a non-success outcome and `warning`
 * when the page never demonstrably settled.
 */
export interface FetchResult {
  provider: string
  /** The URL as requested. */
  url: string
  /** The URL of the final document after redirects. */
  finalUrl: string
  outcome: FetchOutcome
  /** HTTP status of the final document. */
  status?: number
  contentType?: string
  /** Size in bytes of the whole converted document (markdown or PDF text), regardless of the window. */
  contentSize?: number
  title?: string
  /** True when the document was cut at the 1 MiB conversion cap or the returned window does not reach its end. */
  truncated: boolean
  attempts: number
  tookMs: number
  /** `FETCH_URL_REFUSED: ...`, `SEARCH_FAILED: ...`, `PDF_EXTRACT_FAILED: ...` or a challenge message. */
  error?: string
  warning?: string
  /** `content: 'full'` only: the window of the converted document. */
  content?: string
  /** `content: 'full'` only: byte offset of the next window while the document continues. */
  nextOffset?: number
}

/** A CDP page session (the slice of the core's `CdpSession` this module uses). */
export interface FetchSession {
  connect(wsUrl: string): Promise<void>
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void
  close(): void
}

/** An isolated cookieless page (the slice of the core's isolated page handle this module uses). */
export interface FetchPage {
  pageWsUrl: string
  reveal(): Promise<void>
  dispose(): Promise<void>
}

/** The settle verdict (the slice of the core's `SettleResult` this module uses). */
export interface FetchSettle {
  signal: string
  settled: boolean
  tookMs: number
}

/** Every collaborator of the fetch pipeline; the defaults reach Chrome through the core namespaces. */
export interface FetchDeps {
  openPage(cdpHost: string, opts: { foreground: boolean }): Promise<FetchPage>
  newSession(): FetchSession
  settle(session: FetchSession, opts: { navigate: string; deadlineMs: number }): Promise<FetchSettle>
  checkBans(rules: readonly BanRule[], ctx: { url: string; status: number; body: string }): string | null
  toMarkdown(html: string): Promise<MarkdownResult>
  extractPdf(bytes: Uint8Array): Promise<PdfText>
  /** The direct byte fetch (PDF fallback): connects to the address it is given, never to the name; bounded in bytes and time. */
  fetchDirect: DirectFetch
  /** Resolves a hostname to every address; the SSRF check refuses a name that resolves to a private one. */
  resolveHost(host: string): Promise<string[]>
  now(): number
  sleep(ms: number): Promise<void>
  /** Progress and prompts for a human (a challenge being waited out). */
  log(message: string): void
}

/** The production dependencies: Chrome only through the core's `cdp.*` and `capture.*`. */
export function defaultFetchDeps(): FetchDeps {
  return {
    openPage: (cdpHost, opts) => cdp.createIsolatedPageTarget(cdpHost, opts),
    newSession: () => new cdp.CdpSession(),
    settle: (session, opts) => cdp.awaitPageSettled(session as InstanceType<typeof cdp.CdpSession>, opts),
    checkBans: (rules, ctx) => capture.checkBans([...rules], ctx),
    toMarkdown: (html) => htmlToMarkdown(html),
    extractPdf: (bytes) => extractPdfText(bytes),
    fetchDirect: pinnedGet,
    resolveHost: systemResolver,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => {
      process.stderr.write(message)
    },
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** A complete PDF starts with `%PDF-` and ends with a `%%EOF` marker. Chrome streams PDFs to its pdfium
 *  plugin and does NOT buffer the full body for `Network.getResponseBody` (536 bytes for a 2.2 MB PDF),
 *  so a successful-but-truncated body must be rejected, not trusted. */
export function pdfLooksComplete(b: Uint8Array): boolean {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  return b.length >= 1024 && buf.subarray(0, 5).toString('latin1') === '%PDF-' && buf.subarray(Math.max(0, b.length - 3072)).toString('latin1').includes('%%EOF')
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `${code}: ${message}` for any failure; a non-typed throw becomes SEARCH_FAILED. */
export function describeFailure(err: unknown): string {
  if (isSearchError(err)) return `${err.code}: ${err.message}`
  const msg = err instanceof Error ? err.message : String(err)
  return `SEARCH_FAILED: fetch failed: ${msg}`
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** The document `<title>`, or null. */
export function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const t = m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
  return t || null
}

/** The first markdown heading, or null. */
export function firstHeading(md: string): string | null {
  const m = md.match(/^#{1,6}\s+(.+)$/m)
  return m?.[1] ? m[1].trim() : null
}

const NOT_FOUND_RX =
  /\b(?:404|page not found|not found|(?:page|article|document) (?:could not|couldn'?t|can'?t|cannot) be found|(?:page|article|document) (?:does not|doesn'?t) exist|no longer (?:exists?|available))\b/i

/** True when a sparse page's title or first heading reads as a not-found page (soft 404). */
export function looksLikeSoftNotFound(title: string | null, heading: string | null, markdownChars: number): boolean {
  if (markdownChars >= CHALLENGE_SPARSE_CHARS) return false
  return [title, heading].some((t) => t !== null && NOT_FOUND_RX.test(t))
}

/** True when a deep link ended on the site root (a redirect to the home page stands in for a missing page). */
export function redirectedToSiteRoot(requested: string, final: string): boolean {
  try {
    const a = new URL(requested)
    const b = new URL(final)
    const segs = a.pathname.split('/').filter(Boolean)
    if (segs.length === 0) return false
    // A locale prefix (/en) or an index document is a normalisation, not a missing page.
    if (segs.length === 1 && /^([a-z]{2}(-[A-Za-z]{2})?|index(\.\w+)?)$/.test(segs[0] ?? '')) return false
    return b.pathname.replace(/\/+$/, '') === '' && b.search === ''
  } catch {
    return false
  }
}

/** Slice `text` by UTF-8 byte window without splitting a character; `nextOffset` is set while text remains. */
export function sliceWindow(text: string, offset: number, maxBytes: number): { content: string; nextOffset?: number } {
  const buf = Buffer.from(text, 'utf8')
  const isCont = (i: number): boolean => ((buf[i] ?? 0) & 0xc0) === 0x80
  let start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (start >= buf.length) return { content: '' }
  while (start < buf.length && isCont(start)) start++
  let end = maxBytes > 0 ? Math.min(start + Math.floor(maxBytes), buf.length) : buf.length
  while (end < buf.length && end > start && isCont(end)) end--
  if (end <= start) {
    // The window is narrower than one character: take that whole character so paging always advances.
    end = start + 1
    while (end < buf.length && isCont(end)) end++
  }
  const content = buf.subarray(start, end).toString('utf8')
  return end < buf.length ? { content, nextOffset: end } : { content }
}

// ── PDF bytes ───────────────────────────────────────────────────────────────────

/**
 * Capture the PDF bytes FROM THE BROWSER'S NETWORK RESPONSE via Fetch-domain interception: the only
 * path that works for a Cloudflare-walled or session-gated PDF (Network.getResponseBody truncates
 * plugin-streamed PDFs and a direct fetch re-hits the wall). Fetch interception pauses the response
 * BEFORE pdfium consumes it, so Fetch.getResponseBody returns the complete body with the context's
 * cookies. Returns null when no PDF body is seen within the timeout.
 */
async function pdfBytesViaBrowser(session: FetchSession, url: string, deps: FetchDeps): Promise<Uint8Array | null> {
  let captured: Buffer | null = null
  const off = session.on('Fetch.requestPaused', (p) => {
    void (async () => {
      const rid = str(p['requestId'])
      try {
        if (!captured && p['responseStatusCode'] !== undefined) {
          const headers = (p['responseHeaders'] as Array<{ name?: string; value?: string }> | undefined) ?? []
          const ct = headers.find((h) => /content-type/i.test(h.name ?? ''))?.value ?? ''
          const reqUrl = str((p['request'] as { url?: unknown } | undefined)?.url)
          if (/application\/pdf/i.test(ct) || /\.pdf($|[?#])/i.test(reqUrl)) {
            const r = await session.send<{ body: string; base64Encoded: boolean }>('Fetch.getResponseBody', { requestId: rid })
            captured = r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8')
          }
        }
      } catch {
        /* fall through to release */
      }
      // Release the paused request (continueResponse for response-stage pauses).
      await session.send('Fetch.continueResponse', { requestId: rid }).catch(() => session.send('Fetch.continueRequest', { requestId: rid }).catch(() => undefined))
    })()
  })
  try {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] })
    await session.send('Page.navigate', { url })
    const t0 = deps.now()
    while (!captured && deps.now() - t0 < PDF_BROWSER_TIMEOUT_MS) await deps.sleep(PDF_POLL_MS)
  } finally {
    await session.send('Fetch.disable').catch(() => undefined)
    off()
  }
  const got: Buffer | null = captured
  return got ? new Uint8Array(got) : null
}

/**
 * Direct byte fetch, following redirects by hand: every hop passes the SSRF policy, is resolved ONCE and
 * is fetched at the validated address, so a DNS answer that changes after the check cannot redirect it.
 * `pinned` is the already validated answer for the first hop's host.
 */
async function pdfBytesDirect(url: string, pinned: readonly string[], deps: FetchDeps): Promise<Uint8Array> {
  let current = url
  let addresses = pinned
  for (let hop = 0; hop <= MAX_PDF_REDIRECTS; hop++) {
    const address = addresses[0]
    if (!address) throw searchError('SEARCH_FAILED', `no validated address for ${current}`, { detail: { reason: 'dns-resolution-failed' } })
    const res = await deps.fetchDirect(current, address, { headers: { 'User-Agent': FETCH_UA, Accept: 'application/pdf,*/*' }, maxBytes: PDF_MAX_BYTES, timeoutMs: PDF_DIRECT_TIMEOUT_MS })
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw searchError('SEARCH_FAILED', `redirect from ${current} carried no Location`, { detail: { reason: 'redirect-without-location' } })
      const verdict = validateFetchUrl(new URL(res.location, current).toString())
      if (!verdict.ok || !verdict.url) {
        throw searchError('FETCH_URL_REFUSED', `redirect target refused: ${verdict.reason}`, { detail: { reason: verdict.reason } })
      }
      addresses = await resolveAndCheck(verdict.url.hostname, deps.resolveHost)
      current = verdict.url.toString()
      continue
    }
    if (res.body.length > PDF_MAX_BYTES) {
      throw searchError('SEARCH_FAILED', `the response for ${current} is larger than ${PDF_MAX_BYTES} bytes`, { detail: { reason: 'direct-fetch-too-large', maxBytes: PDF_MAX_BYTES } })
    }
    return res.body
  }
  throw searchError('SEARCH_FAILED', `more than ${MAX_PDF_REDIRECTS} redirects fetching ${url}`, { detail: { reason: 'too-many-redirects' } })
}

/** PDF bytes: the browser's network response first (walled/gated PDFs), a validated `Network.getResponseBody`, then a direct fetch. */
async function pdfBytes(session: FetchSession, requestId: string, url: string, pinned: readonly string[], deps: FetchDeps): Promise<Uint8Array> {
  const viaBrowser = await pdfBytesViaBrowser(session, url, deps).catch(() => null)
  if (viaBrowser && pdfLooksComplete(viaBrowser)) return viaBrowser
  if (requestId) {
    try {
      const r = await session.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId })
      const b = new Uint8Array(r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8'))
      if (pdfLooksComplete(b)) return b
    } catch {
      /* fall through */
    }
  }
  return pdfBytesDirect(url, pinned, deps)
}

/** Map a ban signal to the response outcome. */
function banOutcome(signal: string): FetchOutcome {
  if (signal === 'captcha') return 'captcha'
  if (signal === 'rate_limited') return 'rate_limited'
  return 'banned'
}

// ── the fetch ───────────────────────────────────────────────────────────────────

/**
 * Fetch a URL as a settled, cookieless render and convert it to markdown (or extract PDF text).
 * Never throws: every failure is a result with outcome `error` whose message starts with the code.
 */
export async function fetchPage(provider: FetchProviderConfig, url: string, options: FetchOptions = {}, overrides: Partial<FetchDeps> = {}): Promise<FetchResult> {
  const deps: FetchDeps = { ...defaultFetchDeps(), ...overrides }
  const cdpHost = options.cdpHost ?? DEFAULT_CDP_HOST
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const challengeWaitMs = options.challengeWaitMs ?? DEFAULT_CHALLENGE_WAIT_MS
  const wantContent = options.content === 'full'
  const startTime = deps.now()
  const took = (): number => deps.now() - startTime

  let finalUrl = url
  const base = (): Pick<FetchResult, 'provider' | 'url' | 'finalUrl' | 'attempts' | 'tookMs' | 'truncated'> => ({
    provider: provider.id,
    url,
    finalUrl,
    attempts: 1,
    tookMs: took(),
    truncated: false,
  })
  const failure = (err: unknown): FetchResult => ({ ...base(), outcome: 'error', error: describeFailure(err) })

  // ── 1. Validate + SSRF target check BEFORE any network contact ──
  const verdict = validateFetchUrl(url)
  if (!verdict.ok || !verdict.url) {
    return failure(searchError('FETCH_URL_REFUSED', `invalid fetch target: ${verdict.reason}`, { detail: { reason: verdict.reason } }))
  }
  // Resolve ONCE and validate every answer; the direct fetch connects to that answer, and the browser's
  // own connection is checked against the same table (see `refuse` below).
  let pinned: string[]
  try {
    pinned = await resolveAndCheck(verdict.url.hostname, deps.resolveHost)
  } catch (err) {
    return failure(err)
  }
  const target = verdict.url.toString()
  finalUrl = target

  // ── 2. Fresh cookieless context: renders logged out, no credentials ──
  let page: FetchPage | null = null
  const session = deps.newSession()
  try {
    page = await deps.openPage(cdpHost, { foreground: options.foreground ?? false })
    await session.connect(page.pageWsUrl)

    // Capture the MAIN document's content-type, status, URL and requestId. Chrome renders a PDF in its
    // pdfium viewer (canvas) so the text is NOT in the DOM: `application/pdf` must be detected and the
    // bytes parsed. "Last Document response wins" so a Cloudflare to PDF redirect ends up as the PDF.
    let mainMime = ''
    let mainReqId = ''
    let mainStatus: number | undefined

    // SSRF enforcement on what the BROWSER connected to (it resolves names itself and follows redirects):
    // every document request (each redirect hop included) must pass the target policy, every document
    // response must have connected to a non-forbidden address, and every extra host a hop introduced is
    // resolved and checked. Any violation ends the fetch before a byte of the page is read.
    const refusals: unknown[] = []
    const checkedHosts = new Set<string>([verdict.url.hostname])
    const pendingHosts = new Set<string>()
    const checkConnected = (resp: { url?: unknown; remoteIPAddress?: unknown }): void => {
      const addr = str(resp.remoteIPAddress).replace(/^\[|\]$/g, '')
      if (addr && isForbiddenAddress(addr)) {
        refusals.push(searchError('FETCH_URL_REFUSED', `${str(resp.url) || target} connected to ${addr} (private/loopback/link-local)`, { detail: { reason: 'connected-to-forbidden-address', address: addr } }))
      }
    }
    session.on('Network.requestWillBeSent', (p) => {
      if (p['type'] !== 'Document') return
      const u = str((p['request'] as { url?: unknown } | undefined)?.url)
      if (!/^https?:/i.test(u)) return
      const hop = p['redirectResponse']
      if (hop && typeof hop === 'object') checkConnected(hop as { url?: unknown; remoteIPAddress?: unknown })
      try {
        const parsed = new URL(u)
        const reason = forbiddenTargetReason(parsed)
        if (reason) refusals.push(searchError('FETCH_URL_REFUSED', `redirect target refused: ${reason}`, { detail: { reason, url: u } }))
        else if (!checkedHosts.has(parsed.hostname)) pendingHosts.add(parsed.hostname)
      } catch {
        refusals.push(searchError('FETCH_URL_REFUSED', `redirect target is not a valid URL: ${u}`, { detail: { url: u } }))
      }
    })
    const refuse = async (): Promise<void> => {
      for (const host of [...pendingHosts]) {
        pendingHosts.delete(host)
        checkedHosts.add(host)
        try {
          await resolveAndCheck(host, deps.resolveHost)
        } catch (err) {
          refusals.push(err)
        }
      }
      if (refusals[0]) throw refusals[0]
    }
    session.on('Network.responseReceived', (p) => {
      const response = (p['response'] ?? {}) as { url?: unknown; mimeType?: unknown; status?: unknown; remoteIPAddress?: unknown }
      const u = str(response.url)
      if (p['type'] === 'Document') checkConnected(response)
      // Only real http(s) documents: navigating to a PDF fires a SECOND Document response for the
      // pdfium viewer page (chrome-extension://..., text/html) that would clobber application/pdf.
      if (p['type'] === 'Document' && /^https?:/i.test(u)) {
        mainMime = str(response.mimeType)
        mainReqId = str(p['requestId'])
        mainStatus = typeof response.status === 'number' ? response.status : undefined
        finalUrl = u
      }
    })

    // ── 3. Navigate + settle (event-driven) ──
    const settle = await deps.settle(session, { navigate: target, deadlineMs })
    await refuse().catch(async (err: unknown) => {
      await session.send('Page.stopLoading').catch(() => undefined)
      throw err
    })

    const meta = (): Pick<FetchResult, 'status' | 'contentType'> => ({
      ...(mainStatus !== undefined ? { status: mainStatus } : {}),
      ...(mainMime ? { contentType: mainMime } : {}),
    })

    // A missing page is never a success: HTTP 404 and 410 end here, before any conversion or wait.
    if (mainStatus === 404 || mainStatus === 410) {
      return { ...base(), ...meta(), outcome: 'error', error: `SEARCH_FAILED: HTTP ${mainStatus} for ${target}` }
    }

    // Serialize the RENDERED document: whole-document, no walk, no Runtime.evaluate.
    const grab = async (): Promise<string> => {
      const { root } = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
      return (await session.send<{ outerHTML: string }>('DOM.getOuterHTML', { nodeId: root.nodeId })).outerHTML
    }
    let outerHTML = await grab()
    let md = await deps.toMarkdown(outerHTML)

    // ── 4. Challenge handling: WAIT for the wall to clear, do not give up on it ──
    // Detection is SPARSITY-GATED: a real bot wall renders almost no content, while legitimate pages
    // routinely contain ban words in prose, so a ban marker is only trusted when the text is sparse.
    const detectChallenge = (): string | null =>
      md.markdown.trim().length < CHALLENGE_SPARSE_CHARS ? deps.checkBans(provider.bans, { url: target, status: mainStatus ?? 200, body: outerHTML }) : null
    let ban = detectChallenge()
    if (ban && challengeWaitMs > 0) {
      // TWO-PHASE wait. The window starts OFF-SCREEN, so:
      //  Phase 1: stay hidden and poll for AUTO-CLEAR (Cloudflare managed challenges clear for a real
      //    non-headless browser in a few seconds with zero interaction).
      //  Phase 2: if it has not cleared by `revealAfterMs` it needs a HUMAN: bring the window on-screen,
      //    foreground it, prompt the user, and keep polling until they solve it or the wait times out.
      const revealAfterMs = Math.min(REVEAL_AFTER_MS, challengeWaitMs)
      let revealed = false
      deps.log(`\n[fetch] challenge detected (${ban}) at ${target}\n   waiting for it to clear (auto for managed challenges; up to ${Math.round(challengeWaitMs / 1000)}s)...\n`)
      const until = deps.now() + challengeWaitMs
      while (deps.now() < until) {
        await deps.sleep(CHALLENGE_POLL_MS)
        await refuse()
        outerHTML = await grab()
        md = await deps.toMarkdown(outerHTML)
        ban = detectChallenge()
        if (!ban) break
        if (!revealed && deps.now() - startTime - settle.tookMs >= revealAfterMs) {
          revealed = true
          await page.reveal()
          await session.send('Page.bringToFront').catch(() => undefined)
          deps.log(
            `\n   Not auto-clearing: this needs you. A browser window has been brought on-screen.\n   Solve the CAPTCHA/Turnstile there; the fetch continues automatically once it clears (still waiting up to ${Math.round(challengeWaitMs / 1000)}s total)...\n`,
          )
        }
      }
      deps.log(ban ? ' timed out.\n' : ` cleared after ~${Math.round(took() / 1000)}s\n`)
    }
    if (ban) {
      return {
        ...base(),
        ...meta(),
        outcome: banOutcome(ban),
        error: `Challenge (${ban}) did not clear within ${Math.round(challengeWaitMs / 1000)}s. Re-run with a longer challenge wait, or solve it in the browser tab while it waits.`,
      }
    }

    const warning = settle.settled ? undefined : `page never demonstrably settled (signal=${settle.signal}); content may be partial`

    // Assemble the converted document into the result, windowed when content is requested.
    const finish = (text: string, outcome: FetchOutcome, title: string, extra: Partial<FetchResult>): FetchResult => {
      const win = wantContent ? sliceWindow(text, options.offset ?? 0, options.maxContentSize ?? DEFAULT_MAX_CONTENT_SIZE) : null
      return {
        ...base(),
        ...meta(),
        outcome,
        contentSize: Buffer.byteLength(text),
        title,
        truncated: Boolean(extra.truncated) || win?.nextOffset !== undefined,
        ...(warning ? { warning } : {}),
        ...(extra.error ? { error: extra.error } : {}),
        ...(win ? { content: win.content, ...(win.nextOffset !== undefined ? { nextOffset: win.nextOffset } : {}) } : {}),
      }
    }

    // ── 4b. Error statuses: the page that survived challenge handling still answered an HTTP error ──
    // 429 is a rate limit; every other 4xx/5xx (401, 403, 5xx) is an error. The rendered body stays in the result
    // so the caller can read what the site said, but the outcome is never `success`. 404 and 410 ended above.
    if (mainStatus !== undefined && mainStatus >= 400) {
      const rateLimited = mainStatus === 429
      return finish(md.markdown, rateLimited ? 'rate_limited' : 'error', htmlTitle(outerHTML) ?? finalUrl, {
        error: `SEARCH_FAILED: HTTP ${mainStatus} for ${target}`,
      })
    }

    // ── 5. PDF branch: parse bytes, not the (empty) DOM ──
    // Runs AFTER challenge handling so a Cloudflare-walled PDF is unblocked first; by now mainMime
    // reflects the final document.
    const isPdf = /application\/pdf/i.test(mainMime) || (/\.pdf($|[?#])/i.test(target) && md.markdown.trim().length < CHALLENGE_SPARSE_CHARS)
    if (isPdf) {
      const bytes = await pdfBytes(session, mainReqId, target, pinned, deps)
      await refuse()
      const pdf = await deps.extractPdf(bytes)
      const hasText = pdf.text.trim().length > 0
      return finish(pdf.text, hasText ? 'success' : 'empty', finalUrl, {
        ...(hasText ? {} : { error: 'PDF had no extractable text (scanned/image PDF?)' }),
      })
    }

    // ── 6. Not-found detection: a 200 that is really a missing page ──
    const html = htmlTitle(outerHTML)
    const heading = firstHeading(md.markdown)
    if (looksLikeSoftNotFound(html, heading, md.markdown.trim().length)) {
      return { ...base(), ...meta(), outcome: 'error', error: `SEARCH_FAILED: soft 404 at ${finalUrl} (title "${html ?? heading ?? ''}")` }
    }
    if (redirectedToSiteRoot(target, finalUrl)) {
      return { ...base(), ...meta(), outcome: 'error', error: `SEARCH_FAILED: ${target} redirected to the site root ${finalUrl} (the page is missing)` }
    }

    // ── 7. Markdown out ──
    const has = md.markdown.trim().length > 0
    return finish(md.markdown, has ? 'success' : 'empty', html ?? heading ?? finalUrl, { truncated: md.truncated })
  } catch (err) {
    return failure(err)
  } finally {
    session.close()
    // keepPage leaves the isolated page open for inspection; otherwise the whole context is torn down.
    if (page && !options.keepPage) await page.dispose().catch(() => undefined)
  }
}

// ── the provider route ──────────────────────────────────────────────────────────

/** True for the provider whose primary strategy is the URL fetch. */
export function isFetchProvider(provider: { id: string }): boolean {
  return provider.id === 'fetch'
}

/**
 * The `fetch` provider route (inventory I-09): the query IS the URL, handed through untouched. No
 * qualifier is prepended and there is no strategy loop and no retry: exactly one `fetchPage`.
 */
export async function runFetchProvider(provider: FetchProviderConfig, query: string, options: FetchOptions = {}, overrides: Partial<FetchDeps> = {}): Promise<FetchResult> {
  return fetchPage(provider, query, options, overrides)
}
