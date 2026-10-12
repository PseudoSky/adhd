# Monitoring & Timestamps

CDP domains that expose timing data or can be used for activity detection.

## Performance Domain

Source: [chromedevtools.github.io/devtools-protocol/tot/Performance/](https://chromedevtools.github.io/devtools-protocol/tot/Performance/)

Requires connecting to a **page-level** WebSocket (not browser-level).

### `Performance.getMetrics`

Returns metrics for the connected page only:

| Metric | Type | Description |
|--------|------|-------------|
| `Timestamp` | number | Monotonic time since Chrome boot (seconds). |
| `NavigationStart` | number | Monotonic time when page navigation started. |
| `FirstMeaningfulPaint` | number | Monotonic time of meaningful paint. |
| `DomContentLoaded` | number | Monotonic time of DOMContentLoaded. |
| `JSHeapUsedSize` | number | Current JS heap usage in bytes. |
| `Documents` / `Nodes` / `Frames` | number | Counts of live DOM objects. |

These are **monotonic clock** values (`performance.now()` base), not wall-clock timestamps. Can be used to compute relative age of a page's navigation.

### `Performance.enable` / `Performance.disable`

Turns on/off performance metric collection for the target.

## Browser Domain — Histograms

Source: [chromedevtools.github.io/devtools-protocol/tot/Browser/](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)

### `Browser.getHistograms`

Query Chrome's UMA histograms by name substring.

Relevant histograms for idle/activity tracking:

| Histogram Name | Description |
|----------------|-------------|
| `Tabs.PageLoad.TimeSinceActive2` | Aggregate distribution of milliseconds since each tab was last active. Buckets: 45ms, 70ms, 108ms, 167ms, 259ms, 401ms, 621ms, 962ms, 1491ms, 5545ms, 8591ms, etc. |
| `Tabs.PageLoad.TimeSinceCreated2` | Aggregate distribution of milliseconds since each tab was created. Same bucket structure. |
| `PageLoad.PageTiming.ForegroundDuration` | How long pages have been in foreground. |

**Important:** These are **aggregate histograms**, not per-target. They merge data across all tabs. You get sums, counts, and bucket ranges — not individual target timestamps.

### `Browser.getHistogram`

Same as above but for a single named histogram.

## Page Domain — Lifecycle Events

Source: [chromedevtools.github.io/devtools-protocol/tot/Page/](https://chromedevtools.github.io/devtools-protocol/tot/Page/)

Events with timestamps (require real-time connection):

| Event | Timestamp Field | When |
|-------|----------------|------|
| `Page.domContentEventFired` | `timestamp` (monotonic) | DOM ready. |
| `Page.loadEventFired` | `timestamp` (monotonic) | Page fully loaded. |
| `Page.lifecycleEvent` | `timestamp` (monotonic) | Lifecycle phases: `init`, `firstPaint`, `firstContentfulPaint`, `DOMContentLoaded`, `load`, `networkAlmostIdle`, `networkIdle`. |

These are **events only** — no historical querying. You must be connected to the page's WebSocket at the time they fire.

## SystemInfo Domain

Source: [chromedevtools.github.io/devtools-protocol/tot/SystemInfo/](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/)

### `SystemInfo.getProcessInfo`

Returns all browser processes with `{type, id, cpuTime}` — no per-target timestamps.

### `SystemInfo.getInfo`

Returns system-level GPU and model info. Not useful for activity tracking.

## Summary

| What | Method | Timestamps? | Per-target? |
|------|--------|-------------|-------------|
| List targets | `Target.getTargets` | No | Yes |
| Target info | `Target.getTargetInfo` | No | Yes |
| Page nav timing | `Performance.getMetrics` | Monotonic only | Yes (page-level WS) |
| Tab activity histograms | `Browser.getHistograms` | Aggregate only | No |
| Browser processes | `SystemInfo.getProcessInfo` | CPU time only | Per-process, not per-tab |
| Real-time lifecycle | `Page.lifecycleEvent` | Monotonic | Yes (event, not query) |
| Target creation/destroy | `Target.targetCreated`/`targetDestroyed` | No (event only) | Yes |
