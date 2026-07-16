import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build, EnvironmentSnapshot } from '../environment-snapshot';
import { ValidationError } from '../validation';
import type { ParsedYamlSpec } from '@adhd/environment-base-spec';

interface TestConfigShape extends Record<string, unknown> {
  data: { db: { path: string } };
  server: { port: number };
}

function makeSpec(overrides: Partial<ParsedYamlSpec> = {}): ParsedYamlSpec {
  return {
    project: { name: 'my-project', orgNamespace: 'adhd' },
    namespaces: ['default'],
    dirs: [],
    config: {
      system: {},
      global: {},
      project: {
        'data.db.path': { type: 'string', default: '/tmp/default.db' },
        'server.port': { type: 'integer', default: 3000, minimum: 1, maximum: 65535 },
      },
    },
    orgNamespace: 'adhd',
    envPrefix: 'ADHD_MY_PROJECT',
    ...overrides,
  };
}

describe('build()', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhd-env-snapshot-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an EnvironmentSnapshot exposing get/set/configPath/write', () => {
    const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
    expect(snap).toBeInstanceOf(EnvironmentSnapshot);
    expect(typeof snap.get).toBe('function');
    expect(typeof snap.set).toBe('function');
    expect(typeof snap.configPath).toBe('function');
    expect(typeof snap.write).toBe('function');
  });

  it('tolerates a minimal/loosely-typed spec (only project.name) without throwing', () => {
    const snap = build({ project: { name: 't' } } as unknown as ParsedYamlSpec, { adhdRoot: root });
    expect(['get', 'set', 'configPath', 'write'].every((m) => typeof (snap as any)[m] === 'function')).toBe(true);
  });

  it('resolves declared defaults into the nested config', () => {
    const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
    expect(snap.get('data.db.path')).toBe('/tmp/default.db');
    expect(snap.get('server.port')).toBe(3000);
  });

  it('round-trips set(path, value) -> get(path)', () => {
    const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
    snap.set('data.db.path', '/var/lib/my-project/data.db');
    expect(snap.get('data.db.path')).toBe('/var/lib/my-project/data.db');
    // Unrelated fields are untouched.
    expect(snap.get('server.port')).toBe(3000);
  });

  it('computes configPath() as <adhdRoot>/<orgNamespace>/<project>/<namespace>/adhd-environment.json', () => {
    const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
    expect(snap.configPath()).toBe(join(root, 'adhd', 'my-project', 'default', 'adhd-environment.json'));
  });

  it('honors an explicit namespace', () => {
    const snap = build<TestConfigShape>(makeSpec({ namespaces: ['default', 'production'] }), {
      adhdRoot: root,
      namespace: 'production',
    });
    expect(snap.configPath()).toBe(join(root, 'adhd', 'my-project', 'production', 'adhd-environment.json'));
  });

  it('rejects a namespace that was not declared', () => {
    expect(() => build<TestConfigShape>(makeSpec(), { adhdRoot: root, namespace: 'staging' })).toThrow(/not declared/);
  });

  describe('.write()', () => {
    it('produces a real file at configPath() containing the current config', () => {
      const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
      snap.set('data.db.path', '/var/lib/my-project/data.db');
      snap.write();

      const configPath = snap.configPath();
      expect(existsSync(configPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(onDisk.config.data.db.path).toBe('/var/lib/my-project/data.db');
      expect(onDisk.raw['data.db.path']).toBe('/var/lib/my-project/data.db');
    });

    it('writes atomically: no .tmp file left behind after a successful write', () => {
      const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
      snap.write();
      expect(existsSync(`${snap.configPath()}.tmp`)).toBe(false);
    });

    it('never writes a partial/invalid file when the config fails schema validation', () => {
      const snap = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
      // Violates the declared `maximum: 65535` constraint on server.port.
      snap.set('server.port', 999999 as unknown as number);

      const configPath = snap.configPath();
      expect(() => snap.write()).toThrow(ValidationError);
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(`${configPath}.tmp`)).toBe(false);
    });

    it('rejects an invalid config at build() time too, before any write is attempted', () => {
      const spec = makeSpec();
      spec.config.project['server.port'] = { type: 'integer', default: 999999, minimum: 1, maximum: 65535 };
      expect(() => build<TestConfigShape>(spec, { adhdRoot: root })).toThrow(ValidationError);
    });
  });

  describe('rebuild from an existing EnvironmentSnapshot', () => {
    it('build(existingSnapshot) preserves values applied via .set() across the rebuild', () => {
      const first = build<TestConfigShape>(makeSpec(), { adhdRoot: root });
      first.set('data.db.path', '/custom/path/data.db');

      const rebuilt = build<TestConfigShape>(first, { adhdRoot: root });
      expect(rebuilt).toBeInstanceOf(EnvironmentSnapshot);
      expect(rebuilt).not.toBe(first);
      // The override survives the rebuild even though a fresh resolve would
      // otherwise have produced the YAML-declared default.
      expect(rebuilt.get('data.db.path')).toBe('/custom/path/data.db');
      // Fields never touched by .set() still resolve fresh from the spec.
      expect(rebuilt.get('server.port')).toBe(3000);
    });

    it('rebuild keeps the original namespace unless overridden', () => {
      const first = build<TestConfigShape>(makeSpec({ namespaces: ['default', 'production'] }), {
        adhdRoot: root,
        namespace: 'production',
      });
      const rebuilt = build<TestConfigShape>(first, { adhdRoot: root });
      expect(rebuilt.configPath()).toBe(join(root, 'adhd', 'my-project', 'production', 'adhd-environment.json'));
    });
  });
});
