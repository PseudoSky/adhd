/**
 * signal-cleanup.ts — BUG-BACKLOG-NO-SIGNAL-HANDLERS-001.
 *
 * `cli.ts`'s one-shot dispatch (`runBacklogCli`) and `server.ts`'s
 * long-lived listener (`startBacklogServer`) both acquire a store lease
 * early (inside `openGraphBacklogStore` → the store-adapter's `connect`)
 * and release it in a `finally` via `closeGraphBacklogStoreSafe` (cli.ts,
 * server.ts). Node's DEFAULT SIGINT/SIGTERM handling terminates the process
 * immediately — it does not run a `finally` suspended mid-`await` — and the
 * store open/every store operation is entirely async. So a Ctrl-C (or a
 * process-manager SIGTERM) landing anywhere in that window leaks the lease
 * and, if the open got far enough, its `.openmark`. An orphaned lease makes
 * the store look permanently BUSY to every quiescence-gated operation, for
 * every OTHER process, until manually cleared.
 *
 * This module installs a listener that:
 *   1. is IDEMPOTENT — a second SIGINT/SIGTERM while cleanup is already in
 *      flight is a no-op, not a re-entrant close;
 *   2. releases ONLY this connection's own lease/marker — `store` is a
 *      closure-captured value private to the caller's own open, so this can
 *      never touch a sibling connection's marker (the per-connection marker
 *      contract — BUG-019);
 *   3. NEVER swallows the signal — after cleanup it re-raises the
 *      conventional exit code Node's own default handler would have used
 *      (128 + signal number: 130 for SIGINT, 143 for SIGTERM), so a caller
 *      piping this process's exit code (a shell, a process supervisor) sees
 *      the same signal-terminated shape it would have without this handler.
 *
 * STATED LIMIT (be honest about what this does NOT close): SIGKILL cannot be
 * caught by any process, ever — by design, the OS gives the target zero
 * chance to run cleanup code. A native (Rust/N-API) panic inside the
 * store-adapter's own dependency chain can also abort the process outside
 * JS's signal-handling reach entirely. Both leave this exact same lease/
 * marker leak. This handler narrows the hole to "catchable, JS-reachable
 * termination" — it does not close it. The durable fix is crash-safe lease
 * invalidation on READ (i.e. a stale lease/marker is detected and cleared
 * the next time ANY process reads it, not relied on to be released by the
 * process that died) — that is owned by another agent in the sox-ecosystem
 * repo, not this package.
 */
import { constants as osConstants } from 'node:os';

const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type HandledSignal = (typeof HANDLED_SIGNALS)[number];

export interface SignalCleanupHandle {
  /** Removes the listeners this call installed (idempotent). Call from the
   *  owning function's own `finally` once its normal-path cleanup has run,
   *  so a signal arriving AFTER that point is not double-handled. */
  dispose: () => void;
}

/**
 * Installs SIGINT/SIGTERM handlers that run `cleanup()` at most once, then
 * exit with the conventional 128+signum code. `cleanup` is expected to be
 * `closeGraphBacklogStoreSafe`-shaped (never throws) but is wrapped so a
 * defect there can never suppress the exit or hang the process.
 *
 * @param cleanup Releases this connection's own store lease. Called with no
 *   arguments; capture whatever store handle it needs via closure — this
 *   lets callers install the handler BEFORE the store finishes opening
 *   (`cleanup` reads a `let store` that may still be `undefined` at signal
 *   time, in which case the underlying `closeGraphBacklogStoreSafe(undefined)`
 *   is a documented no-op).
 * @param onExit Test-only override for `process.exit` (never overridden in
 *   production) so a red→green test can observe "would have exited with N"
 *   without actually terminating the test runner's process.
 */
export function installSignalCleanup(
  cleanup: () => Promise<void>,
  onExit: (code: number) => void = (code) => process.exit(code)
): SignalCleanupHandle {
  let handled = false;
  const onSignal = (signal: HandledSignal): void => {
    if (handled) return; // idempotent — a second Ctrl-C mid-cleanup is a no-op, not re-entry
    handled = true;
    void cleanup()
      .catch((err) => {
        // cleanup() is closeGraphBacklogStoreSafe-shaped and documented to
        // never throw, but this handler must never let a defect there hang
        // the process mid-signal — log and proceed to the exit below either way.
        console.error(
          `backlog: signal cleanup failed (${signal}): ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        dispose();
        onExit(128 + osConstants.signals[signal]);
      });
  };
  const dispose = (): void => {
    for (const signal of HANDLED_SIGNALS) process.removeListener(signal, onSignal);
  };
  for (const signal of HANDLED_SIGNALS) process.on(signal, onSignal);
  return { dispose };
}

/**
 * True iff nothing on this process already listens for SIGINT/SIGTERM.
 * `startBacklogServer` uses this to avoid installing a SECOND, competing
 * handler when its caller (`serve.ts`'s `runServeCommand`) has already
 * registered its own SIGINT/SIGTERM → `AbortController.abort()` handling
 * BEFORE ever calling into this function — that existing handler already
 * overrides Node's default terminate-without-cleanup behaviour for the
 * entire async store-open window, and it drives a *graceful* drain (fastify/
 * MCP transport teardown via the aborted `signal`) that a second,
 * unconditional close+`process.exit` handler would race and potentially cut
 * short. Direct/embedded callers of `startBacklogServer` that do NOT go
 * through `serve.ts` have no such external coverage, so they get this
 * module's own handler instead.
 */
export function hasExternalSignalHandling(): boolean {
  return HANDLED_SIGNALS.some((signal) => process.listenerCount(signal) > 0);
}
