# `/cdp` — Chrome DevTools Protocol

The CDP entrypoint provides everything you need to connect to, control, and monitor Chrome via the Chrome DevTools Protocol. It is composed of two layers:

1. **`src/lib/cdp/`** — Low-level primitives: WebSocket CDP session, browser process lifecycle, page target management, resource monitoring, idle shutdown timer.
2. **`domains/`** — Higher-level service classes wrapping specific CDP domains (Target, Browser, Page, Network, System). Includes the `CdpClient` facade that composes all five.

## `CdpSession` — Raw WebSocket CDP Connection

The fundamental building block. Provides command/response via `send()`, event subscription via `on()`/`off()`, and connection lifecycle.

```typescript
import { CdpSession } from '@adhd/stealth-core-browser/cdp'

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

// Wait for page load
await pageSession.send('Page.loadEventFired', {}, 10_000)

// Get response body
const { body } = await pageSession.send<{ body: string }>(
  'Network.getResponseBody',
  { requestId }
)
```

### Timing Helpers

```typescript
import { rand, humanPause, shortPause } from '@adhd/stealth-core-browser/cdp'

rand(300, 900)        // Random integer in [300, 900]
await humanPause()    // Sleep 600-1800ms
await shortPause()    // Sleep 300-900ms
```

## Browser Lifecycle

Functions for launching, detecting, and terminating the Chrome process.

```typescript
import {
  launchChrome,
  ensureChromeRunning,
  killChrome,
  isChromeRunning,
} from '@adhd/stealth-core-browser/cdp'
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

Kill the Chrome process associated with a CDP port. If this session spawned Chrome (via `launchChrome`), kills the tracked child process first. Otherwise, uses `lsof -ti:<port>` to find the process listening on the port — safe because it only targets Chrome explicitly launched with `--remote-debugging-port`.

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
import {
  getChromeInfo,
  isChromeReachable,
  listPageTargets,
  listPageTargetsOnly,
  createPageTarget,
  closePageTarget,
  closeAllPageTargets,
} from '@adhd/stealth-core-browser/cdp'
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

Close a page target by ID. Best-effort — catches errors silently.

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

Higher-level wrappers for CDP domains, providing typed methods and automatic WebSocket management.

```typescript
import {
  CdpClient,
  TargetService,
  BrowserService,
  PageService,
  NetworkService,
  SystemService,
} from '@adhd/stealth-core-browser/cdp'
```

### `TargetService`

Manages browser page targets. Two methods use Chrome's HTTP API (`/json/list`); more advanced methods use CDP WebSocket.

```typescript
const target = new TargetService('127.0.0.1:9222')
```

| Method | Returns | Description | Status |
|---|---|---|---|
| `listPageTargets()` | `Promise<CdpTargetInfo[]>` | List all page targets via `GET /json/list` | **Shipped** |
| `countActivePages()` | `Promise<number>` | Number of page targets with non-blank URLs | **Shipped** |
| `getTargetInfo(targetId)` | `Promise<CdpTargetInfo \| null>` | Extended target info via CDP `Target.getTargetInfo` over WebSocket | **Shipped** |
| `activateTarget(targetId)` | `Promise<boolean>` | Activate / focus a target page | 🔴 Not yet implemented — returns `false` |

```typescript
// List all page targets
const pages = await target.listPageTargets()
for (const p of pages) {
  console.log(`${p.title}: ${p.url} (attached: ${p.attached})`)
}

// Count active pages (non-blank URLs)
const count = await target.countActivePages()

// Get extended info for a specific target
const info = await target.getTargetInfo(targetId)
```

### `BrowserService`

Browser-wide state and configuration.

```typescript
const browser = new BrowserService('127.0.0.1:9222')
```

| Method | Returns | Description | Status |
|---|---|---|---|
| `getVersion()` | `Promise<ChromeVersion \| null>` | Chrome version from `GET /json/version` | **Shipped** |
| `getHistograms(query?)` | `Promise<unknown[]>` | Browser histogram data | 🔴 Not yet implemented |
| `getHistogram(name)` | `Promise<unknown \| null>` | Single named histogram | 🔴 Not yet implemented |
| `getWindowBounds(targetId)` | `Promise<BrowserWindowBounds \| null>` | Window bounds for a target | 🔴 Not yet implemented |
| `getWindowForTarget(targetId)` | `Promise<... \| null>` | Window info for a target | 🔴 Not yet implemented |
| `getBrowserCommandLine()` | `Promise<string[]>` | Browser command-line arguments | 🔴 Not yet implemented |

```typescript
const version = await browser.getVersion()
if (version) {
  console.log(`Chrome ${version.browserVersion}`)
  console.log(`User-Agent: ${version.userAgent}`)
}
```

### `PageService`

Per-page operations — navigation, frames, screenshots, metrics.

**All methods in this service are stubs and return `null` or empty results.**

```typescript
const page = new PageService('127.0.0.1:9222')
```

| Method | Returns | Status |
|---|---|---|
| `getNavigationHistory(targetId)` | `Promise<{currentIndex, entries} \| null>` | 🔴 Not yet implemented |
| `getFrameTree(targetId)` | `Promise<unknown \| null>` | 🔴 Not yet implemented |
| `getResourceTree(targetId)` | `Promise<unknown \| null>` | 🔴 Not yet implemented |
| `getLayoutMetrics(targetId)` | `Promise<unknown \| null>` | 🔴 Not yet implemented |
| `captureScreenshot(targetId, format?)` | `Promise<string \| null>` | 🔴 Not yet implemented |
| `getPageMetrics(targetId)` | `Promise<PageMetrics \| null>` | 🔴 Not yet implemented |

For navigation and network capture, use `CdpSession` directly or the `captureNetworkResponse` function from the capture module.

### `NetworkService`

Network/cookie operations via CDP.

**All methods in this service are stubs and return empty arrays.**

```typescript
const network = new NetworkService('127.0.0.1:9222')
```

| Method | Returns | Status |
|---|---|---|
| `getCookies(urls?)` | `Promise<CookieInfo[]>` | 🔴 Not yet implemented |
| `getAllCookies()` | `Promise<CookieInfo[]>` | 🔴 Not yet implemented |

For cookie access, use the storage module's `CookieClient` which reads Chrome's SQLite cookie database directly.

### `SystemService`

Chrome system information and diagnostics.

**All methods in this service are stubs and return `null` or empty results.**

```typescript
const sys = new SystemService('127.0.0.1:9222')
```

| Method | Returns | Status |
|---|---|---|
| `getSystemInfo()` | `Promise<SystemInfo \| null>` | 🔴 Not yet implemented |
| `getProcessInfo()` | `Promise<ProcessInfo[]>` | 🔴 Not yet implemented |
| `getMemoryCounters()` | `Promise<ChromeMemoryCounters \| null>` | 🔴 Not yet implemented |

For resource monitoring, use `collectResourceUsage` from `src/lib/cdp/monitor.ts` directly.

### `CdpClient` — Unified Facade

Composes all five domain services into a single class with convenience passthroughs.

```typescript
const cdp = new CdpClient('127.0.0.1:9222')

// Versions
const version = await cdp.getVersion()
const targetList = await cdp.listPageTargets()
const active = await cdp.countActivePages()
```

| Method | Delegates to | Status |
|---|---|---|
| `getVersion()` | `BrowserService.getVersion()` | **Shipped** |
| `listPageTargets()` | `TargetService.listPageTargets()` | **Shipped** |
| `countActivePages()` | `TargetService.countActivePages()` | **Shipped** |
| `getTargetInfo(targetId)` | `TargetService.getTargetInfo()` | **Shipped** |
| `activateTarget(targetId)` | `TargetService.activateTarget()` | 🔴 Stub |
| `getHistograms(query?)` | `BrowserService.getHistograms()` | 🔴 Stub |
| `getHistogram(name)` | `BrowserService.getHistogram()` | 🔴 Stub |
| `getWindowBounds(targetId)` | `BrowserService.getWindowBounds()` | 🔴 Stub |
| `getWindowForTarget(targetId)` | `BrowserService.getWindowForTarget()` | 🔴 Stub |
| `getBrowserCommandLine()` | `BrowserService.getBrowserCommandLine()` | 🔴 Stub |
| `getNavigationHistory(targetId)` | `PageService.getNavigationHistory()` | 🔴 Stub |
| `getFrameTree(targetId)` | `PageService.getFrameTree()` | 🔴 Stub |
| `getResourceTree(targetId)` | `PageService.getResourceTree()` | 🔴 Stub |
| `getLayoutMetrics(targetId)` | `PageService.getLayoutMetrics()` | 🔴 Stub |
| `captureScreenshot(targetId, format?)` | `PageService.captureScreenshot()` | 🔴 Stub |
| `getPageMetrics(targetId)` | `PageService.getPageMetrics()` | 🔴 Stub |
| `getCookies(urls?)` | `NetworkService.getCookies()` | 🔴 Stub |
| `getAllCookies()` | `NetworkService.getAllCookies()` | 🔴 Stub |
| `getSystemInfo()` | `SystemService.getSystemInfo()` | 🔴 Stub |
| `getProcessInfo()` | `SystemService.getProcessInfo()` | 🔴 Stub |
| `getMemoryCounters()` | `SystemService.getMemoryCounters()` | 🔴 Stub |

## Resource Monitoring

Runtime monitoring via CDP `SystemInfo` and `Performance` domains.

```typescript
import {
  collectResourceUsage,
  checkWatermark,
  clearBrowserCache,
  formatResourceUsage,
} from '@adhd/stealth-core-browser/cdp'
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
import { IdleShutdown, createPageTargetIdleShutdown } from '@adhd/stealth-core-browser/cdp'
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
import {
  CdpSession,
  ensureChromeRunning,
  createPageTarget,
  closePageTarget,
} from '@adhd/stealth-core-browser/cdp'

const cdpHost = '127.0.0.1:9222'
await ensureChromeRunning({ port: 9222 })

const { targetId, pageWsUrl } = await createPageTarget(cdpHost)
const page = new CdpSession()

try {
  await page.connect(pageWsUrl)
  await page.send('Page.enable')
  await page.send('Page.navigate', { url })
  await page.send('Page.loadEventFired', {}, 15_000)
  // ... process page ...
} finally {
  page.close()
  await closePageTarget(cdpHost, targetId)
}
```
