# `/storage` — Read-Only Chrome Data Access

The storage module provides read-only access to Chrome's local databases — History, Cookies, Bookmarks, and Profile data — directly from the filesystem.

All SQLite databases are opened in **immutable mode** (`mode=ro&immutable=1` + `PRAGMA query_only = ON`). This means:
- No file locking — multiple processes can read simultaneously
- No risk of corrupting Chrome's databases
- Chrome can remain open while you query

## `openDb(dbPath)` — Immutable SQLite Helper

The core function used by all storage clients. Opens any SQLite database in read-only immutable mode.

```typescript
import { openDb } from '@adhd/stealth-core-browser/storage'

const db = openDb('/path/to/database.sqlite')
// Database is opened with: ...?mode=ro&immutable=1 + PRAGMA query_only = ON
// Use db.prepare().all()/.get() to query, then db.close()
```

## `HistoryClient`

Reads Chrome's `History` SQLite database (typically at `~/Library/Application Support/Google/Chrome-CDP/Default/History`).

```typescript
import { HistoryClient } from '@adhd/stealth-core-browser/storage'

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

```typescript
const stats = history.getVisitStats(30) // last 30 days
for (const s of stats) {
  console.log(`${s.date}: ${s.visits} visits, ${s.uniqueUrls} unique URLs`)
}
```

#### `getTransitionBreakdown(days?)` — Transition type breakdown

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

### Stub Methods

These methods are not yet implemented and return empty/default values:

| Method | Returns | Status |
|---|---|---|
| `getClusterData()` | `ClusterInfo[]` (empty) | 🔴 Not yet implemented |
| `getContentAnnotations(visitId)` | `Record<string, unknown> \| null` | 🔴 Not yet implemented |
| `getContextAnnotations(visitId)` | `Record<string, unknown> \| null` | 🔴 Not yet implemented |

## `CookieClient`

Reads Chrome's `Cookies` SQLite database.

```typescript
import { CookieClient } from '@adhd/stealth-core-browser/storage'

const cookies = new CookieClient()
// const cookies = new CookieClient('/path/to/profile')
```

### Constructor

```typescript
new CookieClient(profileDir?: string)
```

### Methods

#### `getCookies(hostFilter?)` — Query cookies

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
  console.log(`  last accessed: ${c.lastAccessUtc.toISOString()}`)
}
```

#### `getCookiesByDomain(domain)` — Domain filter

```typescript
const github = cookies.getCookiesByDomain('github.com')
```

### `CookieInfo` type

```typescript
interface CookieInfo {
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
  samesite: string        // 'unspecified' | 'lax' | 'strict' | 'none'
  priority: string        // 'medium' | 'low' | 'high'
}
```

## `BookmarkClient`

Reads Chrome's `Bookmarks` JSON file (not a SQLite database — it's a JSON file at `Default/Bookmarks`).

```typescript
import { BookmarkClient } from '@adhd/stealth-core-browser/storage'

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

### Stub Method

| Method | Returns | Status |
|---|---|---|
| `searchBookmarks(query)` | `Array<{name, url, path}>` (empty) | 🔴 Not yet implemented |

## `ProfileClient`

Stub client for Chrome profile data. All methods return empty/default values.

```typescript
import { ProfileClient } from '@adhd/stealth-core-browser/storage'
```

### Constructor

```typescript
new ProfileClient(profileDir?: string)
```

### Properties

| Property | Type | Description |
|---|---|---|
| `defaultDir` | `string` | Path to the `Default` profile directory |

### Stub Methods

| Method | Returns | Status |
|---|---|---|
| `getTopSites(limit?)` | `Array<{url, title, score}>` (empty) | 🔴 Not yet implemented |
| `getFaviconData(pageUrl)` | `{url, data?, mimeType?} \| null` | 🔴 Not yet implemented |
| `getAutofillData()` | `Array<{name, value, count, lastUsed}>` (empty) | 🔴 Not yet implemented |
| `getSearchEngines()` | `Array<{name, keyword, url}>` (empty) | 🔴 Not yet implemented |
| `getOpenTabs()` | `SessionTab[]` (empty) | 🔴 Not yet implemented |
| `getPreference(key)` | `T \| undefined` | 🔴 Not yet implemented |
| `getExtensionIds()` | `string[]` (empty) | 🔴 Not yet implemented |
| `hasSavedCredentials()` | `false` | 🔴 Not yet implemented |

## Path Helpers

```typescript
import { chromeProfileDir, defaultChromeDir } from '@adhd/stealth-core-browser/storage'
// Re-exported from adhd/helpers.ts

chromeProfileDir()   // ~/Library/Application Support/Google/Chrome-CDP
defaultChromeDir()   // ~/Library/Application Support/Google/Chrome
```

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

function openDb(dbPath: string) {
  const uri = `file:${dbPath}?mode=ro&immutable=1`
  const db = new DatabaseSync(uri)
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
