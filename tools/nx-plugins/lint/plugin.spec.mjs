/**
 * guards: the lint target emits the wrong externalDependencies cache input for a project
 * tier: S
 * cites: fbbb1464 AC1, AC3, AC4, AC5
 *
 * Tests for lint/plugin.js createNodes — the per-project `lint` target's
 * `externalDependencies` cache input (spec fbbb1464).
 *
 * Scope of this file (tier S): the input LIST the plugin emits for a fixture
 * project. The task-hash behavior (AC3: a bumped installed version changes the
 * lint hash; AC4: warm-cache lint fails after the bump) is NOT proven here. It
 * needs Nx's hasher over a real workspace, which cannot run in the unit lane.
 * AC3/AC4 are covered by tools/nx-plugins/lint/declared-deps-hash.e2e.spec.mjs (tier P, e2e lane).
 *
 * Run: node --test tools/nx-plugins/lint/plugin.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const plugin = require('./plugin.js');
const { scratchRootPath } = require('../lib/scratch-root.js');

/** Repo root, so fixture workspaces live under the canonical scratch root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROJECT = 'packages/fx/proj';
const CONFIG = `${PROJECT}/eslint.config.mjs`;

/**
 * Build a throwaway workspace under the scratch root from `files`
 * (workspace-relative path -> body), install each name in `installed` as
 * `node_modules/<name>/package.json` (declaredExternalDeps emits only installed
 * names), run `fn` with its root, and remove it in all cases.
 */
function withWorkspace(files, fn, installed = []) {
  const scratch = scratchRootPath(REPO_ROOT);
  mkdirSync(scratch, { recursive: true });
  const ws = mkdtempSync(join(scratch, 'fbbb1464-lint-'));
  try {
    for (const name of installed) {
      mkdirSync(join(ws, 'node_modules', name), { recursive: true });
      writeFileSync(join(ws, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    }
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(ws, dirname(rel)), { recursive: true });
      writeFileSync(join(ws, rel), body);
    }
    return fn(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Run the plugin's createNodes over the fixture config and return the lint target's inputs. */
function lintInputs(ws) {
  const [[, result]] = plugin.createNodes[1]([CONFIG], {}, { workspaceRoot: ws });
  return result.projects[PROJECT].targets.lint.inputs;
}

/** Return the `externalDependencies` list from an inputs array (asserting one exists). */
function externalDependencies(inputs) {
  const entry = inputs.find(
    (i) => typeof i === 'object' && i !== null && 'externalDependencies' in i,
  );
  assert.ok(entry, 'lint inputs carry an externalDependencies entry');
  return entry.externalDependencies;
}

const PROJECT_JSON = '{}';
const ESLINT_CONFIG = 'export default [];\n';

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: lint keys its cache on `['eslint']` only, so a bump of the
 * project's declared dependency `a` or `b` never misses the lint cache entry.
 * The `@adhd/x` workspace sibling must not appear (it is covered by
 * `^production`).
 */
test('lint inputs include the project declared dependencies and exclude @adhd/* siblings', () => {
  const manifest = JSON.stringify({
    name: 'fx-proj',
    dependencies: { a: '^1.0.0', '@adhd/x': '*' },
    devDependencies: { b: '^2.0.0' },
  });
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
      [`${PROJECT}/package.json`]: manifest,
    },
    (ws) => {
      const ext = externalDependencies(lintInputs(ws));
      assert.deepEqual([...ext].sort(), ['a', 'b', 'eslint']);
      assert.ok(!ext.includes('@adhd/x'));
    },
    ['a', 'b', '@adhd/x'],
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC5
 * Failure mode: a project that declares no npm dependencies produces an empty
 * or invalid inputs array, or drops `eslint`, and the lint target errors.
 */
test('lint inputs for a project with no declared dependencies are eslint only', () => {
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
      [`${PROJECT}/package.json`]: '{"name":"fx-proj"}',
    },
    (ws) => {
      assert.deepEqual(externalDependencies(lintInputs(ws)), ['eslint']);
    },
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC5
 * Failure mode: a project with project.json but no package.json makes the
 * plugin throw during graph construction instead of emitting the eslint-only
 * input.
 */
test('lint inputs for a project with no package.json are eslint only and do not throw', () => {
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
    },
    (ws) => {
      assert.deepEqual(externalDependencies(lintInputs(ws)), ['eslint']);
    },
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: a project that lists `eslint` in devDependencies gets it
 * emitted twice, so the cache key carries a duplicate and the list is no longer
 * the canonical set.
 */
test('lint externalDependencies lists eslint exactly once when the manifest also declares it', () => {
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
      [`${PROJECT}/package.json`]: JSON.stringify({ devDependencies: { eslint: '^9.0.0', c: '^3.0.0' } }),
    },
    (ws) => {
      const ext = externalDependencies(lintInputs(ws));
      assert.equal(ext.filter((n) => n === 'eslint').length, 1);
      assert.deepEqual([...ext].sort(), ['c', 'eslint']);
    },
    ['c', 'eslint'],
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1 (D3(i), commit 29ae7468)
 * Failure mode: a declared dependency with no installed version (manifest ahead
 * of install, missing optional peer) is listed in externalDependencies, so Nx is
 * handed a name it has no version to hash.
 */
test('lint externalDependencies omits a declared name that is not installed', () => {
  const manifest = JSON.stringify({
    name: 'fx-proj',
    dependencies: { a: '^1.0.0', 'not-installed': '^1.0.0' },
    peerDependencies: { 'missing-peer': '^2.0.0' },
  });
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
      [`${PROJECT}/package.json`]: manifest,
    },
    (ws) => {
      const ext = externalDependencies(lintInputs(ws));
      assert.deepEqual([...ext].sort(), ['a', 'eslint']);
      assert.ok(!ext.includes('not-installed'));
      assert.ok(!ext.includes('missing-peer'));
    },
    ['a'],
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: a malformed package.json is swallowed and lint emits an
 * eslint-only key, so a declared dependency bump is silently uncached again.
 * createNodes must fail loudly and name the file.
 */
test('lint createNodes throws naming the file when package.json is malformed', () => {
  withWorkspace(
    {
      [`${PROJECT}/project.json`]: PROJECT_JSON,
      [CONFIG]: ESLINT_CONFIG,
      [`${PROJECT}/package.json`]: '{"dependencies": ',
    },
    (ws) => {
      assert.throws(
        () => lintInputs(ws),
        (err) =>
          err instanceof Error &&
          /declaredExternalDeps: cannot parse .*package\.json/.test(err.message),
      );
    },
  );
});

/**
 * regression:be8a4d5a · tier S · be8a4d5a AC2
 * Failure mode: lint loses the dependency-version invalidation the removed
 * sync-deps-check carried (`^production`), so a workspace dependency bumping its
 * own version leaves a stale green lint (checkVersionMismatches reads it); or the
 * project's own dependency-range edit leaves a stale green lint (measured: the
 * `manifest` json input does not invalidate on a range edit).
 */
test('lint inputs carry ^pkgManifest and nx.json defines the pkgManifest named input', () => {
  withWorkspace(
    { [`${PROJECT}/project.json`]: PROJECT_JSON, [CONFIG]: ESLINT_CONFIG },
    (ws) => {
      assert.ok(lintInputs(ws).includes('^pkgManifest'), 'lint inputs include ^pkgManifest');
      const own = lintInputs(ws).find((i) => typeof i === 'object' && i !== null && 'json' in i);
      assert.ok(own, 'lint inputs hash the project own dependency maps (json input with fields)');
      assert.deepEqual(own.fields, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
    },
  );
  const nx = JSON.parse(readFileSync(join(REPO_ROOT, 'nx.json'), 'utf8'));
  assert.deepEqual(nx.namedInputs.pkgManifest, ['{projectRoot}/package.json']);
  assert.equal(nx.targetDefaults['sync-deps-check'], undefined);
  assert.equal(nx.targetDefaults.lint.dependsOn, undefined);
});
