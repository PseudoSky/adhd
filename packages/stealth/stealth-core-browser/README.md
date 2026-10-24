# @adhd/stealth-core-browser

Drive Chrome over the Chrome DevTools Protocol without automation fingerprints: no `Runtime.evaluate`, no `--enable-automation`. Page data comes from network capture and the CDP DOM tree, and is parsed server-side.

Requires Node.js 22.5 or newer and an installed Chrome or Chromium.

## Install

```bash
pnpm add @adhd/stealth-core-browser
```

## One entry, namespaced

The package root is the only entry; there are no subpath exports. Areas are namespaces, and the chrome-runner verbs and shared types are flat exports.

```ts
import { cdp, storage, capture, parsers, chromeManager, lifecycle, recording, endpoint, StealthCoreBrowserError } from '@adhd/stealth-core-browser'
const { ensureChromeRunning, createPageTarget, closePageTarget } = cdp
const { captureNetworkResponse } = capture

await ensureChromeRunning()
const { targetId, pageWsUrl } = await createPageTarget('127.0.0.1:9222')
try {
  const response = await captureNetworkResponse(pageWsUrl, {
    navigateUrl: 'https://example.com',
    urlPattern: /example\.com/,
    timeoutMs: 10_000,
  })
  console.log(response.status, response.body.length)
} finally {
  await closePageTarget('127.0.0.1:9222', targetId)
}
```

| Namespace | Purpose | Reference |
|---|---|---|
| `cdp` | CDP session, targets, browser launch and kill, `CdpClient` domain facade | [docs/reference/cdp.md](docs/reference/cdp.md) |
| `storage` | Read-only History, Cookies, Bookmarks and Profile readers | [docs/reference/storage.md](docs/reference/storage.md) |
| `capture` | Network capture, DOM walk, ban detection, retry policy | [docs/reference/capture.md](docs/reference/capture.md) |
| `parsers` | Server-side HTML and JSON extraction | [docs/reference/parsers.md](docs/reference/parsers.md) |
| `chromeManager` | Auto-start, idle timer, reaper-host safety shutdown | [docs/reference/chrome-manager.md](docs/reference/chrome-manager.md) |
| `lifecycle`, `recording`, `endpoint` | Manager seam and reaper, network recording, endpoint policy | [docs/reference/README.md](docs/reference/README.md) |

Every failure is a `StealthCoreBrowserError` with a stable `code`; see [docs/ERRORS.md](docs/ERRORS.md).

## Development

```bash
nx build stealth-core-browser
nx test stealth-core-browser
```

## Endpoint policy (`endpoint` namespace)

Every verb and the chrome manager address Chrome through the `endpoint` namespace of the package root. By default only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted; any other `host` input is refused with `CDP_UNREACHABLE` (`detail.reason` `invalid-endpoint`) before a socket is opened. The process that hosts the verbs opts a remote Chrome in once, never a verb input:

```ts
import { endpoint } from '@adhd/stealth-core-browser'

endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })
endpoint.resolveEndpoint({ host: 'chrome.internal', port: 9333 }) // { host, port, cdpHost: 'chrome.internal:9333' }
```

The `stealth-search` host exposes the same opt-in as `--allow-cdp-hosts <comma-separated list>`. Members: `DEFAULT_HOST`, `DEFAULT_PORT`, `allowedHosts`, `assertSameEndpoint`, `configureEndpointPolicy`, `isLoopbackHost`, `portOf`, `resolveEndpoint`. See `docs/reference/README.md` for the full policy.
