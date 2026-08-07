/**
 * migration-admin.spec.ts — MIGRATION.md §4.4's "admin CLI call" half:
 * `setMigrationPhase`/`writeMigrationPhase` must durably persist to the
 * GLOBAL `config.yaml`, not just the current process's env var, and must
 * never clobber unrelated keys already in that file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildBacklogEnv } from './env.js';
import { globalConfigPath, writeMigrationPhase } from './migration-admin.js';
import { setMigrationPhase, migrationStatus, type BacklogCtx } from './client.js';
import { openTmpStore, freshTmpDir, type TmpStore } from './test/helpers/tmp-store.js';

describe('migration-admin — durable, cross-process migration.phase (MIGRATION.md §4.4)', () => {
  let adhdRoot: string;

  beforeEach(() => {
    adhdRoot = freshTmpDir('migration-admin');
  });

  it('globalConfigPath resolves under the isolated adhdRoot, never the real machine ~/.adhd', () => {
    const env = buildBacklogEnv({ scope: 'global', adhdRoot });
    const path = globalConfigPath(env, adhdRoot);
    expect(path.startsWith(adhdRoot)).toBe(true);
    expect(path.endsWith('config.yaml')).toBe(true);
    expect(path).toContain(`${env.project}`);
    expect(path).toContain(`${env.namespace}`);
  });

  it('writeMigrationPhase persists to disk and a FRESH Environment instance reads it back — proving it is a durable cross-process signal, not merely an in-memory value', () => {
    const env1 = buildBacklogEnv({ scope: 'global', adhdRoot });
    expect(env1.config.migration.phase).toBe('not-started');

    const path = writeMigrationPhase(env1, 'phase-2', adhdRoot);
    expect(existsSync(path)).toBe(true);

    // A brand-new Environment instance — never touched by env1 — must see the
    // new phase purely from disk. This is the negative control that
    // distinguishes "durable file write" from "mutated the in-memory config
    // object", which `Environment.config` deliberately never allows (it is
    // resolved once, at construction).
    const env2 = buildBacklogEnv({ scope: 'global', adhdRoot });
    expect(env2.config.migration.phase).toBe('phase-2');
  });

  it('preserves unrelated pre-existing keys in config.yaml instead of clobbering the whole file', () => {
    const env = buildBacklogEnv({ scope: 'global', adhdRoot });
    const path = globalConfigPath(env, adhdRoot);
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, 'db:\n  busyTimeoutMs: 9999\nlogging:\n  level: debug\n', 'utf8');

    writeMigrationPhase(env, 'phase-3', adhdRoot);

    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect((raw['migration'] as Record<string, unknown>)['phase']).toBe('phase-3');
    expect((raw['db'] as Record<string, unknown>)['busyTimeoutMs']).toBe(9999);
    expect((raw['logging'] as Record<string, unknown>)['level']).toBe('debug');
  });

  it('re-running writeMigrationPhase with the same phase is idempotent (no duplicate/nested migration keys)', () => {
    const env = buildBacklogEnv({ scope: 'global', adhdRoot });
    writeMigrationPhase(env, 'phase-2', adhdRoot);
    const path = writeMigrationPhase(env, 'phase-2', adhdRoot);
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(raw['migration']).toEqual({ phase: 'phase-2' });
  });

  describe('client.ts setMigrationPhase / migrationStatus integration', () => {
    let tmp: TmpStore;
    let ctx: BacklogCtx;

    beforeEach(() => {
      tmp = openTmpStore('migration-admin-client');
      ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'global', adhdRoot: tmp.dir }), adhdRoot: tmp.dir };
    });

    afterEach(() => {
      tmp.cleanup();
    });

    // NEGATIVE CONTROL, discovered for real (not hypothetical): the first
    // draft of this test omitted `adhdRoot: tmp.dir` on `ctx` (`BacklogCtx`
    // did not carry it yet). `setMigrationPhase` silently wrote to the REAL
    // machine-global `~/.adhd/backlog/production/config.yaml`, setting
    // `phase-4` on the actual shared store every agent on the machine reads
    // — reverted by hand immediately after discovery. `BacklogCtx.adhdRoot` +
    // this assertion exist specifically so that regression can never recur
    // silently: it asserts the write landed UNDER the isolated tmp root and
    // NOT under the real home directory.
    it('never writes outside the ctx-supplied adhdRoot (regression: a missing adhdRoot silently wrote to the real machine ~/.adhd)', async () => {
      const result = await setMigrationPhase(ctx, 'phase-4');
      expect(result.configPath.startsWith(tmp.dir)).toBe(true);
      // Not just "somewhere under $HOME" — this whole repo (and its tmp/
      // fixtures) already lives under $HOME, so that alone would trivially
      // pass. The real regression this guards is landing under the actual
      // machine-global `~/.adhd/backlog/...` specifically.
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      expect(result.configPath.startsWith(join(homedir(), '.adhd', 'backlog'))).toBe(false);
    });

    it('setMigrationPhase writes through and reports configPath + the same description/toolIsAuthoritative shape as migrationStatus', async () => {
      const result = await setMigrationPhase(ctx, 'phase-4');
      expect(result.phase).toBe('phase-4');
      expect(result.toolIsAuthoritative).toBe(true);
      expect(result.description).toContain('phase-4');
      expect(existsSync(result.configPath)).toBe(true);

      // The ORIGINAL ctx's env was already resolved before the write, so it
      // still reports the OLD phase (Environment.config is a point-in-time
      // snapshot, never live) — a fresh ctx is required to observe the
      // change, exactly like the negative control above.
      const staleRead = await migrationStatus(ctx);
      expect(staleRead.phase).toBe('not-started');

      const freshCtx: BacklogCtx = { store: tmp.store, env: buildBacklogEnv({ scope: 'global', adhdRoot: tmp.dir }), adhdRoot: tmp.dir };
      const freshRead = await migrationStatus(freshCtx);
      expect(freshRead.phase).toBe('phase-4');
      expect(freshRead.toolIsAuthoritative).toBe(true);
    });
  });
});
