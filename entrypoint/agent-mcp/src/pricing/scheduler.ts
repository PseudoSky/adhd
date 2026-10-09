/**
 * 37f6c511 (FS2-AC9, FS2-AC17) — the in-server daily price-pull scheduler.
 *
 * A self-rescheduling `setTimeout` chain (never `setInterval`), every timer `unref()`'d so it can
 * never keep the process alive. On start it consults the pull ledger: a missing or >= 24h-old
 * success schedules one pull after `startDelayMs`; a fresh one schedules the next pull at
 * `last_ok + 24h`. Multi-process safety lives in `claimPull` (a restart storm or several servers on
 * one DB produce exactly one pull; the losers see `skipped`). `stop()` clears the timer and aborts an
 * in-flight pull, whose ledger row is closed `failed: aborted: shutdown`.
 *
 * Timers and clock are injected; there is no wall-clock dependence in tests.
 */
import {
  PULL_INTERVAL_MS,
  PULL_MIN_INTERVAL_MS,
  RUNNING_TTL_MS,
  runPricePull,
  type IPullDeps,
  type IPullResult,
} from './pull.js';
import { pricingOps } from './ops.js';

/** Delay before the start-up pull, so a fleet restart does not fire in the first instant. */
export const DEFAULT_START_DELAY_MS = 5_000;
/** Floor for a re-armed delay, so a skipped/instant result can never spin. */
const MIN_REARM_MS = 60_000;

export interface ITimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: ITimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ISchedulerOptions {
  timers?: ITimers;
  /** Cadence (default 24h). */
  intervalMs?: number;
  /** Delay before the start-up pull when the last success is stale (default 5s). */
  startDelayMs?: number;
  /** Observes every scheduled pull's outcome (tests, metrics). */
  onResult?: (result: IPullResult) => void;
}

export interface IPriceScheduler {
  /** Stop scheduling, clear the timer and abort an in-flight pull. Idempotent. */
  stop(): void;
  /** ISO instant of the next scheduled pull, or null when none is armed. */
  nextRunAt(): string | null;
  /** Resolves when no pull is in flight. */
  idle(): Promise<void>;
}

export function startPriceScheduler(deps: IPullDeps, options: ISchedulerOptions = {}): IPriceScheduler {
  const timers = options.timers ?? realTimers;
  const intervalMs = options.intervalMs ?? PULL_INTERVAL_MS;
  const startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
  const abort = new AbortController();
  let stopped = false;
  let handle: unknown;
  let nextAt: string | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const arm = (delayMs: number, why: string): void => {
    if (stopped) return;
    const ms = Math.max(0, Math.round(delayMs));
    nextAt = new Date(Date.parse(deps.now()) + ms).toISOString();
    handle = timers.setTimeout(tick, ms);
    pricingOps(deps.ops, 'pricing.scheduler.rearm', { delay_ms: ms, next_at: nextAt, why });
    (handle as { unref?: () => void } | null)?.unref?.();
  };

  /** Delay until the next attempt, given the pull that just ran. */
  const nextDelay = (result: IPullResult): number => {
    if (result.status === 'skipped' && result.reason === 'running') return Math.max(MIN_REARM_MS, RUNNING_TTL_MS);
    if (result.status === 'skipped' && result.reason === 'fresh') {
      const lastOk = deps.store.lastLedger(deps.now()).lastOk;
      if (lastOk) {
        return Math.max(MIN_REARM_MS, Date.parse(lastOk.startedAt) + PULL_MIN_INTERVAL_MS - Date.parse(deps.now()));
      }
    }
    return intervalMs;
  };

  function tick(): void {
    handle = undefined;
    nextAt = null;
    if (stopped) return;
    inFlight = (async () => {
      let delay = intervalMs;
      try {
        const result = await runPricePull({ ...deps, signal: abort.signal });
        options.onResult?.(result);
        delay = nextDelay(result);
      } catch (err) {
        // runPricePull never throws; this guards the ledger read in nextDelay.
        deps.logger.error({ err }, 'pricing: scheduler tick failed; will retry next cycle');
      }
      arm(delay, 'after_pull');
    })();
  }

  try {
    const lastOk = deps.store.lastLedger(deps.now()).lastOk;
    const dueIn = lastOk
      ? Date.parse(lastOk.startedAt) + intervalMs - Date.parse(deps.now())
      : 0;
    arm(dueIn > 0 ? dueIn : startDelayMs, dueIn > 0 ? 'last_ok_plus_interval' : 'startup_pull_due');
  } catch (err) {
    deps.logger.error({ err }, 'pricing: could not read the pull ledger; scheduling a start-up pull');
    arm(startDelayMs, 'ledger_unreadable');
  }

  return {
    stop(): void {
      if (!stopped) pricingOps(deps.ops, 'pricing.scheduler.stop', { had_timer: handle !== undefined });
      stopped = true;
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
      nextAt = null;
      abort.abort();
    },
    nextRunAt: () => nextAt,
    idle: () => inFlight,
  };
}
