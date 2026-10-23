/**
 * guards: the sanitize plugin stops vetoing persistence of server-tool result bodies when delegationOnly is false, or
 *   vetoes (or registers a handler) under the default and delegationOnly:true configs, or a veto is reversed.
 * tier: S (real plugin factory on a real in-process HookRegistry)
 * cites: R9-hist AC15
 */
import { describe, it, expect } from 'vitest';
import { HookRegistry } from '@adhd/agent-base-types';
import type {
  HookEvent,
  IHookRegistry,
  Plugin,
  ServerResultPersistPayload,
} from '@adhd/agent-base-types';
import createPlugin from '../../src/index.js';

const EVENT = 'transform:server_result_persist' as const;

function makePayload(
  overrides: Partial<ServerResultPersistPayload> = {}
): ServerResultPersistPayload {
  return {
    sessionId: 'session-1',
    agentName: 'researcher',
    serverBytes: 4096,
    persist: true,
    ...overrides,
  };
}

/** A real HookRegistry that also records which events the plugin subscribed to. */
interface IRecordingRegistry extends IHookRegistry {
  readonly registered: HookEvent[];
}

function install(config: Record<string, unknown>): IRecordingRegistry {
  const real = new HookRegistry();
  const registered: HookEvent[] = [];
  const hooks: IRecordingRegistry = {
    registered,
    register: (event, handler) => {
      registered.push(event);
      real.register(event, handler);
    },
    emit: (event, payload) => real.emit(event, payload),
    registerEnforcement: (event, handler) =>
      real.registerEnforcement(event, handler),
    enforce: (event, payload) => real.enforce(event, payload),
  };
  const plugin = createPlugin({ db: undefined as never, config });
  // The sanitize factory is synchronous even though PluginFactory permits a Promise.
  (plugin as Plugin).install(hooks);
  return hooks;
}

describe('R9-hist AC15: sanitize plugin vetoes server-result persistence', () => {
  it('delegationOnly:false vetoes persistence of server-tool result bodies', async () => {
    const hooks = install({ delegationOnly: false });
    const payload = makePayload();
    await hooks.emit(EVENT, payload);
    expect(payload.persist).toBe(false);
  });

  it('delegationOnly:true (explicit) leaves persistence untouched and registers no handler', async () => {
    const hooks = install({ delegationOnly: true });
    const payload = makePayload();
    await hooks.emit(EVENT, payload);
    expect(payload.persist).toBe(true);
    expect(hooks.registered).not.toContain(EVENT);
  });

  it('the default config (delegationOnly omitted) leaves persistence untouched and registers no handler', async () => {
    const hooks = install({});
    const payload = makePayload();
    await hooks.emit(EVENT, payload);
    expect(payload.persist).toBe(true);
    expect(hooks.registered).not.toContain(EVENT);
  });

  it('negative control: no sanitize plugin installed means persist stays true', async () => {
    const hooks = new HookRegistry();
    const payload = makePayload();
    await hooks.emit(EVENT, payload);
    expect(payload.persist).toBe(true);
  });

  it('the veto does not depend on strategy, agent overrides or the payload contents', async () => {
    for (const defaultStrategy of ['none', 'prefix', 'wrap'] as const) {
      const hooks = install({
        delegationOnly: false,
        defaultStrategy,
        agents: { researcher: 'none' },
      });
      const payload = makePayload({ agentName: undefined, serverBytes: 0 });
      await hooks.emit(EVENT, payload);
      expect(payload.persist).toBe(false);
    }
  });

  it('a veto is never reversed: an already-false persist stays false', async () => {
    const hooks = install({ delegationOnly: false });
    const payload = makePayload({ persist: false });
    await hooks.emit(EVENT, payload);
    expect(payload.persist).toBe(false);
  });

  it('delegationOnly:false still sanitizes tool results (the existing contract is unchanged)', async () => {
    const hooks = install({ delegationOnly: false });
    expect(hooks.registered).toEqual(
      expect.arrayContaining(['transform:tool_result', EVENT])
    );
  });
});
