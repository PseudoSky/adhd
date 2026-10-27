# Changelog

All notable changes to `@adhd/stealth-search` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows [Semantic Versioning](https://semver.org/) (0.x: the surface can still change).

## [Unreleased]

## [0.1.0] - 2026-10-27

### Added

- Eleven operations as a CLI (`stealth-search`) and an MCP server (`stealth-search-mcp`, tools prefixed `stealth_`): `search`, `listProviders`, `describeProvider`, `tripwireStatus`, `clearTripwire`, `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`.
- Twelve search providers: `duckduckgo`, `google`, `arxiv`, `npm`, `github`, `maven`, `wikipedia`, `crates`, `pypi`, `mdn`, `stackoverflow` and `fetch` (a URL read as markdown or extracted PDF text, windowed by `offset` and `maxContentSize`). The `google` parsers are provisional: verified against synthetic fixtures only.
- Host flags shared by both bins (`--cdp-host`, `--cdp-port`, `--user-data-dir`, `--transport`, `--idle-shutdown`, `--data-dir`, `--log-dir`, `--verbose`, ...), printed with their defaults by `--help`.
- Per-provider tripwires and cooldowns for `captcha`, `rate_limited` and `banned` outcomes.
- Telemetry records `adhd.<op>.start|finish|error` for every dispatched call on both hosts.
- Typed errors: `StealthSearchError` with 13 stable codes, a CLI exit status per code and an `isError` tool result over MCP.
- Fetch safety: loopback, private and other internal addresses are refused with `FETCH_URL_REFUSED`; the CDP host input is restricted to loopback unless opted in.
- Documentation: `docs/OBSERVABILITY.md`, `docs/ERRORS.md`, `docs/CONFIGURATION.md`, `docs/EXAMPLES.md`, `docs/RESPONSIBLE-USE.md`, `AGENTS.md`, `llms.txt`, and runnable examples under `examples/`.

[Unreleased]: https://github.com/PseudoSky/adhd/compare/main...HEAD
[0.1.0]: https://github.com/PseudoSky/adhd/tree/main/entrypoint/stealth-search
