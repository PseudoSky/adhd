/**
 * stealth-core-browser/src/lib/session.ts — Session + browser target tracking.
 *
 * Generates a UUID per invocation. Tracks browser targetIds
 * opened during this session so audit logs can correlate events.
 */

import { randomUUID } from 'node:crypto'

let _uuid: string | null = null

/** Get the current session UUID (lazy-initialized). */
export function getSessionId(): string {
  if (!_uuid) _uuid = randomUUID()
  return _uuid
}

/** Browser targetIds opened during this session. */
export class BrowserSession {
  private targetIds: string[] = []

  track(targetId: string): void {
    this.targetIds.push(targetId)
  }

  /** Most recent browser targetId, or empty string. */
  get currentBrowserSessionId(): string {
    return this.targetIds[this.targetIds.length - 1] ?? ''
  }

  /** All targetIds from this session. */
  getAll(): string[] {
    return [...this.targetIds]
  }
}

export const browserSession = new BrowserSession()
