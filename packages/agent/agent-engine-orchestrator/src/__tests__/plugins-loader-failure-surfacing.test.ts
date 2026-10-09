/**
 * c536ce29 E2E-PREREQ (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — `loadExternalPlugins`'
 * `onPluginLoadFailed` hook: every skipped entry is reported with its stage, cause and whether it
 * was a host default, even when the injected logger is a no-op.
 */
import { describe, expect, it } from 'vitest';

import type { IHookRegistry } from '@adhd/agent-base-types';

import type { EngineLogger } from '../interfaces.js';
import { loadExternalPlugins, type PluginLoadFailure } from '../plugins/loader.js';

const noop: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const hooks = { on: () => () => undefined } as unknown as IHookRegistry;

describe('c536ce29 E2E-PREREQ-4: loader reports skipped plugins to onPluginLoadFailed', () => {
  it('reports resolve failures for default and user entries, flagging defaults', async () => {
    const seen: PluginLoadFailure[] = [];
    await loadExternalPlugins(
      hooks,
      {},
      {
        configPath: '/nonexistent/none.json',
        pluginEntries: ['@adhd/no-such-user-plugin-e2e-prereq'],
        onPluginLoadFailed: (f) => void seen.push(f),
      },
      undefined,
      undefined,
      noop,
      [{ module: '@adhd/no-such-default-plugin-e2e-prereq', config: {} }]
    );
    expect(seen.map((f) => [f.specifier, f.stage, f.isDefault])).toEqual([
      ['@adhd/no-such-default-plugin-e2e-prereq', 'resolve', true],
      ['@adhd/no-such-user-plugin-e2e-prereq', 'resolve', false],
    ]);
    expect(seen[0]!.reason).toContain('Cannot resolve plugin');
  });

  it('a throwing handler never aborts the load loop', async () => {
    let calls = 0;
    await loadExternalPlugins(
      hooks,
      {},
      {
        configPath: '/nonexistent/none.json',
        onPluginLoadFailed: () => {
          calls += 1;
          throw new Error('handler boom');
        },
      },
      undefined,
      undefined,
      noop,
      [
        { module: '@adhd/no-such-a-e2e-prereq', config: {} },
        { module: '@adhd/no-such-b-e2e-prereq', config: {} },
      ]
    );
    expect(calls).toBe(2);
  });
});
