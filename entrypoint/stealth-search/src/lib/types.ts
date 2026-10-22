/**
 * @adhd/stealth-search — src/lib/types.ts
 *
 * Shared types for web search. Every provider supports two strategies (plus `fetch`, the
 * arbitrary-URL-to-markdown path):
 *   network (default) — capture the API/XHR/HTML response body and parse it. No JS injection.
 *   dom     (fallback) — walk the DOM tree via DOM.getDocument({depth:-1}).
 *
 * The captured-page provenance type is the core's `PageSource` (re-exported, never redefined).
 * Optional booleans are not used in any exported type: a flag that can only ever be on is the
 * literal `true`, a mode with more than two states is an enum.
 *
 * Inventory rows: I-23 (SearchResultSource -> PageSource, outcomes, HitlInfo, extractor configs).
 * Ticket 8468f7b1 · plan state search-port-providers · commit 591e1a7 (two-config shape).
 */
import type { BanRule, CaptureConfig, DomExtractor, PageSource, ParseResult, RetryConfig } from '@adhd/stealth-core-browser'

export type { BanRule, BanSignal, CapturedRequest, DomPattern, PageSource, RetryConfig, StructuralExtractor } from '@adhd/stealth-core-browser'
export type { DomExtractor } from '@adhd/stealth-core-browser'

/** The ways a provider can be run. `fetch` is the cookieless URL-to-markdown path. */
export type SearchStrategy = 'network' | 'dom' | 'fetch'

/** One search result; `source` is the core's `PageSource`. */
export interface SearchResult extends ParseResult {
  source?: PageSource
}

/** The eight outcomes of a search or fetch. Outcomes are data; only a failure to search throws. */
export type SearchOutcome = 'success' | 'empty' | 'error' | 'timeout' | 'hitl' | 'captcha' | 'rate_limited' | 'banned'

/** First 4 KiB of the raw response, kept for debugging. */
export interface SearchRawInfo {
  sourceUrl: string
  status: number
  contentType: string
  preview: string
}

/** Why a human is needed. */
export type HitlReason = 'captcha' | 'cloudflare' | 'rate_limited' | 'banned' | 'login_required'

export interface HitlInfo {
  /** URL of the page showing the CAPTCHA/challenge/login. */
  pageUrl: string
  reason: HitlReason
  provider: string
  query: string
  /** ISO timestamp. */
  trippedAt: string
  strategy: SearchStrategy
  /** Tripwire lock file path, when a tripwire was written. */
  lockPath?: string
}

/** Whether the full response body rides along: `none` (default, metadata only) or `full`. */
export type ContentMode = 'none' | 'full'

export interface SearchResponse {
  provider: string
  query: string
  count: number
  results: SearchResult[]
  outcome: SearchOutcome
  error?: string
  tookMs: number
  attempts: number
  strategy: SearchStrategy
  raw?: SearchRawInfo
  hitl?: HitlInfo
  /** For the `fetch` strategy: which settle signal fired. 'deadline' = never settled. */
  readySignal?: string
  /** Response body content, present when the caller asked for `content: 'full'`. */
  content?: string
  /** Size of the full response body in bytes (reported in every content mode). */
  contentSize?: number
}

/**
 * Network capture config: the core's `CaptureConfig` plus the signed-out wall rule.
 * `emptyRequiresLogin` — for walls that render zero results without a redirect (GitHub code
 * search). When the parsed page has no results AND `pattern` matches the body, the engine
 * answers outcome `hitl` reason `login_required`. Unlike a ban rule it neither writes a
 * tripwire nor arms the provider cooldown: it is a deterministic account requirement.
 */
export interface NetworkCaptureConfig extends CaptureConfig {
  emptyRequiresLogin?: {
    pattern: RegExp
    error: string
    /** Page the HITL window navigates to so the user can sign in; receives the search URL so the
     *  login can return to it. Absent: the window stays on the search page. */
    loginUrl?: (returnTo: string) => string
  }
}

/** DOM strategy config. `structural: true` selects position-based extraction over class names. */
export interface ProviderDomConfig {
  waitFor: string
  extract: DomExtractor
  structural?: true
}

export interface ProviderConfig {
  id: string
  name: string
  /** Short description shown in the provider listing. */
  help?: string
  /** Qualifier examples (`syntax  description`) shown to callers. */
  qualifierExamples: readonly string[]
  url: (query: string) => string
  /** Primary and fallback strategies. */
  strategies: {
    primary: SearchStrategy
    fallback?: SearchStrategy
  }
  /** Config for the network capture strategy (primary or fallback). */
  network?: NetworkCaptureConfig
  /** Network config for the FALLBACK 'network' strategy when it must differ from `network`
   *  (GitHub: primary = public JSON API; fallback = rendered search page, embedded-json). */
  fallbackNetwork?: NetworkCaptureConfig
  /** Config for the DOM tree strategy. */
  dom?: ProviderDomConfig
  /** Search in the Chrome profile's own session (cookies) instead of an isolated context.
   *  For providers whose results exist only for a signed-in account (GitHub code search). */
  sharedProfile?: true
  bans: BanRule[]
  retry: RetryConfig
}
