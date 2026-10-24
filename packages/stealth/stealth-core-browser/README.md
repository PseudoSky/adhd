# @adhd/stealth-core-browser

Work with your own logged-in Chrome from Node.js over the Chrome DevTools Protocol: Chrome is launched without `--enable-automation` and pages are read without `Runtime.evaluate`.

Requires Node.js 22.5 or newer and an installed Chrome. macOS is the verified platform; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## What "stealth" means here

Exactly two concrete choices, and nothing more:

1. Chrome is launched **without `--enable-automation`**.
2. Pages are read **without `Runtime.evaluate`**: no script is injected into the page; data comes from network capture and the CDP DOM tree and is parsed in your process.

It does not make a program invisible to a site. Read [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md) before pointing it at a real site.

## Install

```bash
pnpm add @adhd/stealth-core-browser
```

## Quickstart

Six flat verbs, each taking one plain object. This runs against a dedicated Chrome on port 9333 (the default port is 9222; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)):

```ts
import { launchChrome, chromeStatus, listPageTargets, shutdownChrome } from '@adhd/stealth-core-browser'

await launchChrome({ port: 9333 })
console.log(await chromeStatus({ port: 9333 }))
const { targets } = await listPageTargets({ port: 9333 })
console.log(targets.map((t) => t.url))
await shutdownChrome({ port: 9333 })
```

| Verb | What it does |
|---|---|
| `chromeStatus` | Whether Chrome answers on the endpoint, its version, and whether this process manages it |
| `launchChrome` | Start (or reuse) a hidden Chrome on a dedicated port and profile |
| `shutdownChrome` | Close the managed Chrome only when it is genuinely idle |
| `listPageTargets` | The open tabs with their target ids and URLs |
| `checkChromeActivity` | Open web pages and the latest history visit, so you do not disturb a person |
| `getPageContext` | One open page: URL, title, cookie count for its host, history count (never cookie values) |

## Namespaces

Areas are namespaces on the one package root; there are no subpath exports.

| Namespace | Purpose | Reference |
|---|---|---|
| `cdp` | CDP session, targets, browser launch and kill, `CdpClient` domain facade | [docs/reference/cdp.md](docs/reference/cdp.md) |
| `storage` | Read-only History, Cookies, Bookmarks and Profile readers | [docs/reference/storage.md](docs/reference/storage.md) |
| `capture` | Network capture, DOM walk, ban detection, retry policy | [docs/reference/capture.md](docs/reference/capture.md) |
| `parsers` | Server-side HTML and JSON extraction (the Google result parsers are provisional, verified against synthetic fixtures only) | [docs/reference/parsers.md](docs/reference/parsers.md) |
| `chromeManager` | Auto-start, idle timer, reaper-host safety shutdown | [docs/reference/chrome-manager.md](docs/reference/chrome-manager.md) |
| `lifecycle`, `recording`, `endpoint` | Manager seam and reaper, redacted network recording, endpoint policy | [docs/reference/README.md](docs/reference/README.md) |

A lower-level example with the `cdp` and `capture` namespaces, on the dedicated port 9333:

```ts
import { cdp, capture } from '@adhd/stealth-core-browser'
const { ensureChromeRunning, createPageTarget, closePageTarget } = cdp
const { captureNetworkResponse } = capture

await ensureChromeRunning({ port: 9333 })
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9333')
try {
  const response = await captureNetworkResponse(pageWsUrl, {
    navigateUrl: 'https://example.com',
    urlPattern: /example\.com/,
    timeoutMs: 10_000,
  })
  console.log(response.status, response.body.length)
} finally {
  await closePageTarget('127.0.0.1:9333', targetId)
}
```

## Stability

The package is 0.x. The six verbs and their types are the stable surface; the root namespaces (`cdp`, `storage`, `capture`, `parsers`, `chromeManager`) are experimental until 1.0.

## Endpoint policy

Only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted by default; any other host is refused with `CDP_UNREACHABLE` (`detail.reason` `invalid-endpoint`) before a socket is opened. The process that hosts the verbs opts a remote Chrome in once, never a verb input:

```ts
import { endpoint } from '@adhd/stealth-core-browser'

endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })
```

## Documentation

- [docs/VERBS.md](docs/VERBS.md): input, return shape and errors of each verb
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every default (port `9222`, the `Chrome-CDP` profile, the lifecycle state directory), options and platform support
- [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md): terms of service, robots.txt, rate limits, read-only profile access
- [docs/EXAMPLES.md](docs/EXAMPLES.md): every runnable file under `examples/` with its scenario
- [docs/LIFECYCLE-AND-RECORDING.md](docs/LIFECYCLE-AND-RECORDING.md): members of `lifecycle`, `recording` and `endpoint`
- [docs/ERRORS.md](docs/ERRORS.md): the `StealthCoreBrowserError` code registry
- [docs/reference/README.md](docs/reference/README.md): API and protocol reference
- [CHANGELOG.md](CHANGELOG.md)

The command line and the MCP server are hosted by `@adhd/stealth-search`, not by this package.

## Development

```bash
nx build stealth-core-browser
nx test stealth-core-browser
```
