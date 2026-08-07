/**
 * Zero-config proof for agent-mcp's REAL `AgentMcpConfig` spec
 * (`../config.js`'s `agentMcpEnvironmentSpec`, the exact spec the exported
 * `env` singleton is built from) — per this worktree's task DoD item 3 /
 * `packages/environment/ARCHITECTURE.md` §7.2/§7.7.
 *
 * Constructs a fresh `Environment<AgentMcpConfig>` from the real spec
 * against an ISOLATED, empty temp `adhdRoot`/`cwd` (so it can never see the
 * developer machine's real `~/.adhd/agent-mcp/production/config.yaml` or
 * this repo's own `.adhd/`), and proves:
 *  (a) `env.config.transport.port` resolves to the spec default (3000) with
 *      ZERO files on disk, zero env vars set — no consumer file/env write
 *      is ever a prerequisite.
 *  (b) setting the remapped env var (`ADHD_AGENT_PORT`) overrides it on a
 *      fresh construction.
 *  (c) negative control: (a)'s isolation actually matters — with the env
 *      var still set from (b), a NEW construction (still isolated from
 *      files) reflects the override, never silently falling back to the
 *      default; this proves the assertions above have teeth (a defaults-
 *      only / non-live implementation would fail this).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';

const cleanupDirs: string[] = [];

/** Isolated `adhdRoot` — proves nothing is read from/written to the real
 *  machine's `~/.adhd`. Lives under this project's `tmp/` per AGENTS.md §10. */
function mkAdhdRoot(): string {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'zero-config-test');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'root-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated `cwd` OUTSIDE this repo's git working tree — this repo itself
 *  has a `.git` marker a few directories up, which would spuriously flip
 *  scope resolution to `'project'` and defeat the "zero files on disk"
 *  isolation. `os.tmpdir()` has no such ancestor. */
function mkCwdFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-agent-mcp-cwd-'));
  cleanupDirs.push(dir);
  return dir;
}

function withEnvVar(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeEnv(adhdRoot: string, cwd: string) {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot,
    cwd,
  });
}

describe('agent-mcp real AgentMcpConfig spec — zero-config proof', () => {
  it('env.config.transport.port resolves to the spec default (3000) with zero files on disk and no env var set', () => {
    const restore = withEnvVar('ADHD_AGENT_PORT', undefined);
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture();

      const env = makeEnv(adhdRoot, cwd);

      expect(env.config.transport.port).toBe(3000);
      expect(env.get('config.transport.port')).toBe(3000);
      expect(env.get('provenance.transport.port')).toMatchObject({ source: 'default' });

      // No file was ever read OR written to construct this — the isolated
      // adhdRoot directory tree stays completely empty (dirs/snapshot are
      // resolved as strings, never eagerly created on disk).
      expect(existsSync(join(adhdRoot, 'agent-mcp'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('setting ADHD_AGENT_PORT overrides env.config.transport.port on a fresh construction', () => {
    const restore = withEnvVar('ADHD_AGENT_PORT', '4321');
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture();

      const env = makeEnv(adhdRoot, cwd);

      expect(env.config.transport.port).toBe(4321);
      expect(env.get('provenance.transport.port')).toMatchObject({ source: 'env', env: 'ADHD_AGENT_PORT' });
    } finally {
      restore();
    }
  });

  it('negative control: the override in the previous test is not a fluke of the default — with the env var STILL set, port is never silently 3000; proves the assertions above have teeth', () => {
    const restore = withEnvVar('ADHD_AGENT_PORT', '9999');
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture();

      const env = makeEnv(adhdRoot, cwd);

      expect(env.config.transport.port).toBe(9999);
      expect(env.config.transport.port).not.toBe(3000);
    } finally {
      restore();
    }
  });

  it('unsetting ADHD_AGENT_PORT again falls back to the spec default — the cascade is live per-construction, not sticky', () => {
    const setRestore = withEnvVar('ADHD_AGENT_PORT', '5555');
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const withOverride = makeEnv(adhdRoot, cwd);
    expect(withOverride.config.transport.port).toBe(5555);
    setRestore();

    const unsetRestore = withEnvVar('ADHD_AGENT_PORT', undefined);
    try {
      const withoutOverride = makeEnv(mkAdhdRoot(), mkCwdFixture());
      expect(withoutOverride.config.transport.port).toBe(3000);
    } finally {
      unsetRestore();
    }
  });

  it('the env-prefix guard covers both agent-mcp own config vars and provider credential vars (ADHD_AGENT_-prefixed)', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = makeEnv(adhdRoot, cwd);

    // Own config var (declared field env name).
    expect(env.isEnvNameAllowed('ADHD_AGENT_PORT')).toBe(true);
    // Provider credential var (not a declared config field, but still
    // ADHD_AGENT_-prefixed — envPrefixOverride:'ADHD_AGENT' exists
    // specifically to keep this true; see config.ts's header comment).
    expect(env.isEnvNameAllowed('ADHD_AGENT_OPENAI_SECRET')).toBe(true);
    // Anything outside the prefix is disallowed.
    expect(env.isEnvNameAllowed('PATH')).toBe(false);
    expect(env.isEnvNameAllowed('OPENAI_API_KEY')).toBe(false);
  });
});
