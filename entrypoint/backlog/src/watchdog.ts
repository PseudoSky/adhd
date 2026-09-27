/**
 * watchdog.ts — a hung-but-alive detector (D-A, Segment B).
 *
 * A frozen event loop cannot run its own timer to detect itself, so detection
 * is driven by a SEPARATE monitor (the `serve` supervisor, or the host process
 * manager): the serving loop calls {@link IWatchdog.tick} each interval, and
 * the monitor compares `lastTickAt`/`missedTicks` and fires `onHung` when
 * `>= maxMissedTicks` intervals pass with no tick. A hung-but-alive process is
 * a LIVENESS failure → restart.
 *
 * PLATFORM GAP, stated not papered over: macOS/launchd has no
 * `WatchdogSec`/`WATCHDOG=1` equivalent, so on macOS the supervisor is the
 * `serve` wrapper or the host; systemd hosts get the native watchdog.
 *
 * The timer is injectable so a test drives it with a virtual clock — never a
 * real sleep.
 */

export interface ITimer {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimer: ITimer = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface IWatchdog {
  /** The serving loop calls this each interval. */
  tick(): void;
  start(): void;
  stop(): void;
  /** Fired when >= maxMissedTicks intervals pass with no tick (frozen loop). */
  onHung(cb: (missedTicks: number) => void): void;
  lastTickAt(): string | undefined;
  missedTicks(): number;
}

export function createWatchdog(opts: {
  intervalMs: number;
  maxMissedTicks: number;
  timer?: ITimer;
}): IWatchdog {
  const timer = opts.timer ?? realTimer;
  let lastTick = timer.now();
  let started = false;
  let intervalHandle: unknown;
  let hung = false;
  const callbacks: Array<(missedTicks: number) => void> = [];

  const missed = (): number => {
    if (opts.intervalMs <= 0) return 0;
    return Math.floor((timer.now() - lastTick) / opts.intervalMs);
  };

  const check = (): void => {
    const m = missed();
    if (m >= opts.maxMissedTicks) {
      if (!hung) {
        hung = true;
        for (const cb of callbacks) cb(m);
      }
    }
  };

  return {
    tick: () => {
      lastTick = timer.now();
      hung = false;
    },
    start: () => {
      if (started) return;
      started = true;
      lastTick = timer.now();
      intervalHandle = timer.setInterval(check, opts.intervalMs);
    },
    stop: () => {
      if (!started) return;
      started = false;
      if (intervalHandle !== undefined) timer.clearInterval(intervalHandle);
      intervalHandle = undefined;
    },
    onHung: (cb) => {
      callbacks.push(cb);
    },
    lastTickAt: () =>
      Number.isFinite(lastTick) ? new Date(lastTick).toISOString() : undefined,
    missedTicks: missed,
  };
}
