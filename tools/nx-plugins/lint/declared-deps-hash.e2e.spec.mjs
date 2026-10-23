/**
 * guards: a bumped installed version of a dependency declared by project A changes A's lint task hash and leaves B's unchanged; a warm-cache lint of A misses and fails after the bump, without nx reset (fbbb1464 AC3, AC4)
 * tier: P
 * gap: This cannot be observed at tier S because the lint cache key is produced by Nx's task hasher over a real workspace graph (external nodes from the lockfile, installed versions, and the plugin-emitted inputs), which only a subprocess `nx run` reaches.
 * cites: fbbb1464 AC3, fbbb1464 AC4
 * red: AC3 B-clause negative control (comment-only/node_modules-only expectation flipped to "must miss") failed with
 *   AssertionError "B sync-deps-check was invalidated by a comment-only lockfile edit or a node_modules-only edit"
 *   (node --test exit 1); restored, the same run passes 2/2 (exit 0).
 *
 * Fixture: an isolated workspace under .adhd/tmp (scratch root) with fake HOME, two projects, and the
 * repo's own lint/plugin.js and deps/plugin.js registered by absolute path (never copied). Project A declares
 * `fixture-probe-dep`; project B does not. Each target's executor is overridden in project.json to a cheap
 * command (lint keeps the plugin-emitted cache inputs, which are what is under test). The
 * lint command is a manifest-range check: it fails when the installed version of a declared dependency is not
 * the declared version, which models the reported scenario.
 *
 * The "bump" writes the installed version in node_modules/<dep>/package.json AND the lockfile entry, as a real
 * install does, since the hasher reads the lockfile for external versions. Whether Nx reads one or both is the
 * D3 probe of the fbbb1464 spec; this file is not yet proven to flip the hash at HEAD.
 *
 * Cache hit/miss is observed from STATE, not Nx stdout wording: each check command appends a line to a
 * per-project-and-target run log (a directory outside the workspace, passed by FBBB1464_RUN_LOG) every time
 * it actually executes. A cache hit replays the stored result without executing the command, so a task was
 * "cached" exactly when its run log did not grow. The log lives outside the workspace so it is never a hash
 * input. No assertion depends on Nx output text; the only inputs are the exit status and the run-log line count.
 * A non-zero exit with no execution means Nx failed before running the task, which is thrown as unobservable
 * rather than read as a hit.
 *
 * Run: node --test tools/nx-plugins/lint/declared-deps-hash.e2e.spec.mjs
 * Lane: e2e (ADR-0009); spawns `nx` and is not part of the unit `test:build-tools` suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const LINT_PLUGIN = join(REPO, 'tools', 'nx-plugins', 'lint', 'plugin.js');
const DEPS_PLUGIN = join(REPO, 'tools', 'nx-plugins', 'deps', 'plugin.js');
const { cleanGitEnv } = require('../lib/git-env.js');
const { scratchRootPath } = require('../lib/scratch-root.js');

const PROBE = 'fixture-probe-dep';
const ESLINT = 'eslint';
const SPAWN_TIMEOUT_MS = 240_000;

/** Resolve the repo's own nx CLI. Throws (loud) when the nx package or its bin is missing. */
function resolveNxBin() {
  const pkgPath = require.resolve('nx/package.json', { paths: [REPO] });
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.nx;
  if (!rel) throw new Error(`nx package at ${pkgPath} declares no nx bin`);
  return join(dirname(pkgPath), rel);
}

const NX_BIN = resolveNxBin();

/**
 * `node_modules/.modules.yaml`, the manifest pnpm writes beside every install. Nx's pnpm lockfile plugin
 * refuses a `pnpm-lock.yaml` whose `node_modules` lacks it ("node_modules was not installed with pnpm"),
 * so the fixture must carry it or the project graph never builds. No hoisted deps: the probe is direct.
 */
const MODULES_MANIFEST = `hoistedDependencies: {}
included:
  dependencies: true
  devDependencies: true
  optionalDependencies: true
layoutVersion: 5
nodeLinker: isolated
packageManager: pnpm@8.15.9
pendingBuilds: []
publicHoistPattern: []
registries:
  default: https://registry.npmjs.org/
skipped: []
virtualStoreDir: .pnpm
`;

/**
 * Integrity string for the probe at `version`. A real registry tarball has a distinct integrity per version, and
 * Nx's pnpm parser hashes an external package by its lockfile integrity (pnpm-parser.js createHashFromSnapshot), so
 * a fixture that reuses one integrity for every version can never show a version bump to the task hasher.
 */
function probeIntegrity(version) {
  return `sha512-${Buffer.from(`${PROBE}@${version}`).toString('base64')}`;
}

/** Pnpm lockfile (v6, matching the repo's lockfile format) with the probe at `probeVersion`. */
function lockfile(probeVersion) {
  return `lockfileVersion: '6.0'

importers:

  .: {}

  projects/a:
    devDependencies:
      ${ESLINT}:
        specifier: 9.0.0
        version: 9.0.0
      ${PROBE}:
        specifier: 1.0.0
        version: ${probeVersion}

  projects/b:
    devDependencies:
      ${ESLINT}:
        specifier: 9.0.0
        version: 9.0.0

packages:

  /${ESLINT}@9.0.0:
    resolution: {integrity: sha512-ZXNsaW50QA==}
    dev: true

  /${PROBE}@${probeVersion}:
    resolution: {integrity: ${probeIntegrity(probeVersion)}}
    dev: true
`;
}

/** Write the installed probe version to node_modules and the lockfile, as a real install does. */
function installProbe(ws, version) {
  const modPkg = join(ws, 'node_modules', PROBE, 'package.json');
  mkdirSync(dirname(modPkg), { recursive: true });
  writeFileSync(modPkg, `${JSON.stringify({ name: PROBE, version }, null, 2)}\n`);
  writeFileSync(join(ws, 'pnpm-lock.yaml'), lockfile(version));
}

/** Manifest-range check used as the lint command: fails when an installed declared version differs. */
const CHECK_SCRIPT = `import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const dir = process.argv[2];
const target = process.argv[3];
mkdirSync(process.env.FBBB1464_RUN_LOG, { recursive: true });
appendFileSync(join(process.env.FBBB1464_RUN_LOG, \`\${basename(dir)}-\${target}.log\`), 'ran\\n');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const bad = [];
for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
  const installed = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')).version;
  if (installed !== range) bad.push(\`\${name} declared \${range} installed \${installed}\`);
}
if (bad.length > 0) {
  console.error(bad.join('\\n'));
  process.exit(1);
}
`;

/**
 * Build the isolated two-project workspace under the scratch root with a fake HOME.
 * Returns the workspace, the env for nx, and a cleanup that removes both directories.
 */
function makeFixture() {
  const scratch = scratchRootPath(REPO);
  mkdirSync(scratch, { recursive: true });
  const ws = mkdtempSync(join(scratch, 'fbbb1464-ws-'));
  const home = mkdtempSync(join(scratch, 'fbbb1464-home-'));
  const runLog = join(home, 'runs');
  const w = (rel, body) => {
    const p = join(ws, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

  w('package.json', json({ name: 'fbbb1464-probe-root', private: true, version: '0.0.0' }));
  w('pnpm-workspace.yaml', "packages:\n  - 'projects/*'\n");
  w('eslint.base.config.mjs', 'export default [];\n');
  w('eslint.config.mjs', 'export default [];\n');
  // targetDefaults mirror the repo root nx.json's `cache: true` for lint: without it the
  // explicit run-commands targets below are never cacheable and no warm re-run can observe a hit. The root's
  w('nx.json', json({
    plugins: [{ plugin: LINT_PLUGIN }, { plugin: DEPS_PLUGIN }],
    targetDefaults: {
      lint: { cache: true },
    },
  }));
  w('check-declared.mjs', CHECK_SCRIPT);
  w('node_modules/eslint/package.json', json({ name: ESLINT, version: '9.0.0' }));
  w('node_modules/.modules.yaml', MODULES_MANIFEST);

  const projects = {
    a: { [ESLINT]: '9.0.0', [PROBE]: '1.0.0' },
    b: { [ESLINT]: '9.0.0' },
  };
  for (const [name, devDependencies] of Object.entries(projects)) {
    const root = `projects/${name}`;
    const command = (target) => `node check-declared.mjs ${root} ${target}`;
    w(`${root}/package.json`, json({ name: `@fbbb1464-probe/${name}`, version: '0.0.0', private: true, devDependencies }));
    w(`${root}/project.json`, json({
      name: `proj-${name}`,
      root,
      targets: {
        build: { executor: 'nx:noop' },
        lint: { executor: 'nx:run-commands', options: { command: command('lint') } },
      },
    }));
    w(`${root}/eslint.config.mjs`, 'export default [];\n');
  }
  installProbe(ws, '1.0.0');

  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NX_')));
  const env = cleanGitEnv(base, {
    HOME: home,
    USERPROFILE: home,
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_TUI: 'false',
    FBBB1464_RUN_LOG: runLog,
    CI: '1',
  });
  return {
    ws,
    env,
    runLog,
    cleanup: () => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Number of times the check command actually executed for `project`:`target` (cache hits do not execute it). */
function executions(fx, project, target) {
  const log = join(fx.runLog, `${project.replace('proj-', '')}-${target}.log`);
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

/**
 * Run `nx run <project>:<target>` in the fixture. Returns the exit status and whether the task was served
 * from the cache (the check command did not execute). Throws when Nx exited non-zero without executing the
 * command, since the cache state is then unobservable.
 */
function nxRun(fx, project, target) {
  const before = executions(fx, project, target);
  const r = spawnSync(process.execPath, [NX_BIN, 'run', `${project}:${target}`, '--outputStyle=static'], {
    cwd: fx.ws,
    env: fx.env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const executed = executions(fx, project, target) > before;
  if (!executed && r.status !== 0) {
    throw new Error(`nx failed before running ${project}:${target} (status ${r.status}); cache state is unobservable\n${out}`);
  }
  return { status: r.status, cached: !executed, out };
}

test('AC3: bumping an installed declared dependency misses only the declaring project lint', () => {
  const fx = makeFixture();
  try {
    // Populate both projects' caches, then confirm a re-run is a hit (precondition: caching works).
    for (const project of ['proj-a', 'proj-b']) {
      for (const target of ['lint']) {
        const r = nxRun(fx, project, target);
        assert.equal(r.status, 0, `populate ${project}:${target} failed\n${r.out}`);
      }
    }
    for (const project of ['proj-a', 'proj-b']) {
      for (const target of ['lint']) {
        const r = nxRun(fx, project, target);
        assert.equal(r.cached, true, `precondition: re-run of ${project}:${target} must be a cache hit\n${r.out}`);
      }
    }

    installProbe(fx.ws, '2.0.0');

    // B does not declare the probe. Amended B-clause (fbbb1464 AC3, option A): a non-declaring project may be
    // invalidated at most once per external-graph change, then stays cached; comment-only lockfile edits and
    // node_modules-only edits do not invalidate.
    for (const target of ['lint']) {
      // (1) The first run after the external-graph change may miss; it must still succeed.
      const first = nxRun(fx, 'proj-b', target);
      assert.equal(first.status, 0, `B ${target} first run after the external-graph change must succeed (a miss is permitted)\n${first.out}`);
      // (2) The second run is cached: at most one invalidation per change.
      assert.equal(nxRun(fx, 'proj-b', target).cached, true, `B ${target} was invalidated again with no further change; at most one invalidation per external-graph change is allowed`);
    }

    // (3) A comment-only lockfile edit and a node_modules-only edit leave B cached.
    const lockPath = join(fx.ws, 'pnpm-lock.yaml');
    writeFileSync(lockPath, `# comment-only edit, no package content change\n${readFileSync(lockPath, 'utf8')}`);
    writeFileSync(join(fx.ws, 'node_modules', ESLINT, 'node-modules-only-edit.txt'), 'not a manifest change\n');
    for (const target of ['lint']) {
      assert.equal(nxRun(fx, 'proj-b', target).cached, true, `B ${target} was invalidated by a comment-only lockfile edit or a node_modules-only edit`);
    }

    // A declares the probe: both keys must change (a miss, not a replay of the old entry).
    assert.equal(nxRun(fx, 'proj-a', 'lint').cached, false, 'A lint hash did not change after a declared dependency was bumped');
  } finally {
    fx.cleanup();
  }
});

test('AC4: a warm-cache lint of a project whose range excludes its installed version misses and fails after the bump, without nx reset', () => {
  const fx = makeFixture();
  try {
    const first = nxRun(fx, 'proj-a', 'lint');
    assert.equal(first.status, 0, `precondition: lint must pass while the installed version matches\n${first.out}`);
    const warm = nxRun(fx, 'proj-a', 'lint');
    assert.equal(warm.cached, true, `precondition: warm re-run must be a cache hit\n${warm.out}`);
    assert.equal(warm.status, 0, `precondition: warm re-run must pass\n${warm.out}`);

    installProbe(fx.ws, '2.0.0');

    const after = nxRun(fx, 'proj-a', 'lint');
    assert.equal(after.cached, false, 'warm-cache lint replayed the old success after the installed version changed (the reported scenario)');
    assert.notEqual(after.status, 0, `lint must fail when the installed version is outside the manifest range\n${after.out}`);
  } finally {
    fx.cleanup();
  }
});
