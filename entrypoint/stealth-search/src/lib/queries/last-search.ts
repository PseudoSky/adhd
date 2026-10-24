/**
 * @adhd/stealth-search — src/lib/queries/last-search.ts
 *
 * Recovers the last search from the Chrome profile's history by reading the core
 * `storage.history` API. For a Google results page the keyword is read from the visit URL's `q`
 * parameter; when the URL carries none, from the history's own keyword-search-terms table.
 * This file holds no SQL, no profile path and no database driver: the core owns all of that.
 *
 * Inventory row: I-31 (Google-history keyword recovery).
 * Ticket 8468f7b1 · plan state search-port-providers.
 */
import { storage } from '@adhd/stealth-core-browser'
import type { ChromeVisit } from '@adhd/stealth-core-browser'

export interface LastSearchResult {
  visit: ChromeVisit
  isFromSearchEngine: boolean
  /** Provider id of the engine whose results page the visit was, or null. */
  searchEngine: string | null
  /** The search keyword for a Google results page; null for every other visit. */
  keyword: string | null
}

/** The slice of the core history client this module reads (the real `storage.HistoryClient` satisfies it). */
export interface LastVisitSource {
  getLastVisit(): ChromeVisit | null
  getSearchTermsForUrl(url: string): Array<{ term: string; normalizedTerm: string }>
}

const SEARCH_ENGINE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['duckduckgo', /duckduckgo\.com\/html/],
  ['google', /google\.com\/search/],
  ['arxiv', /arxiv\.org\/search/],
  ['github', /github\.com\/search/],
  ['npm', /registry\.npmjs\.org/],
  ['maven', /search\.maven\.org/],
  ['wikipedia', /en\.wikipedia\.org\/w\/api/],
  ['crates', /crates\.io\/api/],
  ['pypi', /pypi\.org\/search/],
]

function googleKeyword(history: LastVisitSource, url: string): string | null {
  try {
    const q = new URL(url).searchParams.get('q')
    if (q !== null && q.trim() !== '') return q.trim()
  } catch {
    // Not a parseable URL: fall through to the history's keyword table.
  }
  return history.getSearchTermsForUrl(url)[0]?.term ?? null
}

/**
 * The last visit and, when it was a search-engine results page, which engine and (Google) which
 * keyword. Null for an empty history. `history` defaults to the core's `storage.HistoryClient`
 * on the default profile.
 */
export function getLastSearchFromHistory(history: LastVisitSource = new storage.HistoryClient()): LastSearchResult | null {
  const visit = history.getLastVisit()
  if (!visit) return null

  const url = visit.url.toLowerCase()
  const match = SEARCH_ENGINE_PATTERNS.find(([, pattern]) => pattern.test(url))
  const searchEngine = match ? match[0] : null

  return {
    visit,
    isFromSearchEngine: searchEngine !== null,
    searchEngine,
    keyword: searchEngine === 'google' ? googleKeyword(history, visit.url) : null,
  }
}
