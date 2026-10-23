/**
 * @adhd/stealth-search: src/api.ts, the apigen-visible surface.
 *
 * Exactly eleven plain, TSDoc'd async functions: the search verbs (`search`, `listProviders`,
 * `describeProvider`, `tripwireStatus`, `clearTripwire`), five chrome verbs of the core
 * (`chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`)
 * and `getPageContext`. The hosts project them one-to-one onto the CLI and the MCP server (tool
 * name = function name, tool description = the TSDoc description). Nothing else here is a
 * function: the orchestration lives in lib/search.ts, the wiring entry `configureSearch` in the
 * package root.
 *
 * Rules every verb follows:
 *  - input is ONE plain JSON object of typed options, with enums where a mode has states; there
 *    is no optional boolean property in any input or output type (apigen extracts an optional
 *    boolean as a `oneOf` with a duplicated boolean branch, so a client rejects the result);
 *  - nothing reads an environment variable: the CDP endpoint is `host`/`port` input and every
 *    guard setting is the typed `SearchHostConfig`;
 *  - types are declared in this file (not imported from lib/) so the extraction from the built
 *    `dist/api.d.ts` sees every property;
 *  - `launchChrome` keeps the core input of the port and the profile directory only, so no host
 *    can pass a binary path or process arguments.
 *
 * Inventory rows: I-02, I-03, I-04, I-05, I-06, I-07, I-13, I-14, I-16, I-17, I-18.
 * Ticket 8468f7b1 · plan state search-verbs · [search-verbs.2] [search-verbs.3] [search-verbs.10]
 */
import { getPageContext as readCorePageContext } from '@adhd/stealth-core-browser'
import { redactCookieValues } from './host-projection.js'
import { describeProviderInfo, getSearchService, listProviderSummaries } from './lib/search.js'

export type {
  ChromeActivityReport,
  ChromeEndpointInput,
  ChromeStatus,
  CheckChromeActivityInput,
  LaunchChromeInput,
  LaunchChromeResult,
  PageTarget,
  PageTargetList,
  ShutdownChromeResult,
} from '@adhd/stealth-core-browser'

// The chrome verbs of the core, exposed unchanged.
export { chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity } from '@adhd/stealth-core-browser'

// ─── Types ────────────────────────────────────────────────────────────────────

/** The id of every registered provider. */
export type SearchProvider =
  | 'duckduckgo'
  | 'google'
  | 'arxiv'
  | 'npm'
  | 'github'
  | 'maven'
  | 'wikipedia'
  | 'crates'
  | 'pypi'
  | 'mdn'
  | 'stackoverflow'
  | 'fetch'

/** The ways a provider can be run. `auto` follows the provider; `fetch` renders a URL as markdown. */
export type SearchStrategyInput = 'auto' | 'network' | 'dom' | 'fetch'

/** Input of search. */
export interface SearchInput {
  /** Provider id (see listProviders), or `fetch` to read a URL as markdown. */
  provider: SearchProvider
  /** The search query; for the `fetch` provider the URL to read. */
  query: string
  /** Search syntax prepended to the query (for example `site:example.com` or `repo:owner/name`); ignored by `fetch`. */
  qualifier?: string
  /** `auto` (default) follows the provider; `network` or `dom` forces one strategy; `fetch` reads the query as a URL. */
  strategy?: SearchStrategyInput
  /** `none` (default) returns results and metadata only; `full` adds the response body (markdown for `fetch`) as a window of `maxContentSize` bytes. */
  content?: 'none' | 'full'
  /** `none` (default) omits the first bytes of the raw response; `include` adds them as `raw.preview`. */
  preview?: 'none' | 'include'
  /** Byte offset where the `content` window starts (default 0); continue with the `nextOffset` of the previous result. */
  offset?: number
  /** Size of the `content` window in bytes (default 20000; 0 = unbounded). */
  maxContentSize?: number
  /** One deadline for the whole call across every attempt, and the wait for each capture, in ms (default 30000). */
  timeoutMs?: number
  /** Attempts on a transient failure (default: the provider's own policy, 3 at most). */
  maxAttempts?: number
  /** How long to wait for a Cloudflare or CAPTCHA wall to clear, in ms (default 25000; 0 disables). */
  challengeWaitMs?: number
  /** `offscreen` (default) renders in a minimized window; `foreground` shows the window. */
  visibility?: 'offscreen' | 'foreground'
  /** `dispose` (default) closes the page when the call ends; `keep` leaves it open for inspection. */
  pageDisposal?: 'dispose' | 'keep'
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port (default 9222). */
  port?: number
}

/** One search result. */
export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** Provider-specific attributes (stars, language, repository, ...). */
  meta?: Record<string, string>
}

/** The first bytes of the raw response; `preview` appears only for `preview: 'include'`. */
export interface SearchRaw {
  sourceUrl: string
  status: number
  contentType: string
  preview?: string
}

/** Why a human is needed, and where. */
export interface SearchHitl {
  pageUrl: string
  /** `captcha`, `cloudflare`, `rate_limited`, `banned` or `login_required`. */
  reason: string
  provider: string
  query: string
  /** ISO timestamp. */
  trippedAt: string
  strategy: 'network' | 'dom' | 'fetch'
}

/** Result of search. Outcomes are data: `success`, `empty`, `error`, `timeout`, `hitl`, `captcha`, `rate_limited` or `banned`. */
export interface SearchOutput {
  provider: string
  /** The query (for `fetch`, the URL). */
  query: string
  /** `fetch` only: the URL as requested. */
  url?: string
  /** `fetch` only: the URL of the final document after redirects. */
  finalUrl?: string
  count: number
  results: SearchHit[]
  outcome: 'success' | 'empty' | 'error' | 'timeout' | 'hitl' | 'captcha' | 'rate_limited' | 'banned'
  error?: string
  warning?: string
  tookMs: number
  /** Attempts made; 0 when the call was refused before any page was opened. */
  attempts: number
  strategy: 'network' | 'dom' | 'fetch'
  raw?: SearchRaw
  /** Present for outcome `hitl`: the page a human must act on. */
  hitl?: SearchHitl
  /** `fetch` only: which settle signal fired (`deadline` = never settled). */
  readySignal?: string
  /** `fetch` only: the document title. */
  title?: string
  /** `fetch` only: HTTP status of the final document. */
  status?: number
  /** `fetch` only: content type of the final document. */
  contentType?: string
  /** `content: 'full'` only: the window of the body. */
  content?: string
  /** Size in bytes of the whole body (or converted document), whatever the window. */
  contentSize?: number
  /** Byte offset of the next window while the body continues. */
  nextOffset?: number
}

/** One provider in the listing. */
export interface ProviderSummary {
  id: string
  name: string
  help: string
  /** Primary strategy, then the fallback when there is one. */
  strategies: string[]
}

/** Result of listProviders. */
export interface ListProvidersResult {
  providers: ProviderSummary[]
}

/** Input of describeProvider. */
export interface DescribeProviderInput {
  provider: SearchProvider
}

/** Result of describeProvider. */
export interface ProviderDescription {
  id: string
  name: string
  help: string
  /** Example search URL for the query `demo`. */
  url: string
  strategies: string[]
  /** Qualifier examples (`syntax  description`). */
  qualifierExamples: string[]
  /** Names of the ban rules that classify a hostile response. */
  bans: string[]
  /** How to call search for this provider. */
  usage: string
}

/** One tripped provider, with how to clear it and when it lapses. */
export interface TripwireStatusRecord {
  provider: string
  namespace: string
  /** Ban signal that latched it: `captcha`, `banned` or `rate_limited`. */
  reason: string
  trippedAt: string
  /** How many searches the lock has blocked. */
  blockedCount: number
  lastBlockedAt?: string
  recoveryHint?: string
  query: string
  pageUrl: string
  strategy: string
  /** The verb that clears it. */
  clearWith: 'clearTripwire'
  /** ISO timestamp after which the lock no longer blocks. */
  expiresAt: string
}

/** Input of clearTripwire. */
export interface ClearTripwireInput {
  provider: SearchProvider
}

/** Result of clearTripwire: `cleared` is false when the provider was not tripped. */
export interface ClearTripwireResult {
  provider: string
  cleared: boolean
}

/** Input of getPageContext. */
export interface GetPageContextInput {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port (default 9222). */
  port?: number
  /** Target id of the page, as returned by listPageTargets. */
  targetId: string
}

/** A cookie as described to a caller: its name and attributes, never its value. */
export interface CookieSummary {
  name: string
  host?: string
}

/** One described page. */
export interface PageContext {
  targetId: string
  url: string
  title: string
  /** How many cookies the profile holds for the page's host. */
  cookieCount: number
  hasHistory: boolean
  historyVisits: number
  /** Cookie names when the core reports them; values are always removed. */
  cookies?: CookieSummary[]
}

/** Result of getPageContext: `found` is false when the target no longer exists. */
export interface PageContextResult {
  found: boolean
  context: PageContext | null
}

// ─── Verbs ────────────────────────────────────────────────────────────────────

/**
 * Search a provider, or read a URL as markdown with the `fetch` provider. A search returns
 * `results` of title, url and snippet; the default output is token-efficient (no body, no raw
 * preview, at most 20000 bytes of content when `content: 'full'`, paged with `offset` and
 * `nextOffset`). A provider locked after a captcha, a ban or a rate limit answers outcome
 * `hitl` without opening a window until clearTripwire releases it; a provider cooling down
 * answers `rate_limited` with a retry hint.
 */
export async function search(input: SearchInput): Promise<SearchOutput> {
  return getSearchService().search(input)
}

/**
 * List every registered search provider with its description and strategies, so a caller can
 * choose one before calling search. Use describeProvider for the qualifiers of one provider.
 */
export async function listProviders(): Promise<ListProvidersResult> {
  return listProviderSummaries()
}

/**
 * Describe one provider: its example URL, strategies, ban rules, the qualifier syntax it accepts
 * (for example `site:` or `repo:`) and how to call search for it. Raises UNKNOWN_PROVIDER for an
 * id that is not registered.
 */
export async function describeProvider(input: DescribeProviderInput): Promise<ProviderDescription> {
  return describeProviderInfo(input.provider)
}

/**
 * Report the providers that are locked after a hostile response, each with the reason, when it
 * tripped, when it expires and `clearWith: 'clearTripwire'`. The map is sparse: only tripped
 * providers appear, and an expired lock does not.
 */
export async function tripwireStatus(): Promise<Record<string, TripwireStatusRecord>> {
  return getSearchService().tripwireStatus()
}

/**
 * Release a locked provider after the challenge was solved or the lock is no longer wanted.
 * Returns `cleared: false` when the provider was not tripped. The next search for it proceeds.
 */
export async function clearTripwire(input: ClearTripwireInput): Promise<ClearTripwireResult> {
  return getSearchService().clearTripwire(input.provider)
}

/**
 * Describe one open page: its URL and title, how many cookies the profile holds for its host
 * (names and counts only, cookie values are always removed) and how often it appears in Chrome
 * history.
 */
export async function getPageContext(input: GetPageContextInput): Promise<PageContextResult> {
  return redactCookieValues(await readCorePageContext(input))
}
