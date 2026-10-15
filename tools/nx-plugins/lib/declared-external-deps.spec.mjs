/**
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { declaredExternalDeps } = require('./declared-external-deps.js');

const PROJECT = 'packages/fx/proj';

/**
 * Build a throwaway workspace containing `packages/fx/proj/package.json` with
 * `manifestText` (or no manifest when `manifestText` is undefined), run `fn`
 * with the workspace root, and remove the workspace in all cases.
 */
function withWorkspace(manifestText, fn) {
  const ws = mkdtempSync(join(tmpdir(), 'fbbb1464-deps-'));
  try {
    if (manifestText !== undefined) {
      mkdirSync(join(ws, PROJECT), { recursive: true });
      writeFileSync(join(ws, PROJECT, 'package.json'), manifestText);
    }
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
  });
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
  });
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
