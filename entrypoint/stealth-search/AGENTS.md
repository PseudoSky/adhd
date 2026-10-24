# @adhd/stealth-search

Search entrypoint built on `@adhd/stealth-core-browser`: a CLI (`stealth-search`) and an MCP server (`stealth-search-mcp`) projected from one apigen API. Version 0.1.0 (0.x: the surface can still change).

## Facts

- Eleven operations. CLI: `search`, `listProviders`, `describeProvider`, `tripwireStatus`, `clearTripwire`, `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`. MCP: the same names prefixed `stealth_` (`stealth_search`, ...).
- MCP tool inputs are wrapped as `{ "data": { ... } }`.
- The CLI takes the operation name first, then kebab-case flags or one `--input` JSON object. The form without an operation name is not accepted.
- Providers: `duckduckgo`, `google`, `arxiv`, `npm`, `github`, `maven`, `wikipedia`, `crates`, `pypi`, `mdn`, `stackoverflow`, `fetch`. The `google` parsers are provisional: verified against synthetic fixtures only, not against live pages.
- "Stealth" means two choices: Chrome is launched without `--enable-automation`, and pages are read without `Runtime.evaluate`. It is not a guarantee that sites will not notice or block the browser.
- Outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`) are returned as data. Failures are `StealthSearchError` with 13 codes (`SEARCH_ERROR_CODES` in `src/errors.ts`); CLI form `<CODE>: <message>` on stderr plus exit status; MCP form an `isError` tool result. See `docs/ERRORS.md`.
- Defaults: CDP host `127.0.0.1`, port `9222`; profile `~/Library/Application Support/Google/Chrome-CDP`; data dir `~/.adhd/reverse/data`; MCP transport `stdio`. All settings are flags; no environment variable is read. See `docs/CONFIGURATION.md`.
- The MCP bin writes only JSON-RPC to stdout under stdio; logs go to stderr. Telemetry records are `adhd.<op>.start|finish|error`. See `docs/OBSERVABILITY.md`.
- macOS is the supported platform; Windows and Linux are untested.

## Rules for changes

- Consumes the BUILT core package only; never reaches into the core `src/`.
- CJS-only (ADR-0003); relative imports use `.js` specifiers.
- Never connect to port 9222 in tests or docs checks; tests use an in-process fake CDP server.
- Gates: `nx run stealth-search:lint`, `:typecheck`, `:typecheck-spec`, `:build`, `:build-bin`, `:test`, `:verify-dist-load`.
- Spec: `docs/plan/stealth-browser/SPEC-stealth-search.md`.

## Docs

`README.md`, `CHANGELOG.md`, `llms.txt`, `docs/OBSERVABILITY.md`, `docs/ERRORS.md`, `docs/CONFIGURATION.md`, `docs/EXAMPLES.md`, `docs/RESPONSIBLE-USE.md`. Capability inventory: `docs/marketing/.catalog/capabilities.json`.
