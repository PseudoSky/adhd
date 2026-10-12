# `/chrome-manager` — Automatic Chrome Lifecycle Management

`ChromeManager` provides auto-start, activity-bumped idle timer, and safety-checked auto-shutdown for the Chrome browser process. It composes the `cdp` layer (`src/lib/cdp/`) (browser lifecycle, idle timer) with domain/storage checks (CDP targets + history DB).

## Why a ChromeManager?

In agent-driven automation, Chrome instances accumulate when agents forget to clean up or when sessions end abnormally. `ChromeManager` solves this with:

1. **Auto-start** — Chrome launched on first use if not reachable
2. **Activity bump** — Every CDP operation resets the idle timer
3. **Multi-process safety** — Shared heartbeat file so one process doesn't kill Chrome another process is using
4. **3-tier safety check** — Before shutting down, verifies: (a) heartbeat → (b) CDP active targets → (c) Chrome history for recent activity
5. **Graceful shutdown** — Closes all page targets, then kills the Chrome process (using port-specific `lsof` — safe)

## Usage

### Basic lifecycle

```typescript
import { ChromeManager } from '@adhd/stealth-browser/chrome-manager'

const chrome = new ChromeManager({
  idleTimeoutMs: 120_000,  // 2 minutes of inactivity
  checkHistory: true,       // Check Chrome history for recent use
})

// Start Chrome (no-op if already running)
await chrome.ready()
// → Chrome running on port 9222

// Bump the timer after every CDP operation
chrome.bump()

// Force immediate shutdown
await chrome.shutdown()
```

### Auto-lifecycle with `withBrowser`

The `withBrowser` method ensures Chrome is running for the duration of a function, bumping the timer after completion:

```typescript
await chrome.withBrowser(async () => {
  const { pageWsUrl } = await createPageTarget('127.0.0.1:9222')
  // ... use the page ...
  // Timer is bumped automatically in the finally block
})
```

### Full MCP-style integration

```typescript
const chrome = new ChromeManager({
  idleTimeoutMs: 300_000,     // 5 min idle
  heartbeatPath: '/tmp/stealth-browser-heartbeat',
  logger: (msg) => console.error(`[chrome] ${msg}`),
})

// Start
await chrome.ready()

// Wrap all tool handlers with activity bumps
toolHandler.on('beforeEach', () => chrome.bump())

// Shutdown when the server exits
process.on('SIGTERM', async () => {
  await chrome.shutdown()
  process.exit(0)
})
```

## Constructor Options

### `ChromeManagerOptions`

```typescript
interface ChromeManagerOptions {
  /** CDP host. Default: 127.0.0.1:9222 */
  cdpHost?: string
  /** Idle timeout in ms. Default: 120_000 (2 min) */
  idleTimeoutMs?: number
  /** Path to shared heartbeat file. Default: /tmp/stealth-browser-heartbeat */
  heartbeatPath?: string
  /** If true, check Chrome history for recent activity. Default: true */
  checkHistory?: boolean
  /** Log function. Default: console.error */
  logger?: (msg: string) => void
}
```

| Option | Default | Description |
|---|---|---|
| `cdpHost` | `'127.0.0.1:9222'` | Host:port for the CDP endpoint |
| `idleTimeoutMs` | `120_000` (2 min) | Inactivity period before auto-shutdown |
| `heartbeatPath` | `/tmp/stealth-browser-heartbeat` | Path to shared heartbeat file for cross-process coordination |
| `checkHistory` | `true` | Whether to check Chrome's visit history as an activity signal |
| `logger` | `console.error` | Log function for diagnostics |

## Methods

### `ready()`

Ensure Chrome is running. Idempotent — subsequent calls no-op. Starts the idle timer and writes the first heartbeat.

```typescript
await chrome.ready()
```

### `bump()`

Reset the idle timer and write a heartbeat timestamp. Call after every CDP operation.

```typescript
// After any CDP operation:
chrome.bump()
```

### `shutdown()`

Force immediate shutdown — skips all safety checks, closes page targets, kills Chrome.

```typescript
await chrome.shutdown()
```

### `withBrowser(fn)`

Run a function with automatic Chrome lifecycle management. Ensures Chrome is running before `fn`, bumps the timer after `fn` completes (or fails).

```typescript
const result = await chrome.withBrowser(async () => {
  const response = await captureNetworkResponse(pageWsUrl, {
    navigateUrl: 'https://example.com',
    urlPattern: /example\.com/,
  })
  return response.body
})
```

### `isReady`

Check if Chrome has been initialized.

```typescript
if (chrome.isReady) {
  console.log('Chrome is running')
}
```

## 3-Tier Safety Shutdown

When the idle timer expires, `ChromeManager` does NOT immediately kill Chrome. Instead, it runs three safety checks in sequence:

### Tier 1: Cross-Process Heartbeat

Checks `/tmp/stealth-browser-heartbeat` for heartbeats from other processes within the idle timeout window.

```typescript
// If another process bumped the heartbeat in the last idleTimeoutMs:
// → "pid 12345 active 30s ago — deferring"
// → Resets the timer and returns
```

The heartbeat file is a simple text file, one `pid:timestamp_ms` per line. Dead PIDs (checked via `process.kill(pid, 0)`) are filtered out.

### Tier 2: Live CDP Targets

Queries Chrome's `/json/list` for non-blank page targets.

```typescript
// If there are active pages (not about:blank):
// → "3 active page(s) found — Chrome in use"
// → Resets the timer and returns
```

This catches interactive browsing — if a human has pages open, Chrome won't be killed.

### Tier 3: Chrome History (Optional)

Reads the Chrome-CDP History database for recent visits.

```typescript
// If the most recent visit is within 2 minutes:
// → "recent history activity found — Chrome in use"
// → Resets the timer and returns
```

Controlled by the `checkHistory` option (default: `true`). If the history DB is unavailable (Chrome not fully started, or using a non-standard profile), this check is silently skipped.

### Shutdown

If all three checks pass (no activity detected), the shutdown proceeds:

1. Close all page targets via `closeAllPageTargets()`
2. Kill Chrome via `killChrome()` (port-specific `lsof`, never `pkill`)
3. Set `_ready = false`

## Shared Heartbeat File

The heartbeat file at `/tmp/stealth-browser-heartbeat` enables multi-process coordination. Every process that uses `ChromeManager`:

- Writes its PID + current timestamp on every `bump()`
- Reads the full heartbeat file on each `bump()`, updating its own entry
- Before shutdown, checks if ANY other process (with a live PID) has bumped within the idle timeout window

Heartbeat format:
```
12345:1689000000000
12346:1689000012000
```

Dead PIDs are skipped (checked by `process.kill(pid, 0)` — if the process doesn't exist, it's filtered out). This means stale entries from crashed processes don't prevent shutdown.

## Idle Timer Implementation

The idle timer is driven by `IdleShutdown` from the `cdp` layer:

```typescript
new IdleShutdown({
  timeoutMs: opts.idleTimeoutMs,
  logger: (m) => log(m),
  onShutdown: () => _doShutdown(false), // non-force shutdown with safety checks
})
```

- Timer starts when `ready()` is called
- `bump()` calls `idle.reset()` to restart the countdown
- Timer is `unref`'d so it doesn't prevent Node.js from exiting
- Will not fire again after shutdown (checked via `_fired`)

## Error Handling

| Method | Failure mode | Behavior |
|---|---|---|
| `ready()` | Chrome launch fails | Throws `Error` with details (binary not found, CDP not reachable after 10s) |
| `bump()` | Heartbeat write fails | Silently caught (best effort) |
| `shutdown()` | Target close fails | Silently caught (best effort) |
| `shutdown()` | `killChrome` fails | Silently caught (best effort) |
| Safety checks | CDP unreachable, DB unavailable | Check is skipped, proceeds to next tier |

## Complete Example

```typescript
import { ChromeManager } from '@adhd/stealth-browser/chrome-manager'
import { createPageTarget, closePageTarget } from '@adhd/stealth-browser/cdp'
import { captureNetworkResponse } from '@adhd/stealth-browser/capture'
import { extractWithXpath } from '@adhd/stealth-browser/parsers'

async function search(query: string) {
  const chrome = new ChromeManager({
    idleTimeoutMs: 60_000,     // 1 min idle
    heartbeatPath: '/tmp/my-search-heartbeat',
    checkHistory: false,        // Don't check history (dedicated Chrome-CDP profile)
  })

  await chrome.ready()

  try {
    const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')

    try {
      const response = await captureNetworkResponse(pageWsUrl, {
        navigateUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        urlPattern: /google\.com\/search/,
        timeoutMs: 10_000,
      })

      chrome.bump() // Reset idle timer

      return extractWithXpath(response.body)
    } finally {
      await closePageTarget('127.0.0.1:9222', targetId)
    }
  } finally {
    // Shutdown when done (force = skip safety checks)
    await chrome.shutdown()
  }
}
```

## Comparison: `ChromeManager` vs the raw `cdp` layer

| Aspect | `ChromeManager` | Raw `launchChrome` / `ensureChromeRunning` |
|---|---|---|
| Auto-start | ✅ On first `ready()` | ✅ Via `ensureChromeRunning()` |
| Idle timer | ✅ Built-in, configurable | ❌ Manually with `IdleShutdown` |
| Multi-process safety | ✅ Shared heartbeat file | ❌ Not handled |
| Safety checks | ✅ 3-tier before shutdown | ❌ Not included |
| `withBrowser()` | ✅ Automatic lifecycle | ❌ Manual `try/finally` |
| Force shutdown | ✅ `shutdown()` | ✅ `killChrome()` |
| Granularity | Process-level | Process-level |
| Dependencies | cdp + domains + storage | None beyond cdp |
