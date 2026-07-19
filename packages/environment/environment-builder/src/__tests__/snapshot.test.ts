import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { EnvironmentSpec, SnapshotData } from '@adhd/environment-base-spec';
import { isEnvRef } from '@adhd/environment-base-spec';
import { buildSnapshot, writeSnapshot } from '../snapshot';
import { resolveRoots } from '../roots';
import { ValidationError } from '../validation';

type Cfg = { a: { port: number }; server?: { port: number }; db?: { secret: string } };

const cleanupDirs: string[] = [];
function mkFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-env-snapshot-'));
  cleanupDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildSnapshot — zero-config', () => {
  it('resolves entirely from spec defaults with no files on disk and no env vars set (DoD §7.2)', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'a.port': { type: 'integer', default: 8787 } } };
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    expect(snap.config.a.port).toBe(8787);
    expect(snap.provenance['a.port'].source).toBe('default');
  });

  it('negative control: a broken/absent default produces `undefined`, not a silently-passing 8787 — proves the assertion above has teeth', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'a.port': { type: 'integer' } } }; // no default supplied
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    expect(snap.config.a.port).toBeUndefined();
  });
});

describe('buildSnapshot — cascade via real files', () => {
  it('a project config.yaml overrides the default; a remapped env var overrides the file', () => {
    const projectRoot = mkFixtureDir();
    const adhdRoot = mkFixtureDir();
    const adhdDir = join(projectRoot, '.adhd', 't', 'default');
    mkdirSync(adhdDir, { recursive: true });
    writeFileSync(join(adhdDir, 'config.yaml'), 'a:\n  port: 9000\n', 'utf8');

    const spec: EnvironmentSpec<Cfg> = { config: { 'a.port': { type: 'integer', default: 8787 } } };

    const fileOnly = buildSnapshot<Cfg>('t', spec, { scope: 'project', cwd: projectRoot, adhdRoot, processEnv: {} });
    expect(fileOnly.config.a.port).toBe(9000);
    expect(fileOnly.provenance['a.port'].source).toBe('project');

    const withEnv = buildSnapshot<Cfg>('t', spec, {
      scope: 'project',
      cwd: projectRoot,
      adhdRoot,
      processEnv: { ADHD_T_A_PORT: '9999' },
    });
    expect(withEnv.config.a.port).toBe(9999);
    expect(withEnv.provenance['a.port']).toEqual({ source: 'env', scope: 'project', env: 'ADHD_T_A_PORT' });
  });
});

describe('buildSnapshot — validation', () => {
  it('throws ValidationError when a resolved value violates the generated JSON Schema', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'server.port': { type: 'integer', minimum: 1024, default: 1 } } };
    expect(() => buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} })).toThrow(ValidationError);
  });

  it('validates a secret field against its REAL type, not the opaque env-ref sentinel string', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'db.secret': { type: 'string', secret: true, default: 'x' } } };
    // Must not throw — even though the *stored* raw value is an env-ref string, validation
    // runs against the real typed value ("x"), which does satisfy type: string.
    expect(() => buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} })).not.toThrow();
  });
});

describe('buildSnapshot — dirs/files/hashes', () => {
  it('resolves declared dirs and files, and produces stable content/structure hashes', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = {
      config: { 'a.port': { type: 'integer', default: 1 } },
      dirs: { data: { kind: 'data' }, logs: { kind: 'logs' } },
      files: { db: { in: 'data', name: 'app.sqlite' } },
    };
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    expect(snap.dirs.map((d) => d.name).sort()).toEqual(['data', 'logs']);
    expect(snap.files[0].path).toContain('app.sqlite');
    expect(snap.configHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(snap.structureHash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('never stores a live/secret field plaintext in raw, config, or liveFields.fallback', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'db.secret': { type: 'string', secret: true, default: 'plaintext-x' } } };
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    expect(isEnvRef(snap.raw['db.secret'])).toBe(true);
    expect(snap.liveFields['db.secret'].fallback).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('plaintext-x');
  });

  it('negative control: a non-secret at:"runtime" field DOES keep its (non-sensitive) fallback in liveFields — proves the redaction above is secret-specific, not a blanket fallback wipe', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'server.port': { type: 'integer', at: 'runtime', default: 4000 } } };
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    expect(snap.liveFields['server.port'].fallback).toBe(4000);
  });
});

describe('buildSnapshot — namespace validation', () => {
  it('throws when options.namespace is not declared in the spec', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { namespaces: ['production'], config: {} };
    expect(() => buildSnapshot<Cfg>('t', spec, { scope: 'global', namespace: 'staging', adhdRoot, processEnv: {} })).toThrow(
      /not declared/,
    );
  });
});

describe('writeSnapshot', () => {
  it('persists the snapshot to disk under the active scope root, and it is a well-formed JSON file', () => {
    const adhdRoot = mkFixtureDir();
    const spec: EnvironmentSpec<Cfg> = { config: { 'a.port': { type: 'integer', default: 1 } } };
    const snap = buildSnapshot<Cfg>('t', spec, { scope: 'global', adhdRoot, processEnv: {} });
    const roots = resolveRoots({ project: 't', namespace: snap.namespace, orgNamespace: snap.orgNamespace, adhdRoot });
    const path = writeSnapshot(snap, roots);
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as SnapshotData<Cfg>;
    expect(onDisk.project).toBe('t');
    expect(onDisk.config.a.port).toBe(1);
  });
});
