/**
 * `tool-limiter.ts` — the per-task tool-call concurrency limiter
 * (backlog ea8f6f92 G3; origin 35768ae8, a4235310 AC4).
 *
 * One limiter is created per task run, keyed on `EngineConfig.toolCallConcurrency`, and is shared
 * by BOTH tool-execution paths: the engine-native dispatch loop (`map`) and the claudecli loopback
 * bridge (`run`, one call per CLI `tools/call`). Same knob, same bound, so a provider that runs its
 * own tool loop (claudecli) cannot exceed `toolCallConcurrency` in flight.
 *
 * Deadlock freedom (D6): the limiter is per TASK. A bridged `task` call that spawns a child task
 * runs that child in its own `Orchestrator.run` with its own limiter, so a parent holding the
 * only slot never waits on a slot the child needs.
 *
 * Process-local state only; safe under concurrent processes.
 */
import PQueue from 'p-queue';

import { DEFAULT_TOOL_CALL_CONCURRENCY } from '../interfaces.js';

export interface IToolLimiter {
  /** Effective in-flight bound. */
  readonly concurrency: number;
  /** Runs `fn` once a slot is free; the slot is held until `fn` settles. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Runs `fn` over `items` through the limiter and returns results in INPUT order. A throw (the
   * engine's fatal tool codes) rejects the whole map exactly as `Promise.all` does and drops calls
   * that have not started; calls already in flight run to completion. Ordinary tool failures are
   * caught inside `fn`, so they never cancel siblings.
   */
  map<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]>;
}

/** `limit` falls back to {@link DEFAULT_TOOL_CALL_CONCURRENCY} when absent or not a positive integer. */
export function resolveToolCallConcurrency(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1
    ? limit
    : DEFAULT_TOOL_CALL_CONCURRENCY;
}

/** Creates a limiter bounded to `limit` calls in flight. */
export function createToolLimiter(limit: number | undefined): IToolLimiter {
  const concurrency = resolveToolCallConcurrency(limit);
  const pool = new PQueue({ concurrency });
  return {
    concurrency,
    run: <T>(fn: () => Promise<T>) => pool.add(fn) as Promise<T>,
    map: <T, R>(items: readonly T[], fn: (item: T) => Promise<R>) => {
      // Per-map abort flag set from INSIDE the failing task, before its slot frees, so the pool
      // cannot promote the next queued call first (a4235310 AC4). Not pool.clear(): the pool is
      // shared with bridged calls, and clearing would strand their promises forever.
      let failure: { err: unknown } | undefined;
      const guarded = async (item: T): Promise<R> => {
        if (failure) throw failure.err;
        try {
          return await fn(item);
        } catch (err) {
          failure ??= { err };
          throw err;
        }
      };
      return Promise.all(
        items.map((item) => pool.add(() => guarded(item)) as Promise<R>)
      );
    },
  };
}
