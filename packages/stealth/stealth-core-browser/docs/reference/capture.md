# `/capture` — Network Capture and Ban Detection

The capture module provides event-driven CDP network capture and server-side DOM extraction without using `Runtime.evaluate`. It also includes ban/rate-limit detection and exponential-backoff retry logic.

**Philosophy:** Capture from network responses, not from the DOM. Network capture is indistinguishable from normal browser behavior. DOM extraction (via CDP DOM API, not JS injection) is available as a fallback for SPAs.

## `captureNetworkResponse`

Event-driven CDP network capture. Opens a WebSocket to a page, subscribes to `Network` events, captures every response matching a URL pattern, and returns the body.

**Flow:**
1. Connect via WebSocket to the page's `webSocketDebuggerUrl`
2. Send `Page.enable` + `Network.enable`
3. Subscribe to CDP network events
4. Navigate to `navigateUrl`
5. Track requests matching `urlPattern` via `Network.requestWillBeSent`
6. On `Network.loadingFinished` for matched requests, call `Network.getResponseBody`
7. Buffer all captured responses; pick the best one after `extraWaitMs`
8. Optionally run ban detection rules before returning

**Speed:** Typically ~800ms for static HTML providers.

```typescript
import { capture } from '@adhd/stealth-core-browser'
const { captureNetworkResponse } = capture

const response = await captureNetworkResponse(
  pageWsUrl,                             // From createPageTarget()
  {
    navigateUrl: 'https://example.com/search?q=typescript',
    urlPattern: /example\.com\/search/,   // Match the search results URL
    timeoutMs: 10_000,                    // Max wait for response
    extraWaitMs: 500,                     // Extra buffer after first capture
    banRules: [{                          // Optional ban detection
      name: 'captcha',
      signal: 'captcha',
      checkStatus: [403, 429],
      checkBody: /captcha/i,
    }],
  },
)

// Captured response
console.log(response.status)    // HTTP status code
console.log(response.url)       // Captured URL
console.log(response.body)      // Full response body (HTML/JSON/XML)
console.log(response.requestId) // CDP request ID
```

### `CaptureOptions`

```typescript
interface CaptureOptions {
  /** Regex matching URLs to capture (matched against Network.requestWillBeSent URLs) */
  urlPattern: RegExp
  /** URL to navigate to */
  navigateUrl: string
  /** Max time to wait for a matching response (ms). Default: 10_000 */
  timeoutMs?: number
  /** Extra time to wait after first body capture before returning (ms). Default: 0 */
  extraWaitMs?: number
  /** Ban detection rules to check against captured responses */
  banRules?: BanRule[]
}
```

### `CapturedResponse`

```typescript
interface CapturedResponse {
  requestId: string
  url: string
  status: number
  body: string
  responseHeaders?: Record<string, string>
}
```

### How the capture buffer works

The function tracks all network requests whose URL matches `urlPattern`. When a matching request finishes (`Network.loadingFinished`), it fetches the response body via `Network.getResponseBody`. All captured bodies are buffered.

After the first body is captured, the function waits `extraWaitMs` (or 500ms default) before finalizing. This allows late-arriving responses (e.g., from redirects or secondary API calls) to be captured too. The final result chooses the best match:

1. Prefer the first captured response body
2. Fallback to the last captured body
3. Throw `CAPTURE_TIMEOUT` if nothing was captured

### Ban detection during capture

If `banRules` are provided, the captured response is checked before returning:

```typescript
// If any rule matches, captureNetworkResponse throws a CaptureError:
//   code: 'CAPTURE_BAN_DETECTED'
//   detail: { signal: 'captcha' | 'banned' | 'rate_limited' | ..., url, status }
```

### Error Handling

| Condition | Throws |
|---|---|
| No matching request captured after `timeoutMs` | `CaptureError` `CAPTURE_TIMEOUT` (or `CAPTURE_NO_MATCH` when responses were captured but none matched) |
| WebSocket connection fails | `CaptureError` `CAPTURE_CONNECT_FAILED` |
| Socket closes before a match | `CaptureError` `CAPTURE_SESSION_CLOSED` |
| Ban rule matches | `CaptureError` `CAPTURE_BAN_DETECTED`, `detail.signal` is the rule's signal |

Every code is documented in [ERRORS.md](../ERRORS.md).

## `walkDomTree`

Walk the CDP DOM tree of a page to extract results using pattern-based or structural extraction. Uses `DOM.getDocument({depth:-1})` — no `Runtime.evaluate`.

**Use this only when network capture can't reach the data (e.g., SPAs that load data via client-side rendering).**

```typescript
import { capture, cdp } from '@adhd/stealth-core-browser'
const { walkDomTree } = capture
const { CdpSession } = cdp

const page = new CdpSession()
await page.connect(pageWsUrl)

const results = await walkDomTree(
  page,
  {
    navigateUrl: 'https://example.com/search',
    waitFor: 'div.results',
    timeoutMs: 10_000,
  },
  {
    container: { tag: 'DIV', attrs: { class: 'result' } },
    title: { tag: 'H3' },
    link: { tag: 'A', attr: 'href' },
    snippet: { tag: 'P' },
  },
)

for (const r of results) {
  console.log(`${r.title}: ${r.url}`)
}
```

### `DomWalkOptions`

```typescript
interface DomWalkOptions {
  /** URL to navigate to */
  navigateUrl: string
  /** CSS selector to wait for before extracting */
  waitFor: string
  /** Timeout for waiting. Default: 10_000ms */
  timeoutMs: number
}
```

### `DomExtractor` — Pattern-based extraction

```typescript
interface DomExtractor {
  /** If true, use structural position-based extraction (Google, class-independent) */
  structural?: boolean
  /** Container element filter */
  container?: DomPattern
  /** Title extraction pattern */
  title?: DomPattern & { attr?: string }
  /** Link extraction pattern (requires attr) */
  link?: DomPattern & { attr: string }
  /** Snippet extraction pattern */
  snippet?: DomPattern
  /** Extra metadata fields to extract */
  extra?: Record<string, DomPattern & { attr?: string }>
}
```

### `DomPattern`

```typescript
interface DomPattern {
  tag?: string
  attrs?: Record<string, string | RegExp>
  text?: RegExp
}
```

### Structural extraction (Google-optimized)

When `structural: true` is set in the `DomExtractor`, `walkDomTree` uses a Google-specific extraction strategy that finds `a[jsname]` elements matching the `> div > div` wrapper structure — a stable structural marker that identifies real search results (not sidebar links, video timestamps, or knowledge panels):

```typescript
const results = await walkDomTree(
  page,
  { navigateUrl, waitFor: 'body', timeoutMs: 10_000 },
  { structural: true },
)
```

The structural walker:
1. Walks the full DOM tree collecting `a[jsname]` elements with `href` attributes
2. Filters to only those matching `> div > div` (the real-result marker)
3. Finds the title (heading tag H2/H3 inside the anchor)
4. Walks up to find the result card container (first div with ≥3 children and >50 chars)
5. Extracts the snippet (longest descriptive text >40 chars)

### `detectBanInPage`

Check the rendered DOM for common captcha/ban patterns. Uses broad CSS selector matching.

```typescript
import { capture } from '@adhd/stealth-core-browser'
const { detectBanInPage } = capture

const banSignal = await detectBanInPage(pageSession, docNodeId)
if (banSignal) {
  console.log(`Ban detected: ${banSignal}`)
}
// Returns: 'captcha' | null
```

**Check selectors:** `.g-recaptcha`, `#captcha`, `.captcha`, `[class*="captcha"]`, `[class*="challenge"]`, `#challenge-running`

## `checkBans`

Check a response (URL, status, body) against a set of ban rules.

```typescript
import { capture, type BanRule, type BanSignal } from '@adhd/stealth-core-browser'
const { checkBans } = capture

const signal = checkBans(
  [
    { name: 'rate-limit', signal: 'rate_limited', checkStatus: [429] },
    { name: 'captcha-page', signal: 'captcha', checkBody: /captcha|challenge/i },
    { name: 'blocked-ip', signal: 'banned', checkUrl: /blocked\.example\.com/ },
  ],
  { url: 'https://example.com/search', status: 200, body: '<html>...</html>' },
)

if (signal) {
  console.log(`Ban signal detected: ${signal}`)
}
```

### `BanRule`

```typescript
interface BanRule {
  name: string
  signal: BanSignal
  checkUrl?: RegExp      // Check the response URL path
  checkStatus?: number[] // Check HTTP status code
  checkBody?: RegExp     // Check if body contains a pattern
}
```

### `BanSignal`

```typescript
type BanSignal = 'captcha' | 'banned' | 'rate_limited' | 'login_required'
```

### `BanCheckContext`

```typescript
interface BanCheckContext {
  url: string
  status: number
  body: string
}
```

The function evaluates rules in order; the first matching rule wins. Each rule can check URL, status, body, or any combination.

## `decideRetry`

Given a response outcome and retry configuration, decide whether to retry and how long to wait. Implements exponential backoff with jitter.

```typescript
import { capture, type RetryConfig } from '@adhd/stealth-core-browser'
const { decideRetry } = capture

const config: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  onCaptcha: 'retry',       // 'retry' | 'abort' | 'hitl'
  onRateLimit: 'retry',     // 'retry' | 'abort' | 'hitl'
  onTimeout: 'retry',       // 'retry' | 'abort'
  onBan: 'abort',           // 'abort' | 'hitl'
}

for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
  const result = await performSearch()
  const decision = decideRetry({ outcome: result.outcome }, attempt, config)

  if (!decision.shouldRetry) {
    console.log(`Not retrying: ${decision.reason}`)
    break
  }

  console.log(`Retry ${attempt + 1} in ${decision.delayMs}ms: ${decision.reason}`)
  if (decision.delayMs > 0) {
    await new Promise(r => setTimeout(r, decision.delayMs))
  }
}
```

### `RetryConfig`

```typescript
interface RetryConfig {
  maxAttempts: number
  baseDelayMs: number
  onCaptcha: 'retry' | 'abort' | 'hitl'
  onRateLimit: 'retry' | 'abort' | 'hitl'
  onTimeout: 'retry' | 'abort'
  onBan: 'abort' | 'hitl'
}
```

### `RetryDecision`

```typescript
interface RetryDecision {
  shouldRetry: boolean
  delayMs: number
  reason: string
}
```

### Decision Matrix

| Outcome | `on*` setting | Result |
|---|---|---|
| `success` | (any) | No retry — already succeeded |
| `captcha` | `retry` | Retry with backoff (multiplier: 2) |
| `captcha` | `abort` | No retry |
| `captcha` | `hitl` | Retry immediately (0ms delay) — user is solving |
| `rate_limited` | `retry` | Retry with backoff (multiplier: 2.5, more aggressive) |
| `rate_limited` | `abort` | No retry |
| `rate_limited` | `hitl` | Retry immediately |
| `banned` | `abort` | No retry |
| `banned` | `hitl` | Retry immediately — user must unban |
| `timeout` | `retry` | Retry with backoff (multiplier: 2) |
| `timeout` | `abort` | No retry |
| `empty` / `error` | (always retry) | Retry with backoff (multiplier: 2) |
| Any outcome past `maxAttempts` | — | No retry |

### Backoff Formula

```
delay = min(baseDelayMs * multiplier^attempt + random_jitter, 30_000)
```

- Jitter: 0-30% of the calculated delay
- Rate limiting uses a 2.5× multiplier (more aggressive spacing)
- All delays capped at 30 seconds

## Combined Pattern: Network Capture with Retry

```typescript
import { cdp, capture, StealthCoreBrowserError } from '@adhd/stealth-core-browser'
const { CdpSession, createPageTarget, closePageTarget, ensureChromeRunning } = cdp
const { captureNetworkResponse, decideRetry } = capture

const config = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  onCaptcha: 'abort' as const,
  onRateLimit: 'retry' as const,
  onTimeout: 'retry' as const,
  onBan: 'abort' as const,
}

await ensureChromeRunning()
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')

try {
  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      const response = await captureNetworkResponse(pageWsUrl, {
        navigateUrl: 'https://example.com/search?q=typescript',
        urlPattern: /example\.com\/search/,
        timeoutMs: 10_000,
        banRules: [
          { name: 'rate-limit', signal: 'rate_limited', checkStatus: [429] },
          { name: 'captcha', signal: 'captcha', checkBody: /captcha/i },
        ],
      })

      console.log(`Captured: ${response.url} (${response.status})`)
      break // success

    } catch (err) {
      if (!(err instanceof StealthCoreBrowserError)) throw err
      let outcome: string
      if (err.code === 'CAPTURE_BAN_DETECTED') {
        const signal = (err.detail as { signal?: string } | undefined)?.signal
        outcome = signal === 'captcha' || signal === 'rate_limited' || signal === 'banned' ? signal : 'error'
      } else if (err.code === 'CAPTURE_TIMEOUT') outcome = 'timeout'
      else outcome = 'error'

      const decision = decideRetry({ outcome }, attempt, config)
      if (!decision.shouldRetry) {
        throw new Error(`Failed after ${attempt + 1} attempts: ${decision.reason}`)
      }

      console.log(`Attempt ${attempt + 1}: ${decision.reason} (wait ${decision.delayMs}ms)`)
      if (decision.delayMs > 0) await new Promise(r => setTimeout(r, decision.delayMs))
    }
  }
} finally {
  await closePageTarget('127.0.0.1:9222', targetId)
}
```
