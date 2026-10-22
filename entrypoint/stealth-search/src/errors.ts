/**
 * @adhd/stealth-search — src/errors.ts
 *
 * The one typed error family of the search entrypoint. `StealthSearchError` extends the
 * core's `StealthCoreBrowserError`, so a single `instanceof StealthCoreBrowserError` covers the
 * library and the entrypoint, and `instanceof StealthSearchError` isolates the entrypoint's own
 * failures. Every failure a user can hit (search, guard, fetch, host and tripwire) is one of the
 * 13 codes of `SEARCH_ERROR_CODES`, carries a remediation and maps to a process exit status via
 * `exitCodeFor`. SELECTOR_TIMEOUT and NODE_TOO_OLD are core codes re-listed here so the whole
 * entrypoint registry is readable in one place; their exit statuses come from the core.
 *
 * Outcomes (`success|empty|error|timeout|hitl|captcha|rate_limited|banned`) are data, never
 * exceptions: a search or fetch RESULT carries them, an error is thrown only for a failure.
 *
 * CLI form: `<CODE>: <message>` on stderr, exit `exitCodeFor(code)`. MCP form: a tool result with
 * `isError: true` carrying the code and message. See docs/ERRORS.md.
 *
 * Ticket 8468f7b1 · plan state search-errors.
 */
import { StealthCoreBrowserError, exitCodeFor as coreExitCodeFor } from '@adhd/stealth-core-browser'
import type { ErrorCode as CoreErrorCode, StealthCoreBrowserErrorInit } from '@adhd/stealth-core-browser'

/** Every failure mode of the search entrypoint, in documentation order. */
export const SEARCH_ERROR_CODES = [
  'UNKNOWN_PROVIDER',
  'SEARCH_FAILED',
  'SELECTOR_TIMEOUT',
  'HITL_ABORTED',
  'TRIPWIRE_STATE_UNREADABLE',
  'TRIPWIRE_CLEAR_FAILED',
  'PROVIDER_STATE_IO',
  'FETCH_URL_REFUSED',
  'PDF_EXTRACT_FAILED',
  'HOST_FLAG_INVALID',
  'HOST_TRANSPORT_UNSUPPORTED',
  'HOST_BOOT_FAILED',
  'NODE_TOO_OLD',
] as const

/** One member of `SEARCH_ERROR_CODES`. */
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number]

/** What a caller may attach to a search error (same shape as the core's). */
export type StealthSearchErrorInit = StealthCoreBrowserErrorInit

/** The concrete next step for each code. */
export const SEARCH_REMEDIATION: Readonly<Record<SearchErrorCode, string>> = {
  UNKNOWN_PROVIDER: 'Use one of the registered provider ids (see the providers list), then retry.',
  SEARCH_FAILED: 'Read the message and detail.reason, fix the query, provider or strategy option, then retry.',
  SELECTOR_TIMEOUT: 'Check the selector against the page or increase the timeout, then retry.',
  HITL_ABORTED: 'Retry and solve the challenge in the visible browser window, or choose another provider.',
  TRIPWIRE_STATE_UNREADABLE: 'Check the tripwire state file is readable JSON in a private directory, or remove it to reset, then retry.',
  TRIPWIRE_CLEAR_FAILED: 'Check the tripwire state file is writable, then clear the tripwire again.',
  PROVIDER_STATE_IO: 'Check that the provider state directory exists, is writable and is not full, then retry.',
  FETCH_URL_REFUSED: 'Pass a public http(s) URL; private, loopback and non-http(s) addresses are refused.',
  PDF_EXTRACT_FAILED: 'Check that the URL serves a readable, non-encrypted PDF, or fetch it as raw content.',
  HOST_FLAG_INVALID: 'Run the command with --help and pass a valid value for the flag.',
  HOST_TRANSPORT_UNSUPPORTED: 'Use a supported transport (stdio for MCP, or the CLI) and retry.',
  HOST_BOOT_FAILED: 'Read the cause, fix the host configuration or environment, then start the host again.',
  NODE_TOO_OLD: 'Upgrade Node.js to version 22.5 or newer.',
}

/** The process exit status of codes owned by this entrypoint (core codes use the core's table). */
const OWN_EXIT_CODES: Readonly<Record<Exclude<SearchErrorCode, 'SELECTOR_TIMEOUT' | 'NODE_TOO_OLD'>, number>> = {
  // 2 is the exit code of a `hitl` response, shared with the hosts (search-hosts.22).
  HITL_ABORTED: 2,
  UNKNOWN_PROVIDER: 70,
  SEARCH_FAILED: 71,
  TRIPWIRE_STATE_UNREADABLE: 72,
  TRIPWIRE_CLEAR_FAILED: 73,
  PROVIDER_STATE_IO: 74,
  FETCH_URL_REFUSED: 75,
  PDF_EXTRACT_FAILED: 76,
  HOST_FLAG_INVALID: 77,
  HOST_TRANSPORT_UNSUPPORTED: 78,
  HOST_BOOT_FAILED: 79,
}

/**
 * The process exit status a host applies for a code: the entrypoint's own table first, then the
 * core's (SELECTOR_TIMEOUT 33, NODE_TOO_OLD 12), then 1 for a code nobody knows.
 */
export function exitCodeFor(code: string): number {
  if (Object.prototype.hasOwnProperty.call(OWN_EXIT_CODES, code)) return OWN_EXIT_CODES[code as keyof typeof OWN_EXIT_CODES]
  return coreExitCodeFor(code)
}

/** True when `code` is one of `SEARCH_ERROR_CODES`. */
export function isSearchErrorCode(code: unknown): code is SearchErrorCode {
  return typeof code === 'string' && (SEARCH_ERROR_CODES as readonly string[]).includes(code)
}

/** The typed error of the search entrypoint. Never thrown bare: always one of `SEARCH_ERROR_CODES`. */
export class StealthSearchError extends StealthCoreBrowserError {
  // `code` keeps the core's static type (a closed union that cannot name the search codes); at runtime it is always
  // a member of SEARCH_ERROR_CODES, and `isSearchErrorCode` narrows it.

  constructor(code: SearchErrorCode, message: string, init: StealthSearchErrorInit = {}) {
    // The core types its registry as a closed union; the search codes extend it, so the base only stores the string.
    super(code as CoreErrorCode, message, init)
    this.name = 'StealthSearchError'
    Object.defineProperty(this, 'remediation', { value: SEARCH_REMEDIATION[code], enumerable: true, writable: false, configurable: true })
  }
}

/** A coded error whose message is `summary` followed by the code's remediation (the core's `of` format). */
export function searchError(code: SearchErrorCode, summary: string, init: StealthSearchErrorInit = {}): StealthSearchError {
  return new StealthSearchError(code, `${summary} — ${SEARCH_REMEDIATION[code]}`, init)
}

/** True for a StealthSearchError (optionally of one code). */
export function isSearchError(e: unknown, code?: SearchErrorCode): e is StealthSearchError {
  return e instanceof StealthSearchError && (code === undefined || e.code === code)
}

/**
 * A forced strategy the provider cannot run. It is a SEARCH_FAILED (no extra code) whose
 * `detail.reason` is `strategy-unsupported` and whose message names the provider and the strategy.
 */
export function strategyUnsupported(provider: string, strategy: string, init: StealthSearchErrorInit = {}): StealthSearchError {
  return searchError('SEARCH_FAILED', `provider "${provider}" cannot run the forced strategy "${strategy}"`, {
    ...init,
    detail: { ...init.detail, reason: 'strategy-unsupported', provider, strategy },
  })
}
