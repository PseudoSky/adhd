/**
 * stealth-core-browser/src/lib/session.ts — Session + browser target tracking.
 *
 * Generates a UUID per invocation. Tracks browser targetIds
 * opened during this session so audit logs can correlate events.
 */

let _uuid: string | null = null

/** RFC 4122 v4 UUID. */
function generateUuid(): string {
  const hex = '0123456789abcdef'
  const bits = new Uint8Array(16)
  crypto.getRandomValues(bits)
  bits[6] = (bits[6] & 0x0f) | 0x40
  bits[8] = (bits[8] & 0x3f) | 0x80
  return Array.from(bits, (b, i) => {
    const h = hex[b >> 4] + hex[b & 0x0f]
    return [4, 6, 8, 10].includes(i) ? `-${h}` : h
  }).join('')
}

/** Get the current session UUID (lazy-initialized). */
export function getSessionId(): string {
  if (!_uuid) _uuid = generateUuid()
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
