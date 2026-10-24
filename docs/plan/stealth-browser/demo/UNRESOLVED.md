# UNRESOLVED - @adhd/stealth-browser Demo

Interfaces this demo had to guess, and scope gaps found while authoring. The package does not exist yet, so the exact apigen-generated CLI and MCP surface is inferred from sibling entrypoints. Resolve each before treating the corresponding DEMO.md step as authoritative; the states that fix each one are named.

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|----|-------------------|---------|-------|-----------------------|
| U1 | CLI verb invocation `node dist/bin/cli.js chromeStatus` (verb names exactly as the library exports, flags `--port`) | 3.2.4, 3.2.5 | sibling `dispatch-cli` CLI shape; apigen CLI host default naming | `node dist/bin/cli.js --help` after `surface-hosts` (guard surface-hosts.4) |
| U2 | MCP tool names end with `chrome_status`, `launch_chrome`, `list_page_targets`, `check_chrome_activity`, `get_page_context`, `shutdown_chrome` | 3.2.6 | the live agent-search MCP names its tools `agent_browser_search_mcp_source_chrome_status` (snake-cased verb suffix) | `tools/list` against `dist/bin/mcp.js` in `tests-e2e` |
| U3 | `launchChrome` option names `port`, `userDataDir` | 3.2.2 | `adhd/cdp-connection/src/browser.ts` launch options | the `api.ts` signature written by `surface-api` |
| U4 | Host/port selection for `chromeStatus` through env `STEALTH_BROWSER_CDP_HOST` (guard fallback) | 3.2.4 | none - `ChromeManager` takes typed options; env toggles are forbidden by the plan, so the final CLI flag is the `--port` option in U1 | `surface-hosts` implementation; if the env var is not honored the guard falls back to asserting the output shape only |

## Scope gaps & open questions

- Whether product keeps `capture/dom.ts` (Google-specific walker, kept for dod.4 parity): decided at `productization-hold`.
- Release mode (publish vs `link:` consumption) is the dispatcher's decision at `merge-readiness`; DEMO beat 5.7 demonstrates only the guarded post-condition.
- No Chrome binary is needed: the unit lane and the use-case suites run against an in-memory CDP harness, so CI without Chrome runs everything.
- Version of the three parser dependencies is pinned to the scratch repo ranges (`node-html-parser ^8.0.4`, `xpath ^0.0.34`, `@xmldom/xmldom ^0.9.10`); human approval pending (`hb-deps-approval`).
