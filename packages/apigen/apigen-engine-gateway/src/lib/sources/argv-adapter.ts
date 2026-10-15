import { ApiError } from '@adhd/apigen-base-errors';
import { makeDeadlineExceededError, makeUnavailableError } from '../gateway';
import type { HostAdapter, HostRequest } from '../gateway';
import { argvBindingOf, createArgvInvoker, DEFAULT_ARGV_TIMEOUT_MS } from './argv-operation';
import { nodeProcessLauncher } from './process';
import type { IProcessLauncher } from './process';

/** The executable an argv adapter runs. */
export interface IArgvAdapterSpec {
  /** The command to run (name or path); the binding key is `bin:<base>` of it. */
  readonly command: string;
  /** Working directory used when a call carries no `cwd` of its own. */
  readonly cwd?: string;
}

/** Dependencies of {@link createArgvAdapter}. */
export interface IArgvAdapterDeps {
  /** Defaults to {@link nodeProcessLauncher}; a sandbox supplies a confining one. */
  readonly launcher?: IProcessLauncher;
  /** This adapter's own per-call deadline (default 120000 ms; `0` disables). */
  readonly timeoutMs?: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((a) => typeof a === 'string');
}

/**
 * Create the {@link HostAdapter} of one executable, registered with `createGateway` under the
 * binding key `bin:<base>` (the key `buildArgvOperation` stamps on the argv operation).
 *
 * Nothing starts until a call: `start()` only arms the adapter and `ready()` reports it. Each
 * `invoke(req, signal)` runs `command` once with `req.data.argv` as its arguments in
 * `req.data.cwd` (else `spec.cwd`) through the launcher and resolves with `{exitCode, stdout,
 * stderr}` (plus `signal` when a signal ended the process). `signal` cancels the call (the
 * process group gets SIGTERM, then SIGKILL after a grace); a call outliving `timeoutMs`
 * kills the process group the same way and rejects with `deadline_exceeded`; a command that
 * cannot be started rejects with `unavailable`. `stop()` kills every call still in flight.
 *
 * @param spec - The executable.
 * @param deps - Launcher and the adapter's own call timeout.
 */
export function createArgvAdapter(spec: IArgvAdapterSpec, deps: IArgvAdapterDeps = {}): HostAdapter {
  const host = argvBindingOf(spec.command);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ARGV_TIMEOUT_MS;
  // The adapter owns the deadline so a timeout is reported as `deadline_exceeded`, not as a
  // signalled exit; the invoker's own timer is therefore disabled.
  const invoker = createArgvInvoker(spec.command, deps.launcher ?? nodeProcessLauncher, { timeoutMs: 0 });
  const inflight = new Set<AbortController>();
  let started = false;

  return {
    host,
    hopCost: 1,

    async start() {
      started = true;
    },

    async ready() {
      return started;
    },

    async invoke(req: HostRequest, signal: AbortSignal) {
      if (!started) throw makeUnavailableError(host, req.operation.id, 'not started');
      const { argv, cwd } = req.data;
      const workdir = cwd ?? spec.cwd;
      if (!isStringArray(argv)) {
        throw new ApiError('invalid_argument', `${host}: argv must be an array of strings`);
      }
      if (typeof workdir !== 'string') {
        throw new ApiError('invalid_argument', `${host}: cwd must be a string`);
      }
      signal.throwIfAborted();

      const ctrl = new AbortController();
      inflight.add(ctrl);
      const onAbort = (): void => ctrl.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              ctrl.abort(new Error(`no result within ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      timer?.unref?.();
      try {
        const result = await invoker({ argv, cwd: workdir }, ctrl.signal);
        if (timedOut) throw makeDeadlineExceededError(host, req.operation.id, timeoutMs);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        inflight.delete(ctrl);
      }
    },

    onExit() {
      // Each call is its own process: there is no long-lived child that can crash.
      return () => undefined;
    },

    async stop() {
      started = false;
      for (const ctrl of inflight) ctrl.abort(new Error('adapter stopped'));
    },
  };
}
