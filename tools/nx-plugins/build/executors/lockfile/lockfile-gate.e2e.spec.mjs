/**
 * E2E (ADR-0009 e2e lane: spawns real `corepack pnpm`) proofs for the lockfile
 * freshness gate, with NEGATIVE CONTROLS.
 *
 *   4f26493e AC2  the gate goes red on drift, names package.json + specifier,
 *                 and does not mutate pnpm-lock.yaml
 *   e98bb455 AC1  regenerateLockfile turns a drifted lockfile fresh again
 *
 * Run: node --test tools/nx-plugins/build/executors/lockfile/lockfile-gate.e2e.spec.mjs
 * (`nx run @adhd/source:lockfile-gate-teeth`; invoked by the CI jobs.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..', '..');
const GATE = join(here, 'check-lockfile-fresh.mjs');
const { regenerateLockfile, checkLockfile } = require('../../lib/lockfile-sync.js');
const { cleanGitEnv } = require('../../../lib/git-env.js');

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const gate = (root) => spawnSync('node', [GATE, '--root', root], { encoding: 'utf8' });
const pnpm = (cwd, ...args) => spawnSync('corepack', ['pnpm', ...args], { cwd, encoding: 'utf8' });

/** A two-package pnpm workspace whose only dependency is internal (no network). */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'lockfile-gate-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, packageManager: 'pnpm@8.15.9' }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(root, '.npmrc'), 'link-workspace-packages=true\nprefer-workspace-packages=true\n');
  for (const [n, deps] of [['a', {}], ['b', { '@x/a': '^1.0.0' }]]) {
    mkdirSync(join(root, 'packages', n), { recursive: true });
    writeFileSync(join(root, 'packages', n, 'package.json'), JSON.stringify({ name: `@x/${n}`, version: '1.0.0', dependencies: deps }, null, 2));
  }
  const r = pnpm(root, 'install', '--lockfile-only');
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('4f26493e AC2: fresh workspace -> gate exit 0; drifted range -> exit 1 naming packages/b/package.json and @x/a; lockfile untouched', () => {
  const root = makeWorkspace();
  try {
    assert.equal(gate(root).status, 0, 'a freshly-locked workspace is green');

    const lock = join(root, 'pnpm-lock.yaml');
    const before = md5(lock);
    const bPath = join(root, 'packages/b/package.json');
    const b = JSON.parse(readFileSync(bPath, 'utf8'));
    b.dependencies['@x/a'] = '^1.0.1'; // range edited, lockfile not regenerated
    writeFileSync(bPath, JSON.stringify(b, null, 2));

    const red = gate(root);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /FAIL/);
    assert.match(red.stderr, /packages\/b\/package\.json/);
    assert.match(red.stderr, /@x\/a: lockfile "\^1\.0\.0" vs package\.json "\^1\.0\.1"/);
    assert.equal(md5(lock), before, 'the gate is non-mutating: pnpm-lock.yaml is byte-identical after a RED run');

    // e98bb455 AC1: the release relock heals exactly this drift.
    // (a@1.0.0 does not satisfy ^1.0.1, so bump a too, like a real release does.)
    const aPath = join(root, 'packages/a/package.json');
    writeFileSync(aPath, JSON.stringify({ name: '@x/a', version: '1.0.1' }, null, 2));
    assert.equal(checkLockfile({ cwd: root }).ok, false);
    const regen = regenerateLockfile({ cwd: root });
    assert.equal(regen.ok, true, regen.message);
    assert.equal(gate(root).status, 0, 'after regeneration the gate is green again');
    assert.notEqual(md5(lock), before, 'the lockfile actually changed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('4f26493e AC2 NEGATIVE CONTROL on the REAL repo: drift one tracked package.json range -> red; restored in finally -> green', () => {
  const rel = 'packages/agent/agent-core-provider/package.json';
  const abs = join(REPO, rel);
  const original = readFileSync(abs, 'utf8');
  try {
    assert.equal(gate(REPO).status, 0, 'precondition: the repo lockfile is fresh');
    const drifted = original.replace(/("@adhd\/agent-base-types":\s*)"\^[0-9.]+"/, '$1"^9.9.9"');
    assert.notEqual(drifted, original, 'the mutation must change the range');
    writeFileSync(abs, drifted);
    const red = gate(REPO);
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /agent-core-provider\/package\.json/);
    assert.match(red.stderr, /@adhd\/agent-base-types/);
  } finally {
    writeFileSync(abs, original);
    const diff = spawnSync('git', ['diff', '--quiet', '--', rel], { cwd: REPO, env: cleanGitEnv() });
    assert.equal(diff.status, 0, `${rel} must be restored byte-for-byte`);
  }
  assert.equal(gate(REPO).status, 0, 'restored -> green again');
});
