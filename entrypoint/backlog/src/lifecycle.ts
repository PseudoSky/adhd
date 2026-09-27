/**
 * lifecycle.ts — the `starting / live / ready` trichotomy (D-A, Segment B).
 *
 * Exactly the three states DESIGN §2 D1 names. Failure/stop are transitions,
 * never states:
 *
 *   - `starting`: env resolved, store opening, the mount being composed (the
 *     ~14 s cold-start window), transports not yet accepting.
 *   - `live`: the transport accepts connections (stdio connected / socket bound).
 *   - `ready`: the serving-path probe (`readiness.ts`) has passed.
 *
 * A LIVENESS failure means RESTART; a READINESS failure is REPORT ONLY, state
 * unchanged, NO restart. {@link IServiceLifecycle.fail} records a failure
 * WITHOUT changing the state and returns the action the supervisor must take.
 */

export type IServiceState = 'starting' | 'live' | 'ready';

export interface IServiceFailure {
  kind: 'liveness' | 'readiness';
  code: string;
  message: string;
  subject?: string;
}

export interface IServiceReport {
  state: IServiceState;
  /** ISO timestamp the current state was entered. */
  since: string;
  /** Present on a failure. A liveness failure means RESTART; a readiness
   *  failure means REPORT ONLY, no restart. */
  failure?: IServiceFailure;
  lastTickAt?: string;
  degraded: boolean;
}

export interface IServiceLifecycle {
  state(): IServiceState;
  report(): IServiceReport;
  /** starting → live (transport accepting). */
  markLive(): void;
  /** live → ready (the serving-path probe passed). Idempotent. */
  markReady(): void;
  /** Record a failure WITHOUT changing the state; returns the supervisor action. */
  fail(f: IServiceFailure): { action: 'restart' | 'report' };
  whenReady(): Promise<void>;
}

export interface ILifecycleDeps {
  now?: () => number;
}

export function createLifecycle(
  deps: ILifecycleDeps = {}
): IServiceLifecycle {
  const now = deps.now ?? (() => Date.now());
  const iso = (): string => new Date(now()).toISOString();

  let state: IServiceState = 'starting';
  let since = iso();
  let failure: IServiceFailure | undefined;
  let lastTickAt: string | undefined;
  let readyResolve: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const transition = (next: IServiceState): void => {
    if (state === next) return;
    state = next;
    since = iso();
  };

  return {
    state: () => state,
    report: () => {
      const out: IServiceReport = {
        state,
        since,
        degraded: failure !== undefined,
      };
      if (failure !== undefined) out.failure = { ...failure };
      if (lastTickAt !== undefined) out.lastTickAt = lastTickAt;
      return out;
    },
    markLive: () => transition('live'),
    markReady: () => {
      transition('ready');
      readyResolve?.();
    },
    fail: (f: IServiceFailure) => {
      failure = { ...f };
      return { action: f.kind === 'liveness' ? 'restart' : 'report' };
    },
    whenReady: () => readyPromise,
  };
}
