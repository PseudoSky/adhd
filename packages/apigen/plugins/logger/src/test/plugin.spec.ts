import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loggerPlugin, makeLoggerPlugin, Logger } from '../lib/plugin';
import type { Call, Next, Extensions, Operation } from '@adhd/apigen-core';

// ---------------------------------------------------------------------------
// Helpers — build a minimal Call with a real Extensions map so we can
// inspect ctx insertions without mocking the Layer contract.
// ---------------------------------------------------------------------------

class FakeExtensions implements Extensions {
  private readonly _map = new Map<unknown, unknown>();

  get<T>(key: abstract new (...args: never[]) => T): T | undefined {
    return this._map.get(key) as T | undefined;
  }

  set<T>(key: abstract new (...args: never[]) => T, value: T): void {
    this._map.set(key, value);
  }
}

function makeOperation(id = 'testOp'): Operation {
  return {
    id,
    host: 'ts',
    namespace: 'test',
    path: [],
    kind: 'query',
    async: false,
    streaming: false,
    transports: ['http'],
    input: {},
    output: { type: 'object' },
    envelope: {},
  };
}

function makeCall(opId = 'testOp'): Call {
  return {
    operation: makeOperation(opId),
    data: {},
    envelope: {},
    ctx: new FakeExtensions(),
    transport: 'http',
    signal: new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// Spy logger — captures log calls without actually writing to stderr.
// ---------------------------------------------------------------------------

function makeSpyLogger(): {
  logger: Logger;
  calls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
} {
  const calls: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const fakePino = {
    info:  (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'info',  obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'error', obj, msg }),
    debug: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'debug', obj, msg }),
    warn:  (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'warn',  obj, msg }),
    child: (_bindings: Record<string, unknown>) => ({
      info:  (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'info',  obj, msg }),
      error: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'error', obj, msg }),
      debug: (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'debug', obj, msg }),
      warn:  (obj: Record<string, unknown>, msg: string) => calls.push({ level: 'warn',  obj, msg }),
      child: () => fakePino,
    }),
  };

  // Force-cast: Logger only exposes info/error/debug/warn + .pino getter.
  // We inject a compatible pino-shaped object.
  const logger = new Logger(fakePino as unknown as import('pino').Logger);
  return { logger, calls };
}

// ---------------------------------------------------------------------------
// §1 — Plugin shape: id, capabilities
// ---------------------------------------------------------------------------

describe('loggerPlugin — v2 shape', () => {
  it('has id "logger"', () => {
    expect(loggerPlugin.id).toBe('logger');
  });

  it('has a string description', () => {
    expect(typeof loggerPlugin.description).toBe('string');
    expect(loggerPlugin.description!.length).toBeGreaterThan(0);
  });

  it('capabilities is a non-null object', () => {
    expect(loggerPlugin.capabilities).toBeDefined();
    expect(typeof loggerPlugin.capabilities).toBe('object');
    expect(loggerPlugin.capabilities).not.toBeNull();
  });

  it('declares a valid layer capability with a layer() function', () => {
    const { layer } = loggerPlugin.capabilities;
    expect(layer).toBeDefined();
    expect(typeof layer!.layer).toBe('function');
  });

  it('declares a target capability with name "logger" and a generate() function', () => {
    const { target } = loggerPlugin.capabilities;
    expect(target).toBeDefined();
    expect(target!.name).toBe('logger');
    expect(typeof target!.generate).toBe('function');
  });

  it('target.serve is undefined (generate-only plugin)', () => {
    expect(loggerPlugin.capabilities.target!.serve).toBeUndefined();
  });

  it('target.generate returns an empty File array (no codegen for a layer plugin)', () => {
    const result = loggerPlugin.capabilities.target!.generate(
      { operations: [], host: 'ts', namespace: 'test' },
      {},
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2 — Layer wraps an operation: logs entry, calls next(), logs exit
// ---------------------------------------------------------------------------

describe('layer — wraps an operation (logs around it, delegates via next())', () => {
  it('calls next() exactly once for a unary op', async () => {
    const call = makeCall();
    const next = vi.fn<Next>().mockResolvedValue('result');
    const { layer } = loggerPlugin.capabilities;
    await layer!.layer(call, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns the value from next() unchanged', async () => {
    const call = makeCall();
    const sentinel = { answer: 42 };
    const next: Next = vi.fn().mockResolvedValue(sentinel);
    const { layer } = loggerPlugin.capabilities;
    const result = await layer!.layer(call, next);
    expect(result).toBe(sentinel);
  });

  it('seeds Logger into call.ctx before calling next()', async () => {
    const call = makeCall();
    let seenInNext: Logger | undefined;
    const next: Next = vi.fn(async () => {
      seenInNext = call.ctx.get(Logger);
      return 'ok';
    });
    const { layer } = loggerPlugin.capabilities;
    await layer!.layer(call, next);
    expect(seenInNext).toBeInstanceOf(Logger);
  });

  it('logs entry (→) before invoking next()', async () => {
    const { logger, calls } = makeSpyLogger();
    const call = makeCall('pingOp');
    // Pre-seed the spy logger so we capture all log calls.
    call.ctx.set(Logger, logger);

    let entryLogged = false;
    const next: Next = vi.fn(async () => {
      // At the moment next() is called, an entry log must already exist.
      entryLogged = calls.some((c) => c.msg.includes('→') && c.msg.includes('pingOp'));
      return 'ok';
    });

    const plugin = makeLoggerPlugin({});
    await plugin.capabilities.layer!.layer(call, next);

    expect(entryLogged).toBe(true);
  });

  it('logs exit (←) after next() resolves', async () => {
    const { logger, calls } = makeSpyLogger();
    const call = makeCall('queryOp');
    call.ctx.set(Logger, logger);

    const next: Next = vi.fn().mockResolvedValue('done');
    const plugin = makeLoggerPlugin({});
    await plugin.capabilities.layer!.layer(call, next);

    const exitLog = calls.find((c) => c.msg.includes('←') && c.msg.includes('queryOp'));
    expect(exitLog).toBeDefined();
    expect(exitLog!.level).toBe('info');
    expect(typeof exitLog!.obj['ms']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// §3 — Error propagation: layer does NOT swallow errors (§8.1 rule 2)
// ---------------------------------------------------------------------------

describe('layer — error propagation', () => {
  it('re-throws errors from next() — error propagates outward', async () => {
    const call = makeCall();
    const boom = new Error('downstream failure');
    const next: Next = vi.fn().mockRejectedValue(boom);
    const { layer } = loggerPlugin.capabilities;
    await expect(layer!.layer(call, next)).rejects.toThrow('downstream failure');
  });

  it('logs the error before re-throwing', async () => {
    const { logger, calls } = makeSpyLogger();
    const call = makeCall('failOp');
    call.ctx.set(Logger, logger);

    const boom = new Error('oops');
    const next: Next = vi.fn().mockRejectedValue(boom);
    const plugin = makeLoggerPlugin({});

    await expect(plugin.capabilities.layer!.layer(call, next)).rejects.toThrow('oops');

    const errorLog = calls.find((c) => c.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog!.obj['err']).toBe(boom);
    expect(errorLog!.msg).toContain('failOp');
  });

  it('preserves the original error identity (no wrapping)', async () => {
    const call = makeCall();
    class DomainError extends Error {
      code = 'NOT_FOUND';
    }
    const original = new DomainError('not found');
    const next: Next = vi.fn().mockRejectedValue(original);
    const { layer } = loggerPlugin.capabilities;

    let caught: unknown;
    try {
      await layer!.layer(call, next);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original); // same reference, not a re-wrapped copy
    expect((caught as DomainError).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// §4 — Streaming support: layer is stream-lifecycle aware (SPEC §11)
// ---------------------------------------------------------------------------

describe('layer — stream-lifecycle (§11)', () => {
  /** Build a next() that returns an async iterable of the given chunks. */
  function streamNext(chunks: unknown[]): Next {
    return vi.fn((): AsyncIterable<unknown> => {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    });
  }

  it('delegates a streaming response transparently — yields all chunks', async () => {
    const call = makeCall('streamOp');
    const next = streamNext([1, 2, 3]);
    const { layer } = loggerPlugin.capabilities;

    const result = layer!.layer(call, next);

    // The layer must return an AsyncIterable for a streaming next().
    expect(
      result !== null &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object),
    ).toBe(true);

    const collected: unknown[] = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      collected.push(chunk);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  it('propagates streaming errors outward without swallowing (§8.1 rule 2)', async () => {
    const call = makeCall('failStream');
    const boom = new Error('stream blew up');
    const next: Next = vi.fn((): AsyncIterable<unknown> => {
      return (async function* () {
        yield 'first';
        throw boom;
      })();
    });

    const { layer } = loggerPlugin.capabilities;
    const result = layer!.layer(call, next) as AsyncIterable<unknown>;

    const iterator = result[Symbol.asyncIterator]();
    await iterator.next(); // consume 'first'
    await expect(iterator.next()).rejects.toThrow('stream blew up');
  });

  it('logs an error entry when a stream throws', async () => {
    const { logger, calls } = makeSpyLogger();
    const call = makeCall('errorStream');
    call.ctx.set(Logger, logger);

    const next: Next = vi.fn((): AsyncIterable<unknown> => {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              return Promise.reject(new Error('stream error'));
            },
          };
        },
      };
    });

    const plugin = makeLoggerPlugin({});
    const result = plugin.capabilities.layer!.layer(call, next) as AsyncIterable<unknown>;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of result) {
        // consume
      }
    } catch {
      // expected
    }

    const errorLog = calls.find((c) => c.level === 'error');
    expect(errorLog).toBeDefined();
    expect(errorLog!.msg).toContain('errorStream');
  });

  it('logs stream end (ok) after all chunks are consumed', async () => {
    const { logger, calls } = makeSpyLogger();
    const call = makeCall('completeStream');
    call.ctx.set(Logger, logger);

    const next = streamNext(['a', 'b']);
    const plugin = makeLoggerPlugin({});
    const result = plugin.capabilities.layer!.layer(call, next) as AsyncIterable<unknown>;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of result) {
      // drain
    }

    const exitLog = calls.find((c) => c.msg.includes('←') && c.msg.includes('ok'));
    expect(exitLog).toBeDefined();
    expect(exitLog!.obj['chunks']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §5 — makeLoggerPlugin factory
// ---------------------------------------------------------------------------

describe('makeLoggerPlugin', () => {
  it('returns a Plugin with id "logger"', () => {
    const p = makeLoggerPlugin({ level: 'debug' });
    expect(p.id).toBe('logger');
  });

  it('retains the layer capability', () => {
    const p = makeLoggerPlugin({});
    expect(typeof p.capabilities.layer!.layer).toBe('function');
  });

  it('retains the target capability', () => {
    const p = makeLoggerPlugin({});
    expect(p.capabilities.target).toBeDefined();
    expect(p.capabilities.target!.name).toBe('logger');
  });
});

describe('loggerPlugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(loggerPlugin.language).toBe('ts');
  });
});

// ---------------------------------------------------------------------------
// §6 — Logger ctx key: class is usable as typed extension token
// ---------------------------------------------------------------------------

describe('Logger class — typed ctx key', () => {
  it('is a class constructor (can be used as ctx.set/get token)', () => {
    expect(typeof Logger).toBe('function');
    expect(Logger.prototype).toBeDefined();
  });

  it('can be set/get on a FakeExtensions without casting failures', () => {
    const ext = new FakeExtensions();
    const { logger } = makeSpyLogger();
    ext.set(Logger, logger);
    expect(ext.get(Logger)).toBe(logger);
  });
});
