/**
 * Deterministic "let the already-resolvable async work run" helper for latch-driven engine tests.
 *
 * Replaces the fixed `for (i < 20..50) await new Promise(r => setImmediate(r))` loops. Those loops
 * pay one event-loop turn per iteration regardless of whether anything is still moving, so under
 * machine load their wall time scales with the scheduler (metrics: the tests that used them ran
 * 10-40 ms median with 150-270 ms p95, the same file's loop-free tests 0.7-1 ms).
 *
 * This helper yields to the event loop (one `setImmediate` turn drains every pending microtask,
 * including chains that grow while draining) until `probe()` has returned an unchanged snapshot for
 * `quietHops` consecutive turns, or `maxHops` turns have passed. The engine, the registry and the
 * limiter under test schedule no timers and no I/O, so their promise chains are microtask-only and
 * are quiescent after the first turn; the extra quiet turns are margin, not a wait. No clock is read.
 *
 * Guard strength is unchanged: a negative assertion ("call 3 has NOT started") is still taken only
 * after the observed state has stopped changing across several event-loop turns.
 *
 * tier: S (no timers, no sockets, no clock). Item: qa-variance (dispatch-1014).
 */

export interface ISettleOptions {
  /** Consecutive turns the probe must return an identical snapshot (default 3). */
  quietHops?: number;
  /** Upper bound on event-loop turns before returning anyway (default 200, above the old 50). */
  maxHops?: number;
}

/**
 * Yields to the event loop until `probe()` is stable.
 * @param probe returns the observable state the caller is about to assert on (JSON-serialisable).
 * @returns the number of event-loop turns taken.
 */
export async function settleUntilStable(probe: () => unknown, opts: ISettleOptions = {}): Promise<number> {
  const quietHops = opts.quietHops ?? 3;
  const maxHops = opts.maxHops ?? 200;
  let previous = JSON.stringify(probe());
  let quiet = 0;
  let hops = 0;
  while (quiet < quietHops && hops < maxHops) {
    await new Promise<void>((r) => setImmediate(r));
    hops++;
    const current = JSON.stringify(probe());
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
  }
  return hops;
}
