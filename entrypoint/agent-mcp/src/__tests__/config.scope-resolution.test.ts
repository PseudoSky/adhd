/**
 * DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 — acceptance test for operational
 * `agents.db` scope resolution (design decision 2).
 *
 * Background (architect-verified in the live tree):
 *   - The debt has two halves. The (a) namespace/layout half: 48 real agents
 *     sit in the FLAT legacy `~/.adhd/agent-mcp/agents.db`, while the
 *     zero-config namespaced path (`<HOME>/.adhd/agent-mcp/production/data/
 *     agents.db`) is empty; the global server only works because the
 *     user-scope Claude Code registration pins `ADHD_AGENT_DATABASE_PATH`
 *     to the flat path. The (b) scope-override half: this repo's own
 *     `.mcp.json` runs the project-local `agent-mcp` server with
 *     `ADHD_ENV_SCOPE=project`, which must NEVER relocate the operational
 *     store into the repo tree (AGENTS.md §10).
 *
 * What the shipped redesign (commit bc71a618 + dirs.ts `spec.scope ??
 * activeScope`) already guarantees, verified empirically (probe + this
 * file's tests): the `dirs.data.scope:'global'` PIN wins over
 * `ADHD_ENV_SCOPE=project` for `env.files.db`, so the zero-config DB path
 * already stays under the user-global namespaced root. Test 1 below is a
 * REGRESSION GUARD for that shipped behavior at the isolated-Environment
 * level (the existing `real-environment.e2e.test.ts` test 5 guards the
 * singleton).
 *
 * What was STILL red before this change (probe evidence): the environment
 * CONFIG-FILE layers follow the ACTIVE scope. With `ADHD_ENV_SCOPE=project`,
 * a project-scope `config.yaml` at `<projectRoot>/.adhd/agent-mcp/
 * production/config.yaml` setting `db.path` relocates the operational DB via
 * the `db.path` config field (`db/client.ts` previously opened
 * `env.config.db.path ?? env.files['db']` — the project layer won). Tests 2
 * and 3 prove the fix: the operational DB path is now resolved from
 * `operationalEnv`, a scope-forced (`scope:'global'`) Environment instance,
 * so ADHD_ENV_SCOPE=project relocates only config-file layers
 * (`plugins.configPath`, `registryDbPath` — already explicit project-relative
 * overrides in `.mcp.json`), never `agents.db`. Only an explicit
 * `ADHD_AGENT_DATABASE_PATH` (env var, or a system/global `config.yaml`
 * `db.path`) still wins.
 *
 * RED→GREEN: this file cannot even LOAD against the pre-fix code — the
 * `operationalEnv` export does not exist (the red run fails the module
 * import), and `db/client.ts`'s old expression honored a project layer that
 * these tests prove is ignored. See the task report for both runs.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, operationalEnv, type AgentMcpConfig } from '../config.js';

const cleanupDirs: string[] = [];

/** Isolated `adhdRoot` (test-isolation escape hatch, ARCHITECTURE.md §3.1). */
function mkAdhdRoot(): string {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'scope-resolution-test');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'root-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated `cwd` OUTSIDE the repo's git working tree (os.tmpdir() has no
 *  `.git`/`.adhd` ancestor, so scope auto-detection is a pure function of
 *  the markers THIS test creates). */
function mkCwdFixture(withProjectMarker = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-agent-mcp-scope-cwd-'));
  if (withProjectMarker) {
    // `.adhd` is one of scope.ts's PROJECT_MARKERS — its presence at `cwd`
    // makes `findProjectRoot(cwd)` return `cwd` itself.
    mkdirSync(join(dir, '.adhd'), { recursive: true });
  }
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

/** The REAL singleton's construction shape: no `scope` override at all
 *  (`config.ts` constructs `env` as `new Environment('agent-mcp',
 *  agentMcpEnvironmentSpec, { namespace: 'production' })`), plus the
 *  test-isolation `adhdRoot`/`cwd` options. */
function makePlainEnv(adhdRoot: string, cwd: string) {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    adhdRoot,
    cwd,
  });
}

/** The shape `operationalEnv` is constructed with (`config.ts`): scope
 *  FORCED to 'global' — resolveScope step 1 beats ADHD_ENV_SCOPE (step 2). */
function makeOperationalEnv(adhdRoot: string, cwd: string) {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot,
    cwd,
  });
}

describe('DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 — operational agents.db scope resolution', () => {
  it('(acceptance surface) operationalEnv is exported, scope-forced to global, and resolves the DB under the user-global namespaced root', () => {
    // Deterministic regardless of ambient process env: `scope: 'global'` in
    // the constructor options is resolveScope() step 1 — ADHD_ENV_SCOPE
    // (step 2) can never override it.
    expect(operationalEnv.scope).toBe('global');
    expect(operationalEnv.files.db.endsWith(join('agent-mcp', 'production', 'data', 'agents.db'))).toBe(true);
    // User-global: under os.homedir() (~/.adhd/...), never a bare relative path.
    expect(operationalEnv.files.db.startsWith(homedir())).toBe(true);
  });

  it('(test 1) with ADHD_ENV_SCOPE=project + isolated adhdRoot, the zero-config DB resolves under the user-global namespaced root (<adhdRoot>/agent-mcp/production/data/agents.db), NOT under the project cwd — the shipped dirs.data pin wins', () => {
    const restore = withEnvVar('ADHD_ENV_SCOPE', 'project');
    try {
      const adhdRoot = mkAdhdRoot();
      // cwd WITH a `.adhd` project marker, so auto-detection would resolve
      // 'project' if the pin were not authoritative.
      const cwd = mkCwdFixture(true);

      const env = makePlainEnv(adhdRoot, cwd);

      // The env var IS honored for the active scope (this test is not about
      // disabling project scope — only about dirs.data not inheriting it).
      expect(env.scope).toBe('project');

      const dbPath = env.files.db;
      expect(dbPath).toBe(join(adhdRoot, 'agent-mcp', 'production', 'data', 'agents.db'));
      expect(dbPath).not.toBe('./data/agents.db');
      expect(dbPath.startsWith(cwd)).toBe(false);
      expect(dbPath.startsWith(join(adhdRoot, '.adhd'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('(test 2) with ADHD_ENV_SCOPE=project, a project-scope config.yaml setting db.path relocates the PLAIN env\'s config field (the hazard) but the scope-forced operationalEnv is immune — db.client.ts resolves from the latter', () => {
    const restore = withEnvVar('ADHD_ENV_SCOPE', 'project');
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture(true);
      const relocatedByProjectLayer = join(cwd, 'relocated-by-project-layer.db');

      // Project-scope config layer: `<projectRoot>/.adhd/agent-mcp/production/config.yaml`.
      // roots.project is only populated when the active scope is 'project', and the
      // config-resolver cascade (system → global → project → local → env) consults it.
      const projectLayerDir = join(cwd, '.adhd', 'agent-mcp', 'production');
      mkdirSync(projectLayerDir, { recursive: true });
      writeFileSync(join(projectLayerDir, 'config.yaml'), `db:\n  path: ${relocatedByProjectLayer}\n`);

      const plain = makePlainEnv(adhdRoot, cwd);
      const operational = makeOperationalEnv(adhdRoot, cwd);

      // Teeth: the project layer genuinely relocates the plain cascade's db.path
      // (pre-fix, db/client.ts opened `env.config.db.path ?? env.files['db']` → the
      // relocated path). If this assertion ever fails, the fixture lost its teeth.
      expect(plain.scope).toBe('project');
      expect(plain.config.db.path).toBe(relocatedByProjectLayer);

      // The fix: the scope-forced instance never sees the project layer.
      expect(operational.scope).toBe('global');
      expect(operational.config.db.path).toBeUndefined();
      expect(operational.files.db).toBe(join(adhdRoot, 'agent-mcp', 'production', 'data', 'agents.db'));

      // This is the exact expression db/client.ts resolves the operational DB from.
      const resolvedPath = operational.config.db.path ?? operational.files.db;
      expect(resolvedPath).toBe(join(adhdRoot, 'agent-mcp', 'production', 'data', 'agents.db'));
      expect(resolvedPath).not.toBe(relocatedByProjectLayer);
    } finally {
      restore();
    }
  });

  it('(test 3) an explicit ADHD_AGENT_DATABASE_PATH still wins over everything for the scope-forced instance', () => {
    const restore = withEnvVar('ADHD_AGENT_DATABASE_PATH', '/explicit/operator-pinned/agents.db');
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture(true);

      const operational = makeOperationalEnv(adhdRoot, cwd);

      expect(operational.config.db.path).toBe('/explicit/operator-pinned/agents.db');
      expect(operational.config.db.path ?? operational.files.db).toBe('/explicit/operator-pinned/agents.db');
    } finally {
      restore();
    }
  });

  it('(test 4) the operational DB file is really created under the isolated HOME root by db/client.ts even with ADHD_ENV_SCOPE=project — never in the repo tree', async () => {
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', 'project');
    const restoreHome = withEnvVar('HOME', mkAdhdRoot());
    const restoreDbPath = withEnvVar('ADHD_AGENT_DATABASE_PATH', undefined);
    try {
      // Isolated HOME: the module-scope `env`/`operationalEnv` singletons and
      // db/client.ts all resolve against it.
      const { vi } = await import('vitest');
      vi.resetModules();
      await import('../db/client.js');

      const expected = join(process.env['HOME'] as string, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db');
      expect(existsSync(expected)).toBe(true);

      // Never relocated into the repo tree by the project scope: the exact
      // path the bug's project-scoped server used to open is
      // `<cwd>/.adhd/agent-mcp/production/data/agents.db` — this worktree has
      // real `.git`/`.adhd` markers, so `findProjectRoot(cwd)` would resolve
      // it if the scope-forced resolution were not in place. (Verified absent
      // in this worktree before the run; the isolated-HOME path above is the
      // one db/client.ts actually created.)
      expect(existsSync(join(process.cwd(), '.adhd', 'agent-mcp', 'production', 'data', 'agents.db'))).toBe(false);
    } finally {
      restoreDbPath();
      restoreHome();
      restoreScope();
    }
  });
});
