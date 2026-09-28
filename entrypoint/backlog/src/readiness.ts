/**
 * readiness.ts — the serving-path readiness probe (D-A, Segment B).
 *
 * Ready IFF the SERVING path answers — NOT a ping and NOT a socket accept.
 * Drives a real trivial op through the SAME composed invoker the tools use
 * (`embedding-status`, which opens no write transaction and needs no semantic
 * backend). Returns a typed refusal on timeout; it never throws raw.
 *
 * The result is a plain object (`{ready, failure?}`), not a rejection, so a
 * caller (the lifecycle / a supervisor) can record a READINESS failure without
 * changing state and without a restart.
 */
import type { IServiceFailure } from './lifecycle.js';

export interface IReadinessTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimer: IReadinessTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The minimal composed-server surface the probe needs. */
export interface IReadinessHandle {
  pkg: {
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: () => Promise<unknown>;
  };
  operations: readonly { id: string }[];
  store: unknown;
}

export interface IReadinessProbeOpts {
  timeoutMs: number;
  /** Injectable one-shot timer so a test uses a virtual clock, never sleep. */
  timer?: IReadinessTimer;
  /** Test seam: the exact serving-path call to drive. */
  invoke?: () => Promise<unknown>;
}

export interface IReadinessResult {
  ready: boolean;
  failure?: IServiceFailure;
}

const PROBE_RE = /embedding[_-]?status$/i;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Builds the default probe: the mounted `embedding-status` op, invoked the
 *  way a transport invokes it (through the composed package's `fns`). */
function defaultInvoke(handle: IReadinessHandle): () => Promise<unknown> {
  return async () => {
    const fns = handle.pkg.fns;
    const op = handle.operations.find((o) => PROBE_RE.test(o.id));
    const leaf = op?.id.split('/').pop() ?? 'embedding-status';
    const name =
      [leaf, camel(leaf), 'embeddingStatus'].find(
        (candidate) => typeof fns[candidate] === 'function'
      ) ?? 'embeddingStatus';
    const fn = fns[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `readiness: no embedding-status operation is mounted (looked for ${name})`
      );
    }
    const ctx = await handle.pkg.createClient();
    return fn(ctx);
  };
}

/**
 * A healthy result is either a truthy non-envelope value, or an outcome
 * envelope with `ok:true`. An `ok:false` envelope is a READINESS failure named
 * with the envelope's own error code — the transport answered, but the serving
 * path did not.
 */
function classify(result: unknown): IReadinessResult {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const envelope = result as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    if (envelope.ok === true) return { ready: true };
    return {
      ready: false,
      failure: {
        kind: 'readiness',
        code: envelope.error?.code ?? 'probe_failed',
        message:
          envelope.error?.message ??
          'serving-path probe returned ok:false (transport answered, op did not)',
      },
    };
  }
  return { ready: true };
}

export async function probeReadiness(
  handle: IReadinessHandle,
  opts: IReadinessProbeOpts
): Promise<IReadinessResult> {
  const timer = opts.timer ?? realTimer;
  const invoke = opts.invoke ?? defaultInvoke(handle);

  let timeoutHandle: unknown;
  const timeout = new Promise<IReadinessResult>((resolve) => {
    timeoutHandle = timer.setTimeout(
      () =>
        resolve({
          ready: false,
          failure: {
            kind: 'readiness',
            code: 'probe_timeout',
            message: `serving-path probe did not answer within ${opts.timeoutMs}ms`,
          },
        }),
      opts.timeoutMs
    );
  });

  const attempted = invoke().then(
    (result) => classify(result),
    (err: unknown): IReadinessResult => ({
      ready: false,
      failure: {
        kind: 'readiness',
        code: 'probe_error',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  );

  const result = await Promise.race([attempted, timeout]);
  timer.clearTimeout(timeoutHandle);
  return result;
}
