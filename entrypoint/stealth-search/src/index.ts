/**
 * @adhd/stealth-search: the package root.
 *
 * Re-exports the eleven verbs and their types, `configureSearch` (the one wiring entry: the
 * injected `InteractionPort` and `SearchHostConfig`), the typed error family and the config
 * helpers. Importing this module has no side effect: it starts no server, spawns no process,
 * opens no socket and initializes no telemetry (the hosts do that in their bins).
 *
 * Inventory rows: I-02 .. I-07, I-13, I-14, I-16, I-17, I-18 (through the verbs).
 * Ticket 8468f7b1 · plan state search-verbs · [search-verbs.5]
 */

// The eleven verbs and every type of their inputs and outputs.
export * from './api.js'

// The wiring entry and the search service.
export { configureSearch, createSearchService, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS } from './lib/search.js'
export type { ConfigureSearchOptions, SearchCore, SearchDeps, SearchPage, SearchService, SearchServiceOptions } from './lib/search.js'

// Guard configuration and the human-in-the-loop seam.
export { createSearchHostConfig, DEFAULT_SEARCH_HOST_CONFIG } from './lib/config.js'
export type { GateDecision, GatePromptInfo, InteractionPort, SearchHostConfig, SolvedAnswer, SolvedPromptInfo } from './lib/config.js'

// The typed error family: every failure a caller can hit is a StealthSearchError with a stable code.
export { StealthSearchError, SEARCH_ERROR_CODES, SEARCH_REMEDIATION, exitCodeFor, isSearchError, isSearchErrorCode } from './errors.js'
export type { SearchErrorCode, StealthSearchErrorInit } from './errors.js'
export { StealthCoreBrowserError } from '@adhd/stealth-core-browser'

// Provider registry facts.
export { PROVIDER_NAMES } from './lib/providers.js'
