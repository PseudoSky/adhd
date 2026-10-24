# Target Domain

Source: [chromedevtools.github.io/devtools-protocol/tot/Target/](https://chromedevtools.github.io/devtools-protocol/tot/Target/)

## TargetInfo Type

```ts
{
  targetId: TargetID
  type: string              // "page", "iframe", "worker", "service_worker", "browser", "tab"
  title: string
  url: string
  attached: boolean         // whether a debugging client is attached
  parentId?: TargetID      // parent target (iframe→page, worker→page)
  openerId?: TargetID       // opener target
  canAccessOpener?: boolean // experimental
  openerFrameId?: string    // experimental, frame id of originating window
  parentFrameId?: string    // experimental
  browserContextId?: string // experimental
  subtype?: string          // experimental, e.g. "prerender" for type "page"
  embedderData?: object     // experimental, only for type "tab"
}
```

**No timestamp fields.** No creation time, last-active time, or navigation time.

## Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `Target.getTargets` | `TargetInfo[]` | List all targets (filterable via `TargetFilter`). |
| `Target.getTargetInfo` | `TargetInfo` | Extended info for a single target (same fields as above). |
| `Target.createTarget` | `targetId` | Create a new page/tab. |
| `Target.closeTarget` | `success` | Close a target (and its page if page-type). |
| `Target.activateTarget` | — | Focus/bring to front. |
| `Target.attachToTarget` | `sessionId` | Create a debugging session to a target. |
| `Target.setDiscoverTargets` | — | Subscribe to `targetCreated`/`targetDestroyed`/`targetInfoChanged` events. |

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `Target.targetCreated` | `targetInfo` | New inspection target created. No timestamp in payload. |
| `Target.targetDestroyed` | `targetId` | Target destroyed. No timestamp. |
| `Target.targetInfoChanged` | `targetInfo` | Info changed (title, url, attached). No timestamp. |
| `Target.targetCrashed` | `targetId, status, errorCode` | Target crashed. |

## Key Takeaways

1. **No per-target timestamps** via `getTargets`, `getTargetInfo`, or events.
2. `targetInfoChanged` fires when title/URL changes — but the only way to track timing is to **connect and listen in real-time**.
3. Targets with non-`about:blank` URLs + `type === "page"` indicate an actively loaded page. Our tool closes tabs after each search, so lingering non-blank pages = another process is using Chrome.
4. `Target.closeTarget` is the mechanism used by `closePageTarget` in our CDP tool.
