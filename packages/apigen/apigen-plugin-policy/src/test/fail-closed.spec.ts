import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPolicyLayerPlugin } from '../index';
import type { IPolicyAskHandler, IPolicyDecider, IPolicyLayerOptions, PolicyErrorPhase } from '../index';
import { createHost, latch, refusal } from './helpers/harness';
import { realDecider, unloadableDecider } from './helpers/policies';

/** A distinctive value placed in the call arguments, envelope and error messages: it must never reach the client or stderr. */
const SECRET = 'canary-value-7f3a91';
const GENERIC = 'policy decision failed';

interface IObserved {
  readonly phase: PolicyErrorPhase;
  readonly error: unknown;
}

function build(decider: IPolicyDecider | string, extra: Partial<IPolicyLayerOptions> = {}) {
  const observed: IObserved[] = [];
  const plugin = createPolicyLayerPlugin({
    decider,
    onError: (error, info) => observed.push({ phase: info.phase, error }),
    ...extra,
  });
  return { host: createHost(plugin), observed };
}

const call = (host: ReturnType<typeof createHost>, extra: Record<string, unknown> = {}) =>
  host.invoke('files.read', { path: `/demo/${SECRET}` }, { envelope: { token: SECRET, attributes: { role: 'dev' } }, ...extra });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Feature: Safety-relevant failure paths - a decider that fails never allows', () => {
  it('@S8.1 @negative a decider that throws is refused with permission_denied and the operation never runs', async () => {
    const { host, observed } = build({
      decide: () => {
        throw new Error(`database password is ${SECRET}`);
      },
    });
    const error = await refusal(call(host));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
    expect(observed.map((o) => o.phase)).toEqual(['decide']);
  });

  it('@S8.1 @negative a decider that rejects, or rejects with a non-Error, is refused the same way', async () => {
    for (const reason of [new Error(SECRET), SECRET, undefined, { toString: () => SECRET }]) {
      const { host } = build({ decide: () => Promise.reject(reason) });
      const error = await refusal(call(host));
      expect(error.code).toBe('permission_denied');
      expect(error.message).toBe(GENERIC);
      expect(host.ran).toHaveLength(0);
    }
  });

  it('@S8.1 @negative a decider that never answers within the timeout is refused and the operation never runs', async () => {
    vi.useFakeTimers();
    const entered = latch();
    const { host, observed } = build(
      {
        decide: () => {
          entered.resolve();
          return new Promise(() => undefined);
        },
      },
      { timeoutMs: 50 }
    );
    const outcome = refusal(call(host));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(50);
    const error = await outcome;
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
    expect(observed.map((o) => o.phase)).toEqual(['timeout']);
  });

  it('@S8.1 @negative a decider that returns a malformed result is refused, for every malformed shape', async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'allow',
      42,
      [],
      {},
      { decision: 'maybe' },
      { decision: 'ALLOW' },
      { decision: 'allow', set: 'x' },
      { decision: 'allow', set: ['a'] },
      { decision: 'allow', set: null },
      { allow: true },
    ];
    for (const raw of malformed) {
      const { host, observed } = build({ decide: () => Promise.resolve(raw as never) });
      const error = await refusal(call(host));
      expect(error.code, JSON.stringify(raw)).toBe('permission_denied');
      expect(error.message, JSON.stringify(raw)).toBe(GENERIC);
      expect(host.ran, JSON.stringify(raw)).toHaveLength(0);
      expect(observed.map((o) => o.phase), JSON.stringify(raw)).toEqual(['shape']);
    }
  });

  it('@S8.1 @negative a decider that cannot be loaded refuses every call (load phase)', async () => {
    const { host, observed } = build(`./does-not-exist-${SECRET}.mjs`);
    for (let i = 0; i < 2; i += 1) {
      const error = await refusal(call(host));
      expect(error.code).toBe('permission_denied');
      expect(error.message).toBe(GENERIC);
    }
    expect(host.ran).toHaveLength(0);
    expect(observed.map((o) => o.phase)).toEqual(['load', 'load']);
  });

  it('@S8.1 @negative a module reference without createDecider, or with a decider-less result, is refused (load phase)', async () => {
    const { host, observed } = build('node:path');
    expect((await refusal(call(host))).message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
    expect(observed[0]?.phase).toBe('load');
    expect(String((observed[0]?.error as Error).message)).toContain('module has no createDecider export');
  });

  it('@S8.1 @negative an object that is not a decider is refused (load phase)', async () => {
    const { host, observed } = build({} as unknown as IPolicyDecider);
    expect((await refusal(call(host))).message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
    expect(observed.map((o) => o.phase)).toEqual(['load']);
  });

  it('@S8.1 @negative an unsupported transport is refused without consulting the decider', async () => {
    const decide = vi.fn();
    const { host } = build({ decide });
    const error = await refusal(call(host, { transport: 'carrier-pigeon' }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe('unsupported transport');
    expect(decide).not.toHaveBeenCalled();
    expect(host.ran).toHaveLength(0);
  });

  it('@S8.1 @negative an ask with no handler, a handler that throws, and a handler that declines are all refusals', async () => {
    const ask = { decide: () => Promise.resolve({ decision: 'ask', reason: 'needs a human' } as const) };
    const none = build(ask);
    const withoutHandler = await refusal(call(none.host));
    expect(withoutHandler.code).toBe('permission_denied');
    expect(withoutHandler.message).toBe('needs a human');

    const throwing: IPolicyAskHandler = { ask: () => Promise.reject(new Error(SECRET)) };
    const t = build(ask, { ask: throwing });
    const thrown = await refusal(call(t.host));
    expect(thrown.message).toBe(GENERIC);
    expect(t.observed.map((o) => o.phase)).toEqual(['decide']);

    const declining: IPolicyAskHandler = { ask: () => Promise.resolve('deny') };
    const d = build(ask, { ask: declining });
    expect((await refusal(call(d.host))).message).toBe('needs a human');

    // Anything other than the exact 'allow-once' is a denial.
    const sloppy: IPolicyAskHandler = { ask: () => Promise.resolve('allow' as never) };
    const s = build(ask, { ask: sloppy });
    expect((await refusal(call(s.host))).code).toBe('permission_denied');
    for (const h of [none.host, t.host, d.host, s.host]) expect(h.ran).toHaveLength(0);

    // Control: the handler that answers allow-once is the only way through.
    const allowing: IPolicyAskHandler = { ask: () => Promise.resolve('allow-once') };
    const a = build(ask, { ask: allowing });
    expect(await call(a.host)).toBe('read-ran');
  });

  it('@S8.1 @negative a policy that cannot be evaluated is refused by the real decider, and an allowing real policy still runs the operation', async () => {
    const bad = build(unloadableDecider());
    const error = await refusal(bad.host.invoke('files.read', { path: '/demo/a' }, {}));
    expect(error.code).toBe('permission_denied');
    expect(bad.host.ran).toHaveLength(0);

    const good = build(realDecider());
    expect(await good.host.invoke('files.read', { path: '/demo/shared/guide.md' }, { envelope: { attributes: { role: 'dev', read_roots: ['/demo/work'] } } })).toBe('read-ran');
  });

  it('@S8.1 @negative the client never sees argument values: not in the message, the code, the details or the cause', async () => {
    const failures: IPolicyDecider[] = [
      { decide: () => Promise.reject(new Error(`bad ${SECRET}`)) },
      { decide: () => Promise.resolve({ decision: 'nonsense', note: SECRET } as never) },
      { decide: () => Promise.resolve(SECRET as never) },
    ];
    for (const decider of failures) {
      const { host } = build(decider);
      const error = await refusal(call(host));
      const everything = JSON.stringify({ ...error, message: error.message, stack: error.stack?.split('\n')[0] });
      expect(everything).not.toContain(SECRET);
      expect(error.message).toBe(GENERIC);
    }
  });

  it('@S8.1 @negative the default observer writes exactly one stderr line naming the phase and error class, never a value', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const plugin = createPolicyLayerPlugin({
      decider: {
        decide: () => {
          throw new TypeError(`secret ${SECRET}`);
        },
      },
    });
    const host = createHost(plugin);
    await refusal(call(host));
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toBe('apigen-plugin-policy: decide failure (TypeError); call denied\n');
    expect(line).not.toContain(SECRET);
  });

  it('@S8.1 @negative an onError observer that throws changes nothing: the call is still refused', async () => {
    const plugin = createPolicyLayerPlugin({
      decider: { decide: () => Promise.reject(new Error('boom')) },
      onError: () => {
        throw new Error('observer exploded');
      },
    });
    const host = createHost(plugin);
    const error = await refusal(call(host));
    expect(error.message).toBe(GENERIC);
    expect(host.ran).toHaveLength(0);
  });
});

/** `<repo>/tmp/apigen-plugin-policy`: the gitignored scratch root this package's tests write under. */
const SCRATCH_ROOT = resolve(import.meta.dirname, '../../../../..', 'tmp', 'apigen-plugin-policy');

describe('Feature: A decider given as a module reference is loaded once and a broken module never allows', () => {
  async function withModule<T>(name: string, source: string, fn: (specifier: string, counter: { loads: number; options?: unknown }) => Promise<T>): Promise<T> {
    const dir = join(SCRATCH_ROOT, `${name}-${process.pid}`);
    await mkdir(dir, { recursive: true });
    const counter: { loads: number; options?: unknown } = { loads: 0 };
    (globalThis as Record<string, unknown>)['__policyLayerTest'] = counter;
    try {
      const file = join(dir, 'decider.mjs');
      await writeFile(file, source);
      return await fn(file, counter);
    } finally {
      delete (globalThis as Record<string, unknown>)['__policyLayerTest'];
      await rm(dir, { recursive: true, force: true });
      // Remove the scratch root once empty so an empty `tmp/apigen-plugin-policy` is not left behind (non-recursive: never removes anything else).
      await rmdir(SCRATCH_ROOT).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
    }
  }

  it('@S8.1 @happy createDecider runs once for many calls and receives deciderOptions', async () => {
    const source = `export function createDecider(options) {
      const state = globalThis.__policyLayerTest; state.loads += 1; state.options = options;
      return { decide: async () => ({ decision: 'allow' }) };
    }`;
    await withModule('once', source, async (specifier, counter) => {
      const host = createHost(createPolicyLayerPlugin({ decider: specifier, deciderOptions: { scope: 'x' } }));
      expect(await call(host)).toBe('read-ran');
      expect(await call(host)).toBe('read-ran');
      expect(await Promise.all([call(host), call(host)])).toEqual(['read-ran', 'read-ran']);
      expect(counter.loads).toBe(1);
      expect(counter.options).toEqual({ scope: 'x' });
    });
  });

  it('@S8.1 @negative a createDecider that throws is tried once and every call is refused', async () => {
    const source = `export function createDecider() {
      globalThis.__policyLayerTest.loads += 1;
      throw new Error('cannot start');
    }`;
    await withModule('broken', source, async (specifier, counter) => {
      const { host, observed } = build(specifier);
      for (let i = 0; i < 3; i += 1) expect((await refusal(call(host))).message).toBe(GENERIC);
      expect(host.ran).toHaveLength(0);
      expect(counter.loads).toBe(1);
      expect(observed.map((o) => o.phase)).toEqual(['load', 'load', 'load']);
    });
  });
});
