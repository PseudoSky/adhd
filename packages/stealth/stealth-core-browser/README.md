# @adhd/stealth-core-browser

> Drive your own Chrome over CDP from Node.js: no `--enable-automation`, no `Runtime.evaluate`, six plain verbs.

You already have a Chrome with your logins, tabs and history. This library talks to it over the Chrome DevTools Protocol, reads pages without injecting a single script, and keeps its hands off whatever a person is doing. Requires Node.js 22.5 or newer and an installed Chrome. macOS is the verified platform; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## What "stealth" means here

Exactly two concrete choices, and nothing more:

1. Chrome is launched **without `--enable-automation`**.
2. Pages are read **without `Runtime.evaluate`**: no script runs inside the page. Data comes from network capture and the CDP DOM tree and is parsed in your process.

That is the whole definition. It does not make a program invisible to a site, and it does not exempt you from a site's rules. Read [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md) before pointing it at a real site.

## Quickstart

```bash
pnpm add @adhd/stealth-core-browser
```

Every verb takes one plain object and imports from the package root. Start (or reuse) a hidden Chrome on a dedicated port and profile. Calling it twice is safe:

```ts
import { launchChrome, type LaunchChromeResult } from '@adhd/stealth-core-browser'
```

```ts
const result = await launchChrome({ port, userDataDir })
  log(`Chrome is ready on port ${result.port}${userDataDir ? ` with profile ${userDataDir}` : ''}`)
```

Then ask what answers on that port:

```ts
const status = await chromeStatus({ host, port })
  if (status.running) {
    log(`Chrome ${status.version ?? 'unknown'} (protocol ${status.protocol ?? 'unknown'}) is up on port ${port}; managed by this process: ${status.managed}`)
  } else {
    log(`nothing answers on port ${port}: launch Chrome before the job starts`)
  }
```

When the job ends, close Chrome only if nobody else is using it:

```ts
const result = await shutdownChrome({ host, port })
  log(result.running ? `Chrome on port ${port} is still in use and was left running` : `Chrome on port ${port} was shut down`)
```

The snippets above are lifted from runnable files: [examples/verbs/launchChrome.ts](examples/verbs/launchChrome.ts), [examples/verbs/chromeStatus.ts](examples/verbs/chromeStatus.ts) and [examples/verbs/shutdownChrome.ts](examples/verbs/shutdownChrome.ts). The library's default port is `9222` and its default profile is the `Chrome-CDP` directory next to your normal Chrome profile (exact paths per platform in [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). Every example targets port `9333` instead, so it never touches a Chrome you are using.

## Features

- **Hidden, dedicated Chrome.** `launchChrome` starts Chrome on its own port and profile, reuses one that already answers, and refuses a Chrome that carries a different profile.
- **Polite shutdown.** `shutdownChrome` defers to open pages and other sessions. It never throws on a failed close; it returns `{ ok, running }`.
- **Look before you touch.** `checkChromeActivity` reports open web pages and the latest history visit, so a job can wait while a person is browsing.
- **Describe a tab without reading secrets.** `getPageContext` returns URL, title, cookie *count* for the host and history count. Never cookie values.
- **Read-only profile access.** `storage` opens Chrome's History, Cookies, Bookmarks and Profile SQLite files immutable.
- **Capture, then parse in your process.** `capture` records real network responses and walks the DOM through CDP, with ban detection and a retry policy. `parsers` extracts rows from JSON and HTML.
- **Recordings that do not leak.** `recording` masks credential headers before anything is stored.
- **Loopback by default.** `endpoint` refuses any non-loopback host unless the host process opts in once.
- **Typed errors.** Failures are `StealthCoreBrowserError` values with a stable `code`; the registry is [docs/ERRORS.md](docs/ERRORS.md).

## Surfaces

Six flat verbs, plus namespaces on the one package root. There are no subpath exports and there is no legacy subpath.

| Verb | What it does | Example |
|---|---|---|
| `chromeStatus` | Whether Chrome answers on the endpoint, its version, whether this process manages it | [examples/verbs/chromeStatus.ts](examples/verbs/chromeStatus.ts) |
| `launchChrome` | Start (or reuse) a hidden Chrome on a dedicated port and profile | [examples/verbs/launchChrome.ts](examples/verbs/launchChrome.ts) |
| `shutdownChrome` | Close the managed Chrome only when it is genuinely idle | [examples/verbs/shutdownChrome.ts](examples/verbs/shutdownChrome.ts) |
| `listPageTargets` | The open tabs with their target ids and URLs | [examples/verbs/listPageTargets.ts](examples/verbs/listPageTargets.ts) |
| `checkChromeActivity` | Open web pages and the latest history visit | [examples/verbs/checkChromeActivity.ts](examples/verbs/checkChromeActivity.ts) |
| `getPageContext` | One open page: URL, title, cookie count, history count | [examples/verbs/getPageContext.ts](examples/verbs/getPageContext.ts) |

| Namespace | Purpose | Reference | Example |
|---|---|---|---|
| `cdp` | CDP session, targets, launch and kill, `CdpClient` domain facade | [docs/reference/cdp.md](docs/reference/cdp.md) | [examples/namespaces/cdp.ts](examples/namespaces/cdp.ts) |
| `storage` | Read-only History, Cookies, Bookmarks, Profile readers | [docs/reference/storage.md](docs/reference/storage.md) | [examples/namespaces/storage.ts](examples/namespaces/storage.ts) |
| `capture` | Network capture, DOM walk, ban detection, retry policy | [docs/reference/capture.md](docs/reference/capture.md) | [examples/namespaces/capture.ts](examples/namespaces/capture.ts) |
| `parsers` | HTML and JSON extraction. The Google result parsers are provisional: verified against synthetic fixtures only | [docs/reference/parsers.md](docs/reference/parsers.md) | [examples/namespaces/parsers.ts](examples/namespaces/parsers.ts) |
| `chromeManager` | Auto-start, idle timer, reaper-host safety shutdown | [docs/reference/chrome-manager.md](docs/reference/chrome-manager.md) | [examples/namespaces/chromeManager.ts](examples/namespaces/chromeManager.ts) |
| `recording` | Redacted network recording | [docs/LIFECYCLE-AND-RECORDING.md](docs/LIFECYCLE-AND-RECORDING.md) | [examples/namespaces/recording.ts](examples/namespaces/recording.ts) |
| `lifecycle` | Idle-shutdown decision and launch-storm guard | [docs/LIFECYCLE-AND-RECORDING.md](docs/LIFECYCLE-AND-RECORDING.md) | [examples/namespaces/lifecycle.ts](examples/namespaces/lifecycle.ts) |
| `endpoint` | Endpoint policy (loopback by default) | [docs/LIFECYCLE-AND-RECORDING.md](docs/LIFECYCLE-AND-RECORDING.md) | [examples/namespaces/endpoint.ts](examples/namespaces/endpoint.ts) |

This package is a library. It has no `examples/cli.md` and no `examples/mcp-config.json`: the command line and the MCP server live in `@adhd/stealth-search`, which projects the six verbs one to one.

### Capture a page and check it for a wall

Capture the real response of a page load, test it against ban rules, and let the retry policy decide ([examples/namespaces/capture.ts](examples/namespaces/capture.ts)):

```ts
const response = await capture.captureNetworkResponse(tab.webSocketDebuggerUrl, {
    urlPattern: /./,
    navigateUrl: url,
    timeoutMs: 10_000,
  })
```

```ts
const ban = capture.checkBans(rules, { url: response.url, status: response.status, body: response.body })
  const retry = capture.decideRetry({ outcome: ban ?? 'success' }, 1, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    onCaptcha: 'retry',
    onRateLimit: 'retry',
    onTimeout: 'retry',
    onBan: 'abort',
  })
```

### Record a load without leaking credentials

Cookie and authorization headers are replaced with a mask before the sink stores anything ([examples/namespaces/recording.ts](examples/namespaces/recording.ts)):

```ts
const sink = new recording.MemoryRecordingSink()
  await capture.captureNetworkResponse(tab.webSocketDebuggerUrl, {
    urlPattern: /./,
    navigateUrl: url,
    sink,
    redact: recording.redactHeaders(['cookie', 'authorization']),
  })
```

### Keep the endpoint on loopback

A remote Chrome is allowed once, by the host process, never by a verb input ([examples/namespaces/endpoint.ts](examples/namespaces/endpoint.ts)):

```ts
endpoint.configureEndpointPolicy({ allowHosts: [remoteHost] })
```

## Stability

The package is 0.x. Only the six verbs and their types are stable. The root namespaces `cdp`, `storage`, `capture`, `parsers` and `chromeManager` are experimental until 1.0, so their members may change in a minor release. There is no legacy subpath: everything is imported from `@adhd/stealth-core-browser`.

## Receipts

Each claim above maps to a shipped capability and the test run that verifies it. The runner is vitest with an in-process fake CDP: no Chrome, no port 9222. Results are recorded in [docs/marketing/.catalog/capabilities.json](docs/marketing/.catalog/capabilities.json).

| Claim | Capability | Receipt command (from the package directory) | Recorded result |
|---|---|---|---|
| Status of the endpoint <!-- receipt:chromeStatus --> | `chromeStatus` | `pnpm exec vitest run test/unit/surface/verbs.spec.ts test/unit/surface/api.spec.ts` | exit 0; 24 tests passed |
| Dedicated, idempotent launch <!-- receipt:launchChrome --> | `launchChrome` | `pnpm exec vitest run test/unit/surface/verbs.spec.ts test/unit/cdp/browser.spec.ts test/unit/cdp/launch-hardening.spec.ts test/unit/errors/api-launch-errors.spec.ts` | exit 0; 64 tests passed |
| Idle-safe shutdown <!-- receipt:shutdownChrome --> | `shutdownChrome` | `pnpm exec vitest run test/unit/surface/verbs.spec.ts test/unit/cdp/shutdown.spec.ts test/unit/lifecycle/shutdown-modes.spec.ts` | exit 0; 29 tests passed |
| Tab listing <!-- receipt:listPageTargets --> | `listPageTargets` | `pnpm exec vitest run test/unit/surface/verbs.spec.ts test/unit/cdp/targets.spec.ts test/unit/use-cases/list-my-open-tabs.spec.ts` | exit 0; 72 tests passed |
| Activity check <!-- receipt:checkChromeActivity --> | `checkChromeActivity` | `pnpm exec vitest run test/unit/queries/activity.spec.ts test/unit/surface/verbs.spec.ts` | exit 0; 18 tests passed |
| Page context without cookie values <!-- receipt:getPageContext --> | `getPageContext` | `pnpm exec vitest run test/unit/queries/context.spec.ts test/unit/surface/verbs.spec.ts` | exit 0; 18 tests passed |
| Capture, ban check, retry <!-- receipt:capture --> | `capture` | `pnpm exec vitest run test/unit/capture test/unit/capture-parsers/dom.spec.ts test/unit/capture-parsers/network.spec.ts test/unit/capture-parsers/bans.spec.ts test/unit/use-cases/capture-a-page-load-and-spot-a-block.spec.ts` | exit 0; 246 tests passed |
| Redacted recording <!-- receipt:recording --> | `recording` | `pnpm exec vitest run test/unit/capture/memory-sink.spec.ts test/unit/capture/store-sink.spec.ts test/unit/capture/open-store-sink.spec.ts test/unit/capture/redaction.spec.ts test/unit/use-cases/record-a-session-without-leaking-credentials.spec.ts` | exit 0; 37 tests passed |
| Read-only profile readers <!-- receipt:storage --> | `storage` | `pnpm exec vitest run test/unit/domains-storage test/unit/use-cases/audit-my-browsing-history.spec.ts test/unit/use-cases/find-a-saved-bookmark-and-top-site.spec.ts` | exit 0; 173 tests passed |

The Google result parsers inside `parsers` are provisional and are not listed as a receipt: they are verified against synthetic fixtures only.

## Documentation

- [docs/VERBS.md](docs/VERBS.md): input, return shape and errors of each verb
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every default (port `9222`, the `Chrome-CDP` profile, the lifecycle state directory), options and platform support
- [docs/ERRORS.md](docs/ERRORS.md): the `StealthCoreBrowserError` code registry
- [docs/EXAMPLES.md](docs/EXAMPLES.md): every runnable file under `examples/` with its scenario
- [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md): terms of service, robots.txt, rate limits, read-only profile access
- [docs/LIFECYCLE-AND-RECORDING.md](docs/LIFECYCLE-AND-RECORDING.md): members of `lifecycle`, `recording` and `endpoint`
- [docs/reference/README.md](docs/reference/README.md): API and protocol reference
- [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
nx build stealth-core-browser
nx test stealth-core-browser
```
