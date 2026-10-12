/**
 * stealth-browser/src/lib/types.ts — Shared types for the ADHD package.
 *
 * Consolidated from cdp-query-client.ts (CDP query types) and
 * search-types.ts (search / parsing types).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// From cdp-query-client.ts
// ═══════════════════════════════════════════════════════════════════════════════

export interface CdpTargetInfo {
  targetId: string
  type: 'page' | 'iframe' | 'worker' | 'service_worker' | 'browser' | 'tab' | 'background_contents'
  title: string
  url: string
  attached: boolean
  browserContextId?: string
  openerId?: string
  parentId?: string
  subtype?: string
}

export interface ChromeVisit {
  id: number
  urlId: number
  url: string
  title: string
  /** Unix timestamp in seconds (from SQL computation, avoids BigInt). */
  visitTimeUnix: number
  /** JavaScript Date. */
  visitTime: Date
  /** Core transition type name. */
  transitionType: string
  /** Transition bitfield value. */
  transitionRaw: number
  fromVisitId: number
  /** Visit duration in ms. */
  visitDurationMs: number
  openerVisitId: number
}

export interface UrlInfo {
  id: number
  url: string
  title: string
  visitCount: number
  typedCount: number
  lastVisitTime: Date
  hidden: boolean
}

export interface VisitStat {
  date: string
  visits: number
  uniqueUrls: number
  transitionBreakdown: Record<string, number>
}

export interface RedirectChainEntry {
  visitId: number
  url: string
  depth: number
}

export interface ClusterInfo {
  clusterId: number
  label: string | null
  visits: Array<{ visitId: number; score: number; url: string; title: string }>
}

export interface CookieInfo {
  name: string
  value: string
  host: string
  path: string
  creationUtc: Date
  lastAccessUtc: Date
  hasExpires: boolean
  expiresUtc: Date | null
  isSecure: boolean
  isHttpOnly: boolean
  samesite: string
  priority: string
}

export interface BookmarkNode {
  id: string
  name: string
  url?: string
  dateAdded?: Date
  dateModified?: Date
  children?: BookmarkNode[]
  type: 'url' | 'folder'
}

export interface SessionTab {
  tabId: number
  url: string
  title: string
  lastActiveTime?: Date
  pinned: boolean
  navigationIndex: number
  navigationCount: number
}

export interface ChromeVersion {
  browserVersion: string
  protocolVersion: string
  userAgent: string
  jsVersion: string
  v8Version: string
}

export interface SystemInfo {
  modelName: string
  modelVersion: string
  commandLine: string
  gpu: { vendor: string; device: string; driverVersion: string }
}

export interface ProcessInfo {
  type: string
  id: number
  cpuTime: number
}

export interface PageMetrics {
  timestamp: number
  documents: number
  nodes: number
  jsHeapUsedSize: number
  jsHeapTotalSize: number
  navigationStart: number
  domContentLoaded: number
  firstMeaningfulPaint: number
  layoutCount: number
  scriptDuration: number
  taskDuration: number
}

export interface BrowserWindowBounds {
  windowId: number
  left: number
  top: number
  width: number
  height: number
  windowState: 'normal' | 'minimized' | 'maximized' | 'fullscreen'
}

export interface ChromeActivity {
  activePages: number
  pageTargets: string[]
  lastVisit: ChromeVisit | null
  recentlyUsed: boolean
  meta: {
    checkedAt: string
    cdpHost: string
    profileDir: string
  }
}

export interface ChromeMemoryCounters {
  nodes: number
  documents: number
  jsEventListeners: number
  layouts: number
  recalcStyleCount: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// From search-types.ts (shared search types)
// ═══════════════════════════════════════════════════════════════════════════════

export type BanSignal =
  | 'captcha'
  | 'banned'
  | 'rate_limited'
  | 'login_required'

export interface BanRule {
  name: string
  signal: BanSignal
  /** Check the response URL path. */
  checkUrl?: RegExp
  /** Check HTTP status code. */
  checkStatus?: number[]
  /** Check if body contains a pattern. */
  checkBody?: RegExp
}

export interface RetryConfig {
  maxAttempts: number
  baseDelayMs: number
  onCaptcha: 'retry' | 'abort' | 'hitl'
  onRateLimit: 'retry' | 'abort' | 'hitl'
  onTimeout: 'retry' | 'abort'
  onBan: 'abort' | 'hitl'
}

export interface SearchResultSource {
  provider: string
  strategy: 'network' | 'dom'
  capturedUrl: string
  position: number
  capturedAt: string
}

/** Parsed result from a search provider. Renamed from SearchResult. */
export interface ParseResult {
  title: string
  url: string
  snippet: string
  meta?: Record<string, string>
  source?: SearchResultSource
}

export interface DomPattern {
  tag?: string
  attrs?: Record<string, string | RegExp>
  text?: RegExp
}

export interface DomExtractor {
  /** If true, use structural position-based extraction instead of class-based. */
  structural?: boolean
  container?: DomPattern
  title?: DomPattern & { attr?: string }
  link?: DomPattern & { attr: string }
  snippet?: DomPattern
  extra?: Record<string, DomPattern & { attr?: string }>
}

/** Structural extraction config — finds results by DOM position, not classes. */
export interface StructuralExtractor {
  rootSelector: string
  itemTag: string
  itemDepth: number
  headingTag: string
  linkTag: string
  snippetTag: string
  searchDepth: number
}

/** Network capture config. Renamed from NetworkCaptureConfig. */
export interface CaptureConfig {
  urlPattern: string
  parser: 'html' | 'json' | 'xml' | 'embedded-json'
  resultSelector: string
  fields: {
    title: string
    url: string
    snippet: string
    linkSelector?: string
    /** Optional URL template with `{}` placeholder replaced by the extracted url field value.
     *  E.g. `'https://en.wikipedia.org/?curid={}'` turns pageid `30621` into a real URL.
     *  E.g. `'https://developer.mozilla.org{}'` turns relative path `/en-US/docs/...` into a full URL. */
    urlTemplate?: string
    meta?: Record<string, string>
    clean?: {
      title?: { pattern: string; replace: string }
      snippet?: { pattern: string; replace: string }
    }
  }
  /** For embedded-json parser: which data-target attribute to match on the <script> tag. */
  dataTarget?: string
  /** How many lines from the snippets array to include in each result's snippet. Default: 1. */
  snippetLines?: number
  /** Override URL for directFetch. If set, use this instead of provider.url(query). */
  apiUrl?: string
  extraWaitMs?: number
  directFetch?: boolean
}

export interface CapturedRequest {
  requestId: string
  url: string
  method: string
  status: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  base64Encoded?: boolean
  finished: boolean
  isNavigation: boolean
}
