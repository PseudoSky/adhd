# `/cdp` — Chrome DevTools Protocol

The CDP entrypoint provides everything you need to connect to, control, and monitor Chrome via the Chrome DevTools Protocol. It is composed of two layers:

1. **`src/lib/cdp/`** — Low-level primitives: WebSocket CDP session, browser process lifecycle, page target management, resource monitoring, idle shutdown timer.
2. **`domains/`** — Higher-level service classes wrapping specific CDP domains (Target, Browser, Page, Network, System). Includes the `CdpClient` facade that composes all five.

## `CdpSession` — Raw WebSocket CDP Connection

The fundamental building block. Provides command/response via `send()`, event subscription via `on()`/`off()`, and connection lifecycle.

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { CdpSession } = cdp

const session = new CdpSession()
await session.connect('ws://127.0.0.1:9222/devtools/browser/<id>')

// Send a CDP command
const result = await session.send<{ targetId: string }>('Target.createTarget', {
  url: 'about:blank',
})

// Subscribe to events
session.on('Network.requestWillBeSent', (params) => {
  console.log('Request:', (params.request as { url: string }).url)
})

// Unsubscribe
session.off('Network.requestWillBeSent')

session.close()
```

### Constructor

```typescript
new CdpSession()
```

### Properties

| Property | Type | Description |
|---|---|---|
| `connected` | `boolean` | Whether the WebSocket is currently open |

### Methods

| Method | Returns | Description |
|---|---|---|
| `connect(wsUrl)` | `Promise<void>` | Open a WebSocket connection to the CDP endpoint |
| `send(method, params?, timeoutMs?)` | `Promise<T>` | Send a CDP command and wait for response (default timeout: 30s) |
| `on(method, handler)` | `void` | Subscribe to a CDP event |
| `off(method)` | `void` | Unsubscribe from a CDP event |
| `close()` | `void` | Close the WebSocket, reject all pending commands, clear all handlers |

### Examples

```typescript
// Navigate to a URL
await pageSession.send('Page.navigate', { url: 'https://example.com' })

// Wait for the page to settle (Page.loadEventFired is an EVENT, not a command)
await awaitPageSettled(pageSession, { deadlineMs: 10_000 })

// Get response body
const { body } = await pageSession.send<{ body: string }>(
  'Network.getResponseBody',
  { requestId }
)
```

### Timing Helpers

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { rand, humanPause, shortPause } = cdp

rand(300, 900)        // Random integer in [300, 900]
await humanPause()    // Sleep 600-1800ms
await shortPause()    // Sleep 300-900ms
```

## Browser Lifecycle

Functions for launching, detecting, and terminating the Chrome process.

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { launchChrome, ensureChromeRunning, killChrome, isChromeRunning } = cdp
```

### `launchChrome(options?)`

Launch Chrome with `--remote-debugging-port`. Uses `nohup` + `spawn` so the process outlives the parent. No `--enable-automation` flag — Chrome appears as a normal browser.

**Idempotent:** If Chrome is already reachable on the target port, returns immediately without launching.

```typescript
const result = await launchChrome({
  port: 9222,
  profileDir: '/path/to/Chrome-CDP', // default: ~/Library/Application Support/Google/Chrome-CDP
  chromePath: '/Applications/Google Chrome.app/...', // auto-detected
  extraArgs: [], // additional Chrome CLI flags
})
// → { pid: 12345, port: 9222, alreadyRunning: false, profileDir: '...' }
```

| Option | Default | Description |
|---|---|---|
| `port` | `9222` | CDP debugging port |
| `profileDir` | `~/Library/Application Support/Google/Chrome-CDP` | Dedicated user data directory |
| `chromePath` | Auto-detected per platform | Path to Chrome/Chromium binary |
| `extraArgs` | `[]` | Additional Chrome CLI arguments |

**Platform auto-detection:**

| Platform | Default path |
|---|---|
| macOS | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| Linux | `which google-chrome \|\| which chromium \|\| which chromium-browser` |
| Windows | `C:\Program Files\Google\Chrome\Application\chrome.exe` |

**Throws** if the Chrome binary is not found at the resolved path.

### `ensureChromeRunning(options?)`

Idempotent: no-ops if Chrome is already reachable on the port. Launches if missing. This is the main entry point for consumers who just need Chrome available.

```typescript
const { pid, port, profileDir } = await ensureChromeRunning()
```

### `killChrome(port?)`

Stop the Chrome associated with a CDP port. If this process launched Chrome (via `launchChrome`), it stops the tracked launch's process group (SIGTERM, then SIGKILL after a bounded wait). Otherwise it acts only on a listener on the port whose command line carries `--user-data-dir=<resolved profile>` (the `profileDir` option, default the dedicated CDP profile); a listener that does not match is skipped with a logged reason. It never kills an arbitrary process that happens to own the port.

```typescript
await killChrome(9222)
```

### `isChromeRunning(host)`

Lightweight check — a single HTTP GET to `/json/version`. Alias for `isChromeReachable`.

```typescript
const running = await isChromeRunning('127.0.0.1:9222')
```

## Page Target Lifecycle

Functions for creating, listing, and closing page targets.

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { getChromeInfo, isChromeReachable, listPageTargets, listPageTargetsOnly, createPageTarget, closePageTarget, closeAllPageTargets } = cdp
```

### `createPageTarget(cdpHost)`

Create a new page target (`about:blank`) and return its direct WebSocket URL.

1. Opens a browser-level WebSocket
2. Calls `Target.createTarget({ url: 'about:blank' })`
3. Polls `/json/list` until the target's `webSocketDebuggerUrl` is registered (typically <200ms)

```typescript
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')
// → { targetId: '...', pageWsUrl: 'ws://127.0.0.1:9222/devtools/page/...' }
```

**Throws** if the target does not appear in `/json/list` within 3 seconds.

### `closePageTarget(cdpHost, targetId)`

Close a page target by ID. Best-effort: a failure is logged with `console.warn` and not thrown.

```typescript
await closePageTarget('127.0.0.1:9222', targetId)
```

### `closeAllPageTargets(cdpHost)`

Close ALL page targets (but not the browser itself). Uses `Promise.allSettled`.

```typescript
await closeAllPageTargets('127.0.0.1:9222')
```

### `listPageTargets(cdpHost)`

List all targets with their WebSocket URLs.

```typescript
const targets = await listPageTargets('127.0.0.1:9222')
// → [{ id, type, url, webSocketDebuggerUrl }, ...]
```

### `listPageTargetsOnly(cdpHost)`

List only page-type targets (excludes service workers, background pages, etc.).

### `getChromeInfo(cdpHost)`

Get browser metadata from `/json/version`.

```typescript
const info = await getChromeInfo('127.0.0.1:9222')
// → { browserWsUrl, browserVersion, protocolVersion, userAgent, webSocketDebuggerUrl }
```

### `isChromeReachable(cdpHost)`

Check if Chrome's CDP endpoint is reachable.

### Types

```typescript
interface PageTargetInfo {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

interface ChromeVersionInfo {
  browserWsUrl: string
  browserVersion: string
  protocolVersion: string
  userAgent: string
  webSocketDebuggerUrl: string
}
```

## Domain Services

`CdpClient` is the typed facade over five domain services (Target, Browser, Page, Network, System). The service classes are internal; they are reached as `client.target`, `client.browser`, `client.page`, `client.network` and `client.system`, or through the facade's passthrough methods. Every method is implemented, talks to Chrome, and throws a typed `StealthCoreBrowserError` on failure; none returns `null` to mean "failed" (see [ERRORS.md](../ERRORS.md)).

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { CdpClient } = cdp

const client = new CdpClient('127.0.0.1:9222')
const version = await client.getVersion()
console.log(`Chrome ${version.browserVersion}`)
```

Target-scoped commands (`Page.*`, `Network.*`, `Performance.*`) are routed through a flat page session attached to the requested target; browser-scoped commands (`Target.*`, `Browser.*`, `SystemInfo.*`) use the browser session. A call that names an unknown target throws `TARGET_NOT_FOUND`; an unreachable or invalid endpoint throws `CDP_UNREACHABLE`; a timeout throws `CDP_TIMEOUT`; a malformed reply throws `CDP_BAD_RESPONSE`; a CDP error reply throws `CDP_REMOTE_ERROR`.

| Method | Service | Returns | Backing call |
|---|---|---|---|
| `getVersion()` | Browser | `Promise<ChromeVersion>` | `GET /json/version` |
| `listPageTargets()` | Target | `Promise<CdpTargetInfo[]>` | `GET /json/list`, `type === 'page'` only |
| `countActivePages()` | Target | `Promise<number>` | page targets with an http(s) URL |
| `getTargetInfo(targetId)` | Target | `Promise<CdpTargetInfo>` | `Target.getTargetInfo` |
| `activateTarget(targetId)` | Target | `Promise<void>` | `Target.activateTarget`; throws `TARGET_NOT_FOUND` |
| `getHistograms(query?)` | Browser | `Promise<unknown[]>` | `Browser.getHistograms` |
| `getHistogram(name)` | Browser | `Promise<unknown>` | `Browser.getHistogram` |
| `getWindowBounds(targetId)` | Browser | `Promise<BrowserWindowBounds>` | `Browser.getWindowForTarget`, then `Browser.getWindowBounds` |
| `getWindowForTarget(targetId)` | Browser | `Promise<{ windowId, bounds }>` | `Browser.getWindowForTarget` |
| `getBrowserCommandLine()` | Browser | `Promise<string[]>` | `Browser.getBrowserCommandLine` |
| `getNavigationHistory(targetId)` | Page | `Promise<{ currentIndex, entries }>` | `Page.getNavigationHistory` (page session) |
| `getFrameTree(targetId)` | Page | `Promise<unknown>` | `Page.getFrameTree` (page session) |
| `getResourceTree(targetId)` | Page | `Promise<unknown>` | `Page.getResourceTree` (page session) |
| `getLayoutMetrics(targetId)` | Page | `Promise<unknown>` | `Page.getLayoutMetrics` (page session) |
| `captureScreenshot(targetId, format?)` | Page | `Promise<string>` (base64) | `Page.captureScreenshot` (page session) |
| `getPageMetrics(targetId)` | Page | `Promise<PageMetrics>` | `Performance.getMetrics` (page session) |
| `getCookies(urls?, targetId?)` | Network | `Promise<CookieInfo[]>` | `Network.getCookies` (page session) |
| `getAllCookies(targetId?)` | Network | `Promise<CookieInfo[]>` | `Network.getAllCookies` (page session) |
| `getSystemInfo()` | System | `Promise<SystemInfo>` | `SystemInfo.getInfo` |
| `getProcessInfo()` | System | `Promise<ProcessInfo[]>` | `SystemInfo.getProcessInfo` |
| `getMemoryCounters(targetId?)` | System | `Promise<ChromeMemoryCounters>` | `Performance.getMetrics` |

```typescript
// List page targets and focus the first one
const pages = await client.listPageTargets()
for (const p of pages) console.log(`${p.title}: ${p.url} (attached: ${p.attached})`)
if (pages[0]) await client.activateTarget(pages[0].targetId)

// Page-scoped reads need a target id
const metrics = await client.getPageMetrics(pages[0]!.targetId)
```

For cookie values from the profile on disk rather than the live browser, use the storage module's cookie readers (`storage.getCookies`), which read Chrome's SQLite cookie database. For resource monitoring, use `collectResourceUsage` (below).


## Resource Monitoring

Runtime monitoring via CDP `SystemInfo` and `Performance` domains.

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { collectResourceUsage, checkWatermark, clearBrowserCache, formatResourceUsage } = cdp
```

### `collectResourceUsage(browserSession, pageSession?)`

Collect RSS, JS heap, CPU info, and DOM stats.

```typescript
const usage = await collectResourceUsage(browserSession, pageSession)
// → { rssMb, heapUsedMb, heapTotalMb, cpuInfo: { modelName, cores }, storage, performance }
```

**Platform note:** On macOS, `privateMemory` in `SystemInfo.getProcessInfo` may be 0 — this is a CDP platform limitation, not a bug. Core count from `os.cpus()` is always reliable.

### `checkWatermark(usage, thresholds?)`

Check if resource usage exceeds thresholds.

```typescript
const result = checkWatermark(usage, { maxRssMb: 500, maxHeapMb: 300 })
// → { overMemory: boolean, overCache: boolean, shouldRestart: boolean, usage }
```

### `clearBrowserCache(pageSession)`

Clear browser cache storage via `Storage.clearDataForOrigin` + `Network.clearBrowserCache`.

```typescript
await clearBrowserCache(pageSession)
```

### `formatResourceUsage(usage)`

Format resource usage as a human-readable string.

```typescript
console.log(formatResourceUsage(usage))
// "RSS: 245MB | heap: 120/350MB | DOM: 1800 nodes | CPU: Apple M3 (12 cores)"
```

## Idle Shutdown

Prevents Chrome instances from accumulating when an agent forgets to clean up.

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { IdleShutdown, createPageTargetIdleShutdown } = cdp
```

### `IdleShutdown`

```typescript
const idle = new IdleShutdown({
  timeoutMs: 120_000,      // 2 minutes
  onShutdown: async () => { /* close targets, kill Chrome */ },
  logger: console.error,
})

// Call on every CDP activity:
idle.reset()   // Bump the timer

// Stop the timer:
idle.cancel()

// Check if shutdown has fired:
idle.fired  // boolean
```

### `createPageTargetIdleShutdown(closeTargets, opts?)`

Convenience factory for the common pattern: close page targets on idle, optionally kill Chrome.

```typescript
const idle = createPageTargetIdleShutdown(
  () => closeAllPageTargets('127.0.0.1:9222'),
  { shutDownChrome: true, onShutdown: () => killChrome(9222) },
)
```

## Shared Types

### `CdpTargetInfo`

```typescript
interface CdpTargetInfo {
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
```

### `ChromeVersion`

```typescript
interface ChromeVersion {
  browserVersion: string
  protocolVersion: string
  userAgent: string
  jsVersion: string
  v8Version: string
}
```

### `BrowserWindowBounds`

```typescript
interface BrowserWindowBounds {
  windowId: number
  left: number
  top: number
  width: number
  height: number
  windowState: 'normal' | 'minimized' | 'maximized' | 'fullscreen'
}
```

### `PageMetrics`

```typescript
interface PageMetrics {
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
```

### `ChromeMemoryCounters`

```typescript
interface ChromeMemoryCounters {
  nodes: number
  documents: number
  jsEventListeners: number
  layouts: number
  recalcStyleCount: number
}
```

### `ResourceUsage`

```typescript
interface ResourceUsage {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
  cpuInfo: { modelName: string; cores: number }
  storage: { cacheBytes: number; localStorageBytes: number; sessionStorageBytes: number }
  performance: { domNodes: number; eventListeners: number; jsHeapSize: number }
}
```

## Usage Pattern: Full Browser Session

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { CdpSession, awaitPageSettled, ensureChromeRunning, createPageTarget, closePageTarget } = cdp

const cdpHost = '127.0.0.1:9222'
await ensureChromeRunning({ port: 9222 })

const { targetId, pageWsUrl } = await createPageTarget(cdpHost)
const page = new CdpSession()

try {
  await page.connect(pageWsUrl)
  await page.send('Page.enable')
  const settled = await awaitPageSettled(page, { navigate: url, deadlineMs: 15_000 })
  if (!settled.settled) console.warn(`never settled (${settled.signal})`)
  // ... process page ...
} finally {
  page.close()
  await closePageTarget(cdpHost, targetId)
}
```
