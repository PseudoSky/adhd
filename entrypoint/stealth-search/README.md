# @adhd/stealth-search

> Search and read the web through your own Chrome, as a CLI or MCP server, with typed errors and a tripwire.

Twelve providers, eleven operations, two bins: `stealth-search` and `stealth-search-mcp`. Ask for hits from DuckDuckGo, GitHub, npm, arXiv and more, or read any URL as markdown. The work runs in a real Chrome profile that you own, on your machine.

Install with `pnpm add @adhd/stealth-search`. Node.js 22.5 or newer. macOS is the supported platform.

## What "stealth" means

Exactly two concrete choices. Chrome is launched without `--enable-automation`. Pages are read without `Runtime.evaluate`. That gives a lower footprint in your own logged-in browser. It does not promise that a site will not notice, throttle or block you. Read [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md) before you point it at a site: terms of service, robots.txt, rate limits, your own profile only.

Stability: the package is 0.x. The surface can still change between minor versions. See [CHANGELOG.md](CHANGELOG.md).

Every code block in this README is listed in `examples/manifest.json` and checked by `test/unit/examples/examples.spec.ts`. TypeScript blocks are lines of a runnable file in `examples/`. Command lines name real operations and flags. The sample output is what the example prints against a fake Chrome.

## Quickstart

### CLI

The CLI takes the operation name first, then the input as kebab-case flags (or one `--input` JSON object).

```sh
stealth-search search --provider duckduckgo --query "headless chrome detection" --qualifier site:developer.chrome.com
stealth-search search --provider github --query vite --qualifier repo:vitejs/vite --strategy network --max-attempts 2
```

Read a URL as markdown, 20 000 bytes at a time. Continue with the `nextOffset` of the result.

```sh
stealth-search search --provider fetch --query https://example.com/docs/getting-started --content full --offset 0 --max-content-size 20000
```

Discover providers before the first search.

```sh
stealth-search listProviders --pretty
stealth-search describeProvider --provider github
```

Manage the Chrome it drives. The default endpoint is `127.0.0.1:9222`; the examples use `9333` to stay clear of a Chrome you already run.

```sh
stealth-search chromeStatus --cdp-port 9333
stealth-search launchChrome --port 9333
stealth-search checkChromeActivity --port 9333 --within-minutes 5
stealth-search listPageTargets --port 9333
stealth-search tripwireStatus
stealth-search clearTripwire --provider google
```

`launchChrome` uses the `Chrome-CDP` profile (`~/Library/Application Support/Google/Chrome-CDP` on macOS) unless you pass `--user-data-dir`. Every default is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### MCP

Register the server with an MCP client. Host flags such as `--transport`, `--idle-shutdown` and `--data-dir` go in `args`.

```json
{
  "mcpServers": {
    "stealth-search": { "command": "stealth-search-mcp", "args": ["--transport", "stdio", "--idle-shutdown", "120000"] }
  }
}
```

After `pnpm add`, the bins live in `node_modules/.bin`. Use an absolute path, or `pnpm exec stealth-search-mcp`, as the MCP `command`.

Every MCP tool takes its input wrapped in `data`. A `tools/call` for a DuckDuckGo search looks like this:

`{"method":"tools/call","params":{"name":"stealth_search","arguments":{"data":{"provider":"duckduckgo","query":"headless chrome detection","qualifier":"site:developer.chrome.com"}}}}`

## Features

- **Search or read.** `search` queries a provider. The `fetch` provider renders a URL as markdown, windowed by `offset` and `maxContentSize`, and reads PDFs too (capped at 32 MiB and 30 s).
- **Twelve providers.** `duckduckgo`, `google`, `arxiv`, `npm`, `github`, `maven`, `wikipedia`, `crates`, `pypi`, `mdn`, `stackoverflow` and `fetch`. `describeProvider` lists each one's qualifiers (`site:`, `repo:`, `type:code`, ...).
- **Outcomes are data.** A call returns `success`, `empty`, `hitl`, `captcha`, `rate_limited`, `banned` and more as a field. Branch on `out.outcome`; no exception to catch.
- **Bounded results.** Engine providers cap the serialized list with `maxResultBytes` (default 8192). Whole results are dropped from the tail, and `omitted` counts them.
- **Typed errors.** Thirteen codes, each with a fixed CLI exit status and an MCP `isError` result. See [docs/ERRORS.md](docs/ERRORS.md).
- **Tripwire protection.** After a hostile response a provider is locked. A locked provider answers `hitl` and opens no window. `tripwireStatus` lists the locks and `clearTripwire` releases one.
- **Polite to your session.** `checkChromeActivity` reports open pages and the last history visit before you disturb a human session. `shutdownChrome` closes Chrome only when it is idle. `--idle-shutdown` closes the Chrome the host launched after 120 000 ms by default.
- **Safe defaults.** The Chrome host is restricted to loopback. A fetch resolves the host once and refuses internal addresses with `FETCH_URL_REFUSED`. A non-loopback `--listen-host` needs `--allow-remote-listen`. State files are written owner-only (0600).
- **Cookie values stay out.** `getPageContext` returns cookie names and counts, never values.
- **Traced.** Every operation writes `adhd.<op>.start|finish|error` records on both hosts. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

Provider status: the `google` result parsers are provisional. They are verified against synthetic fixtures, not live Google pages, so treat its results as best effort.

## Surfaces

One set of eleven operations, three ways in.

| Operation | CLI | MCP tool |
| --- | --- | --- |
| Search a provider or fetch a URL as markdown | `search` | `stealth_search` |
| List the providers | `listProviders` | `stealth_listProviders` |
| Describe one provider | `describeProvider` | `stealth_describeProvider` |
| List providers locked by the tripwire | `tripwireStatus` | `stealth_tripwireStatus` |
| Release a locked provider | `clearTripwire` | `stealth_clearTripwire` |
| Report whether Chrome answers on the endpoint | `chromeStatus` | `stealth_chromeStatus` |
| Start the managed Chrome | `launchChrome` | `stealth_launchChrome` |
| Shut it down when idle | `shutdownChrome` | `stealth_shutdownChrome` |
| List open tabs | `listPageTargets` | `stealth_listPageTargets` |
| Check whether Chrome is in use | `checkChromeActivity` | `stealth_checkChromeActivity` |
| Describe one open page | `getPageContext` | `stealth_getPageContext` |

The bare form without an operation name (`stealth-search duckduckgo "query"`) is not accepted.

**Host flags** apply to every operation and go on either bin. The ones you will reach for:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--cdp-port <n>` | `9222` | Chrome remote-debugging port |
| `--transport <name>` | `stdio` | MCP transport: `stdio`, `sse` or `streaming-http` |
| `--listen-port <n>` | `3100` | Port the `sse` and `streaming-http` transports bind |
| `--data-dir <path>` | `~/.adhd/reverse/data` | Tripwire, cooldown and audit state |

`sse` and `streaming-http` carry no authentication and expose `launchChrome` and `shutdownChrome`. Keep them on loopback or behind your own authenticating proxy. Run `stealth-search --help` for the full table, and see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

**`search` inputs.** All but `provider` and `query` are optional.

| Input | Values and default |
| --- | --- |
| `provider` | A provider id from `listProviders`, or `fetch`. |
| `query` | The query; for `fetch`, the URL. |
| `qualifier` | Search syntax prepended to the query (`site:example.com`, `repo:owner/name`); ignored by `fetch`. |
| `strategy` | `auto` (default), `network`, `dom` or `fetch`. |
| `content` | `none` (default) or `full`. |
| `offset`, `maxContentSize` | Window start (default 0) and size in bytes (default 20000; 0 = unbounded). |
| `timeoutMs`, `maxAttempts` | One deadline for the call (default 30000); attempts on a transient failure (at most 3). |
| `visibility` | `offscreen` (default) or `foreground`, to solve a challenge by hand. |

**Typed errors reach MCP clients as `isError` tool results.** The text is `<canonical>: <CODE>: <message>` and `_meta["adhd/error"].code` is the code.

For example, `stealth-search search --provider nope --query q` prints `UNKNOWN_PROVIDER: Unknown provider "nope". Available: duckduckgo, google, arxiv, ...` on stderr and exits 70.

**Library.** Every example in `examples/` exports `run({ api })`, which takes the operations as an injected dependency. Pass `import * as api from '@adhd/stealth-search'`. The wiring and error exports are in [docs/LIBRARY.md](docs/LIBRARY.md).

```ts
const out = await api.search({
  provider: 'duckduckgo',
  query: 'headless chrome detection',
  qualifier: 'site:developer.chrome.com',
  strategy: 'auto',
  timeoutMs: 30_000,
})
```

Page through a document.

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

Every example file, with its scenario, is in [docs/EXAMPLES.md](docs/EXAMPLES.md).

## Receipts

Each claim below names a shipped capability in `docs/marketing/.catalog/capabilities.json`. Operations that need a live Chrome are verified against fakes and `--help`, not a live Chrome run, and no successful live search was executed for the catalog.

- Twelve providers answer `listProviders`, and an unknown provider fails with `UNKNOWN_PROVIDER` and exit 70. <!-- receipt:listProviders --> <!-- receipt:search -->
- The MCP server writes only JSON-RPC to stdout, and `tools/list` returns the eleven `stealth_*` tools. <!-- receipt:mcp-stdout-json-rpc-only -->
- Thirteen typed error codes carry fixed exit statuses; a bad `--cdp-port` value is `HOST_FLAG_INVALID` with exit 77. <!-- receipt:typed-error-codes --> <!-- receipt:host-flags -->
- Typed failures arrive as `isError` MCP results with `_meta["adhd/error"].code`. <!-- receipt:mcp-iserror-channel -->
- A failing call writes exactly one `adhd.<op>.error` record plus one upstream twin. <!-- receipt:observability-spans -->
- `tripwireStatus` and `clearTripwire` list and release locked providers; on an empty data directory they answer `{}` and `cleared: false`. <!-- receipt:tripwireStatus --> <!-- receipt:clearTripwire -->
- `getPageContext` returns cookie names and counts and never a cookie value; redaction is tested. <!-- receipt:getPageContext -->

## Documentation

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every default and host flag (port 9222, the `Chrome-CDP` profile, the state and data directories); macOS-first.
- [docs/ERRORS.md](docs/ERRORS.md): the typed error codes, exit statuses and MCP rendering.
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md): `adhd.<op>.start|finish|error` records, `--verbose` diagnostics, what the MCP bin writes to stdout.
- [docs/LIBRARY.md](docs/LIBRARY.md): the wiring, configuration and error exports of the package root.
- [docs/EXAMPLES.md](docs/EXAMPLES.md): every file under `examples/` with its scenario.
- [docs/RESPONSIBLE-USE.md](docs/RESPONSIBLE-USE.md): terms of service, robots.txt, rate limits, no CAPTCHA or ban circumvention, your own profile only.
- [CHANGELOG.md](CHANGELOG.md), [LICENSE](LICENSE) (MIT).
