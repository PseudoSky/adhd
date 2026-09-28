/**
 * readiness.spec.ts — AC4's probe half: the serving path (not a socket
 * accept) decides readiness; an `ok:false` envelope or a throw is a READINESS
 * failure; a timeout is a typed refusal.
 *
 * Negative control: a socket-only readiness check would report `ready:true`
 * for the not-serving case; the assertions below fail if `ready` is not keyed
 * on the probe's own answer.
 */
import { describe, expect, it } from 'vitest';
import { probeReadiness, type IReadinessHandle, type IReadinessTimer } from './readiness.js';

function handleWith(
  invokeResult: unknown | (() => Promise<unknown>)
): IReadinessHandle {
  return {
    pkg: {
      fns: { embeddingStatus: () => invokeResult },
      createClient: async () => ({}),
    },
    operations: [{ id: 'backlog/embedding-status' }],
    store: {},
  };
}

describe('probeReadiness', () => {
  it('is ready when the serving path answers ok:true', async () => {
    const result = await probeReadiness(handleWith({ ok: true, data: {} }), {
      timeoutMs: 1000,
    });
    expect(result.ready).toBe(true);
  });

  it('is NOT ready when the transport answers but the op fails', async () => {
    const result = await probeReadiness(
      handleWith({
        ok: false,
        error: { code: 'rag_not_configured', message: 'no backend' },
      }),
      { timeoutMs: 1000 }
    );
    expect(result.ready).toBe(false);
    expect(result.failure?.kind).toBe('readiness');
    expect(result.failure?.code).toBe('rag_not_configured');
  });

  it('is NOT ready when the probe throws (never throws raw)', async () => {
    const result = await probeReadiness(
      {
        pkg: {
          fns: {
            embeddingStatus: () => {
              throw new Error('boom');
            },
          },
          createClient: async () => ({}),
        },
        operations: [{ id: 'backlog/embedding-status' }],
        store: {},
      },
      { timeoutMs: 1000 }
    );
    expect(result.ready).toBe(false);
    expect(result.failure?.code).toBe('probe_error');
  });

  it('returns a typed timeout refusal without a real sleep', async () => {
    let fire: (() => void) | undefined;
    let cleared = false;
    const timer: IReadinessTimer = {
      setTimeout: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimeout: () => {
        cleared = true;
      },
    };
    const pending = probeReadiness(handleWith(new Promise<never>(() => {
      void 0;
    })), {
      timeoutMs: 50,
      timer,
    });
    // `setTimeout` was registered synchronously before the first await.
    fire?.();
    const result = await pending;
    expect(result.ready).toBe(false);
    expect(result.failure?.code).toBe('probe_timeout');
    expect(cleared).toBe(true);
  });
});
