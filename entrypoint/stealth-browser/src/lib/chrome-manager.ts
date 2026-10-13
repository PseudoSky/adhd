/**
 * chrome-manager.ts — Chrome lifecycle management.
 *
 * Provides auto-start, activity-bumped idle timer, and safety-checked
 * auto-shutdown. Composes cdp-connection (browser lifecycle, idle timer)
 * with domain/storage checks (CDP targets + history).
 *
 * Multi-process safety via shared heartbeat file at
 * /tmp/stealth-browser-heartbeat. Every process bumps the heartbeat
 * on each activity; the idle shutdown defers if any process has
 * bumped recently. Only GENUINE CDP activity stamps the heartbeat — a
 * process that merely defers to a sibling re-arms its timer without
 * stamping, so idle processes cannot keep each other alive forever
 * (see _rearmIdle).
 *
 * Usage:
 *   const chrome = new ChromeManager()
 *   await chrome.ready()          // Chrome running, browser ready
 *   chrome.bump()                 // reset idle timer, write heartbeat
 *   await chrome.shutdown()       // force shutdown now
 */

import { ensureChromeRunning, killChrome } from './cdp/browser.js'
import { IdleShutdown } from './cdp/shutdown.js'
import { closeAllPageTargets, hideAllWindows, isChromeReachable } from './cdp/targets.js'
import { TargetService } from './domains/target.js'
import { HistoryClient } from './storage/history.js'
import { isActiveWebTarget } from './lifecycle/page-tier.js'
import { writeFileSync, readFileSync } from 'node:fs'

export interface ChromeManagerOptions {
  /** CDP host. Default: 127.0.0.1:9222 */
  cdpHost?: string
  /** Idle timeout in ms. Default: 120_000 (2 min). */
  idleTimeoutMs?: number
  /** Path to shared heartbeat file. Default: /tmp/stealth-browser-heartbeat */
  heartbeatPath?: string
  /** If true, check Chrome history for recent activity. Default: true. */
  checkHistory?: boolean
  /** Log function. Default: console.error */
  logger?: (msg: string) => void
}

const defaultLogger = (msg: string) => console.error(`[chrome-manager] ${msg}`)

const HEARTBEAT_PATH = '/tmp/stealth-browser-heartbeat'

/** Safety tier 2 lives in lifecycle/page-tier.ts; re-exported here so the manager module keeps the export. */
export { isActiveWebTarget }

export class ChromeManager {
  private targetService: TargetService
  private history: HistoryClient
  private idle: IdleShutdown | null = null
  private _ready = false
  private readonly opts: Required<ChromeManagerOptions>
  private readonly log: (msg: string) => void
  private readonly myPid: number

  constructor(opts: ChromeManagerOptions = {}) {
    this.opts = {
      cdpHost: opts.cdpHost ?? '127.0.0.1:9222',
      idleTimeoutMs: opts.idleTimeoutMs ?? 120_000,
      heartbeatPath: opts.heartbeatPath ?? HEARTBEAT_PATH,
      checkHistory: opts.checkHistory ?? true,
      logger: opts.logger ?? defaultLogger,
    }
    this.log = this.opts.logger
    this.myPid = process.pid
    this.targetService = new TargetService(this.opts.cdpHost)
    this.history = new HistoryClient()
  }

  /** Ensure Chrome is running. Starts it if not reachable.
   *
   *  Self-healing: `_ready` is NOT trusted blindly. Another process's idle
   *  shutdown may have killed the SHARED Chrome while this process was idle,
   *  leaving the flag stale — a blind `if (this._ready) return` would then
   *  skip the relaunch and every search() would fail on CDP. Instead, when
   *  `_ready` is true we cheaply re-verify reachability (one GET to
   *  /json/version) and only take the fast path when Chrome is actually up.
   *  On the fast path we deliberately do NOT re-hide windows: a HITL window
   *  revealed for a human must stay visible. */
  async ready(): Promise<void> {
    if (this._ready) {
      if (await isChromeReachable(this.opts.cdpHost)) {
        this._writeHeartbeat()
        return
      }
      this.log('stale _ready — Chrome no longer reachable (killed by another process?); relaunching')
      this._ready = false
    }
    try {
      await ensureChromeRunning({ port: this._port() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to ensure Chrome running: ${msg}`)
      throw err
    }
    try {
      // Hide ALL Chrome windows — prevents the default window from appearing on-screen
      // after auto-launch, even when Chrome ignores --window-position from saved state.
      await hideAllWindows(this.opts.cdpHost)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to hide Chrome windows: ${msg}`)
      throw err
    }
    this._ready = true
    this._startIdleTimer()
    // We just had activity (a launch) — re-arm the idle window from now.
    this.idle?.reset()
    this._writeHeartbeat()
  }

  /** Bump the idle timer and write heartbeat. Call after every CDP operation. */
  bump(): void {
    if (!this.idle) return
    this.idle.reset()
    this._writeHeartbeat()
  }

  /**
   * Re-arm our idle timer WITHOUT advertising activity to siblings.
   *
   * Called only from the deferral branches of `_doShutdown`. The deferral path
   * must NOT call `bump()`: writing the heartbeat from a process that is idle
   * but merely *refusing* to shut down makes that process look active to its
   * siblings, so they defer to it in turn — a mutual-deferral livelock in which
   * every idle process keeps every other process's heartbeat fresh forever and
   * the shared Chrome is never reaped, even with zero pages open (observed live:
   * three idle servers rotating heartbeats every ~120s indefinitely). The
   * heartbeat is written exclusively by genuine activity (`bump()` after a real
   * CDP operation); deferral re-arms only, so `_isOtherProcessActive()` keeps
   * meaning "another process is really doing work".
   */
  private _rearmIdle(): void {
    this.idle?.reset()
  }

  /** Force immediate shutdown. */
  async shutdown(): Promise<void> {
    this.idle?.cancel()
    await this._doShutdown(true)
  }

  /**
   * SOFT shutdown: close Chrome only if it is genuinely idle — deferring to the
   * cross-process heartbeat and to any open http(s) page (see `_doShutdown`).
   * Unlike `shutdown()` this never force-kills a Chrome another session or a
   * human's captcha window is using. Safe to call from a process-exit path so a
   * server that launched Chrome does not orphan it (its idle timer dies with
   * the process, leaving nothing to reap Chrome).
   */
  async shutdownIfIdle(): Promise<void> {
    this.idle?.cancel()
    await this._doShutdown(false)
  }

  /** Run a function with automatic Chrome lifecycle management. */
  async withBrowser<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready()
    try {
      return await fn()
    } finally {
      this.bump()
    }
  }

  get isReady(): boolean {
    return this._ready
  }

  /** CDP port parsed from cdpHost. */
  private _port(): number {
    return parseInt(this.opts.cdpHost.split(':')[1] ?? '9222', 10)
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  /** Write our PID + current timestamp to the shared heartbeat file. */
  private _writeHeartbeat(): void {
    try {
      const existing = this._readHeartbeat()
      existing.set(this.myPid, Date.now())
      const lines = Array.from(existing.entries())
        .map(([pid, ts]) => `${pid}:${ts}`)
        .join('\n')
      writeFileSync(this.opts.heartbeatPath, lines + '\n', 'utf8')
    } catch { /* best effort */ }
  }

  /** Read the shared heartbeat file, filtering out dead PIDs.
   *  Returns Map<pid, timestamp_ms> of live processes only. */
  private _readHeartbeat(): Map<number, number> {
    const map = new Map<number, number>()
    try {
      const raw = readFileSync(this.opts.heartbeatPath, 'utf8')
      for (const line of raw.trim().split('\n')) {
        const [pidStr, tsStr] = line.split(':')
        if (!pidStr || !tsStr) continue
        const pid = parseInt(pidStr, 10)
        const ts = parseInt(tsStr, 10)
        if (isNaN(pid) || isNaN(ts)) continue
        // Skip dead PIDs — they can't be actively using Chrome
        try { process.kill(pid, 0) } catch { continue }
        map.set(pid, ts)
      }
    } catch { /* no file yet — we're first */ }
    return map
  }

  /** Check if another process bumped the heartbeat within the timeout window. */
  private _isOtherProcessActive(): boolean {
    const heartbeat = this._readHeartbeat()
    const now = Date.now()
    const window = this.opts.idleTimeoutMs
    for (const [pid, ts] of heartbeat) {
      if (pid === this.myPid) continue
      if (now - ts < window) {
        this.log(`pid ${pid} active ${Math.round((now - ts) / 1000)}s ago — deferring`)
        return true
      }
    }
    return false
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  private _startIdleTimer(): void {
    if (this.idle) return
    this.idle = new IdleShutdown({
      timeoutMs: this.opts.idleTimeoutMs,
      logger: (m) => this.log(m),
      onShutdown: () => this._doShutdown(false),
    })
  }

  private async _doShutdown(force: boolean): Promise<void> {
    if (!force) {
      // 1. Cross-process heartbeat check
      if (this._isOtherProcessActive()) {
        this._rearmIdle()
        return
      }

      // 2. Live CDP check: is a real WEB page open? Only http(s) documents mean
      //    "a human / another call is using Chrome". Browser-internal targets
      //    (chrome://newtab/, chrome://omnibox…, chrome-untrusted://, about:,
      //    devtools://, extension service workers) must NOT keep Chrome alive —
      //    the default window ALWAYS shows chrome://newtab/, so the previous
      //    `url !== 'about:blank'` test counted it as active and made the idle
      //    shutdown defer FOREVER (Chrome was never reaped). A HITL captcha
      //    window or a keepPage result is http(s) and still defers correctly.
      try {
        const targets = await this.targetService.listPageTargets()
        const active = targets.filter((t) => t.url && isActiveWebTarget(t.url))
        if (active.length > 0) {
          this.log(`${active.length} active page(s) found — Chrome in use`)
          this._rearmIdle()
          return
        }
      } catch { /* can't reach CDP — proceed */ }

      // 3. History check (optional): recent visits?
      if (this.opts.checkHistory) {
        try {
          const recentlyUsed = this.history.isRecentlyUsed(2)
          if (recentlyUsed) {
            this.log('recent history activity found — Chrome in use')
            this._rearmIdle()
            return
          }
        } catch { /* history DB unavailable — proceed */ }
      }
    }

    this.log('shutting down...')
    try {
      await closeAllPageTargets(this.opts.cdpHost)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to close page targets during shutdown: ${msg}`)
    }
    try {
      await killChrome(this._port())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to kill Chrome during shutdown: ${msg}`)
    }
    // After a REAL shutdown the idle timer is spent: any later relaunch must
    // arm a fresh one (IdleShutdown.reset() now re-arms, but nulling also
    // makes bump() a no-op until the next ready()).
    this.idle = null
    this._ready = false
  }
}
