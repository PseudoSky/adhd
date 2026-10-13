# CDP API Reference — agent-browser Tool

What our CDP tool (`CdpSession` in `src/lib/cdp/session.ts`) can actually query against a live browser.

## Connection Types

Our tool can open two kinds of CDP connections:

1. **Browser-level WS** (`info.webSocketDebuggerUrl` from `/json/version`) — global scope, can manage targets, query histograms, etc.
2. **Page-level WS** (`target.webSocketDebuggerUrl` from `/json/list` or `createPageTarget`) — per-page scope, can query performance, navigation timing, DOM.

## Concrete Queries Available

### 1. List All Page Targets (No Timestamps)

```
→ Target.getTargets()
← [{ targetId, type, title, url, attached, browserContextId, ... }]
```

Quick check: count page-type targets with non-`about:blank` URLs. If any exist, browser is in use.

### 2. Check Page Nav Freshness (One Page at a Time)

```
→ connect to page WS
→ Performance.getMetrics()
← { Timestamp, NavigationStart, DomContentLoaded, ... }
```

`NavigationStart` gives the monotonic time when the page started navigating. The gap between `NavigationStart` and `Timestamp` tells you how long that page has been alive. Requires a WS connection per page — impractical for scanning many targets.

### 3. Aggregate Tab Activity Histogram

```
→ connect to browser WS
→ Browser.getHistograms({ query: "TimeSinceActive2" })
← { name: "Tabs.PageLoad.TimeSinceActive2", buckets: [{ low, high, count }], sum, count }
```

Returns an aggregate distribution across all tabs. A bucket with `high < 5000` means at least one tab was active within the last 5 seconds. Not per-target, but useful as a "is anyone using Chrome?" heuristic.

### 4. Real-Time Target Monitoring

```
→ connect to browser WS
→ Target.setDiscoverTargets({ discover: true })
← events: Target.targetCreated, Target.targetDestroyed, Target.targetInfoChanged
```

From that point forward, receive events as targets are created, change, or are destroyed. No historical replay — only events while connected.

### 5. Target Ownership via BrowserContext

Each target has a `browserContextId`. All targets from our tool's Chrome instance share the same `browserContextId`. If a target exists with a different `browserContextId`, it was created by a different profile (not us). If same `browserContextId`, it's ours — but we can't distinguish which MCP server process created it.

### 6. Process Info

```
→ SystemInfo.getProcessInfo()
← [{ type: "browser" | "renderer" | "gpu" | ..., id: pid, cpuTime: seconds }]
```

Per-process CPU time, but no per-tab mapping.

## What We Cannot Do

| Cannot | Why |
|--------|-----|
| Get per-target `createdAt` timestamp | CDP TargetInfo has no such field |
| Get per-target `lastActiveAt` timestamp | CDP TargetInfo has no such field |
| Get per-target navigation history from browser WS | Must be connected to page WS at time of navigation |
| Determine which MCP process created which target | All targets share same browser context; no process tag |
| Get timestamps for historical events | Events forwarded by `setDiscoverTargets` are live-only |
| Query `Session` history per target | CDP sessions are ephemeral, no history |

## Multi-Process Idle Detection Strategy (Proposed)

Given these constraints, the approach to safely shut down Chrome when multiple MCP server processes share it:

1. **Each process tracks its own `lastSearchAt`** in module memory.
2. **A shared `IdleShutdown` timer** resets on every `search()` call.  
3. **On idle fire**, check CDP `/json/list` (equivalent to `Target.getTargets`):
   - If any `type === "page"` targets exist with real URLs → skip shutdown (Chrome is in use).
   - If zero page targets → check local `lastSearchAt`: if it's within the last 10 seconds, a request might be in-flight → skip.
   - Otherwise → safely shut down (close targets and/or kill Chrome).
4. **No heartbeat file needed** — the browser's own target list is the shared truth.

Rationale: Since our `search()` function now closes its tab in a `finally` block (`closePageTarget`), normal idle state is zero page targets. Stale processes' timers fire, see zero targets, and shut down harmlessly. A live process with an in-flight search would have a target open, protecting Chrome from premature shutdown.
