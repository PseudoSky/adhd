/**
 * c536ce29 (wire/ops tracing, segment S3) — the log tree is declared in the agent-mcp
 * `EnvironmentSpec` and resolved ONLY through the real `@adhd/environment` cascade.
 *
 *   c536ce29 TRC-AC1   every resolved root is under `<adhd root>/agent-mcp/<ns>/…`, never under
 *                      cwd, even with `ADHD_ENV_SCOPE=project` in a git repo; two Environment
 *                      instances (different generated instanceIds) resolve the SAME logs root
 *   c536ce29 TRC-AC17  zero-config resolution (no env, no yaml) yields the logs/temp dirs, the
 *                      `logging.*` defaults, and the tracing plugin receives `<logs>/trace`
 *
 * Real: the real `agentMcpEnvironmentSpec` resolved by a real `Environment` over isolated temp
 * `adhdRoot`/`cwd` dirs (same shape as bind-host.test.ts). Negative controls build variants of
 * the REAL spec with `share:'shared'` / `scope:'global'` removed and assert the guarantee breaks.
 * No process is spawned; pure path resolution (ensureDirs touches only the temp adhdRoot).
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';
import type { EnvironmentSpec } from '@adhd/environment-base-spec';

import {
  agentMcpEnvironmentSpec,
  defaultPluginEntries,
  DEFAULT_TRACING_PLUGIN_MODULE,
  resolveLogRoots,
  type AgentMcpConfig,
} from '../config.js';

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** A temp directory that is a git project (so auto/forced project scope has a real marker). */
function gitRepoCwd(): string {
  const d = scratch('trc-wirelog-cwd-');
  mkdirSync(join(d, '.git'));
  return d;
}

function clearAmbient(): void {
  for (const k of [
    'ADHD_ENV_SCOPE',
    'ADHD_AGENT_LOGGING_DIR',
    'ADHD_AGENT_LOGGING_API',
    'ADHD_AGENT_LOGGING_INSTANCE_LABEL',
    'ADHD_AGENT_TRACING_LOG_DIR',
  ]) {
    setEnv(k, undefined);
  }
}

function makeEnv(
  spec: EnvironmentSpec<AgentMcpConfig>,
  opts: { adhdRoot?: string; cwd: string; scope?: 'global' | 'project' }
) {
  return new Environment<AgentMcpConfig>('agent-mcp', spec, {
    namespace: 'production',
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.adhdRoot !== undefined ? { adhdRoot: opts.adhdRoot } : {}),
    cwd: opts.cwd,
  });
}

/** Variant of the REAL spec with one property removed from the `logs`/`temp` DirSpecs. */
function specWithout(prop: 'share' | 'scope'): EnvironmentSpec<AgentMcpConfig> {
  const real = agentMcpEnvironmentSpec.dirs ?? {};
  const strip = (key: 'logs' | 'temp') => {
    const copy = { ...(real[key] as NonNullable<(typeof real)[string]>) };
    delete (copy as Record<string, unknown>)[prop];
    return copy;
  };
  return { ...agentMcpEnvironmentSpec, dirs: { ...real, logs: strip('logs'), temp: strip('temp') } };
}

const under = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

describe('c536ce29 TRC-AC1 log roots resolve through @adhd/environment, never the cwd', () => {
  it('c536ce29 TRC-AC1 the spec declares logs+temp global-pinned and share:shared', () => {
    for (const key of ['logs', 'temp'] as const) {
      expect(agentMcpEnvironmentSpec.dirs?.[key]).toMatchObject({ kind: key, scope: 'global', share: 'shared' });
    }
  });

  it('c536ce29 TRC-AC1 ADHD_ENV_SCOPE=project in a git repo: every root is under <adhdRoot>/agent-mcp/production and none under cwd', () => {
    clearAmbient();
    setEnv('ADHD_ENV_SCOPE', 'project');
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    const env = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd });
    expect(env.scope).toBe('project'); // proves the control scenario really is project-scope
    const roots = resolveLogRoots(env);
    const base = join(adhdRoot, 'agent-mcp', 'production');
    expect(roots.root).toBe(join(base, 'logs'));
    expect(roots.api).toBe(join(base, 'logs', 'api'));
    expect(roots.ops).toBe(join(base, 'logs', 'ops'));
    expect(roots.trace).toBe(join(base, 'logs', 'trace'));
    expect(roots.temp).toBe(join(base, 'temp'));
    for (const p of Object.values(roots)) {
      expect(under(p, base)).toBe(true);
      expect(under(p, cwd)).toBe(false);
    }
  });

  it('c536ce29 TRC-AC1 with HOME faked and no adhdRoot the roots are under <HOME>/.adhd/agent-mcp/production (the real ~/.adhd default)', () => {
    clearAmbient();
    setEnv('ADHD_ENV_SCOPE', 'project');
    const home = scratch('trc-wirelog-home-');
    setEnv('HOME', home);
    setEnv('USERPROFILE', home);
    const cwd = gitRepoCwd();
    const roots = resolveLogRoots(makeEnv(agentMcpEnvironmentSpec, { cwd }));
    const base = join(home, '.adhd', 'agent-mcp', 'production');
    expect(roots.root).toBe(join(base, 'logs'));
    expect(roots.temp).toBe(join(base, 'temp'));
    for (const p of Object.values(roots)) {
      expect(under(p, base)).toBe(true);
      expect(under(p, cwd)).toBe(false);
      // never the repo-local scratch locations either
      expect(p).not.toContain(`${sep}tmp${sep}agent-mcp`);
    }
  });

  it('c536ce29 TRC-AC1 two Environment instances with different instanceIds resolve the SAME logs/temp roots', () => {
    clearAmbient();
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    const a = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd });
    const b = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd });
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(resolveLogRoots(b)).toEqual(resolveLogRoots(a));
    expect(resolveLogRoots(a).root).not.toContain(a.instanceId);
  });

  it('c536ce29 TRC-AC1 NEGATIVE CONTROL: without share:"shared" the roots embed the instanceId and differ per process start', () => {
    clearAmbient();
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    const spec = specWithout('share');
    const a = makeEnv(spec, { adhdRoot, cwd });
    const b = makeEnv(spec, { adhdRoot, cwd });
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(resolveLogRoots(a).root).toContain(a.instanceId);
    expect(resolveLogRoots(b).root).not.toBe(resolveLogRoots(a).root);
    expect(resolveLogRoots(b).temp).not.toBe(resolveLogRoots(a).temp);
  });

  it('c536ce29 TRC-AC1 NEGATIVE CONTROL: without scope:"global" ADHD_ENV_SCOPE=project puts the roots under cwd', () => {
    clearAmbient();
    setEnv('ADHD_ENV_SCOPE', 'project');
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    const roots = resolveLogRoots(makeEnv(specWithout('scope'), { adhdRoot, cwd }));
    expect(under(roots.root, cwd)).toBe(true);
    expect(under(roots.temp, cwd)).toBe(true);
  });

  it('c536ce29 TRC-AC1 logging.dir is an explicit operator override (env var), unset by default', () => {
    clearAmbient();
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    expect(makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd }).config.logging.dir).toBeUndefined();
    const custom = scratch('trc-wirelog-custom-');
    setEnv('ADHD_AGENT_LOGGING_DIR', custom);
    const roots = resolveLogRoots(makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd }));
    expect(roots.root).toBe(custom);
    expect(roots.api).toBe(join(custom, 'api'));
    expect(roots.trace).toBe(join(custom, 'trace'));
    expect(roots.temp).toBe(join(adhdRoot, 'agent-mcp', 'production', 'temp'));
  });
});

describe('c536ce29 TRC-AC17 zero-config defaults for the logging surface', () => {
  it('c536ce29 TRC-AC17 no env, no yaml: logging.* resolve to the documented defaults from the code spec', () => {
    clearAmbient();
    const env = makeEnv(agentMcpEnvironmentSpec, { adhdRoot: scratch('trc-wirelog-root-'), cwd: gitRepoCwd() });
    expect(env.config.logging).toMatchObject({
      level: 'info',
      instanceLabel: 'default',
      api: 'on',
      apiBodyMaxBytes: 4 * 1024 * 1024,
      apiRotateBytes: 64 * 1024 * 1024,
      apiRetentionDays: 14,
      apiMaxDirBytes: 2 * 1024 ** 3,
      opsRotateBytes: 16 * 1024 * 1024,
      opsRetentionDays: 60,
      opsMaxDirBytes: 256 * 1024 * 1024,
      traceRetentionDays: 30,
      traceMaxDirBytes: 512 * 1024 * 1024,
      floodMaxBytes: 256 * 1024 * 1024,
      floodWindowSeconds: 600,
    });
    expect(env.get('provenance.logging.api')).toMatchObject({ source: 'default' });
  });

  it('c536ce29 TRC-AC17 ADHD_AGENT_LOGGING_* env vars override; api=off is the only off-switch and is a value', () => {
    clearAmbient();
    setEnv('ADHD_AGENT_LOGGING_API', 'off');
    setEnv('ADHD_AGENT_LOGGING_INSTANCE_LABEL', 'sox-dev');
    setEnv('ADHD_AGENT_LOGGING_API_RETENTION_DAYS', '3');
    setEnv('ADHD_AGENT_LOGGING_API_BODY_MAX_BYTES', '1024');
    const env = makeEnv(agentMcpEnvironmentSpec, { adhdRoot: scratch('trc-wirelog-root-'), cwd: gitRepoCwd() });
    expect(env.config.logging).toMatchObject({
      api: 'off',
      instanceLabel: 'sox-dev',
      apiRetentionDays: 3,
      apiBodyMaxBytes: 1024,
    });
    expect(env.get('provenance.logging.api')).toMatchObject({ source: 'env' });
    // No enable/disable flag exists for ops or trace logs.
    const keys = Object.keys(agentMcpEnvironmentSpec.config).filter((k) => k.startsWith('logging.'));
    for (const k of keys) expect(k).not.toMatch(/enable|disable|toggle/i);
    for (const k of keys) {
      const e = (agentMcpEnvironmentSpec.config[k as keyof typeof agentMcpEnvironmentSpec.config] as { env?: string }).env;
      expect(e).toMatch(/^ADHD_AGENT_(LOG_LEVEL|LOGGING_[A-Z_]+)$/);
      expect(e).not.toMatch(/ENABLED|DISABLE/);
    }
  });

  it('c536ce29 TRC-AC17 invalid values are rejected (api enum, path-escaping instanceLabel)', () => {
    clearAmbient();
    const mk = () => makeEnv(agentMcpEnvironmentSpec, { adhdRoot: scratch('trc-wirelog-root-'), cwd: gitRepoCwd() });
    setEnv('ADHD_AGENT_LOGGING_API', 'maybe');
    expect(() => mk().config).toThrow();
    setEnv('ADHD_AGENT_LOGGING_API', undefined);
    setEnv('ADHD_AGENT_LOGGING_INSTANCE_LABEL', '../escape');
    expect(() => mk().config).toThrow();
    setEnv('ADHD_AGENT_LOGGING_INSTANCE_LABEL', 'a/b');
    expect(() => mk().config).toThrow();
  });

  it('c536ce29 TRC-AC17 ensureDirs on the zero-config env creates logs and temp under the adhd root only', () => {
    clearAmbient();
    const adhdRoot = scratch('trc-wirelog-root-');
    const cwd = gitRepoCwd();
    const env = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd });
    env.ensureDirs();
    const roots = resolveLogRoots(env);
    expect(existsSync(roots.root)).toBe(true);
    expect(existsSync(roots.temp)).toBe(true);
    expect(existsSync(join(cwd, '.adhd'))).toBe(false);
  });

  it('c536ce29 TRC-AC17 tracing.logDir default moves to <logs>/trace; an operator-set tracing.logDir still wins', () => {
    clearAmbient();
    const adhdRoot = scratch('trc-wirelog-root-');
    const env = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd: gitRepoCwd() });
    const roots = resolveLogRoots(env);
    const tracingOf = (entries: ReturnType<typeof defaultPluginEntries>) =>
      entries.find((e) => e.module === DEFAULT_TRACING_PLUGIN_MODULE)?.config as Record<string, unknown>;

    // Zero-config: the FieldSpec stays unset, the plugin is handed <logs>/trace.
    expect(env.config.tracing.logDir).toBeUndefined();
    const dflt = tracingOf(defaultPluginEntries({} as NodeJS.ProcessEnv, env.config.tracing, roots.trace));
    expect(dflt['logDir']).toBe(join(adhdRoot, 'agent-mcp', 'production', 'logs', 'trace'));
    expect(String(dflt['logDir'])).not.toContain('sox-ecosystem');

    // Operator override wins.
    const custom = join(adhdRoot, 'elsewhere');
    setEnv('ADHD_AGENT_TRACING_LOG_DIR', custom);
    const overridden = makeEnv(agentMcpEnvironmentSpec, { adhdRoot, cwd: gitRepoCwd() });
    expect(
      tracingOf(defaultPluginEntries({} as NodeJS.ProcessEnv, overridden.config.tracing, roots.trace))['logDir']
    ).toBe(custom);
  });
});
