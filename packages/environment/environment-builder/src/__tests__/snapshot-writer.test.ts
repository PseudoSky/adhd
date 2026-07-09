import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNoNamespaceConflict,
  atomicWrite,
  DEFAULT_SNAPSHOT_DIR_MODE,
  DEFAULT_SNAPSHOT_FILE_MODE,
  detectDrift,
  DriftError,
  NamespaceConflictError,
  readExistingSnapshot,
  resolveConfigPath,
  resolveDirs,
} from '../snapshot-writer';
import { redactSecrets } from '../config-resolver';
import { unflatten } from '../config-resolver';
import type { ConfigFieldDefinition, ResolvedDirectoryEntry, SnapshotData } from '@adhd/environment-base-spec';

describe('resolveConfigPath', () => {
  it('builds <adhdRoot>/<org>/<project>/<namespace>/adhd-environment.json', () => {
    expect(resolveConfigPath('/Users/nix/.adhd', 'adhd', 'agent-mcp', 'production')).toBe(
      join('/Users/nix/.adhd', 'adhd', 'agent-mcp', 'production', 'adhd-environment.json'),
    );
  });

  it('includes the "default" namespace segment explicitly (no namespace is ever omitted at the builder level)', () => {
    expect(resolveConfigPath('/Users/nix/.adhd', 'adhd', 'agent-mcp', 'default')).toBe(
      join('/Users/nix/.adhd', 'adhd', 'agent-mcp', 'default', 'adhd-environment.json'),
    );
  });

  it('honors a non-default orgNamespace', () => {
    expect(resolveConfigPath('/Users/nix/.acme', 'acme', 'agent-mcp', 'default')).toBe(
      join('/Users/nix/.acme', 'acme', 'agent-mcp', 'default', 'adhd-environment.json'),
    );
  });
});

describe('atomicWrite', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhd-atomic-write-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the file, and no .tmp file is left behind on success', () => {
    const filePath = join(dir, 'nested', 'deep', 'adhd-environment.json');
    atomicWrite(filePath, { hello: 'world' });
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ hello: 'world' });
  });

  it('creates the parent directory tree if it does not exist', () => {
    const filePath = join(dir, 'a', 'b', 'c', 'snapshot.json');
    atomicWrite(filePath, { ok: true });
    expect(existsSync(filePath)).toBe(true);
  });

  it('accepts a pre-serialized string payload as-is', () => {
    const filePath = join(dir, 'raw.json');
    atomicWrite(filePath, '{"raw":true}');
    expect(readFileSync(filePath, 'utf8')).toBe('{"raw":true}');
  });

  // ENV-CORE-010 — the credential-bearing snapshot must not be world-readable.
  it('creates the snapshot 0o600 and its parent directory 0o700 by default', () => {
    const subdir = join(dir, 'sub');
    const filePath = join(subdir, 'adhd-environment.json');
    atomicWrite(filePath, { ok: true });
    expect(statSync(filePath).mode & 0o777).toBe(DEFAULT_SNAPSHOT_FILE_MODE);
    expect(statSync(subdir).mode & 0o777).toBe(DEFAULT_SNAPSHOT_DIR_MODE);
    expect(DEFAULT_SNAPSHOT_FILE_MODE).toBe(0o600);
    expect(DEFAULT_SNAPSHOT_DIR_MODE).toBe(0o700);
  });

  // ENV-CORE-011 — a failed rename must not leave a stale plaintext .tmp.
  it('unlinks the .tmp and rethrows when the rename fails, leaving no stale plaintext behind', () => {
    // Make the destination an existing non-empty directory so renameSync throws.
    const filePath = join(dir, 'snap.json');
    mkdirSync(filePath);
    mkdirSync(join(filePath, 'child'));
    expect(() => atomicWrite(filePath, { secret: 'sk-must-not-persist' })).toThrow();
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    // And the secret never reached the (would-be) tmp on disk.
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  // ENV-CORE-009 — a resolved secret value must never appear in the file bytes.
  it('writes a snapshot whose secret field is a reference, never the plaintext value', () => {
    const fields: Record<string, ConfigFieldDefinition> = {
      'providers.openai.secret': {
        type: 'string',
        default: '',
        scope: 'project',
        sourceScope: 'project',
        env: 'OPENAI_API_KEY',
        secret: true,
      },
      'db.path': { type: 'string', default: '', scope: 'project', sourceScope: 'project', env: 'ADHD_X_DB_PATH' },
    };
    const resolvedRaw = { 'providers.openai.secret': 'sk-live-should-not-persist', 'db.path': '/tmp/db' };
    const redacted = redactSecrets(resolvedRaw, fields);
    const snapshot = {
      version: '0.0.5',
      raw: redacted,
      config: unflatten(redacted),
    };
    const filePath = join(dir, 'agent-mcp', 'default', 'adhd-environment.json');
    atomicWrite(filePath, snapshot);
    const bytes = readFileSync(filePath, 'utf8');
    expect(bytes).toContain('adhd-secret-ref:OPENAI_API_KEY');
    expect(bytes).not.toContain('sk-live-should-not-persist');
    // Non-secret fields are untouched.
    expect(bytes).toContain('/tmp/db');
  });
});

describe('resolveDirs', () => {
  const ctx = { adhdRoot: '/Users/nix/.adhd', orgNamespace: 'adhd', project: 'agent-mcp', namespace: 'production' };

  it('auto-derives a path when dir.path is absent', () => {
    const [resolved] = resolveDirs([{ type: 'state.data', name: 'primary', scope: 'project' }], ctx);
    expect(resolved.path).toBe(join(ctx.adhdRoot, ctx.orgNamespace, ctx.project, ctx.namespace, 'project', 'state.data', 'primary'));
    expect(resolved.scope).toBe('project');
  });

  it('defaults scope to "project" when unset', () => {
    const [resolved] = resolveDirs([{ type: 'runtime.log' }], ctx);
    expect(resolved.scope).toBe('project');
  });

  it('interpolates ${HOME} in an explicit path', () => {
    const [resolved] = resolveDirs([{ type: 'state.data', path: '${HOME}/custom/data' }], ctx);
    expect(resolved.path.endsWith('/custom/data')).toBe(true);
    expect(resolved.path).not.toContain('${HOME}');
  });

  it('interpolates ${NAMESPACE} in an explicit path', () => {
    const [resolved] = resolveDirs([{ type: 'state.data', path: '/data/${NAMESPACE}/db' }], ctx);
    expect(resolved.path).toBe('/data/production/db');
  });

  it('interpolates ${PROJECT_ROOT} in an explicit path', () => {
    const [resolved] = resolveDirs([{ type: 'state.data', path: '${PROJECT_ROOT}/db' }], { ...ctx, projectRoot: '/repo/agent-mcp' });
    expect(resolved.path).toBe('/repo/agent-mcp/db');
  });

  it('resolves an empty dirs array to an empty array', () => {
    expect(resolveDirs([], ctx)).toEqual([]);
  });
});

describe('readExistingSnapshot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhd-read-existing-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(readExistingSnapshot(join(dir, 'missing.json'))).toBeNull();
  });

  it('returns null when the file is corrupt JSON', () => {
    const filePath = join(dir, 'corrupt.json');
    atomicWrite(filePath, '{not json');
    expect(readExistingSnapshot(filePath)).toBeNull();
  });

  it('parses a well-formed snapshot file', () => {
    const filePath = join(dir, 'snap.json');
    const snapshot = { project: { name: 'agent-mcp' } };
    atomicWrite(filePath, snapshot);
    expect(readExistingSnapshot(filePath)).toEqual(snapshot);
  });
});

function makeResolvedDir(
  type: ResolvedDirectoryEntry['type'],
  name: string | undefined,
  scope: string,
  path = '/x',
): ResolvedDirectoryEntry {
  return { type, name, path, scope };
}

describe('detectDrift', () => {
  it('reports no drift when dirs are identical', () => {
    const dirs = [makeResolvedDir('state.data', 'primary', 'project')];
    expect(detectDrift(dirs, dirs)).toEqual({ added: [], removed: [], typeChanges: [], scopeChanges: [] });
  });

  it('reports an added directory', () => {
    const existing = [makeResolvedDir('state.data', 'primary', 'project')];
    const next = [makeResolvedDir('state.data', 'primary', 'project'), makeResolvedDir('runtime.log', undefined, 'project')];
    const drift = detectDrift(existing, next);
    expect(drift.added).toEqual(['index:1']);
    expect(drift.removed).toEqual([]);
  });

  it('reports a removed directory', () => {
    const existing = [makeResolvedDir('state.data', 'primary', 'project'), makeResolvedDir('runtime.log', undefined, 'project')];
    const next = [makeResolvedDir('state.data', 'primary', 'project')];
    const drift = detectDrift(existing, next);
    expect(drift.removed).toEqual(['index:1']);
    expect(drift.added).toEqual([]);
  });

  it('reports a type change for the same key', () => {
    const existing = [makeResolvedDir('state.data', 'primary', 'project')];
    const next = [makeResolvedDir('runtime.cache', 'primary', 'project')];
    const drift = detectDrift(existing, next);
    expect(drift.typeChanges).toEqual([{ key: 'name:primary', from: 'state.data', to: 'runtime.cache' }]);
  });

  it('reports a scope change for the same key', () => {
    const existing = [makeResolvedDir('state.data', 'primary', 'project')];
    const next = [makeResolvedDir('state.data', 'primary', 'global')];
    const drift = detectDrift(existing, next);
    expect(drift.scopeChanges).toEqual([{ key: 'name:primary', from: 'project', to: 'global' }]);
  });

  it('distinguishes dirs by name when the same type has multiple entries', () => {
    const existing = [makeResolvedDir('state.data', 'primary', 'project'), makeResolvedDir('state.data', 'registry', 'project')];
    const next = [makeResolvedDir('state.data', 'primary', 'project')];
    const drift = detectDrift(existing, next);
    expect(drift.removed).toEqual(['name:registry']);
  });

  it('DriftError carries the drift result and a descriptive message', () => {
    const drift = { added: [], removed: [], typeChanges: [{ key: 'k', from: 'a', to: 'b' }], scopeChanges: [] };
    const error = new DriftError(drift);
    expect(error.drift).toBe(drift);
    expect(error.message).toMatch(/1 type change/);
  });
});

describe('assertNoNamespaceConflict', () => {
  it('does nothing when there is no existing snapshot', () => {
    expect(() => assertNoNamespaceConflict(null, 'agent-mcp', '/path/to/snap.json')).not.toThrow();
  });

  it('does nothing when the existing snapshot belongs to the same project', () => {
    const existing: Pick<SnapshotData, 'project'> = {
      project: { name: 'agent-mcp', orgNamespace: 'adhd', envPrefix: 'ADHD_AGENT_MCP', namespace: 'default' },
    };
    expect(() => assertNoNamespaceConflict(existing, 'agent-mcp', '/path/to/snap.json')).not.toThrow();
  });

  it('throws NamespaceConflictError when the existing snapshot belongs to a different project', () => {
    const existing: Pick<SnapshotData, 'project'> = {
      project: { name: 'other-project', orgNamespace: 'adhd', envPrefix: 'ADHD_OTHER_PROJECT', namespace: 'default' },
    };
    expect(() => assertNoNamespaceConflict(existing, 'agent-mcp', '/path/to/snap.json')).toThrow(NamespaceConflictError);
  });
});
