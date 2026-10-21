/**
 * @adhd/stealth-core-browser — src/errors.ts
 *
 * The one typed error of the library. Every failure a caller can hit is a
 * `StealthCoreBrowserError` carrying a stable `code`, a remediation naming a
 * concrete next step, an optional `cause` and structured `detail`. The capture
 * layer's `CaptureError` and the lifecycle layer's `LifecycleError` extend it,
 * so a single `instanceof StealthCoreBrowserError` covers the whole package.
 * Hosts map a code to a process exit status with `exitCodeFor`; the CLI/MCP
 * rendering and the Node preflight that raises NODE_TOO_OLD live in the host
 * packages, which reuse this registry.
 *
 * `ERROR_CODES` is ordered: environment, library, capture, lifecycle. The
 * order is the order of docs/ERRORS.md.
 *
 * Ticket 8468f7b1 · plan state prod-errors (PA5.1, PA5.4).
 */

/** Every failure mode of the library, in documentation order. */
export const ERROR_CODES = [
  // environment
  'CHROME_NOT_FOUND',
  'PORT_IN_USE',
  'NODE_TOO_OLD',
  'CHROME_NOT_RUNNING',
  // library
  'CHROME_START_TIMEOUT',
  'CDP_UNREACHABLE',
  'CDP_BAD_RESPONSE',
  'TARGET_NOT_FOUND',
  'CDP_CONNECT_FAILED',
  'CDP_NOT_CONNECTED',
  'CDP_TIMEOUT',
  'CDP_REMOTE_ERROR',
  'CDP_SESSION_CLOSED',
  'CDP_SEND_FAILED',
  'NAVIGATION_FAILED',
  'PAGE_SETTLE_FAILED',
  'OPERATION_ABORTED',
  'SELECTOR_TIMEOUT',
  // capture
  'CAPTURE_CONNECT_FAILED',
  'CAPTURE_NAVIGATE_FAILED',
  'CAPTURE_TIMEOUT',
  'CAPTURE_NO_MATCH',
  'CAPTURE_BAN_DETECTED',
  'CAPTURE_SESSION_CLOSED',
  'CAPTURE_SINK_FAILED',
  'CAPTURE_SINK_UNAVAILABLE',
  // lifecycle
  'LAUNCH_FAILED',
  'LAUNCH_LOCK_TIMEOUT',
  'CHROME_UNREACHABLE_AFTER_LAUNCH',
  'LAUNCH_CIRCUIT_OPEN',
  'REAPER_UNAVAILABLE',
  'ISOLATED_CONTEXT_FAILED',
] as const

/** One member of `ERROR_CODES`. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** What a caller may attach to an error. */
export interface StealthCoreBrowserErrorInit {
  /** The underlying failure. */
  cause?: unknown
  /** Machine-readable facts about the failure (port, path, retryAfterMs, ...). */
  detail?: Record<string, unknown>
}

/** The concrete next step for each code. One phrasing per code; shown by docs/ERRORS.md. */
const REMEDIATION: Record<ErrorCode, string> = {
  CHROME_NOT_FOUND: 'Install Google Chrome or pass the path of an existing Chrome binary.',
  PORT_IN_USE: 'Free the port or choose another remote-debugging port.',
  NODE_TOO_OLD: 'Upgrade Node.js to version 22.5 or newer.',
  CHROME_NOT_RUNNING: 'Start Chrome with launchChrome, then retry.',
  CHROME_START_TIMEOUT: 'Check that the Chrome profile is not locked by another process, then retry the launch.',
  CDP_UNREACHABLE: 'Start Chrome with launchChrome, or check the host and port you passed.',
  CDP_BAD_RESPONSE: 'Check that the endpoint is Chrome DevTools and that Chrome is not shutting down, then retry.',
  TARGET_NOT_FOUND: 'List the open pages again and use a current target id.',
  CDP_CONNECT_FAILED: 'Check that the page websocket URL is current and the page is still open, then retry.',
  CDP_NOT_CONNECTED: 'Connect the session first and use it only while it is connected.',
  CDP_TIMEOUT: 'Increase the command timeout or retry when Chrome is less busy.',
  CDP_REMOTE_ERROR: 'Check the method name and parameters against the DevTools protocol, then retry.',
  CDP_SESSION_CLOSED: 'Open a new session and retry the operation.',
  CDP_SEND_FAILED: 'Reconnect the session and retry the command.',
  NAVIGATION_FAILED: 'Check the URL and the network, then retry the navigation.',
  PAGE_SETTLE_FAILED: 'Pass a navigate URL or a loaderId so the wait can scope to your navigation.',
  OPERATION_ABORTED: 'Retry the operation if the abort was not intended.',
  SELECTOR_TIMEOUT: 'Check the selector against the page or increase the timeout, then retry.',
  CAPTURE_CONNECT_FAILED: 'Check that the page websocket URL is current and Chrome is running, then retry.',
  CAPTURE_NAVIGATE_FAILED: 'Check the navigate URL and the network, then retry the capture.',
  CAPTURE_TIMEOUT: 'Increase the capture timeout or check that the page issues the expected request.',
  CAPTURE_NO_MATCH: 'Check the URL pattern against the requests the page makes, or relax it.',
  CAPTURE_BAN_DETECTED: 'Wait, then retry with a different request pattern or solve the challenge in the visible page.',
  CAPTURE_SESSION_CLOSED: 'Keep the page open for the whole capture and retry.',
  CAPTURE_SINK_FAILED: 'Check the recording sink storage and retry the capture.',
  CAPTURE_SINK_UNAVAILABLE: 'Install the store adapter and pass a writable database path and a valid table name.',
  LAUNCH_FAILED: 'Install Chrome or pass chromePath, free the port and retry.',
  LAUNCH_LOCK_TIMEOUT: 'Remove the stale launch lock file if no launcher is running, then retry.',
  CHROME_UNREACHABLE_AFTER_LAUNCH: 'Check that nothing else holds the port and the profile is not locked, then retry.',
  LAUNCH_CIRCUIT_OPEN: 'Fix the launch error and retry after retryAfterMs.',
  REAPER_UNAVAILABLE: 'Use a private state directory (mode 0700, own user) so the reaper can start.',
  ISOLATED_CONTEXT_FAILED: 'Check that Chrome is reachable and retry opening the page.',
}

/** The process exit status a host uses for each code (0 and 1 are left to the host). */
const EXIT_CODES: Record<ErrorCode, number> = {
  CHROME_NOT_FOUND: 10,
  PORT_IN_USE: 11,
  NODE_TOO_OLD: 12,
  CHROME_NOT_RUNNING: 13,
  CHROME_START_TIMEOUT: 20,
  CDP_UNREACHABLE: 21,
  CDP_BAD_RESPONSE: 22,
  TARGET_NOT_FOUND: 23,
  CDP_CONNECT_FAILED: 24,
  CDP_NOT_CONNECTED: 25,
  CDP_TIMEOUT: 26,
  CDP_REMOTE_ERROR: 27,
  CDP_SESSION_CLOSED: 28,
  CDP_SEND_FAILED: 29,
  NAVIGATION_FAILED: 30,
  PAGE_SETTLE_FAILED: 31,
  OPERATION_ABORTED: 32,
  SELECTOR_TIMEOUT: 33,
  CAPTURE_CONNECT_FAILED: 40,
  CAPTURE_NAVIGATE_FAILED: 41,
  CAPTURE_TIMEOUT: 42,
  CAPTURE_NO_MATCH: 43,
  CAPTURE_BAN_DETECTED: 44,
  CAPTURE_SESSION_CLOSED: 45,
  CAPTURE_SINK_FAILED: 46,
  CAPTURE_SINK_UNAVAILABLE: 47,
  LAUNCH_FAILED: 60,
  LAUNCH_LOCK_TIMEOUT: 61,
  CHROME_UNREACHABLE_AFTER_LAUNCH: 62,
  LAUNCH_CIRCUIT_OPEN: 63,
  REAPER_UNAVAILABLE: 64,
  ISOLATED_CONTEXT_FAILED: 65,
}

/** True when `code` is a registry code. */
function isCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, code)
}

/** Exit status for a host that meets an error code it does not know. */
const UNKNOWN_EXIT_CODE = 1

/**
 * The process exit status a host applies for a registry code. An unknown code
 * (for example a host's own) maps to 1.
 */
export function exitCodeFor(code: string): number {
  return isCode(code) ? EXIT_CODES[code as ErrorCode] : UNKNOWN_EXIT_CODE
}

/** Marks every package error, including the RangeError flavour, so `instanceof` stays one check. */
const BRAND = Symbol.for('@adhd/stealth-core-browser/error')

/** The longest cause chain `classifyLaunchFailure` follows. */
const MAX_CAUSE_DEPTH = 6

function causeOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined
}

function codeOf(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  return typeof c === 'string' ? c : undefined
}

function messageOf(e: unknown): string {
  return typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : String(e)
}

/** The typed error of the library. Never thrown bare: always one of the registry codes. */
export class StealthCoreBrowserError extends Error {
  /** Stable machine-readable code from `ERROR_CODES`. */
  readonly code: ErrorCode
  /** The concrete next step for this code. */
  readonly remediation: string
  /** Machine-readable facts about the failure. */
  readonly detail?: Record<string, unknown>
  /** The underlying failure, when there is one. */
  readonly cause?: unknown

  constructor(code: ErrorCode, message: string, init: StealthCoreBrowserErrorInit = {}) {
    super(message)
    if (init.cause !== undefined) this.cause = init.cause
    this.name = 'StealthCoreBrowserError'
    this.code = code
    this.remediation = REMEDIATION[code]
    if (init.detail !== undefined) this.detail = init.detail
    Object.defineProperty(this, BRAND, { value: true })
  }

  /** True for this class, its subclasses and the RangeError flavour of an invalid endpoint. */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true
    return this === StealthCoreBrowserError && typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }

  /** A coded error whose message is `summary` followed by the code's remediation. */
  static of(code: ErrorCode, summary: string, init: StealthCoreBrowserErrorInit = {}): StealthCoreBrowserError {
    return new StealthCoreBrowserError(code, `${summary} — ${REMEDIATION[code]}`, init)
  }

  /**
   * The error of an endpoint (host or port) that cannot address a Chrome. It is a RangeError
   * (the value is out of range) AND a package error (code CDP_UNREACHABLE, `detail.reason`
   * 'invalid-endpoint'), so both checks hold.
   */
  static invalidEndpoint(message: string): StealthCoreBrowserError {
    return new InvalidEndpointError(`${message} — ${REMEDIATION.CDP_UNREACHABLE}`)
  }

  /**
   * Refine a launch failure to the most specific environment code: a cause chain holding
   * ENOENT (or CHROME_NOT_FOUND) is CHROME_NOT_FOUND, EADDRINUSE is PORT_IN_USE; any other
   * typed error keeps its own code and an untyped one is LAUNCH_FAILED.
   */
  static classifyLaunchFailure(error: unknown): ErrorCode {
    let node: unknown = error
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && node !== undefined; depth++, node = causeOf(node)) {
      const code = codeOf(node)
      if (code === 'ENOENT' || code === 'CHROME_NOT_FOUND') return 'CHROME_NOT_FOUND'
      if (code === 'EADDRINUSE' || code === 'PORT_IN_USE') return 'PORT_IN_USE'
      const text = messageOf(node)
      if (/\bENOENT\b/.test(text)) return 'CHROME_NOT_FOUND'
      if (/\bEADDRINUSE\b/.test(text)) return 'PORT_IN_USE'
    }
    const own = codeOf(error)
    return own !== undefined && isCode(own) ? (own as ErrorCode) : 'LAUNCH_FAILED'
  }
}

/** The RangeError flavour of an invalid endpoint; it carries the same fields as the base class. */
class InvalidEndpointError extends RangeError {
  readonly code: ErrorCode = 'CDP_UNREACHABLE'
  readonly remediation: string = REMEDIATION.CDP_UNREACHABLE
  readonly detail: Record<string, unknown> = { reason: 'invalid-endpoint' }

  constructor(message: string) {
    super(message)
    this.name = 'StealthCoreBrowserError'
    Object.defineProperty(this, BRAND, { value: true })
  }
}
