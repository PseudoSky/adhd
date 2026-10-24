# `chromeManager` — Automatic Chrome Lifecycle Management

`ChromeManager` is the Chrome lifecycle of one client process: race-free auto-start, an activity-bumped idle timer, and an idle shutdown that never closes a Chrome someone else is using. It lives in `src/lib/chrome-manager.ts` and is exported as the `chromeManager` namespace.

## Why a ChromeManager?

In agent-driven automation, Chrome instances accumulate when agents forget to clean up or when sessions end abnormally. `ChromeManager` solves this with:

1. **Auto-start** — Chrome is launched on first use if it is not reachable.
2. **Activity bump** — `bump()` (and `withBrowser`) re-arms the idle timer and tells the reaper.
3. **Multi-process safety** — Every manager holds ONE connection to the *reaper host* of its port. The host keeps the registry of connected clients, so one process never closes a Chrome another process is using.
4. **3-tier safety check** — Before an idle shutdown the reaper host verifies: (a) sibling client activity, (b) open http(s) pages, (c) recent Chrome history.
5. **Ordered reap** — The host closes the page targets, then stops the Chrome process group.

There is no shared heartbeat file. A client's connection closes when the client dies, so a dead process can never pin Chrome, and the host outlives every client, so Chrome is never orphaned.

## Usage

### Basic lifecycle

Hosts normally read managers through the `lifecycle` seam (`lifecycle.managerFor(host, port)`), which is the one place a manager is constructed. A manager can also be constructed directly:

```typescript
import { chromeManager } from '@adhd/stealth-core-browser'
const { ChromeManager } = chromeManager

const chrome = new ChromeManager({
  idleTimeoutMs: 120_000, // 2 minutes of inactivity
  checkHistory: true,     // recent Chrome history keeps Chrome alive
})

// Start Chrome (no-op if already running) and register with the reaper
await chrome.ready()

// Real work happened: re-arm the idle timer and tell the reaper
chrome.bump()

// Force immediate shutdown
await chrome.shutdown()
```

### Auto-lifecycle with `withBrowser`

`withBrowser` ensures Chrome is running for the duration of a function and bumps the timer when it completes or throws:

```typescript
await chrome.withBrowser(async () => {
  const { pageWsUrl } = await cdp.createPageTarget('127.0.0.1:9222')
  // ... use the page ...
  // bump() runs in the finally block
})
```

### Long-lived host

```typescript
const chrome = new ChromeManager({
  keepAlive: true, // never arm the idle timer
  logger: (msg) => console.error(`[chrome] ${msg}`),
})

await chrome.ready()

process.on('SIGTERM', async () => {
  await chrome.shutdownIfIdle() // closes Chrome only if nobody else uses it
  process.exit(0)
})
```

## Constructor Options

### `ChromeManagerOptions`

| Option | Default | Description |
|---|---|---|
| `cdpHost` | `'127.0.0.1:9222'` | `host:port` of the CDP endpoint |
| `idleTimeoutMs` | `120_000` (2 min) | Inactivity period before the soft idle reap |
| `keepAlive` | `false` | `true` never arms the idle timer; `shutdown()`, `shutdownIfIdle()` and the reaper's own decisions are unchanged |
| `entryPath` | the bundle this code runs from | The built CommonJS package entry the detached reaper process loads `runChromeReaper` through |
| `userDataDir` | the dedicated CDP profile | Chrome user data directory this manager launches and may kill |
| `checkHistory` | `true` | Let a Chrome history visit within 2 minutes keep Chrome alive |
| `shutdownGraceMs` | `30_000` | Grace after the last client left before the reaper closes Chrome |
| `orphanWindowMs` | `30_000` | A reaper host nobody uses retires this long after Chrome is gone |
| `stateDir` | `<os.tmpdir()>/stealth-browser-<uid>-<port>` | Private state directory (lock, ownership record, breaker, reaper socket) |
| `reaperScope` | `'port-occupant'` | What the reaper may close: the port occupant, or only a Chrome it can prove it launched (`'launched-only'`) |
| `link` | the service-proxy reaper link of this port | The reaper seam (tests inject a fake) |
| `logger` | `console.error` | Log function for diagnostics |

## Methods

### `ready()`

Ensure Chrome is running and registered with the reaper. Idempotent. When the manager already believes Chrome is up it re-verifies reachability (one `GET /json/version`) and only then takes the fast path, because another process may have killed the shared Chrome. After a launch it hides all windows and starts the idle timer; the fast path never re-hides a window revealed for a human.

Rejects with a typed lifecycle error when the launch circuit breaker is open, the launch fails, or CDP never answers after the launch. A refusal to attach to a Chrome running on a foreign profile throws `LAUNCH_FAILED` with `detail.reason === 'foreign-profile'` and does not feed the breaker.

### `bump()`

Real work happened: re-arm the idle timer and send `activity` to the reaper. Call after every CDP operation. A no-op before `ready()`. If the reaper link is down, `bump()` makes at most one reconnect attempt per 2 s when Chrome is reachable.

### `shutdown()`

Force immediate shutdown: it cancels the idle timer, closes all page targets, runs `killChrome` for this manager's port (and `userDataDir`, if set), removes the ownership record and leaves the reaper registry. It ignores every safety tier and makes no reaper round-trip. Failures to close targets or kill Chrome are logged, not thrown.

`killChrome` stops the process group of the Chrome this process launched. For a Chrome it did not launch, it acts only on a listener whose command line carries `--user-data-dir=<resolved profile>`; any other listener is skipped with a logged reason. It never kills "whatever owns the port".

### `shutdownIfIdle()`

SOFT shutdown: cancels the idle timer and asks the reaper host whether Chrome is genuinely idle. The host defers to a sibling client, an open http(s) page, or recent history. It never force-kills a Chrome another session or a human's captcha window is using. Safe for process-exit paths. Without an answer from the host it re-arms the timer and closes nothing.

### `release()`

Leave the reaper registry. The process may live on; its next `ready()` re-registers. Never throws.

### `withBrowser(fn)`

Runs `ready()`, then `fn`, then `bump()` in a `finally`. Returns `fn`'s result.

### `isReady`

`true` once `ready()` has verified a running Chrome and until a real shutdown.

### `status()`

```typescript
interface ChromeStatus {
  ready: boolean                    // this manager has a verified, running Chrome
  owned: boolean                    // this process launched the running Chrome
  processes: number                 // clients connected to the reaper (0 when unavailable)
  activeProcesses: number           // clients active within the idle window
  httpPages: number | 'unreachable' // open http(s) pages
  reaper: boolean                   // the out-of-process reaper is connected (false = degraded)
  breaker: { open: boolean; retryAfterMs?: number }
  siblingWarning: boolean           // many sibling clients are connected (diagnostic only)
}
```

## 3-Tier Safety Shutdown

When the idle timer fires (or `shutdownIfIdle()` is called) the manager asks the reaper host to `reapIfIdle`. The host evaluates three tiers in order:

1. **Sibling activity** — another connected client was active within the idle window.
2. **Open http(s) pages** — Chrome's `/json/list` shows a non-blank http(s) page. This catches interactive browsing.
3. **Recent history** — when `checkHistory` is on, a Chrome history visit within 2 minutes keeps Chrome alive. If the history database is unavailable the check is skipped.

If any tier pins Chrome, the manager logs `Chrome in use (<tier>) — deferring`, re-arms the timer and sends nothing (livelock protection: only genuine use sends `activity`, so idle processes cannot keep each other alive). If no tier pins it, the host performs the ordered reap and the manager resets to not-ready; a later `ready()` relaunches and arms a fresh timer. The soft reap answers within 3 s or the manager defers.

## Degraded mode

When the reaper cannot be started (for example an unsafe state directory), `ready()` still succeeds, `status().reaper` is `false`, exactly one warning is logged, the idle timer still fires but never closes Chrome (it cannot see siblings), and a forced `shutdown()` still works.

## Idle Timer

The timer is an `IdleShutdown` (`src/lib/cdp/shutdown.ts`) whose `onShutdown` is the soft reap above. It starts at `ready()`, restarts on `bump()`, is `unref`'d so it never keeps Node.js alive, and is cancelled by a real shutdown. A manager created with `keepAlive: true` arms no timer.

## Error Handling

| Method | Failure mode | Behavior |
|---|---|---|
| `ready()` | Breaker open, launch fails, CDP never answers | Rejects with a typed lifecycle error (`LAUNCH_FAILED`, `CHROME_START_TIMEOUT`, ...) |
| `bump()` | Reaper unreachable | Logged, never thrown |
| `shutdown()` | Target close or `killChrome` fails | Logged, never thrown |
| `release()` | Link error | Logged, never thrown |
| Soft reap | Reaper unavailable, no answer | Chrome is not closed; the timer re-arms |

## Complete Example

```typescript
import { chromeManager, cdp, capture, parsers } from '@adhd/stealth-core-browser'
const { ChromeManager } = chromeManager
const { createPageTarget, closePageTarget } = cdp
const { captureNetworkResponse } = capture
const { extractWithXpath } = parsers

async function search(query: string) {
  const chrome = new ChromeManager({
    idleTimeoutMs: 60_000, // 1 min idle
    checkHistory: false,   // dedicated Chrome-CDP profile
  })

  return chrome.withBrowser(async () => {
    const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')
    try {
      const response = await captureNetworkResponse(pageWsUrl, {
        navigateUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        urlPattern: /google\.com\/search/,
        timeoutMs: 10_000,
      })
      return extractWithXpath(response.body)
    } finally {
      await closePageTarget('127.0.0.1:9222', targetId)
    }
  })
}
```

## Comparison: `ChromeManager` vs the raw `cdp` layer

| Aspect | `ChromeManager` | Raw `launchChrome` / `ensureChromeRunning` |
|---|---|---|
| Auto-start | On first `ready()` | Via `ensureChromeRunning()` |
| Idle timer | Built in, configurable | Manually with `IdleShutdown` |
| Multi-process safety | Reaper host registry | Not handled |
| Safety checks | 3 tiers before an idle shutdown | Not included |
| `withBrowser()` | Automatic lifecycle | Manual `try/finally` |
| Force shutdown | `shutdown()` | `killChrome()` |
