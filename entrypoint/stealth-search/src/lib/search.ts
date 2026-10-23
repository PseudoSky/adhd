/**
 * @adhd/stealth-search: src/lib/search.ts
 *
 * The orchestration of the `search` verb over the ported modules and the core, in the order of the
 * source runner:
 *
 *   unknown provider -> forced-strategy check -> tripwire gate -> cooldown -> concurrency queue ->
 *   window open -> engine -> hostile-outcome cooldown (hitl excluded) -> HITL fire and keep the
 *   context -> finally dispose (`pageDisposal`)
 *
 * Every collaborator that touches Chrome, the clock or the interactive human is an injectable entry
 * of `SearchDeps` / `SearchServiceOptions`, so the unit lane runs the whole verb on a fake core with no
 * process, socket or window. Chrome is reached only through the core's `cdp.*` and `lifecycle.*`
 * namespaces (and, through the ported engine and fetch modules, `capture.*`).
 *
 * Behaviors pinned here:
 *   - one overall deadline `timeoutMs` (default 30000) shared by every attempt: a hung provider
 *     resolves as outcome `timeout`, releases its concurrency slot, disposes its page and arms no
 *     cooldown; the budget is paused while a human is prompted (backlog 861571da, 224e7a44)
 *   - the same `timeoutMs` is the capture wait of every engine network call (commit 591e1a7)
 *   - a forced strategy a provider cannot run is a usage error before any page, gate or attempt
 *     (SEARCH_FAILED, reason `strategy-unsupported`, commit 591e1a7)
 *   - a login interrupt (`login_required`) writes no tripwire and arms no cooldown; the revealed page
 *     is navigated to the sign-in URL before the human is asked (commit 591e1a7)
 *   - the attempt loop uses the core `decideRetry`: a zero-result page is one attempt, a transport
 *     failure retries up to maxAttempts (commit c00edea)
 *   - the default output is token-efficient: no body, no raw preview, a bounded and paged `content`
 *     window (backlog cd05ad09)
 *
 * Inventory rows: I-02 (locked fail-fast), I-04 (unknown provider first), I-05 (gate before any
 * Chrome work), I-06 (cooldown gate), I-07 (bounded FIFO concurrency), I-13 (hostile outcomes arm the
 * cooldown, hitl fires the tripwire and keeps the context), I-14 (finally dispose, outer catch
 * disposes a leaked context), I-03 and I-18 (provider listing and qualifier help).
 * Ticket 8468f7b1 · plan state search-verbs · [search-verbs.4] [search-verbs.10] [search-verbs.11]
 * [search-verbs.13] [search-verbs.14] [search-verbs.15] [search-verbs.16]
 */
import { capture, cdp, lifecycle, StealthCoreBrowserError } from '@adhd/stealth-core-browser'
import type {
  ClearTripwireResult,
  ListProvidersResult,
  ProviderDescription,
  SearchHit,
  SearchOutput,
  SearchInput,
  SearchProvider,
  TripwireStatusRecord,
} from '../api.js'
import { searchError, strategyUnsupported, StealthSearchError } from '../errors.js'
import { createSearchHostConfig } from './config.js'
import type { InteractionPort, SearchHostConfig } from './config.js'
import { DEFAULT_CHALLENGE_WAIT_MS } from './challenge.js'
import { DEFAULT_MAX_CONTENT_SIZE, fetchPage, sliceWindow } from './fetch/fetch.js'
import type { FetchDeps, FetchResult } from './fetch/fetch.js'
import { createSearchGuard } from './guard.js'
import type { SearchGuard } from './guard.js'
import { runStrategies } from './network.js'
import type { EngineDeps } from './network.js'
import { getProvider, PROVIDERS } from './providers.js'
import type { ProviderName } from './providers.js'
import { createSearchTripwire } from './tripwire.js'
import type { SearchTripwire, TripwireRecord } from './tripwire.js'
import type { ProviderConfig, SearchResponse, SearchStrategy } from './types.js'
import { applyQualifier, resolveProvider } from './utils.js'

/** The one overall deadline of a search call, in ms, shared across every attempt. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
/** Attempts on a transient failure when neither the caller nor the provider says otherwise. */
export const DEFAULT_MAX_ATTEMPTS = 3
/** The default CDP endpoint of the verbs. */
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9222
/** Bytes of the raw response / converted document a caller gets for `preview: 'include'`. */
const PREVIEW_BYTES = 4096
/** Default byte bound of the serialized output of a search (`Buffer.byteLength(JSON.stringify(out))`); whole results are dropped to fit. */
export const DEFAULT_MAX_RESULT_BYTES = 8192
/** A snippet is cut to this many characters so a result list stays small. */
const SNIPPET_MAX_CHARS = 300
/** The settle deadline of the fetch pipeline when the caller's timeout is larger. */
const FETCH_SETTLE_DEADLINE_MS = 20_000

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
/** Compile-time proof that the verb's `SearchProvider` union is exactly the registry's key set. */
export type SearchProviderMatchesRegistry = Assert<Equal<SearchProvider, ProviderName>>

// ─── Collaborators ────────────────────────────────────────────────────────────

/** An isolated page of the controlled Chrome (the slice of the core's page handle the verb uses). */
export interface SearchPage {
  targetId: string
  pageWsUrl: string
  /** Bring the window on screen. */
  reveal(): Promise<void>
  /** Close the page and its context. Idempotent. */
  dispose(): Promise<void>
}

/** Everything the verb needs from Chrome. The default reaches the core's `cdp.*` and `lifecycle.*`. */
export interface SearchCore {
  /** Start or reuse the managed Chrome at host:port. */
  ensureChrome(host: string, port: number): Promise<void>
  /** Genuine use of Chrome: re-arm its idle timer. */
  noteActivity(host: string, port: number): void
  /** Open an isolated page; `sharedProfile` places it in the profile's own session instead. */
  openPage(cdpHost: string, options: { foreground: boolean; sharedProfile: boolean }): Promise<SearchPage>
  /** Send a revealed page to a URL (the sign-in page). */
  navigate(pageWsUrl: string, url: string): Promise<void>
}

/** The injectable collaborators of the search service. */
export interface SearchDeps {
  core: SearchCore
  /** Overrides for the engine's capture, fetch, session and clock entries. */
  engine: Partial<EngineDeps>
  /** One attempt over a provider's strategy plan (the engine's `runStrategies`); replaceable by a scripted engine. */
  strategies: typeof runStrategies
  /** Overrides for the fetch pipeline's session, settle, markdown and clock entries. */
  fetch: Partial<FetchDeps>
  /** The provider registry the verb resolves ids against; tests inject a per-test copy instead of mutating the module singleton. */
  providers: Readonly<Record<ProviderName, ProviderConfig>>
  sleep(ms: number): Promise<void>
  now(): number
  log(message: string): void
}

/** The production core: Chrome only through the core's `cdp` and `lifecycle` namespaces. */
export function defaultSearchCore(): SearchCore {
  return {
    ensureChrome: (host, port) => lifecycle.managerFor(host, port).ready(),
    noteActivity: (host, port) => lifecycle.managerFor(host, port).bump(),
    openPage: (cdpHost, options) =>
      options.sharedProfile
        ? cdp.createIsolatedPageTarget(cdpHost, { foreground: options.foreground, sharedProfile: true })
        : cdp.createIsolatedPageTarget(cdpHost, { foreground: options.foreground }),
    navigate: async (pageWsUrl, url) => {
      const session = new cdp.CdpSession()
      try {
        await session.connect(pageWsUrl)
        await session.send('Page.navigate', { url })
      } finally {
        session.close()
      }
    },
  }
}

function defaultDeps(): SearchDeps {
  return {
    core: defaultSearchCore(),
    engine: {},
    strategies: runStrategies,
    fetch: {},
    providers: PROVIDERS as Readonly<Record<ProviderName, ProviderConfig>>,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => {
      process.stderr.write(`${message}\n`)
    },
  }
}

/** Options of one search service. */
export interface SearchServiceOptions {
  /** The human-in-the-loop seam; absent for the MCP host (a tripped provider then answers `hitl`). */
  interaction?: InteractionPort
  /** Guard and tripwire settings; overrides over `DEFAULT_SEARCH_HOST_CONFIG`. */
  config?: Partial<SearchHostConfig>
  /** Collaborator overrides, for embedders and tests. */
  deps?: Partial<SearchDeps>
}

/** The search service: the `search` orchestration plus the tripwire verbs bound to one config. */
export interface SearchService {
  readonly config: SearchHostConfig
  readonly guard: SearchGuard
  readonly tripwire: SearchTripwire
  search(input: SearchInput): Promise<SearchOutput>
  tripwireStatus(): Promise<Record<string, TripwireStatusRecord>>
  clearTripwire(provider: string): Promise<ClearTripwireResult>
}

// ─── Provider help ────────────────────────────────────────────────────────────

const strategiesOf = (p: ProviderConfig): string[] => [p.strategies.primary, ...(p.strategies.fallback ? [p.strategies.fallback] : [])]

/** Every registered provider with its description and strategies (inventory row I-03). */
export function listProviderSummaries(): ListProvidersResult {
  return {
    providers: Object.values(PROVIDERS as Record<string, ProviderConfig>).map((p) => ({ id: p.id, name: p.name, help: p.help ?? '', strategies: strategiesOf(p) })),
  }
}

/** One provider's description and qualifier examples (inventory rows I-03, I-18). Raises UNKNOWN_PROVIDER. */
export function describeProviderInfo(provider: string): ProviderDescription {
  const p = getProvider(provider)
  const isFetch = p.strategies.primary === 'fetch'
  return {
    id: p.id,
    name: p.name,
    help: p.help ?? '',
    url: p.url(isFetch ? 'https://example.com' : 'demo'),
    strategies: strategiesOf(p),
    qualifierExamples: [...p.qualifierExamples],
    bans: p.bans.map((b) => b.name),
    usage: isFetch
      ? 'search({ provider: "fetch", query: "https://example.com", content: "full" }) returns the page as markdown in `content`'
      : `search({ provider: "${p.id}", query: "tree-sitter", qualifier: "<optional syntax>" }) returns results of title, url and snippet`,
  }
}

// ─── The deadline ─────────────────────────────────────────────────────────────

/** One overall deadline that can be paused (while a human is prompted) and resumed. */
class Budget {
  readonly expired: Promise<'expired'>
  private left: number
  private since = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private fire: () => void = () => undefined

  constructor(ms: number, private readonly now: () => number) {
    this.left = ms
    this.expired = new Promise<'expired'>((resolve) => {
      this.fire = () => resolve('expired')
    })
    this.arm()
  }

  private arm(): void {
    this.since = this.now()
    this.timer = setTimeout(this.fire, Math.max(0, this.left))
  }

  pause(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.left -= this.now() - this.since
  }

  resume(): void {
    if (this.timer === undefined) this.arm()
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

// ─── Shaping ──────────────────────────────────────────────────────────────────

const HOSTILE: ReadonlySet<string> = new Set(['captcha', 'rate_limited', 'banned'])

function clamp(text: string): string {
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text
}

function toHit(r: SearchResponse['results'][number]): SearchHit {
  return { title: r.title, url: r.url, snippet: clamp(r.snippet ?? ''), ...(r.meta && Object.keys(r.meta).length > 0 ? { meta: r.meta } : {}) }
}

/** The first `PREVIEW_BYTES` bytes of a text, cut on a character boundary. */
function previewOf(text: string): string {
  return sliceWindow(text, 0, PREVIEW_BYTES).content
}

interface Shape {
  content: 'none' | 'full'
  preview: 'none' | 'include'
  offset: number
  maxContentSize: number
  maxResultBytes: number
}

const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/**
 * Keep the longest whole-result prefix whose serialized output fits `maxBytes`. Untouched when everything fits;
 * otherwise `omitted` (the dropped count) is set and counted in the size.
 */
function boundResults(out: SearchOutput, maxBytes: number): SearchOutput {
  if (byteSize(out) <= maxBytes) return out
  const total = out.results.length
  const marked = { ...out, results: [] as SearchHit[], omitted: total }
  let used = byteSize(marked)
  let keep = 0
  for (const hit of out.results) {
    const next = used + byteSize(hit) + (keep > 0 ? 1 : 0)
    if (next > maxBytes) break
    used = next
    keep++
  }
  return { ...out, results: out.results.slice(0, keep), omitted: total - keep }
}

/** Turn an engine response into the verb's token-efficient output. */
function shapeEngine(raw: SearchResponse, shape: Shape): SearchOutput {
  const out: SearchOutput = {
    provider: raw.provider,
    query: raw.query,
    count: raw.count,
    results: raw.results.map(toHit),
    outcome: raw.outcome,
    tookMs: raw.tookMs,
    attempts: raw.attempts,
    strategy: raw.strategy,
  }
  if (raw.error !== undefined) out.error = raw.error
  if (raw.readySignal !== undefined) out.readySignal = raw.readySignal
  if (raw.raw) {
    out.raw = { sourceUrl: raw.raw.sourceUrl, status: raw.raw.status, contentType: raw.raw.contentType, ...(shape.preview === 'include' ? { preview: raw.raw.preview } : {}) }
  }
  if (raw.hitl) {
    out.hitl = { pageUrl: raw.hitl.pageUrl, reason: raw.hitl.reason, provider: raw.hitl.provider, query: raw.hitl.query, trippedAt: raw.hitl.trippedAt, strategy: raw.hitl.strategy }
  }
  if (shape.content === 'full' && raw.content !== undefined) {
    const win = sliceWindow(raw.content, shape.offset, shape.maxContentSize)
    out.content = win.content
    out.contentSize = Buffer.byteLength(raw.content)
    if (win.nextOffset !== undefined) out.nextOffset = win.nextOffset
  } else if (raw.contentSize !== undefined) {
    out.contentSize = raw.contentSize
  }
  return boundResults(out, shape.maxResultBytes)
}

/** Turn a fetch result into the verb's output (`results` stay empty, the document rides in `content`). */
function shapeFetch(res: FetchResult, shape: Shape): SearchOutput {
  const out: SearchOutput = {
    provider: res.provider,
    query: res.url,
    url: res.url,
    finalUrl: res.finalUrl,
    count: 0,
    results: [],
    outcome: res.outcome,
    tookMs: res.tookMs,
    attempts: res.attempts,
    strategy: 'fetch',
  }
  if (res.error !== undefined) out.error = res.error
  const truncationNote = res.truncated && res.nextOffset === undefined ? 'the converted document was cut at the conversion cap' : undefined
  const warning = [res.warning, truncationNote].filter((w): w is string => w !== undefined).join('; ')
  if (warning !== '') out.warning = warning
  if (res.title !== undefined) out.title = res.title
  if (res.status !== undefined) out.status = res.status
  if (res.contentType !== undefined) out.contentType = res.contentType
  if (res.contentSize !== undefined) out.contentSize = res.contentSize
  if (shape.content === 'full' && res.content !== undefined) {
    out.content = res.content
    if (res.nextOffset !== undefined) out.nextOffset = res.nextOffset
  }
  if (shape.preview === 'include' && res.content !== undefined) {
    out.raw = { sourceUrl: res.finalUrl, status: res.status ?? 0, contentType: res.contentType ?? '', preview: previewOf(res.content) }
  }
  return out
}

function lockedOutput(p: ProviderConfig, query: string, record: TripwireRecord | null): SearchOutput {
  const strategy = (record?.strategy || p.strategies.primary) as SearchOutput['strategy']
  const out: SearchOutput = {
    provider: p.id,
    query,
    count: 0,
    results: [],
    outcome: 'hitl',
    error: `Provider "${p.id}" is locked pending human resolution (${record?.reason ?? 'unknown'} at ${record?.trippedAt ?? 'unknown'}). A challenge window may still be open — solve it, then call clearTripwire("${p.id}") to release the lock.`,
    tookMs: 0,
    attempts: 0,
    strategy,
  }
  if (record) {
    out.hitl = { pageUrl: record.pageUrl, reason: record.reason, provider: p.id, query: record.query || query, trippedAt: record.trippedAt, strategy }
  }
  return out
}

function failureOf(e: unknown, provider: string): StealthCoreBrowserError {
  if (e instanceof StealthCoreBrowserError) return e
  return searchError('SEARCH_FAILED', `Search failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e, detail: { provider } })
}

function resolveEndpoint(input: { host?: string; port?: number }): { host: string; port: number; cdpHost: string } {
  const host = input.host?.trim() || DEFAULT_HOST
  const port = input.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw StealthCoreBrowserError.invalidEndpoint(`port must be an integer between 1 and 65535, got ${String(port)}`)
  }
  if (/[\s/]/.test(host)) throw StealthCoreBrowserError.invalidEndpoint(`host must be a bare host name or address, got "${host}"`)
  return { host, port, cdpHost: `${host}:${port}` }
}

function usageError(provider: string, field: string, rule: string, value: unknown): StealthSearchError {
  return searchError('SEARCH_FAILED', `${field} must be ${rule} (got ${String(value)})`, { detail: { reason: 'invalid-option', provider, field } })
}

/** Reject a malformed numeric option before any gate or page. */
function checkNumber(provider: string, field: string, value: number | undefined, min: number, integer: boolean): void {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw usageError(provider, field, `${integer ? 'an integer' : 'a number'} >= ${min}`, value)
  }
}

/** A forced strategy the (resolved) provider cannot run is a `strategy-unsupported` usage error (search-errors.7). */
function assertStrategySupported(p: ProviderConfig, strategy: NonNullable<SearchInput['strategy']>): void {
  if (strategy === 'dom' && !p.dom) throw strategyUnsupported(p.id, 'dom')
  if (strategy === 'network' && !p.network) throw strategyUnsupported(p.id, 'network')
}

// ─── The service ──────────────────────────────────────────────────────────────

/** Mutable bookkeeping of one search call, shared by the work and the deadline race. */
interface RunState {
  aborted: boolean
  attempts: number
  pages: Set<SearchPage>
  kept: Set<SearchPage>
}

/** Build the search service for one config, interaction port and set of collaborators. Performs no I/O. */
export function createSearchService(options: SearchServiceOptions = {}): SearchService {
  const config = createSearchHostConfig(options.config ?? {})
  const deps: SearchDeps = { ...defaultDeps(), ...options.deps }
  const interaction = options.interaction
  const guard = createSearchGuard(config)
  const tripwire = createSearchTripwire(config)

  /** Wrap a page so its dispose is idempotent and the call can find every page it opened. */
  const track = (state: RunState, page: SearchPage): SearchPage => {
    let disposed: Promise<void> | undefined
    const wrapped: SearchPage = {
      targetId: page.targetId,
      pageWsUrl: page.pageWsUrl,
      reveal: () => page.reveal(),
      dispose: () => {
        disposed ??= page.dispose().catch((e: unknown) => deps.log(`[search] page dispose failed: ${e instanceof Error ? e.message : String(e)}`))
        return disposed
      },
    }
    state.pages.add(wrapped)
    return wrapped
  }

  const disposeLeaked = async (state: RunState): Promise<void> => {
    for (const page of state.pages) if (!state.kept.has(page)) await page.dispose()
  }

  const openTracked = async (state: RunState, endpoint: { cdpHost: string }, foreground: boolean, sharedProfile: boolean): Promise<SearchPage> => {
    const page = track(state, await deps.core.openPage(endpoint.cdpHost, { foreground, sharedProfile }))
    if (state.aborted) await page.dispose()
    return page
  }

  /** The fetch route (`fetch` provider or forced strategy): one render, no attempt loop. */
  const fetchRoute = async (
    state: RunState,
    p: ProviderConfig,
    query: string,
    input: SearchInput,
    shape: Shape,
    endpoint: { cdpHost: string },
    timeoutMs: number,
  ): Promise<SearchOutput> => {
    const fetchDeps: Partial<FetchDeps> = {
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
      openPage: async (cdpHost, opts) => openTracked(state, { cdpHost }, opts.foreground, false),
      ...deps.fetch,
    }
    // A preview of a fetch is the head of the converted document, so ask the pipeline for it even when the body is not wanted.
    const wantsText = shape.content === 'full' || shape.preview === 'include'
    const res = await fetchPage(
      { id: p.id, bans: p.bans },
      query,
      {
        cdpHost: endpoint.cdpHost,
        content: wantsText ? 'full' : 'none',
        maxContentSize: shape.content === 'full' ? shape.maxContentSize : PREVIEW_BYTES,
        offset: shape.content === 'full' ? shape.offset : 0,
        deadlineMs: Math.min(timeoutMs, FETCH_SETTLE_DEADLINE_MS),
        ...(input.challengeWaitMs !== undefined ? { challengeWaitMs: input.challengeWaitMs } : {}),
        foreground: input.visibility === 'foreground',
        keepPage: input.pageDisposal === 'keep',
      },
      fetchDeps,
    )
    if (state.aborted) return shapeFetch(res, shape)
    await guard.recordSearchOutcome(p.id, res.outcome, query)
    return shapeFetch(res, shape)
  }

  /** The search route: the attempt loop over the engine. */
  const searchRoute = async (
    state: RunState,
    budget: Budget,
    p: ProviderConfig,
    resolved: ProviderConfig,
    query: string,
    fullQuery: string,
    input: SearchInput,
    shape: Shape,
    endpoint: { cdpHost: string },
    timeoutMs: number,
  ): Promise<SearchOutput> => {
    const maxAttempts = input.maxAttempts ?? Math.min(resolved.retry.maxAttempts, DEFAULT_MAX_ATTEMPTS)
    const retryConfig = { ...resolved.retry, maxAttempts }
    const strategy = input.strategy === 'dom' || input.strategy === 'network' ? input.strategy : 'auto'
    const challengeWaitMs = input.challengeWaitMs ?? DEFAULT_CHALLENGE_WAIT_MS
    const foreground = input.visibility === 'foreground'
    const keepAfter = input.pageDisposal === 'keep'

    let last: SearchResponse | null = null
    let carried = null as SearchPage | null
    let retrySleepMs = 0

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (state.aborted) break
      if (retrySleepMs > 0) {
        await deps.sleep(retrySleepMs)
        retrySleepMs = 0
        if (state.aborted) break
      }
      const page: SearchPage = carried ?? (await openTracked(state, endpoint, foreground, resolved.sharedProfile === true))
      carried = null
      let disposeAfter = true
      try {
        if (state.aborted) break
        const raw = await deps.strategies(
          { pageWsUrl: page.pageWsUrl, reveal: () => page.reveal() },
          resolved,
          fullQuery,
          { strategy, content: shape.content, maxContentSize: 0, timeoutMs, challengeWaitMs },
          deps.engine,
        )
        if (state.aborted) break
        raw.attempts = attempt + 1
        state.attempts = attempt + 1
        last = raw

        // Hostile outcomes arm the per-provider cooldown; success and empty disarm it; hitl is ignored (the tripwire is its gate).
        await guard.recordSearchOutcome(p.id, raw.outcome, fullQuery)

        if (raw.outcome === 'success') {
          // Unconditional: a stored login_required lock is invisible to `read`, and resolving a clear provider is a no-op.
          await tripwire.resolved(p.id).catch((e: unknown) => deps.log(`[search] could not clear the tripwire of ${p.id}: ${e instanceof Error ? e.message : String(e)}`))
          disposeAfter = !keepAfter
          return shapeEngine(raw, shape)
        }

        if (raw.outcome === 'hitl' && raw.hitl) {
          const hitl = raw.hitl
          // A sign-in wall is account state, not a ban: no tripwire record (no tripwire), no cooldown.
          if (hitl.reason !== 'login_required') {
            await tripwire.fire({
              provider: p.id,
              query,
              reason: hitl.reason,
              pageUrl: hitl.pageUrl,
              strategy: hitl.strategy,
              browserSessionId: page.targetId,
              lastOperation: resolved.url(fullQuery),
            })
          }
          await page.reveal().catch(() => undefined)
          if (hitl.reason === 'login_required') await deps.core.navigate(page.pageWsUrl, hitl.pageUrl).catch(() => undefined)
          // The user's window must stay alive.
          state.kept.add(page)
          disposeAfter = false
          if (!interaction) return shapeEngine(raw, shape)

          let answer: 'solved' | 'abort'
          budget.pause()
          try {
            answer = await interaction.confirmSolved({ provider: p.id, reason: hitl.reason, query, strategy: hitl.strategy, pageUrl: hitl.pageUrl })
          } catch (e) {
            deps.log(`[search] ${p.id}: the human prompt ended without an answer (${e instanceof Error ? e.message : String(e)}); the lock stays`)
            answer = 'abort'
          } finally {
            budget.resume()
          }
          if (answer === 'abort') return shapeEngine(raw, shape)

          // Solved: release the lock and search again on the same page (it holds the clearance and the sign-in).
          if (hitl.reason !== 'login_required') await tripwire.cleared(p.id, 'hitl-clear')
          state.kept.delete(page)
          carried = page
          continue
        }

        // Hostile outcomes armed the cooldown, so they end the call; only transport failures are retried.
        const decision = capture.decideRetry(raw, attempt, retryConfig)
        if (!decision.shouldRetry || HOSTILE.has(raw.outcome)) {
          disposeAfter = !keepAfter
          return shapeEngine(raw, shape)
        }
        deps.log(`[${p.id}] ${decision.reason} — waiting ${decision.delayMs}ms`)
        retrySleepMs = decision.delayMs
      } finally {
        if (disposeAfter) await page.dispose()
      }
    }
    if (carried) await carried.dispose()
    return shapeEngine(last ?? emptyFailure(p, fullQuery, strategy), shape)
  }

  const emptyFailure = (p: ProviderConfig, query: string, strategy: string): SearchResponse => ({
    provider: p.id,
    query,
    count: 0,
    results: [],
    outcome: 'error',
    error: 'No response after all attempts',
    tookMs: 0,
    attempts: 0,
    strategy: (strategy === 'dom' ? 'dom' : 'network') satisfies SearchStrategy,
  })

  const search: SearchService['search'] = async (input) => {
    const started = deps.now()
    // 1. Unknown provider, before any gate.
    const name = String(input.provider)
    getProvider(name) // throws UNKNOWN_PROVIDER for an id outside the registry
    const p: ProviderConfig = deps.providers[name as ProviderName]
    const query = input.query ?? ''
    if (query.trim() === '') {
      throw searchError('SEARCH_FAILED', 'query must not be empty', { detail: { reason: 'query-required', provider: p.id } })
    }
    checkNumber(p.id, 'timeoutMs', input.timeoutMs, 1, true)
    checkNumber(p.id, 'maxAttempts', input.maxAttempts, 1, true)
    checkNumber(p.id, 'challengeWaitMs', input.challengeWaitMs, 0, true)
    checkNumber(p.id, 'offset', input.offset, 0, true)
    checkNumber(p.id, 'maxContentSize', input.maxContentSize, 0, true)
    checkNumber(p.id, 'maxResultBytes', input.maxResultBytes, 1, true)
    const endpoint = resolveEndpoint(input)

    const forced = input.strategy ?? 'auto'
    const isFetch = p.strategies.primary === 'fetch' || forced === 'fetch'
    // The fetch provider's query IS a URL: no qualifier, no github routing.
    const fullQuery = isFetch ? query : applyQualifier(p, input.qualifier ?? '', query)
    const resolved = isFetch ? p : resolveProvider(p, fullQuery)
    // 2. A forced strategy the provider cannot run: before any page, gate or attempt.
    if (!isFetch || forced === 'dom' || forced === 'network') {
      try {
        assertStrategySupported(resolved, forced)
      } catch (e) {
        deps.log(`[search] ${p.id}: strategy-unsupported (${forced}); nothing was opened`)
        throw e
      }
    }

    // 3. Tripwire gate, before any Chrome work. A stored login_required lock never gates.
    const gate = await tripwire.gate(p.id)
    if (gate.locked) {
      if (!interaction) {
        deps.log(`[search] ${p.id} is tripwire-locked (${gate.record?.reason ?? 'unknown'}) — search blocked without opening a window`)
        return lockedOutput(p, query, gate.record)
      }
      const decision = await interaction.promptTripwireGate({
        provider: p.id,
        reason: gate.record?.reason ?? 'unknown',
        trippedAt: gate.record?.trippedAt ?? '',
        blockedCount: gate.record?.blockedCount ?? 0,
        pageUrl: gate.record?.pageUrl ?? '',
      })
      if (decision === 'abort') {
        throw searchError('HITL_ABORTED', `search for ${p.id} aborted at the tripwire prompt`, { detail: { provider: p.id, reason: gate.record?.reason ?? 'unknown' } })
      }
      await tripwire.cleared(p.id, decision === 'retry' ? 'hitl-retry' : 'hitl-clear')
    }

    // 4. Cooldown gate.
    const remainingMs = await guard.cooldownRemainingMs(p.id)
    if (remainingMs > 0) {
      const cd = await guard.readProviderCooldown(p.id)
      return {
        provider: p.id,
        query,
        count: 0,
        results: [],
        outcome: 'rate_limited',
        error: `Provider "${p.id}" is cooling down after a previous ${cd?.reason ?? 'hostile'} outcome — retry in ~${Math.ceil(remainingMs / 1000)}s`,
        tookMs: 0,
        attempts: 0,
        strategy: p.strategies.primary,
      }
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
    const shape: Shape = {
      content: input.content ?? 'none',
      preview: input.preview ?? 'none',
      offset: input.offset ?? 0,
      maxContentSize: input.maxContentSize ?? DEFAULT_MAX_CONTENT_SIZE,
      maxResultBytes: input.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    }

    // 5. Bounded concurrency around the window-opening body.
    return guard.withSearchConcurrency(async () => {
      const state: RunState = { aborted: false, attempts: 0, pages: new Set(), kept: new Set() }
      const budget = new Budget(timeoutMs, deps.now)
      const work = (async (): Promise<SearchOutput> => {
        await deps.core.ensureChrome(endpoint.host, endpoint.port)
        deps.core.noteActivity(endpoint.host, endpoint.port)
        try {
          const out = isFetch
            ? await fetchRoute(state, p, query, input, shape, endpoint, timeoutMs)
            : await searchRoute(state, budget, p, resolved, query, fullQuery, input, shape, endpoint, timeoutMs)
          return out
        } finally {
          deps.core.noteActivity(endpoint.host, endpoint.port)
        }
      })()
      // If the deadline wins, the hung work is abandoned; its eventual rejection must not surface.
      work.catch(() => undefined)
      try {
        const first = await Promise.race([work, budget.expired])
        if (first === 'expired') {
          state.aborted = true
          await disposeLeaked(state)
          return {
            provider: p.id,
            query: isFetch ? query : fullQuery,
            ...(isFetch ? { url: query } : {}),
            count: 0,
            results: [],
            outcome: 'timeout',
            error: `${p.id} did not answer within the ${timeoutMs}ms deadline`,
            tookMs: deps.now() - started,
            attempts: state.attempts,
            strategy: isFetch ? 'fetch' : resolved.strategies.primary,
          } satisfies SearchOutput
        }
        return { ...first, tookMs: deps.now() - started }
      } catch (e) {
        // A page that was allocated but whose attempt never reached its finally is closed here (I-14).
        state.aborted = true
        await disposeLeaked(state)
        throw failureOf(e, p.id)
      } finally {
        budget.stop()
      }
    })
  }

  const tripwireStatus: SearchService['tripwireStatus'] = async () => {
    const all = await tripwire.tripwireStatus()
    const out: Record<string, TripwireStatusRecord> = {}
    for (const [id, e] of Object.entries(all)) {
      out[id] = {
        provider: e.provider,
        namespace: e.namespace,
        reason: e.reason,
        trippedAt: e.trippedAt,
        blockedCount: e.blockedCount,
        ...(e.lastBlockedAt !== undefined ? { lastBlockedAt: e.lastBlockedAt } : {}),
        ...(e.recoveryHint !== undefined ? { recoveryHint: e.recoveryHint } : {}),
        query: e.query,
        pageUrl: e.pageUrl,
        strategy: e.strategy,
        clearWith: e.clearWith,
        expiresAt: e.expiresAt,
      }
    }
    return out
  }

  const clearTripwire: SearchService['clearTripwire'] = async (provider) => {
    const p = getProvider(String(provider))
    return { provider: p.id, cleared: await tripwire.cleared(p.id, 'mcp-clear') }
  }

  return { config, guard, tripwire, search, tripwireStatus, clearTripwire }
}

// ─── The package-level service ────────────────────────────────────────────────

/** What `configureSearch` accepts. */
export interface ConfigureSearchOptions {
  /** The human-in-the-loop seam (CLI: a TTY prompter; MCP: none). */
  interaction?: InteractionPort
  /** Guard and tripwire settings; overrides over the defaults. */
  config?: Partial<SearchHostConfig>
  /** Collaborator overrides, for embedders and tests. */
  deps?: Partial<SearchDeps>
}

let configured: ConfigureSearchOptions = {}
let current: SearchService | undefined

/**
 * Wire the injected `InteractionPort` and `SearchHostConfig` the verbs use. Each call replaces the
 * previous wiring (an omitted field returns to its default) and rebuilds the guard and tripwire, so
 * call it once at boot, before the first verb. Importing the package performs no wiring and no I/O.
 */
export function configureSearch(options: ConfigureSearchOptions = {}): void {
  configured = options
  current = undefined
}

/** The service the verbs delegate to, built on first use from the `configureSearch` wiring. */
export function getSearchService(): SearchService {
  current ??= createSearchService(configured)
  return current
}
