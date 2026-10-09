/**
 * c536ce29 E2E-PREREQ (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — a default plugin that cannot be
 * resolved/imported at startup must be SURFACED, not silently dropped by a quiet logger.
 *
 *   c536ce29 E2E-PREREQ-1 an unresolvable DEFAULT entry yields a stderr WARNING and a
 *                         `plugin.load_failed` ops record (plugin, stage, reason, default:true)
 *   c536ce29 E2E-PREREQ-2 the server does not crash: sibling entries still load (skip semantics)
 *   c536ce29 E2E-PREREQ-3 `loadDefaultPluginsOrFail` throws a message naming the plugin and the
 *                         `nx build agent-plugin-tracing` remedy when tracing is unresolvable
 *
 * Real: the real engine loader + real `loadDefaultPlugins`; the logger is a NO-OP (the production
 * failure mode this guards). The ops channel is a collector (the channel is the seam, not the thing under test).
 */
import { describe, expect, it } from 'vitest';

import type { IHookRegistry } from '@adhd/agent-base-types';
import type { EngineLogger } from '@adhd/agent-engine-orchestrator';

import { defaultPluginEntries } from '../config.js';
import { loadDefaultPlugins } from '../plugins/load-defaults.js';
import { loadDefaultPluginsOrFail } from './plugin-prereq.js';

const noopLogger: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const MISSING = '@adhd/definitely-not-installed-plugin-e2e-prereq';
const hooks = { on: () => () => undefined, emit: async () => undefined } as unknown as IHookRegistry;

interface IRec { event: string; fields: Record<string, unknown> }
const collector = (): { channel: { logEvent: (e: string, f: Record<string, unknown>) => void }; recs: IRec[] } => {
  const recs: IRec[] = [];
  return { recs, channel: { logEvent: (event, fields) => void recs.push({ event, fields }) } };
};

describe('c536ce29 E2E-PREREQ: unresolvable default plugin is surfaced', () => {
  it('c536ce29 E2E-PREREQ-1: stderr warning + plugin.load_failed ops record for a default entry', async () => {
    const stderr: string[] = [];
    const ops = collector();
    await loadDefaultPlugins(hooks, {}, noopLogger, {
      configPath: '/nonexistent/no-such-config.json',
      defaultEntries: [{ module: MISSING, config: {} }],
      stderr: { write: (c: string | Uint8Array) => (stderr.push(String(c)), true) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opsChannel: ops.channel as any,
    });
    expect(stderr.join('')).toMatch(new RegExp(`WARNING: default plugin ${MISSING} failed to load \\(resolve\\)`));
    expect(ops.recs).toHaveLength(1);
    expect(ops.recs[0]!.event).toBe('plugin.load_failed');
    expect(ops.recs[0]!.fields).toMatchObject({ component: 'plugin', plugin: MISSING, stage: 'resolve', default: true });
    expect(String(ops.recs[0]!.fields.reason)).toContain(MISSING);
  });

  it('c536ce29 E2E-PREREQ-2: the failure does not abort the load loop (sibling entries still run)', async () => {
    const stderr: string[] = [];
    const ops = collector();
    await loadDefaultPlugins(hooks, {}, noopLogger, {
      configPath: '/nonexistent/no-such-config.json',
      defaultEntries: [{ module: MISSING, config: {} }, { module: `${MISSING}-2`, config: {} }],
      stderr: { write: (c: string | Uint8Array) => (stderr.push(String(c)), true) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opsChannel: ops.channel as any,
    });
    expect(ops.recs.map((r) => r.fields.plugin)).toEqual([MISSING, `${MISSING}-2`]);
  });

  it('c536ce29 E2E-PREREQ-3: loadDefaultPluginsOrFail names the plugin and the build remedy', async () => {
    // Point the tracing specifier at a path that does not exist: the loader resolves it, the import
    // fails, and the collected error text still names the package.
    const broken = defaultPluginEntries({} as NodeJS.ProcessEnv).map((e) =>
      e.module === '@adhd/agent-plugin-tracing' ? { ...e, module: '/nonexistent/@adhd/agent-plugin-tracing/dist/index.js' } : e
    );
    await expect(
      loadDefaultPluginsOrFail(hooks, {}, { configPath: '/nonexistent/no-such-config.json', defaultEntries: broken })
    ).rejects.toThrow(/default plugin @adhd\/agent-plugin-tracing did not load[\s\S]*npx nx build agent-plugin-tracing/);
  });
});
