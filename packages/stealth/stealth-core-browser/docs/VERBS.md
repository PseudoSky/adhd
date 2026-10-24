# Verbs

The six flat verbs of `@adhd/stealth-core-browser`. Each takes one plain, JSON-serializable object (or none) and returns plain JSON. `host` defaults to `127.0.0.1` and `port` to `9222`; see [CONFIGURATION.md](CONFIGURATION.md). Error codes are in [ERRORS.md](ERRORS.md).

Every verb that takes an endpoint rejects an unusable one (a non-integer port, a port outside 1-65535, a host that is not loopback and not allowed by the hosting process) with `CDP_UNREACHABLE` and `detail.reason` `invalid-endpoint`, before any socket is opened.

| Verb | Input | Returns | Notes |
|---|---|---|---|
| `chromeStatus` | `{ host?, port? }` | `{ running: boolean, managed: boolean, version?: string, protocol?: string }` | Nothing answering is not an error: it returns `{ running: false, managed: false }`. `managed` is true when this process launched and manages that Chrome. |
| `launchChrome` | `{ port?, userDataDir? }` | `{ ok: true, port }` | Starts Chrome if none runs and hides its windows; an already running Chrome of the same profile is reused. Refuses a Chrome on the port that is not this tool's own with `LAUNCH_FAILED` (`detail.reason` `foreign-profile`). Other failures: `CHROME_NOT_FOUND`, `PORT_IN_USE`, `CHROME_START_TIMEOUT`, `LAUNCH_FAILED`, `LAUNCH_LOCK_TIMEOUT`, `CHROME_UNREACHABLE_AFTER_LAUNCH`, `LAUNCH_CIRCUIT_OPEN`. |
| `shutdownChrome` | `{ host?, port? }` | `{ ok: boolean, running: boolean }` | Soft shutdown: closes Chrome only when it is idle, deferring to other sessions and open web pages. `ok: true, running: true` means it deferred. A failed shutdown does not throw: `ok` is `false`. Only an invalid endpoint rejects. |
| `listPageTargets` | `{ host?, port? }` | `{ targets: { id, type, url, webSocketDebuggerUrl? }[] }` | Open tabs only; service workers and background pages are excluded. `CDP_UNREACHABLE` when nothing answers. |
| `checkChromeActivity` | `{ host?, port?, withinMinutes?, userDataDir? }` | `{ activePages, pageTargets, lastVisit, recentlyUsed, meta }` | `withinMinutes` defaults to 2. `lastVisit` is `null` or a visit with an ISO `visitTime`. `meta` holds `checkedAt`, `cdpHost` and `profileDir`. |
| `getPageContext` | `{ targetId, host?, port?, userDataDir? }` | `{ found: boolean, context: PageContext \| null }` | `targetId` comes from `listPageTargets`. `found` is `false` when the target no longer exists. Cookie counts only, never names or values. |

## Which Chrome do the verbs act on?

`shutdownChrome` and `launchChrome` act through a per-port manager held by the hosting process. A Chrome started by another process on the same port is governed by the reaper for that port (see the state directory in [CONFIGURATION.md](CONFIGURATION.md)); `reaperScope` decides whether it may close a Chrome it did not launch.

The Chrome that `launchChrome` starts has its windows hidden.
