import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { ValidationError } from '@adhd/environment-builder';
import { Environment, EnvironmentError, SnapshotNotFoundError } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture } from '../test/fixtures';

type Cfg = { transport: { port: number; kind: string }; db: { path: string }; logging: { level: string } };

const SPEC = {
  config: {
    'transport.port': { type: 'integer' as const, default: 4000 },
    'transport.kind': { type: 'string' as const, default: 'stdio' },
    'db.path': { type: 'string' as const, default: './data.db' },
    'logging.level': { type: 'string' as const, default: 'info' },
  },
  dirs: { data: { kind: 'data' as const }, logs: { kind: 'logs' as const } },
  files: { db: { in: 'data', name: 'app.sqlite' } },
};

function makeEnv(adhdRoot: string, cwd: string) {
  return new Environment<Cfg>('agent-mcp-test', SPEC, { scope: 'global', adhdRoot, cwd });
}

afterEach(() => {
  cleanupFixtures();
});

describe('Environment — identity + config surface', () => {
  it('exposes project/namespace/orgNamespace/scope/prefix/instanceId', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.project).toBe('agent-mcp-test');
    expect(env.namespace).toBe('default');
    expect(env.orgNamespace).toBe('adhd');
    expect(env.scope).toBe('global');
    expect(env.prefix).toBe('ADHD_AGENT_MCP_TEST');
    expect(typeof env.instanceId).toBe('string');
    expect(env.instanceId.length).toBeGreaterThan(0);
  });

  it('mirrors the real agent-mcp consumer surface (ARCHITECTURE.md §3.2/§6)', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.config.transport.port).toBe(4000);
    expect(env.config.transport.kind).toBe('stdio');
    expect(env.config.db.path).toBe('./data.db');
    expect(env.config.logging.level).toBe('info');
  });

  it('exposes version metadata computed live', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.version.configHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(env.version.structureHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(env.hash).toBe(env.version.configHash);
    expect(typeof env.version.generatedAt).toBe('string');
  });
});

describe('Environment#get — dynamic dot-path accessor', () => {
  it('config.* reads through to the config tree', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.get('config.transport.port')).toBe(4000);
  });

  it('path.* reads a declared dirs key', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.get('path.data')).toBe(env.paths.data);
    expect(typeof env.get('path.data')).toBe('string');
  });

  it('provenance.* reads a field provenance entry', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.get('provenance.transport.port')).toEqual({ source: 'default', scope: 'global' });
  });

  it('an unknown prefix or a key with no dot returns undefined, never throws', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.get('nope')).toBeUndefined();
    expect(env.get('bogus.path')).toBeUndefined();
  });
});

describe('Environment — bracket-access proxy (env["config.x"] === env.get("config.x"))', () => {
  it('dispatches unknown string keys through get()', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env['config.transport.port']).toBe(env.get('config.transport.port'));
    expect(env['path.data']).toBe(env.get('path.data'));
  });

  it('real members are NOT intercepted by the proxy (project, config, paths, ...)', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.project).toBe('agent-mcp-test');
    expect(env.paths).toBe(env.paths); // stable identity, not re-derived through get()
  });
});

describe('Environment — resolveEnvName / isEnvNameAllowed', () => {
  it('isEnvNameAllowed is true for a name within the project prefix, false otherwise', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.isEnvNameAllowed('ADHD_AGENT_MCP_TEST_OPENAI_SECRET')).toBe(true);
    expect(env.isEnvNameAllowed('PATH')).toBe(false);
    expect(env.isEnvNameAllowed('HOME')).toBe(false);
  });

  it('resolveEnvName reads a live, allowed env var; returns undefined when disallowed or unset', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    const varName = 'ADHD_AGENT_MCP_TEST_CUSTOM_SECRET';
    expect(env.resolveEnvName(varName)).toBeUndefined();
    process.env[varName] = 'sk-value';
    try {
      expect(env.resolveEnvName(varName)).toBe('sk-value');
      expect(env.resolveEnvName('PATH')).toBeUndefined(); // disallowed even if set
    } finally {
      delete process.env[varName];
    }
  });
});

describe('Environment — paths/files', () => {
  it('paths are resolved strings, not created eagerly', () => {
    const adhdRoot = mkAdhdRoot();
    const env = makeEnv(adhdRoot, mkCwdFixture());
    expect(typeof env.paths.data).toBe('string');
    expect(existsSync(env.paths.data)).toBe(false);
  });

  it('ensureDirs() creates every declared directory on disk', () => {
    const adhdRoot = mkAdhdRoot();
    const env = makeEnv(adhdRoot, mkCwdFixture());
    expect(existsSync(env.paths.data)).toBe(false);
    env.ensureDirs();
    expect(existsSync(env.paths.data)).toBe(true);
    expect(existsSync(env.paths.logs)).toBe(true);
  });

  it('files resolve inside their declared parent directory', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    expect(env.files.db).toContain('app.sqlite');
    expect(env.files.db.startsWith(env.paths.data)).toBe(true);
  });
});

describe('Environment — validation propagation', () => {
  it('throws ValidationError (re-exported from @adhd/environment-builder) when a resolved value violates the schema', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    expect(
      () =>
        new Environment('t', { config: { 'server.port': { type: 'integer', minimum: 1024, default: 1 } } }, {
          scope: 'global',
          adhdRoot,
          cwd,
        }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty project name', () => {
    expect(() => new Environment('', { config: {} }, { scope: 'global', adhdRoot: mkAdhdRoot(), cwd: mkCwdFixture() })).toThrow(
      EnvironmentError,
    );
  });
});

describe('Environment#write / Environment.fromSnapshot — round trip', () => {
  it('write() persists a well-formed JSON snapshot at snapshotPath', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    const path = env.write();
    expect(path).toBe(env.snapshotPath);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.project).toBe('agent-mcp-test');
    expect(onDisk.config.transport.port).toBe(4000);
  });

  it('fromSnapshot reads the persisted snapshot and exposes the same config/paths/get() surface', () => {
    const original = makeEnv(mkAdhdRoot(), mkCwdFixture());
    original.write();

    const loaded = Environment.fromSnapshot<Cfg>(original.snapshotPath);
    expect(loaded.project).toBe(original.project);
    expect(loaded.config.transport.port).toBe(4000);
    expect(loaded.get('config.db.path')).toBe('./data.db');
    expect(loaded.paths.data).toBe(original.paths.data);
  });

  it('fromSnapshot throws SnapshotNotFoundError for a missing file — never silently returns an empty environment', () => {
    expect(() => Environment.fromSnapshot(`${mkAdhdRoot()}/does-not-exist/adhd-environment.json`)).toThrow(
      SnapshotNotFoundError,
    );
  });

  it('fromSnapshot resolves a secret field live from process.env too, never the persisted env-ref sentinel', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const varName = 'ADHD_AGENT_MCP_TEST_DB_SECRET';
    const original = new Environment<{ db: { secret: string } }>(
      'agent-mcp-test',
      { config: { 'db.secret': { type: 'string', secret: true } } },
      { scope: 'global', adhdRoot, cwd },
    );
    original.write();

    process.env[varName] = 'sk-from-fromSnapshot';
    try {
      const loaded = Environment.fromSnapshot<{ db: { secret: string } }>(original.snapshotPath);
      expect(loaded.config.db.secret).toBe('sk-from-fromSnapshot');
    } finally {
      delete process.env[varName];
    }
  });
});

describe('Environment#toJSON', () => {
  it('returns a deep-frozen copy of the resolved snapshot', () => {
    const env = makeEnv(mkAdhdRoot(), mkCwdFixture());
    const json = env.toJSON();
    expect(json.project).toBe('agent-mcp-test');
    expect(Object.isFrozen(json)).toBe(true);
  });
});
