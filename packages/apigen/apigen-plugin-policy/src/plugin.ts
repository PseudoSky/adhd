import { ApiError } from '@adhd/apigen-base-errors';
import type { Call, UsePlugin } from '@adhd/apigen-engine-runtime';
import { loadDecider } from './load-decider.js';
import type {
  IPolicyAskHandler,
  IPolicyDecideRequest,
  IPolicyDecider,
  IPolicyDecision,
} from './ports.js';
import { createPluginState } from './state.js';

/** Where a failure happened; handed to `IPolicyLayerOptions.onError`. */
export type PolicyErrorPhase = 'load' | 'decide' | 'timeout' | 'shape' | 'merge';

/** Options for the policy Layer. */
export interface IPolicyLayerOptions {
  /** An object, or a module specifier / path exporting `createDecider(options)`. */
  readonly decider: IPolicyDecider | string;
  /** Options handed to `createDecider` when `decider` is a module reference. */
  readonly deciderOptions?: Readonly<Record<string, unknown>>;
  readonly ask?: IPolicyAskHandler;
  /**
   * Optional deadline for one decision, in milliseconds. Must be a finite
   * number greater than zero (anything else throws at construction). Expiry
   * denies (LP-11) and aborts the `AbortSignal` handed to `decide`.
   */
  readonly timeoutMs?: number;
  /**
   * Observes every fail-closed denial caused by an error. The client always
   * receives the generic denial; this is where the operator sees the cause.
   * Default: one stderr line naming the phase and error class (never argument
   * values). A throwing handler is ignored.
   */
  readonly onError?: (error: unknown, info: { phase: PolicyErrorPhase }) => void;
}

type Transport = IPolicyDecideRequest['transport'];
type Attributes = NonNullable<IPolicyDecideRequest['attributes']>;

/** Outcome of the decision phase; `next()` is only ever invoked on `allow`. */
type Verdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string };

const DENY_FAILED: Verdict = { kind: 'deny', reason: 'policy decision failed' };
const TRANSPORTS: readonly string[] = ['http', 'grpc', 'mcp', 'cli'];

/** Thrown by the deadline so the failure is classified as `timeout`. */
class PolicyTimeoutError extends Error {
  constructor() {
    super('policy decision timed out');
    this.name = 'PolicyTimeoutError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Throw when `timeoutMs` is present but not a finite number greater than zero.
 * Called at construction and at `--use` option capture, never per call.
 */
function assertTimeoutMs(timeoutMs: unknown): void {
  if (timeoutMs === undefined) return;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ApiError(
      'invalid_argument',
      'apigen-plugin-policy: timeoutMs must be a finite number greater than 0'
    );
  }
}

/**
 * Validate `envelope.attributes` (D-18). Only string, finite number and
 * string[] values are accepted; any other shape yields `undefined` (no
 * attributes). An own `__proto__` key rejects the whole object, and the result
 * has a null prototype built with `defineProperty`, so a key can never reach
 * `Object.prototype` or a prototype setter (L1).
 */
function readAttributes(envelope: Record<string, unknown>): Attributes | undefined {
  const raw = envelope['attributes'];
  if (!isPlainObject(raw)) return undefined;
  if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) return undefined;
  const out: Record<string, string | number | readonly string[]> = Object.create(null);
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    let value: string | number | readonly string[];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      value = v;
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      value = Object.freeze([...(v as string[])]);
    } else {
      return undefined;
    }
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return Object.freeze(out);
}

/**
 * Race `p` against a deadline; the timer is always cleared. On expiry the
 * controller is aborted (so the decider can stop work) and the race rejects
 * with a `PolicyTimeoutError`.
 */
function withDeadline<T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  controller: AbortController | undefined
): Promise<T> {
  if (timeoutMs === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new PolicyTimeoutError();
      controller?.abort(err);
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

function reasonOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Validate a decider's raw answer; `undefined` means malformed. */
function readDecision(raw: unknown): IPolicyDecision | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const d = raw as { decision?: unknown; set?: unknown; reason?: unknown };
  if (d.decision === 'allow') {
    if (d.set === undefined) return { decision: 'allow' };
    return isPlainObject(d.set) ? { decision: 'allow', set: d.set } : undefined;
  }
  if (d.decision === 'ask' || d.decision === 'deny') {
    const reason = reasonOf(d.reason);
    return reason === undefined
      ? { decision: d.decision }
      : { decision: d.decision, reason };
  }
  return undefined;
}

/** Default `onError`: one stderr line, phase and error class only. */
function defaultOnError(error: unknown, info: { phase: PolicyErrorPhase }): void {
  const name = error instanceof Error ? error.name : typeof error;
  process.stderr.write(`apigen-plugin-policy: ${info.phase} failure (${name}); call denied\n`);
}

/**
 * Merge a decider's `set` over the call's domain arguments. `defineProperty`,
 * not assignment: a `__proto__` key must become an own property, never reach
 * the prototype setter. A non-extensible target throws `ApiError('internal')`.
 */
function mergeSet(domainArgs: Record<string, unknown>, set: Readonly<Record<string, unknown>>): void {
  if (!Object.isExtensible(domainArgs)) {
    throw new ApiError('internal', 'apigen-plugin-policy: call arguments cannot be modified');
  }
  try {
    for (const key of Object.keys(set)) {
      Object.defineProperty(domainArgs, key, {
        value: set[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } catch {
    throw new ApiError('internal', 'apigen-plugin-policy: call arguments cannot be modified');
  }
}

/**
 * Build the policy Layer plugin (LP-06..LP-17). Per call: resolve the decider
 * once (a load failure is memoised, so every call is then denied), map the
 * transport, build the request (frozen shallow copies of the arguments and
 * envelope, so a decider cannot mutate the real call), race the decision
 * against `timeoutMs` (expiry aborts the signal given to `decide`), validate
 * the answer, then `allow` merges `set` over `call.domainArgs` and continues,
 * `ask` consults the ask handler, `deny` throws `ApiError('permission_denied')`.
 * Every failure mode denies (fail closed) and is reported to `onError`.
 * No state is held between calls (LP-13); streaming results pass through
 * untouched (LP-12).
 *
 * Ordering rule (LP-14): declare this layer AFTER any layer that writes
 * `call.envelope.attributes` (an auth layer), since it reads them there.
 *
 * @param options Decider, optional ask handler, decision deadline and error observer.
 * @throws ApiError('invalid_argument') when `timeoutMs` is not a finite number > 0.
 */
export function createPolicyLayerPlugin(options: IPolicyLayerOptions): UsePlugin {
  assertTimeoutMs(options.timeoutMs);
  const onError = options.onError ?? defaultOnError;
  const report = (error: unknown, phase: PolicyErrorPhase): void => {
    try {
      onError(error, { phase });
    } catch {
      // An observer must never change the outcome.
    }
  };
  let deciderPromise: Promise<IPolicyDecider> | undefined;
  const resolveDecider = (): Promise<IPolicyDecider> => {
    deciderPromise ??= loadDecider(
      options.decider,
      options.deciderOptions as Record<string, unknown> | undefined
    );
    return deciderPromise;
  };

  async function decideCall(call: Call): Promise<Verdict> {
    let phase: PolicyErrorPhase = 'load';
    try {
      const transport = call.transport as string;
      if (!TRANSPORTS.includes(transport)) {
        return { kind: 'deny', reason: 'unsupported transport' };
      }
      const envelope = call.envelope ?? {};
      const request: IPolicyDecideRequest = Object.freeze({
        tool: call.operation.id,
        args: Object.freeze({ ...call.domainArgs }),
        envelope: Object.freeze({ ...envelope }),
        transport: transport as Transport,
        attributes: readAttributes(envelope),
      });
      const decider = await resolveDecider();
      phase = 'decide';
      const controller =
        options.timeoutMs === undefined ? undefined : new AbortController();
      let signal = call.signal;
      if (controller !== undefined) {
        signal =
          call.signal === undefined
            ? controller.signal
            : AbortSignal.any([call.signal, controller.signal]);
      }
      const raw = await withDeadline(
        Promise.resolve(decider.decide(request, signal)),
        options.timeoutMs,
        controller
      );
      phase = 'shape';
      const decision = readDecision(raw);
      if (decision === undefined) {
        report(new Error('malformed decision'), 'shape');
        return DENY_FAILED;
      }
      if (decision.decision === 'allow') {
        phase = 'merge';
        if (decision.set !== undefined) mergeSet(call.domainArgs, decision.set);
        return { kind: 'allow' };
      }
      if (decision.decision === 'ask') {
        if (options.ask === undefined) {
          return { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
        }
        phase = 'decide';
        const answer = await options.ask.ask(request, decision.reason);
        return answer === 'allow-once'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
      }
      return { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
    } catch (error) {
      report(error, error instanceof PolicyTimeoutError ? 'timeout' : phase);
      return DENY_FAILED;
    }
  }

  return {
    id: 'policy',
    capabilities: {
      layer: {
        layer: async (rawCall, next) => {
          const verdict = await decideCall(rawCall as Call);
          if (verdict.kind === 'deny') {
            throw new ApiError('permission_denied', verdict.reason, { code: 'policy-denied' });
          }
          return next();
        },
      },
    },
  };
}

const state = createPluginState();
let cached: { options: object; plugin: UsePlugin } | undefined;

function delegate(): UsePlugin {
  const options = state.get();
  if (options?.decider === undefined) {
    throw new ApiError('internal', 'apigen-plugin-policy: no decider configured');
  }
  if (cached?.options !== options) {
    cached = { options, plugin: createPolicyLayerPlugin(options as IPolicyLayerOptions) };
  }
  return cached.plugin;
}

/**
 * Default export, loaded by `--use @adhd/apigen-plugin-policy`. A host hands
 * `--use` options only to `mount.operations` (D-14), so that capability
 * captures them and returns no operations; the `layer` capability then
 * delegates to a plugin built from the captured options. Without options the
 * layer throws `ApiError('internal')`, which fails the call (closed).
 *
 * One configuration per process: options are held in module scope, so every
 * mount in a process shares the most recently captured options, and a mount
 * that supplies none keeps them. Invalid options (`timeoutMs`) throw at capture.
 */
const plugin: UsePlugin = {
  id: 'policy',
  capabilities: {
    layer: {
      layer: async (call, next) => {
        const inner = delegate().capabilities?.layer?.layer;
        if (inner === undefined) {
          throw new ApiError('internal', 'apigen-plugin-policy: no decider configured');
        }
        return inner(call, next);
      },
    },
    mount: {
      operations: (_descriptor, opts) => {
        // A later mount (the host mounts once per transport/instance) that
        // carries no options must not erase the configuration already captured.
        if (opts === undefined || opts === null) return [];
        const captured = opts as Parameters<typeof state.set>[0];
        assertTimeoutMs(captured?.timeoutMs);
        state.set(captured);
        return [];
      },
    },
  },
};

export default plugin;
