# @adhd/stealth-search

Stealth Chrome search and fetch (CDP DOM walks, no automation flags) as a CLI and an MCP server.

Bins: `stealth-search`, `stealth-search-mcp`. Install with `pnpm add @adhd/stealth-search`.

Every code block below is listed in `examples/manifest.json` and verified by
`src/test/unit/examples/examples.spec.ts`: TypeScript blocks are lines of a runnable file in
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
stealth-search checkChromeActivity --port 9333
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
