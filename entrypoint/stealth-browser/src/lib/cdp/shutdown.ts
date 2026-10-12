/**
 * @adhd/stealth-browser — src/lib/cdp/shutdown.ts
 *
 * Idle-based auto-shutdown for Chrome browser sessions.
 *
 * Starts a timer when created. Resets on each "activity" signal.
 * If the timer expires (no activity for `timeoutMs`), triggers
 * shutdown: closes all page targets, optionally kills the browser.
 *
 * This prevents Chrome instances from accumulating when an agent
 * forgets to clean up, or when a session ends abnormally.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface IdleShutdownOptions {
  /** Idle timeout in ms. Default 120_000 (2 minutes). */
  timeoutMs?: number
  /** Called when idle timeout expires. */
  onShutdown?: () => Promise<void>
  /** If true, also shut down Chrome (not just close targets). Default false. */
  shutDownChrome?: boolean
  /** Log function for diagnostics. */
  logger?: (msg: string) => void
}

// ─── Idle Shutdown ─────────────────────────────────────────────────────────────

export class IdleShutdown {
  private timer: ReturnType<typeof setTimeout> | null = null
  private _fired = false
  private readonly timeoutMs: number
  private readonly onShutdown?: () => Promise<void>
  private readonly logger?: (msg: string) => void

  constructor(opts: IdleShutdownOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000
    this.onShutdown = opts.onShutdown
    this.logger = opts.logger
    this.reset()
  }

  /** Reset the idle timer (call this on every CDP activity).
   *
   *  Re-arms even AFTER a fire: once an idle shutdown has run and the browser
   *  is later relaunched (e.g. ChromeManager.ready() after another process
   *  killed shared Chrome), a fresh idle window must be armed. Previously a
   *  fired timer could never re-arm, so a relaunched browser was never
   *  auto-shut-down again. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this._fired = false
    this.timer = setTimeout(() => this.fire(), this.timeoutMs)
    // Allow Node to exit even if this timer is pending
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  /** Stop the timer without firing. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Whether the shutdown has already fired. */
  get fired(): boolean {
    return this._fired
  }

  private async fire(): Promise<void> {
    this._fired = true
    this.timer = null
    this.logger?.(`[idle-shutdown] no activity for ${this.timeoutMs}ms — shutting down`)
    try {
      await this.onShutdown?.()
    } catch (e) {
      this.logger?.(`[idle-shutdown] error: ${(e as Error).message}`)
    }
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Create an IdleShutdown that closes all page targets after inactivity.
 * This is the most common use case: close browser tabs, keep Chrome running.
 *
 * @param closeTargets A function that closes all open page targets.
 * @param opts Optional overrides.
 */
export function createPageTargetIdleShutdown(
  closeTargets: () => Promise<void>,
  opts: IdleShutdownOptions = {},
): IdleShutdown {
  return new IdleShutdown({
    timeoutMs: opts.timeoutMs ?? 120_000,
    logger: opts.logger,
    onShutdown: async () => {
      await closeTargets()
      if (opts.shutDownChrome) {
        await opts.onShutdown?.()
      }
    },
  })
}
