# Chrome History SQLite Database Reference

> Complete reference for the `History` SQLite database used by Google Chrome / Chromium.

## 1. File Location

### macOS Paths

| Profile | Path |
|---------|------|
| Default Chrome profile | `~/Library/Application Support/Google/Chrome/Default/History` |
| Chrome-CDP (remote debug) profile | `~/Library/Application Support/Google/Chrome/Default/History` |
| Canary | `~/Library/Application Support/Google/Chrome Canary/Default/History` |
| Chromium | `~/Library/Application Support/Chromium/Default/History` |

If a custom `--user-data-dir` is used, the file is at `<user-data-dir>/Default/History`.

### Notes

- The filename is `History` with **no file extension**.
- It is *not* called `history.db` in any official Chrome profile.
- A Write-Ahead Log (WAL) journal accompanies the database as `History-wal` and `History-shm` while Chrome is running.
- The companion favicons database is at `Favicons` in the same directory.

## 2. Tables

### 2.1 `urls`

Stores one row per unique URL visited.

```sql
CREATE TABLE urls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             LONGVARCHAR,
    title           LONGVARCHAR,
    visit_count     INTEGER DEFAULT 0 NOT NULL,
    typed_count     INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL,
    hidden          INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS urls_url_index ON urls (url);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER` | Primary key, autoincrement. Used as foreign key from `visits.url`. |
| `url` | `LONGVARCHAR` | The URL string (e.g. `https://example.com/page`). |
| `title` | `LONGVARCHAR` | Page title. |
| `visit_count` | `INTEGER` | Number of visits. May not exactly match `visits` table count (some "useless" transitions are excluded). |
| `typed_count` | `INTEGER` | Number of times typed in the omnibox. |
| `last_visit_time` | `INTEGER` | Chrome timestamp of the most recent visit. |
| `hidden` | `INTEGER` | `0` = visible, `1` = hidden (typically for subframe URLs not shown in UI). |

### 2.2 `visits`

Stores one row per individual page visit, including redirects and subframes.

```sql
CREATE TABLE visits(
    id                               INTEGER PRIMARY KEY AUTOINCREMENT,
    url                              INTEGER NOT NULL,
    visit_time                       INTEGER NOT NULL,
    from_visit                       INTEGER,
    external_referrer_url            TEXT,
    transition                       INTEGER DEFAULT 0 NOT NULL,
    segment_id                       INTEGER,
    visit_duration                   INTEGER DEFAULT 0 NOT NULL,
    incremented_omnibox_typed_score  BOOLEAN DEFAULT FALSE NOT NULL,
    opener_visit                     INTEGER,
    originator_cache_guid            TEXT,
    originator_visit_id              INTEGER,
    originator_from_visit            INTEGER,
    originator_opener_visit          INTEGER,
    is_known_to_sync                 BOOLEAN DEFAULT FALSE NOT NULL,
    consider_for_ntp_most_visited    BOOLEAN DEFAULT FALSE NOT NULL,
    visited_link_id                  INTEGER DEFAULT 0 NOT NULL,
    app_id                           TEXT
);

CREATE INDEX IF NOT EXISTS visits_url_index         ON visits (url);
CREATE INDEX IF NOT EXISTS visits_from_index        ON visits (from_visit);
CREATE INDEX IF NOT EXISTS visits_time_index        ON visits (visit_time);
CREATE INDEX IF NOT EXISTS visits_originator_id_index ON visits (originator_visit_id);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER` | Primary key, autoincrement. |
| `url` | `INTEGER` | Foreign key to `urls.id`. |
| `visit_time` | `INTEGER` | Chrome timestamp (microseconds since 1601-01-01). |
| `from_visit` | `INTEGER` | Visit ID of the referrer/redirect source. `0` = none. |
| `external_referrer_url` | `TEXT` | Referrer URL when the referrer is *not* a visit in the DB (e.g. side panel, external app). |
| `transition` | `INTEGER` | Bitfield of `ui::PageTransition` values (see §5). |
| `segment_id` | `INTEGER` | Segment ID for "Most Visited" aggregation. `0` = null. |
| `visit_duration` | `INTEGER` | Duration in microseconds (time delta). |
| `incremented_omnibox_typed_score` | `BOOLEAN` | Whether this visit incremented the omnibox typed count. |
| `opener_visit` | `INTEGER` | Visit ID that opened this one (cross-tab). `0` = none. |
| `originator_cache_guid` | `TEXT` | For synced visits: the originator device's sync cache GUID. |
| `originator_visit_id` | `INTEGER` | For synced visits: the visit ID on the originator device. |
| `originator_from_visit` | `INTEGER` | For synced visits: originator's `from_visit` equivalent. |
| `originator_opener_visit` | `INTEGER` | For synced visits: originator's `opener_visit` equivalent. |
| `is_known_to_sync` | `BOOLEAN` | Whether the visit is known to Chrome Sync. |
| `consider_for_ntp_most_visited` | `BOOLEAN` | Whether this navigation should contribute to NTP Most Visited tiles. |
| `visited_link_id` | `INTEGER` | FK to `visited_links.id` for LINK/MANUAL_SUBFRAME transitions. `0` = invalid. |
| `app_id` | `TEXT` | Android-only. Package name of the Custom Tab app. |

### 2.3 `visit_source`

Maps visit IDs to their source type. Only non-browsed sources are recorded.

```sql
CREATE TABLE visit_source(
    id     INTEGER PRIMARY KEY,
    source INTEGER NOT NULL
);
```

| `source` Value | Constant | Description |
|---------------|----------|-------------|
| `0` | `SOURCE_SYNCED` | Synchronized from another device |
| `1` | `SOURCE_BROWSED` | User browsed (not recorded in table) |
| `2` | `SOURCE_EXTENSION` | Added by an extension |
| `3` | `SOURCE_FIREFOX_IMPORTED` | Imported from Firefox |
| `4` | `SOURCE_IE_IMPORTED` | Imported from Internet Explorer |
| `5` | `SOURCE_SAFARI_IMPORTED` | Imported from Safari |
| `6` | `SOURCE_ACTOR` | Added by the GLIC actor |
| `7` | `SOURCE_OS_MIGRATION_IMPORTED` | OS-level migration import |

### 2.4 `keyword_search_terms`

Maps search-engine keyword URLs to search terms.

```sql
CREATE TABLE keyword_search_terms (
    keyword_id      INTEGER NOT NULL,
    url_id          INTEGER NOT NULL,
    term            LONGVARCHAR NOT NULL,
    normalized_term LONGVARCHAR NOT NULL
);
```

| Column | Type | Description |
|--------|------|-------------|
| `keyword_id` | `INTEGER` | ID of the `TemplateURL` (search engine). |
| `url_id` | `INTEGER` | FK to `urls.id`. |
| `term` | `LONGVARCHAR` | The raw search term. |
| `normalized_term` | `LONGVARCHAR` | Lowercased, whitespace-collapsed version of `term`. |

Indices:
- `keyword_search_terms_index1` ON (`keyword_id`, `normalized_term`)
- `keyword_search_terms_index2` ON (`url_id`)
- `keyword_search_terms_index3` ON (`term`)

### 2.5 `downloads`

Stores download history.

```sql
-- Simplified schema; see Chromium source for full column list.
CREATE TABLE downloads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    current_path    LONGVARCHAR,
    target_path     LONGVARCHAR,
    start_time      INTEGER NOT NULL,
    received_bytes  INTEGER NOT NULL,
    total_bytes     INTEGER NOT NULL,
    state           INTEGER NOT NULL,
    danger_type     INTEGER NOT NULL,
    interrupt_reason INTEGER NOT NULL,
    hash            BLOB,
    end_time        INTEGER NOT NULL,
    opened          INTEGER NOT NULL,
    last_access_time INTEGER NOT NULL,
    transient       INTEGER,
    referrer        VARCHAR,
    site_url        VARCHAR,
    embedder_download_data VARCHAR,
    ...
);
```

### 2.6 `downloads_url_chains`

Maps download IDs to their URL redirect chain.

```sql
CREATE TABLE downloads_url_chains (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_index INTEGER NOT NULL,
    url    LONGVARCHAR NOT NULL,
    download_id INTEGER NOT NULL
);
```

### 2.7 `segments` and `segment_usage`

Used for the "Most Visited" view on the New Tab Page.

```sql
CREATE TABLE segments (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR NOT NULL,
    url_id INTEGER NOT NULL
);

CREATE TABLE segment_usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_id INTEGER NOT NULL,
    time_slot  INTEGER NOT NULL,
    visit_count INTEGER DEFAULT 0 NOT NULL
);
```

### 2.8 `clusters` and `clusters_and_visits`

Used for the History Clusters / Journeys feature.

```sql
CREATE TABLE clusters(
    cluster_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    should_show_on_prominent_ui_surfaces BOOLEAN NOT NULL,
    label                   VARCHAR,
    raw_label               VARCHAR,
    label_source            INTEGER,
    originator_cache_guid   TEXT,
    originator_cluster_id   INTEGER
);

CREATE TABLE clusters_and_visits(
    cluster_id          INTEGER NOT NULL,
    visit_id            INTEGER NOT NULL,
    score               DECIMAL NOT NULL DEFAULT 0,
    engagement_score    DECIMAL NOT NULL DEFAULT 0,
    url_for_deduping    LONGVARCHAR NOT NULL,
    normalized_url      LONGVARCHAR NOT NULL,
    url_for_display     LONGVARCHAR NOT NULL,
    interaction_state   INTEGER NOT NULL DEFAULT 0
);
```

### 2.9 `content_annotations` and `context_annotations`

Store ML and user-context metadata for each visit.

```sql
CREATE TABLE content_annotations(
    visit_id                INTEGER PRIMARY KEY,
    visibility_score        NUMERIC,
    floc_protected_score    NUMERIC,
    categories              VARCHAR,
    page_topics_model_version INTEGER,
    annotation_flags        INTEGER NOT NULL DEFAULT 0,
    entities                VARCHAR,
    related_searches        VARCHAR,
    search_normalized_url   VARCHAR,
    search_terms            TEXT,
    alternative_title       VARCHAR,
    page_language           VARCHAR,
    password_state          INTEGER DEFAULT 0 NOT NULL,
    has_url_keyed_image     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE context_annotations(
    visit_id                    INTEGER PRIMARY KEY,
    context_annotation_flags    INTEGER NOT NULL DEFAULT 0,
    duration_since_last_visit   INTEGER,
    page_end_reason             INTEGER,
    total_foreground_duration   INTEGER,
    browser_type                INTEGER DEFAULT 0 NOT NULL,
    window_id                   INTEGER DEFAULT -1 NOT NULL,
    tab_id                      INTEGER DEFAULT -1 NOT NULL,
    task_id                     INTEGER DEFAULT -1 NOT NULL,
    root_task_id                INTEGER DEFAULT -1 NOT NULL,
    parent_task_id              INTEGER DEFAULT -1 NOT NULL,
    response_code               INTEGER DEFAULT 0 NOT NULL
);
```

### 2.10 `visited_links`

Triple-key partitioned visited link database.

```sql
CREATE TABLE visited_links(
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    link_url_id     INTEGER NOT NULL,
    top_level_url   LONGVARCHAR NOT NULL,
    frame_url       LONGVARCHAR NOT NULL,
    visit_count     INTEGER DEFAULT 0 NOT NULL
);
```

### 2.11 `typed_url_sync_metadata`

Removed in database version 67 migration. The table should not exist on modern profiles.

### 2.12 `meta`

Key-value metadata table maintained by `sql::MetaTable`.

```sql
-- Managed internally; not explicitly created by Chrome.
CREATE TABLE meta(
    key   LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY,
    value LONGVARCHAR
);
```

Notable keys in use:
| Key | Description |
|-----|-------------|
| `version` | Database schema version (currently `70`) |
| `last_compatible_version` | Minimum compatible version (`16`) |
| `early_expiration_threshold` | Internal threshold for history expiry |
| `may_contain_foreign_visits` | `1` if DB has synced visits from other devices |
| `delete_foreign_visits_until_id` | Visit ID watermark for batched foreign-visit deletion |
| `known_to_sync_visits_exist` | `1` if any visit is marked known-to-sync |

## 3. Complete Column List (from source)

Assembled from the `HISTORY_URL_ROW_FIELDS` and `HISTORY_VISIT_ROW_FIELDS` macros:

**URL row fields** (`urls` table):
`id, url, title, visit_count, typed_count, last_visit_time, hidden`

**Visit row fields** (`visits` table, in order):
`id, url, visit_time, from_visit, external_referrer_url, transition, segment_id, visit_duration, incremented_omnibox_typed_score, opener_visit, originator_cache_guid, originator_visit_id, originator_from_visit, originator_opener_visit, is_known_to_sync, consider_for_ntp_most_visited, visited_link_id, app_id`

## 4. Timestamp Format

### Chrome Time

Chrome stores timestamps as **microseconds since 1601-01-01 00:00:00 UTC** (the Windows NT epoch / FILETIME epoch).

```
chrome_time_micros = number of 10⁻⁶ sec intervals since 1601-01-01 UTC
```

### Conversion Formula

**To Unix time (seconds since 1970-01-01):**

```
unix_time_seconds = (chrome_time_micros / 1_000_000) - 11_644_473_600
```

**In SQLite:**

```sql
-- Convert Chrome timestamp to Unix timestamp (seconds)
SELECT (visit_time / 1000000) - 11644473600 AS unix_ts FROM visits;

-- Convert Chrome timestamp to ISO-8601
SELECT datetime((visit_time / 1000000) - 11644473600, 'unixepoch') AS iso_time FROM visits;

-- Convert current time to Chrome timestamp (for querying recent visits)
SELECT (strftime('%s', 'now') + 11644473600) * 1000000 AS chrome_now;
```

**In Python:**

```python
import datetime

def chrome_to_datetime(chrome_us: int) -> datetime.datetime:
    """Convert Chrome timestamp (µs since 1601-01-01) to Python datetime."""
    unix_sec = (chrome_us / 1_000_000) - 11_644_473_600
    return datetime.datetime.fromtimestamp(unix_sec, tz=datetime.timezone.UTC)

def datetime_to_chrome(dt: datetime.datetime) -> int:
    """Convert Python datetime to Chrome timestamp."""
    unix_sec = dt.timestamp()
    return int((unix_sec + 11_644_473_600) * 1_000_000)
```

**In JavaScript:**

```javascript
function chromeTimeToDate(us) {
  return new Date((us / 1000) - 11644473600000);
}
function dateToChromeTime(d) {
  return (d.getTime() + 11644473600000) * 1000;
}
```

The migration constant `11644473600000000` (or `11644473600` for seconds) can be found in Chromium source at `components/history/core/browser/history_database.cc`:

```cpp
// MigrateTimeEpoch():
"UPDATE urls SET last_visit_time = last_visit_time + 11644473600000000 ..."
"UPDATE visits SET visit_time = visit_time + 11644473600000000 ..."
```

## 5. Transition Types

The `transition` column is an `INTEGER` bitfield combining a core value and optional qualifiers.

### Core Values (mask: `0xFF`)

| Value | Constant | Meaning |
|-------|----------|---------|
| `0` | `PAGE_TRANSITION_LINK` | User clicked a link on another page. |
| `1` | `PAGE_TRANSITION_TYPED` | User typed the URL in the omnibox (or other explicit navigation). |
| `2` | `PAGE_TRANSITION_AUTO_BOOKMARK` | User navigated via a bookmark suggestion. |
| `3` | `PAGE_TRANSITION_AUTO_SUBFRAME` | Automatic subframe navigation (ads, fenced frames). |
| `4` | `PAGE_TRANSITION_MANUAL_SUBFRAME` | User-initiated subframe navigation. |
| `5` | `PAGE_TRANSITION_GENERATED` | User selected a non-URL suggestion in the omnibox (e.g., search). |
| `6` | `PAGE_TRANSITION_AUTO_TOPLEVEL` | Automatic top-level navigation (NTP, DevTools, etc.). |
| `7` | `PAGE_TRANSITION_FORM_SUBMIT` | Form submission. |
| `8` | `PAGE_TRANSITION_RELOAD` | Reload (button, enter in address bar, session restore, undo close tab). |
| `9` | `PAGE_TRANSITION_KEYWORD` | URL generated from a non-default search engine keyword. |
| `10` | `PAGE_TRANSITION_KEYWORD_GENERATED` | Visit generated for a keyword result. |

### Qualifier Flags (mask: `0xFFFFFF00`)

| Value | Constant | Meaning |
|-------|----------|---------|
| `0x00800000` | `PAGE_TRANSITION_BLOCKED` | Navigation was blocked by managed user policy. |
| `0x01000000` | `PAGE_TRANSITION_FORWARD_BACK` | User used Forward/Back button. |
| `0x02000000` | `PAGE_TRANSITION_FROM_ADDRESS_BAR` | Navigation originated from the address bar. |
| `0x04000000` | `PAGE_TRANSITION_HOME_PAGE` | User is navigating to the home page. |
| `0x08000000` | `PAGE_TRANSITION_FROM_API` | Navigation from an external application. |
| `0x10000000` | `PAGE_TRANSITION_CHAIN_START` | Beginning of a redirect chain. |
| `0x20000000` | `PAGE_TRANSITION_CHAIN_END` | Last transition in a redirect chain. |
| `0x40000000` | `PAGE_TRANSITION_CLIENT_REDIRECT` | Client-side redirect (JS, meta refresh). |
| `0x80000000` | `PAGE_TRANSITION_SERVER_REDIRECT` | Server-side redirect (HTTP 3xx). |

### How to Query

```sql
-- Get core transition type
SELECT id, transition & 255 AS core_transition FROM visits;

-- Filter by specific core type (e.g., typed)
SELECT * FROM visits WHERE (transition & 255) = 1;

-- Filter by qualifier (e.g., chain end)
SELECT * FROM visits WHERE (transition & 0x20000000) != 0;

-- Filter by core type + no redirect
SELECT * FROM visits
WHERE (transition & 255) = 1
  AND (transition & 0xC0000000) = 0;
```

### User-Visible Visits

Chrome considers a visit "user-visible" if it satisfies ALL of:
1. Has the `CHAIN_END` (`0x20000000`) bit set
2. Is a main-frame navigation (NOT `AUTO_SUBFRAME` or `MANUAL_SUBFRAME`)
3. Is NOT `KEYWORD_GENERATED`

```sql
-- User-visible visits (Chrome's definition)
SELECT * FROM visits
WHERE (transition & 0x20000000) != 0              -- CHAIN_END
  AND (transition & 255) NOT IN (3, 4, 10);       -- not subframe or keyword_generated
```

## 6. Example Queries

### Last 10 visits with URLs and timestamps

```sql
SELECT u.url, u.title, v.visit_time,
       datetime((v.visit_time / 1000000) - 11644473600, 'unixepoch') AS iso_time,
       (v.transition & 255) AS core_transition
FROM visits v
JOIN urls u ON v.url = u.id
WHERE (v.transition & 0x20000000) != 0
ORDER BY v.visit_time DESC
LIMIT 10;
```

### Check if Chrome was used in the last N minutes

```sql
-- Check if any visits occurred in the last 5 minutes
WITH chrome_now AS (
    SELECT (strftime('%s', 'now') + 11644473600) * 1000000 AS ts
)
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM visits, chrome_now
    WHERE visit_time > chrome_now.ts - (5 * 60 * 1000000)
) THEN 'active' ELSE 'inactive' END AS chrome_status;

-- Get the time since the last visit in minutes
WITH chrome_now AS (
    SELECT (strftime('%s', 'now') + 11644473600) * 1000000 AS ts
)
SELECT MAX((ts - visit_time) / 60000000) AS minutes_since_last_visit
FROM visits, chrome_now;
```

### Get page title for a URL

```sql
SELECT title FROM urls WHERE url = 'https://example.com/page';
```

### Recent visits for a specific domain

```sql
SELECT u.url, u.title, v.visit_time,
       datetime((v.visit_time / 1000000) - 11644473600, 'unixepoch') AS iso_time,
       v.transition & 255 AS transition_type,
       v.visit_duration / 1000000 AS duration_seconds
FROM visits v
JOIN urls u ON v.url = u.id
WHERE u.url LIKE 'https://github.com/%'
  AND (v.transition & 0x20000000) != 0
ORDER BY v.visit_time DESC
LIMIT 20;
```

### Visit count by day (last 30 days)

```sql
SELECT date(datetime((v.visit_time / 1000000) - 11644473600, 'unixepoch')) AS day,
       COUNT(*) AS visits,
       COUNT(DISTINCT u.url) AS unique_urls
FROM visits v
JOIN urls u ON v.url = u.id
WHERE v.visit_time > ((strftime('%s', 'now') - 30*86400 + 11644473600) * 1000000)
  AND (v.transition & 0x20000000) != 0
GROUP BY day
ORDER BY day DESC;
```

### Redirect chain for a specific visit

```sql
WITH RECURSIVE chain(visit_id, url_id, from_visit, depth) AS (
    SELECT id, url, from_visit, 0 FROM visits WHERE id = ?
    UNION ALL
    SELECT v.id, v.url, v.from_visit, c.depth + 1
    FROM visits v
    JOIN chain c ON v.id = c.from_visit
    WHERE c.from_visit != 0 AND c.depth < 32
)
SELECT chain.visit_id, u.url, chain.depth
FROM chain
JOIN urls u ON chain.url_id = u.id
ORDER BY chain.depth ASC;
```

### Search terms associated with a URL

```sql
SELECT kst.term, kst.normalized_term
FROM keyword_search_terms kst
JOIN urls u ON kst.url_id = u.id
WHERE u.url = 'https://www.google.com/search?q=example';
```

### Most visited URLs (all time)

```sql
SELECT u.url, u.title, u.visit_count, u.typed_count,
       datetime((u.last_visit_time / 1000000) - 11644473600, 'unixepoch') AS last_visited
FROM urls u
WHERE u.hidden = 0
ORDER BY u.visit_count DESC
LIMIT 20;
```

### Synthesized visits (keyword_generated, auto_subframe)

```sql
-- Count visits by transition type
SELECT
    CASE (v.transition & 255)
        WHEN 0 THEN 'LINK'
        WHEN 1 THEN 'TYPED'
        WHEN 2 THEN 'AUTO_BOOKMARK'
        WHEN 3 THEN 'AUTO_SUBFRAME'
        WHEN 4 THEN 'MANUAL_SUBFRAME'
        WHEN 5 THEN 'GENERATED'
        WHEN 6 THEN 'AUTO_TOPLEVEL'
        WHEN 7 THEN 'FORM_SUBMIT'
        WHEN 8 THEN 'RELOAD'
        WHEN 9 THEN 'KEYWORD'
        WHEN 10 THEN 'KEYWORD_GENERATED'
    END AS transition_name,
    COUNT(*) AS count
FROM visits v
GROUP BY (v.transition & 255)
ORDER BY count DESC;
```

## 7. SQLite Access Patterns

### Opening the Database Safely

```python
import sqlite3
import os

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/Default/History"
)

# Connect in readonly mode so we never accidentally modify Chrome's DB
conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
conn.execute("PRAGMA query_only = ON;")
conn.row_factory = sqlite3.Row
```

### WAL Mode and Locking

Chrome opens the History database in **Write-Ahead Log (WAL) mode**, which allows concurrent readers without blocking:

- Readers do **not** block writers (Chrome can write while you query).
- Writers do **not** block readers (you can query while Chrome writes).
- You may see a `History-wal` and `History-shm` file while Chrome is running — these are the WAL journal files.
- After Chrome exits, the WAL is checkpointed into the main DB.

⚠️ **Important:**

- Always open the database with `PRAGMA query_only = ON` to prevent accidental writes.
- Do **not** use `PRAGMA locking_mode = EXCLUSIVE` — that would block Chrome.
- If you get a "database is locked" error, it means the WAL checkpoint is running. Retry with a short delay.

```python
conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
conn.execute("PRAGMA journal_mode=WAL;")       # Allow reading WAL content
conn.execute("PRAGMA query_only = ON;")         # Prevent accidental writes
conn.execute("PRAGMA temp_store = MEMORY;")     # Performance
```

### Handling a Locked Database

```python
import sqlite3
import time

def query_history(sql, params=(), retries=3, delay=0.1):
    for attempt in range(retries):
        try:
            conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
            conn.execute("PRAGMA query_only = ON;")
            conn.execute("PRAGMA journal_mode=WAL;")
            cur = conn.execute(sql, params)
            results = cur.fetchall()
            conn.close()
            return results
        except sqlite3.OperationalError as e:
            if "locked" in str(e) and attempt < retries - 1:
                time.sleep(delay)
                continue
            raise
```

### Using `sqlite3` CLI

```bash
# Read-only query from the command line
sqlite3 "file:${HOME}/Library/Application Support/Google/Chrome/Default/History?mode=ro&immutable=1" \
  "SELECT url, title FROM urls ORDER BY last_visit_time DESC LIMIT 5;"
```

## 8. Edge Cases

### Chrome Running (WAL mode)

When Chrome is open, the DB can be read safely via WAL mode. The `History-wal` file may contain uncheckpointed writes. Always set `PRAGMA journal_mode=WAL` before reading to include WAL content.

### Corrupted Database

Chrome handles corruption with:

1. **`RazeDbIfTooOld()`** — if the database version is below the minimum supported version (`15`), the DB is razed and recreated.
2. **`KillHistoryDatabase()`** — on unrecoverable errors, Chrome renames the corrupt DB to `History-corrupted` and creates a fresh one.
3. **Error callback** — Chrome installs a custom error handler that schedules DB deletion on certain SQLite errors.

If you encounter a corrupt DB, the safest approach is to handle `sqlite3.DatabaseError` and report that history data is unavailable.

### Empty Profile / No History

If the profile directory exists but has no `History` file, or the file exists but has no tables:

```sql
-- Check if the urls table exists
SELECT name FROM sqlite_master WHERE type='table' AND name='urls';
-- Check if there are any URLs
SELECT COUNT(*) FROM urls;
```

On first run with a brand new profile, Chrome creates an empty History database on first page visit.

### Multiple Profiles

Each Chrome profile has its own `History` database. The active profile for debugging depends on the `--user-data-dir` and `--profile-directory` flags passed to Chrome.

### Historical Data Retention

By default, Chrome keeps history for **90 days**. The `ExpireHistoryBackend` component runs periodically and deletes visits older than this threshold. The exact behavior is controlled by `history::kHistoryExpirationThreshold` (default 90 days). Visits can survive longer if they have been synced or if they are typed/bookmarked.

### Foreign (Synced) Visits

Visits from other devices have a non-empty `originator_cache_guid`. Their `from_visit` and `opener_visit` columns are remapped to local visit IDs. If remapping fails, the originator values (`originator_from_visit`, `originator_opener_visit`) can be used to cross-reference.

## 9. Database Version History

The current schema version is **70** (as of Chromium main). The minimum compatible version is **16**.

Notable migrations:
| Version | Change |
|---------|--------|
| 36 | Added `AUTOINCREMENT` to `urls.id` |
| 41 | `keyword_search_terms.lower_term` → `normalized_term` |
| 48 | Added `opener_visit`, dropped `publicly_routable` |
| 54 | Added `AUTOINCREMENT` + originator columns to `visits` |
| 58 | Added `is_known_to_sync` column |
| 62 | Added `consider_for_ntp_most_visited` column |
| 65 | Added `external_referrer_url` column |
| 66 | Added `visited_link_id` column |
| 67 | Removed `typed_url_sync_metadata` table |
| 68 | Added `app_id` column |
| 69 | Dropped `android_urls` table (Android only) |
| 70 | Current version |

## 10. References

- **urls_database.h**: `components/history/core/browser/url_database.h`
- **visit_database.h**: `components/history/core/browser/visit_database.h`
- **history_database.cc**: `components/history/core/browser/history_database.cc`
- **page_transition_types.h**: `ui/base/page_transition_types.h`
- **history_types.h**: `components/history/core/browser/history_types.h`
- **url_row.h**: `components/history/core/browser/url_row.h`
- **history_constants.h**: `components/history/core/browser/history_constants.h`
- Source browser: https://source.chromium.org/chromium/chromium/src/+/main:components/history/core/browser/
- Git repository: https://chromium.googlesource.com/chromium/src/+/main/components/history/core/browser/
