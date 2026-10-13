/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/errors.ts
 *
 * The six failure modes of the Chrome lifecycle. Every throw site under
 * src/lib/lifecycle (and the lifecycle paths of chrome-manager.ts) goes
 * through `lifecycleError`, so the later `prod-errors` state reconciles the
 * class with `StealthBrowserError` in one place.
 *
 * There is deliberately no presence/lease code: presence is one held
 * connection per client to the reaper host, so there is no presence file whose
 * directory could be insecure.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.6, CL20).
 */

export const LIFECYCLE_ERROR_CODES = [
  'LAUNCH_FAILED',
  'LAUNCH_LOCK_TIMEOUT',
  'CHROME_UNREACHABLE_AFTER_LAUNCH',
  'LAUNCH_CIRCUIT_OPEN',
  'REAPER_UNAVAILABLE',
  'ISOLATED_CONTEXT_FAILED',
] as const

export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number]

/** Structured, machine-readable facts about a lifecycle failure. */
export interface LifecycleErrorDetail {
  /** LAUNCH_CIRCUIT_OPEN: how long until the breaker lets one probe launch through. */
  retryAfterMs?: number
  /** The CDP port the failure is about. */
  port?: number
  /** A filesystem path involved (lock file, state directory, socket). */
  path?: string
  [key: string]: unknown
}

export interface LifecycleErrorInit {
  cause?: unknown
  detail?: LifecycleErrorDetail
}

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode
  readonly cause?: unknown
  readonly detail?: LifecycleErrorDetail

  constructor(code: LifecycleErrorCode, message: string, init: LifecycleErrorInit = {}) {
    super(message)
    this.name = 'LifecycleError'
    this.code = code
    if (init.cause !== undefined) this.cause = init.cause
    if (init.detail !== undefined) this.detail = init.detail
  }
}

/** The single construction site for lifecycle failures. */
export function lifecycleError(code: LifecycleErrorCode, message: string, init: LifecycleErrorInit = {}): LifecycleError {
  return new LifecycleError(code, message, init)
}

/** True for a LifecycleError (optionally of one code). */
export function isLifecycleError(e: unknown, code?: LifecycleErrorCode): e is LifecycleError {
  return e instanceof LifecycleError && (code === undefined || e.code === code)
}

/** Message text of anything thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * One-line messages that name the fix. Kept together so every code has
 * exactly one phrasing and `errors.spec.ts` can reach each through the
 * factory below.
 */
export const lifecycleErrors = {
  launchFailed: (port: number, cause: unknown): LifecycleError =>
    lifecycleError(
      'LAUNCH_FAILED',
      `Chrome could not be launched on port ${port} (${errorMessage(cause)}); install Chrome or pass chromePath, and free the port.`,
      { cause, detail: { port } },
    ),
  launchLockTimeout: (port: number, path: string): LifecycleError =>
    lifecycleError(
      'LAUNCH_LOCK_TIMEOUT',
      `Timed out waiting for the Chrome launch lock ${path} on port ${port}; remove the stale lock file if no launcher is running.`,
      { detail: { port, path } },
    ),
  unreachableAfterLaunch: (port: number, cause?: unknown): LifecycleError =>
    lifecycleError(
      'CHROME_UNREACHABLE_AFTER_LAUNCH',
      `Chrome started but CDP did not answer on port ${port} within 10 s; check that nothing else holds the port and the profile is not locked.`,
      { cause, detail: { port } },
    ),
  circuitOpen: (port: number, retryAfterMs: number): LifecycleError =>
    lifecycleError(
      'LAUNCH_CIRCUIT_OPEN',
      `Chrome failed to launch 3 times in 60 s on port ${port}; retry in ${Math.ceil(retryAfterMs / 1000)} s after fixing the launch error.`,
      { detail: { port, retryAfterMs } },
    ),
  reaperUnavailable: (port: number, cause?: unknown, path?: string): LifecycleError =>
    lifecycleError(
      'REAPER_UNAVAILABLE',
      `The Chrome reaper for port ${port} could not be started (${errorMessage(cause ?? 'unknown')}); idle Chrome is not auto-closed until the state directory is private (0700, own uid).`,
      { cause, detail: path === undefined ? { port } : { port, path } },
    ),
  isolatedContextFailed: (step: string, cause: unknown): LifecycleError =>
    lifecycleError(
      'ISOLATED_CONTEXT_FAILED',
      `Opening an isolated page failed at ${step} (${errorMessage(cause)}); the context was disposed, check that Chrome is reachable and retry.`,
      { cause, detail: { step } },
    ),
} as const
