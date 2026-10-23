/**
 * guards: transform:server_result_persist drops out of HookEvent or its payload shape drifts, or the real HookRegistry stops
 *   handing handlers the payload by reference, so a handler's persist=false veto is no longer visible after emit().
 * tier: S (in-process HookRegistry plus type-level assertions checked by typecheck-spec)
 * cites: R9-hist AC15
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { HookRegistry } from '../../src/registry.js';
import type {
  HookEvent,
  HookEventMap,
  ServerResultPersistPayload,
} from '../../src/index.js';

describe('R9-hist AC15: transform:server_result_persist hook surface', () => {
  it('is a HookEvent whose payload is the documented mutable shape', () => {
    expectTypeOf<'transform:server_result_persist'>().toExtend<HookEvent>();
    expectTypeOf<
      HookEventMap['transform:server_result_persist']
    >().toEqualTypeOf<ServerResultPersistPayload>();
    expectTypeOf<ServerResultPersistPayload>().toEqualTypeOf<{
      sessionId: string;
      agentName?: string;
      serverBytes: number;
      persist: boolean;
    }>();
  });

  it('a real HookRegistry hands handlers the payload by reference, so a veto is visible after emit()', async () => {
    const hooks = new HookRegistry();
    hooks.register('transform:server_result_persist', (p) => {
      p.persist = false;
    });
    const payload: ServerResultPersistPayload = {
      sessionId: 's1',
      serverBytes: 10,
      persist: true,
    };
    await hooks.emit('transform:server_result_persist', payload);
    expect(payload.persist).toBe(false);
  });

  it('negative control: with no handler registered, emit() leaves persist true', async () => {
    const hooks = new HookRegistry();
    const payload: ServerResultPersistPayload = {
      sessionId: 's1',
      serverBytes: 10,
      persist: true,
    };
    await hooks.emit('transform:server_result_persist', payload);
    expect(payload.persist).toBe(true);
  });
});
