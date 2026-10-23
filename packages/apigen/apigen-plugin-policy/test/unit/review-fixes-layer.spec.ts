// guards: A review finding in the policy Layer regresses: unsafe attribute reads, an unreported fail-closed phase, an unvalidated or unenforced timeoutMs, a decider that can alter the real call, or drifted package metadata.
// tier: S
// cites: review findings L1, L2, L5, L6, L7 (L4, the captured configuration, is replaced by make-policy-plugin.spec.ts) of the apigen-plugin-policy review.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePolicyPlugin } from '../../src/index';
import type { IPolicyDecideRequest, IPolicyDecider, IPolicyDecision, PolicyErrorPhase } from '../../src/index';
import { createHost, latch, refusal } from '../helpers/harness';
import { realDecider } from '../helpers/policies';

const GENERIC = 'policy decision failed';
const ALLOW = Promise.resolve({ decision: 'allow' } as IPolicyDecision);

/** Records the one request the decider sees, then answers `answer`. */
function spy(answer: IPolicyDecision | Promise<IPolicyDecision> = ALLOW) {
  const seen: { request?: IPolicyDecideRequest; signal?: AbortSignal } = {};
  const decider: IPolicyDecider = {
    decide: (request, signal) => {
      seen.request = request;
      seen.signal = signal;
      return Promise.resolve(answer);
    },
  };
  return { seen, decider };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Feature: L1 attributes are read safely', () => {
  it('@L1 @negative an own __proto__ key rejects the whole attributes object: the decider receives none', async () => {
    const hostile = JSON.parse('{"__proto__": {"role": "admin"}, "role": "dev"}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(hostile, '__proto__')).toBe(true);
    const { seen, decider } = spy();
    const host = createHost(makePolicyPlugin({ decider }));
    await host.invoke('files/read', { path: '/a' }, { attributes: hostile });
    expect(seen.request?.attributes).toBeUndefined();
    expect(({} as Record<string, unknown>)['role']).toBeUndefined();
  });

  it('@L1 @negative a scalar-valued own __proto__ key is rejected too, not stored as an attribute', async () => {
    for (const json of ['{"__proto__": "admin", "role": "dev"}', '{"role": "dev", "__proto__": ["x"]}', '{"role": "dev", "__proto__": 7}']) {
      const hostile = JSON.parse(json) as Record<string, unknown>;
      const { seen, decider } = spy();
      const host = createHost(makePolicyPlugin({ decider }));
      await host.invoke('files/read', { path: '/a' }, { attributes: hostile });
      expect(seen.request?.attributes, json).toBeUndefined();
    }
  });

  it('@L1 @negative through the real decider a hostile __proto__ attribute object is refused, as no attributes at all would be', async () => {
    const hostile = JSON.parse('{"__proto__": {"role": "dev"}, "role": "dev", "read_roots": ["/demo/work"]}') as Record<string, unknown>;
    const host = createHost(makePolicyPlugin({ decider: realDecider(), onError: () => undefined }));
    const error = await refusal(host.invoke('files/write', { path: '/demo/work/a.txt' }, { attributes: hostile }));
    expect(error.code).toBe('permission_denied');
    expect(host.ran).toHaveLength(0);
  });

  it('@L1 @happy accepted attributes are a frozen null-prototype copy that keeps keys such as constructor as plain data', async () => {
    const source = { role: 'dev', max_refund: 7, read_roots: ['/a', '/b'], constructor: 'bogus', toString: 'x' };
    const { seen, decider } = spy();
    const host = createHost(makePolicyPlugin({ decider }));
    await host.invoke('files/read', { path: '/a' }, { attributes: source });
    const attributes = seen.request?.attributes as Record<string, unknown>;
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(Object.isFrozen(attributes)).toBe(true);
    expect({ ...attributes }).toEqual(source);
    expect(attributes).not.toBe(source);
    expect(Object.isFrozen(attributes['read_roots'])).toBe(true);
    expect(attributes['read_roots']).not.toBe(source.read_roots);
  });

  it('@L1 @negative a value that is not a string, a finite number or a string list drops all attributes', async () => {
    const bad: unknown[] = [
      { role: { nested: 'x' } },
      { role: 'dev', n: Number.NaN },
      { role: 'dev', n: Number.POSITIVE_INFINITY },
      { role: 'dev', list: ['a', 1] },
      { role: 'dev', flag: true },
      { role: 'dev', gone: null },
      ['role'],
      'role=dev',
      null,
    ];
    for (const attributes of bad) {
      const { seen, decider } = spy();
      const host = createHost(makePolicyPlugin({ decider }));
      await host.invoke('files/read', { path: '/a' }, { attributes });
      expect(seen.request?.attributes, JSON.stringify(attributes)).toBeUndefined();
    }
  });
});

describe('Feature: L2 onError reports every fail-closed phase and the client still gets the generic message', () => {
  async function phaseOf(options: {
    decider: IPolicyDecider;
    timeoutMs?: number;
    arrange?: (go: () => Promise<unknown>, host: ReturnType<typeof createHost>) => Promise<unknown>;
    domainArgs?: Record<string, unknown>;
  }): Promise<{ phase: PolicyErrorPhase; error: unknown; refusalMessage: string; ran: number }> {
    const events: { phase: PolicyErrorPhase; error: unknown }[] = [];
    const host = createHost(
      makePolicyPlugin({
        decider: options.decider,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        onError: (error, info) => events.push({ phase: info.phase, error }),
      })
    );
    const go = () => host.invoke('files/write', options.domainArgs ?? { path: '/a' }, {});
    const outcome = refusal(options.arrange ? (options.arrange(go, host) as Promise<never>) : go());
    const error = await outcome;
    expect(events).toHaveLength(1);
    const [event] = events as [{ phase: PolicyErrorPhase; error: unknown }];
    return { ...event, refusalMessage: error.message, ran: host.ran.length };
  }

  it('@L2 @negative decide: a decider that throws, the original error is handed to the observer', async () => {
    const cause = new RangeError('decider blew up');
    const r = await phaseOf({ decider: { decide: () => Promise.reject(cause) } });
    expect(r.phase).toBe('decide');
    expect(r.error).toBe(cause);
    expect(r.refusalMessage).toBe(GENERIC);
    expect(r.ran).toBe(0);
  });

  it('@L2 @negative timeout: expiry is reported as timeout, not decide', async () => {
    vi.useFakeTimers();
    const entered = latch();
    const r = phaseOf({
      decider: { decide: () => (entered.resolve(), new Promise<never>(() => undefined)) },
      timeoutMs: 25,
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    const result = await r;
    expect(result.phase).toBe('timeout');
    expect((result.error as Error).name).toBe('PolicyTimeoutError');
    expect(result.refusalMessage).toBe(GENERIC);
    expect(result.ran).toBe(0);
  });

  it('@L2 @negative shape: a malformed answer', async () => {
    const r = await phaseOf({ decider: { decide: () => Promise.resolve({ decision: 'sure' } as never) } });
    expect(r.phase).toBe('shape');
    expect(r.refusalMessage).toBe(GENERIC);
    expect(r.ran).toBe(0);
  });

  it('@L2 @negative merge: a forced value that cannot be merged (frozen arguments)', async () => {
    const r = await phaseOf({
      decider: { decide: () => Promise.resolve({ decision: 'allow', set: { overwrite: false } }) },
      domainArgs: Object.freeze({ path: '/a' }),
    });
    expect(r.phase).toBe('merge');
    expect(r.refusalMessage).toBe(GENERIC);
    expect(r.ran).toBe(0);
  });

  it('@L2 @happy an allowed call reports nothing', async () => {
    const onError = vi.fn();
    const host = createHost(makePolicyPlugin({ decider: { decide: () => ALLOW }, onError }));
    expect(await host.invoke('files/read', { path: '/a' }, {})).toBe('read-ran');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('Feature: L5 timeoutMs is validated and a deadline aborts the decider', () => {
  it('@L5 @negative a timeoutMs that is not a finite number above zero is rejected at construction', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0', '-1', 'abc', '1e3', '', null, {}, true]) {
      let thrown: unknown;
      try {
        makePolicyPlugin({ decider: { decide: () => ALLOW }, timeoutMs: timeoutMs as never });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string }).code, String(timeoutMs)).toBe('invalid_argument');
      expect((thrown as Error).message).toContain('timeoutMs must be a finite number greater than 0');
    }
  });

  it('@L5 @happy a decimal string (what --opt delivers) is accepted at construction, like a small positive number or an omitted value', () => {
    expect(() => makePolicyPlugin({ decider: { decide: () => ALLOW }, timeoutMs: '10' as never })).not.toThrow();
    expect(() => makePolicyPlugin({ decider: { decide: () => ALLOW }, timeoutMs: 0.5 })).not.toThrow();
    expect(() => makePolicyPlugin({ decider: { decide: () => ALLOW } })).not.toThrow();
  });

  it('@L5 @negative the deadline aborts the signal handed to decide, denies, and the abort reason is the timeout', async () => {
    vi.useFakeTimers();
    const entered = latch<AbortSignal>();
    const aborted = latch<unknown>();
    const host = createHost(
      makePolicyPlugin({
        timeoutMs: 40,
        onError: () => undefined,
        decider: {
          decide: (_request, signal) => {
            signal?.addEventListener('abort', () => aborted.resolve(signal.reason), { once: true });
            entered.resolve(signal as AbortSignal);
            return new Promise<never>(() => undefined);
          },
        },
      })
    );
    const outcome = refusal(host.invoke('files/read', { path: '/a' }, {}));
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(signal.aborted).toBe(true);
    expect(((await aborted.promise) as Error).name).toBe('PolicyTimeoutError');
    const error = await outcome;
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
  });

  it('@L5 @edge a decision that arrives before the deadline allows the call and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const { seen, decider } = spy();
    const host = createHost(makePolicyPlugin({ decider, timeoutMs: 1000 }));
    expect(await host.invoke('files/read', { path: '/a' }, {})).toBe('read-ran');
    expect(vi.getTimerCount()).toBe(0);
    expect(seen.signal?.aborted).toBe(false);
  });

  it('@L5 @edge the caller signal still reaches the decider, with and without a deadline', async () => {
    const caller = new AbortController();
    const plain = spy();
    await createHost(makePolicyPlugin({ decider: plain.decider })).invoke('files/read', { path: '/a' }, { signal: caller.signal });
    expect(plain.seen.signal).toBe(caller.signal);

    const timed = spy();
    await createHost(makePolicyPlugin({ decider: timed.decider, timeoutMs: 1000 })).invoke('files/read', { path: '/a' }, { signal: caller.signal });
    expect(timed.seen.signal?.aborted).toBe(false);
    caller.abort();
    expect(timed.seen.signal?.aborted).toBe(true);
  });
});

describe('Feature: L6 the decider cannot change the real call', () => {
  it('@L6 @negative a decider that mutates its request changes neither the real arguments nor the envelope', async () => {
    const attempts: string[] = [];
    const decider: IPolicyDecider = {
      decide: (request) => {
        const mutable = request as unknown as { args: Record<string, unknown>; envelope: Record<string, unknown> };
        for (const [label, mutate] of [
          ['args.set', () => (mutable.args['injected'] = true)],
          ['args.overwrite', () => (mutable.args['path'] = '/etc/passwd')],
          ['args.delete', () => delete mutable.args['path']],
          ['envelope.set', () => (mutable.envelope['injected'] = true)],
          ['envelope.overwrite', () => (mutable.envelope['who'] = 'admin')],
        ] as const) {
          try {
            mutate();
            attempts.push(`${label}: accepted`);
          } catch {
            attempts.push(`${label}: rejected`);
          }
        }
        return ALLOW;
      },
    };
    const host = createHost(makePolicyPlugin({ decider }));
    const envelope = { who: 'alice' };
    expect(await host.invoke('files/read', { path: '/a' }, { envelope })).toBe('read-ran');
    expect(attempts.every((a) => a.endsWith('rejected'))).toBe(true);
    expect(envelope).toEqual({ who: 'alice' });
    expect(host.ran).toEqual([{ fn: 'files/read', args: ['/a'] }]);
  });

  it('@L6 @edge the decider is handed copies, not the call objects, and they are frozen', async () => {
    const { seen, decider } = spy();
    const domainArgs = { path: '/a' };
    const envelope = { who: 'alice' };
    await createHost(makePolicyPlugin({ decider })).invoke('files/read', domainArgs, { envelope });
    expect(seen.request?.args).toEqual(domainArgs);
    expect(seen.request?.args).not.toBe(domainArgs);
    expect(Object.isFrozen(seen.request?.args)).toBe(true);
    expect(seen.request?.envelope).not.toBe(envelope);
    expect(Object.isFrozen(seen.request?.envelope)).toBe(true);
    expect(Object.isFrozen(seen.request)).toBe(true);
  });

  it('@L6 @negative frozen arguments plus a forced value deny with the standard shape and the operation never runs', async () => {
    const host = createHost(
      makePolicyPlugin({ decider: { decide: () => Promise.resolve({ decision: 'allow', set: { overwrite: false } }) }, onError: () => undefined })
    );
    const error = await refusal(host.invoke('files/write', Object.freeze({ path: '/a' }), {}));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
  });

  it('@L6 @edge sealed and non-extensible arguments deny the same way; a forced value on plain arguments is merged', async () => {
    const make = () => createHost(makePolicyPlugin({ decider: { decide: () => Promise.resolve({ decision: 'allow', set: { overwrite: false } }) }, onError: () => undefined }));
    const sealedHost = make();
    expect((await refusal(sealedHost.invoke('files/write', Object.preventExtensions({ path: '/a' }), {}))).message).toBe(GENERIC);
    expect(sealedHost.ran).toHaveLength(0);

    const plain = make();
    expect(await plain.invoke('files/write', { path: '/a', overwrite: true }, {})).toBe('write-ran');
    expect(plain.ran).toEqual([{ fn: 'files/write', args: ['/a', false] }]);
  });

  it('@L6 @negative a forced value keyed __proto__ becomes an own property and never reaches the prototype', async () => {
    const set = JSON.parse('{"__proto__": {"polluted": true}, "overwrite": false}') as Record<string, unknown>;
    const host = createHost(makePolicyPlugin({ decider: { decide: () => Promise.resolve({ decision: 'allow', set }) } }));
    const domainArgs: Record<string, unknown> = { path: '/a' };
    expect(await host.invoke('files/write', domainArgs, {})).toBe('write-ran');
    expect(Object.getPrototypeOf(domainArgs)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(domainArgs, '__proto__')).toBe(true);
    expect(domainArgs['overwrite']).toBe(false);
  });
});

describe('Feature: L7 package metadata mirrors sibling plugins', () => {
  const root = join(import.meta.dirname, '..', '..');

  it('@L7 @happy package.json points main and types at dist, ships dist, and (CommonJS-only re-emit, X1) declares no ESM exports map', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      main: string;
      types: string;
      files: string[];
      type?: string;
      exports?: unknown;
    };
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.files).toContain('dist');
    expect(pkg.type).not.toBe('module');
  });

  it('@L7 @happy the vitest config runs the tests in the node environment', () => {
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toMatch(/environment:\s*'node'/);
  });
});
