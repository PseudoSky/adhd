/**
 * @adhd/stealth-search — src/lib/network.ts
 *
 * The network strategy and the single-attempt strategy pass of the search engine.
 *
 *   networkSearch   routes to the direct JSON-API fetch (no browser) or to the core's
 *                   `capture.captureNetworkResponse` with a `select` function (no second capture
 *                   implementation lives here), then runs ban rules, the signed-out wall rule and the
 *                   parser of the provider.
 *   runStrategies   one attempt over the provider's strategy plan: index 0 runs against the provider as
 *                   given, a `network` strategy at index above 0 runs against `fallbackView(provider)`, a
 *                   `dom` strategy needs a `dom` config (otherwise an `error` outcome, never a throw), a
 *                   captcha-class hitl runs the managed-challenge recovery once, and a failed strategy
 *                   falls back to the next one. It never throws and never loops `decideRetry`: the
 *                   attempt loop belongs to the caller.
 *
 * Browser access is only the core's `capture.*` and `cdp.*` namespaces; every collaborator (capture,
 * fetch, sessions, clock) is an injectable entry of `EngineDeps`, so the unit lane runs the whole engine
 * with no socket, no process and no network.
 *
 * Inventory rows: I-11 (isolated-context strategy select), I-11.a (a dom strategy without a dom config is
 * an error outcome), I-24 (direct fetch, network capture search, `No network config`), I-24.a
 * (`noCaptureOutcome`), I-24.b (`loginWallResponse`).
 * Ticket 8468f7b1 · plan state search-port-engine · commits 591e1a7, c00edea · backlog 224e7a44.
 */
import { capture, cdp, parsers, recording } from '@adhd/stealth-core-browser'
import type { BanSignal } from '@adhd/stealth-core-browser'
import { recoverFromChallenge, DEFAULT_CHALLENGE_WAIT_MS, type ChallengeSession } from './challenge.js'
import { defaultClock, domSearch, type DomSession, type EngineClock } from './dom.js'
import type { ContentMode, HitlReason, ProviderConfig, SearchResponse, SearchResult } from './types.js'
import { fallbackView } from './utils.js'

/** The default capture wait: the CLI/MCP request timeout (several providers take 12 to 30 s on a cold Chrome). */
export const DEFAULT_TIMEOUT_MS = 30_000
/** First bytes of the raw response kept for debugging. */
const PREVIEW_BYTES = 4096
/** HTTP statuses that mean "slow down" and outrank any body when several responses were captured. */
const RATE_LIMIT_STATUSES: readonly number[] = [429, 503]

type CaptureOptions = capture.CaptureOptions
type Candidate = Parameters<NonNullable<CaptureOptions['select']>>[0][number]

/** What the engine reads from a captured response. */
export interface CapturedBody {
  url: string
  /** The recorded status; 0 or absent when none was recorded (read as 200). */
  status: number
  body: string
  headers: Record<string, string>
}

/** The collaborators of the engine. */
export interface EngineDeps extends EngineClock {
  /** Capture a page's response (production: the core's `capture.captureNetworkResponse`). */
  capture: (pageWsUrl: string, options: CaptureOptions) => Promise<CapturedBody>
  /** Direct fetch (production: global `fetch`). */
  fetchImpl: typeof fetch
  checkBans: (rules: ProviderConfig['bans'], ctx: { url: string; status: number; body: string }) => BanSignal | null
  /** Open a session on a page for the dom strategy and the challenge poll. */
  connect: (pageWsUrl: string) => Promise<DomSession & ChallengeSession & { close: () => void }>
  log: (message: string) => void
}

/** The production dependencies: Chrome only through the core's `capture.*` and `cdp.*`. */
export function defaultEngineDeps(): EngineDeps {
  return {
    ...defaultClock(),
    capture: (pageWsUrl, options) => capture.captureNetworkResponse(pageWsUrl, options),
    fetchImpl: (input, init) => fetch(input, init),
    checkBans: (rules, ctx) => capture.checkBans([...rules], ctx),
    connect: async (pageWsUrl) => {
      const session = new cdp.CdpSession()
      await session.connect(pageWsUrl)
      return session
    },
    log: (message) => console.error(message),
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * The outcome of a capture that produced no body. This is a transport failure, never a zero-result page, so
 * it must not be `empty` (which is not retried): a dropped or late response (no error, or the capture
 * `timeout`) is `timeout` (retried) and a broken socket (any other error text, such as `WebSocket error`) is
 * `error` (retried). Pure, so it is testable without CDP.
 */
export function noCaptureOutcome(socketError: string | null | undefined): 'timeout' | 'error' {
  return socketError === null || socketError === undefined || socketError === '' || socketError === 'timeout' ? 'timeout' : 'error'
}

/** HITL response for a signed-out wall (e.g. GitHub code search). Pure, so the shape is testable without CDP. */
export function loginWallResponse(provider: Pick<ProviderConfig, 'id'>, query: string, pageUrl: string, error: string, tookMs: number): SearchResponse {
  return {
    provider: provider.id,
    query,
    count: 0,
    results: [],
    outcome: 'hitl',
    error: `Login required: ${error}`,
    tookMs,
    attempts: 1,
    strategy: 'network',
    hitl: { pageUrl, reason: 'login_required', provider: provider.id, query, trippedAt: new Date().toISOString(), strategy: 'network' },
  }
}

const statusOf = (c: Candidate): number => c.response?.status || 200

/**
 * The `select` function the engine passes to `capture.captureNetworkResponse`. Of the matching responses
 * captured it prefers, in order:
 *   1. a 429 or 503 response, so a rate limit reaches the ban rules even when its body is small (it would
 *      otherwise lose to a larger 200 body and be parsed as a legitimate empty page);
 *   2. the response carrying the Google results container (`id="rso"` / `#rso`);
 *   3. the largest body, ties to the later capture.
 * A response with no recorded status counts as 200.
 */
export function selectCandidate(candidates: readonly Candidate[]): Candidate | undefined {
  if (candidates.length === 0) return undefined
  const limited = candidates.find((c) => RATE_LIMIT_STATUSES.includes(statusOf(c)))
  if (limited) return limited
  // Each body is decoded once: the rso scan and the size comparison share the decoded text.
  const decoded = new Map<Candidate, string>()
  const bodyOf = (c: Candidate): string => {
    let body = decoded.get(c)
    if (body === undefined) {
      body = recording.decodeBody(c.response)
      decoded.set(c, body)
    }
    return body
  }
  const rso = candidates.find((c) => {
    const body = bodyOf(c)
    return body.includes('id="rso"') || body.includes('#rso')
  })
  if (rso) return rso
  return candidates.reduce((a, b) => (bodyOf(a).length > bodyOf(b).length ? a : b))
}

/** The `Retry-After` header value of a response, matched case-insensitively. */
export function retryAfterOf(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') return value
  }
  return undefined
}

function errorCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code
  return undefined
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** Capture failures that mean "nothing arrived in time" (retried as `timeout`); every other failure is a transport `error`. */
const TIMEOUT_CAPTURE_CODES: readonly string[] = ['CAPTURE_TIMEOUT', 'CAPTURE_NO_MATCH']

// ─── The network strategy ─────────────────────────────────────────────────────

/** Options of one network search. */
export interface NetworkSearchOptions {
  /** `full` returns the response body in `content`. Default `none`. */
  content?: ContentMode
  /** Cap on `content` bytes; 0 means unlimited. Default 0. */
  maxContentSize?: number
  /** The capture wait. Default `DEFAULT_TIMEOUT_MS` (30000), never a fixed 10 s. */
  timeoutMs?: number
}

const emptyResponse = (provider: ProviderConfig, query: string, outcome: SearchResponse['outcome'], error: string, startedAt: number, deps: EngineClock): SearchResponse => ({
  provider: provider.id,
  query,
  count: 0,
  results: [],
  outcome,
  error,
  tookMs: deps.now() - startedAt,
  attempts: 1,
  strategy: 'network',
})

function contentOf(body: string, options: NetworkSearchOptions): Pick<SearchResponse, 'content' | 'contentSize'> {
  return {
    ...(options.content === 'full' ? { content: body.slice(0, options.maxContentSize || undefined) } : {}),
    contentSize: body.length,
  }
}

/** Parse a captured body with the parser the provider declares. */
function parseBody(body: string, capturePlan: NonNullable<ProviderConfig['network']>): SearchResult[] {
  if (capturePlan.parser === 'json') return parsers.extractResultsFromJson(body, capturePlan)
  if (capturePlan.parser === 'embedded-json') return parsers.extractResultsFromEmbeddedJson(body, capturePlan)
  // A structural selector (#rso) is read with the XPath extractor; a class selector with the HTML parser.
  return capturePlan.resultSelector.startsWith('#') ? parsers.extractWithXpath(body) : parsers.extractResultsFromHtml(body, capturePlan)
}

/**
 * Run a search with the network strategy: direct fetch for public JSON APIs (no browser), otherwise a
 * capture of the matching response through the core, then ban rules, the signed-out wall rule and the
 * provider's parser. Outcomes are data; this never throws.
 */
export async function networkSearch(
  pageWsUrl: string,
  provider: ProviderConfig,
  query: string,
  options: NetworkSearchOptions = {},
  overrides: Partial<EngineDeps> = {},
): Promise<SearchResponse> {
  const deps: EngineDeps = { ...defaultEngineDeps(), ...overrides }
  const startedAt = deps.now()
  const plan = provider.network

  if (!plan) return emptyResponse(provider, query, 'error', 'No network config', startedAt, deps)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Direct fetch for public JSON APIs: the pageWsUrl is unused, no browser is involved.
  if (plan.directFetch) return directFetchSearch(provider, query, options, timeoutMs, deps)

  const searchUrl = provider.url(query)
  let captured: CapturedBody
  try {
    captured = await deps.capture(pageWsUrl, {
      urlPattern: new RegExp(plan.urlPattern),
      timeoutMs,
      extraWaitMs: plan.extraWaitMs ?? 0,
      navigateUrl: searchUrl,
      select: selectCandidate,
      logger: deps.log,
    })
  } catch (e) {
    // The capture never produced a body (timeout, closed socket, failed navigation): a transport failure,
    // never `empty`. The cause stays in the response.
    const message = messageOf(e)
    const code = errorCodeOf(e)
    const socketError = code !== undefined && TIMEOUT_CAPTURE_CODES.includes(code) ? 'timeout' : message
    return emptyResponse(provider, query, noCaptureOutcome(socketError), message, startedAt, deps)
  }

  const body = captured.body
  const status = captured.status || 200
  const pageUrl = captured.url || searchUrl
  const retryAfter = retryAfterOf(captured.headers)

  try {
    return processCaptured(provider, query, options, plan, deps, startedAt, { body, status, pageUrl, retryAfter, searchUrl })
  } catch (e) {
    // Ban rules or a parser threw on the captured body: the page was captured, so this is an engine
    // error outcome carrying the cause, never an exception out of networkSearch.
    deps.log(`[network] post-capture processing failed: ${messageOf(e)}`)
    return emptyResponse(provider, query, 'error', `Processing failed: ${messageOf(e)}`, startedAt, deps)
  }
}

interface CapturedView { body: string; status: number; pageUrl: string; retryAfter: string | undefined; searchUrl: string }

/** Ban rules, the signed-out wall and the parser over one captured body. May throw; the caller converts it. */
function processCaptured(
  provider: ProviderConfig,
  query: string,
  options: NetworkSearchOptions,
  plan: NonNullable<ProviderConfig['network']>,
  deps: EngineDeps,
  startedAt: number,
  view: CapturedView,
): SearchResponse {
  const { body, status, pageUrl, retryAfter, searchUrl } = view
  // Ban detection: a challenge needing the user is a hitl interrupt; a rate limit is its own outcome.
  const banSignal = deps.checkBans(provider.bans, { url: pageUrl, status, body })
  if (banSignal) {
    if (banSignal === 'captcha' || banSignal === 'banned' || banSignal === 'login_required') {
      return {
        ...emptyResponse(provider, query, 'hitl', `Challenge detected: ${banSignal} — solve in browser to continue`, startedAt, deps),
        hitl: { pageUrl, reason: banSignal as HitlReason, provider: provider.id, query, trippedAt: new Date().toISOString(), strategy: 'network' },
      }
    }
    return {
      ...emptyResponse(provider, query, 'rate_limited', `Ban detected: ${banSignal} (HTTP ${status}${retryAfter !== undefined ? `, retry-after ${retryAfter}` : ''})`, startedAt, deps),
      raw: { sourceUrl: pageUrl, status, contentType: '', preview: body.slice(0, PREVIEW_BYTES) },
    }
  }

  const results = parseBody(body, plan)

  // Signed-out wall (e.g. GitHub code search): an account requirement, not a transient ban. It applies only
  // when the page parsed to zero results, and routes through HITL so the window stays open for sign-in.
  const loginRule = plan.emptyRequiresLogin
  if (results.length === 0 && loginRule?.pattern.test(body)) {
    const loginPage = loginRule.loginUrl ? loginRule.loginUrl(searchUrl) : pageUrl
    return loginWallResponse(provider, query, loginPage, loginRule.error, deps.now() - startedAt)
  }

  return {
    provider: provider.id,
    query,
    count: results.length,
    results,
    outcome: results.length > 0 ? 'success' : 'empty',
    tookMs: deps.now() - startedAt,
    attempts: 1,
    strategy: 'network',
    raw: { sourceUrl: pageUrl, status, contentType: '', preview: body.slice(0, PREVIEW_BYTES) },
    ...contentOf(body, options),
  }
}

/** Direct fetch of a public JSON API: no browser, ban rules on the status then on the body. */
async function directFetchSearch(provider: ProviderConfig, query: string, options: NetworkSearchOptions, timeoutMs: number, deps: EngineDeps): Promise<SearchResponse> {
  const startedAt = deps.now()
  const plan = provider.network as NonNullable<ProviderConfig['network']>
  const searchUrl = plan.apiUrl ? `${plan.apiUrl}${encodeURIComponent(query)}` : provider.url(query)

  // Provider-specific query validation.
  if (provider.id === 'npm' && (query.length < 2 || query.length > 64)) {
    return emptyResponse(provider, query, 'error', `npm search query must be between 2 and 64 characters (got ${query.length})`, startedAt, deps)
  }

  try {
    const response = await deps.fetchImpl(searchUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'stealth-search/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = response.status
    const sourceUrl = response.url || searchUrl

    const statusBan = deps.checkBans(provider.bans, { url: sourceUrl, status, body: '' })
    if (statusBan) {
      return {
        ...emptyResponse(provider, query, statusBan === 'rate_limited' ? 'rate_limited' : 'banned', `Ban detected: ${statusBan} (HTTP ${status})`, startedAt, deps),
        raw: { sourceUrl, status, contentType: '', preview: `HTTP ${status}` },
      }
    }

    if (!response.ok) {
      return { ...emptyResponse(provider, query, 'error', `HTTP ${status}`, startedAt, deps), raw: { sourceUrl, status, contentType: '', preview: `HTTP ${status}` } }
    }

    const body = await response.text()

    const bodyBan = deps.checkBans(provider.bans, { url: sourceUrl, status, body })
    if (bodyBan) {
      return {
        ...emptyResponse(provider, query, bodyBan === 'captcha' ? 'captcha' : 'banned', `Ban detected: ${bodyBan}`, startedAt, deps),
        raw: { sourceUrl, status, contentType: '', preview: body.slice(0, PREVIEW_BYTES) },
      }
    }

    const results = parseBody(body, plan)
    return {
      provider: provider.id,
      query,
      count: results.length,
      results,
      outcome: results.length > 0 ? 'success' : 'empty',
      tookMs: deps.now() - startedAt,
      attempts: 1,
      strategy: 'network',
      raw: { sourceUrl, status, contentType: response.headers.get('content-type') ?? '', preview: body.slice(0, PREVIEW_BYTES) },
      ...contentOf(body, options),
    }
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    deps.log(`[network] direct fetch error: ${messageOf(e)}`)
    return emptyResponse(provider, query, timedOut ? 'timeout' : 'error', `Fetch failed: ${messageOf(e)}`, startedAt, deps)
  }
}

// ─── The strategy pass ────────────────────────────────────────────────────────

/** A strategy the engine can run. */
export type EngineStrategy = 'network' | 'dom'

/** Which strategies a caller forces: `auto` follows the provider's primary and fallback. */
export type StrategyChoice = 'auto' | 'network' | EngineStrategy

/** The page one attempt runs on. */
export interface EnginePage {
  /** The page's debugger WebSocket URL. */
  pageWsUrl: string
  /** Bring the page's window on screen (a managed challenge clears only on a visible page). */
  reveal: () => Promise<void>
}

export interface StrategyRunOptions extends NetworkSearchOptions {
  /** `auto` (default) follows the provider; `network` or `dom` forces one strategy. */
  strategy?: StrategyChoice
  /** Time budget for a managed challenge to clear; 0 disables the recovery. Default 25000. */
  challengeWaitMs?: number
}

/** The ordered strategies of a provider: forced when asked, otherwise primary then fallback (`fetch` excluded). */
export function planStrategies(provider: ProviderConfig, strategy: StrategyChoice = 'auto'): EngineStrategy[] {
  if (strategy !== 'auto') return [strategy]
  const plan: EngineStrategy[] = []
  const { primary, fallback } = provider.strategies
  if (primary === 'network' || primary === 'dom') plan.push(primary)
  if (fallback === 'network' || fallback === 'dom') plan.push(fallback)
  return plan
}

const noDomResponse = (provider: ProviderConfig, query: string): SearchResponse => ({
  provider: provider.id,
  query,
  count: 0,
  results: [],
  outcome: 'error',
  error: `Provider "${provider.id}" has no DOM strategy config`,
  tookMs: 0,
  attempts: 1,
  strategy: 'dom',
})

/** Outcomes that stop the pass: success, or something a human or a cooldown must handle (not another strategy). */
const TERMINAL_OUTCOMES: ReadonlySet<SearchResponse['outcome']> = new Set(['success', 'hitl', 'captcha', 'rate_limited', 'banned'])

/**
 * One attempt over the provider's strategy plan on an open page. Never throws: every failure, including a
 * closed CDP socket during capture, becomes an outcome (backlog 224e7a44).
 *
 * - strategy index 0 runs against the provider as given; a `network` strategy at index above 0 runs against
 *   `fallbackView(provider)` (GitHub: API primary, rendered page fallback)
 * - a `dom` strategy on a provider without a `dom` config returns outcome `error` ("has no DOM strategy
 *   config") without touching the page
 * - a captcha-class hitl from the network strategy runs the managed-challenge recovery: reveal, poll the
 *   provider's ban markers, retry exactly once
 * - success and hostile outcomes (hitl, captcha, rate_limited, banned) return at once; `empty`, `error`
 *   and `timeout` fall back to the next strategy, and the last response is returned when none succeeds
 * - the SearchInput `timeoutMs` is the capture wait of the primary call, the fallback call and the
 *   post-challenge retry call
 */
export async function runStrategies(
  page: EnginePage,
  provider: ProviderConfig,
  query: string,
  options: StrategyRunOptions = {},
  overrides: Partial<EngineDeps> = {},
): Promise<SearchResponse> {
  const deps: EngineDeps = { ...defaultEngineDeps(), ...overrides }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const challengeWaitMs = options.challengeWaitMs ?? DEFAULT_CHALLENGE_WAIT_MS
  const networkOptions: NetworkSearchOptions = { content: options.content, maxContentSize: options.maxContentSize, timeoutMs }
  const startedAt = deps.now()

  let last: SearchResponse | undefined
  for (const [index, strategy] of planStrategies(provider, options.strategy).entries()) {
    let response: SearchResponse
    try {
      if (strategy === 'network') {
        const view = index > 0 ? fallbackView(provider) : provider
        response = await networkSearch(page.pageWsUrl, view, query, networkOptions, deps)

        const recovery = await recoverFromChallenge(
          {
            response,
            provider: view,
            budgetMs: challengeWaitMs,
            reveal: page.reveal,
            connect: () => deps.connect(page.pageWsUrl),
            retry: () => networkSearch(page.pageWsUrl, view, query, networkOptions, deps),
          },
          deps,
        )
        response = recovery.response
      } else if (!provider.dom) {
        response = noDomResponse(provider, query)
      } else {
        const session = await deps.connect(page.pageWsUrl)
        try {
          response = await domSearch(session, provider, query, timeoutMs, deps)
        } finally {
          session.close()
        }
      }
    } catch (e) {
      response = {
        provider: provider.id,
        query,
        count: 0,
        results: [],
        outcome: 'error',
        error: messageOf(e),
        tookMs: deps.now() - startedAt,
        attempts: 1,
        strategy,
      }
    }

    last = response
    if (TERMINAL_OUTCOMES.has(response.outcome)) return response
  }

  return last ?? { provider: provider.id, query, count: 0, results: [], outcome: 'error', error: 'No strategy to run', tookMs: 0, attempts: 1, strategy: 'network' }
}
