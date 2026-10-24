# @adhd/stealth-core-browser

A toolbox for driving Chrome via the Chrome DevTools Protocol (CDP) without triggering bot detection. No `Runtime.evaluate`, no `--enable-automation` — Chrome appears as a normal browser.

## Design Philosophy

This package exists because the usual approaches to browser automation — Puppeteer, Playwright, Selenium — all leave detectable fingerprints (`navigator.webdriver`, automation flags, characteristic timing). `@adhd/stealth-core-browser` takes a different approach:

- **No `Runtime.evaluate`** — JavaScript injection is detectable. All data extraction is server-side (CDP network capture → parser).
- **No `--enable-automation`** — Chrome is launched with a clean profile. It looks like a normal user's browser.
- **Network-first extraction** — capture responses from CDP `Network.loadingFinished` + `Network.getResponseBody`. Gives you the same HTML/JSON/XML the browser rendered, without executing in the page context.
- **Read-only Chrome data access** — open Chrome's SQLite databases (History, Cookies, Bookmarks) in immutable mode — no file locking, no corruption risk.

## Entrypoints

| Import path | What it gives you | Status |
|---|---|---|
| `@adhd/stealth-core-browser/cdp` | CDP connection management, domain services, browser lifecycle | Shipped |
| `@adhd/stealth-core-browser/storage` | Read-only access to Chrome's History, Cookies, Bookmarks and Profile databases | Shipped (partial) |
| `@adhd/stealth-core-browser/capture` | Network response capture, DOM tree walk, ban detection, retry/backoff | Shipped |
| `@adhd/stealth-core-browser/parsers` | Server-side HTML (xpath/class/structural) and JSON extraction | Shipped |
| `@adhd/stealth-core-browser/chrome-manager` | Auto-start, activity-bumped idle timer, heartbeat, 3-tier safety shutdown | Shipped |

## Installation

```bash
npm install @adhd/stealth-core-browser
# or
pnpm add @adhd/stealth-core-browser
```

**Prerequisites:**
- Node.js 22+ (uses `node:sqlite` and `WebSocket`)
- Chrome or Chromium installed (auto-detected on macOS, Linux, Windows)
- TypeScript 5+

## Quick Start

### Launch Chrome and navigate

```typescript
import { CdpSession, ensureChromeRunning, createPageTarget } from '@adhd/stealth-core-browser/cdp'

// 1. Ensure Chrome is running (starts it if missing)
const { port, profileDir } = await ensureChromeRunning()
const cdpHost = `127.0.0.1:${port}`

// 2. Create a page target
const { targetId, pageWsUrl } = await createPageTarget(cdpHost)

// 3. Connect and navigate
const page = new CdpSession()
await page.connect(pageWsUrl)
await page.send('Page.navigate', { url: 'https://example.com' })

// 4. Clean up
page.close()
```

### Capture a network response

```typescript
import { captureNetworkResponse } from '@adhd/stealth-core-browser/capture'

const response = await captureNetworkResponse(pageWsUrl, {
  navigateUrl: 'https://example.com/search?q=test',
  urlPattern: /example\.com/,
  timeoutMs: 10_000,
})

console.log(response.body) // Full HTML/JSON of the matched response
```

### Read Chrome history

```typescript
import { HistoryClient } from '@adhd/stealth-core-browser/storage'

const history = new HistoryClient()
const lastVisit = history.getLastVisit()
console.log(`${lastVisit.title} — ${lastVisit.url}`)
```

### Automatic Chrome lifecycle management

```typescript
import { ChromeManager } from '@adhd/stealth-core-browser/chrome-manager'

const chrome = new ChromeManager({ idleTimeoutMs: 120_000 })
await chrome.ready()

// Every CDP operation bumps the idle timer
chrome.bump()

// Or use withBrowser for automatic lifecycle
await chrome.withBrowser(async () => {
  // Chrome is guaranteed running here
  const { pageWsUrl } = await createPageTarget('127.0.0.1:9222')
  // ... do work ...
})

// Shuts down when idle timeout expires (after safety checks)
```

## Module Overview

| Module | Key exports | Documents |
|---|---|---|
| **cdp** | `CdpSession`, `CdpClient`, `TargetService`, `BrowserService`, `PageService`, `NetworkService`, `SystemService`, `launchChrome`, `ensureChromeRunning`, `killChrome`, `createPageTarget`, `IdleShutdown`, `collectResourceUsage` | [docs/cdp.md](./cdp.md) |
| **storage** | `HistoryClient`, `CookieClient`, `BookmarkClient`, `ProfileClient`, `openDb` | [docs/storage.md](./storage.md) |
| **capture** | `captureNetworkResponse`, `walkDomTree`, `checkBans`, `decideRetry`, `detectBanInPage` | [docs/capture.md](./capture.md) |
| **parsers** | `extractWithXpath`, `extractResultsFromHtml`, `extractResultsFromJson`, `extractStructural` | [docs/parsers.md](./parsers.md) |
| **chrome-manager** | `ChromeManager`, `ChromeManagerOptions` | [docs/chrome-manager.md](./chrome-manager.md) |

## Architecture

```
src/lib/
├── cdp/                     # low-level CDP primitives
│   ├── session.ts           # CdpSession — WebSocket CDP session
│   ├── browser.ts           # launchChrome, ensureChromeRunning, killChrome
│   ├── targets.ts           # createPageTarget, listPageTargets, closePageTarget
│   ├── shutdown.ts          # IdleShutdown — auto-shutdown timer
│   └── monitor.ts           # Resource usage tracking, watermarks, cache clearing
├── domains/                 # Higher-level CDP domain wrappers
│   ├── target.ts            # TargetService — page listing, target info
│   ├── browser.ts           # BrowserService — version, histograms, windows
│   ├── page.ts              # PageService — navigation, screenshots, metrics
│   ├── network.ts           # NetworkService — cookie access
│   └── system.ts            # SystemService — system info, processes, memory
├── storage/                 # Read-only Chrome data access
│   ├── history.ts           # HistoryClient — visit/URL/stats queries
│   ├── cookies.ts           # CookieClient — cookie queries
│   ├── bookmarks.ts         # BookmarkClient — bookmark tree
│   └── profile.ts           # ProfileClient — profile data (stubs)
├── capture/                 # CDP-driven capture
│   ├── network.ts           # captureNetworkResponse — event-driven capture
│   ├── dom.ts               # walkDomTree — CDP DOM tree walk
│   └── bans.ts              # checkBans, decideRetry — ban detection
├── parsers.ts               # Server-side response parsers
├── chrome-manager.ts        # ChromeManager — lifecycle + safety shutdown
├── session.ts               # Search session tracking
├── helpers.ts               # Shared helpers (paths, DB, timestamps)
└── types.ts                 # Shared type definitions
```

## Key Design Decisions

### Why no `Runtime.evaluate`?

JavaScript injection via CDP `Runtime.evaluate` is detectable by the page through `navigator.webdriver`, stack trace analysis, and timing fingerprinting. Every major search engine and many commercial sites use these signals to block automated access.

Instead, `@adhd/stealth-core-browser` uses network capture to obtain page data without executing anything in the page context. The browser loads the page normally; the tool intercepts the network response and parses it server-side.

### Why no `--enable-automation`?

The `--enable-automation` flag causes Chrome to:
- Set `navigator.webdriver = true`
- Show "Chrome is being controlled by automated software" banner
- Change TLS handshake behavior

This package launches Chrome without that flag, using only `--remote-debugging-port` and `--user-data-dir` for a dedicated profile. The browser is indistinguishable from a normal Chrome instance.

### Immutable database access

All Chrome SQLite databases (History, Cookies) are opened with `mode=ro&immutable=1` and `PRAGMA query_only = ON`. This means:
- No file locking — multiple processes can read simultaneously
- No risk of corrupting Chrome's databases
- No write access (read-only by design)

## Endpoint policy

Every verb and the chrome manager address Chrome through `endpoint.resolveEndpoint({ host, port })`. The host must be a bare host name or address and, by default, loopback (`127.0.0.1`, `localhost`, `::1`). A hosting process that really talks to a remote Chrome opts in once with `endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })`; the entry point reads no environment variable. The debugger WebSocket URL a Chrome reports must name the host that was asked (`endpoint.assertSameEndpoint`), every CDP HTTP request times out after 5 s, and a frame that is not a CDP message closes the connection with `CDP_BAD_RESPONSE`. The launch lock of a port is reclaimed atomically after 15 s without an owner; a launcher that cannot take it within 30 s fails with `LAUNCH_LOCK_TIMEOUT` and never starts a second Chrome without the lock. A launch that does not answer CDP within 10 s kills the Chrome it spawned (`CHROME_START_TIMEOUT`). `killChrome(port)` signals only the Chrome this process launched on that port, and forgets it the moment the child exits.
