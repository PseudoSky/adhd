# Target Timing — Deep Dive

**The core question:** Can we know when a CDP target was created or last active?

**Short answer:** No — `TargetInfo` has no timestamp fields, and no CDP endpoint provides per-target wall-clock timestamps.

---

## What TargetInfo Exposes (Verified)

`Target.getTargets()` and `Target.getTargetInfo()` return `TargetInfo` objects with:

```typescript
{
  targetId: TargetID          // opaque ID
  type: string                // "page", "iframe", "worker", etc.
  title: string
  url: string
  attached: boolean           // debugging client attached?
  parentId?: TargetID
  openerId?: TargetID
  canAccessOpener?: boolean
  openerFrameId?: string      // experimental
  parentFrameId?: string      // experimental
  browserContextId?: string   // experimental
  subtype?: string            // "prerender", etc.
}
```

**No creation timestamp. No last-active timestamp. No navigation timestamp.**

Events also lack timestamps:
- `Target.targetCreated` — fires when created, payload is `TargetInfo` (no timestamp)
- `Target.targetDestroyed` — payload is just `targetId`
- `Target.targetInfoChanged` — payload is `TargetInfo` (no timestamp)

You cannot query historical timing data. The only way to track timing is to be connected and record it yourself.

---

## Workarounds

### 1. Real-Time Event Recording (The Practical Approach)

The most reliable approach: record timestamps locally when events fire.

```typescript
const browser = new CdpSession()
await browser.connect(browserWsUrl)
await browser.send('Target.setDiscoverTargets', { discover: true })
await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

const targetCreatedAt = new Map<string, number>()

browser.on('Target.targetCreated', (params) => {
  const info = params.targetInfo as any
  targetCreatedAt.set(info.targetId, Date.now())
  console.log(`Target ${info.targetId} created at ${new Date().toISOString()}`)
})

browser.on('Target.targetDestroyed', (params) => {
  const targetId = params.targetId as string
  const createdAt = targetCreatedAt.get(targetId)
  const age = createdAt ? Date.now() - createdAt : 'unknown'
  console.log(`Target ${targetId} destroyed, age: ${age}ms`)
  targetCreatedAt.delete(targetId)
})
```

**Limitations:** Only works while the WebSocket is open. No historical data on connect.

### 2. Performance.getMetrics (Page-Level, Monotonic)

Connect to a page-level WS and query:

```typescript
const metrics = await page.send('Performance.getMetrics')
// → [{name: "Timestamp", value: 123456.78}, {name: "NavigationStart", value: ...}, ...]
```

Key metrics:
| Metric | Description |
|--------|-------------|
| `Timestamp` | Monotonic time since Chrome boot (seconds) |
| `NavigationStart` | Monotonic time when page navigation started |
| `DomContentLoaded` | Monotonic time of DOMContentLoaded |
| `FirstMeaningfulPaint` | Monotonic time of meaningful paint |
| `JSHeapUsedSize` | Current JS heap usage in bytes |

**Use case:** Compute how long a page has been alive:
```
pageAge = Timestamp - NavigationStart
```

**Limitations:**
- Requires a WebSocket connection to the target (one at a time)
- Values are monotonic (`performance.now()` base), not wall-clock
- `Performance.enable` must be called first
- Can't scan all open targets efficiently

### 3. Performance.Timeline (Page-Level, Real-Time)

The `PerformanceTimeline` domain reports performance observer events (LCP, layout shifts) as they happen:

```typescript
await page.send('PerformanceTimeline.enable', {
  eventTypes: ['largest-contentful-paint', 'layout-shift']
})

page.on('PerformanceTimeline.timelineEventAdded', (event) => {
  // event.type
  // event.time — ⚠️ UNIX EPOCH SECONDS, *not* monotonic. See below.
})
```

**Limitations:** Events only, no historical querying.

> ⚠️ **`event.time` is NOT on the same clock as `Network.*` timestamps.**
> Measured on Chrome 150 (2026-07-16): `timelineEventAdded.event.time` is a
> **Unix-epoch** value (e.g. `1784220851.590`), while `Network.requestWillBeSent`
> / `loadingFinished` `timestamp` is **monotonic-since-boot** (e.g. `329459.921`).
> Subtracting one from the other yields nonsense — an earlier version of this doc
> described these values as monotonic, and a design that joined the two streams
> rested on that error.
>
> To correlate them, reconcile via `Network.requestWillBeSent`, which carries
> **both** `timestamp` (monotonic) and `wallTime` (epoch); their difference is
> the offset. (Note §2's "monotonic (`performance.now()` base)" claim is about
> the **`Performance` domain**'s `getMetrics`, which is a separate thing and is
> not contradicted here — it was not measured.)

### 4. Page.lifecycleEvent (Page-Level, Real-Time)

The `Page.lifecycleEvent` event reports lifecycle phases with monotonic timestamps:

```typescript
page.on('Page.lifecycleEvent', (event) => {
  // event.name: "init", "firstPaint", "firstContentfulPaint",
  //            "DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle"
  // event.timestamp: monotonic seconds
})
```

**Limitations:** Events only. Requires `Page.setLifecycleEventsEnabled(true)`.

### 5. Browser.getHistograms (Browser-Level, Aggregate)

Query Chrome's UMA histograms for aggregate timing data:

```typescript
const h = await browser.send('Browser.getHistogram', {
  name: 'Tabs.PageLoad.TimeSinceActive2'
})
// → { name, sum, count, buckets: [{low, high, count}, ...] }
```

Relevant histograms:

| Histogram | Description |
|-----------|-------------|
| `Tabs.PageLoad.TimeSinceActive2` | ms since each tab was last active (aggregate) |
| `Tabs.PageLoad.TimeSinceCreated2` | ms since each tab was created (aggregate) |
| `PageLoad.PageTiming.ForegroundDuration` | how long pages have been in foreground |

**Limitations:**
- **Aggregate only** — merges data across all tabs
- You get bucket counts, not per-target values
- A bucket with `high < 5000` and `count > 0` means at least one tab was active in the last 5s — useful as a heuristic
- No way to identify which target contributed to which bucket

### 6. SystemInfo.getProcessInfo (Browser-Level, Per-Process)

```typescript
const info = await browser.send('SystemInfo.getProcessInfo')
// → [{type: "browser", id: 123, cpuTime: 45.2}, {type: "renderer", ...}, ...]
```

**Limitations:** Per-process CPU time, no per-tab mapping. A renderer process may host multiple tabs (site isolation complicates the mapping).

### 7. Page.getMetrics / Page.getLayoutMetrics (Page-Level)

```typescript
const metrics = await page.send('Page.getLayoutMetrics')
// → { layoutViewport, visualViewport, contentSize, cssLayoutViewport, ... }
```

**Limitations:** No timing data — only layout geometry.

---

## The Idle Shutdown Proposal

Given these constraints, the multi-process idle detection strategy:

### Heuristic

```typescript
async function shouldShutdown(): Promise<boolean> {
  // 1. Check target list
  const targets = await browser.send('Target.getTargets')
  const livePages = targets.targetInfos.filter(
    (t: any) => t.type === 'page' && t.url !== 'about:blank'
  )

  // If any real page exists, someone else is using Chrome
  if (livePages.length > 0) return false

  // 2. Check our own last activity
  if (Date.now() - lastSearchAt < 10_000) return false // request in flight

  // 3. (Optional) Check histogram for recent activity
  const hist = await browser.send('Browser.getHistogram', {
    name: 'Tabs.PageLoad.TimeSinceActive2'
  })
  const recentBucket = hist.buckets.find((b: any) => b.high < 5000)
  if (recentBucket && recentBucket.count > 0) return false // recent activity

  // 4. Shut down
  return true
}
```

### Strengths

- Zero coordination between processes (Chrome's target list is the shared truth)
- No heartbeat files, no IPC
- Each process's `finally` block closes its own target
- Normal idle state = zero page targets → safe to shutdown

### Weaknesses

- Cannot distinguish between "our process's target" and "another process's target" with same `browserContextId`
- Aggregate histogram is noisy in multi-tab scenarios
- Race: a target may be about to be created but not yet visible

### Recommendation

The target-list-only heuristic (step 1) is sufficient for safety. Steps 2–3 are refinements to prevent false positives. The histogram check (step 3) is optional and may be removed if it adds latency without benefit.
