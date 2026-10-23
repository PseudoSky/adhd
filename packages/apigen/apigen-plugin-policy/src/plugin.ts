import { ApiError } from '@adhd/apigen-base-errors';
import type { Call, Next, Plugin } from '@adhd/apigen-core-client';
import { PolicyAttributes } from './attributes.js';
import type {
  IPolicyAskHandler,
  IPolicyDecideRequest,
  IPolicyDecider,
  IPolicyDecision,
} from './ports.js';

/** Where a failure happened; handed to `IPolicyLayerOptions.onError`. */
export type PolicyErrorPhase = 'decide' | 'timeout' | 'shape' | 'merge';

/** Options for {@link makePolicyPlugin}. */
export interface IPolicyLayerOptions {
  /** Answers every authorization question. */
  readonly decider: IPolicyDecider;
  /** Resolves an `ask` decision; without one, `ask` denies. */
  readonly ask?: IPolicyAskHandler;
  /**
   * Optional deadline for one decision, in milliseconds. Must be a finite
   * number greater than zero (anything else throws at construction). Expiry
   * denies (LP-11) and aborts the `AbortSignal` handed to `decide`. A
   * `timeoutMs` in the options a host hands `createLayer` overrides it.
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

const TIMEOUT_MS_MESSAGE =
  'apigen-plugin-policy: timeoutMs must be a finite number greater than 0';

/** A decimal string as `--opt timeoutMs=<n>` delivers it; the value must still be > 0. */
const DECIMAL_PATTERN = '^[0-9]+(\\.[0-9]+)?$';
const DECIMAL = new RegExp(DECIMAL_PATTERN);

/**
 * JSON Schema for the options a host hands `createLayer`. The bag is the
 * invocation's whole flat `--opt` map, shared by every `--use` plugin, so
 * unknown keys are allowed and ignored. `--opt` delivers strings, so a decimal
 * string is accepted for `timeoutMs`; either form must be greater than 0.
 */
const OPTIONS_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  properties: {
    timeoutMs: {
      description:
        'Deadline for one decision, in milliseconds; greater than 0. Expiry denies the call.',
      anyOf: [
        { type: 'number', exclusiveMinimum: 0 },
        { type: 'string', pattern: DECIMAL_PATTERN },
      ],
    },
  },
});

/**
 * Validate a `timeoutMs` value against {@link OPTIONS_SCHEMA}: absent, a
 * finite number greater than 0, or a decimal string whose value is greater
 * than 0. Called at construction and in `createLayer`, never per call.
 *
 * @returns The value as a number, or `undefined` when absent.
 * @throws ApiError('invalid_argument') for any other value.
 */
function readTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  let value: number | undefined;
  if (typeof timeoutMs === 'number') value = timeoutMs;
  else if (typeof timeoutMs === 'string' && DECIMAL.test(timeoutMs)) value = Number(timeoutMs);
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new ApiError('invalid_argument', TIMEOUT_MS_MESSAGE);
  }
  return value;
}

/**
 * Validate the values of the call's {@link PolicyAttributes}. Only string,
 * finite number and string[] values are accepted; any other shape yields
 * `undefined` (no attributes). An own `__proto__` key rejects the whole
 * object, and the result has a null prototype built with `defineProperty`, so
 * a key can never reach `Object.prototype` or a prototype setter (L1).
 */
function readAttributes(raw: unknown): Attributes | undefined {
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

/** The layer function `createLayer` returns (SPEC §7.1). */
type PolicyLayer = (call: Call, next: Next) => Promise<unknown>;

/** Options for the policy plugin as a host hands them to `createLayer`. */
export interface IPolicyPluginOptions {
  /** Overrides the factory's `timeoutMs`; a decimal string (from `--opt`) is accepted. */
  readonly timeoutMs?: number;
}

/**
 * The refusal of an unconfigured plugin: every call is denied, and the reason
 * says how to supply a decider.
 */
const NO_DECIDER_REASON =
  'apigen-plugin-policy: no decider configured. Create a module whose default export is ' +
  "makePolicyPlugin({ decider }) (import { makePolicyPlugin } from '@adhd/apigen-plugin-policy') " +
  'and load that module with --use <module> instead of the bare package';

/**
 * Build the policy Layer for one configuration (LP-06..LP-17). Per call: map
 * the transport, build the request (frozen shallow copies of the arguments and
 * envelope, so a decider cannot mutate the real call; attributes from
 * `call.ctx.get(PolicyAttributes)`), race the decision against `timeoutMs`
 * (expiry aborts the signal given to `decide`), validate the answer, then
 * `allow` merges `set` over `call.data` and continues, `ask` consults the ask
 * handler, `deny` throws `ApiError('permission_denied')`. Every failure mode
 * denies (fail closed) and is reported to `onError`. No state is held between
 * calls (LP-13); streaming results pass through untouched (LP-12).
 */
function buildPolicyLayer(
  options: IPolicyLayerOptions,
  timeoutMs: number | undefined
): PolicyLayer {
  const decider = options.decider;
  const onError = options.onError ?? defaultOnError;
  const report = (error: unknown, phase: PolicyErrorPhase): void => {
    try {
      onError(error, { phase });
    } catch {
      // An observer must never change the outcome.
    }
  };

  async function decideCall(call: Call): Promise<Verdict> {
    let phase: PolicyErrorPhase = 'decide';
    try {
      const transport = call.transport as string;
      if (!TRANSPORTS.includes(transport)) {
        return { kind: 'deny', reason: 'unsupported transport' };
      }
      const envelope = call.envelope ?? {};
      const request: IPolicyDecideRequest = Object.freeze({
        tool: call.operation.id,
        args: Object.freeze({ ...call.data }),
        envelope: Object.freeze({ ...envelope }),
        transport: transport as Transport,
        attributes: readAttributes(call.ctx?.get(PolicyAttributes)?.values),
      });
      const controller = timeoutMs === undefined ? undefined : new AbortController();
      let signal = call.signal;
      if (controller !== undefined) {
        signal =
          call.signal === undefined
            ? controller.signal
            : AbortSignal.any([call.signal, controller.signal]);
      }
      const raw = await withDeadline(
        Promise.resolve(decider.decide(request, signal)),
        timeoutMs,
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
        if (decision.set !== undefined) mergeSet(call.data, decision.set);
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

  return async (call, next) => {
    const verdict = await decideCall(call);
    if (verdict.kind === 'deny') {
      throw new ApiError('permission_denied', verdict.reason, { code: 'policy-denied' });
    }
    return next();
  };
}

/** The Layer of a plugin made without a decider: refuses every call. */
const refuseUnconfigured: PolicyLayer = async () => {
  throw new ApiError('permission_denied', NO_DECIDER_REASON, { code: 'policy-not-configured' });
};

/**
 * Make a policy Layer plugin (adhd ADR-0019 D1). Each call returns an
 * independent plugin: nothing is held in module scope, so several
 * configurations in one process never affect each other.
 *
 * `capabilities.layer.createLayer(opts)` is called by the host once per
 * invocation with its flat options bag; it validates `opts.timeoutMs` against
 * `optionsSchema` (which then overrides `options.timeoutMs`) and returns the
 * Layer. Without `options` (or without a decider) the Layer refuses every
 * call with `ApiError('permission_denied')` whose reason says how to configure
 * a decider.
 *
 * Ordering rule (LP-14): declare this plugin AFTER any layer that writes
 * `PolicyAttributes` on `call.ctx` (an auth layer), since it reads them there.
 *
 * @example
 * ```ts
 * // policy.plugin.mjs, loaded with `--use ./policy.plugin.mjs`
 * import { makePolicyPlugin } from '@adhd/apigen-plugin-policy';
 * export default makePolicyPlugin({ decider: await createMyDecider(), timeoutMs: 5000 });
 * ```
 *
 * @param options Decider, optional ask handler, decision deadline and error observer.
 * @returns A plugin with id `policy`, an `optionsSchema` and a `layer.createLayer` capability.
 * @throws ApiError('invalid_argument') when `options.timeoutMs` is not a finite number > 0.
 */
export function makePolicyPlugin(options?: IPolicyLayerOptions): Plugin<IPolicyPluginOptions> {
  const baseTimeoutMs = readTimeoutMs(options?.timeoutMs);
  return {
    id: 'policy',
    description:
      'Layer plugin: gates every operation behind an authorization decision; fails closed.',
    language: 'ts',
    optionsSchema: OPTIONS_SCHEMA,
    capabilities: {
      layer: {
        createLayer: (opts: Record<string, unknown>) => {
          const timeoutMs = readTimeoutMs(opts?.['timeoutMs']) ?? baseTimeoutMs;
          if (options?.decider === undefined) return refuseUnconfigured;
          return buildPolicyLayer(options, timeoutMs);
        },
      },
    },
  };
}

/**
 * Default export, loaded by a bare `--use @adhd/apigen-plugin-policy`: a
 * plugin with no decider, so every call is refused with `permission_denied`
 * and a reason that says how to configure one. Configure a decider with
 * {@link makePolicyPlugin}.
 */
const policyPlugin: Plugin<IPolicyPluginOptions> = makePolicyPlugin();

export default policyPlugin;
