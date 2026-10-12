# CDP Usage — agent-browser

How `CdpSession` connects and uses the Chrome DevTools Protocol.

---

## Connection Types

### Browser-Level WebSocket

```
ws://host:port/devtools/browser/<browserId>
```

Obtained from `GET /json/version` → `webSocketDebuggerUrl`. Provides access to:
- `Target.*` — list, create, close, and discover targets
- `Browser.*` — histograms, version, permissions
- `SystemInfo.*` — process list, GPU info

### Page-Level WebSocket

```
ws://host:port/devtools/page/<targetId>
```

Obtained from `GET /json/list` or by creating a target via `createPageTarget()`. Provides access to:
- `Page.*` — navigation, screenshots, frames
- `Network.*` — request/response capture
- `Runtime.*` — JavaScript evaluation (banned in this project)
- `DOM.*` — DOM tree inspection
- `Performance.*` — per-page metrics

---

## Connection Lifecycle

```typescript
// 1. Check if Chrome is reachable
const info = await getChromeInfo('127.0.0.1:9222')
// → { browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/...', ... }

// 2. Create a browser-level session
const browser = new CdpSession()
await browser.connect(info.browserWsUrl)

// 3. Create a page target
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')

// 4. Create a page-level session
const page = new CdpSession()
await page.connect(pageWsUrl)

// 5. Use the page session
await page.send('Page.enable')
await page.send('Page.navigate', { url: 'https://example.com' })

// 6. Clean up
page.close()
await closePageTarget('127.0.0.1:9222', targetId)
browser.close()
```

---

## `CdpSession.send()` Pattern

```typescript
class CdpSession {
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<T>
}
```

- Method names follow `Domain.action` format (e.g., `'Target.createTarget'`)
- Params are the CDP command parameters as a flat object
- Returns the `result` object directly (not wrapped in the JSON-RPC envelope)
- Auto-increments a numeric `id` per message
- Timeout rejects pending commands after `timeoutMs` (default 30s)
- Errors from CDP (`msg.error`) reject the promise with an `Error`

### Commands used in agent-browser

| Method | When | Purpose |
|--------|------|---------|
| `Target.createTarget` | Per-search | Open a blank page for navigation |
| `Target.closeTarget` | Search cleanup | Close the page tab |
| `Page.enable` | Per-page session | Subscribe to page events |
| `Page.navigate` | Per-search | Navigate to search URL |
| `Network.enable` | Per-page session | Capture network responses |
| `Network.getResponseBody` | Per-response | Extract HTML body from network |
| `Performance.getMetrics` | Per-page | Get nav timestamps |
| `Browser.getHistograms` | Browser session | Get aggregate timing data |

---

## Target Lifecycle

```typescript
import { createPageTarget, closePageTarget } from '@adhd/stealth-browser/cdp'

// Create — opens about:blank, returns { targetId, pageWsUrl }
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')

// Use the page...
const page = new CdpSession()
await page.connect(pageWsUrl)
await page.send('Page.navigate', { url: 'https://example.com' })
// ... search logic ...
page.close()

// Close — always runs in finally block
await closePageTarget('127.0.0.1:9222', targetId)
```

The `createPageTarget` function:
1. Opens a browser-level WS
2. Calls `Target.createTarget({ url: 'about:blank' })` to create the page
3. Polls `GET /json/list` until the target's `webSocketDebuggerUrl` appears
4. Returns both `targetId` and `pageWsUrl`

The `closePageTarget` function:
1. Opens a browser-level WS
2. Sends `{ id: 1, method: 'Target.closeTarget', params: { targetId } }`
3. Best-effort — catches errors silently

All page targets are closed in `finally` blocks to prevent leaks:
```typescript
const { targetId, pageWsUrl } = await createPageTarget(cdpHost)
try {
  // ... search logic ...
} finally {
  await closePageTarget(cdpHost, targetId).catch(() => {})
}
```

---

## Event Subscription

```typescript
const page = new CdpSession()
await page.connect(pageWsUrl)

// Subscribe to an event
page.on('Network.requestWillBeSent', (params) => {
  console.log('Request:', params.request.url)
})

// Navigate — events fire in real-time
await page.send('Page.navigate', { url: 'https://example.com' })

// Unsubscribe
page.off('Network.requestWillBeSent')

page.close()
```

### Events used in agent-browser

| Event | Purpose |
|-------|---------|
| `Network.requestWillBeSent` | Track outgoing requests (URL matching) |
| `Network.responseReceived` | Track response headers, status codes |
| `Network.loadingFinished` | Request complete — trigger `getResponseBody` |
| `Page.frameStartedLoading` | Navigation began |
| `Page.frameStoppedLoading` | Navigation finished |
| `Page.lifecycleEvent` | Track network/first-paint timing |

### Event capture pattern for search

```typescript
const responses: Map<string, { body: string; url: string }> = new Map()

page.on('Network.loadingFinished', async (params) => {
  const requestId = params.requestId as string
  const { body } = await page.send('Network.getResponseBody', { requestId })
  responses.set(requestId, { body, url: /* from requestWillBeSent */ })
})
```

---

## Browser-Level Discovery

```typescript
const browser = new CdpSession()
await browser.connect(browserWsUrl)

// Subscribe to target lifecycle
await browser.send('Target.setDiscoverTargets', { discover: true })

browser.on('Target.targetCreated', (info) => {
  console.log('New target:', info.targetInfo.url)
})

browser.on('Target.targetDestroyed', (info) => {
  console.log('Target destroyed:', info.targetId)
})
```

This is used in the idle shutdown heuristic to monitor whether the Chrome instance has any active page targets besides those created by the current process.

---

## Session Cleanup

Always close sessions and targets in `finally` blocks:

```typescript
let page: CdpSession | null = null
try {
  page = new CdpSession()
  await page.connect(pageWsUrl)
  // ... work ...
} finally {
  page?.close()
}
```

The `close()` method:
- Sets `_connected = false`
- Closes the WebSocket
- Rejects all pending commands with `'Session closed'`
- Clears all event handlers
