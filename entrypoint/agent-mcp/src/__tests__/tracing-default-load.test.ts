/**
 * TRACE-4 (backlog 0f760dcd) — `@adhd/agent-plugin-tracing` is default-loaded by agent-mcp with a
 * typed `tracing` config block and NO env toggle.
 *
 *   0f760dcd AC1 a fresh agent-mcp boot registers the tracing plugin with no operator config
 *   0f760dcd AC2 invalid `tracing` block -> plugin skipped with a logged reason; absent -> loaded
 *   0f760dcd AC3 no env-toggled enable/disable path (source scan + FieldSpec scan)
 *   0f760dcd AC4 the block reuses the plugin's own option names/defaults (no divergent copy)
 *
 * Real: the real engine loader, the real built `@adhd/agent-plugin-tracing` resolved through
 * agent-mcp's own module base, the real `agentMcpEnvironmentSpec` resolved by a real
 * `Environment`. No process is spawned (the built-server boot is the `*.e2e.test.ts` in the e2e
 * lane); the tracing sink is `none` so nothing is written to disk.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { IHookRegistry } from '@adhd/agent-base-types';
import type { EngineLogger } from '@adhd/agent-engine-orchestrator';
import { configSchema } from '@adhd/agent-plugin-tracing';
import { Environment } from '@adhd/environment';

import {
  agentMcpEnvironmentSpec,
  DEFAULT_TRACING_PLUGIN_MODULE,
  defaultPluginEntries,
  tracingPluginConfig,
  type AgentMcpConfig,
} from '../config.js';
import { loadDefaultPlugins } from '../plugins/load-defaults.js';

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

/** An isolated resolution of the REAL spec: empty adhdRoot + a cwd with no git/.adhd ancestor. */
function freshEnv(): Environment<AgentMcpConfig> {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot: scratch('trace4-root-'),
    cwd: scratch('trace4-cwd-'),
  });
}

interface LogLine {
  level: 'info' | 'warn' | 'error';
  msg: unknown;
  text: unknown;
}

function harness() {
  const logs: LogLine[] = [];
  const registered: string[] = [];
  const logger: EngineLogger = {
    info: (msg, ...a) => logs.push({ level: 'info', msg, text: a[0] }),
    warn: (msg, ...a) => logs.push({ level: 'warn', msg, text: a[0] }),
    error: (msg, ...a) => logs.push({ level: 'error', msg, text: a[0] }),
    debug: () => undefined,
  };
  const hooks = {
    register: (hook: string) => registered.push(hook),
    registerEnforcement: (hook: string) => registered.push(hook),
    emit: async () => undefined,
    enforce: async () => undefined,
  } as unknown as IHookRegistry;
  const installedPlugins = () =>
    logs
      .filter((l) => l.text === 'External plugin installed')
      .map((l) => (l.msg as { plugin?: string }).plugin);
  return { logs, registered, logger, hooks, installedPlugins };
}

/** The default entries with the tracing sink silenced (hermetic) and a given tracing block. */
const hermeticTracing: AgentMcpConfig['tracing'] = { service: 'agent-mcp', logSink: 'none', logDir: undefined, captureArgs: false };
const noConfigFile = (): string => join(scratch('trace4-nocfg-'), 'does-not-exist.json');

function configFileWith(entries: unknown[]): string {
  const dir = scratch('trace4-cfg-');
  const file = join(dir, 'agent-mcp.config.json');
  writeFileSync(file, JSON.stringify({ plugins: entries }));
  return file;
}

describe('TRACE-4 default-load of the tracing plugin (0f760dcd)', () => {
  it('AC1: a fresh boot with NO operator config registers the tracing plugin through the real loader', async () => {
    const h = harness();
    await loadDefaultPlugins(h.hooks, {}, h.logger, {
      configPath: noConfigFile(),
      defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, hermeticTracing),
    });
    expect(h.installedPlugins()).toContain('agent-plugin-tracing');
    expect(h.registered).toEqual(expect.arrayContaining(['session:created', 'task:start', 'pre:tool_call', 'permission:decision']));
    expect(h.logs.filter((l) => l.level === 'error')).toEqual([]);

    // NEGATIVE CONTROL: with the tracing entry removed from the defaults the plugin is NOT loaded,
    // so the assertion above is attributable to the default entry.
    const without = harness();
    await loadDefaultPlugins(without.hooks, {}, without.logger, {
      configPath: noConfigFile(),
      defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, hermeticTracing).filter(
        (e) => e.module !== DEFAULT_TRACING_PLUGIN_MODULE
      ),
    });
    expect(without.installedPlugins()).not.toContain('agent-plugin-tracing');
  });

  it('AC2 (absent block): the real spec with no tracing config resolves to the plugin defaults and loads', () => {
    const block = freshEnv().config.tracing;
    expect(block).toEqual({ service: 'agent-mcp', logSink: 'file', logDir: undefined, captureArgs: false });
    // The plugin's own schema accepts exactly what agent-mcp passes, and defaults are identical.
    expect(configSchema.parse(tracingPluginConfig(block))).toEqual({ service: 'agent-mcp', logSink: 'file', captureArgs: false });
    expect(configSchema.parse({})).toEqual(configSchema.parse(tracingPluginConfig(block)));
  });

  it('AC2 (invalid block): an invalid tracing config skips the plugin with a logged reason; others still load', async () => {
    const h = harness();
    await loadDefaultPlugins(h.hooks, {}, h.logger, {
      configPath: configFileWith([{ module: DEFAULT_TRACING_PLUGIN_MODULE, config: { logSink: 'bogus' } }]),
      defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, hermeticTracing),
    });
    expect(h.installedPlugins()).not.toContain('agent-plugin-tracing');
    expect(h.installedPlugins()).toContain('agent-mcp-budget');
    const reason = h.logs.find((l) => l.level === 'error' && String(l.text).includes('failed schema validation'));
    expect(reason, 'a logged reason for the skip').toBeDefined();
    expect((reason?.msg as { specifier?: string }).specifier).toBe(DEFAULT_TRACING_PLUGIN_MODULE);

    // Control: the SAME user entry with a valid block replaces the default and loads exactly once.
    const ok = harness();
    await loadDefaultPlugins(ok.hooks, {}, ok.logger, {
      configPath: configFileWith([{ module: DEFAULT_TRACING_PLUGIN_MODULE, config: { logSink: 'none' } }]),
      defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, hermeticTracing),
    });
    expect(ok.installedPlugins().filter((n) => n === 'agent-plugin-tracing')).toHaveLength(1);
  });

  it('AC3: no env-toggled enable/disable path — source scan and FieldSpec scan', () => {
    // 1. `rg -i "<tracing>_<enabled>"` over entrypoint/agent-mcp/src returns nothing. The needle is
    //    assembled at runtime so this file does not itself match.
    const needle = new RegExp(['TRACING', 'ENABLED'].join('_'), 'i');
    const srcRoot = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (needle.test(readFileSync(full, 'utf8'))) hits.push(full);
      }
    };
    walk(srcRoot);
    expect(hits).toEqual([]);

    // 2. The tracing FieldSpecs are exactly the four value fields — no enable/disable flag, and no
    //    boolean spec other than `captureArgs` (a value, not a switch).
    const tracingKeys = Object.keys(agentMcpEnvironmentSpec.config).filter((k) => k.startsWith('tracing.'));
    expect(tracingKeys.sort()).toEqual(['tracing.captureArgs', 'tracing.logDir', 'tracing.logSink', 'tracing.service']);
    for (const key of tracingKeys) {
      expect(key).not.toMatch(/enable|disable|toggle|off/i);
      const spec = agentMcpEnvironmentSpec.config[key as keyof typeof agentMcpEnvironmentSpec.config] as { env?: string };
      expect(spec.env).toMatch(/^ADHD_AGENT_TRACING_(SERVICE|LOG_SINK|LOG_DIR|CAPTURE_ARGS)$/);
    }

    // 3. Whatever the environment says, the tracing entry is always present: the budget opt-out
    //    and every `*_DISABLE_*`/`*_ENABLED` style var cannot remove it.
    for (const env of [
      {},
      { ADHD_AGENT_DISABLE_BUDGET_PLUGIN: '1' },
      { ADHD_AGENT_DISABLE_TRACING: '1', ADHD_AGENT_TRACING_DISABLED: 'true' },
    ]) {
      const modules = defaultPluginEntries(env as unknown as NodeJS.ProcessEnv, hermeticTracing).map((e) => e.module);
      expect(modules).toContain(DEFAULT_TRACING_PLUGIN_MODULE);
    }
  });

  it('AC4: the tracing block reuses the plugin schema option names/defaults, and a divergent key is rejected', () => {
    // Every key agent-mcp can pass is a key of the plugin schema (no private divergent copy)…
    const passed = Object.keys(tracingPluginConfig({ service: 's', logSink: 'file', logDir: '/x', captureArgs: true }));
    expect(passed.sort()).toEqual(Object.keys(configSchema.shape).sort());
    // …and the plugin's `.strict()` schema rejects a key it does not own (negative control).
    expect(configSchema.safeParse({ ...tracingPluginConfig(hermeticTracing), prefix: 'adhd' }).success).toBe(false);
  });
});

