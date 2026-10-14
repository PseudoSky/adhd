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
import { performance } from 'node:perf_hooks';

import PQueue from 'p-queue';

import { DEFAULT_TOOL_CALL_CONCURRENCY } from '../interfaces.js';
import { assignGroups, type ToolSchedulingClass } from './tool-class.js';

/** What {@link IToolLimiter.mapOrdered} tells each call when it starts. */
export interface IOrderedCallMeta {
  /** Zero-based ordered execution group this call ran in (see `assignGroups`). */
  groupIndex: number;
  /**
   * Whole milliseconds from the `mapOrdered` call (turn dispatch) to this call starting: time spent
   * waiting for a concurrency slot or for an earlier barrier. 0 for a call that started at once.
   */
  queuedMs: number;
}

export interface IToolLimiter {
  /** Effective in-flight bound. */
  readonly concurrency: number;
  /**
   * Runs `fn` once a slot is free; the slot is held until `fn` settles. When `signal` aborts while
   * the call is still queued, `fn` is never invoked and the returned promise rejects with the
   * signal's reason (a cancelled task's queued bridge calls are dropped, not run with a dead
   * signal). A call already running is not interrupted here; its own client receives the signal,
   * and its slot (and the returned promise) stay held until `fn` settles, so the in-flight bound
   * holds across an abort.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Runs `fn` over `items` through the limiter and returns results in INPUT order. A throw (the
   * engine's fatal tool codes) rejects the whole map exactly as `Promise.all` does and drops calls
   * that have not started; calls already in flight run to completion. Ordinary tool failures are
   * caught inside `fn`, so they never cancel siblings.
   */
  map<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]>;
  /**
   * Like {@link IToolLimiter.map}, but honours each item's {@link ToolSchedulingClass} (R10 P1).
   * Ordering guarantee, deterministic and independent of timing:
   *  - a `barrier` item starts only after EVERY earlier `safe`/`barrier` item has settled, and
   *    every later `safe`/`barrier` item starts only after it has settled;
   *  - `safe` items between two barriers share the pool and run concurrently, up to
   *    `concurrency`;
   *  - an `unordered` item waits for nothing and nothing waits for it;
   *  - "settled" means resolved OR rejected, so a failed barrier never strands a later call;
   *  - results come back in INPUT order;
   *  - the first rejection (a fatal tool code) stops every call that has not started, exactly as
   *    `map` does; calls already in flight run to completion.
   * Waiting happens BEFORE a call enters the pool, so a waiting call never holds a slot and a
   * limiter with `concurrency: 1` cannot deadlock on its own ordering.
   */
  mapOrdered<T, R>(
    items: readonly T[],
    fn: (item: T, meta: IOrderedCallMeta) => Promise<R>,
    classOf: (item: T) => ToolSchedulingClass
  ): Promise<R[]>;
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
    run: <T>(fn: () => Promise<T>, signal?: AbortSignal) => {
      if (!signal) return pool.add(fn) as Promise<T>;
      if (signal.aborted) return Promise.reject(signal.reason);
      // The signal is deliberately NOT handed to p-queue: p-queue races a RUNNING operation against the
      // signal, so an abort would free the slot while `fn` is still executing and let in-flight calls
      // exceed the bound (cf7e0e5c review-4). Abort is handled here instead: a call still queued rejects
      // at once and never starts; a running call keeps its slot until `fn` itself settles.
      let started = false;
      const task = pool.add(async () => {
        signal.throwIfAborted();
        started = true;
        return fn();
      }) as Promise<T>;
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          if (!started) reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const done = () => signal.removeEventListener('abort', onAbort);
        task.then(
          (v) => { done(); resolve(v); },
          (e) => { done(); reject(e); }
        );
      });
    },
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
    mapOrdered: <T, R>(
      items: readonly T[],
      fn: (item: T, meta: IOrderedCallMeta) => Promise<R>,
      classOf: (item: T) => ToolSchedulingClass
    ) => {
      const dispatchedAt = performance.now();
      const classes = items.map(classOf);
      const groups = assignGroups(classes);
      // Same abort-from-inside-the-failing-task flag as `map` (a4235310 AC4).
      let failure: { err: unknown } | undefined;
      // Settle signals (never reject) of the ordered items seen so far, and of the latest barrier.
      let sinceBarrier: Array<Promise<void>> = [];
      let lastBarrier: Promise<void> | undefined;
      const results = items.map((item, i) => {
        const cls = classes[i];
        // unordered: waits for nothing; safe: waits for the latest barrier (which itself waited for
        // everything before it); barrier: waits for the latest barrier and every safe call since.
        const waitFor: Array<Promise<void>> = [];
        if (cls !== 'unordered' && lastBarrier) waitFor.push(lastBarrier);
        if (cls === 'barrier') waitFor.push(...sinceBarrier);
        const guarded = async (): Promise<R> => {
          if (failure) throw failure.err;
          try {
            return await fn(item, {
              groupIndex: groups[i],
              queuedMs: Math.max(0, Math.round(performance.now() - dispatchedAt)),
            });
          } catch (err) {
            failure ??= { err };
            throw err;
          }
        };
        const result = (waitFor.length === 0 ? Promise.resolve() : Promise.all(waitFor).then(() => undefined)).then(
          () => pool.add(guarded) as Promise<R>
        );
        const settled = result.then(
          () => undefined,
          () => undefined
        );
        if (cls === 'barrier') {
          lastBarrier = settled;
          sinceBarrier = [];
        } else if (cls === 'safe') {
          sinceBarrier.push(settled);
        }
        return result;
      });
      return Promise.all(results);
    },
  };
}
