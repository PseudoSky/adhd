import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SnapshotData } from '@adhd/environment-base-spec';
import { Environment, EnvironmentError, SnapshotNotFoundError } from '../environment';

const PROJECT = 'test-project';
const NAMESPACE = 'default';
const SECRET_ENV_VAR = 'ADHD_TEST_PROVIDERS_OPENAI_SECRET';

function buildSnapshot(): SnapshotData {
  return {
    version: '1.0.0',
    libraryVersion: '0.0.1',
    generatedAt: '2026-07-09T00:00:00.000Z',
    project: {
      name: PROJECT,
      orgNamespace: 'adhd',
      envPrefix: 'ADHD_TEST',
      namespace: NAMESPACE,
    },
    config: {
      providers: {
        openai: {
          // ENV-CORE-009: redacted at build time — never the plaintext.
          secret: `adhd-secret-ref:${SECRET_ENV_VAR}`,
          model: 'gpt-4o',
        },
      },
      transport: {
        port: 4000,
      },
    },
    raw: {
      'providers.openai.secret': `adhd-secret-ref:${SECRET_ENV_VAR}`,
      'providers.openai.model': 'gpt-4o',
      'transport.port': 4000,
    },
    fieldSchema: null,
    configHash: 'sha256-test-hash',
    structureHash: 'sha256-test-structure-hash',
    dirs: [
      { type: 'state.data', path: '/tmp/adhd-test/state', scope: 'project' },
      { type: 'state.data', name: 'registry', path: '/tmp/adhd-test/state-registry', scope: 'project' },
      { type: 'runtime.log', path: '/tmp/adhd-test/log', scope: 'system' },
    ],
    provenance: {
      'providers.openai.secret': { source: 'project.env', scope: 'project', env: SECRET_ENV_VAR },
      'providers.openai.model': { source: 'project.default', scope: 'project' },
      'transport.port': { source: 'system.default', scope: 'system' },
    },
    envVars: {
      SOME_RECORDED_VAR: 'recorded-value',
    },
  };
}

describe('Environment (environment-core-node)', () => {
  let root: string;
  let previousSecretEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhd-environment-core-node-test-'));
    const snapshotDir = join(root, PROJECT, NAMESPACE);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'adhd-environment.json'), JSON.stringify(buildSnapshot()), 'utf8');
    previousSecretEnv = process.env[SECRET_ENV_VAR];
    delete process.env[SECRET_ENV_VAR];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousSecretEnv === undefined) {
      delete process.env[SECRET_ENV_VAR];
    } else {
      process.env[SECRET_ENV_VAR] = previousSecretEnv;
    }
  });

  it('constructs and exposes identity fields from the snapshot', () => {
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });
    expect(env.project).toBe(PROJECT);
    expect(env.namespace).toBe(NAMESPACE);
    expect(env.orgNamespace).toBe('adhd');
    expect(env.prefix).toBe('ADHD_TEST');
    expect(env.hash).toBe('sha256-test-hash');
    expect(env.snapshotPath).toBe(join(root, PROJECT, NAMESPACE, 'adhd-environment.json'));
  });

  // ENV-CORE-014 (HIGH, cross-language security parity gap): the TS runtime
  // client did NOT resolve `adhd-secret-ref:` values, unlike the Python and
  // Rust runtime clients — a secret-ref in a snapshot came back literally
  // instead of resolved. This test has teeth: it fails (returns the literal
  // `adhd-secret-ref:...` string) if `Environment.get`'s secret-ref
  // resolution is ever removed or bypassed.
  it('resolves a secret-ref config value from the live environment at read time (ENV-CORE-014)', () => {
    process.env[SECRET_ENV_VAR] = 'sk-live-secret-value';
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });

    const value = env.get('config.providers.openai.secret');

    expect(value).toBe('sk-live-secret-value');
    expect(value).not.toContain('adhd-secret-ref:');
  });

  it('returns undefined for a secret-ref config value when the referenced env var is unset', () => {
    delete process.env[SECRET_ENV_VAR];
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });

    expect(env.get('config.providers.openai.secret')).toBeUndefined();
  });

  it('returns non-secret config values unchanged', () => {
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });
    expect(env.get('config.providers.openai.model')).toBe('gpt-4o');
    expect(env.get('config.transport.port')).toBe(4000);
  });

  it('resolves path.* directory lookups, disambiguating bare type from type+name', () => {
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });
    expect(env.get('path.state.data')).toBe('/tmp/adhd-test/state');
    expect(env.get('path.state.data.registry')).toBe('/tmp/adhd-test/state-registry');
    expect(env.get('path.runtime.log')).toBe('/tmp/adhd-test/log');
  });

  it('resolves env.* and provenance.* lookups', () => {
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });
    expect(env.get('env.SOME_RECORDED_VAR')).toBe('recorded-value');
    expect(env.get('provenance.providers.openai.model')).toEqual({ source: 'project.default', scope: 'project' });
  });

  it('supports bracket access equivalent to get()', () => {
    process.env[SECRET_ENV_VAR] = 'sk-live-secret-value';
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });

    expect(env['config.transport.port']).toBe(env.get('config.transport.port'));
    expect(env['config.providers.openai.secret']).toBe(env.get('config.providers.openai.secret'));
    expect(env['config.providers.openai.secret']).toBe('sk-live-secret-value');
  });

  it('filters config and dirs by scope, and still resolves secret refs within the allowed scope', () => {
    process.env[SECRET_ENV_VAR] = 'sk-live-secret-value';
    const projectScoped = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root, scope: 'project' });
    const systemScoped = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root, scope: 'system' });

    // project-scoped: project fields resolve (including the secret ref), system fields hidden.
    expect(projectScoped.get('config.providers.openai.secret')).toBe('sk-live-secret-value');
    expect(projectScoped.get('config.transport.port')).toBeUndefined();
    expect(projectScoped.get('path.runtime.log')).toBeUndefined();

    // system-scoped: system fields resolve, project fields hidden.
    expect(systemScoped.get('config.transport.port')).toBe(4000);
    expect(systemScoped.get('config.providers.openai.secret')).toBeUndefined();
    expect(systemScoped.get('path.state.data')).toBeUndefined();
    expect(systemScoped.get('path.runtime.log')).toBe('/tmp/adhd-test/log');
  });

  it('throws SnapshotNotFoundError with a descriptive message when the snapshot is missing', () => {
    expect(() => new Environment({ project: 'no-such-project', namespace: NAMESPACE, adhdRoot: root })).toThrow(
      SnapshotNotFoundError,
    );
    try {
      new Environment({ project: 'no-such-project', namespace: NAMESPACE, adhdRoot: root });
      expect.unreachable('expected SnapshotNotFoundError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotNotFoundError);
      expect((err as Error).message).toContain('adhd-environment snapshot not found');
      expect((err as Error).message).toContain('no-such-project');
    }
  });

  it('rejects an empty project name', () => {
    expect(() => new Environment({ project: '', namespace: NAMESPACE, adhdRoot: root })).toThrow(EnvironmentError);
  });

  it('rejects a path-traversal project or namespace segment (ENV-CORE-006 parity)', () => {
    expect(() => new Environment({ project: '../escape', namespace: NAMESPACE, adhdRoot: root })).toThrow(
      EnvironmentError,
    );
    expect(() => new Environment({ project: PROJECT, namespace: '../escape', adhdRoot: root })).toThrow(
      EnvironmentError,
    );
  });

  it('returns a deep, frozen copy of the full snapshot via toJSON()', () => {
    const env = new Environment({ project: PROJECT, namespace: NAMESPACE, adhdRoot: root });
    const json = env.toJSON();
    expect(json.configHash).toBe('sha256-test-hash');
    expect(Object.isFrozen(json)).toBe(true);
  });
});
