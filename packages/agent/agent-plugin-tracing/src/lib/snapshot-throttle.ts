/** Injectable clock/timer/writer so the throttle is deterministic under test (no wall-clock sleeps). */
export interface SnapshotThrottleDeps {
  /** Persist one `metrics.snapshot` (activity) record. */
  write: () => Promise<unknown> | void;
  /** Minimum ms between two writes triggered by `request()`. Default {@link DEFAULT_SNAPSHOT_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Monotonic ms. Default `performance.now`. */
  now?: () => number;
  /** Schedule `fn` after `ms`; returns a cancel function. Default: an unref'd `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Default floor between activity snapshots written because of task terminals. */
export const DEFAULT_SNAPSHOT_MIN_INTERVAL_MS = 5000;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Leading-edge rate limiter with a trailing flush, for the `metrics.snapshot` writes a task
 * terminal requests. Without it every terminal of a busy host appends a snapshot record
 * (unbounded growth); with it the first terminal writes immediately, further terminals inside the
 * window collapse into one trailing write (timer, {@link flush} or {@link dispose}), so the final
 * counters are always eventually persisted. Never throws.
 */
export class SnapshotThrottle {
  private readonly min: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private last: number | undefined;
  private cancelTimer: (() => void) | undefined;
  private pending = false;

  constructor(private readonly deps: SnapshotThrottleDeps) {
    this.min = deps.minIntervalMs ?? DEFAULT_SNAPSHOT_MIN_INTERVAL_MS;
    this.now = deps.now ?? (() => performance.now());
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  /** A task terminal wants a snapshot: write now if the window is clear, else coalesce. */
  request(): void {
    const t = this.now();
    if (this.last === undefined || t - this.last >= this.min) {
      void this.fire();
      return;
    }
    if (this.pending) return;
    this.pending = true;
    this.cancelTimer = this.schedule(() => void this.fire(), this.min - (t - this.last));
  }

  /** Write a snapshot now (cancelling any coalesced one) and resolve when it has been written. */
  flush(): Promise<void> {
    return this.fire();
  }

  /** Write the coalesced snapshot if one is pending, then stop the timer. */
  dispose(): Promise<void> {
    if (this.pending) return this.fire();
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    return Promise.resolve();
  }

  /** True while requests are coalesced into a not-yet-written trailing snapshot. */
  get hasPending(): boolean {
    return this.pending;
  }

  private async fire(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = false;
    this.last = this.now();
    try {
      await this.deps.write();
    } catch {
      /* telemetry must never break a task */
    }
  }
}
