/**
 * invokeBatch integration tests (F1/F4, BATCH_0.0.1.md §3).
 *
 * TEETH contract (CLAUDE.md §7 / AGENTS.md §7): real `createInvoker` Layer
 * composition (no mocked invoker), real concurrency proved by a latch/barrier
 * (never sleep), real partial-failure semantics (`onItemError: continue` vs
 * `abort`), real per-item timeout/cancellation composing with the batch's own
 * `AbortSignal` (F4), and real streaming collection via `collectWithPhase`
 * (§4 Tier 1) — no mocks of the thing under test.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInvoker, LayerContext } from '../lib/invoke';
import type { Layer, Call, InvokeOptions } from '../lib/invoke';
import type { ComposedSchemas } from '../lib/types';
import { createStream } from '../lib/stream';
import { invokeBatch, BATCH_MAX_CONCURRENCY } from '../lib/batch';
import { ApiError } from '@adhd/apigen-base-errors';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const echoSchema: ComposedSchemas = {
  echo: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { value: {} },
        },
      },
      required: ['data'],
    },
    output: {},
  },
};

function makeCall(domainArgs: Record<string, unknown>, overrides?: Partial<Call>): Call {
  return {
    operation: { id: 'echo' },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Baseline — real createInvoker/dispatch composition (no mocked invoke)
// ---------------------------------------------------------------------------

describe('invokeBatch — real createInvoker/Layer composition', () => {
  it('fans out N real invoke() calls through the composed Layer stack (no bypass)', async () => {
    const seen: string[] = [];
    const observingLayer: Layer = async (call, next) => {
      seen.push(call.operation.id ?? 'unknown');
      return next();
    };
    const invoke = createInvoker([observingLayer]);
    const fns = { echo: (v: unknown) => v };
    const opts: InvokeOptions = { fns, schemas: echoSchema };

    const calls = [1, 2, 3].map((v) => makeCall({ value: v }));
    const results = await invokeBatch(invoke, 'echo', calls, opts);

    // Every item passed through the SAME Layer the harness composes for a
    // single-op invoke — not a dispatch bypass.
    expect(seen).toEqual(['echo', 'echo', 'echo']);
    expect(results).toEqual([
      { index: 0, status: 'fulfilled', value: 1 },
      { index: 1, status: 'fulfilled', value: 2 },
      { index: 2, status: 'fulfilled', value: 3 },
    ]);
  });

  it('preserves index ordering in the results array regardless of completion order', async () => {
    const gates: Array<() => void> = [];
    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) =>
        new Promise<number>((resolve) => {
          gates[v] = () => resolve(v);
        }),
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1, 2].map((v) => makeCall({ value: v }));

    const promise = invokeBatch(invoke, 'echo', calls, opts, { concurrency: 3 });
    // Resolve out of order: 2, then 0, then 1.
    await vi.waitFor(() => expect(gates[2]).toBeDefined());
    gates[2]();
    await vi.waitFor(() => expect(gates[0]).toBeDefined());
    gates[0]();
    await vi.waitFor(() => expect(gates[1]).toBeDefined());
    gates[1]();

    const results = await promise;
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Real concurrency — proved by a barrier, not sleep
// ---------------------------------------------------------------------------

describe('invokeBatch — concurrency is real and bounded (barrier proof)', () => {
  it('never runs more than `concurrency` items at once, and all N items eventually run', async () => {
    const CONCURRENCY = 2;
    const N = 6;
    let active = 0;
    let maxActive = 0;
    // FIFO queue of release callbacks, pushed the instant each item starts
    // (synchronously, before any await) — draining it release-by-release
    // while asserting `active` is the barrier proof (no sleep involved).
    const queue: Array<() => void> = [];

    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) =>
        new Promise<number>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          queue.push(() => {
            active--;
            resolve(v);
          });
        }),
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = Array.from({ length: N }, (_, v) => makeCall({ value: v }));

    const promise = invokeBatch(invoke, 'echo', calls, opts, {
      concurrency: CONCURRENCY,
    });

    for (let released = 0; released < N; released++) {
      await vi.waitFor(() => expect(queue.length).toBeGreaterThan(released));
      expect(active).toBeLessThanOrEqual(CONCURRENCY);
      queue[released]();
    }

    const results = await promise;
    expect(results.length).toBe(N);
    expect(maxActive).toBeLessThanOrEqual(CONCURRENCY);
    expect(maxActive).toBeGreaterThan(1); // proves it's genuinely concurrent, not accidentally serial
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('clamps a requested concurrency above BATCH_MAX_CONCURRENCY down to the hard cap', async () => {
    let maxActive = 0;
    let active = 0;
    const invoke = createInvoker([]);
    const N = BATCH_MAX_CONCURRENCY + 10;
    const queue: Array<() => void> = [];
    const fns = {
      echo: (v: number) =>
        new Promise<number>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          queue.push(() => {
            active--;
            resolve(v);
          });
        }),
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = Array.from({ length: N }, (_, v) => makeCall({ value: v }));

    const promise = invokeBatch(invoke, 'echo', calls, opts, {
      concurrency: BATCH_MAX_CONCURRENCY * 10,
    });

    // Let every worker that's ALLOWED to start actually start before
    // asserting the ceiling — no more than the hard cap must ever appear.
    await vi.waitFor(() => expect(queue.length).toBe(BATCH_MAX_CONCURRENCY));
    expect(maxActive).toBe(BATCH_MAX_CONCURRENCY);

    // Drain the pool to completion: releasing the first cohort frees workers
    // to pick up the remaining N-BATCH_MAX_CONCURRENCY items, which push
    // their own release callbacks onto `queue` — keep draining until every
    // item has started (and thus been released).
    let released = 0;
    while (released < N) {
      await vi.waitFor(() => expect(queue.length).toBeGreaterThan(released));
      queue[released]();
      released++;
    }
    await promise;
  });
});

// ---------------------------------------------------------------------------
// Partial failure — onItemError: 'continue' (default) vs 'abort'
// ---------------------------------------------------------------------------

describe('invokeBatch — partial failure semantics', () => {
  it('onItemError "continue" (default) runs every item regardless of earlier failures', async () => {
    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) => {
        if (v === 1) throw new Error('item 1 boom');
        return v;
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1, 2].map((v) => makeCall({ value: v }));

    const results = await invokeBatch(invoke, 'echo', calls, opts, {
      mode: 'serial',
    });

    expect(results[0]).toEqual({ index: 0, status: 'fulfilled', value: 0 });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as { reason: unknown }).reason).toBeInstanceOf(Error);
    // continue semantics: item 2 still ran despite item 1's failure.
    expect(results[2]).toEqual({ index: 2, status: 'fulfilled', value: 2 });
  });

  it('onItemError "abort" stops remaining not-yet-started items after the first failure (serial)', async () => {
    const calledWith: number[] = [];
    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) => {
        calledWith.push(v);
        if (v === 1) throw new Error('item 1 boom');
        return v;
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1, 2, 3].map((v) => makeCall({ value: v }));

    const results = await invokeBatch(invoke, 'echo', calls, opts, {
      mode: 'serial',
      onItemError: 'abort',
    });

    // Item 3 must NEVER have been invoked — proves real short-circuit, not
    // just a status-shape assertion.
    expect(calledWith).toEqual([0, 1]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('rejected');
    expect(results[3].status).toBe('rejected');
  });

  it('mode "chained" ALWAYS stops on first failure, even with onItemError "continue" (negative control)', async () => {
    const calledWith: number[] = [];
    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) => {
        calledWith.push(v);
        if (v === 0) throw new Error('item 0 boom');
        return v;
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1, 2].map((v) => makeCall({ value: v }));

    const results = await invokeBatch(invoke, 'echo', calls, opts, {
      mode: 'chained',
      onItemError: 'continue', // deliberately the opposite of what 'chained' should do
    });

    expect(calledWith).toEqual([0]); // items 1, 2 never ran — negative control has teeth
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('rejected');
  });

  it('"abort" in parallel mode lets already-in-flight items finish but starts no new ones', async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const invoke = createInvoker([]);
    const fns = {
      echo: (v: number) => {
        started.push(v);
        if (v === 0) throw new Error('item 0 boom');
        return new Promise<number>((resolve) => {
          releases[v] = () => resolve(v);
        });
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    // item 0 fails synchronously; items 1/2 are slow; concurrency 2 means
    // 0 and 1 start together, 0 fails immediately, 2 must never start.
    const calls = [0, 1, 2].map((v) => makeCall({ value: v }));

    const promise = invokeBatch(invoke, 'echo', calls, opts, {
      concurrency: 2,
      onItemError: 'abort',
    });

    await vi.waitFor(() => expect(releases[1]).toBeDefined());
    releases[1]();
    const results = await promise;

    expect(started).toEqual([0, 1]); // item 2 never started
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// F4 — itemTimeoutMs derives a per-item AbortSignal linked to the batch signal
// ---------------------------------------------------------------------------

describe('invokeBatch — F4 itemTimeoutMs / per-item AbortSignal composition', () => {
  /** A Layer that races `next()` against the call's own signal — simulating
   *  how a real consumer wires an external service call to `call.signal`. */
  const signalRacingLayer: Layer = (call, next) => {
    const signal = call.signal;
    if (!signal) return next();
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      next().then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });
  };

  it('a per-item timeout cuts off a hanging item without affecting siblings', async () => {
    const invoke = createInvoker([signalRacingLayer]);
    let neverResolves: () => void = () => {
      /* replaced once the pending promise's executor runs */
    };
    const fns = {
      echo: (v: number) => {
        if (v === 0) return new Promise<number>((resolve) => (neverResolves = () => resolve(0)));
        return v;
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1].map((v) => makeCall({ value: v }));

    const results = await invokeBatch(invoke, 'echo', calls, opts, {
      itemTimeoutMs: 20,
      concurrency: 2,
    });

    expect(results[0].status).toBe('rejected');
    // BUG-APIGEN-047: `DOMException` IS `instanceof Error` in Node (unlike a
    // plain object), and suffers the EXACT same wire-serialization loss a
    // bare `Error` does (`JSON.stringify(new DOMException(...))` also
    // produces `{}` — proven in the BUG-APIGEN-047 describe block below), so
    // `normalizeReason` wraps it the same way: a real `ApiError('internal',
    // message)` whose `toJSON()` survives the wire.
    const reason = (results[0] as { reason: unknown }).reason;
    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).message).toBe(
      'apigen/invokeBatch: item timed out after 20ms'
    );
    expect((reason as ApiError).code).toBe('internal');
    // Sibling item, unaffected by item 0's timeout.
    expect(results[1]).toEqual({ index: 1, status: 'fulfilled', value: 1 });
    neverResolves(); // release the dangling promise so nothing leaks past the test
  });

  it('aborting the WHOLE-BATCH signal aborts every in-flight item (composes, does not bypass)', async () => {
    const invoke = createInvoker([signalRacingLayer]);
    const controller = new AbortController();
    let resolveItem: (() => void) | undefined;
    const fns = {
      echo: (v: number) =>
        new Promise<number>((resolve) => {
          resolveItem = () => resolve(v);
        }),
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [0, 1].map((v) => makeCall({ value: v }, { signal: controller.signal }));

    const promise = invokeBatch(invoke, 'echo', calls, opts, { concurrency: 2 });
    await vi.waitFor(() => expect(resolveItem).toBeDefined());
    controller.abort(new Error('whole batch cancelled'));

    const results = await promise;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('negative control — WITHOUT itemTimeoutMs, a hanging item is never cut off (proves the timeout, not something else, causes the cutoff)', async () => {
    const invoke = createInvoker([signalRacingLayer]);
    let resolveIt: (() => void) | undefined;
    const fns = {
      echo: () =>
        new Promise<number>((resolve) => {
          resolveIt = () => resolve(42);
        }),
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [makeCall({ value: 0 })];

    const promise = invokeBatch(invoke, 'echo', calls, opts, {});
    // Give the event loop a couple of ticks — without a real itemTimeoutMs
    // the item must still be pending (no wall-clock sleep; bounded microtask
    // flush only).
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveIt).toBeDefined();
    resolveIt?.();
    const results = await promise;
    expect(results[0]).toEqual({ index: 0, status: 'fulfilled', value: 42 });
  });
});

// ---------------------------------------------------------------------------
// §4 Tier 1 — streaming items collected into a uniform terminal BatchItemResult
// ---------------------------------------------------------------------------

describe('invokeBatch — §4 Tier 1 streaming item collection', () => {
  const streamingSchema: ComposedSchemas = {
    stream: {
      input: {
        type: 'object',
        properties: { data: { type: 'object', properties: { n: {} } } },
        required: ['data'],
      },
      output: {},
    },
  };

  it('collects a clean streaming item into { status: fulfilled, chunks }', async () => {
    const invoke = createInvoker([]);
    const fns = {
      stream: (n: number) =>
        createStream<number>({
          produce: async function* () {
            for (let i = 0; i < n; i++) yield i;
          },
        }),
    };
    const opts: InvokeOptions = { fns, schemas: streamingSchema };
    const call: Call = {
      operation: { id: 'stream' },
      ctx: new LayerContext(),
      envelope: {},
      domainArgs: { n: 3 },
    };

    const results = await invokeBatch(invoke, 'stream', [call], opts);
    expect(results[0]).toEqual({ index: 0, status: 'fulfilled', chunks: [0, 1, 2] });
  });

  it('collects a streaming item that errors AFTER its first chunk, with chunksDelivered', async () => {
    const invoke = createInvoker([]);
    const fns = {
      stream: () =>
        createStream<number>({
          produce: async function* () {
            yield 0;
            yield 1;
            throw new Error('stream blew up');
          },
        }),
    };
    const opts: InvokeOptions = { fns, schemas: streamingSchema };
    const call: Call = {
      operation: { id: 'stream' },
      ctx: new LayerContext(),
      envelope: {},
      domainArgs: { n: 5 },
    };

    const results = await invokeBatch(invoke, 'stream', [call], opts);
    expect(results[0].status).toBe('rejected');
    const rejected = results[0] as { reason: unknown; chunksDelivered?: number };
    expect(rejected.chunksDelivered).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// BUG-APIGEN-047 — rejected `reason` survives a real JSON.stringify round trip
// ---------------------------------------------------------------------------

describe('invokeBatch — BUG-APIGEN-047 rejected reason wire normalization', () => {
  it('a bare thrown Error is normalized so its message survives a real JSON round trip', async () => {
    const invoke = createInvoker([]);
    const fns = {
      echo: (): never => {
        throw new Error('getItem: item not found');
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [makeCall({ value: 0 })];

    const results = await invokeBatch(invoke, 'echo', calls, opts);

    expect(results[0].status).toBe('rejected');
    const reason = (results[0] as { reason: unknown }).reason;
    // Still a real Error (ApiError extends Error) — doesn't change the shape
    // consumers already narrow on with `instanceof Error`/`instanceof
    // ApiError` in-process.
    expect(reason).toBeInstanceOf(Error);

    // The actual bug: a bare `Error` has no own enumerable properties, so
    // `JSON.stringify` used to drop `message` entirely, leaving `{}` on the
    // wire. Prove the REAL round trip now carries the real message.
    const wire = JSON.parse(JSON.stringify(results[0])) as {
      reason?: { message?: string; code?: string };
    };
    expect(wire.reason).toBeDefined();
    expect(wire.reason?.message).toBe('getItem: item not found');
    expect(wire.reason?.code).toBe('internal');
    // Negative control for the exact regression this bug describes: a bare
    // `Error` put through `JSON.stringify` directly (i.e. the un-normalized
    // path this fix replaces) loses its message — proving the bug is real
    // and the fix is what closes the gap, not an assertion artifact.
    expect(JSON.parse(JSON.stringify(new Error('getItem: item not found')))).toEqual({});
  });

  it('a thrown ApiError is passed through unchanged and already round-trips via its own toJSON', async () => {
    const invoke = createInvoker([]);
    const fns = {
      echo: (): never => {
        throw new ApiError('not_found', 'item not found: missing');
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [makeCall({ value: 0 })];

    const results = await invokeBatch(invoke, 'echo', calls, opts);

    expect(results[0].status).toBe('rejected');
    const reason = (results[0] as { reason: unknown }).reason;
    expect(reason).toBeInstanceOf(ApiError);

    const wire = JSON.parse(JSON.stringify(results[0])) as {
      reason?: { message?: string; code?: string };
    };
    expect(wire.reason?.message).toBe('item not found: missing');
    expect(wire.reason?.code).toBe('not_found');
  });

  it('a plain (non-Error) rejection reason passes through unchanged, unnormalized', async () => {
    // `normalizeReason` only touches `Error`/`ApiError` instances (per BUG-
    // APIGEN-047's fix constraint) — a plain object/string reason is already
    // JSON-serializable and must be left exactly as thrown, not re-wrapped
    // into an `ApiError`.
    //
    // The itemTimeoutMs DOMException case is covered above (F4 describe
    // block, "a per-item timeout cuts off a hanging item...") — it DOES get
    // normalized, since `DOMException instanceof Error` is `true` in Node
    // and it suffers the identical wire-loss bug a bare `Error` does.
    const invoke = createInvoker([]);
    const fns = {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately exercising a non-Error throw to prove passthrough
      echo: (): never => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { code: 'domain_specific', detail: 'not an Error instance' };
      },
    };
    const opts: InvokeOptions = { fns, schemas: echoSchema };
    const calls = [makeCall({ value: 0 })];

    const results = await invokeBatch(invoke, 'echo', calls, opts);

    expect(results[0].status).toBe('rejected');
    const reason = (results[0] as { reason: unknown }).reason;
    expect(reason).not.toBeInstanceOf(Error);
    expect(reason).toEqual({ code: 'domain_specific', detail: 'not an Error instance' });
    expect(JSON.parse(JSON.stringify(results[0]))).toMatchObject({
      reason: { code: 'domain_specific', detail: 'not an Error instance' },
    });
  });
});
