# @adhd/stealth-search

Stealth Chrome search and fetch (CDP DOM walks, no automation flags) as a CLI and an MCP server.

Bins: `stealth-search`, `stealth-search-mcp`. Install with `pnpm add @adhd/stealth-search`.

Every code block below is listed in `examples/manifest.json` and verified by
`test/unit/examples/examples.spec.ts`: TypeScript blocks are lines of a runnable file in
`examples/`, command lines name real operations and flags, and the sample output is what the
example prints against a fake Chrome.

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
public name that redirects or resolves to an internal address is refused with `FETCH_URL_REFUSED`. A direct
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
