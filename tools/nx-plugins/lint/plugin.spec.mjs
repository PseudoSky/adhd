/**
 * Tests for lint/plugin.js createNodes — the per-project `lint` target's
 * `externalDependencies` cache input (spec fbbb1464).
 *
 * Scope of this file (tier S): the input LIST the plugin emits for a fixture
 * project. The task-hash behavior (AC3: a bumped installed version changes the
 * lint hash; AC4: warm-cache lint fails after the bump) is NOT proven here. It
 * needs Nx's hasher over a real workspace, which cannot run in the unit lane.
 * See the fbbb1464 tier-P gap recorded in the author-regression report.
 *
 * Run: node --test tools/nx-plugins/lint/plugin.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const plugin = require('./plugin.js');

const PROJECT = 'packages/fx/proj';
const CONFIG = `${PROJECT}/eslint.config.mjs`;

/**
 * Build a throwaway workspace from `files` (workspace-relative path -> body),
 * run `fn` with its root, and remove it in all cases.
 */
function withWorkspace(files, fn) {
  const ws = mkdtempSync(join(tmpdir(), 'fbbb1464-lint-'));
  try {
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
