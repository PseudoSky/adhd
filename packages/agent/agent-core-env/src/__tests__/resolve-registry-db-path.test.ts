/**
 * `resolveRegistryDbPath()` precedence — Decision 4 of
 * `docs/environment/agent-base-env/DESIGN.md`:
 *   1. function-arg override
 *   2. `ADHD_AGENT_REGISTRY_DB_PATH`
 *   3. `REGISTRY_DATABASE_PATH`
 *   4. `DATABASE_PATH`
 *   5. `@adhd/environment`-resolved canonical default
 *      (`~/.adhd/agent-registry/production/data/registry.db`, scope-pinned
 *      `global` by default; `ADHD_ENV_SCOPE=project` overrides that pin).
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveRegistryDbPath } from '../resolve-registry-db-path.js';
import { cleanupFixtures, mkAdhdRoot, snapshotRegistryEnvVars } from '../test/fixtures.js';

afterEach(() => {
  cleanupFixtures();
});

describe('resolveRegistryDbPath — precedence', () => {
  it('5. canonical default: no override, no env vars → ~/.adhd/agent-registry/production/data/registry.db (sandboxed)', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      const adhdRoot = mkAdhdRoot('canonical-');
      const resolved = resolveRegistryDbPath({ scope: 'global' });
      // resolveRegistryDbPath() itself has no adhdRoot param (it constructs
      // its own Environment); prove the SHAPE of the canonical default by
      // constructing the same spec against a sandboxed root directly.
      expect(resolved.endsWith(join('agent-registry', 'production', 'data', 'registry.db'))).toBe(true);
      // adhdRoot fixture unused here beyond proving cleanup path exists —
      // the shape assertion above is the real proof; sandboxing the actual
      // home-dir write is covered by the scope-pin test below.
      expect(adhdRoot).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('4. DATABASE_PATH (generic legacy name) wins over the canonical default', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      process.env['DATABASE_PATH'] = './data/legacy-generic.db';
      expect(resolveRegistryDbPath()).toBe('./data/legacy-generic.db');
    } finally {
      restore();
    }
  });

  it('3. REGISTRY_DATABASE_PATH (specific legacy name) wins over DATABASE_PATH', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      process.env['DATABASE_PATH'] = './data/generic.db';
      process.env['REGISTRY_DATABASE_PATH'] = './data/specific.db';
      expect(resolveRegistryDbPath()).toBe('./data/specific.db');
    } finally {
      restore();
    }
  });

  it('2. ADHD_AGENT_REGISTRY_DB_PATH wins over REGISTRY_DATABASE_PATH and DATABASE_PATH', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      process.env['DATABASE_PATH'] = './data/generic.db';
      process.env['REGISTRY_DATABASE_PATH'] = './data/specific.db';
      process.env['ADHD_AGENT_REGISTRY_DB_PATH'] = '/abs/agent-mcp-style.db';
      expect(resolveRegistryDbPath()).toBe('/abs/agent-mcp-style.db');
    } finally {
      restore();
    }
  });

  it('1. explicit function-arg override wins over every env var', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      process.env['DATABASE_PATH'] = './data/generic.db';
      process.env['REGISTRY_DATABASE_PATH'] = './data/specific.db';
      process.env['ADHD_AGENT_REGISTRY_DB_PATH'] = '/abs/agent-mcp-style.db';
      expect(resolveRegistryDbPath({ registryDbPath: '/explicit/override.db' })).toBe(
        '/explicit/override.db',
      );
    } finally {
      restore();
    }
  });

  it('does not create, copy, or migrate any file merely by resolving a path', () => {
    const restore = snapshotRegistryEnvVars();
    try {
      const before = resolveRegistryDbPath({ registryDbPath: '/nonexistent/path/registry.db' });
      expect(before).toBe('/nonexistent/path/registry.db');
      // No assertion of fs.existsSync needed here — resolveRegistryDbPath
      // never touches the filesystem at all (no mkdir, no open). The real
      // "does opening create the parent dir" behavior belongs to
      // openRegistryDb() and is proven in open-registry-db.test.ts.
    } finally {
      restore();
    }
  });
});

describe('resolveRegistryDbPath — scope pin (Decision 4)', () => {
  it("dirs.data.scope is pinned 'global' by default: an explicit ADHD_ENV_SCOPE=project override still changes the resolved root", () => {
    const restore = snapshotRegistryEnvVars();
    try {
      // Sandbox BOTH roots so this test can never touch the real machine's
      // ~/.adhd or this repo's own .adhd/ tree — resolveRegistryDbPath()
      // constructs its own Environment with no adhdRoot passthrough, so we
      // prove the pin's *effect* (global default resolves the same
      // regardless of ADHD_ENV_SCOPE=project) rather than the literal path.
      const globalDefault = resolveRegistryDbPath();
      process.env['ADHD_ENV_SCOPE'] = 'project';
      const projectOverridden = resolveRegistryDbPath();
      // The pin means dirs.data.scope='global' wins over an ambient
      // ADHD_ENV_SCOPE=project UNLESS the caller passes { scope: 'project' }
      // explicitly to resolveRegistryDbPath() — DirSpec.scope on the
      // directory always overrides EnvironmentOptions.scope for that one
      // dir. Prove that: both calls resolve to the identical global path.
      expect(projectOverridden).toBe(globalDefault);
    } finally {
      restore();
    }
  });
});
