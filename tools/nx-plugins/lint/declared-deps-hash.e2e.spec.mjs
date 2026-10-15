/**
 * guards: a bumped installed version of a dependency declared by project A changes A's lint and sync-deps-check task hashes and leaves B's unchanged; a warm-cache lint of A misses and fails after the bump, without nx reset (fbbb1464 AC3, AC4)
 * tier: P
 * gap: This cannot be observed at tier S because the lint and sync-deps-check cache keys are produced by Nx's task hasher over a real workspace graph (external nodes from the lockfile, installed versions, and the plugin-emitted inputs), which only a subprocess `nx run` reaches.
 * cites: fbbb1464 AC3, fbbb1464 AC4
 * red: pending (authored against base f9b64cbc; not run in this dispatch)
 *
 * Fixture: an isolated workspace under .adhd/tmp (scratch root) with fake HOME, two projects, and the
 * repo's own lint/plugin.js and deps/plugin.js registered by absolute path (never copied). Project A declares
 * `fixture-probe-dep`; project B does not. Each target's executor is overridden in project.json to a cheap
 * command (lint and sync-deps-check keep the plugin-emitted cache inputs, which are what is under test). The
 * lint command is a manifest-range check: it fails when the installed version of a declared dependency is not
 * the declared version, which models the reported scenario.
 *
 * The "bump" writes the installed version in node_modules/<dep>/package.json AND the lockfile entry, as a real
 * install does, since the hasher reads the lockfile for external versions. Whether Nx reads one or both is the
 * D3 probe of the fbbb1464 spec; this file is not yet proven to flip the hash at HEAD.
 *
 * Run: node --test tools/nx-plugins/lint/declared-deps-hash.e2e.spec.mjs
 * Lane: e2e (ADR-0009); spawns `nx` and is not part of the unit `test:build-tools` suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CACHE_HIT = /instead of running the command for 1 out of 1 tasks/;
const NX_OUTPUT = /\bNx\b|nx run|Successfully ran|Running target/;

/** Resolve the repo's own nx CLI. Throws (loud) when the nx package or its bin is missing. */
function resolveNxBin() {
  const pkgPath = require.resolve('nx/package.json', { paths: [REPO] });
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.nx;
  if (!rel) throw new Error(`nx package at ${pkgPath} declares no nx bin`);
  return join(dirname(pkgPath), rel);
}

const NX_BIN = resolveNxBin();

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
    resolution: {integrity: sha512-ZHJvYmUtcHJvYmU=}
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

/** Manifest-range check used as both lint and sync-deps-check command: fails when an installed declared version differs. */
const CHECK_SCRIPT = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
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
  w('nx.json', json({ plugins: [{ plugin: LINT_PLUGIN }, { plugin: DEPS_PLUGIN }] }));
  w('check-declared.mjs', CHECK_SCRIPT);
  w('node_modules/eslint/package.json', json({ name: ESLINT, version: '9.0.0' }));

  const projects = {
    a: { [ESLINT]: '9.0.0', [PROBE]: '1.0.0' },
    b: { [ESLINT]: '9.0.0' },
  };
  for (const [name, devDependencies] of Object.entries(projects)) {
    const root = `projects/${name}`;
    const command = `node check-declared.mjs ${root}`;
    w(`${root}/package.json`, json({ name: `@fbbb1464-probe/${name}`, version: '0.0.0', private: true, devDependencies }));
    w(`${root}/project.json`, json({
      name: `proj-${name}`,
      root,
      targets: {
        build: { executor: 'nx:noop' },
        lint: { executor: 'nx:run-commands', options: { command } },
        'sync-deps-check': { executor: 'nx:run-commands', options: { command } },
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
    CI: '1',
  });
  return {
    ws,
    env,
    cleanup: () => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Run `nx run <project>:<target>` in the fixture. Returns the exit status and whether Nx reported the task was
 * read from the cache. Throws when the output shows no nx task (the cache state is then unobservable).
 */
function nxRun(fx, project, target) {
  const r = spawnSync(process.execPath, [NX_BIN, 'run', `${project}:${target}`, '--outputStyle=static'], {
    cwd: fx.ws,
    env: fx.env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (!NX_OUTPUT.test(out)) {
    throw new Error(`no nx task output for ${project}:${target} (status ${r.status}); cache state is unobservable\n${out}`);
  }
  return { status: r.status, cached: CACHE_HIT.test(out), out };
}

test('AC3: bumping an installed declared dependency misses only the declaring project lint and sync-deps-check', () => {
  const fx = makeFixture();
  try {
    // Populate both projects' caches, then confirm a re-run is a hit (precondition: caching works).
    for (const project of ['proj-a', 'proj-b']) {
      for (const target of ['sync-deps-check', 'lint']) {
        const r = nxRun(fx, project, target);
        assert.equal(r.status, 0, `populate ${project}:${target} failed\n${r.out}`);
      }
    }
    for (const project of ['proj-a', 'proj-b']) {
      for (const target of ['sync-deps-check', 'lint']) {
        const r = nxRun(fx, project, target);
        assert.equal(r.cached, true, `precondition: re-run of ${project}:${target} must be a cache hit\n${r.out}`);
      }
    }

    installProbe(fx.ws, '2.0.0');

    // B does not declare the probe: its keys must be unchanged.
    assert.equal(nxRun(fx, 'proj-b', 'sync-deps-check').cached, true, 'B sync-deps-check hash changed; it does not declare the bumped dependency');
    assert.equal(nxRun(fx, 'proj-b', 'lint').cached, true, 'B lint hash changed; it does not declare the bumped dependency');

    // A declares the probe: both keys must change (a miss, not a replay of the old entry).
    assert.equal(nxRun(fx, 'proj-a', 'sync-deps-check').cached, false, 'A sync-deps-check hash did not change after a declared dependency was bumped');
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
