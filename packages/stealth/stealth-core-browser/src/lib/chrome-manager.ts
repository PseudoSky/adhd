/**
 * chrome-manager.ts — the Chrome lifecycle of one client process.
 *
 * Auto-start (race-free, bounded, self-healing), an activity-bumped idle
 * timer, and an idle shutdown that never closes a Chrome someone else is
 * using. Cross-process coordination is connection-based: every manager holds
 * ONE connection to the reaper host of its port (`ReaperLink`); the host keeps
 * the registry of connected clients, evaluates the three safety tiers
 * (sibling activity, open http(s) pages, recent history) and performs the
 * ordered reap. A killed client's connection closes with it, so a dead process
 * can never pin Chrome, and the host outlives every client, so Chrome is never
 * orphaned. There is no shared activity file.
 *
 * Livelock protection: only genuine use of Chrome sends `activity` (`bump()`,
 * which `withBrowser` calls, and `ready()`, through one private sender). Idle
 * fire and `shutdownIfIdle()` ask the host (`reapIfIdle`) and, on keep / wait,
 * re-arm the timer and send nothing — so idle processes cannot keep each other
 * alive.
 *
 * Degraded mode (decision D1): when the reaper cannot be started (an unsafe
 * state directory, `ensureBackend` failing with E_UDS_DIR_UNSAFE, ...) `ready()`
 * still succeeds, `status().reaper` is false, the idle timer still fires but
 * never closes Chrome (it cannot see siblings), a forced `shutdown()` still
 * works, and exactly one warning is logged.
 *
 * Usage:
 *   const chrome = managerFor('127.0.0.1', 9222)   // src/lib/managers.ts is the one construction site
 *   await chrome.ready()          // Chrome running, registered with the reaper
 *   chrome.bump()                 // real work happened: re-arm + tell the reaper
 *   await chrome.shutdown()       // force shutdown now
 *   await chrome.release()        // leave the reaper registry (process lives on)
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.3, CL1-CL4 CL9 CL19 CL21 CL26 CL28 CL29).
 */

import { ensureChromeRunning, killChrome } from './cdp/browser.js'
import { IdleShutdown } from './cdp/shutdown.js'
import { portOf } from './endpoint.js'
import { closeAllPageTargets, hideAllWindows, isChromeReachable, listPageTargetsOnly } from './cdp/targets.js'
import { errorMessage, isLifecycleError, lifecycleError, lifecycleErrors, type LifecycleError } from './lifecycle/errors.js'
import { createLaunchBreaker, type LaunchBreaker } from './lifecycle/launch-breaker.js'
import { createOwnershipStore, type OwnershipStore } from './lifecycle/ownership.js'
import { countActiveWebPages, isActiveWebTarget } from './lifecycle/page-tier.js'
import type { ReaperScope } from './lifecycle/reap-policy.js'
import type { ReapOutcome } from './lifecycle/reaper-host.js'
import { createProxyReaperLink, type ReaperLink } from './lifecycle/reaper-link.js'
import { resolveStateDir, type StateDirResult } from './lifecycle/state-dir.js'

/** Safety tier 2 lives in lifecycle/page-tier.ts; re-exported here so the manager module keeps the export. */
export { isActiveWebTarget }
export type { ReaperLink }

/** The launch ran but CDP never answered: the typed CHROME_START_TIMEOUT, or its message from an older build. */
function isStartTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'CHROME_START_TIMEOUT' || /did not start CDP/.test(errorMessage(err))
}

export interface ChromeManagerOptions {
  /** CDP host. Default: 127.0.0.1:9222 */
  cdpHost?: string
  /** Idle timeout in ms. Default: 120_000 (2 min). */
  idleTimeoutMs?: number
  /**
   * true never arms the idle timer (a long-lived host keeps its Chrome); the forced `shutdown()`,
   * the soft `shutdownIfIdle()` and the reaper's own decisions are unchanged. Default: false.
   */
  keepAlive?: boolean
  /**
   * The built CommonJS package entry the detached reaper process loads `runChromeReaper` through
   * (the entry the HOST loaded). Default: the bundle this code runs from.
   */
  entryPath?: string
  /** Chrome user data directory this manager launches and may kill. Default: the dedicated CDP profile. */
  userDataDir?: string
  /** Let a Chrome history visit within 2 minutes keep Chrome alive. Default: true. */
  checkHistory?: boolean
  /** Grace after the last client left before the reaper closes Chrome. Default: 30_000. */
  shutdownGraceMs?: number
  /** A reaper host nobody uses retires this long after Chrome is gone. Default: 30_000. */
  orphanWindowMs?: number
  /** Private state directory. Default: `<os.tmpdir()>/stealth-browser-<uid>-<port>`. */
  stateDir?: string
  /** What the reaper may close: the port occupant (default) or only a Chrome it can prove it launched. */
  reaperScope?: 'launched-only' | 'port-occupant'
  /** The reaper seam. Default: the service-proxy reaper link of this port. */
  link?: ReaperLink
  /** Log function. Default: console.error */
  logger?: (msg: string) => void
}

export interface ChromeStatus {
  /** This manager has a verified, running Chrome. */
  ready: boolean
  /** This process launched the running Chrome. */
  owned: boolean
  /** Clients connected to the reaper (0 when it is unavailable). */
  processes: number
  /** Connected clients active within the idle window. */
  activeProcesses: number
  /** Open http(s) pages (`'unreachable'` when CDP did not answer). */
  httpPages: number | 'unreachable'
  /** The out-of-process reaper is connected (false = degraded). */
  reaper: boolean
  /** The launch circuit breaker. */
  breaker: { open: boolean; retryAfterMs?: number }
  /** Many sibling clients are connected (diagnostic only; never kills). */
  siblingWarning: boolean
}

const defaultLogger = (msg: string) => console.error(`[chrome-manager] ${msg}`)

/** A soft reap through the host answers within this bound, or the manager defers. */
export const REAP_IF_IDLE_TIMEOUT_MS = 3_000
/** At most one reconnect attempt per this interval from `bump()` / `withBrowser`. */
export const RECONNECT_MIN_INTERVAL_MS = 2_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    if (typeof t === 'object' && 'unref' in t) t.unref()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export class ChromeManager {
  private idle: IdleShutdown | null = null
  private _ready = false
  private owned = false
  private readonly cdpHost: string
  private readonly port: number
  private readonly idleTimeoutMs: number
  private readonly keepAlive: boolean
  private readonly entryPath: string | undefined
  private readonly userDataDir: string | undefined
  private readonly checkHistory: boolean
  private readonly shutdownGraceMs: number
  private readonly orphanWindowMs: number
  private readonly scope: ReaperScope
  private readonly stateDirOpt: string | undefined
  private readonly injectedLink: ReaperLink | undefined
  private readonly log: (msg: string) => void

  private state: StateDirResult | null = null
  private link: ReaperLink | null = null
  private ownership: OwnershipStore | null = null
  private breaker: LaunchBreaker | null = null
  private degradedWarned = false
  /** The last ensure failed and the one idle-fire retry has not been spent yet. */
  private ensureFailed = false
  private idleRetrySpent = false
  private lastReconnectAt = Number.NEGATIVE_INFINITY

  constructor(opts: ChromeManagerOptions = {}) {
    this.cdpHost = opts.cdpHost ?? '127.0.0.1:9222'
    this.port = portOf(this.cdpHost)
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000
    this.keepAlive = opts.keepAlive ?? false
    this.entryPath = opts.entryPath
    this.userDataDir = opts.userDataDir
    this.checkHistory = opts.checkHistory ?? true
    this.shutdownGraceMs = opts.shutdownGraceMs ?? 30_000
    this.orphanWindowMs = opts.orphanWindowMs ?? 30_000
    this.scope = opts.reaperScope ?? 'port-occupant'
    this.stateDirOpt = opts.stateDir
    this.injectedLink = opts.link
    this.log = opts.logger ?? defaultLogger
  }

  // ── Wiring (lazy: the constructor touches nothing) ─────────────────────────

  /** Resolve the private state dir once; an unsafe dir means degraded mode, never a throw. */
  private wire(): { state: StateDirResult; breaker: LaunchBreaker } {
    if (this.state && this.breaker) return { state: this.state, breaker: this.breaker }
    const state = resolveStateDir(this.port, this.stateDirOpt === undefined ? {} : { stateDir: this.stateDirOpt })
    this.state = state
    const dir = state.ok ? state.dir : undefined
    const breaker = createLaunchBreaker({ port: this.port, ...(dir ? { stateDir: dir } : {}), logger: this.log })
    this.breaker = breaker
    if (dir) this.ownership = createOwnershipStore({ stateDir: dir, port: this.port, logger: this.log })
    if (this.injectedLink) this.link = this.injectedLink
    else if (dir) {
      this.link = createProxyReaperLink({
        port: this.port,
        cdpHost: this.cdpHost,
        stateDir: dir,
        pid: process.pid,
        checkHistory: this.checkHistory,
        idleTimeoutMs: this.idleTimeoutMs,
        shutdownGraceMs: this.shutdownGraceMs,
        orphanWindowMs: this.orphanWindowMs,
        scope: this.scope,
        ...(this.entryPath === undefined ? {} : { entryPath: this.entryPath }),
        ...(this.userDataDir === undefined ? {} : { profileDir: this.userDataDir }),
        logger: this.log,
      })
    }
    return { state, breaker }
  }

  /** One warning for the whole degraded session. */
  private warnDegraded(err: LifecycleError): void {
    if (this.degradedWarned) return
    this.degradedWarned = true
    this.log(`warning: reaper unavailable, running degraded — idle Chrome will not be closed automatically (${err.message})`)
  }

  /** Ensure the reaper and hold the link. Never throws; false = degraded. */
  private async ensureLink(): Promise<boolean> {
    const st = this.wire().state
    if (!st.ok || !this.link) {
      this.ensureFailed = true
      this.warnDegraded(lifecycleErrors.reaperUnavailable(this.port, st.ok ? lifecycleError('REAPER_UNAVAILABLE', 'no reaper link') : st.error, st.dir))
      return false
    }
    if (this.link.isUp()) return true
    let ok = false
    try {
      ok = await this.link.ensureAndHello()
    } catch (e) {
      ok = false
      this.log(`reaper link failed: ${errorMessage(e)}`)
    }
    if (ok) {
      this.ensureFailed = false
      this.idleRetrySpent = false
      return true
    }
    this.ensureFailed = true
    let err: LifecycleError | null = null
    try {
      err = this.link.lastError()
    } catch {
      err = null
    }
    this.warnDegraded(err ?? lifecycleErrors.reaperUnavailable(this.port))
    return false
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Ensure Chrome is running. Starts it if not reachable.
   *
   *  Self-healing: `_ready` is NOT trusted blindly. Another process may have
   *  killed the SHARED Chrome while this process was idle, so when `_ready` is
   *  true we cheaply re-verify reachability (one GET to /json/version) and only
   *  take the fast path when Chrome is actually up. On the fast path windows
   *  are deliberately NOT re-hidden: a window revealed for a human stays visible. */
  async ready(): Promise<void> {
    this.wire()
    if (this._ready) {
      if (await isChromeReachable(this.cdpHost)) {
        // Fast path: no relaunch, no re-hide; this use of Chrome is genuine activity.
        await this.ensureLink()
        this.sendActivity()
        return
      }
      this.log('stale _ready — Chrome no longer reachable (killed by another process?); relaunching')
      this._ready = false
      this.owned = false
    }

    const { breaker } = this.wire()
    breaker.assertClosed()
    let launched: { pid: number | null; profileDir: string }
    try {
      launched = await ensureChromeRunning({ port: this.port, ...(this.userDataDir === undefined ? {} : { profileDir: this.userDataDir }) })
    } catch (err) {
      // A refusal to attach to somebody else's Chrome is not a failed launch: it must not feed the breaker, and its detail survives.
      if (isLifecycleError(err, 'LAUNCH_FAILED') && err.detail?.['reason'] === 'foreign-profile') throw err
      breaker.recordFailure()
      const msg = errorMessage(err)
      this.log(`Failed to ensure Chrome running: ${msg}`)
      throw isStartTimeout(err) ? lifecycleErrors.unreachableAfterLaunch(this.port, err) : lifecycleErrors.launchFailed(this.port, err)
    }
    breaker.recordSuccess()

    if (launched.pid !== null) {
      // This process spawned Chrome: record it (pid + start token) for the reaper.
      this.owned = true
      this.ownership?.write(launched.pid, launched.profileDir)
    }
    try {
      // hideAllWindows is best-effort today (it logs and swallows its own failures); this guard keeps a future
      // throwing implementation from leaving a visible window while the manager reports ready.
      // Hide ALL Chrome windows — prevents the default window from appearing on-screen
      // after auto-launch, even when Chrome ignores --window-position from saved state.
      // Only on this (launch) path: the fast path above never re-hides.
      await hideAllWindows(this.cdpHost)
    } catch (err) {
      this.log(`Failed to hide Chrome windows: ${errorMessage(err)}`)
      throw err
    }
    this._ready = true
    this.startIdleTimer()
    // We just had activity (a launch) — re-arm the idle window from now.
    this.idle?.reset()
    await this.ensureLink()
    this.sendActivity()
  }

  /** Real work happened: re-arm the idle timer and tell the reaper. Call after every CDP operation. */
  bump(): void {
    // `_ready` (not the timer): a keep-alive manager arms no timer but its work is still activity the reaper must see.
    if (!this._ready) return
    this.idle?.reset()
    if (this.link?.isUp()) {
      this.sendActivity()
      return
    }
    // The link is down: reconnect (rate-limited) if Chrome is reachable, then report this activity.
    const now = Date.now()
    if (now - this.lastReconnectAt < RECONNECT_MIN_INTERVAL_MS) return
    this.lastReconnectAt = now
    void (async () => {
      try {
        if (!(await isChromeReachable(this.cdpHost))) return
        if (await this.ensureLink()) this.sendActivity()
      } catch (e) {
        this.log(`reconnect failed: ${errorMessage(e)}`)
      }
    })()
  }

  /** Force immediate shutdown: ignores every safety tier; local (no reaper round-trip). */
  async shutdown(): Promise<void> {
    this.idle?.cancel()
    this.log('shutting down...')
    try {
      await closeAllPageTargets(this.cdpHost)
    } catch (err) {
      this.log(`Failed to close page targets during shutdown: ${errorMessage(err)}`)
    }
    try {
      await killChrome(this.port, ...(this.userDataDir === undefined ? [] : [{ profileDir: this.userDataDir }] as const))
    } catch (err) {
      this.log(`Failed to kill Chrome during shutdown: ${errorMessage(err)}`)
    }
    this.ownership?.remove()
    await this.release()
    this.resetAfterShutdown()
  }

  /**
   * SOFT shutdown: close Chrome only if it is genuinely idle — the reaper host
   * defers to a sibling client, an open http(s) page and recent history. Never
   * force-kills a Chrome another session or a human's captcha window is using.
   * Safe for process-exit paths.
   */
  async shutdownIfIdle(): Promise<void> {
    this.idle?.cancel()
    await this.softReap()
  }

  /** Leave the reaper registry (the process may live on; its next `ready()` re-registers). Never throws. */
  async release(): Promise<void> {
    if (!this.link) return
    try {
      await this.link.release()
    } catch (e) {
      this.log(`release failed: ${errorMessage(e)}`)
    }
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

  async status(): Promise<ChromeStatus> {
    const breaker = this.wire().breaker.state()
    let host = null
    try {
      host = this.link?.isUp() ? await this.link.status() : null
    } catch (e) {
      this.log(`reaper status failed: ${errorMessage(e)}`)
    }
    const httpPages = host ? host.httpPages : await countActiveWebPages(() => listPageTargetsOnly(this.cdpHost))
    return {
      ready: this._ready,
      owned: this.owned,
      processes: host?.clients ?? 0,
      activeProcesses: host?.activeClients ?? 0,
      httpPages,
      reaper: this.link?.isUp() ?? false,
      breaker,
      siblingWarning: host?.siblingWarning ?? false,
    }
  }

  // ── Activity and idle ──────────────────────────────────────────────────────

  /**
   * The ONE place `activity` is sent: genuine use of Chrome (`ready()`,
   * `bump()`, `withBrowser`) only. No deferral, tick or soft reap ever reaches
   * it (livelock protection). Fire-and-forget; never throws.
   */
  private sendActivity(): void {
    const link = this.link
    if (!link?.isUp()) return
    try {
      link.activity()
    } catch (e) {
      this.log(`activity not sent: ${errorMessage(e)}`)
    }
  }


  private startIdleTimer(): void {
    if (this.idle || this.keepAlive) return
    this.idle = new IdleShutdown({
      timeoutMs: this.idleTimeoutMs,
      logger: (m) => this.log(m),
      onShutdown: () => this.softReap(),
    })
  }

  /** Re-arm WITHOUT advertising activity (the deferral branch: livelock protection). */
  private rearmIdle(): void {
    this.idle?.reset()
  }

  /**
   * The soft path (idle fire, `shutdownIfIdle`): the host decides. Keep / wait /
   * no answer re-arm and write nothing; degraded never closes Chrome.
   */
  private async softReap(): Promise<void> {
    let link = this.link
    if (!link?.isUp()) {
      // One retry of a previously failed ensure, then fail-safe defer (D1).
      if (this.ensureFailed && !this.idleRetrySpent) {
        this.idleRetrySpent = true
        await this.ensureLink()
      }
      link = this.link
      if (!link?.isUp()) {
        this.log('reaper unavailable — not closing Chrome (cannot see sibling clients)')
        this.rearmIdle()
        return
      }
    }
    let out: ReapOutcome | null | 'timeout' = null
    try {
      out = await withTimeout(link.reapIfIdle(), REAP_IF_IDLE_TIMEOUT_MS)
    } catch (e) {
      this.log(`reapIfIdle failed: ${errorMessage(e)}`)
      out = null
    }
    if (out === 'timeout' || out === null) {
      this.rearmIdle()
      return
    }
    if (out.reaped) {
      this.log('reaper closed idle Chrome')
      this.resetAfterShutdown()
      return
    }
    if (out.action === 'keep') this.log(`Chrome in use (${out.pinnedBy ?? 'unknown'}) — deferring`)
    this.rearmIdle()
  }

  /** After a REAL shutdown the idle timer is spent and ready is false: a later ready() relaunches and arms a fresh timer. */
  private resetAfterShutdown(): void {
    this.idle?.cancel()
    this.idle = null
    this._ready = false
    this.owned = false
  }
}

