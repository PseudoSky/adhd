# @adhd/stealth-core-browser

A toolbox for driving Chrome via the Chrome DevTools Protocol (CDP) with a lower footprint than the usual automation drivers. No `Runtime.evaluate`, no `--enable-automation`: those two choices are all that "stealth" means here.

## Design Philosophy

This package exists because the usual approaches to browser automation — Puppeteer, Playwright, Selenium — set automation flags (such as `--enable-automation`) and inject script into pages. `@adhd/stealth-core-browser` takes a different approach:

- **No `Runtime.evaluate`** — Injected script runs inside the page. All data extraction is server-side (CDP network capture → parser).
- **No `--enable-automation`** — Chrome is launched with a dedicated profile and without the automation flag.
- **Network-first extraction** — capture responses from CDP `Network.loadingFinished` + `Network.getResponseBody`. Gives you the same HTML/JSON/XML the browser rendered, without executing in the page context.
- **Read-only Chrome data access** — open Chrome's SQLite databases (History, Cookies, Bookmarks) in immutable mode — no file locking, no corruption risk.

## Entrypoints

The package has ONE entry, the root `@adhd/stealth-core-browser`; there are no subpath exports. Areas are namespaces on that root:

| Root export | What it gives you | Status |
|---|---|---|
| `cdp` | CDP connection management, the `CdpClient` domain facade, browser lifecycle | Shipped |
| `storage` | Read-only access to Chrome's History, Cookies, Bookmarks and Profile databases | Shipped |
| `capture` | Network response capture, DOM tree walk, ban detection, retry/backoff | Shipped |
| `parsers` | Server-side HTML (xpath/class/structural) and JSON extraction | Shipped |
| `chromeManager` | Auto-start, activity-bumped idle timer, reaper-host 3-tier safety shutdown | Shipped |
| `lifecycle`, `recording`, `endpoint` | Manager seam and reaper, network recording, endpoint policy | Shipped |

## Installation

```bash
npm install @adhd/stealth-core-browser
# or
pnpm add @adhd/stealth-core-browser
```

**Prerequisites:**
- Node.js 22+ (uses `node:sqlite` and `WebSocket`)
- Chrome or Chromium installed (macOS is the verified platform; see [CONFIGURATION.md](../CONFIGURATION.md))
- TypeScript 5+

## Quick Start

### Launch Chrome and navigate

```typescript
import { cdp } from '@adhd/stealth-core-browser'
const { CdpSession, ensureChromeRunning, createPageTarget } = cdp

// 1. Ensure Chrome is running (starts it if missing)
const { port, profileDir } = await ensureChromeRunning({ port: 9333 })
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
import { capture } from '@adhd/stealth-core-browser'
const { captureNetworkResponse } = capture

const response = await captureNetworkResponse(pageWsUrl, {
  navigateUrl: 'https://example.com/search?q=test',
  urlPattern: /example\.com/,
  timeoutMs: 10_000,
})

console.log(response.body) // Full HTML/JSON of the matched response
```

### Read Chrome history

```typescript
import { storage } from '@adhd/stealth-core-browser'
const { HistoryClient } = storage

const history = new HistoryClient()
const lastVisit = history.getLastVisit() // null when the history is empty
if (lastVisit) console.log(`${lastVisit.title} — ${lastVisit.url}`)
```

### Automatic Chrome lifecycle management

```typescript
import { cdp, chromeManager } from '@adhd/stealth-core-browser'
const { createPageTarget } = cdp
const { ChromeManager } = chromeManager

const chrome = new ChromeManager({ idleTimeoutMs: 120_000 })
await chrome.ready()

// Every CDP operation bumps the idle timer
chrome.bump()

// Or use withBrowser for automatic lifecycle
await chrome.withBrowser(async () => {
  // Chrome is guaranteed running here
  const { pageWsUrl } = await createPageTarget('127.0.0.1:9333')
  // ... do work ...
})

// When the idle timeout expires the reaper host closes Chrome only after its safety checks pass
```

## Module Overview

| Module | Key exports | Documents |
|---|---|---|
| **cdp** | `CdpSession`, `CdpClient`, `launchChrome`, `ensureChromeRunning`, `killChrome`, `createPageTarget`, `IdleShutdown`, `collectResourceUsage` | [docs/cdp.md](./cdp.md) |
| **storage** | `HistoryClient`, `CookieClient`, `BookmarkClient`, `ProfileClient`, `openDb`, `toUnixTimeSql` | [docs/storage.md](./storage.md) |
| **capture** | `captureNetworkResponse`, `walkDomTree`, `checkBans`, `decideRetry`, `captureAllNetworkResponses` | [docs/capture.md](./capture.md) |
| **parsers** | `extractWithXpath`, `extractResultsFromHtml`, `extractResultsFromJson`, `extractStructural`, `extractResultsFromEmbeddedJson` | [docs/parsers.md](./parsers.md) |
| **chrome-manager** | `ChromeManager`, `ChromeManagerOptions`, `isActiveWebTarget` | [docs/chrome-manager.md](./chrome-manager.md) |
| **endpoint** | `configureEndpointPolicy`, `resolveEndpoint`, `assertSameEndpoint`, `isLoopbackHost`, `allowedHosts`, `portOf`, `DEFAULT_HOST`, `DEFAULT_PORT` | [Endpoint policy](#endpoint-policy) below |

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
│   ├── target.ts            # TargetService — page listing, target info (reached through CdpClient)
│   ├── browser.ts           # BrowserService — version, histograms, windows
│   ├── page.ts              # PageService — navigation, screenshots, metrics
│   ├── network.ts           # NetworkService — cookie access
│   └── system.ts            # SystemService — system info, processes, memory
├── storage/                 # Read-only Chrome data access
│   ├── history.ts           # HistoryClient — visit/URL/stats queries
│   ├── cookies.ts           # CookieClient — cookie queries
│   ├── bookmarks.ts         # BookmarkClient — bookmark tree
│   └── profile.ts           # ProfileClient — profile data
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

`Runtime.evaluate` executes script in the page's own context, where the page can observe it. This package avoids that call.

Instead, `@adhd/stealth-core-browser` uses network capture to obtain page data without executing anything in the page context. The browser loads the page normally; the tool intercepts the network response and parses it server-side.

### Why no `--enable-automation`?

The `--enable-automation` flag causes Chrome to:
- Set `navigator.webdriver = true`
- Show "Chrome is being controlled by automated software" banner
- Change TLS handshake behavior

This package launches Chrome without that flag, using only `--remote-debugging-port` and `--user-data-dir` for a dedicated profile. This does not make the browser invisible to a site; see [RESPONSIBLE-USE.md](../RESPONSIBLE-USE.md).

### Immutable database access

All Chrome SQLite databases (History, Cookies, Bookmarks, Profile) are opened with `mode=ro&immutable=1` and `PRAGMA query_only = ON`. This means:
- No file locking — multiple processes can read simultaneously
- No risk of corrupting Chrome's databases
- No write access (read-only by design)

The trade-off: `immutable=1` tells SQLite the file cannot change, so it ignores the write-ahead log. Rows Chrome has written but not yet checkpointed are invisible, and a read of a database Chrome is writing right now can be stale or, rarely, inconsistent. Treat the readers as a view of the last checkpoint. See [storage.md](./storage.md).

## Endpoint policy

Every verb and the chrome manager address Chrome through `endpoint.resolveEndpoint({ host, port })`. The host must be a bare host name or address and, by default, loopback (`127.0.0.1`, `localhost`, `::1`). A hosting process that really talks to a remote Chrome opts in once with `endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })` (the `stealth-search` host exposes this as `--allow-cdp-hosts <comma-separated list>`; loopback only otherwise); the entry point reads no environment variable. The debugger WebSocket URL a Chrome reports must name the host that was asked (`endpoint.assertSameEndpoint`), every CDP HTTP request times out after 5 s, and a frame that is not a CDP message closes the connection with `CDP_BAD_RESPONSE`. The launch lock of a port is reclaimed atomically after 15 s without an owner; a launcher that cannot take it within 30 s fails with `LAUNCH_LOCK_TIMEOUT` and never starts a second Chrome without the lock. A launch that does not answer CDP within 10 s kills the Chrome it spawned (`CHROME_START_TIMEOUT`). `killChrome(port)` stops the process group of the Chrome this process launched on that port and forgets it the moment the child exits; for a Chrome it did not launch it acts only on a listener whose command line carries `--user-data-dir=<resolved profile>` and skips any other listener with a logged reason.

## Verb inputs and results

- `getPageContext({ targetId, host?, port?, userDataDir? })` and `checkChromeActivity({ host?, port?, withinMinutes?, userDataDir? })` read cookies and history from `userDataDir` (default: the dedicated CDP profile). `cookieCount` counts the cookies a request to the page's host would carry (see `CookieClient.getCookiesForHostname`).
- `shutdownChrome()` never throws for a failed shutdown, but an invalid endpoint (a host the endpoint policy refuses) rejects with `CDP_UNREACHABLE` and `detail.reason` `invalid-endpoint` before any work. `ok` is `false` when the soft shutdown itself failed; `running` says whether Chrome still answers afterwards (a deliberate deferral to an active session leaves `ok: true, running: true`).
- A network recording opened through the store sink is created owner-only (0600, in a 0700 directory) together with its `-wal` and `-shm` files, and the open fails with `CAPTURE_SINK_UNAVAILABLE` when that cannot be done. The recorder default stays identity redaction because replay needs the cookies; pass `redactHeaders()` to mask `cookie`, `set-cookie` and `authorization` headers. A token in a URL query string is never masked.
