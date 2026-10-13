/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/reap-policy.ts
 *
 * The ONE reap policy. Pure: no I/O, no clock, no writes. The reaper host
 * calls it from its tick (graceMs = shutdownGraceMs) and from a client's soft
 * `reapIfIdle` (graceMs = 0); there is no second implementation.
 *
 * Tier order (each tier that pins returns `keep`):
 *   1. another connected client sent `activity` within `idleTimeoutMs`
 *      (the caller's own activity never pins — F8, F13 of the inventory);
 *   2. an open http(s) page (`isActiveWebTarget`; browser-internal targets
 *      never pin; an unreachable CDP during the check proceeds — F10-F12);
 *   3. a history visit within 2 minutes, when the tier is enabled (on when ANY
 *      connected client enables it, else the reaper default; an unavailable
 *      history database proceeds — F13);
 * then the grace window since the last pin (`wait`), then the scope:
 * `launched-only` without a valid owner record never signals anything (`none`),
 * `port-occupant` (the default, F19) reaps.
 *
 * Livelock protection (F9): deciding never writes anything. Only the
 * `activity` message mutates `lastActivityAt`, and only `bump()` sends it.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.2).
 */

export type ReaperScope = 'launched-only' | 'port-occupant'

/** One connected client as the policy sees it. */
export interface ClientView {
  id: string
  pid: number | null
  checkHistory: boolean
  /** Host-clock time of the client's last `activity`, null when it never sent one. */
  lastActivityAt: number | null
}

export interface ReapInput {
  now: number
  clients: readonly ClientView[]
  /** The client asking (soft `reapIfIdle`): excluded from the client pin check. */
  callerId?: string
  idleTimeoutMs: number
  /** Explicit soft shutdown passes 0 (F15); the host tick passes shutdownGraceMs (N2). */
  graceMs: number
  chromeUp: boolean
  /** `'unreachable'` means the page listing failed: proceed (F12). */
  httpPageCount: number | 'unreachable'
  /** `'unavailable'` means the history database could not be read: proceed. */
  historyRecent: boolean | 'unavailable'
  /** The history tier when no client is connected (the reaper default, true). */
  checkHistoryDefault: boolean
  scope: ReaperScope
  /** True only when the launched-Chrome record matches a live process (pid + start token). */
  ownerValid: boolean
  /** Host-clock time Chrome was last pinned (or a pinning client left); null = never. */
  lastPinAt: number | null
}

export type ReapAction = 'keep' | 'wait' | 'reap' | 'none'
export type PinReason = 'client' | 'page' | 'history' | 'grace'

export interface ReapDecision {
  action: ReapAction
  pinnedBy?: PinReason
}

/** True when a client's activity is inside the idle window at `now`. */
export function isClientActive(c: ClientView, now: number, idleTimeoutMs: number): boolean {
  return c.lastActivityAt !== null && now - c.lastActivityAt < idleTimeoutMs
}

/** The history tier is on when ANY connected client enables it, else the reaper default. */
export function historyTierEnabled(clients: readonly ClientView[], checkHistoryDefault: boolean): boolean {
  return clients.length === 0 ? checkHistoryDefault : clients.some((c) => c.checkHistory)
}

export function decideReap(i: ReapInput): ReapDecision {
  if (!i.chromeUp) return { action: 'none' }

  // Tier 1: another connected client active within the idle window.
  if (i.clients.some((c) => c.id !== i.callerId && isClientActive(c, i.now, i.idleTimeoutMs))) {
    return { action: 'keep', pinnedBy: 'client' }
  }

  // Tier 2: an open http(s) page. Unreachable CDP proceeds.
  if (i.httpPageCount !== 'unreachable' && i.httpPageCount > 0) {
    return { action: 'keep', pinnedBy: 'page' }
  }

  // Tier 3: recent history, when enabled. An unavailable database proceeds.
  if (historyTierEnabled(i.clients, i.checkHistoryDefault) && i.historyRecent === true) {
    return { action: 'keep', pinnedBy: 'history' }
  }

  // Grace since the last pin.
  if (i.graceMs > 0 && i.lastPinAt !== null && i.now - i.lastPinAt < i.graceMs) {
    return { action: 'wait', pinnedBy: 'grace' }
  }

  // Scope: launched-only never signals a Chrome it cannot prove it launched.
  if (i.scope === 'launched-only' && !i.ownerValid) return { action: 'none' }
  return { action: 'reap' }
}
