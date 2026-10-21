/**
 * guards: declaredExternalDeps misreads a project's declared or installed dependencies
 * tier: S
 * cites: fbbb1464 AC1, AC5
 *
 * Tests for lib/declared-external-deps.js — the single reader behind the
 * per-project `externalDependencies` cache input of `lint`, `sync-deps` and
 * `sync-deps-check` (spec fbbb1464).
 *
 * Run: node --test tools/nx-plugins/lib/declared-external-deps.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { declaredExternalDeps } = require('./declared-external-deps.js');
const { scratchRootPath } = require('./scratch-root.js');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROJECT = 'packages/fx/proj';

/** Write a minimal installed package (`node_modules/<name>/package.json`) under `dir`. */
function install(dir, name) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

/**
 * Build a throwaway workspace under the tooling scratch root containing
 * `packages/fx/proj/package.json` with `manifestText` (or no manifest when
 * `manifestText` is undefined), install the names in `installedAtRoot` at
 * `<ws>/node_modules` and `installedInProject` at the project's own
 * `node_modules`, run `fn` with the workspace root, and remove the workspace in
 * all cases.
 */
function withWorkspace(manifestText, fn, { installedAtRoot = [], installedInProject = [] } = {}) {
  const scratch = scratchRootPath(REPO);
  mkdirSync(scratch, { recursive: true });
  const ws = mkdtempSync(join(scratch, 'fbbb1464-deps-'));
  try {
    if (manifestText !== undefined) {
      mkdirSync(join(ws, PROJECT), { recursive: true });
      writeFileSync(join(ws, PROJECT, 'package.json'), manifestText);
    }
    for (const name of installedAtRoot) install(ws, name);
    for (const name of installedInProject) install(join(ws, PROJECT), name);
    return fn(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC5
 * Failure mode: a project without a package.json makes the reader throw or
 * return a non-list, so the cache input cannot be built for that project.
 */
test('declaredExternalDeps: a project with no package.json yields an empty list', () => {
  withWorkspace(undefined, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), []);
  });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: a declared name in any of the four dependency fields is
 * dropped, or the output order/duplicates depend on manifest key order, so the
 * cache key changes between identical checkouts.
 */
test('declaredExternalDeps: collects all four dependency fields, sorted and de-duplicated', () => {
  const manifest = JSON.stringify({
    name: 'fx-proj',
    optionalDependencies: { delta: '^5.0.0' },
    peerDependencies: { gamma: '>=4' },
    devDependencies: { beta: '^3.0.0', alpha: '^2.0.0' },
    dependencies: { zeta: '^1.0.0', alpha: '^2.0.0' },
  });
  withWorkspace(manifest, (ws) => {
    assert.deepEqual(
      declaredExternalDeps(PROJECT, ws),
      ['alpha', 'beta', 'delta', 'gamma', 'zeta'],
    );
  }, { installedAtRoot: ['alpha', 'beta', 'delta', 'gamma', 'zeta'] });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: a workspace sibling (`@adhd/*`) or `eslint` leaks into the
 * list. Siblings are already covered by `^production`, and `eslint` is always
 * listed by the caller, so a leak duplicates or distorts the key.
 */
test('declaredExternalDeps: excludes @adhd/* workspace names and eslint', () => {
  const manifest = JSON.stringify({
    dependencies: { '@adhd/data-base-transforms': '*', 'real-dep': '^1.0.0' },
    devDependencies: { eslint: '^9.0.0' },
  });
  withWorkspace(manifest, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), ['real-dep']);
  }, { installedAtRoot: ['real-dep', '@adhd/data-base-transforms', 'eslint'] });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC5
 * Failure mode: a manifest that declares no dependency fields yields a
 * non-empty or throwing result, which would add phantom names to the key.
 */
test('declaredExternalDeps: a manifest with no dependency fields yields an empty list', () => {
  withWorkspace('{"name":"fx-proj","version":"0.0.1"}', (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), []);
  });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 AC1
 * Failure mode: a malformed package.json is swallowed and treated as "declares
 * nothing". The cache input then silently drops every declared dependency,
 * which is the stale-cache defect this helper exists to prevent. The error
 * must name the file.
 */
test('declaredExternalDeps: malformed package.json throws an error naming the file', () => {
  withWorkspace('{"dependencies": { "a": ', (ws) => {
    assert.throws(
      () => declaredExternalDeps(PROJECT, ws),
      (err) =>
        err instanceof Error &&
        /declaredExternalDeps: cannot parse .*package\.json/.test(err.message),
    );
  });
});

const INSTALLED_MANIFEST = JSON.stringify({
  dependencies: { 'dep-installed': '^1.0.0', 'dep-missing': '^1.0.0' },
  devDependencies: { 'dev-installed': '^1.0.0', 'dev-missing': '^1.0.0' },
  peerDependencies: { 'peer-installed': '>=1', 'peer-missing': '>=1' },
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 D3(i) (supports AC1)
 * Failure mode: an installed dependency, devDependency or peerDependency is
 * dropped from the list, so a bump of its installed version no longer
 * invalidates the project's lint/sync-deps cache (the reported stale-cache bug).
 */
test('declaredExternalDeps: installed dependency, devDependency and peerDependency are all emitted', () => {
  withWorkspace(INSTALLED_MANIFEST, (ws) => {
    const out = declaredExternalDeps(PROJECT, ws);
    for (const name of ['dep-installed', 'dev-installed', 'peer-installed']) {
      assert.ok(out.includes(name), `${name} is installed and declared, so it must be emitted; got ${JSON.stringify(out)}`);
    }
  }, { installedAtRoot: ['dep-installed', 'dev-installed', 'peer-installed'] });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 D3(i)
 * Failure mode: a declared-but-not-installed name (missing optional peer,
 * manifest ahead of install) is emitted into externalDependencies, naming a
 * package with no installed version for Nx to hash.
 */
test('declaredExternalDeps: declared names that are not installed are absent, installed ones remain', () => {
  withWorkspace(INSTALLED_MANIFEST, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), [
      'dep-installed',
      'dev-installed',
      'peer-installed',
    ]);
  }, { installedAtRoot: ['dep-installed', 'dev-installed', 'peer-installed'] });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 D3(i)
 * Failure mode: with nothing installed every declared name is emitted anyway
 * (the filter is skipped), so the list names packages with no installed version.
 */
test('declaredExternalDeps: nothing installed yields an empty list', () => {
  withWorkspace(INSTALLED_MANIFEST, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), []);
  });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 D3(i)
 * Failure mode: only the project's own node_modules is searched, so a hoisted
 * root install (the common pnpm/npm layout) is treated as missing and its
 * version bumps stop invalidating the cache.
 */
test('declaredExternalDeps: a package installed only in the workspace root node_modules is emitted', () => {
  const manifest = JSON.stringify({ dependencies: { hoisted: '^1.0.0' } });
  withWorkspace(manifest, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), ['hoisted']);
  }, { installedAtRoot: ['hoisted'] });
});

/**
 * regression:fbbb1464 · tier S · fbbb1464 D3(i)
 * Failure mode: only the workspace root node_modules is searched, so a package
 * linked into the project's own node_modules (pnpm layout) is treated as missing.
 */
test('declaredExternalDeps: a package installed only in the project node_modules is emitted', () => {
  const manifest = JSON.stringify({ dependencies: { local: '^1.0.0', '@scope/local': '^1.0.0' } });
  withWorkspace(manifest, (ws) => {
    assert.deepEqual(declaredExternalDeps(PROJECT, ws), ['@scope/local', 'local']);
  }, { installedInProject: ['local', '@scope/local'] });
});
