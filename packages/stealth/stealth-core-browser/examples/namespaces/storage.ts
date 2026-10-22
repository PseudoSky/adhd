/**
 * Scenario: read-only-profile-audit -- audit which of the open tabs the dedicated profile already knows,
 * read-only and without touching Chrome's files: the history of each open page,
 * bookmarks matching a topic and the profile's top sites.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { cdp, storage } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP host (default 127.0.0.1). */
  host?: string
  /** CDP remote-debugging port of the controlled Chrome. */
  port?: number
  /** Chrome user data directory to read (default: the dedicated CDP profile). */
  profileDir?: string
  /** Bookmark search text. */
  topic?: string
}

export interface ProfileAudit {
  tabs: Array<{ url: string; visitCount: number | null }>
  recentVisitUrls: string[]
  bookmarks: Array<{ name: string; url: string; path: string }>
  topSites: Array<{ url: string; title: string; score: number }>
}

export async function run({ host = '127.0.0.1', port = 9333, profileDir, topic = 'docs' }: RunOptions = {}): Promise<ProfileAudit> {
  const history = new storage.HistoryClient(profileDir)
  const bookmarks = new storage.BookmarkClient(profileDir)
  const profile = new storage.ProfileClient(profileDir)

  const pages = await cdp.listPageTargetsOnly(`${host}:${port}`)
  const tabs = pages.map((p) => ({ url: p.url, visitCount: history.getUrlInfo(p.url)?.visitCount ?? null }))

  return {
    tabs,
    recentVisitUrls: history.getRecentVisits(5).map((v) => v.url),
    bookmarks: bookmarks.searchBookmarks(topic),
    topSites: profile.getTopSites(3),
  }
}
