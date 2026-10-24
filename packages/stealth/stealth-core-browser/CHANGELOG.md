# Changelog

All notable changes to `@adhd/stealth-core-browser` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Removed

- The unimplemented `ProfileClient.getOpenTabs()` stub (it only warned and returned `[]`). Use `listPageTargets()` for the open tabs of a running Chrome.

## [0.0.1] - 2026-10-24

Migration release: the Chrome runner library moves out of the `agent-browser` project into this package, with `@adhd/stealth-search` as its consumer.

### Added

- Six flat verbs: `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`. Each takes one plain object and returns plain JSON.
- Namespaces on the one package root (no subpath exports): `cdp`, `storage`, `capture`, `parsers`, `chromeManager`, `lifecycle`, `recording`, `endpoint`.
- `StealthCoreBrowserError` with a stable `code` registry (`ERROR_CODES`, `exitCodeFor`); see `docs/ERRORS.md`.
- Endpoint policy: loopback hosts only unless the hosting process calls `endpoint.configureEndpointPolicy`.
- Chrome lifecycle: race-free auto-start, idle timer, a reaper that defers to other sessions and open pages, a launch circuit breaker and a per-port state directory.
- Documentation: `docs/CONFIGURATION.md`, `docs/RESPONSIBLE-USE.md`, `docs/EXAMPLES.md` and runnable `examples/`.

### Changed

- Chrome is launched without `--enable-automation` and pages are read without `Runtime.evaluate`; this is the whole meaning of "stealth" in this package.
- The package is library-only. The CLI and the MCP server are hosted by `@adhd/stealth-search`.

### Notes

- The Google result-page parsers are provisional: they are verified against synthetic fixtures only.
- macOS is the verified platform; Linux and Windows code paths are untested. See `docs/CONFIGURATION.md`.
