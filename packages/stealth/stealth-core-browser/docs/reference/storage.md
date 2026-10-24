# `/storage` — Read-Only Chrome Data Access

The storage module provides read-only access to Chrome's local databases — History, Cookies, Bookmarks, and Profile data — directly from the filesystem.

All SQLite databases are opened in **immutable mode** (`mode=ro&immutable=1` + `PRAGMA query_only = ON`). This means:
- No file locking — multiple processes can read simultaneously
- No risk of corrupting Chrome's databases
- Chrome can remain open while you query

**Trade-off.** `immutable=1` declares that the file cannot change, so SQLite ignores the write-ahead log (`-wal`) and takes no locks. Rows Chrome has written but not yet checkpointed into the main file are invisible, and a read that overlaps a Chrome write can be stale or, rarely, inconsistent. Treat every reader as a view of the last checkpoint. If you need the very latest rows, copy the database together with its `-wal` and `-shm` files and open the copy.

## `openDb(dbPath)` — Immutable SQLite Helper

The core function used by all storage clients. Opens any SQLite database in read-only immutable mode.

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { openDb } = storage

const db = openDb('/path/to/database.sqlite')
// Database is opened with: ...?mode=ro&immutable=1 + PRAGMA query_only = ON
// Use db.prepare().all()/.get() to query, then db.close()
```

## Timestamps

Chrome stores times as microseconds since 1601-01-01 UTC. The readers convert them to `Date` with sub-second precision (the microsecond value is divided as a real number, never truncated to whole seconds). A stored `0` or empty value is "unset" and is surfaced as `null` (cookie creation/last-access, bookmark dates) rather than as the 1601 epoch.

## `HistoryClient`

Reads Chrome's `History` SQLite database (typically at `~/Library/Application Support/Google/Chrome-CDP/Default/History`).

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { HistoryClient } = storage

const history = new HistoryClient()
// Or with a custom profile directory:
// const history = new HistoryClient('/path/to/profile')
```

### Constructor

```typescript
new HistoryClient(profileDir?: string)
```

If no `profileDir` is given, defaults to the Chrome-CDP profile at `~/Library/Application Support/Google/Chrome-CDP`.

### Properties

| Property | Type | Description |
|---|---|---|
| `path` | `string` | Absolute path to the History database file |

### Visit Queries

#### `getLastVisit()` — Most recent visit

```typescript
const last = history.getLastVisit()
if (last) {
  console.log(`Last visited: ${last.title} (${last.url})`)
  console.log(`  at ${last.visitTime.toISOString()}`)
  console.log(`  transition: ${last.transitionType}`)
  console.log(`  duration: ${last.visitDurationMs}ms`)
}
```

**Filters:** Only returns visits that are user-initiated (`CoreTransition` != AUTO_SUBFRAME, MANUAL_SUBFRAME, or KEYWORD_GENERATED) and not excluded by the Chrome bookmark/autocomplete flag.

#### `getRecentVisits(limit?, offset?)` — Recent visit list

```typescript
const visits = history.getRecentVisits(10, 0) // latest 10
for (const v of visits) {
  console.log(`${v.visitTime.toISOString()} — ${v.title}`)
}
```

#### `isRecentlyUsed(withinMinutes?)` — Activity check

Used by `ChromeManager`'s safety check. Returns `true` if the most recent visit is within the given window.

```typescript
if (history.isRecentlyUsed(2)) {
  console.log('Chrome was used within the last 2 minutes')
}
```

#### `getRedirectChain(visitId)` — Redirect chain

Uses a recursive CTE to trace the redirect chain for a visit.

```typescript
const chain = history.getRedirectChain(visitId)
// → [{ visitId, url, depth }, ...]
```

### URL Queries

#### `getUrlInfo(urlOrId)` — URL details

```typescript
const info = history.getUrlInfo('https://example.com')
// or: history.getUrlInfo(42)

if (info) {
  console.log(`${info.url} — visited ${info.visitCount} times`)
  console.log(`Last visit: ${info.lastVisitTime.toISOString()}`)
}
```

#### `searchUrls(query, limit?)` — URL search

```typescript
const results = history.searchUrls('typescript', 20)
for (const r of results) {
  console.log(`${r.title}: ${r.url} (${r.visitCount} visits)`)
}
```

### Statistics

#### `getVisitStats(days?)` — Daily visit stats

Counts one visit per navigation: redirect hops (a visit whose transition carries the redirect qualifier and that is not the end of its chain) are not counted, the same rule `getTransitionBreakdown` applies. Each day carries its own `transitionBreakdown`.

```typescript
const stats = history.getVisitStats(30) // last 30 days
for (const s of stats) {
  console.log(`${s.date}: ${s.visits} visits, ${s.uniqueUrls} unique URLs`)
}
```

#### `getTransitionBreakdown(days?)` — Transition type breakdown

Core transition types over the window, counted per navigation (chain-end visits only), most frequent first.

```typescript
const breakdown = history.getTransitionBreakdown(30)
console.log(breakdown)
// → { LINK: 42, TYPED: 8, RELOAD: 3, ... }
```

### Keyword Search Terms

#### `getSearchTermsForUrl(url)`

```typescript
const terms = history.getSearchTermsForUrl('https://github.com/search')
// → [{ term: 'typescript', normalizedTerm: 'typescript' }, ...]
```

### Clusters and annotations

| Method | Returns | Notes |
|---|---|---|
| `getClusterData()` | `ClusterInfo[]` | Reads the `clusters` and `clusters_and_visits` tables; empty when Chrome has not computed journeys |
| `getContentAnnotations(visitId)` | `Record<string, unknown> \| null` | The `content_annotations` row of the visit, or `null` |
| `getContextAnnotations(visitId)` | `Record<string, unknown> \| null` | The `context_annotations` row of the visit, or `null` |

## `CookieClient`

Reads Chrome's `Cookies` SQLite database.

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { CookieClient } = storage

const cookies = new CookieClient()
// const cookies = new CookieClient('/path/to/profile')
```

### Constructor

```typescript
new CookieClient(profileDir?: string)
```

### Methods

#### `getCookies(hostFilter?, opts?)` — Query cookies

Returns up to 200 cookies, ordered by last access time descending.

```typescript
// All cookies
const all = cookies.getCookies()

// Filtered by host
const example = cookies.getCookies('example.com')
for (const c of example) {
  console.log(`${c.name}=${c.value}`)
  console.log(`  secure: ${c.isSecure}, httpOnly: ${c.isHttpOnly}`)
  console.log(`  samesite: ${c.samesite}, priority: ${c.priority}`)
  console.log(`  last accessed: ${c.lastAccessUtc?.toISOString() ?? 'never'}`)
}
```

**Values are secrets.** Every cookie read accepts `{ redactValues: true }` as its last argument; each `value` is then `'[redacted]'` (`COOKIE_REDACTED`).

```typescript
const safe = cookies.getCookies('example.com', { redactValues: true })
```

#### `getCookiesByDomain(domain, opts?)` — Domain filter

```typescript
const github = cookies.getCookiesByDomain('github.com')
```

#### `getCookiesForHostname(hostname, opts?)` — what a request to a host would carry

Matches by domain, not by substring: the cookies stored for exactly that host (`www.example.com`) and the domain cookies of the host and each parent domain (`.www.example.com`, `.example.com`), never the bare top-level domain. `notexample.com` and `example.com.evil.net` do not match `example.com`. The host keys are matched in SQL, so the 200-row cap of an unfiltered read cannot hide a match.

```typescript
const forPage = cookies.getCookiesForHostname('www.github.com')
```

### `CookieInfo` type

```typescript
interface CookieInfo {
  name: string
  value: string
  host: string
  path: string
  creationUtc: Date | null   // null when Chrome stored 0 (unset)
  lastAccessUtc: Date | null // null when Chrome stored 0 (unset)
  hasExpires: boolean
  expiresUtc: Date | null
  isSecure: boolean
  isHttpOnly: boolean
  samesite: string        // 'unspecified' | 'lax' | 'strict' | 'none'
  priority: string        // 'medium' | 'low' | 'high'
}
```

## `BookmarkClient`

Reads Chrome's `Bookmarks` JSON file (not a SQLite database — it's a JSON file at `Default/Bookmarks`).

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { BookmarkClient } = storage

const bookmarks = new BookmarkClient()
```

### Constructor

```typescript
new BookmarkClient(profileDir?: string)
```

### Methods

#### `getBookmarks()` — Full bookmark tree

Returns the bookmark tree from all root folders (bookmark bar, other bookmarks, synced, managed).

```typescript
const roots = bookmarks.getBookmarks()
for (const node of roots) {
  printBookmarks(node, '')
}

function printBookmarks(node: BookmarkNode, indent: string) {
  if (node.type === 'url') {
    console.log(`${indent}🔗 ${node.name} → ${node.url}`)
  } else {
    console.log(`${indent}📁 ${node.name}`)
    for (const child of (node.children ?? [])) {
      printBookmarks(child, indent + '  ')
    }
  }
}
```

### `BookmarkNode` type

```typescript
interface BookmarkNode {
  id: string
  name: string
  url?: string
  dateAdded?: Date
  dateModified?: Date
  children?: BookmarkNode[]
  type: 'url' | 'folder'
}
```

### Search

| Method | Returns | Notes |
|---|---|---|
| `searchBookmarks(query)` | `Array<{name, url, path}>` | Case-insensitive match on the bookmark name or URL; `path` is the folder path; `[]` for an empty query |

```typescript
const hits = bookmarks.searchBookmarks('typescript')
```

## `ProfileClient`

Read-only client for the non-history data files of a Chrome profile (top sites, favicons, autofill, search engines, preferences, extensions). The open tabs of a running Chrome come from `listPageTargets()`; the profile's session files are not parsed. Every database is opened immutable and read-only.

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { ProfileClient } = storage
```

### Constructor

```typescript
new ProfileClient(profileDir?: string)
```

### Properties

| Property | Type | Description |
|---|---|---|
| `defaultDir` | `string` | Path to the `Default` profile directory |

### Methods

| Method | Returns | Status |
|---|---|---|
| `getTopSites(limit?)` | `Array<{url, title, score}>` | Implemented |
| `getFaviconData(pageUrl)` | `{url, data?, mimeType?} \| null` | Implemented |
| `getAutofillData({ redactValues? })` | `Array<{name, value, count, lastUsed}>`, newest first, at most 100 | Implemented. Values are personal data: `redactValues: true` replaces each with `[REDACTED]` |
| `getSearchEngines()` | `Array<{name, keyword, url}>` | Implemented |
| `getPreference(key)` | `T \| undefined` | Implemented (dotted key path) |
| `getExtensionIds()` | `string[]` | Implemented |
| `hasSavedCredentials()` | `boolean` | Implemented |

## Path Helpers

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { HistoryClient, CookieClient, BookmarkClient, ProfileClient } = storage

// Each client takes an optional profile directory; with none it reads the
// dedicated CDP profile, resolved per platform:
//   macOS   ~/Library/Application Support/Google/Chrome-CDP
//   Windows %LOCALAPPDATA%\Google\Chrome-CDP
//   Linux   $XDG_CONFIG_HOME/google/Chrome-CDP (default ~/.config/google/Chrome-CDP)
const history = new HistoryClient()
const everyday = new HistoryClient('/path/to/everyday/Chrome/profile')
```

The path helpers (`chromeProfileDir`, `defaultChromeDir`, `googleSupportDir`) are internal; the package root does not export them.

## Shared Types

```typescript
interface ChromeVisit {
  id: number
  urlId: number
  url: string
  title: string
  visitTimeUnix: number
  visitTime: Date
  transitionType: string
  transitionRaw: number
  fromVisitId: number
  visitDurationMs: number
  openerVisitId: number
}

interface UrlInfo {
  id: number
  url: string
  title: string
  visitCount: number
  typedCount: number
  lastVisitTime: Date
  hidden: boolean
}

interface VisitStat {
  date: string
  visits: number
  uniqueUrls: number
  transitionBreakdown: Record<string, number>
}

interface RedirectChainEntry {
  visitId: number
  url: string
  depth: number
}

interface SessionTab {
  tabId: number
  url: string
  title: string
  lastActiveTime?: Date
  pinned: boolean
  navigationIndex: number
  navigationCount: number
}
```

## SQLite Architecture

All database access uses Node.js 22+'s built-in `node:sqlite` module — no external dependencies. The `openDb` helper:

```typescript
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

function openDb(dbPath: string) {
  // pathToFileURL percent-encodes '?', '#' and '%' in the path, so a profile directory cannot change the URI's meaning
  const uri = pathToFileURL(dbPath)
  uri.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(uri.href)
  db.exec('PRAGMA query_only = ON')
  return db
}
```

Each method call opens, queries, and closes the database. This is intentional — it avoids holding locks across async boundaries and works correctly even when Chrome is actively writing to the same database.

### Chrome Timestamp Conversion

Chrome stores timestamps as microseconds since 1601-01-01 (Windows epoch). The `toUnixTimeSql` helper converts them in SQL:

```
(column / 1000000) - 11644473600
```

The `chromeTimeToDate()` helper does the same conversion in JavaScript.
