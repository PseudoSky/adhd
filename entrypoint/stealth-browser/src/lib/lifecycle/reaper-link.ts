/**
 * @adhd/stealth-browser — src/lib/lifecycle/reaper-link.ts
 *
 * `ReaperLink` is the ONE seam between a ChromeManager (the client) and the
 * reaper host for its port. The manager depends only on this port; the real
 * adapter (`createProxyReaperLink`, over the service-proxy transport through
 * `sp.ts`) and the unit-test fake (`src/test/unit/lifecycle/fake-reaper-link.ts`)
 * both implement it.
 *
 * Link rules (SPEC-single-pass-lifecycle.md 3.4): one held connection per
 * client; `hello{pid, checkHistory}` on connect (registration, not activity);
 * `activity()` is fire-and-forget and the ONLY activity sender is the
 * manager's `bump()`; re-ensure happens only on `ready()`, on a `bump()` /
 * `withBrowser` settle while the link is down and Chrome is reachable, and on
 * one retry of a previously failed ensure at idle fire — never on disconnect.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (CL15 CL22).
 */

import type { ReapOutcome, ReaperStatus } from './reaper-host.js'

export interface ReaperLink {
  /**
   * Ensure the reaper host for this port is running and hold one connection
   * that has sent `hello`. Resolves false (never rejects) when the reaper is
   * unavailable: the manager then runs in degraded mode.
   */
  ensureAndHello(): Promise<boolean>
  /** Fire-and-forget `activity` notification. Never throws. */
  activity(): void
  /** Soft reap through the host (graceMs 0, caller excluded); null when the link is down. */
  reapIfIdle(): Promise<ReapOutcome | null>
  /** Leave the host registry and close the connection. Best effort, never rejects. */
  release(): Promise<void>
  /** The host `status` answer; null when the link is down. */
  status(): Promise<ReaperStatus | null>
  /** True while a connection that sent `hello` is held. */
  isUp(): boolean
}
