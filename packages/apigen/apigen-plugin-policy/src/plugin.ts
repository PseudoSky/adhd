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

/** Options for the policy Layer. */
export interface IPolicyLayerOptions {
  /** An object, or a module specifier / path exporting `createDecider(options)`. */
  readonly decider: IPolicyDecider | string;
  /** Options handed to `createDecider` when `decider` is a module reference. */
  readonly deciderOptions?: Readonly<Record<string, unknown>>;
  readonly ask?: IPolicyAskHandler;
  /** Optional deadline for one decision. Expiry denies (LP-11). */
  readonly timeoutMs?: number;
}

type Transport = IPolicyDecideRequest['transport'];
type Attributes = NonNullable<IPolicyDecideRequest['attributes']>;

/** Outcome of the decision phase; `next()` is only ever invoked on `allow`. */
type Verdict =
  | { readonly kind: 'allow'; readonly set?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'deny'; readonly reason: string };

const DENY_FAILED: Verdict = { kind: 'deny', reason: 'policy decision failed' };
const TRANSPORTS: readonly string[] = ['http', 'grpc', 'mcp', 'cli'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate `envelope.attributes` (D-18). Only string, finite number and
 * string[] values are accepted; any other shape yields `undefined` (no attributes).
 */
function readAttributes(envelope: Record<string, unknown>): Attributes | undefined {
  const raw = envelope['attributes'];
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string | number | readonly string[]> = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      out[key] = v;
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      out[key] = [...(v as string[])];
    } else {
      return undefined;
    }
  }
  return out;
}

/** Race `p` against a deadline; the timer is always cleared. */
function withDeadline<T>(p: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return p;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('policy decision timed out')), timeoutMs);
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

/**
 * Build the policy Layer plugin (LP-06..LP-17). Per call: resolve the decider
 * once (a load failure is memoised, so every call is then denied), map the
 * transport, build the request, race the decision against `timeoutMs`,
 * validate the answer, then `allow` merges `set` over `call.domainArgs` and
 * continues, `ask` consults the ask handler, `deny` throws
 * `ApiError('permission_denied')`. Every failure mode denies (fail closed).
 * No state is held between calls (LP-13); streaming results pass through
 * untouched (LP-12).
 *
 * Ordering rule (LP-14): declare this layer AFTER any layer that writes
 * `call.envelope.attributes` (an auth layer), since it reads them there.
 *
 * @param options Decider, optional ask handler and decision deadline.
 */
export function createPolicyLayerPlugin(options: IPolicyLayerOptions): UsePlugin {
  let deciderPromise: Promise<IPolicyDecider> | undefined;
  const resolveDecider = (): Promise<IPolicyDecider> => {
    deciderPromise ??= loadDecider(
      options.decider,
      options.deciderOptions as Record<string, unknown> | undefined
    );
    return deciderPromise;
  };

  async function decideCall(call: Call): Promise<Verdict> {
    try {
      const transport = call.transport as string;
      if (!TRANSPORTS.includes(transport)) {
        return { kind: 'deny', reason: 'unsupported transport' };
      }
      const envelope = call.envelope ?? {};
      const request: IPolicyDecideRequest = {
        tool: call.operation.id,
        args: call.domainArgs,
        envelope,
        transport: transport as Transport,
        attributes: readAttributes(envelope),
      };
      const decider = await resolveDecider();
      const raw = await withDeadline(
        Promise.resolve(decider.decide(request, call.signal)),
        options.timeoutMs
      );
      const decision = readDecision(raw);
      if (decision === undefined) return DENY_FAILED;
      if (decision.decision === 'allow') return { kind: 'allow', set: decision.set };
      if (decision.decision === 'ask') {
        if (options.ask === undefined) {
          return { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
        }
        const answer = await options.ask.ask(request, decision.reason);
        return answer === 'allow-once'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
      }
      return { kind: 'deny', reason: decision.reason ?? 'denied by policy' };
    } catch {
      return DENY_FAILED;
    }
  }

  return {
    id: 'policy',
    capabilities: {
      layer: {
        layer: async (rawCall, next) => {
          const call = rawCall as Call;
          const verdict = await decideCall(call);
          if (verdict.kind === 'deny') {
            throw new ApiError('permission_denied', verdict.reason, { code: 'policy-denied' });
          }
          if (verdict.set !== undefined) {
            for (const key of Object.keys(verdict.set)) {
              // defineProperty, not assignment: a `__proto__` key must become
              // an own property, never reach the prototype setter.
              Object.defineProperty(call.domainArgs, key, {
                value: verdict.set[key],
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
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
        state.set((opts ?? undefined) as Parameters<typeof state.set>[0]);
        return [];
      },
    },
  },
};

export default plugin;
