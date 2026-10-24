# Examples

Every file under [`examples/`](../examples) is a runnable TypeScript module that opens with a `Scenario:` header and exports `run(options)`. Each targets port `9333`, never the default `9222`, and imports only the package root, exactly as a consumer does. The unit suite (`test/unit/examples/examples.spec.ts`) executes every `run()` against an in-process fake Chrome, so none of them starts a real browser in CI. Failures are `StealthCoreBrowserError` values; the codes are in [ERRORS.md](ERRORS.md). Defaults and overrides are in [CONFIGURATION.md](CONFIGURATION.md); read [RESPONSIBLE-USE.md](RESPONSIBLE-USE.md) before pointing any of this at a real site.

## Verbs

| File | Scenario |
|---|---|
| [`examples/verbs/chromeStatus.ts`](../examples/verbs/chromeStatus.ts) | Before a job starts, find out whether the dedicated Chrome already answers on its debugging port and which version it is, to decide between reusing it and launching a new one. |
| [`examples/verbs/launchChrome.ts`](../examples/verbs/launchChrome.ts) | Start (or reuse) a hidden Chrome on a dedicated port with its own profile directory; calling it twice is safe. |
| [`examples/verbs/shutdownChrome.ts`](../examples/verbs/shutdownChrome.ts) | When a job finishes, ask the managed Chrome to close only if it is genuinely idle, and read from the result whether it is still running. |
| [`examples/verbs/listPageTargets.ts`](../examples/verbs/listPageTargets.ts) | Find the target id of the tab a person left open on a given site so a follow-up call can inspect that exact page. |
| [`examples/verbs/checkChromeActivity.ts`](../examples/verbs/checkChromeActivity.ts) | Before touching a shared Chrome, check that nobody is actively browsing: no open web pages and no recent history visit. |
| [`examples/verbs/getPageContext.ts`](../examples/verbs/getPageContext.ts) | Describe an open tab from its target id (URL, title, cookie count for its host, history count) without reading cookie values. |

## Namespaces

| File | Scenario |
|---|---|
| [`examples/namespaces/cdp.ts`](../examples/namespaces/cdp.ts) | Inspect a running Chrome at the protocol level: confirm it answers, read its version, list its tabs and open a raw CDP session on the first tab. |
| [`examples/namespaces/storage.ts`](../examples/namespaces/storage.ts) | Audit, read-only, which open tabs the dedicated profile already knows: page history, bookmarks matching a topic and top sites. |
| [`examples/namespaces/capture.ts`](../examples/namespaces/capture.ts) | Capture the network response of a page load, check it for a CAPTCHA or rate-limit wall and decide whether to retry or give up. |
| [`examples/namespaces/parsers.ts`](../examples/namespaces/parsers.ts) | Turn a captured response into result rows without injecting script: JSON when it is JSON, otherwise HTML, with a structural XPath fallback. |
| [`examples/namespaces/chromeManager.ts`](../examples/namespaces/chromeManager.ts) | Report whether a long-lived host's Chrome is safe to close: which tabs count as web pages and what the reaper and launch breaker say. |
| [`examples/namespaces/recording.ts`](../examples/namespaces/recording.ts) | Keep a replayable record of a page load for debugging, with cookies and authorization headers masked before anything is stored. |
| [`examples/namespaces/lifecycle.ts`](../examples/namespaces/lifecycle.ts) | Decide whether an idle Chrome may be closed now (another client, an open page or a recent visit each keep it alive) and guard against a launch storm. |
| [`examples/namespaces/endpoint.ts`](../examples/namespaces/endpoint.ts) | Vet which DevTools endpoint a caller may use (loopback by default) and refuse a debugger WebSocket URL that points at a third host. |

## CLI and MCP hosts

This package is a library: it has no `examples/cli.md` and no `examples/mcp-config.json`. The command line and the MCP server are hosted by `@adhd/stealth-search`, which projects the six verbs one-to-one; its examples and usage live with that package.
