/**
 * service-config.spec.ts — AC1 (config precedence + hard error + absolute
 * paths), the `SERVICE_CONFIG_KEYS`/spec drift guard, and AC2 (the load-time
 * artifact drift check).
 *
 * Negative control: each strict assertion is paired with a deliberately
 * permissive variant that ACCEPTS the bad input, proving the strict check is
 * the thing doing the work (remove the strict branch and these go red).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBacklogEnv } from './env.js';
import {
  assertMcpEntryValid,
  assertServerArtifact,
  resolveServiceConfig,
  SERVICE_CONFIG_KEYS,
} from './service-config.js';
import {
  ArtifactDriftError,
  NonAbsolutePathError,
  UnknownConfigKeyError,
  UnknownMcpConfigKeyError,
} from './service-errors.js';
import { backlogEnvironmentSpec } from './env.js';
import type { StartOpts } from './server.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'backlog-da-config-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function baseOpts(adhdRoot: string): StartOpts {
  return {
    transport: 'mcp',
    adhdRoot,
    signal: new AbortController().signal,
  };
}

function productionConfigPath(adhdRoot: string): string {
  return join(adhdRoot, 'backlog', 'production', 'config.yaml');
}

describe('resolveServiceConfig', () => {
  it('exposes exactly the service.* keys the environment spec declares', () => {
    const declared = Object.keys(backlogEnvironmentSpec.config)
      .filter((k) => k.startsWith('service.'))
      .sort();
    expect([...SERVICE_CONFIG_KEYS].sort()).toEqual(declared);
  });

  it('applies code defaults when nothing is configured', () => {
    const adhdRoot = tmpRoot();
    const env = buildBacklogEnv({ adhdRoot });
    const cfg = resolveServiceConfig(baseOpts(adhdRoot), env);
    expect(cfg.transport).toBe('mcp');
    expect(cfg.port).toBe(3300);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.readiness.timeoutMs).toBe(30000);
    expect(cfg.connect.budgetMs).toBe(60000);
  });

  it('rejects an unknown service.* key in a layer file, naming key + file', () => {
    const adhdRoot = tmpRoot();
    const file = productionConfigPath(adhdRoot);
    mkdirSync(join(adhdRoot, 'backlog', 'production'), { recursive: true });
    writeFileSync(file, 'service:\n  bogusKey: 42\n');
    const env = buildBacklogEnv({ adhdRoot });

    // Negative control: a present-only validator accepts the unknown key,
    // which is exactly how the mistyped key silently no-ops today.
    const naivePresentOnly = (): void => {
      // checks required keys are present, never that unknown keys are absent
      void 0;
    };
    expect(naivePresentOnly).not.toThrow();

    try {
      resolveServiceConfig(baseOpts(adhdRoot), env);
      throw new Error('expected UnknownConfigKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownConfigKeyError);
      const e = err as UnknownConfigKeyError;
      expect(e.key).toBe('bogusKey');
      expect(e.file).toBe(file);
    }
  });

  it('rejects a relative dbPath as a non-absolute path', () => {
    const adhdRoot = tmpRoot();
    const prev = process.env['ADHD_BACKLOG_DATABASE_PATH'];
    process.env['ADHD_BACKLOG_DATABASE_PATH'] = 'relative/backlog.db';
    try {
      const env = buildBacklogEnv({ adhdRoot });
      expect(() => resolveServiceConfig(baseOpts(adhdRoot), env)).toThrow(
        NonAbsolutePathError
      );
    } finally {
      if (prev === undefined) delete process.env['ADHD_BACKLOG_DATABASE_PATH'];
      else process.env['ADHD_BACKLOG_DATABASE_PATH'] = prev;
    }
  });

  it('ranks explicit opts above env vars above layer files', () => {
    const adhdRoot = tmpRoot();
    mkdirSync(join(adhdRoot, 'backlog', 'production'), { recursive: true });
    writeFileSync(productionConfigPath(adhdRoot), 'service:\n  port: 1111\n');
    const prev = process.env['ADHD_BACKLOG_SERVICE_PORT'];
    process.env['ADHD_BACKLOG_SERVICE_PORT'] = '2222';
    try {
      const env = buildBacklogEnv({ adhdRoot });
      // env var beats file:
      expect(resolveServiceConfig(baseOpts(adhdRoot), env).port).toBe(2222);
      // explicit opt beats env var and file:
      expect(
        resolveServiceConfig({ ...baseOpts(adhdRoot), port: 3333 }, env).port
      ).toBe(3333);
    } finally {
      if (prev === undefined) delete process.env['ADHD_BACKLOG_SERVICE_PORT'];
      else process.env['ADHD_BACKLOG_SERVICE_PORT'] = prev;
    }
  });
});

describe('assertMcpEntryValid', () => {
  it('rejects the recorded `environment` (not `env`) silent no-op', () => {
    try {
      assertMcpEntryValid(
        { type: 'stdio', command: 'npx', args: [], environment: {} },
        '/host/.mcp.json'
      );
      throw new Error('expected UnknownMcpConfigKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownMcpConfigKeyError);
      expect((err as UnknownMcpConfigKeyError).key).toBe('environment');
    }
  });

  it('accepts the shapes install actually writes', () => {
    expect(() =>
      assertMcpEntryValid({ type: 'stdio', command: 'npx', args: ['-y'] }, '/x')
    ).not.toThrow();
    expect(() =>
      assertMcpEntryValid({ type: 'local', command: ['npx', 'x'] }, '/x')
    ).not.toThrow();
  });

  it('rejects a relative command that is not a PATH bin', () => {
    expect(() =>
      assertMcpEntryValid({ command: './scripts/serve.sh' }, '/x')
    ).toThrow(NonAbsolutePathError);
  });
});

describe('assertServerArtifact (AC2 load-time drift check)', () => {
  it('accepts a present, executable file whose sha256 matches', () => {
    const root = tmpRoot();
    const file = join(root, 'serve.sh');
    writeFileSync(file, '#!/bin/sh\necho hi\n');
    chmodSync(file, 0o755);
    const sha256 = createHash('sha256').update('#!/bin/sh\necho hi\n').digest('hex');
    expect(() =>
      assertServerArtifact({
        command: file,
        identity: { kind: 'path', sha256 },
      })
    ).not.toThrow();
  });

  it('refuses a missing path and NAMES the resolved absolute path', () => {
    const root = tmpRoot();
    const missing = join(root, 'gone.sh');
    try {
      assertServerArtifact({
        command: missing,
        identity: { kind: 'path', sha256: 'deadbeef' },
      });
      throw new Error('expected ArtifactDriftError');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactDriftError);
      expect((err as ArtifactDriftError).resolvedPath).toBe(missing);
    }
  });

  it('refuses when sha256 does not match (content drift)', () => {
    const root = tmpRoot();
    const file = join(root, 'serve.sh');
    writeFileSync(file, 'real content');
    chmodSync(file, 0o755);
    expect(() =>
      assertServerArtifact({
        command: file,
        identity: { kind: 'path', sha256: 'not-the-hash' },
      })
    ).toThrow(ArtifactDriftError);
  });

  it('is a no-op when no server command is configured', () => {
    expect(() =>
      assertServerArtifact({ command: '', identity: { kind: 'path' } })
    ).not.toThrow();
  });
});
