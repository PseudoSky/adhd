# Library API

`import * as api from '@adhd/stealth-search'` exposes the eleven operations and a small wiring surface. Importing the package starts no server, spawns no process, opens no socket and initializes no telemetry; the bins do that.

## Operations

`search`, `listProviders`, `describeProvider`, `tripwireStatus`, `clearTripwire`, `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity` and `getPageContext`, with the types of their inputs and outputs. See the [README](../README.md) and [EXAMPLES.md](EXAMPLES.md).

## Wiring and the search service

| Export | What it is |
| --- | --- |
| `configureSearch(options?)` | The one wiring entry. Sets the `InteractionPort` and the `SearchHostConfig` the operations use. Each call replaces the previous wiring and rebuilds the guard and tripwire; call it once at boot, before the first operation. |
| `createSearchService(options?)` | Builds a search service for one config, interaction port and set of collaborators. Performs no I/O. |
| `DEFAULT_SEARCH_TIMEOUT_MS`, `DEFAULT_MAX_ATTEMPTS` | The default deadline (30000 ms) and attempt count (3) of a search. |
| `PROVIDER_NAMES` | The id of every registered provider, in registration order. |

## Guard configuration

| Export | What it is |
| --- | --- |
| `createSearchHostConfig(overrides?)` | A complete `SearchHostConfig` from overrides. A `dataDir` override with no `auditPath` moves the audit log under that directory. A non-integer or out-of-range number raises `HOST_FLAG_INVALID`. |
| `DEFAULT_SEARCH_HOST_CONFIG` | The defaults: data dir `~/.adhd/reverse/data`, tripwire TTL 7200000 ms, cooldowns 30000 / 20000 / 60000 ms, 2 searches in flight, 4 siblings. See [CONFIGURATION.md](CONFIGURATION.md). |
| `InteractionPort` | The human-in-the-loop seam: `promptTripwireGate` (retry, clear or abort before work on a tripped provider) and `confirmSolved` (wait for a person to solve a challenge in the visible window). The CLI implements it over a terminal; the MCP host provides none. |

## Errors

| Export | What it is |
| --- | --- |
| `StealthSearchError`, `StealthCoreBrowserError` | The typed error classes; the first extends the second. |
| `SEARCH_ERROR_CODES` | The 13 codes. See [ERRORS.md](ERRORS.md). |
| `SEARCH_REMEDIATION` | The next step for each code. |
| `exitCodeFor(code)` | The process exit status of a code. |
| `isSearchError(e, code?)`, `isSearchErrorCode(x)` | Type guards for a `StealthSearchError` (optionally of one code) and for a code string. |
