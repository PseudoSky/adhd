/**
 * guards: an aborted invocation keeps running (or resolves) instead of rejecting with an aborted ApiError, or the call's signal never reaches a ctx-taking function through createClient
 * tier: S
 * cites: REMEDIATION-PLAN T-R3 (scenario "cancellation reaches a ctx-taking function"; behaviour change 2); ADR-0019 D4
 * tags: concurrency
 * teeth: red: make raceAbort in dispatch.ts `return work` unconditionally (guarded temporary edit, restored) and run `npx vitest run src/test/dispatch-signal.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; "rejects with an aborted ApiError when the caller aborts mid-call" goes red (the call stays pending until the 1 s test timeout)
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import { createInvoker, LayerContext, type Call } from '../lib/invoke';
import type { ComposedSchemas } from '../lib/types';

const ctxSchemas: ComposedSchemas = {
  work: {
    input: { type: 'object', properties: { data: { type: 'object', properties: {} } }, required: ['data'] },
    output: {},
    hasCtx: true,
  },
};

function makeCall(signal?: AbortSignal): Call {
  return {
    operation: { id: 'work' },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs: {},
    transport: 'cli',
    ...(signal !== undefined ? { signal } : {}),
  };
}

interface IClient {
  signal?: AbortSignal;
}

/** A latch resolved by the function under test once it is running. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('dispatch cancellation (T-R3)', () => {
  it('rejects with an aborted ApiError when the caller aborts mid-call, carrying the reason', async () => {
    const started = latch();
    const createClient = vi.fn(async (_env: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<IClient> => ({
      signal: options?.signal,
    }));
    // The function parks until its own client's signal aborts — it only ends if the signal reaches it.
    const fn = async (ctx: IClient): Promise<string> => {
      started.open();
      await new Promise<void>((resolve) => ctx.signal?.addEventListener('abort', () => resolve()));
      return 'finished-late';
    };
    const controller = new AbortController();
    const invoke = createInvoker([]);
    const outcome = invoke('work', makeCall(controller.signal), {
      fns: { work: fn as never },
      schemas: ctxSchemas,
      createClient,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await started.promise;
    controller.abort(new Error('user cancelled'));
    const result = await outcome;
    expect(result).toHaveProperty('error');
    const error = (result as { error: unknown }).error;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('internal');
    expect((error as ApiError).message).toMatch(/operation "work" aborted: user cancelled/);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('rejects at once, running nothing, when the signal is already aborted', async () => {
    const fn = vi.fn();
    const createClient = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createInvoker([])('work', makeCall(controller.signal), {
        fns: { work: fn },
        schemas: ctxSchemas,
        createClient,
      })
    ).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('aborted') as string });
    expect(fn).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('passes the signal to the client factory on the session-envelope path too', async () => {
    const schemas: ComposedSchemas = {
      work: {
        input: {
          type: 'object',
          properties: { session: { type: 'string' }, data: { type: 'object', properties: {} } },
        },
        output: {},
      },
    };
    const createClient = vi.fn(async (_env: Record<string, unknown>, _o?: { signal?: AbortSignal }) => ({ client: true }));
    const controller = new AbortController();
    const call = { ...makeCall(controller.signal), envelope: { session: 's-1' } };
    const fn = vi.fn(async (ctx: unknown) => ctx);
    const result = await createInvoker([])('work', call, { fns: { work: fn as never }, schemas, createClient });
    expect(result).toEqual({ client: true });
    expect(createClient).toHaveBeenCalledWith({ session: 's-1' }, { signal: controller.signal });
  });

  it('calls a one-argument client factory with exactly the envelope when the call has no signal', async () => {
    const createClient = vi.fn(async (_env: Record<string, unknown>) => ({ client: true }));
    const fn = vi.fn(async (ctx: unknown) => ctx);
    const result = await createInvoker([])('work', makeCall(), {
      fns: { work: fn as never },
      schemas: ctxSchemas,
      createClient,
    });
    expect(result).toEqual({ client: true });
    expect(createClient).toHaveBeenCalledWith({});
    expect(createClient.mock.calls[0]).toHaveLength(1);
  });

  it('a call that finishes before any abort resolves normally and leaves no abort listener behind', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fn = async (): Promise<string> => 'done';
    const schemas: ComposedSchemas = {
      work: { input: ctxSchemas['work'].input, output: {} },
    };
    const result = await createInvoker([])('work', makeCall(controller.signal), { fns: { work: fn }, schemas });
    expect(result).toBe('done');
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    controller.abort(); // after settlement: nothing to reject, nothing unhandled
  });
});
