# Hero proposal for README

## Tagline

**Search, fetch and read pages through your own logged-in Chrome, with a lower footprint: no `--enable-automation`, no `Runtime.evaluate`. One CLI, one MCP server, twelve providers.**

> "Stealth" here means exactly two choices: Chrome is launched without `--enable-automation`, and pages are read without `Runtime.evaluate`. It is not a guarantee that a site will not notice, throttle or block you.

## Three differentiators

### 1. One typed surface for CLI, MCP and library (11 operations, 12 providers)

`search`, `listProviders`, `describeProvider`, `tripwireStatus`, `clearTripwire`, `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`. The MCP server lists the same operations as 11 `stealth_*` tools and writes only JSON-RPC to stdout.

Receipt: capability `mcp-stdout-json-rpc-only` (stdout parsed as JSON line by line, 11 tools listed); `listProviders` executed for real, exit 0 (duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch).

### 2. Errors are typed data, not log scraping

13 error codes, each with a fixed CLI exit status (for example `UNKNOWN_PROVIDER` is exit 70, `HOST_FLAG_INVALID` is exit 77). MCP clients get them as `isError` results with `_meta["adhd/error"].code`.

```text
$ stealth-search search --provider nope --query q
UNKNOWN_PROVIDER: Unknown provider "nope". Available: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch — Use one of the registered provider ids (see the providers list), then retry.
exit=70
```

Receipt: capabilities `typed-error-codes` (55 + 6 tests pass) and `mcp-iserror-channel` (7 tests pass).

### 3. Built to be polite to your own browser session

- `checkChromeActivity` reports open pages and the latest history visit before you disturb a human session; `shutdownChrome` closes Chrome only when genuinely idle.
- `tripwireStatus` / `clearTripwire` list and release providers locked after a hostile response, and a locked provider answers `hitl` without opening a window.
- `getPageContext` describes a page with cookie names and counts, never cookie values (redaction is tested).
- Safe defaults: CDP host restricted to loopback unless you opt in; 65 host-flag tests pass.

Receipts: capabilities `checkChromeActivity`, `shutdownChrome`, `tripwireStatus`, `clearTripwire`, `getPageContext`, `host-flags`. Chrome-dependent operations are verified against fakes and `--help`, not a live Chrome run.

## Honest caveats to keep next to the hero

- The `google` provider's result parsers are provisional: verified against synthetic fixtures, not live Google pages.
- A successful live search was not executed in the catalog run (it needs Chrome); search behaviour is covered by unit tests with a fake core.
- Read `docs/RESPONSIBLE-USE.md`: terms of service, robots.txt, rate limits, your own profile only.
