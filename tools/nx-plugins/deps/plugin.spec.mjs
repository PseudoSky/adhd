/**
 * Tests for deps/plugin.js createNodes — the `sync-deps` and `sync-deps-check`
 * targets' shared `externalDependencies` cache input (spec fbbb1464).
 *
 * Scope of this file (tier S): the input LIST each target emits for fixture
 * projects. The task-hash behavior (AC3: a bumped installed version changes the
 * sync-deps-check hash; AC4: a warm-cache lint of a mismatched project fails
 * after the bump) is NOT proven here. It needs Nx's hasher over a real
 * workspace, which cannot run in the unit lane. Tier-P gap: this cannot be
 * observed at tier S because the sync-deps-check cache key is produced by Nx's
 * task hasher over a real project graph (external nodes, installed versions and
 * the plugin-emitted inputs), which only a subprocess `nx run` reaches. AC3/AC4
 * are covered by tools/nx-plugins/lint/declared-deps-hash.e2e.spec.mjs (tier P, e2e lane).
 *
 * Run: node --test tools/nx-plugins/deps/plugin.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const plugin = require('./plugin.js');
const { scratchRootPath } = require('../lib/scratch-root.js');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROJECT_A = 'packages/fx/alpha';
const PROJECT_B = 'packages/fx/beta';

/**
 * Build a throwaway workspace from `files` (workspace-relative path -> body),
 * run `fn` with its root, and remove it in all cases.
 */
function withWorkspace(files, fn) {
  mkdirSync(scratchRootPath(REPO), { recursive: true });
  const ws = mkdtempSync(join(scratchRootPath(REPO), 'fbbb1464-deps-plugin-'));
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

/**
 * Fixture files that install `names` at the workspace root (`node_modules/<name>/package.json`).
 * The declared-deps helper emits only installed names (fbbb1464 D3(i)), so a declared
 * name must be installed in the fixture to appear in the externalDependencies list.
 */
function installed(...names) {
  return Object.fromEntries(
    names.map((n) => [`node_modules/${n}/package.json`, JSON.stringify({ name: n, version: '1.0.0' })]),
  );
}

/** A project.json that makes hasBuildTarget() true, so the plugin attaches sync targets. */
const BUILDABLE_PROJECT_JSON = '{"targets":{"build":{}}}';

/** Run createNodes over the given package.json paths and return the per-project targets keyed by project root. */
function syncTargets(ws, pkgPaths) {
  const out = plugin.createNodes[1](pkgPaths, {}, { workspaceRoot: ws });
  const targets = {};
  for (const [, result] of out) {
    for (const [root, project] of Object.entries(result.projects ?? {})) {
      targets[root] = project.targets;
    }
  }
  return targets;
}

/** Return the `externalDependencies` list from an inputs array (asserting one exists). */
function externalDependencies(inputs) {
  const entry = inputs.find(
    (i) => typeof i === 'object' && i !== null && 'externalDependencies' in i,
  );
  assert.ok(entry, 'sync target inputs carry an externalDependencies entry');
  return entry.externalDependencies;
}

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC2
 * Failure mode: sync-deps and sync-deps-check diverge, so one of the two
 * targets caches on a stale declared set and reports a verdict from a warm
 * cache after a dependency bump.
 */
test('sync-deps and sync-deps-check carry the same declared externalDependencies set', () => {
  const manifest = JSON.stringify({
    dependencies: { a: '^1.0.0', '@adhd/x': '*' },
    devDependencies: { b: '^2.0.0' },
  });
  withWorkspace(
    {
      [`${PROJECT_A}/project.json`]: BUILDABLE_PROJECT_JSON,
      [`${PROJECT_A}/package.json`]: manifest,
      ...installed('a', 'b', '@adhd/x'),
    },
    (ws) => {
      const targets = syncTargets(ws, [`${PROJECT_A}/package.json`]);
      const syncDeps = externalDependencies(targets[PROJECT_A]['sync-deps'].inputs);
      const check = externalDependencies(targets[PROJECT_A]['sync-deps-check'].inputs);
      assert.deepEqual([...syncDeps].sort(), ['a', 'b', 'eslint']);
      assert.deepEqual([...check].sort(), [...syncDeps].sort());
    },
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC5
 * Failure mode: a project with no declared npm dependencies gets an empty or
 * missing externalDependencies entry, and the sync targets fail to build a
 * valid input list.
 */
test('sync targets for a project with no declared dependencies are eslint only', () => {
  withWorkspace(
    {
      [`${PROJECT_A}/project.json`]: BUILDABLE_PROJECT_JSON,
      [`${PROJECT_A}/package.json`]: '{"name":"fx-alpha"}',
    },
    (ws) => {
      const targets = syncTargets(ws, [`${PROJECT_A}/package.json`]);
      assert.deepEqual(
        externalDependencies(targets[PROJECT_A]['sync-deps'].inputs),
        ['eslint'],
      );
      assert.deepEqual(
        externalDependencies(targets[PROJECT_A]['sync-deps-check'].inputs),
        ['eslint'],
      );
    },
  );
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC2 (isolation half of AC3)
 * Failure mode: the declared set is shared across projects (a single
 * hoisted list), so a project inherits another project's dependency names and
 * its cache misses on bumps it does not depend on. Each project's list must
 * contain only its own declared names.
 */
test('sync target externalDependencies are per-project and do not leak across projects', () => {
  withWorkspace(
    {
      [`${PROJECT_A}/project.json`]: BUILDABLE_PROJECT_JSON,
      [`${PROJECT_A}/package.json`]: JSON.stringify({ dependencies: { a: '^1.0.0' } }),
      [`${PROJECT_B}/project.json`]: BUILDABLE_PROJECT_JSON,
      [`${PROJECT_B}/package.json`]: JSON.stringify({ dependencies: { c: '^3.0.0' } }),
      ...installed('a', 'c'),
    },
    (ws) => {
      const targets = syncTargets(ws, [
        `${PROJECT_A}/package.json`,
        `${PROJECT_B}/package.json`,
      ]);
      const aExt = externalDependencies(targets[PROJECT_A]['sync-deps-check'].inputs);
      const bExt = externalDependencies(targets[PROJECT_B]['sync-deps-check'].inputs);
      assert.deepEqual([...aExt].sort(), ['a', 'eslint']);
      assert.deepEqual([...bExt].sort(), ['c', 'eslint']);
      assert.ok(!aExt.includes('c'));
      assert.ok(!bExt.includes('a'));
    },
  );
});
