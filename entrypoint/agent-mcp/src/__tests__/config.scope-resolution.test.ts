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
 *
 * TEST-ISOLATION (2026-08-10, post-merge fix): the adhd repo root carries a
 * gitignored `.env` (present in main-checkout dev trees, absent in fresh
 * worktrees and CI) setting `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/
 * agents-dev.db`. `config.ts` runs `loadEnvHierarchy()` at MODULE SCOPE, which
 * loads `<cwd>/.env` into `process.env` with `override:true` — so an ambient
 * var can contaminate (a) every `Environment` constructed below (env layer is
 * highest precedence) and (b) the module-scope `env`/`operationalEnv`
 * singletons, which capture `process.env` at import time. The suite is
 * therefore made immune to ANY ambient `ADHD_AGENT_DATABASE_PATH` regardless
 * of runner env injection: a `beforeEach` clears the var before EVERY test,
 * and the tests that exercise the module-scope singletons (`operationalEnv`,
 * `db/client.ts`) re-import them through `importUnderCleanEnv()` — cleared
 * var + cwd moved to an empty tmpdir (so the module-scope loader finds no
 * `.env`) + `vi.resetModules()`. Tests that intend to set the var (test 3)
 * set it explicitly after the clear.
 *
 * SECOND CONTAMINATION (2026-08-10, post-merge): test 4's "never in the repo
 * tree" negative assertion originally targeted the REAL repo root
 * (`<repoRoot>/.adhd/agent-mcp/production/data/agents.db`). On a main checkout
 * that path carries a pre-existing residue — the historical project-scoped
 * agent-mcp server created it 2026-07-25, weeks before this test existed — so
 * `existsSync(...) === false` passed or failed on ambient repo state the test
 * does not control. The negative assertion is now FIXTURE-OWNED: db/client.ts
 * is imported with cwd = a `mkCwdFixture(true)` project root (`.adhd` marker)
 * the test creates and deletes, and the assertion targets that fixture. Green
 * regardless of what residue exists in the real repo tree.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';

const cleanupDirs: string[] = [];

beforeEach(() => {
  // Post-merge test-isolation fix (2026-08-10): a gitignored repo-root `.env`
  // (main-checkout dev trees only — not in fresh worktrees or CI) sets
  // `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`. `config.ts`'s
  // module-scope `loadEnvHierarchy()` loads it into `process.env`, and every
  // `Environment` below reads the env-var layer at construction — so clear the
  // contaminant before EVERY test, regardless of what the runner injected.
  // Tests that intend to set the var (test 3) set it explicitly after this.
  delete process.env.ADHD_AGENT_DATABASE_PATH;
});

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

/**
 * Deterministic dynamic import for tests that exercise the module-scope
 * singletons (`env`/`operationalEnv` in `config.ts`, and `db/client.ts`'s
 * module-scope DB creation). Returns the imported module namespace.
 *
 * WHY clearing the var alone is NOT enough (2026-08-10): `config.ts` calls
 * `loadEnvHierarchy()` at module scope, which loads `<cwd>/.env` into
 * `process.env` with `override:true`. Any re-import of `config.js` (e.g. after
 * `vi.resetModules()`) therefore RE-INJECTS the ambient
 * `ADHD_AGENT_DATABASE_PATH` even if the test deleted it first. So this helper
 * additionally chdirs into a freshly-created EMPTY tmpdir (no `.env`,
 * no `.adhd/.env` for the loader to find) for the duration of the import, then
 * restores the original cwd. `~/.adhd/.env` is still consulted by the loader,
 * but it must not set the var for this to hold (verified: it does not).
 *
 * `cwd` (optional): an OWNED fixture directory the caller wants the import to
 * run under (e.g. a `mkCwdFixture(true)` project root with a `.adhd` marker,
 * so the scope tests exercise db/client.ts against a cwd that IS a project
 * root). The caller owns its lifecycle (`cleanupDirs`); this helper neither
 * creates nor removes it.
 */
async function importUnderCleanEnv<T>(specifier: string, cwd?: string): Promise<T> {
  const originalCwd = process.cwd();
  const cleanCwd = cwd ?? mkdtempSync(join(tmpdir(), 'adhd-agent-mcp-clean-env-'));
  try {
    delete process.env.ADHD_AGENT_DATABASE_PATH;
    process.chdir(cleanCwd);
    vi.resetModules();
    return (await import(specifier)) as T;
  } finally {
    process.chdir(originalCwd);
    if (!cwd) rmSync(cleanCwd, { recursive: true, force: true });
  }
}

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
  it('(acceptance surface) operationalEnv is exported, scope-forced to global, and resolves the DB under the user-global namespaced root', async () => {
    // The singleton captures `process.env` at MODULE-import time, so import it
    // deterministically: cleared var + clean cwd + fresh module registry (see
    // `importUnderCleanEnv`). The static `agentMcpEnvironmentSpec` import above
    // already forced `config.js` to evaluate once under the ambient env, so the
    // module-scope singleton MUST be re-imported to be trustworthy here.
    const { operationalEnv } = await importUnderCleanEnv<typeof import('../config.js')>('../config.js');
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

  it('(test 4) the operational DB file is really created under the isolated HOME root by db/client.ts even with ADHD_ENV_SCOPE=project — never under the project cwd (fixture-owned project root)', async () => {
    // Isolated HOME the test fully owns (fresh temp dir, deleted in afterEach).
    const fakeHome = mkAdhdRoot();
    // A FAKE project root the test fully owns — a temp dir carrying the `.adhd`
    // PROJECT_MARKER — used as the cwd db/client.ts runs under, so
    // `ADHD_ENV_SCOPE=project` has a real project root to (wrongly) relocate
    // the operational store into if the scope-forced resolution were not in
    // place. Deleted in afterEach.
    //
    // Deliberately NOT the real repo root: on a main checkout a pre-existing
    // `.adhd/agent-mcp/production/data/agents.db` (created 2026-07-25 by the
    // historical project-scoped server, weeks before this test existed) makes
    // ANY `existsSync(...) === false` assertion against the real repo root
    // environment-dependent — it passes or fails on ambient repo state the
    // test does not control, not on the code under test. This fixture is
    // created fresh by the test, so the negative assertion below is
    // deterministic regardless of checkout history.
    const cwdFixture = mkCwdFixture(true);
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', 'project');
    const restoreHome = withEnvVar('HOME', fakeHome);
    const restoreDbPath = withEnvVar('ADHD_AGENT_DATABASE_PATH', undefined);
    try {
      // Isolated HOME + fresh module registry, imported with cwd = the fixture
      // project root: the module-scope `env`/`operationalEnv` singletons and
      // db/client.ts all resolve against BOTH the isolated HOME and a
      // project-marker cwd — the exact historical bug scenario (project-scoped
      // server, cwd in a repo carrying `.git`/`.adhd` markers). A repo-root
      // `.env` injected by the runner or by `config.ts`'s module-scope loader
      // can no longer leak in either (see `importUnderCleanEnv`).
      await importUnderCleanEnv('../db/client.js', cwdFixture);

      // The operational DB MUST land under the isolated HOME's namespaced root.
      const expected = join(fakeHome, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db');
      expect(existsSync(expected)).toBe(true);

      // The teeth: project scope must NOT relocate the operational store into
      // the project root — even though `cwd` IS a project root (`.adhd`
      // marker present), the exact path the bug's project-scoped server used
      // to open, `<cwd>/.adhd/agent-mcp/production/data/agents.db`, must NOT
      // exist. Fixture-owned: green with or without the historical repo-tree
      // residue.
      expect(existsSync(join(cwdFixture, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db'))).toBe(false);
    } finally {
      restoreDbPath();
      restoreHome();
      restoreScope();
    }
  });
});
