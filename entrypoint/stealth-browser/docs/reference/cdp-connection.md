# CDP connection layer (`src/lib/cdp/`)

Chrome DevTools Protocol connection manager — session, targets, browser lifecycle, resource monitoring, and idle shutdown.

Part of `@adhd/stealth-browser`; consumed by the capture layer, the chrome manager, and the CLI and MCP surfaces.

## Quick start

```ts
import { ensureChromeRunning, createPageTarget, CdpSession } from '@adhd/stealth-browser/cdp'

// 1. Launch Chrome (idempotent — no-ops if already running)
await ensureChromeRunning()

// 2. Create a page target
const { pageWsUrl } = await createPageTarget('127.0.0.1:9222')

// 3. Connect and send CDP commands
const session = new CdpSession()
await session.connect(pageWsUrl)
await session.send('Page.navigate', { url: 'https://example.com' })
const title = await session.send<{ result: { value: string } }>(
  'Runtime.evaluate',
  { expression: 'document.title' },
)
console.log(title.result.value) // "Example Domain"
session.close()
```

## Modules

### Session (`src/session.ts`)

Raw CDP WebSocket with command/response + event subscription.

| Method | Description |
|---|---|
| `connect(wsUrl)` | Connect to a CDP WebSocket endpoint |
| `send(method, params?, timeoutMs?)` | Send a CDP command, returns response |
| `on(method, handler)` | Subscribe to CDP events (e.g. `Network.requestWillBeSent`) |
| `off(method)` | Unsubscribe from an event |
| `close()` | Close WebSocket, reject all pending |

Events work like the capture pattern — register `on('Network.loadingFinished', ...)` before navigation to capture responses.

```ts
session.on('Network.responseReceived', (params) => {
  console.log(params.response.url, params.response.status)
})
```

### Targets (`src/targets.ts`)

Page target lifecycle.

| Function | Description |
|---|---|
| `getChromeInfo(cdpHost)` | Browser version, protocol, WebSocket URL |
| `isChromeReachable(cdpHost)` | Lightweight reachability check |
| `listPageTargets(cdpHost)` | All targets (pages, service workers, etc.) |
| `listPageTargetsOnly(cdpHost)` | Filter to page-type targets only |
| `createPageTarget(cdpHost)` | Create new tab, returns `{ targetId, pageWsUrl }` |
| `closePageTarget(cdpHost, targetId)` | Close a specific tab |
| `closeAllPageTargets(cdpHost)` | Close every page tab |

### Browser (`src/browser.ts`)

Chrome process lifecycle — launch, ensure, kill.

| Function | Description |
|---|---|
| `launchChrome(opts?)` | Launch Chrome with `--remote-debugging-port`. No `--enable-automation`. Waits up to 10s for CDP. |
| `ensureChromeRunning(opts?)` | `launchChrome` if not reachable, no-op if already running. Main entry point for consumers. |
| `killChrome(opts?)` | Kill the Chrome process we launched (not externally-managed ones) |
| `isChromeRunning(cdpHost)` | Alias for `isChromeReachable` |

Launch options:
```ts
await ensureChromeRunning({
  port: 9222,
  profileDir: '~/.cache/chrome-cdp',               // default: ~/Library/.../Chrome-CDP
  chromePath: '/Applications/Google Chrome.app/...', // auto-detected per OS
  extraArgs: ['--disable-extensions'],
})
```

Key design (the stealth launch recipe):
- **No `--enable-automation`** — avoids `navigator.webdriver === true` detection
- **Dedicated profile** — separate from everyday Chrome
- **Idempotent** — no-ops if already running
- **Background** — `spawn` with `detached: true`, survives parent exit

### Monitor (`src/monitor.ts`)

Resource usage collection and GC.

| Function | Description |
|---|---|
| `collectResourceUsage(browserSession)` | RSS, JS heap, CPU, cache storage, performance metrics |
| `checkWatermark(usage, thresholds?)` | Compare against thresholds. Returns `{ overMemory, overCache, shouldRestart }` |
| `clearBrowserCache(browserSession)` | Clear `cache_storage` + Network cache |
| `formatResourceUsage(usage)` | Human-readable string for logging |

Default thresholds (configurable):
| Metric | Default threshold |
|---|---|
| RSS memory | 500 MB |
| JS heap | 300 MB |
| Cache storage | 100 MB |

```ts
const usage = await collectResourceUsage(browserSession)
const result = checkWatermark(usage, { maxRssMb: 800 })
if (result.shouldRestart) {
  await clearBrowserCache(browserSession)
  await closeAllPageTargets(cdpHost)
}
console.log(formatResourceUsage(usage))
// "RSS: 342MB | heap: 128/512MB | cache: 12.3MB | CPU: Apple M3 (8 cores)"
```

### Shutdown (`src/shutdown.ts`)

Idle-based auto-shutdown to prevent Chrome process accumulation.

```ts
const shutdown = new IdleShutdown({
  timeoutMs: 120_000,           // 2 minutes idle
  onShutdown: async () => {      // what to do when timer fires
    await closeAllPageTargets(cdpHost)
    await killChrome()
  },
  logger: console.error,
})

// Call reset() on every CDP activity
session.on('Network.requestWillBeSent', () => shutdown.reset())

// To stop without firing:
shutdown.cancel()
```

Convenience factory:
```ts
createPageTargetIdleShutdown(
  () => closeAllPageTargets('127.0.0.1:9222'),
  { shutDownChrome: true, logger: console.error },
)
```

The timer is `unref()`'d so it doesn't block Node.js process exit.

## See also

- [CDP reference](./cdp.md): domain services and session API
- [Chrome manager](./chrome-manager.md): lifecycle and safety shutdown built on this layer
- [Capture](./capture.md): network capture and DOM walk built on this layer
