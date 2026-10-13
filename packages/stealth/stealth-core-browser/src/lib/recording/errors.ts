/**
 * @adhd/stealth-core-browser — src/lib/recording/errors.ts
 *
 * The eight failure modes of the capture pipeline. Every throw site in
 * src/lib/recording and capture/network.ts goes through `captureError`, so the
 * later `prod-errors` state reconciles the class with `StealthBrowserError` in
 * one place.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade (spec 5.5).
 */

export const CAPTURE_ERROR_CODES = [
  'CAPTURE_CONNECT_FAILED',
  'CAPTURE_NAVIGATE_FAILED',
  'CAPTURE_TIMEOUT',
  'CAPTURE_NO_MATCH',
  'CAPTURE_BAN_DETECTED',
  'CAPTURE_SESSION_CLOSED',
  'CAPTURE_SINK_FAILED',
  'CAPTURE_SINK_UNAVAILABLE',
] as const

export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number]

export interface CaptureErrorInit {
  cause?: unknown
  detail?: Record<string, unknown>
}

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  readonly cause?: unknown
  readonly detail?: Record<string, unknown>

  constructor(code: CaptureErrorCode, message: string, init: CaptureErrorInit = {}) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
    if (init.cause !== undefined) this.cause = init.cause
    if (init.detail !== undefined) this.detail = init.detail
  }
}

/** The single construction site for capture failures. */
export function captureError(code: CaptureErrorCode, message: string, init: CaptureErrorInit = {}): CaptureError {
  return new CaptureError(code, message, init)
}

/** Message text of anything thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
