# @adhd/stealth-search

Stealth Chrome search and fetch (CDP DOM walks, no automation flags) as a CLI and an MCP server.

Bins: `stealth-search`, `stealth-search-mcp`. Install with `pnpm add @adhd/stealth-search`.

Every code block below is listed in `examples/manifest.json` and verified by
`test/unit/examples/examples.spec.ts`: TypeScript blocks are lines of a runnable file in
`examples/`, command lines name real operations and flags, and the sample output is what the
example prints against a fake Chrome.

## What "stealth" means

Exactly two concrete choices: Chrome is launched without `--enable-automation`, and pages are read without `Runtime.evaluate`. It is a lower-footprint way to work with your own logged-in browser. It is not a guarantee that a site will not notice, throttle or block you. Read [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md) before pointing it at a site.

## Operations

The CLI takes the operation name first, then the input as kebab-case flags (or one `--input` JSON
object). The eleven operations are `search`, `listProviders`, `describeProvider`, `tripwireStatus`,
`clearTripwire`, `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`,
`checkChromeActivity` and `getPageContext`; the MCP tools are the same names prefixed `stealth_`.
The bare form without an operation name (`stealth-search duckduckgo "query"`) is not accepted.

## Search

```sh
stealth-search search --provider duckduckgo --query "headless chrome detection" --qualifier site:developer.chrome.com
stealth-search search --provider github --query vite --qualifier repo:vitejs/vite --strategy network --max-attempts 2
```

Read a URL as markdown, 20 000 bytes at a time (continue with the `nextOffset` of the result):

```sh
stealth-search search --provider fetch --query https://example.com/docs/getting-started --content full --offset 0 --max-content-size 20000
```

Discover providers before the first search:

```sh
stealth-search listProviders --pretty
stealth-search describeProvider --provider github
```

## Chrome and tripwires

```sh
stealth-search chromeStatus --cdp-port 9333
stealth-search launchChrome --port 9333
stealth-search checkChromeActivity --port 9333 --within-minutes 5
stealth-search listPageTargets --port 9333
stealth-search tripwireStatus
stealth-search clearTripwire --provider google
```

## MCP server

Register the server with an MCP client; the host flags (`--transport`, `--idle-shutdown`,
`--data-dir`, ...) go in `args`:

```json
{
  "mcpServers": {
    "stealth-search": { "command": "stealth-search-mcp", "args": ["--transport", "stdio", "--idle-shutdown", "120000"] }
  }
}
```

## Calling `stealth_search` over MCP

Every MCP tool takes its input wrapped in `data`. A `tools/call` request for a DuckDuckGo search:

```json
{ "method": "tools/call", "params": { "name": "stealth_search", "arguments": { "data": { "provider": "duckduckgo", "query": "headless chrome detection", "qualifier": "site:developer.chrome.com" } } } }
```

`search` inputs (all but `provider` and `query` are optional):

| Input | Values and default |
| --- | --- |
| `provider` | A provider id from `listProviders`, or `fetch`. |
| `query` | The query; for `fetch`, the URL. |
| `qualifier` | Search syntax prepended to the query (`site:example.com`, `repo:owner/name`); ignored by `fetch`. |
| `strategy` | `auto` (default), `network`, `dom` or `fetch`. |
| `content` | `none` (default) or `full` (adds the body as a window). |
| `offset`, `maxContentSize` | Window start (default 0) and size in bytes (default 20000; 0 = unbounded). |
| `maxResultBytes` | Byte bound of the result list (default 8192). |
| `timeoutMs` | One deadline for the whole call (default 30000). |
| `maxAttempts` | Attempts on a transient failure (the provider's policy, at most 3). |
| `challengeWaitMs` | Wait for a Cloudflare or CAPTCHA wall to clear (default 25000; 0 disables). |
| `visibility` | `offscreen` (default, a minimized window) or `foreground` (shows the window, for solving a challenge by hand). |
| `pageDisposal` | `dispose` (default) or `keep`. |
| `host`, `port` | CDP endpoint (default `127.0.0.1`, `9222`). |

The result is a `SearchOutput` with `outcome`, `count`, `results` (`title`, `url`, `snippet`, optional `meta`) and, for a `fetch`, `content` and `nextOffset`. Before a search runs, the host asks the Chrome manager for a ready Chrome on the endpoint; on macOS a Chrome launched by `launchChrome` is `/Applications/Google Chrome.app` with the `Chrome-CDP` profile. After `pnpm add`, the bins live in `node_modules/.bin`: use an absolute path or `pnpm exec stealth-search-mcp` as the MCP `command`.

## Result size

A search over an engine provider (`duckduckgo`, `google`, `github`, ...) bounds the serialized result
list with `maxResultBytes` (default 8192, a positive integer). Whole results are dropped from the tail,
never cut, and `omitted` counts the dropped ones; the field is absent when nothing was dropped, so a
result with `omitted` set is a truncated list. The `fetch` provider does not use `maxResultBytes` or
`omitted`: its document is windowed by `content`, `offset` and `maxContentSize`, and `nextOffset` says
where to continue.

## Fetch outcomes

A fetched page that answers an HTTP error is never a `success`: 404 and 410 are `error`, 429 is
`rate_limited`, and every other 4xx or 5xx is `error` with `SEARCH_FAILED: HTTP <status> for <url>`. The
rendered body of a 401, 403, 429 or 5xx page is still returned in `content`. A fetch ban or rate limit
cools down per site, not for every URL: the cooldown file is keyed by the host, so a banned site never
blocks the others.

A fetch resolves the host once and connects to the address it validated. Redirect hops and the address
Chrome actually connected to are checked against the same forbidden-address table (loopback, private,
link-local, carrier-grade NAT, documentation, multicast, reserved and the IPv4-in-IPv6 forms of those), so a
public name that redirects or resolves to an internal address is refused with `FETCH_URL_REFUSED`. The
browser-side check runs on the connection Chrome reports: it detects a forbidden connection and ends the fetch
before any page content is read, it does not prevent the connection itself, and a document response that reports
no remote address (for example one served from cache) is not checked at that step. A direct
PDF download is capped at 32 MiB and 30 s.

## Safe defaults and their opt-ins

- **Chrome host.** The `host` input of the Chrome operations and of `search` is restricted to loopback
  (`127.0.0.1`, `localhost`, `::1`) and must be a plain host name or address. A remote Chrome needs the
  explicit opt-in `--allow-cdp-hosts <list>` (comma-separated), or a non-default `--cdp-host`, which is
  allowed for that run. A debugger WebSocket URL that points at another host than the one asked is refused.
- **Network listener.** `--transport sse` and `--transport streaming-http` carry no authentication and expose
  `launchChrome` and `shutdownChrome`. A non-loopback `--listen-host` is refused unless `--allow-remote-listen`
  is given, and then a warning is logged at startup. Keep the listener on loopback or behind your own
  authenticating proxy.
- **Files.** Runtime state (cooldowns, the operations cache, the boot trace) is written owner-only (0600). The
  baked operations file shipped in `dist` is world-readable (0644) because it holds no secret and must survive
  packing; a baked file the process cannot read is reported on stderr (reason `baked-cache-unreadable`) and the
  operations are re-extracted.
- **Recordings.** Network recordings opened through the core's store sink are owner-only and keep cookies and
  authorization headers in clear unless the caller passes `redactHeaders()`; a token in a URL query is never
  masked.

## MCP errors

A typed failure (`UNKNOWN_PROVIDER`, `HOST_FLAG_INVALID`, `FETCH_URL_REFUSED`, ...) reaches an MCP client as an
`isError` tool result whose text is `<canonical>: <CODE>: <message>` and whose `_meta["adhd/error"].code` is the
canonical code; see `docs/ERRORS.md`. A non-typed throw stays a JSON-RPC error.

## Programmatic use

Every example in `examples/` exports `run({ api })`, which takes the operations as an injected
dependency and returns the text it prints. Pass `import * as api from '@adhd/stealth-search'`.

```ts
const out = await api.search({
  provider: 'duckduckgo',
  query: 'headless chrome detection',
  qualifier: 'site:developer.chrome.com',
  strategy: 'auto',
  timeoutMs: 30_000,
})
```

Outcomes are data (`success`, `empty`, `hitl`, `captcha`, `rate_limited`, `banned`, ...), so branch
on `out.outcome`. Page through a document:

```ts
const out = await api.search({
  provider: 'fetch',
  query: 'https://example.com/docs/getting-started',
  content: 'full',
  offset,
  maxContentSize: 20_000,
})
```

Printed by `examples/search-web.ts` when the provider answers with two hits:

```text
1. Detecting headless Chrome
   https://developer.chrome.com/docs/detect
2. Chrome for Testing
   https://developer.chrome.com/docs/chrome-for-testing
```

## Provider status

The `google` provider's result parsers are provisional: they are verified against synthetic fixtures, not against live Google pages, so treat its results as best effort.

## Documentation

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every default and host flag (port 9222, the Chrome-CDP profile, the state and data directories); macOS-first.
- [docs/ERRORS.md](docs/ERRORS.md): the typed error codes, exit statuses and MCP rendering.
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md): `adhd.<op>.start|finish|error` records, `--verbose` diagnostics, what the MCP bin writes to stdout.
- [docs/EXAMPLES.md](docs/EXAMPLES.md): every file under `examples/` with its scenario.
- [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md): terms of service, robots.txt, rate limits, no CAPTCHA or ban circumvention, your own profile only.
- [CHANGELOG.md](CHANGELOG.md), [LICENSE](LICENSE) (MIT).
